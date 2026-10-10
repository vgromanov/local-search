import type { App } from "obsidian";
import {
  BODY_SOURCE,
  createLinkGraphIndexFromApp,
  type GraphEdge,
  type GraphEdgeSource,
  type GraphIdConflict,
  type GraphNode,
  type GraphUnresolved,
  type LinkGraph,
  type LinkGraphIndex
} from "./graph.ts";
import { DEFAULT_MAX_STRING_LENGTH, serializeValue, type JsonValue } from "./serialize.ts";

/**
 * Read-only `POST /graph/traverse/` over {@link createLinkGraphIndexFromApp}.
 * Local REST API authenticates the route before the handler runs.
 */

export const GRAPH_TRAVERSE_PATH = "/graph/traverse/";
export const DEFAULT_LIMIT_NODES = 2_000;
export const DEFAULT_LIMIT_EDGES = 20_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_LIMIT_NODES = 10_000;
export const MAX_LIMIT_EDGES = 100_000;
export const MAX_TIMEOUT_MS = 30_000;

export interface NoteView {
  frontmatter?: Record<string, unknown> | null;
  /** Full note text. Frontmatter is removed with `bodyStart` or a leading fence. */
  text?: string | null;
  bodyStart?: number | null;
  mtime?: number | null;
}

export interface GraphTraverseDeps {
  index: LinkGraphIndex;
  /** Read at request time. True when the metadata cache is settled. */
  indexReady: () => boolean;
  readNote?: (path: string) => Promise<NoteView | null> | NoteView | null;
  now?: () => number;
}

export interface TraverseNode {
  id: string;
  path: string;
  depth: number;
  fields: { [key: string]: JsonValue };
}

export interface TraverseEdge {
  from: string;
  to: string;
  source: string;
  section?: string | null;
}

export interface TraverseCycle {
  ids: string[];
  /** Edge sources this component was computed over, in request order. */
  sources: string[];
}

export interface GraphTraverseResponse {
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  unresolved: GraphUnresolved[];
  conflicts: GraphIdConflict[];
  cycles: TraverseCycle[];
  truncated: boolean;
  index_ready: boolean;
}

export type GraphTraverseOutcome =
  | { ok: true; body: GraphTraverseResponse }
  | { ok: false; status: number; message: string };

type Direction = "out" | "in" | "both";

interface ParsedQuery {
  scope: string;
  idField: string;
  edges: GraphEdgeSource[];
  cycleSources: string[];
  direction: Direction;
  maxDepth: number | null;
  include: string[];
  limitNodes: number;
  limitEdges: number;
  timeoutMs: number;
  start: string[] | null;
}

interface VaultFile {
  path?: string;
  extension?: string;
  stat?: { mtime?: number };
}

interface VaultReader {
  getAbstractFileByPath(path: string): unknown;
  cachedRead?(file: unknown): Promise<string>;
}

interface CacheReader {
  getFileCache?(file: unknown): {
    frontmatter?: Record<string, unknown>;
    frontmatterPosition?: { end?: { offset?: number } };
  } | null;
}

export function graphIndexReady(metadataCache: object | null | undefined): boolean {
  if (!metadataCache) return false;
  const record = metadataCache as {
    initialized?: unknown;
    inProgressTaskCount?: unknown;
    queue?: unknown;
  };
  if (record.initialized === false) return false;
  const pending = pendingMetadata(record);
  if (pending !== null && pending > 0) return false;
  return true;
}

export async function readVaultNote(app: {
  vault: VaultReader;
  metadataCache: CacheReader;
}, path: string): Promise<NoteView | null> {
  const file = app.vault.getAbstractFileByPath(path) as VaultFile | null;
  if (!file || file.extension !== "md") return null;
  const cache = app.metadataCache.getFileCache?.(file) ?? null;
  const text = typeof app.vault.cachedRead === "function"
    ? await app.vault.cachedRead(file)
    : null;
  const offset = cache?.frontmatterPosition?.end?.offset;
  const mtime = file.stat?.mtime;
  return {
    frontmatter: cache?.frontmatter ?? null,
    text,
    bodyStart: typeof offset === "number" && Number.isFinite(offset) ? offset : null,
    mtime: typeof mtime === "number" && Number.isFinite(mtime) ? mtime : null
  };
}

export function openGraphTraverse(app: App): { deps: GraphTraverseDeps; dispose: () => void } {
  const index = createLinkGraphIndexFromApp(app);
  return {
    deps: {
      index,
      indexReady: () => graphIndexReady(app.metadataCache),
      readNote: (path) => readVaultNote(app, path)
    },
    dispose: () => index.dispose()
  };
}

export function registerGraphTraverseRoute(
  api: {
    addRoute: (path: string) => {
      post?: (handler: (req: unknown, res: unknown) => void | Promise<void>) => unknown;
    };
    sendSuccess?: (res: unknown, body: unknown) => void;
    sendError?: (res: unknown, status: number, message: string) => void;
  },
  deps: GraphTraverseDeps
): void {
  api.addRoute(GRAPH_TRAVERSE_PATH).post?.(async (req, res) => {
    try {
      const outcome = await executeGraphTraverse(deps, readJsonBody(req));
      if (outcome.ok) {
        sendOk(api, res, outcome.body);
        return;
      }
      sendFailure(api, res, outcome.status, outcome.message);
    } catch (error) {
      sendFailure(api, res, 500, error instanceof Error ? error.message : String(error));
    }
  });
}

export async function executeGraphTraverse(
  deps: GraphTraverseDeps,
  body: unknown
): Promise<GraphTraverseOutcome> {
  const parsed = parseRequest(body);
  if (!parsed.ok) return fail(400, parsed.message);

  const query = parsed.value;
  let graph: LinkGraph;
  try {
    graph = deps.index.get({
      scope: query.scope,
      idField: query.idField,
      edges: query.edges
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid graph query";
    if (message.startsWith("Graph ")) return fail(400, message);
    throw error;
  }

  if (!graph.nodes.some((node) => node.inScope)) return fail(400, "scope has no notes");

  const byId = new Map<string, GraphNode[]>();
  const byPath = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    const listed = byId.get(node.id);
    if (listed) listed.push(node);
    else byId.set(node.id, [node]);
    byPath.set(node.path, node);
  }
  for (const listed of byId.values()) listed.sort((a, b) => compareText(a.path, b.path));

  const clock = deps.now ?? Date.now;
  const deadline = clock() + query.timeoutMs;
  const expired = (): boolean => clock() >= deadline;
  let truncated = false;
  const depth = new Map<string, number>();

  if (query.start === null) {
    const selected = selectWholeScope(graph, query.limitNodes);
    truncated = selected.truncated;
    for (const id of selected.ids) depth.set(id, 0);
  } else {
    const resolved = resolveStart(query.start, byId, byPath);
    if (!resolved.ok) return fail(400, `Unknown start: ${resolved.missing.join(", ")}`);
    const walked = walk(resolved.ids, adjacency(graph.edges, query.direction, byId), query.maxDepth, query.limitNodes, expired);
    truncated = walked.truncated;
    for (const [id, nodeDepth] of walked.depth) depth.set(id, nodeDepth);
  }

  const selectedNodes = nodesForIds(depth.keys(), byId);
  if (selectedNodes.length > query.limitNodes) truncated = true;

  let edges = graph.edges
    .filter((edge) => depth.has(edge.from) && depth.has(edge.to))
    .map(copyEdge)
    .sort(compareEdge);
  const cycleSources = new Set(query.cycleSources);
  const cycles = stronglyConnected(
    selectedNodes.map((node) => node.id),
    edges.filter((edge) => cycleSources.has(edge.source))
  ).map((ids): TraverseCycle => ({ ids, sources: [...query.cycleSources] }));
  if (edges.length > query.limitEdges) {
    edges = edges.slice(0, query.limitEdges);
    truncated = true;
  }

  const selectedIds = new Set(depth.keys());
  const unresolved = graph.unresolved
    .filter((entry) => selectedIds.has(entry.from))
    .map(copyUnresolved);
  const conflicts = relevantConflicts(graph.conflicts, selectedNodes).map(copyConflict);

  const nodes: TraverseNode[] = [];
  for (const node of selectedNodes) {
    const nodeDepth = depth.get(node.id) ?? 0;
    const projected = await projectNode(deps, node, query.include, expired);
    if (projected.truncated) truncated = true;
    nodes.push({
      id: node.id,
      path: node.path,
      depth: nodeDepth,
      fields: projected.fields
    });
  }
  nodes.sort(compareTraverseNode);

  return {
    ok: true,
    body: {
      nodes,
      edges,
      unresolved,
      conflicts,
      cycles,
      truncated,
      index_ready: deps.indexReady()
    }
  };
}

function selectWholeScope(graph: LinkGraph, limitNodes: number): { ids: string[]; truncated: boolean } {
  const inside = graph.nodes.filter((node) => node.inScope).map((node) => node.id).sort(compareText);
  const outside = graph.nodes.filter((node) => !node.inScope).map((node) => node.id).sort(compareText);
  const ordered = [...inside, ...outside];
  if (ordered.length <= limitNodes) return { ids: ordered, truncated: false };
  return { ids: ordered.slice(0, limitNodes), truncated: true };
}

function nodesForIds(ids: Iterable<string>, byId: Map<string, GraphNode[]>): GraphNode[] {
  const seen = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const id of ids) {
    for (const node of byId.get(id) ?? []) {
      if (seen.has(node.path)) continue;
      seen.add(node.path);
      nodes.push(node);
    }
  }
  return nodes;
}

function resolveStart(
  tokens: readonly string[],
  byId: Map<string, GraphNode[]>,
  byPath: Map<string, GraphNode>
): { ok: true; ids: string[] } | { ok: false; missing: string[] } {
  const ids: string[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  const reported = new Set<string>();
  for (const token of tokens) {
    const listed = byId.get(token);
    const node = listed && listed.length > 0 ? listed[0] : byPath.get(token);
    if (!node) {
      if (!reported.has(token)) {
        reported.add(token);
        missing.push(token);
      }
      continue;
    }
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    ids.push(node.id);
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, ids };
}

function adjacency(
  edges: readonly GraphEdge[],
  direction: Direction,
  byId: Map<string, GraphNode[]>
): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    if (!byId.has(from) || !byId.has(to)) return;
    const set = sets.get(from) ?? new Set<string>();
    set.add(to);
    sets.set(from, set);
  };
  for (const edge of edges) {
    if (direction === "out" || direction === "both") add(edge.from, edge.to);
    if (direction === "in" || direction === "both") add(edge.to, edge.from);
  }
  const sorted = new Map<string, string[]>();
  for (const [id, set] of sets) sorted.set(id, [...set].sort(compareText));
  return sorted;
}

function walk(
  seeds: readonly string[],
  neighborsOf: Map<string, string[]>,
  maxDepth: number | null,
  limitNodes: number,
  expired: () => boolean
): { depth: Map<string, number>; truncated: boolean } {
  const depth = new Map<string, number>();
  const ordered = [...seeds].sort(compareText);
  let truncated = ordered.length > limitNodes;
  for (const id of ordered.slice(0, limitNodes)) depth.set(id, 0);
  if (truncated || expired()) return { depth, truncated: true };

  let frontier = [...depth.keys()].sort(compareText);
  while (frontier.length > 0) {
    const next: string[] = [];
    let stop = false;
    for (const id of frontier) {
      const nodeDepth = depth.get(id) ?? 0;
      if (maxDepth !== null && nodeDepth >= maxDepth) continue;
      if (expired()) {
        truncated = true;
        stop = true;
        break;
      }
      for (const neighbor of neighborsOf.get(id) ?? []) {
        if (depth.has(neighbor)) continue;
        if (depth.size >= limitNodes) {
          truncated = true;
          stop = true;
          break;
        }
        depth.set(neighbor, nodeDepth + 1);
        next.push(neighbor);
      }
      if (stop) break;
    }
    if (stop) break;
    frontier = next.sort(compareText);
  }
  return { depth, truncated };
}

async function projectNode(
  deps: GraphTraverseDeps,
  node: GraphNode,
  include: readonly string[],
  expired: () => boolean
): Promise<{ fields: { [key: string]: JsonValue }; truncated: boolean }> {
  const fields: { [key: string]: JsonValue } = {};
  if (include.length === 0) return { fields, truncated: false };

  const needsNote = include.some((key) => key !== "$path");
  let note: NoteView | null = null;
  let truncated = false;
  if (needsNote) {
    if (expired()) {
      for (const key of include) fields[key] = key === "$path" ? node.path : null;
      return { fields, truncated: true };
    }
    try {
      note = (await deps.readNote?.(node.path)) ?? null;
    } catch {
      note = null;
    }
  }

  for (const key of include) {
    if (key === "$path") {
      fields[key] = node.path;
      continue;
    }
    if (key === "$mtime") {
      const mtime = note?.mtime;
      fields[key] = typeof mtime === "number" && Number.isFinite(mtime) ? mtime : null;
      continue;
    }
    if (key === "$body") {
      if (typeof note?.text !== "string") {
        fields[key] = null;
        continue;
      }
      let body = bodyExcludingFrontmatter(note.text, note.bodyStart);
      if (body.length > DEFAULT_MAX_STRING_LENGTH) {
        body = body.slice(0, DEFAULT_MAX_STRING_LENGTH);
        truncated = true;
      }
      fields[key] = body;
      continue;
    }
    const raw = readOwn(note?.frontmatter, key);
    if (raw === undefined) {
      fields[key] = null;
      continue;
    }
    const serialized = serializeValue(raw);
    if (serialized.truncated) truncated = true;
    fields[key] = serialized.value;
  }
  return { fields, truncated };
}

export function bodyExcludingFrontmatter(text: string, bodyStart?: number | null): string {
  if (typeof bodyStart === "number" && Number.isFinite(bodyStart) && bodyStart >= 0) {
    return text.slice(Math.min(Math.floor(bodyStart), text.length));
  }
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return text;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] !== "---") continue;
    const separator = text.includes("\r\n") ? "\r\n" : "\n";
    return lines.slice(index + 1).join(separator);
  }
  return text;
}

function stronglyConnected(ids: readonly string[], edges: readonly TraverseEdge[]): string[][] {
  const present = new Set(ids);
  const outgoing = new Map<string, string[]>();
  for (const id of ids) outgoing.set(id, []);
  for (const edge of edges) {
    if (!present.has(edge.from) || !present.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)?.push(edge.to);
  }
  for (const list of outgoing.values()) list.sort(compareText);

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let next = 0;
  const components: string[][] = [];

  const connect = (id: string): void => {
    index.set(id, next);
    low.set(id, next);
    next += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!index.has(target)) {
        connect(target);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(target) ?? 0));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const popped = stack.pop();
      if (popped === undefined) break;
      onStack.delete(popped);
      component.push(popped);
      if (popped === id) break;
    }
    if (component.length > 1) {
      component.sort(compareText);
      components.push(component);
    }
  };

  for (const id of [...ids].sort(compareText)) {
    if (!index.has(id)) connect(id);
  }
  components.sort((a, b) => compareText(a.join("\0"), b.join("\0")));
  return components;
}

function relevantConflicts(conflicts: readonly GraphIdConflict[], selected: readonly GraphNode[]): GraphIdConflict[] {
  const paths = new Set(selected.map((node) => node.path));
  const ids = new Set(selected.map((node) => node.id));
  return conflicts.filter((conflict) => ids.has(conflict.id) || conflict.paths.some((path) => paths.has(path)));
}

function copyEdge(edge: GraphEdge): TraverseEdge {
  const copy: TraverseEdge = { from: edge.from, to: edge.to, source: edge.source };
  if (Object.prototype.hasOwnProperty.call(edge, "section")) copy.section = edge.section ?? null;
  return copy;
}

function copyUnresolved(entry: GraphUnresolved): GraphUnresolved {
  const copy: GraphUnresolved = { from: entry.from, value: entry.value, source: entry.source };
  if (Object.prototype.hasOwnProperty.call(entry, "section")) copy.section = entry.section ?? null;
  return copy;
}

function copyConflict(conflict: GraphIdConflict): GraphIdConflict {
  return { id: conflict.id, paths: [...conflict.paths] };
}

function parseRequest(body: unknown): { ok: true; value: ParsedQuery } | { ok: false; message: string } {
  const record = asRecord(body);
  if (!record) return { ok: false, message: "Request body must be a JSON object" };

  if (record.scope !== undefined && typeof record.scope !== "string") {
    return { ok: false, message: "`scope` must be a string" };
  }
  const idField = parseIdField(record.id_field);
  if (!idField.ok) return idField;

  const edges = parseEdges(record.edges);
  if (!edges.ok) return edges;
  const cycleSources = parseCycleSources(record.cycle_sources, edges.value);
  if (!cycleSources.ok) return cycleSources;
  const direction = parseDirection(record.direction);
  if (!direction.ok) return direction;
  const maxDepth = parseMaxDepth(record.max_depth);
  if (!maxDepth.ok) return maxDepth;
  const include = parseInclude(record.include);
  if (!include.ok) return include;
  const limitNodes = parseCap(record.limit_nodes, DEFAULT_LIMIT_NODES, MAX_LIMIT_NODES, "limit_nodes");
  if (!limitNodes.ok) return limitNodes;
  const limitEdges = parseCap(record.limit_edges, DEFAULT_LIMIT_EDGES, MAX_LIMIT_EDGES, "limit_edges");
  if (!limitEdges.ok) return limitEdges;
  const timeoutMs = parseCap(record.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeout_ms");
  if (!timeoutMs.ok) return timeoutMs;
  const start = parseStart(record.start);
  if (!start.ok) return start;

  return {
    ok: true,
    value: {
      scope: typeof record.scope === "string" ? record.scope : "",
      idField: idField.value,
      edges: edges.value,
      cycleSources: cycleSources.value,
      direction: direction.value,
      maxDepth: maxDepth.value,
      include: include.value,
      limitNodes: limitNodes.value,
      limitEdges: limitEdges.value,
      timeoutMs: timeoutMs.value,
      start: start.value
    }
  };
}

function defaultCycleSources(edges: readonly GraphEdgeSource[]): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.source === BODY_SOURCE) continue;
    if (seen.has(edge.source)) continue;
    seen.add(edge.source);
    sources.push(edge.source);
  }
  return sources;
}

function parseCycleSources(
  raw: unknown,
  edges: readonly GraphEdgeSource[]
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: defaultCycleSources(edges) };
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.trim() === "")) {
    return { ok: false, message: "`cycle_sources` must be a list of edge sources" };
  }
  const available = new Set(edges.map((edge) => edge.source));
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!available.has(item)) {
      return { ok: false, message: "`cycle_sources` must list sources from `edges`" };
    }
    if (seen.has(item)) continue;
    seen.add(item);
    sources.push(item);
  }
  return { ok: true, value: sources };
}

function parseIdField(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, message: "`id_field` must be a non-empty string" };
  }
  return { ok: true, value: raw };
}

function parseDirection(raw: unknown): { ok: true; value: Direction } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: "out" };
  if (raw === "out" || raw === "in" || raw === "both") return { ok: true, value: raw };
  return { ok: false, message: "direction must be one of: out, in, both" };
}

function parseMaxDepth(raw: unknown): { ok: true; value: number | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return { ok: true, value: raw };
  return { ok: false, message: "`max_depth` must be a non-negative integer or null" };
}

function parseInclude(raw: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.trim() === "")) {
    return { ok: false, message: "`include` must be a list of field names" };
  }
  const include: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (seen.has(item)) continue;
    seen.add(item);
    include.push(item);
  }
  return { ok: true, value: include };
}

function parseStart(raw: unknown): { ok: true; value: string[] | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, message: "`start` must be a list of ids or paths" };
  if (raw.length === 0 || raw.some((item) => typeof item !== "string" || item.trim() === "")) {
    return { ok: false, message: "`start` must list at least one id or path" };
  }
  return { ok: true, value: [...raw] };
}

function parseEdges(raw: unknown): { ok: true; value: GraphEdgeSource[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: "edges must be a non-empty list" };
  }
  const edges: GraphEdgeSource[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record || typeof record.source !== "string" || record.source.trim() === "") {
      return { ok: false, message: "each edge source must be a non-empty string" };
    }
    const edge: GraphEdgeSource = { source: record.source };
    if (record.sections !== undefined) {
      if (!Array.isArray(record.sections) || record.sections.some((section) => typeof section !== "string")) {
        return { ok: false, message: "edge sections must be a list of strings" };
      }
      edge.sections = record.sections;
    }
    if (record.embeds !== undefined) {
      if (typeof record.embeds !== "boolean") return { ok: false, message: "edge embeds must be a boolean" };
      edge.embeds = record.embeds;
    }
    edges.push(edge);
  }
  return { ok: true, value: edges };
}

function parseCap(
  raw: unknown,
  fallback: number,
  hardMax: number,
  label: string
): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: Math.min(fallback, hardMax) };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, message: `\`${label}\` must be a positive integer` };
  }
  return { ok: true, value: Math.min(raw, hardMax) };
}

function pendingMetadata(cache: { inProgressTaskCount?: unknown; queue?: unknown }): number | null {
  const count = cache.inProgressTaskCount;
  if (typeof count === "number" && Number.isFinite(count)) return count;
  const queue = cache.queue;
  if (Array.isArray(queue)) return queue.length;
  if (queue && typeof queue === "object" && "length" in queue) {
    const length = (queue as { length?: unknown }).length;
    if (typeof length === "number" && Number.isFinite(length)) return length;
  }
  return null;
}

function readOwn(frontmatter: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!frontmatter || typeof frontmatter !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) return undefined;
  return frontmatter[key];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function fail(status: number, message: string): GraphTraverseOutcome {
  return { ok: false, status, message };
}

function readJsonBody(req: unknown): unknown {
  const request = req as { body?: unknown; json?: unknown };
  if (request?.body && typeof request.body === "object") return request.body;
  if (request?.json && typeof request.json === "object") return request.json;
  return {};
}

function sendOk(
  api: { sendSuccess?: (res: unknown, body: unknown) => void },
  res: unknown,
  body: GraphTraverseResponse
): void {
  if (api.sendSuccess) {
    api.sendSuccess(res, body);
    return;
  }
  const response = res as { status?: (status: number) => unknown; json?: (body: unknown) => void };
  response.status?.(200);
  response.json?.(body);
}

function sendFailure(
  api: { sendError?: (res: unknown, status: number, message: string) => void },
  res: unknown,
  status: number,
  message: string
): void {
  if (api.sendError) {
    api.sendError(res, status, message);
    return;
  }
  const response = res as { status?: (status: number) => unknown; json?: (body: unknown) => void };
  response.status?.(status);
  response.json?.({ ok: false, error: message, status });
}

function compareTraverseNode(a: TraverseNode, b: TraverseNode): number {
  return a.depth - b.depth || compareText(a.id, b.id) || compareText(a.path, b.path);
}

function compareEdge(a: TraverseEdge, b: TraverseEdge): number {
  return compareText(a.from, b.from)
    || compareText(a.to, b.to)
    || compareText(a.source, b.source)
    || compareText(sectionKey(a.section), sectionKey(b.section));
}

function sectionKey(section: string | null | undefined): string {
  if (section === undefined) return "0";
  if (section === null) return "1";
  return `2${section}`;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
