import type { App } from "obsidian";
import type { DataviewApi } from "./types";

const QUERY_PREFIX = /^(LIST|TABLE|TASK|CALENDAR)\b/i;

/** True when the string is already a Dataview query (not a bare source). */
export function isDataviewQuery(value: string): boolean {
  return QUERY_PREFIX.test(value.trim());
}

/**
 * Collapse a bare Dataview source into a LIST query so everything goes through
 * `api.query`. Full queries are returned unchanged.
 */
export function toDataviewQuery(sourceOrQuery: string): string {
  const trimmed = sourceOrQuery.trim();
  if (!trimmed) return trimmed;
  if (isDataviewQuery(trimmed)) return trimmed;
  return `LIST FROM ${trimmed}`;
}

/**
 * Extract a vault path from a Dataview page/Link-like value.
 * Prefer `.file.path` / `.path`. Never follow `.value` — Dataview DataArray
 * Proxies auto-flatten unknown fields and following `.value` recurses forever.
 */
export function extractPath(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    file?: { path?: string };
    path?: string;
  };
  if (typeof candidate.file?.path === "string") return candidate.file.path;
  if (typeof candidate.path === "string") return candidate.path;
  return null;
}

function isDataArrayLike(value: object): boolean {
  return typeof (value as { array?: unknown }).array === "function";
}

/**
 * Collect vault paths from Dataview list-like values (arrays, DataArray, rows).
 * Cycle-detects with WeakSet. Never walks `.value` (DataArray Proxy trap);
 * callers should pass `queryResult.value` explicitly when needed.
 */
export function extractPaths(
  value: unknown,
  paths = new Set<string>(),
  seen = new WeakSet<object>()
): Set<string> {
  if (value == null) return paths;

  const direct = extractPath(value);
  if (direct) paths.add(direct);

  if (typeof value !== "object") return paths;
  if (seen.has(value)) return paths;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) extractPaths(item, paths, seen);
    return paths;
  }

  const objectValue = value as Record<string, unknown>;

  // Dataview DataArray: materialize via .array(); never walk Proxy .value.
  if (isDataArrayLike(objectValue)) {
    try {
      const materialized = (objectValue.array as () => unknown[])();
      extractPaths(materialized, paths, seen);
    } catch {
      // ignore materialization failures
    }
    return paths;
  }

  if (Array.isArray(objectValue.values)) extractPaths(objectValue.values, paths, seen);
  if (Array.isArray(objectValue.rows)) extractPaths(objectValue.rows, paths, seen);
  if (Array.isArray(objectValue.children)) extractPaths(objectValue.children, paths, seen);

  return paths;
}

function assertSuccessfulQuery(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const queryResult = result as { successful?: boolean; error?: string };
  if (queryResult.successful === false) {
    throw new Error(queryResult.error || "Dataview query failed.");
  }
}

export class DataviewFilter {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  get api(): DataviewApi | null {
    return (this.app as unknown as { plugins?: { plugins?: Record<string, { api?: DataviewApi }> } })
      .plugins?.plugins?.dataview?.api ?? null;
  }

  /**
   * Resolve allowed note paths via Dataview. Both `source` and `query` are
   * executed through `api.query` (sources wrapped as `LIST FROM …`). Never
   * calls `api.pages()` — that returns DataArrays that stack-overflow path walkers.
   */
  async resolvePaths(source?: string, query?: string): Promise<Set<string> | null> {
    const api = this.api;
    if (!api?.query) return null;

    const raw = (query?.trim() || source?.trim()) || "";
    if (!raw) return null;

    const dvQuery = toDataviewQuery(raw);
    const result = await api.query(dvQuery);
    assertSuccessfulQuery(result);

    // api.query returns a plain { successful, value } object. Walk `value` only
    // (not Proxy .value chains on DataArrays inside extractPaths).
    const payload =
      result && typeof result === "object" && "value" in result
        ? (result as { value: unknown }).value
        : result;
    return extractPaths(payload);
  }
}
