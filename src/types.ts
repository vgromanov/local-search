import type { TFile } from "obsidian";

export interface LocalSmartLookupSettings {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingPath: string;
  rerankBaseUrl: string;
  rerankModel: string;
  rerankPath: string;
  useRerank: boolean;
  chunkSize: number;
  chunkOverlap: number;
  defaultLimit: number;
  defaultDataviewSource: string;
  useLexical: boolean;
  candidateMultiplier: number;
  rerankPoolSize: number;
  rrfK: number;
  rrfWeightRerank: number;
  rrfWeightVector: number;
  rrfWeightLexical: number;
}

export interface VaultChunk {
  id: string;
  path: string;
  folder: string;
  basename: string;
  mtime: number;
  size: number;
  position: number;
  text: string;
}

export interface VectorRecord extends VaultChunk {
  vector: number[];
  contentHash: string;
  bodyHash: string;
  frontmatterHash: string;
  chunkingConfigHash: string;
  embeddingModel: string;
  embeddingDim: number;
  indexedAt: string;
  tags: string[];
  inlineTags: string[];
  frontmatterTags: string[];
  aliases: string[];
  frontmatter: Record<string, unknown>;
  frontmatterKeys: string[];
  title: string;
  status: string;
  project: string;
  type: string;
  /** Note/session id from frontmatter.uuid ?? session_uuid (not chunk id). */
  uuid: string;
  workspace: string;
  /** YYYY-MM-DD from frontmatter.date or Daily/ path; "" if absent. */
  date_bucket: string;
  signal_kind: string;
  workflow_id: string;
  schema_ver: string;
}

export interface SearchOptions {
  limit?: number;
  dataviewSource?: string;
  dataviewQuery?: string;
  allowedPaths?: Set<string>;
  where?: string;
  tags?: string[];
  frontmatter?: Record<string, string | number | boolean>;
}

export interface SearchResult extends VaultChunk {
  score: number;
  distance?: number;
  rerankScore?: number;
  ftsScore?: number;
  fusedScore?: number;
  vectorRank?: number;
  lexicalRank?: number;
  rerankRank?: number;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
  title?: string;
  status?: string;
  project?: string;
  type?: string;
  uuid?: string;
  workspace?: string;
  date_bucket?: string;
  signal_kind?: string;
  workflow_id?: string;
  schema_ver?: string;
}

export interface DataviewApi {
  pages?: (source?: string) => unknown;
  query?: (query: string, file?: string) => Promise<unknown>;
}

export interface ObsidianRestPublicApi {
  addRoute: (path: string) => {
    get?: (handler: (req: unknown, res: unknown) => void | Promise<void>) => unknown;
    post?: (handler: (req: unknown, res: unknown) => void | Promise<void>) => unknown;
  };
  sendSuccess?: (res: unknown, body: unknown) => void;
  sendError?: (res: unknown, status: number, message: string) => void;
}

export type FileWithContent = {
  file: TFile;
  content: string;
};
