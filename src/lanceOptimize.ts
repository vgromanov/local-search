/**
 * A Rust panic inside the LanceDB native module surfaces in JS as a
 * GenericFailure whose message is "Panic in async function" (the panic text
 * itself only goes to stderr).
 */
export function isLanceNativePanic(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\bpanic/i.test(message);
}

export type OptimizeRecoveryHooks<T> = {
  optimize: () => Promise<T>;
  /** Rebuild the FTS index from scratch; resolve false if the rebuild failed. */
  rebuildFts: () => Promise<boolean>;
  onRecover?: (error: unknown) => void;
};

/**
 * Run optimize(); if Lance panics, rebuild the FTS index and retry once.
 *
 * lance-index 7.0.0 (@lancedb/lancedb 0.30.0) panics with "index out of bounds"
 * in InnerBuilder::merge_from (scalar/inverted/builder.rs:856) when optimize
 * merges FTS partitions after deletes: TokenSet::remap compacts token ids but
 * keeps the stale next_id, so newly merged tokens get ids past posting_lists.
 * Fixed upstream in lance-index 8.0.0 (@lancedb/lancedb 0.31.0). A fresh single-partition index
 * avoids the merge, after which optimize succeeds.
 */
export async function optimizeWithFtsRecovery<T>(hooks: OptimizeRecoveryHooks<T>): Promise<T> {
  try {
    return await hooks.optimize();
  } catch (error) {
    if (!isLanceNativePanic(error)) throw error;
    hooks.onRecover?.(error);
    if (!(await hooks.rebuildFts())) throw error;
    return hooks.optimize();
  }
}

export type OptimizePassStats = {
  compaction?: { fragmentsRemoved?: number };
  prune?: { bytesRemoved?: number; oldVersionsRemoved?: number };
} | null;

/**
 * Whether another optimize pass can still reclaim space.
 *
 * Since @lancedb/lancedb 0.40, optimize() runs compact → prune → index update,
 * so a pass may report no work while its index update grows the directory, and
 * the versions a compaction leaves behind are only pruned on the next pass.
 * Keep going until a pass both reports no work and leaves the size flat.
 */
export function shouldRunAnotherOptimizePass(
  stats: OptimizePassStats,
  previousBytes: number,
  currentBytes: number,
  tolerance = 0.02
): boolean {
  const didWork =
    Number(stats?.compaction?.fragmentsRemoved ?? 0) > 0 ||
    Number(stats?.prune?.bytesRemoved ?? 0) > 0 ||
    Number(stats?.prune?.oldVersionsRemoved ?? 0) > 0;
  if (didWork) return true;
  if (previousBytes <= 0) return false;
  return Math.abs(currentBytes - previousBytes) > previousBytes * tolerance;
}
