import type { DataAdapter, Plugin } from "obsidian";
import { normalizePath } from "obsidian";
import {
  INDEX_METRIC,
  QUERYABLE_FIELDS,
  SCALAR_FILTER_COLUMNS,
  SCHEMA_VER,
  type IndexMeta
} from "./schema";
import type { SearchOptions, SearchResult, VectorRecord } from "./types";

type FtsOptions = {
  lowercase?: boolean;
  stem?: boolean;
  removeStopWords?: boolean;
  asciiFolding?: boolean;
};

type LanceDbModule = {
  connect: (uri: string) => Promise<Connection>;
  Index: {
    fts: (options?: FtsOptions) => unknown;
  };
};

type Query = {
  where: (predicate: string) => Query;
  select: (columns: string[]) => Query;
  limit: (limit: number) => Query;
  fullTextSearch: (query: string, options?: { columns?: string[] }) => Query;
  toArray: () => Promise<Record<string, unknown>[]>;
};

type VectorQuery = Query & {
  distanceType: (distanceType: "cosine") => VectorQuery;
};

type IndexConfig = {
  name: string;
  columns?: string[];
};

type Table = {
  close: () => void;
  add: (data: Record<string, unknown>[]) => Promise<unknown>;
  update: (opts: { where: string; values: Record<string, unknown> }) => Promise<unknown>;
  delete: (predicate: string) => Promise<unknown>;
  countRows: (filter?: string) => Promise<number>;
  query: () => Query;
  vectorSearch: (vector: number[]) => VectorQuery;
  createIndex: (column: string, options?: { config?: unknown; replace?: boolean }) => Promise<void>;
  listIndices: () => Promise<IndexConfig[]>;
  optimize: () => Promise<unknown>;
};

type Connection = {
  close: () => void;
  tableNames: () => Promise<string[]>;
  openTable: (name: string) => Promise<Table>;
  createTable: (name: string, data: Record<string, unknown>[]) => Promise<Table>;
  dropTable: (name: string) => Promise<void>;
};

type LanceChunkRow = Omit<VectorRecord,
  "contentHash" |
  "bodyHash" |
  "frontmatterHash" |
  "chunkingConfigHash" |
  "embeddingModel" |
  "embeddingDim" |
  "indexedAt" |
  "tags" |
  "inlineTags" |
  "frontmatterTags" |
  "aliases" |
  "frontmatter" |
  "frontmatterKeys"
> & {
  vector: number[];
  content_hash: string;
  body_hash: string;
  frontmatter_hash: string;
  chunking_config_hash: string;
  embedding_model: string;
  embedding_dim: number;
  indexed_at: string;
  tags_json: string;
  tags_text: string;
  inline_tags_json: string;
  frontmatter_tags_json: string;
  aliases_json: string;
  aliases_text: string;
  frontmatter_json: string;
  frontmatter_keys_json: string;
  frontmatter_keys_text: string;
};

export type IndexDecision =
  | "missing"
  | "unchanged"
  | "metadata-only"
  | "content-changed"
  | "config-changed";

export type ExistingPathState = {
  exists: boolean;
  contentHash?: string;
  bodyHash?: string;
  frontmatterHash?: string;
  chunkingConfigHash?: string;
  embeddingModel?: string;
  embeddingDim?: number;
};

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

function listText(values: string[]): string {
  return `|${values.map((value) => value.toLowerCase()).join("|")}|`;
}

function toRow(record: VectorRecord): LanceChunkRow {
  return {
    id: record.id,
    path: record.path,
    folder: record.folder,
    basename: record.basename,
    mtime: record.mtime,
    size: record.size,
    position: record.position,
    text: record.text,
    vector: record.vector,
    title: record.title,
    status: record.status,
    project: record.project,
    type: record.type,
    uuid: record.uuid,
    workspace: record.workspace,
    date_bucket: record.date_bucket,
    signal_kind: record.signal_kind,
    workflow_id: record.workflow_id,
    schema_ver: record.schema_ver,
    content_hash: record.contentHash,
    body_hash: record.bodyHash,
    frontmatter_hash: record.frontmatterHash,
    chunking_config_hash: record.chunkingConfigHash,
    embedding_model: record.embeddingModel,
    embedding_dim: record.embeddingDim,
    indexed_at: record.indexedAt,
    tags_json: JSON.stringify(record.tags),
    tags_text: listText(record.tags),
    inline_tags_json: JSON.stringify(record.inlineTags),
    frontmatter_tags_json: JSON.stringify(record.frontmatterTags),
    aliases_json: JSON.stringify(record.aliases),
    aliases_text: listText(record.aliases),
    frontmatter_json: JSON.stringify(record.frontmatter),
    frontmatter_keys_json: JSON.stringify(record.frontmatterKeys),
    frontmatter_keys_text: listText(record.frontmatterKeys)
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function fromRow(row: Record<string, unknown>): SearchResult {
  const distance = typeof row._distance === "number" ? row._distance : undefined;
  const ftsScore = typeof row._score === "number" ? row._score : undefined;
  return {
    id: String(row.id ?? ""),
    path: String(row.path ?? ""),
    folder: String(row.folder ?? ""),
    basename: String(row.basename ?? ""),
    mtime: Number(row.mtime ?? 0),
    size: Number(row.size ?? 0),
    position: Number(row.position ?? 0),
    text: String(row.text ?? ""),
    distance,
    score: distance === undefined ? 0 : 1 / (1 + distance),
    ftsScore,
    tags: parseJson<string[]>(row.tags_json, []),
    frontmatter: parseJson<Record<string, unknown>>(row.frontmatter_json, {}),
    title: String(row.title ?? ""),
    status: String(row.status ?? ""),
    project: String(row.project ?? ""),
    type: String(row.type ?? ""),
    uuid: String(row.uuid ?? ""),
    workspace: String(row.workspace ?? ""),
    date_bucket: String(row.date_bucket ?? ""),
    signal_kind: String(row.signal_kind ?? ""),
    workflow_id: String(row.workflow_id ?? ""),
    schema_ver: String(row.schema_ver ?? "")
  };
}

const SEARCH_COLUMNS = [
  "id",
  "path",
  "folder",
  "basename",
  "mtime",
  "size",
  "position",
  "text",
  "tags_json",
  "frontmatter_json",
  "title",
  "status",
  "project",
  "type",
  "uuid",
  "workspace",
  "date_bucket",
  "signal_kind",
  "workflow_id",
  "schema_ver"
];

function pathWhere(path: string): string {
  return `path = '${escapeSql(path)}'`;
}

function buildWhere(options: SearchOptions): string | undefined {
  const clauses: string[] = [];

  if (options.where?.trim()) {
    clauses.push(`(${options.where.trim()})`);
  }

  if (options.allowedPaths) {
    if (options.allowedPaths.size === 0) {
      clauses.push("path = '__local_smart_lookup_no_match__'");
    } else {
      const paths = Array.from(options.allowedPaths).map((path) => `'${escapeSql(path)}'`);
      clauses.push(`path IN (${paths.join(", ")})`);
    }
  }

  for (const tag of options.tags ?? []) {
    const normalized = normalizeTag(tag).toLowerCase();
    if (normalized) clauses.push(`tags_text LIKE '%|${escapeSql(normalized)}|%'`);
  }

  for (const [key, value] of Object.entries(options.frontmatter ?? {})) {
    const column = QUERYABLE_FIELDS[key] ?? key;
    if ((SCALAR_FILTER_COLUMNS as readonly string[]).includes(column)) {
      clauses.push(`${column} = '${escapeSql(String(value))}'`);
      continue;
    }
    const jsonNeedle = `"${key}":${JSON.stringify(value)}`;
    clauses.push(`frontmatter_json LIKE '%${escapeSql(jsonNeedle)}%'`);
  }

  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

export class LanceVectorStore {
  private connection: Connection | null = null;
  private table: Table | null = null;
  private lancedb: LanceDbModule | null = null;
  private dbPath: string;
  private metaPath: string;
  private pluginDir: string;
  private tableName = "chunks";
  private lexicalColumn = "text";
  private lexicalIndexReady = false;
  private didResetSchema = false;

  constructor(private plugin: Plugin, private adapter: DataAdapter) {
    this.pluginDir = normalizePath(plugin.manifest.dir ?? ".obsidian/plugins/local-smart-lookup");
    this.dbPath = normalizePath(`${this.pluginDir}/lancedb`);
    this.metaPath = normalizePath(`${this.pluginDir}/index-meta.json`);
  }

  /** True if load() dropped the chunks table due to schema_ver mismatch. */
  consumedSchemaReset(): boolean {
    const value = this.didResetSchema;
    this.didResetSchema = false;
    return value;
  }

  async load(): Promise<void> {
    await this.ensureConnection();
    await this.ensureSchemaCurrent();
  }

  close(): void {
    this.table?.close();
    this.connection?.close();
    this.table = null;
    this.connection = null;
  }

  async readIndexMeta(): Promise<IndexMeta | null> {
    if (!(await this.adapter.exists(this.metaPath))) return null;
    try {
      const raw = JSON.parse(await this.adapter.read(this.metaPath)) as Partial<IndexMeta>;
      if (!raw || typeof raw !== "object") return null;
      return {
        schema_ver: String(raw.schema_ver ?? ""),
        metric: INDEX_METRIC,
        built_at: String(raw.built_at ?? ""),
        embedding_model: String(raw.embedding_model ?? ""),
        embedding_dim: Number(raw.embedding_dim ?? 0)
      };
    } catch {
      return null;
    }
  }

  async writeIndexMeta(meta: IndexMeta): Promise<void> {
    await this.adapter.write(this.metaPath, JSON.stringify(meta, null, 2));
  }

  async sampleIndexedEmbedding(): Promise<{ embeddingModel: string; embeddingDim: number } | null> {
    const table = await this.getTable();
    if (!table) return null;
    const rows = await table.query().select(["embedding_model", "embedding_dim"]).limit(1).toArray();
    if (rows.length === 0) return null;
    return {
      embeddingModel: String(rows[0].embedding_model ?? ""),
      embeddingDim: Number(rows[0].embedding_dim ?? 0)
    };
  }

  async count(): Promise<number> {
    const table = await this.getTable();
    return table ? table.countRows() : 0;
  }

  /** Count rows matching a compiler-emitted SQL predicate (SI path). */
  async countFiltered(whereSql?: string): Promise<number> {
    const table = await this.getTable();
    if (!table) return 0;
    return whereSql?.trim() ? table.countRows(whereSql) : table.countRows();
  }

  /**
   * Metadata sample for SI filter live validation.
   * Returns stable-ish rows (caller may sort); selects only safe columns.
   */
  async sampleFiltered(
    whereSql: string | undefined,
    limit = 5
  ): Promise<Array<Record<string, unknown>>> {
    const table = await this.getTable();
    if (!table) return [];
    let query = table.query().select([
      "id",
      "path",
      "uuid",
      "workspace",
      "date_bucket",
      "type",
      "mtime",
      "schema_ver"
    ]);
    if (whereSql?.trim()) query = query.where(whereSql);
    return query.limit(Math.max(1, limit)).toArray();
  }

  async paths(): Promise<Set<string>> {
    const table = await this.getTable();
    if (!table) return new Set();
    const rows = await table.query().select(["path"]).toArray();
    return new Set(rows.map((row) => String(row.path)));
  }

  async stateForPath(path: string): Promise<ExistingPathState> {
    const table = await this.getTable();
    if (!table) return { exists: false };

    const rows = await table.query()
      .where(pathWhere(path))
      .select([
        "content_hash",
        "body_hash",
        "frontmatter_hash",
        "chunking_config_hash",
        "embedding_model",
        "embedding_dim"
      ])
      .limit(1)
      .toArray();

    if (rows.length === 0) return { exists: false };
    const row = rows[0];
    return {
      exists: true,
      contentHash: String(row.content_hash ?? ""),
      bodyHash: String(row.body_hash ?? ""),
      frontmatterHash: String(row.frontmatter_hash ?? ""),
      chunkingConfigHash: String(row.chunking_config_hash ?? ""),
      embeddingModel: String(row.embedding_model ?? ""),
      embeddingDim: Number(row.embedding_dim ?? 0)
    };
  }

  decideIndex(existing: ExistingPathState, next: {
    contentHash: string;
    bodyHash: string;
    frontmatterHash: string;
    chunkingConfigHash: string;
    embeddingModel: string;
  }): IndexDecision {
    if (!existing.exists) return "missing";
    if (existing.chunkingConfigHash !== next.chunkingConfigHash || existing.embeddingModel !== next.embeddingModel) {
      return "config-changed";
    }
    if (existing.contentHash === next.contentHash) return "unchanged";
    if (existing.bodyHash === next.bodyHash && existing.frontmatterHash !== next.frontmatterHash) {
      return "metadata-only";
    }
    return "content-changed";
  }

  async replacePath(path: string, records: VectorRecord[]): Promise<void> {
    await this.deletePath(path);
    if (records.length === 0) return;
    const table = await this.ensureTable(records);
    await table.add(records.map(toRow));
  }

  async updatePathMetadata(path: string, metadata: Partial<VectorRecord>): Promise<void> {
    const table = await this.getTable();
    if (!table) return;
    const tags = metadata.tags ?? [];
    const inlineTags = metadata.inlineTags ?? [];
    const frontmatterTags = metadata.frontmatterTags ?? [];
    const aliases = metadata.aliases ?? [];
    const frontmatter = metadata.frontmatter ?? {};
    const frontmatterKeys = metadata.frontmatterKeys ?? [];

    await table.update({
      where: pathWhere(path),
      values: {
        mtime: metadata.mtime ?? 0,
        size: metadata.size ?? 0,
        content_hash: metadata.contentHash ?? "",
        frontmatter_hash: metadata.frontmatterHash ?? "",
        tags_json: JSON.stringify(tags),
        tags_text: listText(tags),
        inline_tags_json: JSON.stringify(inlineTags),
        frontmatter_tags_json: JSON.stringify(frontmatterTags),
        aliases_json: JSON.stringify(aliases),
        aliases_text: listText(aliases),
        frontmatter_json: JSON.stringify(frontmatter),
        frontmatter_keys_json: JSON.stringify(frontmatterKeys),
        frontmatter_keys_text: listText(frontmatterKeys),
        title: metadata.title ?? "",
        status: metadata.status ?? "",
        project: metadata.project ?? "",
        type: metadata.type ?? "",
        uuid: metadata.uuid ?? "",
        workspace: metadata.workspace ?? "",
        date_bucket: metadata.date_bucket ?? "",
        signal_kind: metadata.signal_kind ?? "",
        workflow_id: metadata.workflow_id ?? "",
        schema_ver: metadata.schema_ver ?? SCHEMA_VER,
        indexed_at: metadata.indexedAt ?? new Date().toISOString()
      }
    });
  }

  async renamePath(oldPath: string, newPath: string, basename: string, folder: string): Promise<void> {
    const table = await this.getTable();
    if (!table) return;
    await table.update({
      where: pathWhere(oldPath),
      values: {
        path: newPath,
        basename,
        folder
      }
    });
  }

  async removeMissingPaths(existingPaths: Set<string>): Promise<number> {
    const indexed = await this.paths();
    let removed = 0;
    for (const path of indexed) {
      if (!existingPaths.has(path)) {
        await this.deletePath(path);
        removed++;
      }
    }
    return removed;
  }

  async search(vector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    const table = await this.getTable();
    if (!table) return [];

    const limit = Math.max(1, options.limit ?? 10);
    let query = table.vectorSearch(vector).distanceType("cosine").limit(limit);
    const where = buildWhere(options);
    if (where) query = query.where(where);

    const rows = await query.select([...SEARCH_COLUMNS, "_distance"]).toArray();
    return rows.map(fromRow);
  }

  async searchLexical(text: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const table = await this.getTable();
    if (!table) return [];
    if (!(await this.ensureLexicalIndex())) return [];

    const limit = Math.max(1, options.limit ?? 10);
    try {
      let query = table.query().fullTextSearch(trimmed, { columns: [this.lexicalColumn] });
      const where = buildWhere(options);
      if (where) query = query.where(where);
      const rows = await query.limit(limit).select([...SEARCH_COLUMNS, "_score"]).toArray();
      return rows.map(fromRow);
    } catch (error) {
      console.error("Local Smart Lookup lexical search failed", error);
      return [];
    }
  }

  async ensureLexicalIndex(rebuild = false): Promise<boolean> {
    if (this.lexicalIndexReady && !rebuild) return true;
    const table = await this.getTable();
    if (!table) return false;

    try {
      if (!rebuild) {
        const indices = await table.listIndices();
        const hasFts = indices.some((index) => (index.columns ?? []).includes(this.lexicalColumn));
        if (hasFts) {
          this.lexicalIndexReady = true;
          return true;
        }
      }

      const lancedb = this.loadLanceDb();
      await table.createIndex(this.lexicalColumn, {
        config: lancedb.Index.fts({
          lowercase: true,
          stem: true,
          removeStopWords: true,
          asciiFolding: true
        }),
        replace: true
      });
      this.lexicalIndexReady = true;
      return true;
    } catch (error) {
      console.error("Local Smart Lookup failed to build lexical index", error);
      return false;
    }
  }

  async optimize(): Promise<void> {
    const table = await this.getTable();
    if (!table) return;
    try {
      await table.optimize();
    } catch (error) {
      console.error("Local Smart Lookup optimize failed", error);
    }
  }

  private async ensureSchemaCurrent(): Promise<void> {
    const table = await this.getTable();
    if (!table) return;

    let onDiskVer = "";
    try {
      const rows = await table.query().select(["schema_ver"]).limit(1).toArray();
      onDiskVer = String(rows[0]?.schema_ver ?? "");
    } catch {
      onDiskVer = "";
    }

    if (onDiskVer === SCHEMA_VER) return;

    console.info(
      `Local Smart Lookup: schema_ver "${onDiskVer || "(missing)"}" != "${SCHEMA_VER}"; dropping chunks table for recreate.`
    );
    await this.dropChunksTable();
    this.didResetSchema = true;
  }

  private async dropChunksTable(): Promise<void> {
    this.table?.close();
    this.table = null;
    this.lexicalIndexReady = false;
    const connection = await this.ensureConnection();
    const names = await connection.tableNames();
    if (names.includes(this.tableName)) {
      await connection.dropTable(this.tableName);
    }
    if (await this.adapter.exists(this.metaPath)) {
      await this.adapter.remove(this.metaPath);
    }
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.connection) return this.connection;
    if (!(await this.adapter.exists(this.dbPath))) {
      await this.adapter.mkdir(this.dbPath);
    }
    const lancedb = this.loadLanceDb();
    this.connection = await lancedb.connect(this.absoluteAdapterPath(this.dbPath));
    return this.connection;
  }

  private loadLanceDb(): LanceDbModule {
    if (this.lancedb) return this.lancedb;
    const pluginMainPath = `${this.absoluteAdapterPath(this.pluginDir)}/main.js`;
    const nodeRequire = require("module").createRequire(pluginMainPath);
    this.lancedb = nodeRequire("@lancedb/lancedb") as LanceDbModule;
    return this.lancedb;
  }

  private absoluteAdapterPath(path: string): string {
    const adapterWithBase = this.adapter as DataAdapter & { getBasePath?: () => string };
    const basePath = adapterWithBase.getBasePath?.();
    if (!basePath) {
      throw new Error("LanceDB requires the desktop file-system adapter so the plugin can resolve a local database path.");
    }
    return `${basePath}/${normalizePath(path)}`;
  }

  private async getTable(): Promise<Table | null> {
    if (this.table) return this.table;
    const connection = await this.ensureConnection();
    const names = await connection.tableNames();
    if (!names.includes(this.tableName)) return null;
    this.table = await connection.openTable(this.tableName);
    return this.table;
  }

  private async ensureTable(records: VectorRecord[]): Promise<Table> {
    const existing = await this.getTable();
    if (existing) return existing;
    const connection = await this.ensureConnection();
    this.table = await connection.createTable(this.tableName, records.map(toRow));
    return this.table;
  }

  private async deletePath(path: string): Promise<void> {
    const table = await this.getTable();
    if (!table) return;
    await table.delete(pathWhere(path));
  }
}
