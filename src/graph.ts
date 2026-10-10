import type { App, CachedMetadata, EmbedCache, HeadingCache, LinkCache } from "obsidian";
import { serializeValue, type JsonValue } from "./serialize.ts";

/**
 * In-memory link graph over Obsidian `metadataCache`.
 *
 * RVG-198 should call {@link createLinkGraphIndexFromApp} and then `get`.
 * Field values are normalized with {@link serializeValue}; this module does
 * not walk DataArray `.value`.
 */

/** Reserved edge source: body links (and embeds when requested), not frontmatter. */
export const BODY_SOURCE = "$body";

export interface GraphEdgeSource {
  /** Frontmatter field name, or {@link BODY_SOURCE}. */
  source: string;
  /**
   * `$body` only. When non-empty, keep a link whose nearest heading or an
   * ancestor heading is in this list. Omitted or empty keeps every section.
   */
  sections?: readonly string[];
  /** `$body` only. Include `CachedMetadata.embeds` when true. */
  embeds?: boolean;
}

export interface GraphQuery {
  /** Folder prefix. `""` is the whole vault. A trailing slash matches descendants only. */
  scope: string;
  /**
   * Frontmatter field used as the node id when it is a non-empty scalar.
   * An empty string means path identity: every node id is its vault path, and
   * edge values resolve by link resolution and exact path only.
   */
  idField: string;
  edges: readonly GraphEdgeSource[];
}

export interface GraphNode {
  id: string;
  path: string;
  inScope: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  source: string;
  /**
   * Set only for `$body` edges. Null when the link sits above the first heading.
   */
  section?: string | null;
}

export interface GraphUnresolved {
  from: string;
  value: string;
  source: string;
  /** Set only for `$body` edges, with the same meaning as {@link GraphEdge.section}. */
  section?: string | null;
}

export interface GraphIdConflict {
  /** Shared id. The first path in {@link paths} owns it. */
  id: string;
  /** Every path that claimed `id`, sorted. */
  paths: string[];
}

export interface LinkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: GraphUnresolved[];
  conflicts: GraphIdConflict[];
}

export interface LinkGraphIndex {
  /** Cached, immutable graph. Callers must not mutate the returned objects. */
  get(query: GraphQuery): LinkGraph;
  invalidate(): void;
  dispose(): void;
}

/** Narrow host so tests can build a graph without constructing an Obsidian `App`. */
export interface LinkGraphHost {
  listMarkdownPaths(): readonly string[];
  getCache(path: string): CachedMetadata | null;
  /** `metadataCache.getFirstLinkpathDest`, or null when the link does not resolve. */
  resolveLink(linkpath: string, sourcePath: string): string | null;
  /** Fired for metadataCache `changed` / `resolved` and vault `rename` / `delete`. */
  subscribe(listener: () => void): () => void;
}

interface CanonEdge {
  source: string;
  sections: string[];
  embeds: boolean;
}

interface NoteRef {
  path: string;
  id: string;
}

interface OrderedHeading {
  heading: string;
  level: number;
  offset: number;
  index: number;
}

interface BuildState {
  host: LinkGraphHost;
  scope: string;
  pathSet: Set<string>;
  notes: Map<string, NoteRef>;
  idOwner: Map<string, string>;
  caches: Map<string, CachedMetadata | null>;
  edges: GraphEdge[];
  unresolved: GraphUnresolved[];
  edgeKeys: Set<string>;
  unresolvedKeys: Set<string>;
  targeted: Set<string>;
}

export function createLinkGraphIndexFromApp(app: App): LinkGraphIndex {
  return createLinkGraphIndex({
    listMarkdownPaths() {
      return app.vault.getMarkdownFiles().map((file) => file.path);
    },
    getCache(path) {
      return app.metadataCache.getCache(path);
    },
    resolveLink(linkpath, sourcePath) {
      return app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
    },
    subscribe(listener) {
      const metadataRefs = [
        app.metadataCache.on("changed", listener),
        app.metadataCache.on("resolved", listener)
      ];
      const vaultRefs = [
        app.vault.on("rename", listener),
        app.vault.on("delete", listener)
      ];
      return () => {
        for (const ref of metadataRefs) app.metadataCache.offref(ref);
        for (const ref of vaultRefs) app.vault.offref(ref);
      };
    }
  });
}

export function createLinkGraphIndex(host: LinkGraphHost): LinkGraphIndex {
  const cache = new Map<string, LinkGraph>();
  let disposed = false;
  const unsubscribe = host.subscribe(() => {
    cache.clear();
  });

  return {
    get(query) {
      if (disposed) throw new Error("Link graph index is disposed");
      validateQuery(query);
      const key = cacheKey(query);
      const hit = cache.get(key);
      if (hit) return hit;
      const graph = buildGraph(host, query);
      cache.set(key, graph);
      return graph;
    },
    invalidate() {
      cache.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cache.clear();
      unsubscribe();
    }
  };
}

function buildGraph(host: LinkGraphHost, query: GraphQuery): LinkGraph {
  validateQuery(query);
  const scope = query.scope.trim();
  const idField = query.idField.trim();
  const specs = canonicalizeEdges(query.edges);
  const paths = uniqueSorted(host.listMarkdownPaths());
  const state: BuildState = {
    host,
    scope,
    pathSet: new Set(paths),
    notes: new Map(),
    idOwner: new Map(),
    caches: new Map(),
    edges: [],
    unresolved: [],
    edgeKeys: new Set(),
    unresolvedKeys: new Set(),
    targeted: new Set()
  };

  const claimsById = new Map<string, string[]>();
  for (const path of paths) {
    const claimed = readId(cacheFor(state, path), idField);
    if (claimed == null) {
      state.notes.set(path, { path, id: path });
      continue;
    }
    const list = claimsById.get(claimed) ?? [];
    list.push(path);
    claimsById.set(claimed, list);
    if (list.length === 1) {
      state.idOwner.set(claimed, path);
      state.notes.set(path, { path, id: claimed });
    } else {
      state.notes.set(path, { path, id: path });
    }
  }

  const conflicts: GraphIdConflict[] = [];
  for (const [id, claimedPaths] of claimsById) {
    if (claimedPaths.length < 2) continue;
    conflicts.push({ id, paths: [...claimedPaths].sort(compareText) });
  }
  conflicts.sort((a, b) => compareText(a.id, b.id));

  for (const path of paths) {
    if (!pathInScope(path, scope)) continue;
    const source = state.notes.get(path);
    if (!source) continue;
    const cache = cacheFor(state, path);
    for (const spec of specs) {
      if (spec.source === BODY_SOURCE) collectBody(state, cache, source, spec);
      else collectField(state, cache, source, spec);
    }
  }

  const nodes: GraphNode[] = [];
  for (const path of paths) {
    const inScope = pathInScope(path, scope);
    if (!inScope && !state.targeted.has(path)) continue;
    const note = state.notes.get(path);
    if (!note) continue;
    nodes.push({ id: note.id, path, inScope });
  }

  state.edges.sort(compareEdge);
  state.unresolved.sort(compareUnresolved);
  return { nodes, edges: state.edges, unresolved: state.unresolved, conflicts };
}

function cacheFor(state: BuildState, path: string): CachedMetadata | null {
  if (state.caches.has(path)) return state.caches.get(path) ?? null;
  const cache = state.host.getCache(path);
  state.caches.set(path, cache);
  return cache;
}

function collectField(state: BuildState, cache: CachedMetadata | null, source: NoteRef, spec: CanonEdge): void {
  const raw = readOwn(cache?.frontmatter, spec.source);
  if (raw === undefined) return;
  for (const token of referenceTokens(serializeValue(raw).value)) {
    const resolved = resolveReference(state, token, source.path);
    if (!resolved) {
      pushUnresolved(state, { from: source.id, value: token, source: spec.source });
      continue;
    }
    pushEdge(state, {
      from: source.id,
      to: state.notes.get(resolved)!.id,
      source: spec.source
    }, resolved);
  }
}

function collectBody(state: BuildState, cache: CachedMetadata | null, source: NoteRef, spec: CanonEdge): void {
  const refs: Array<LinkCache | EmbedCache> = [...(cache?.links ?? [])];
  if (spec.embeds) refs.push(...(cache?.embeds ?? []));
  const filter = spec.sections.length > 0 ? new Set(spec.sections) : null;
  const headings = orderedHeadings(cache?.headings);

  for (const ref of refs) {
    const offset = ref.position?.start?.offset;
    if (typeof offset === "number" && insideFrontmatter(cache, offset)) continue;
    const stack = typeof offset === "number" ? headingsAt(headings, offset) : [];
    if (filter && !stack.some((heading) => filter.has(heading))) continue;
    const section = stack.length > 0 ? stack[stack.length - 1] : null;
    const token = typeof ref.link === "string" ? ref.link.trim() : "";
    if (!token) continue;
    const resolved = resolveReference(state, token, source.path);
    if (!resolved) {
      pushUnresolved(state, { from: source.id, value: token, source: BODY_SOURCE, section });
      continue;
    }
    pushEdge(state, {
      from: source.id,
      to: state.notes.get(resolved)!.id,
      source: BODY_SOURCE,
      section
    }, resolved);
  }
}

function pushEdge(state: BuildState, edge: GraphEdge, targetPath: string): void {
  const key = edgeKey(edge);
  if (state.edgeKeys.has(key)) return;
  state.edgeKeys.add(key);
  state.edges.push(edge);
  state.targeted.add(targetPath);
}

function pushUnresolved(state: BuildState, entry: GraphUnresolved): void {
  const key = unresolvedKey(entry);
  if (state.unresolvedKeys.has(key)) return;
  state.unresolvedKeys.add(key);
  state.unresolved.push(entry);
}

function resolveReference(state: BuildState, token: string, sourcePath: string): string | null {
  const linkpath = normalizeRef(token);
  if (!linkpath) return null;
  const byId = state.idOwner.get(linkpath);
  if (byId) return byId;
  const linked = state.host.resolveLink(linkpath, sourcePath);
  if (linked && state.pathSet.has(linked)) return linked;
  if (state.pathSet.has(linkpath)) return linkpath;
  if (!linkpath.endsWith(".md") && state.pathSet.has(`${linkpath}.md`)) return `${linkpath}.md`;
  return null;
}

/**
 * Full-string wikilink or embed, then alias / heading / block suffixes.
 * Plain strings keep a single leading subpath cut so `Note#Heading` resolves to `Note`.
 */
function normalizeRef(raw: string): string {
  let text = raw.trim();
  const wiki = /^!?\[\[([\s\S]*?)\]\]$/.exec(text);
  if (wiki) text = wiki[1];
  const pipe = text.indexOf("|");
  if (pipe >= 0) text = text.slice(0, pipe);
  const hash = text.indexOf("#");
  if (hash >= 0) text = text.slice(0, hash);
  return text.trim();
}

function readId(cache: CachedMetadata | null, idField: string): string | null {
  if (idField === "") return null;
  const raw = readOwn(cache?.frontmatter, idField);
  if (raw === undefined || Array.isArray(raw)) return null;
  const serialized = serializeValue(raw).value;
  if (typeof serialized === "number" && Number.isFinite(serialized)) {
    const asId = normalizeRef(String(serialized));
    return asId || null;
  }
  if (typeof serialized !== "string") return null;
  const id = normalizeRef(serialized);
  return id || null;
}

function referenceTokens(value: JsonValue): string[] {
  const tokens: string[] = [];
  collectTokens(value, tokens);
  return tokens;
}

function collectTokens(value: JsonValue, tokens: string[]): void {
  if (typeof value === "string") {
    const token = value.trim();
    if (token) tokens.push(token);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    tokens.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTokens(item, tokens);
  }
}

function readOwn(frontmatter: CachedMetadata["frontmatter"], key: string): unknown {
  if (!frontmatter || typeof frontmatter !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) return undefined;
  return frontmatter[key];
}

function insideFrontmatter(cache: CachedMetadata | null, offset: number): boolean {
  if (!cache) return false;
  const frontmatter = cache.frontmatterPosition;
  if (frontmatter && offset >= frontmatter.start.offset && offset < frontmatter.end.offset) return true;
  for (const section of cache.sections ?? []) {
    if (section.type !== "yaml") continue;
    const start = section.position?.start?.offset;
    const end = section.position?.end?.offset;
    if (typeof start === "number" && typeof end === "number" && offset >= start && offset < end) return true;
  }
  return false;
}

function orderedHeadings(headings: HeadingCache[] | undefined): OrderedHeading[] {
  const ordered: OrderedHeading[] = [];
  (headings ?? []).forEach((heading, index) => {
    const text = heading.heading?.trim() ?? "";
    const offset = heading.position?.start?.offset;
    if (!text || typeof offset !== "number") return;
    ordered.push({ heading: text, level: heading.level || 1, offset, index });
  });
  ordered.sort((a, b) => a.offset - b.offset || a.index - b.index);
  return ordered;
}

function headingsAt(headings: OrderedHeading[], offset: number): string[] {
  const stack: OrderedHeading[] = [];
  for (const heading of headings) {
    if (heading.offset > offset) break;
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
    stack.push(heading);
  }
  return stack.map((heading) => heading.heading);
}

function pathInScope(path: string, scope: string): boolean {
  if (scope === "") return true;
  if (scope.endsWith("/")) return path.startsWith(scope);
  return path === scope || path.startsWith(`${scope}/`);
}

function canonicalizeEdges(edges: readonly GraphEdgeSource[]): CanonEdge[] {
  return edges
    .map((edge) => ({
      source: edge.source.trim(),
      sections: (edge.sections ?? [])
        .map((section) => section.trim())
        .filter((section) => section !== "")
        .sort(compareText),
      embeds: edge.embeds === true
    }))
    .sort((a, b) => compareText(a.source, b.source)
      || compareText(a.sections.join("\0"), b.sections.join("\0"))
      || Number(a.embeds) - Number(b.embeds));
}

function validateQuery(query: GraphQuery): void {
  if (!query || typeof query.scope !== "string") throw new Error("Graph scope must be a string");
  if (typeof query.idField !== "string" || (query.idField.trim() === "" && query.idField !== "")) {
    throw new Error("Graph idField must be a non-empty string");
  }
  if (!Array.isArray(query.edges) || query.edges.length === 0) {
    throw new Error("Graph edges must be a non-empty list");
  }
  for (const edge of query.edges) {
    if (!edge || typeof edge.source !== "string" || edge.source.trim() === "") {
      throw new Error("Graph edge source must be a non-empty string");
    }
    if (edge.sections === undefined) continue;
    if (!Array.isArray(edge.sections) || edge.sections.some((section) => typeof section !== "string")) {
      throw new Error("Graph edge sections must be a list of strings");
    }
  }
}

function cacheKey(query: GraphQuery): string {
  return JSON.stringify({
    scope: query.scope.trim(),
    idField: query.idField.trim(),
    edges: canonicalizeEdges(query.edges)
  });
}

function uniqueSorted(paths: readonly string[]): string[] {
  const sorted = paths.filter((path) => typeof path === "string" && path.length > 0).sort(compareText);
  const unique: string[] = [];
  for (const path of sorted) {
    if (unique.length === 0 || unique[unique.length - 1] !== path) unique.push(path);
  }
  return unique;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareEdge(a: GraphEdge, b: GraphEdge): number {
  return compareText(a.from, b.from)
    || compareText(a.to, b.to)
    || compareText(a.source, b.source)
    || compareText(sectionSortKey(a.section), sectionSortKey(b.section));
}

function compareUnresolved(a: GraphUnresolved, b: GraphUnresolved): number {
  return compareText(a.from, b.from)
    || compareText(a.source, b.source)
    || compareText(a.value, b.value)
    || compareText(sectionSortKey(a.section), sectionSortKey(b.section));
}

function sectionSortKey(section: string | null | undefined): string {
  if (section === undefined) return "0";
  if (section === null) return "1";
  return `2${section}`;
}

function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([
    edge.from,
    edge.to,
    edge.source,
    Object.prototype.hasOwnProperty.call(edge, "section") ? edge.section : undefined
  ]);
}

function unresolvedKey(entry: GraphUnresolved): string {
  return JSON.stringify([
    entry.from,
    entry.source,
    entry.value,
    Object.prototype.hasOwnProperty.call(entry, "section") ? entry.section : undefined
  ]);
}
