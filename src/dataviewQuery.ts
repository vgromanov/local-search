import { extractPath } from "./dataview.ts";
import { serializeValue, type JsonValue } from "./serialize.ts";

/**
 * Read-only DQL for `POST /dataview/query/`.
 * Execution is Dataview `api.query`. Values go through {@link serializeValue}.
 * DataArrays are materialized only via `.array()`.
 */

export const DEFAULT_DATAVIEW_QUERY_LIMIT = 500;
export const DEFAULT_DATAVIEW_QUERY_TIMEOUT_MS = 5_000;
export const DEFAULT_DATAVIEW_QUERY_MAX_ROWS = 5_000;
export const DEFAULT_DATAVIEW_QUERY_MAX_TIMEOUT_MS = 30_000;

const DATAVIEW_UNAVAILABLE = "Dataview plugin is not available";
const QUERY_TIMED_OUT = "Dataview query timed out";
const CALENDAR_REJECTED = "CALENDAR queries are not supported";
const DATAVIEWJS_REJECTED = "dataviewjs is not supported";
const INLINE_JS_REJECTED = "Inline JavaScript ($=) is not supported";
const JS_EXPR_REJECTED = "JavaScript expressions are not supported";
const QUERY_TYPE_REJECTED = "Only TABLE, LIST, and TASK queries are supported";

export interface DataviewQueryContext {
  /** Bound to the Dataview API object by the caller. Null when the plugin is absent. */
  query: ((source: string) => Promise<unknown>) | null;
  indexReady: boolean;
  maxRows: number;
  maxTimeoutMs: number;
}

export type DataviewQueryOutcome =
  | { ok: true; body: { [key: string]: JsonValue } }
  | { ok: false; status: number; message: string };

interface IndexReadySource {
  dataviewIndex?: { initialized?: boolean } | null;
  metadataCache?: object | null;
}

type Node =
  | { kind: "leaf"; path: string; value: JsonValue }
  | { kind: "group"; key: JsonValue; children: Node[] };

class QueryTimeoutError extends Error {
  constructor() {
    super(QUERY_TIMED_OUT);
    this.name = "QueryTimeoutError";
  }
}

export function dataviewIndexReady(
  app: { metadataCache?: object | null },
  api: { index?: { initialized?: boolean } | null } | null
): boolean {
  return isIndexReady({
    dataviewIndex: api?.index ?? null,
    metadataCache: app.metadataCache ?? null
  });
}

/**
 * True when the Dataview index has finished its initial build and the
 * metadata cache is not reporting unfinished resolution work.
 * `initialized` and the pending-queue fields are runtime properties; the
 * public metadata cache type does not list them.
 */
export function isIndexReady(source: IndexReadySource): boolean {
  if (source.dataviewIndex?.initialized !== true) return false;
  const cache = source.metadataCache;
  if (!cache) return false;
  const record = cache as {
    initialized?: unknown;
    inProgressTaskCount?: unknown;
    queue?: unknown;
  };
  if (record.initialized === false) return false;
  const pending = pendingMetadata(record);
  if (pending !== null && pending > 0) return false;
  return true;
}

export async function executeDataviewQuery(
  ctx: DataviewQueryContext,
  body: unknown
): Promise<DataviewQueryOutcome> {
  if (!ctx.query) return fail(503, DATAVIEW_UNAVAILABLE);

  const record = asRecord(body);
  if (!record) return fail(400, "`query` must be a string");

  const limit = boundedPositive(
    record.limit,
    DEFAULT_DATAVIEW_QUERY_LIMIT,
    ctx.maxRows,
    DEFAULT_DATAVIEW_QUERY_MAX_ROWS,
    "limit"
  );
  if (!limit.ok) return fail(400, limit.message);

  const timeout = boundedPositive(
    record.timeout_ms,
    DEFAULT_DATAVIEW_QUERY_TIMEOUT_MS,
    ctx.maxTimeoutMs,
    DEFAULT_DATAVIEW_QUERY_MAX_TIMEOUT_MS,
    "timeout_ms"
  );
  if (!timeout.ok) return fail(400, timeout.message);

  if (typeof record.query !== "string") return fail(400, "`query` must be a string");
  const source = record.query.trim();
  const rejected = rejectQuery(source);
  if (rejected) return fail(400, rejected);

  let result: unknown;
  try {
    result = await withTimeout(ctx.query(source), timeout.value);
  } catch (error) {
    if (error instanceof QueryTimeoutError) return fail(408, QUERY_TIMED_OUT);
    const message = error instanceof Error ? error.message : "Dataview query failed";
    return fail(500, message);
  }

  const unwrapped = unwrapQueryResult(result);
  if (!unwrapped.ok) return fail(400, unwrapped.message);

  try {
    return normalizeResult(unwrapped.value, !hasSort(source), limit.value, ctx.indexReady);
  } catch {
    return fail(500, "Dataview query failed");
  }
}

function fail(status: number, message: string): DataviewQueryOutcome {
  return { ok: false, status, message };
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function boundedPositive(
  raw: unknown,
  fallback: number,
  hardMax: number,
  hardDefault: number,
  label: string
): { ok: true; value: number } | { ok: false; message: string } {
  const cap = positiveInt(hardMax) ?? hardDefault;
  if (raw === undefined || raw === null) {
    return { ok: true, value: Math.min(fallback, cap) };
  }
  const parsed = positiveInt(raw);
  if (parsed === null) {
    return { ok: false, message: `\`${label}\` must be a positive number` };
  }
  return { ok: true, value: Math.min(parsed, cap) };
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}

/** Quoted strings are removed so a literal `$=` or `SORT` is not treated as syntax. */
export function stripQuoted(source: string): string {
  let out = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char !== "\"") {
      out += char;
      continue;
    }
    out += "\"\"";
    index++;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === "\"") break;
      index++;
    }
  }
  return out;
}

export function rejectQuery(source: string): string | null {
  if (!source) return "`query` must be a string";
  const bare = stripQuoted(source);
  if (/\bdataviewjs\b/i.test(bare)) return DATAVIEWJS_REJECTED;
  if (/\$\s*=/.test(bare)) return INLINE_JS_REJECTED;
  // `function` as a keyword (`function name(`), not a tag, path, or field
  // such as `#function` or `my-function`. Those contain the same letters
  // after a non-word character, which a bare word-boundary check rejects.
  if (/\bfunction\s*\*?\s*(?:[A-Za-z_$][\w$]*\s*)?\(/.test(bare) || /=>/.test(bare)) {
    return JS_EXPR_REJECTED;
  }
  const keyword = /^(TABLE|LIST|TASK|CALENDAR)\b/i.exec(source);
  if (!keyword) return QUERY_TYPE_REJECTED;
  if (keyword[1].toUpperCase() === "CALENDAR") return CALENDAR_REJECTED;
  return null;
}

function hasSort(source: string): boolean {
  return /\bSORT\b/i.test(stripQuoted(source));
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new QueryTimeoutError()), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function unwrapQueryResult(
  result: unknown
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!result || typeof result !== "object") {
    return { ok: false, message: "Dataview query failed" };
  }
  const wrapped = result as { successful?: boolean; error?: unknown; value?: unknown; type?: unknown };
  if (wrapped.successful === false) {
    return {
      ok: false,
      message: typeof wrapped.error === "string" ? wrapped.error : "Dataview query failed"
    };
  }
  if (wrapped.successful === true) return { ok: true, value: wrapped.value };
  if (typeof wrapped.type === "string") return { ok: true, value: result };
  return { ok: false, message: "Dataview query failed" };
}

function normalizeResult(
  value: unknown,
  sortByPath: boolean,
  limit: number,
  indexReady: boolean
): DataviewQueryOutcome {
  if (!value || typeof value !== "object") return fail(400, "Dataview query failed");
  const typed = value as {
    type?: unknown;
    headers?: unknown;
    values?: unknown;
    idMeaning?: unknown;
    primaryMeaning?: unknown;
  };

  if (typed.type === "calendar") return fail(400, CALENDAR_REJECTED);
  if (typed.type === "table") {
    const headers = tableHeaders(typed.headers);
    const nodes = tableNodes(headers, asArray(typed.values) ?? [], typed.idMeaning);
    return finish("table", { headers }, nodes, sortByPath, limit, indexReady);
  }
  if (typed.type === "list") {
    const grouped = isGroupMeaning(typed.primaryMeaning);
    const nodes = (asArray(typed.values) ?? []).map((item) => listNode(item, grouped));
    return finish("list", {}, nodes, sortByPath, limit, indexReady);
  }
  if (typed.type === "task") {
    const nodes = (asArray(typed.values) ?? []).map((item) => taskNode(item));
    return finish("task", {}, nodes, sortByPath, limit, indexReady);
  }
  return fail(400, QUERY_TYPE_REJECTED);
}

function tableHeaders(headers: unknown): string[] {
  return (asArray(headers) ?? []).map((header) => (typeof header === "string" ? header : ""));
}

function finish(
  type: "table" | "list" | "task",
  extra: { [key: string]: JsonValue },
  nodes: Node[],
  sortByPath: boolean,
  limit: number,
  indexReady: boolean
): DataviewQueryOutcome {
  const ordered = orderNodes(nodes, sortByPath);
  const limited = takeNodes(ordered, limit);
  const field = type === "table" ? "rows" : type === "list" ? "items" : "tasks";
  return {
    ok: true,
    body: {
      type,
      ...extra,
      [field]: nodesToJson(limited.nodes),
      truncated: limited.droppedLeaves,
      index_ready: indexReady
    }
  };
}

function isGroupMeaning(meaning: unknown): boolean {
  return !!meaning && typeof meaning === "object" && (meaning as { type?: unknown }).type === "group";
}

function groupColumnIndex(headers: string[], idMeaning: unknown): number {
  if (!isGroupMeaning(idMeaning)) return -1;
  const name = (idMeaning as { name?: unknown }).name;
  if (typeof name === "string" && headers[0] === name) return 0;
  return -1;
}

function tableNodes(headers: string[], rows: unknown[], idMeaning: unknown): Node[] {
  const groupCol = groupColumnIndex(headers, idMeaning);
  return rows.map((raw) => {
    if (isGroup(raw)) return groupNode(raw, false);
    const cells = asArray(raw) ?? [];
    if (groupCol >= 0) {
      const row = rowObject(headers, cells, groupCol);
      return {
        kind: "group",
        key: serializeValue(cells[groupCol]).value,
        children: [{ kind: "leaf", path: pathFromRow(row, cells), value: row }]
      };
    }
    const row = rowObject(headers, cells, -1);
    return { kind: "leaf", path: pathFromRow(row, cells), value: row };
  });
}

function listNode(item: unknown, grouped: boolean): Node {
  if (isGroup(item)) return groupNode(item, false);
  const pair = readListPair(item);
  if (pair && grouped) {
    return {
      kind: "group",
      key: pair.key,
      children: [leafFromValue(pair.rawValue)]
    };
  }
  if (grouped) {
    return { kind: "group", key: serializeValue(item).value, children: [] };
  }
  if (pair) {
    const value: JsonValue = { key: pair.key, value: pair.value };
    return { kind: "leaf", path: pathFromUnknown(pair.rawKey, pair.key), value };
  }
  return leafFromValue(item);
}

function taskNode(item: unknown): Node {
  if (isGroup(item)) return groupNode(item, true);
  if (item && typeof item === "object" && isTask(item)) {
    const projected = projectTask(item);
    const path = typeof projected.path === "string" ? projected.path : "";
    return { kind: "leaf", path, value: projected };
  }
  return leafFromValue(item);
}

function groupNode(value: { key: unknown; rows: unknown }, asTasks: boolean): Node {
  const rows = asArray(value.rows) ?? [];
  return {
    kind: "group",
    key: serializeValue(value.key).value,
    children: rows.map((row) => (asTasks ? taskNode(row) : listNode(row, false)))
  };
}

function leafFromValue(item: unknown): Node {
  if (isGroup(item)) return groupNode(item, false);
  const serialized = serializeValue(item).value;
  return { kind: "leaf", path: pathFromUnknown(item, serialized), value: serialized };
}

function rowObject(
  headers: string[],
  cells: unknown[],
  skip: number
): { [key: string]: JsonValue } {
  const used = new Set<string>();
  const out: { [key: string]: JsonValue } = {};
  headers.forEach((header, index) => {
    if (index === skip) return;
    const key = uniqueHeaderKey(header, used);
    out[key] = key === "file" ? fileCell(cells[index]) : serializeValue(cells[index]).value;
  });
  return out;
}

function uniqueHeaderKey(header: string, used: Set<string>): string {
  const base = header.toLowerCase() === "file" ? "file" : header;
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base}_${suffix}`;
    suffix++;
  }
  used.add(key);
  return key;
}

function fileCell(value: unknown): JsonValue {
  const extracted = extractPath(value);
  if (extracted) return extracted;
  return serializeValue(value).value;
}

function pathFromRow(row: { [key: string]: JsonValue }, cells: unknown[]): string {
  if (typeof row.file === "string") return row.file;
  for (const cell of cells) {
    const extracted = extractPath(cell);
    if (extracted) return extracted;
  }
  return "";
}

function pathFromUnknown(raw: unknown, serialized: JsonValue): string {
  const extracted = extractPath(raw);
  if (extracted) return extracted;
  if (typeof serialized === "string") return serialized;
  if (isJsonObject(serialized) && typeof serialized.path === "string") return serialized.path;
  return "";
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTask(value: object): boolean {
  const task = value as { text?: unknown; line?: unknown; completed?: unknown };
  return typeof task.text === "string"
    && typeof task.line === "number"
    && Number.isFinite(task.line)
    && typeof task.completed === "boolean";
}

function projectTask(value: object): { [key: string]: JsonValue } {
  const task = value as {
    path?: unknown;
    link?: unknown;
    line?: unknown;
    text?: unknown;
    completed?: unknown;
    status?: unknown;
    section?: unknown;
  };
  const extracted = typeof task.path === "string" && task.path
    ? task.path
    : extractPath(task.link) ?? extractPath(task) ?? "";
  const status = serializeValue(task.status).value;
  const projected: { [key: string]: JsonValue } = {
    path: extracted,
    line: typeof task.line === "number" ? task.line : 0,
    text: typeof task.text === "string" ? task.text : "",
    completed: task.completed === true,
    status: typeof status === "string" ? status : ""
  };
  const section = sectionText(task.section);
  if (section) projected.section = section;
  return projected;
}

function sectionText(section: unknown): string | null {
  if (typeof section === "string" && section) return section;
  if (!section || typeof section !== "object") return null;
  const record = section as { subpath?: unknown; display?: unknown; header?: unknown; path?: unknown };
  if (typeof record.subpath === "string" && record.subpath) return record.subpath;
  if (typeof record.header === "string" && record.header) return record.header;
  if (typeof record.display === "string" && record.display) return record.display;
  if (typeof record.path === "string" && record.path) return record.path;
  return null;
}

function isGroup(value: unknown): value is { key: unknown; rows: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (isTask(value)) return false;
  const record = value as { key?: unknown; rows?: unknown; file?: unknown };
  if (!("key" in record) || !("rows" in record)) return false;
  if (record.file && typeof record.file === "object") return false;
  return asArray(record.rows) !== null;
}

interface ListPair {
  key: JsonValue;
  value: JsonValue;
  rawKey: unknown;
  rawValue: unknown;
}

function readListPair(value: unknown): ListPair | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (isGroup(value) || isTask(value)) return null;
  const record = value as { key?: unknown; value?: unknown; file?: unknown };
  const ctor = value.constructor?.name;
  const widget = ctor === "ListPairWidget";
  const plainPair = (ctor === "Object" || ctor === undefined)
    && Object.keys(record).length === 2
    && "key" in record
    && "value" in record;
  if (!widget && !plainPair) return null;
  if (!("key" in record) || !("value" in record)) return null;
  if (record.file && typeof record.file === "object") return null;
  return {
    key: serializeValue(record.key).value,
    value: serializeValue(record.value).value,
    rawKey: record.key,
    rawValue: record.value
  };
}

function orderNodes(nodes: Node[], sortByPath: boolean): Node[] {
  const mapped = nodes.map((node) => (
    node.kind === "group"
      ? { ...node, children: orderNodes(node.children, sortByPath) }
      : node
  ));
  if (!sortByPath) return mapped;
  return [...mapped].sort((left, right) => {
    const leftPath = minPath(left);
    const rightPath = minPath(right);
    if (leftPath < rightPath) return -1;
    if (leftPath > rightPath) return 1;
    return 0;
  });
}

function minPath(node: Node): string {
  if (node.kind === "leaf") return node.path;
  let best = "";
  let seen = false;
  for (const child of node.children) {
    const path = minPath(child);
    if (!seen || path < best) {
      best = path;
      seen = true;
    }
  }
  return best;
}

function takeNodes(nodes: Node[], limit: number): { nodes: Node[]; droppedLeaves: boolean } {
  let left = limit;
  const out: Node[] = [];
  let droppedLeaves = false;

  for (const node of nodes) {
    if (node.kind === "leaf") {
      if (left <= 0) {
        droppedLeaves = true;
        continue;
      }
      out.push(node);
      left -= 1;
      continue;
    }

    const inner = takeNodes(node.children, left);
    if (inner.droppedLeaves) droppedLeaves = true;
    const kept = countLeaves(inner.nodes);
    if (kept === 0 && countLeaves(node.children) > 0) {
      droppedLeaves = true;
      continue;
    }
    out.push({ kind: "group", key: node.key, children: inner.nodes });
    left -= kept;
  }

  return { nodes: out, droppedLeaves };
}

function countLeaves(nodes: Node[]): number {
  let count = 0;
  for (const node of nodes) {
    count += node.kind === "leaf" ? 1 : countLeaves(node.children);
  }
  return count;
}

function nodesToJson(nodes: Node[]): JsonValue[] {
  return nodes.map((node) => (
    node.kind === "leaf"
      ? node.value
      : { key: node.key, rows: nodesToJson(node.children) }
  ));
}

/**
 * Materialize an array or a Dataview DataArray. Never reads `.value`.
 * Returns null when `value` is not array-like.
 */
function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  let arrayFn: unknown;
  try {
    arrayFn = (value as { array?: unknown }).array;
  } catch {
    return null;
  }
  if (typeof arrayFn !== "function") return null;
  try {
    const rows = (arrayFn as () => unknown).call(value);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function pendingMetadata(record: {
  inProgressTaskCount?: unknown;
  queue?: unknown;
}): number | null {
  if (typeof record.inProgressTaskCount === "number" && Number.isFinite(record.inProgressTaskCount)) {
    return record.inProgressTaskCount;
  }
  const queue = record.queue;
  if (Array.isArray(queue)) return queue.length;
  if (queue && typeof queue === "object") {
    const nested = queue as { length?: unknown; queue?: unknown };
    if (typeof nested.length === "number" && Number.isFinite(nested.length)) return nested.length;
    if (Array.isArray(nested.queue)) return nested.queue.length;
  }
  return null;
}
