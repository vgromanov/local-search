import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLanceNativePanic, optimizeWithFtsRecovery, shouldRunAnotherOptimizePass } from "./lanceOptimize.ts";

function lancePanic(): Error {
  return Object.assign(new Error("Panic in async function"), { code: "GenericFailure" });
}

describe("isLanceNativePanic", () => {
  it("matches the napi panic error", () => {
    assert.equal(isLanceNativePanic(lancePanic()), true);
  });

  it("ignores ordinary errors", () => {
    assert.equal(isLanceNativePanic(new Error("No space left on device")), false);
    assert.equal(isLanceNativePanic(undefined), false);
  });
});

describe("optimizeWithFtsRecovery", () => {
  it("returns stats without rebuilding when optimize succeeds", async () => {
    let rebuilds = 0;
    const stats = await optimizeWithFtsRecovery({
      optimize: async () => "ok",
      rebuildFts: async () => {
        rebuilds++;
        return true;
      }
    });
    assert.equal(stats, "ok");
    assert.equal(rebuilds, 0);
  });

  it("rebuilds the FTS index and retries once after a panic", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const recovered: unknown[] = [];
    const stats = await optimizeWithFtsRecovery({
      optimize: async () => {
        calls.push("optimize");
        if (attempts++ === 0) throw lancePanic();
        return "ok";
      },
      rebuildFts: async () => {
        calls.push("rebuild");
        return true;
      },
      onRecover: (error) => recovered.push(error)
    });
    assert.equal(stats, "ok");
    assert.deepEqual(calls, ["optimize", "rebuild", "optimize"]);
    assert.equal(recovered.length, 1);
  });

  it("surfaces a second panic instead of looping", async () => {
    let attempts = 0;
    await assert.rejects(
      optimizeWithFtsRecovery({
        optimize: async () => {
          attempts++;
          throw lancePanic();
        },
        rebuildFts: async () => true
      }),
      /Panic in async function/
    );
    assert.equal(attempts, 2);
  });

  it("rethrows the original panic when the rebuild fails", async () => {
    let attempts = 0;
    const panic = lancePanic();
    await assert.rejects(
      optimizeWithFtsRecovery({
        optimize: async () => {
          attempts++;
          throw panic;
        },
        rebuildFts: async () => false
      }),
      (error) => error === panic
    );
    assert.equal(attempts, 1);
  });

  it("does not rebuild for non-panic failures", async () => {
    let rebuilds = 0;
    await assert.rejects(
      optimizeWithFtsRecovery({
        optimize: async () => {
          throw new Error("No space left on device");
        },
        rebuildFts: async () => {
          rebuilds++;
          return true;
        }
      }),
      /No space left/
    );
    assert.equal(rebuilds, 0);
  });
});

describe("shouldRunAnotherOptimizePass", () => {
  const idle = { compaction: { fragmentsRemoved: 0 }, prune: { bytesRemoved: 0, oldVersionsRemoved: 0 } };

  // Sizes (KiB) and stats from optimize passes on a copy of a real 36k-row index under 0.40.0.
  it("continues through an index-only pass that grows the directory", () => {
    assert.equal(shouldRunAnotherOptimizePass(idle, 409_916, 422_908), true);
  });

  it("continues after a compaction even though the directory doubled", () => {
    const stats = { compaction: { fragmentsRemoved: 2 }, prune: { bytesRemoved: 8_299_267, oldVersionsRemoved: 2 } };
    assert.equal(shouldRunAnotherOptimizePass(stats, 422_908, 817_992), true);
  });

  it("continues after a pass that only pruned", () => {
    const stats = { compaction: { fragmentsRemoved: 0 }, prune: { bytesRemoved: 424_692_587, oldVersionsRemoved: 1 } };
    assert.equal(shouldRunAnotherOptimizePass(stats, 817_992, 403_224), true);
  });

  it("stops once a pass does no work and the size is flat", () => {
    assert.equal(shouldRunAnotherOptimizePass(idle, 403_224, 403_224), false);
    assert.equal(shouldRunAnotherOptimizePass(idle, 403_224, 400_000), false);
  });

  it("stops when optimize returned no stats and nothing changed", () => {
    assert.equal(shouldRunAnotherOptimizePass(null, 1000, 1000), false);
    assert.equal(shouldRunAnotherOptimizePass(null, 0, 0), false);
  });
});
