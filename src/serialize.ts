import emojiRegex from "emoji-regex";
import { extractPath } from "./dataview.ts";

/**
 * JSON serializer for Dataview `api.query` values and Obsidian
 * frontmatter / metadataCache values.
 *
 * Importers (later query and graph routes) should use {@link serializeValue}.
 * DataArray proxies are materialized only via `.array()`. `.value` and `.to`
 * are never read: those Proxy traps auto-flatten and recurse.
 */

export const DEFAULT_MAX_DEPTH = 32;
export const DEFAULT_MAX_STRING_LENGTH = 100_000;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SerializeWarningCode =
  | "unsupported"
  | "truncated-depth"
  | "truncated-string"
  | "cycle"
  | "non-finite-number"
  | "invalid-temporal"
  | "dropped-duplicate-key";

export interface SerializeWarning {
  /** JSON Pointer to the value that produced the warning. Empty at the root. */
  path: string;
  code: SerializeWarningCode;
  message: string;
}

export interface SerializeOptions {
  /**
   * When true, Dataview links become `{ path, display? }` instead of a path
   * string. `display` is included only when the link has display text.
   */
  linkDisplay?: boolean;
  /** Maximum nesting depth. The root is depth 0. Deeper values become null. */
  maxDepth?: number;
  /** Maximum string length. Longer strings are sliced and flagged. */
  maxStringLength?: number;
}

export interface SerializeResult {
  value: JsonValue;
  warnings: SerializeWarning[];
  /** True when a depth or string guard truncated a value. */
  truncated: boolean;
}

interface Ctx {
  linkDisplay: boolean;
  maxDepth: number;
  maxStringLength: number;
  warnings: SerializeWarning[];
  truncated: boolean;
  /** Objects currently on the walk stack. Shared DAGs are fine; cycles are not. */
  stack: WeakSet<object>;
}

const LINK_TYPES = new Set(["file", "header", "block"]);

export function serializeValue(value: unknown, options?: SerializeOptions): SerializeResult {
  const ctx = createContext(options);
  try {
    return {
      value: serializeInto(value, ctx, "", 0),
      warnings: ctx.warnings,
      truncated: ctx.truncated
    };
  } catch {
    warn(ctx, "", "unsupported", "Serialization failed");
    return { value: null, warnings: ctx.warnings, truncated: ctx.truncated };
  }
}

function createContext(options?: SerializeOptions): Ctx {
  return {
    linkDisplay: options?.linkDisplay === true,
    maxDepth: finiteFloor(options?.maxDepth, DEFAULT_MAX_DEPTH),
    maxStringLength: finiteFloor(options?.maxStringLength, DEFAULT_MAX_STRING_LENGTH),
    warnings: [],
    truncated: false,
    stack: new WeakSet()
  };
}

function finiteFloor(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function warn(ctx: Ctx, path: string, code: SerializeWarningCode, message: string): void {
  ctx.warnings.push({ path, code, message });
  if (code === "truncated-depth" || code === "truncated-string") ctx.truncated = true;
}

function serializeInto(value: unknown, ctx: Ctx, path: string, depth: number): JsonValue {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case "string":
      return boundString(ctx, path, value);
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        warn(ctx, path, "non-finite-number", "Non-finite number");
        return null;
      }
      return value;
    case "bigint":
    case "function":
    case "symbol":
      warn(ctx, path, "unsupported", `Unsupported ${typeof value}`);
      return null;
    case "object":
      break;
    default:
      warn(ctx, path, "unsupported", "Unsupported value");
      return null;
  }

  if (depth > ctx.maxDepth) {
    warn(ctx, path, "truncated-depth", "Maximum nesting depth exceeded");
    return null;
  }

  if (ctx.stack.has(value)) {
    warn(ctx, path, "cycle", "Cycle");
    return null;
  }

  const materialized = materializeDataArray(value);
  if (materialized.kind === "failed") {
    warn(ctx, path, "unsupported", "DataArray materialization failed");
    return null;
  }
  if (materialized.kind === "array") {
    ctx.stack.add(value);
    try {
      return serializeInto(materialized.rows, ctx, path, depth);
    } finally {
      ctx.stack.delete(value);
    }
  }

  if (value instanceof Date) return dateToIso(ctx, path, value);

  const dateTime = luxonIso(value, "isLuxonDateTime", "DateTime");
  if (dateTime !== undefined) return temporalResult(ctx, path, dateTime, "DateTime");

  const duration = luxonIso(value, "isLuxonDuration", "Duration");
  if (duration !== undefined) return temporalResult(ctx, path, duration, "Duration");

  if (isLink(value)) return serializeLink(ctx, path, value);

  if (Array.isArray(value)) return serializeArray(ctx, path, depth, value);

  if (isPlainObject(value)) return serializeObject(ctx, path, depth, value);

  warn(ctx, path, "unsupported", "Unsupported class instance");
  return null;
}

function boundString(ctx: Ctx, path: string, text: string): string {
  if (text.length <= ctx.maxStringLength) return text;
  warn(ctx, path, "truncated-string", "String exceeds max length");
  return text.slice(0, ctx.maxStringLength);
}

function dateToIso(ctx: Ctx, path: string, value: Date): string | null {
  if (Number.isNaN(value.getTime())) {
    warn(ctx, path, "invalid-temporal", "Invalid Date");
    return null;
  }
  try {
    return value.toISOString();
  } catch {
    warn(ctx, path, "invalid-temporal", "Invalid Date");
    return null;
  }
}

/**
 * Returns the ISO string, null when `toISO` fails, or undefined when `value`
 * is not this Luxon type.
 */
function luxonIso(
  value: object,
  flag: "isLuxonDateTime" | "isLuxonDuration",
  ctorName: string
): string | null | undefined {
  const record = value as { toISO?: unknown };
  const marked =
    (value as { isLuxonDateTime?: unknown; isLuxonDuration?: unknown })[flag] === true ||
    (value.constructor?.name === ctorName && typeof record.toISO === "function");
  if (!marked) return undefined;
  if (typeof record.toISO !== "function") return null;
  try {
    const iso = record.toISO.call(value);
    return typeof iso === "string" ? iso : null;
  } catch {
    return null;
  }
}

function temporalResult(
  ctx: Ctx,
  path: string,
  iso: string | null,
  kind: "DateTime" | "Duration"
): string | null {
  if (iso == null) {
    warn(ctx, path, "invalid-temporal", `Invalid ${kind}`);
    return null;
  }
  return boundString(ctx, path, iso);
}

function isLink(value: object): boolean {
  const record = value as { path?: unknown; type?: unknown; file?: unknown };
  if (typeof record.path !== "string") return false;
  if (record.file && typeof record.file === "object") return false;
  if (value.constructor?.name === "Link") return true;
  return typeof record.type === "string" && LINK_TYPES.has(record.type);
}

function serializeLink(ctx: Ctx, path: string, value: object): JsonValue {
  const linkPath = extractPath(value);
  if (typeof linkPath !== "string") {
    warn(ctx, path, "unsupported", "Link has no path");
    return null;
  }
  const vaultPath = boundString(ctx, path, linkPath);
  if (!ctx.linkDisplay) return vaultPath;

  const display = (value as { display?: unknown }).display;
  const out: { [key: string]: JsonValue } = { path: vaultPath };
  if (typeof display === "string") {
    out.display = boundString(ctx, `${path}/display`, display);
  }
  return out;
}

function serializeArray(ctx: Ctx, path: string, depth: number, value: unknown[]): JsonValue[] {
  ctx.stack.add(value);
  try {
    return value.map((item, index) => serializeInto(item, ctx, `${path}/${index}`, depth + 1));
  } finally {
    ctx.stack.delete(value);
  }
}

function serializeObject(
  ctx: Ctx,
  path: string,
  depth: number,
  value: object
): { [key: string]: JsonValue } {
  ctx.stack.add(value);
  try {
    const out: { [key: string]: JsonValue } = {};
    for (const field of objectFields(ctx, path, value)) {
      const source = (value as Record<string, unknown>)[field.sourceKey];
      if (source === undefined && field.sourceKey === field.outKey) continue;
      const childPath = joinPointer(path, field.outKey);
      out[field.outKey] = serializeInto(source, ctx, childPath, depth + 1);
    }
    return out;
  } finally {
    ctx.stack.delete(value);
  }
}

interface FieldPlan {
  outKey: string;
  sourceKey: string;
}

function objectFields(ctx: Ctx, path: string, value: object): FieldPlan[] {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!isDataviewPage(value)) {
    return keys.map((key) => ({ outKey: key, sourceKey: key }));
  }

  const canonicalToOriginal = new Map<string, string>();
  const frontmatter = readFileFrontmatter(value);
  if (frontmatter) {
    for (const key of Object.keys(frontmatter)) {
      const canonical = canonicalizeDataviewKey(key);
      if (!canonical || canonical === "file" || canonicalToOriginal.has(canonical)) continue;
      canonicalToOriginal.set(canonical, key);
    }
  }
  const keySet = new Set(keys);
  for (const key of keys) {
    if (key === "file") continue;
    const canonical = canonicalizeDataviewKey(key);
    if (!canonical || canonical === key || canonical === "file") continue;
    if (keySet.has(canonical) && !canonicalToOriginal.has(canonical)) {
      canonicalToOriginal.set(canonical, key);
    }
  }

  const emitted = new Set<string>();
  const plan: FieldPlan[] = [];
  for (const key of keys) {
    if (key === "file") {
      if (!emitted.has("file")) {
        emitted.add("file");
        plan.push({ outKey: "file", sourceKey: "file" });
      }
      continue;
    }

    const canonical = canonicalizeDataviewKey(key);
    const original = canonicalToOriginal.get(canonical);
    if (original && original !== key && keySet.has(original)) {
      if (!Object.is(record[key], record[original])) {
        warn(
          ctx,
          joinPointer(path, key),
          "dropped-duplicate-key",
          `Dropped canonical key "${key}"`
        );
      }
      continue;
    }

    const outKey = original && original !== key ? original : key;
    if (emitted.has(outKey)) continue;
    emitted.add(outKey);
    plan.push({ outKey, sourceKey: key });
  }
  return plan;
}

function isDataviewPage(value: object): boolean {
  const file = (value as { file?: unknown }).file;
  if (!file || typeof file !== "object" || Array.isArray(file)) return false;
  return typeof (file as { path?: unknown }).path === "string";
}

function readFileFrontmatter(value: object): Record<string, unknown> | null {
  const file = (value as { file?: unknown }).file;
  if (!file || typeof file !== "object" || Array.isArray(file)) return null;
  const frontmatter = (file as { frontmatter?: unknown }).frontmatter;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return null;
  if (!isPlainObject(frontmatter)) return null;
  return frontmatter as Record<string, unknown>;
}

/**
 * Dataview `canonicalizeVarName`: an emoji sequence stays as-is (same
 * `emoji-regex` major version Dataview uses), a run of letters, numbers, `_`,
 * or `-` is lowercased, each whitespace character becomes `-`, and every
 * other character is dropped.
 */
const dataviewEmoji = emojiRegex();

function canonicalizeDataviewKey(name: string): string {
  let out = "";
  let index = 0;
  while (index < name.length) {
    const rest = name.slice(index);
    dataviewEmoji.lastIndex = 0;
    const emoji = dataviewEmoji.exec(rest);
    if (emoji && emoji.index === 0) {
      out += emoji[0];
      index += emoji[0].length;
      continue;
    }
    const word = /^[0-9\p{Letter}_-]+/u.exec(rest);
    if (word) {
      out += word[0].toLocaleLowerCase();
      index += word[0].length;
      continue;
    }
    const whitespace = /^\s/u.exec(rest);
    if (whitespace) {
      out += "-";
      index += whitespace[0].length;
      continue;
    }
    index += rest.codePointAt(0)! > 0xffff ? 2 : 1;
  }
  return out;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type Materialized =
  | { kind: "absent" }
  | { kind: "failed" }
  | { kind: "array"; rows: unknown[] };

function materializeDataArray(value: object): Materialized {
  let arrayFn: unknown;
  try {
    arrayFn = (value as { array?: unknown }).array;
  } catch {
    return { kind: "failed" };
  }
  if (typeof arrayFn !== "function") return { kind: "absent" };
  try {
    const rows = (arrayFn as () => unknown).call(value);
    if (!Array.isArray(rows)) return { kind: "failed" };
    return { kind: "array", rows };
  } catch {
    return { kind: "failed" };
  }
}

function joinPointer(parent: string, token: string): string {
  return `${parent}/${token.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}
