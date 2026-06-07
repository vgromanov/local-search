import type { DataAdapter, Plugin } from "obsidian";
import { normalizePath } from "obsidian";
import type { SearchOptions, SearchResult, VectorRecord } from "./types";

type LanceDbModule = {
  connect: (uri: string) => Promise<Connection>;
};

type Query = {
  where: (predicate: string) => Query;
  select: (columns: string[]) => Query;
  limit: (limit: number) => Query;
  toArray: () => Promise<Record<string, unknown>[]>;
};

type VectorQuery = Query & {
  distanceType: (distanceType: "cosine") => VectorQuery;
};

type Table = {
  close: () => void;
  add: (data: Record<string, unknown>[]) => Promise<unknown>;
  update: (opts: { where: string; values: Record<string, unknown> }) => Promise<unknown>;
  delete: (predicate: string) => Promise<unknown>;
  countRows: (filter?: string) => Promise<number>;
  query: () => Query;
  vectorSearch: (vector: number[]) => VectorQuery;
};

type Connection = {
  close: () => void;
  tableNames: () => Promise<string[]>;
  openTable: (name: string) => Promise<Table>;
  createTable: (name: string, data: Record<string, unknown>[]) => Promise<Table>;
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
    tags: parseJson<string[]>(row.tags_json, []),
    frontmatter: parseJson<Record<string, unknown>>(row.frontmatter_json, {})
  };
}

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
    if (["status", "project", "type", "title"].includes(key)) {
      clauses.push(`${key} = '${escapeSql(String(value))}'`);
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
  private pluginDir: string;
  private tableName = "chunks";

  constructor(private plugin: Plugin, private adapter: DataAdapter) {
    this.pluginDir = normalizePath(plugin.manifest.dir ?? ".obsidian/plugins/local-smart-lookup");
    this.dbPath = normalizePath(`${this.pluginDir}/lancedb`);
  }

  async load(): Promise<void> {
    await this.ensureConnection();
  }

  close(): void {
    this.table?.close();
    this.connection?.close();
    this.table = null;
    this.connection = null;
  }

  async count(): Promise<number> {
    const table = await this.getTable();
    return table ? table.countRows() : 0;
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

    const rows = await query.select([
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
      "_distance"
    ]).toArray();

    return rows.map(fromRow);
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
