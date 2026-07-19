/**
 * Shared SI filter compiler.
 *
 * Safety comes from re-emitting SQL from a validated AST — never from inspecting
 * or passthrough of caller-supplied text into LanceDB `.where()`.
 *
 * Accepts either:
 * - structured JSON: `{ field, op, value }` / `{ and|or: [...] }` / `{ not: node }`
 * - string subset (mining ergonomics): parse → AST → re-render
 */

import { QUERYABLE_FIELDS } from "./schema";

export type CompareOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "IN";

export type FilterLeaf = {
  field: string;
  op: CompareOp;
  value: string | number | boolean | Array<string | number | boolean>;
};

export type FilterNode =
  | FilterLeaf
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode };

export class FilterCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterCompileError";
  }
}

const MAX_CLAUSES = 64;
const MAX_DEPTH = 8;
const MAX_STRING_LEN = 2048;
const MAX_IN_ITEMS = 64;
const MAX_INPUT_LEN = 4096;

const COMPARE_OPS = new Set<CompareOp>(["=", "!=", ">", ">=", "<", "<=", "IN"]);

const NUMERIC_COLUMNS = new Set(["mtime", "size", "position"]);

export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function resolveColumn(field: string): string {
  const column = QUERYABLE_FIELDS[field];
  if (!column) {
    throw new FilterCompileError(`Unknown field: ${field}`);
  }
  return column;
}

function assertStringLen(value: string): void {
  if (value.length > MAX_STRING_LEN) {
    throw new FilterCompileError(`String value exceeds max length ${MAX_STRING_LEN}`);
  }
}

function renderLiteral(column: string, value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FilterCompileError("Numeric value must be finite");
    return String(value);
  }
  assertStringLen(value);
  if (NUMERIC_COLUMNS.has(column) && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return `'${escapeSql(value)}'`;
}

function countLeaves(node: FilterNode): number {
  if ("and" in node) return node.and.reduce((sum, child) => sum + countLeaves(child), 0);
  if ("or" in node) return node.or.reduce((sum, child) => sum + countLeaves(child), 0);
  if ("not" in node) return countLeaves(node.not);
  return 1;
}

function renderNode(node: FilterNode, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new FilterCompileError(`Filter nesting exceeds max depth ${MAX_DEPTH}`);
  }

  if ("and" in node) {
    if (!Array.isArray(node.and) || node.and.length === 0) {
      throw new FilterCompileError("`and` requires a non-empty array");
    }
    return `(${node.and.map((child) => renderNode(child, depth + 1)).join(" AND ")})`;
  }
  if ("or" in node) {
    if (!Array.isArray(node.or) || node.or.length === 0) {
      throw new FilterCompileError("`or` requires a non-empty array");
    }
    return `(${node.or.map((child) => renderNode(child, depth + 1)).join(" OR ")})`;
  }
  if ("not" in node) {
    if (!node.not || typeof node.not !== "object") {
      throw new FilterCompileError("`not` requires a filter node");
    }
    return `(NOT ${renderNode(node.not, depth + 1)})`;
  }

  const leaf = node as FilterLeaf;
  if (!leaf.field || typeof leaf.field !== "string") {
    throw new FilterCompileError("Leaf filter requires a string `field`");
  }
  if (!COMPARE_OPS.has(leaf.op)) {
    throw new FilterCompileError(`Unknown operator: ${String(leaf.op)}`);
  }
  const column = resolveColumn(leaf.field);

  if (leaf.op === "IN") {
    if (!Array.isArray(leaf.value) || leaf.value.length === 0) {
      throw new FilterCompileError("`IN` requires a non-empty array value");
    }
    if (leaf.value.length > MAX_IN_ITEMS) {
      throw new FilterCompileError(`IN list exceeds max items ${MAX_IN_ITEMS}`);
    }
    const items = leaf.value.map((item) => {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
        throw new FilterCompileError("IN items must be string, number, or boolean");
      }
      return renderLiteral(column, item);
    });
    return `(${column} IN (${items.join(", ")}))`;
  }

  if (Array.isArray(leaf.value)) {
    throw new FilterCompileError(`Operator ${leaf.op} does not accept array values`);
  }
  if (typeof leaf.value !== "string" && typeof leaf.value !== "number" && typeof leaf.value !== "boolean") {
    throw new FilterCompileError("Compare value must be string, number, or boolean");
  }
  return `(${column} ${leaf.op} ${renderLiteral(column, leaf.value)})`;
}

function compileAst(node: FilterNode): string {
  const leaves = countLeaves(node);
  if (leaves > MAX_CLAUSES) {
    throw new FilterCompileError(`Filter exceeds max clauses ${MAX_CLAUSES}`);
  }
  return renderNode(node, 0);
}

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "op"; value: CompareOp | "AND" | "OR" | "NOT" | "(" | ")" | "," };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let value = "";
      while (i < input.length) {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        if (input[i] === quote) {
          i++;
          break;
        }
        value += input[i];
        i++;
      }
      assertStringLen(value);
      tokens.push({ kind: "string", value });
      continue;
    }
    if (/[<>!=]/.test(ch)) {
      const two = input.slice(i, i + 2);
      if (two === ">=" || two === "<=" || two === "!=" || two === "<>") {
        tokens.push({ kind: "op", value: two === "<>" ? "!=" : two as CompareOp });
        i += 2;
        continue;
      }
      if (ch === "=" || ch === ">" || ch === "<") {
        tokens.push({ kind: "op", value: ch as CompareOp });
        i++;
        continue;
      }
      throw new FilterCompileError(`Unexpected operator near '${ch}'`);
    }
    if (/[0-9.]/.test(ch) || (ch === "-" && i + 1 < input.length && /[0-9]/.test(input[i + 1]))) {
      const start = i;
      i++;
      while (i < input.length && /[0-9.]/.test(input[i])) i++;
      const raw = input.slice(start, i);
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new FilterCompileError(`Invalid number: ${raw}`);
      tokens.push({ kind: "number", value: num });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i++;
      const raw = input.slice(start, i);
      const upper = raw.toUpperCase();
      if (upper === "AND" || upper === "OR" || upper === "NOT" || upper === "IN") {
        tokens.push({ kind: "op", value: upper as "AND" | "OR" | "NOT" | "IN" });
      } else if (upper === "TRUE") {
        tokens.push({ kind: "ident", value: "true" });
      } else if (upper === "FALSE") {
        tokens.push({ kind: "ident", value: "false" });
      } else {
        tokens.push({ kind: "ident", value: raw });
      }
      continue;
    }
    throw new FilterCompileError(`Unexpected character '${ch}'`);
  }
  return tokens;
}

class StringParser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): FilterNode {
    const node = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new FilterCompileError("Unexpected trailing tokens in filter string");
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private take(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new FilterCompileError("Unexpected end of filter string");
    this.pos++;
    return token;
  }

  private parseOr(): FilterNode {
    let left = this.parseAnd();
    while (this.peek()?.kind === "op" && this.peek()?.value === "OR") {
      this.take();
      const right = this.parseAnd();
      left = { or: [left, right] };
    }
    return left;
  }

  private parseAnd(): FilterNode {
    let left = this.parseUnary();
    while (this.peek()?.kind === "op" && this.peek()?.value === "AND") {
      this.take();
      const right = this.parseUnary();
      left = { and: [left, right] };
    }
    return left;
  }

  private parseUnary(): FilterNode {
    if (this.peek()?.kind === "op" && this.peek()?.value === "NOT") {
      this.take();
      return { not: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FilterNode {
    if (this.peek()?.kind === "op" && this.peek()?.value === "(") {
      this.take();
      const inner = this.parseOr();
      const close = this.take();
      if (!(close.kind === "op" && close.value === ")")) {
        throw new FilterCompileError("Expected closing ')'");
      }
      return inner;
    }

    const fieldTok = this.take();
    if (fieldTok.kind !== "ident") {
      throw new FilterCompileError("Expected field name");
    }
    // Resolve early so unknown fields fail with field name (DoD).
    resolveColumn(fieldTok.value);

    const opTok = this.take();
    if (opTok.kind !== "op") {
      throw new FilterCompileError("Expected comparison operator");
    }
    const opValue = opTok.value;
    if (opValue === "IN") {
      const open = this.take();
      if (!(open.kind === "op" && open.value === "(")) {
        throw new FilterCompileError("Expected '(' after IN");
      }
      const values: Array<string | number | boolean> = [];
      while (true) {
        values.push(this.parseScalar());
        const next = this.peek();
        if (next?.kind === "op" && next.value === ",") {
          this.take();
          continue;
        }
        break;
      }
      const close = this.take();
      if (!(close.kind === "op" && close.value === ")")) {
        throw new FilterCompileError("Expected ')' after IN list");
      }
      return { field: fieldTok.value, op: "IN", value: values };
    }

    const compareOps: CompareOp[] = ["=", "!=", ">", ">=", "<", "<="];
    if (!compareOps.includes(opValue as CompareOp)) {
      throw new FilterCompileError(`Unknown operator: ${String(opValue)}`);
    }
    return {
      field: fieldTok.value,
      op: opValue as CompareOp,
      value: this.parseScalar()
    };
  }

  private parseScalar(): string | number | boolean {
    const token = this.take();
    if (token.kind === "string") return token.value;
    if (token.kind === "number") return token.value;
    if (token.kind === "ident" && (token.value === "true" || token.value === "false")) {
      return token.value === "true";
    }
    throw new FilterCompileError("Expected string, number, or boolean literal");
  }
}

function parseFilterString(input: string): FilterNode {
  if (input.length > MAX_INPUT_LEN) {
    throw new FilterCompileError(`Filter string exceeds max length ${MAX_INPUT_LEN}`);
  }
  const tokens = tokenize(input);
  if (tokens.length === 0) {
    throw new FilterCompileError("Empty filter string");
  }
  return new StringParser(tokens).parse();
}

function isFilterNode(value: unknown): value is FilterNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if ("and" in obj || "or" in obj || "not" in obj) return true;
  return typeof obj.field === "string" && typeof obj.op === "string";
}

/**
 * Compile a filter to LanceDB SQL. Pass either `where` (string) or `filter` (structured).
 * Returns undefined when both are absent/empty.
 */
export function compileFilter(input: {
  where?: unknown;
  filter?: unknown;
}): string | undefined {
  const hasWhere = typeof input.where === "string" && input.where.trim().length > 0;
  const hasFilter = input.filter !== undefined && input.filter !== null;

  if (hasWhere && hasFilter) {
    throw new FilterCompileError("Provide either `where` or `filter`, not both");
  }
  if (!hasWhere && !hasFilter) return undefined;

  if (hasFilter) {
    if (!isFilterNode(input.filter)) {
      throw new FilterCompileError("Invalid structured `filter` object");
    }
    return compileAst(input.filter);
  }

  return compileAst(parseFilterString(String(input.where).trim()));
}

/** Cosine distance threshold predicate (LanceDB `_distance = 1 - cosine_similarity`). */
export function distanceWithinThreshold(distance: number, threshold: number): boolean {
  return distance <= threshold;
}

export type KeysetPage = {
  /** Opaque cursor = last seen chunk `id`. */
  cursor: string | null;
  limit: number;
};

export function normalizeKeysetPage(input: {
  cursor?: unknown;
  limit?: unknown;
  defaultLimit?: number;
  maxLimit?: number;
}): KeysetPage {
  const defaultLimit = input.defaultLimit ?? 100;
  const maxLimit = input.maxLimit ?? 5000;
  let limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.floor(input.limit)
    : defaultLimit;
  if (limit < 1) limit = 1;
  if (limit > maxLimit) {
    throw new FilterCompileError(`limit exceeds max ${maxLimit}`);
  }
  const cursor = typeof input.cursor === "string" && input.cursor.length > 0
    ? input.cursor
    : null;
  if (cursor && cursor.length > MAX_STRING_LEN) {
    throw new FilterCompileError("cursor too long");
  }
  return { cursor, limit };
}

/**
 * Build keyset predicate on primary key `id`.
 * Caller should also sort the returned page by `id` ascending.
 */
export function keysetPredicate(cursor: string | null): string | undefined {
  if (!cursor) return undefined;
  return `(id > '${escapeSql(cursor)}')`;
}

export function combinePredicates(...parts: Array<string | undefined>): string | undefined {
  const clauses = parts.filter((part): part is string => Boolean(part && part.trim()));
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return `(${clauses.join(" AND ")})`;
}
