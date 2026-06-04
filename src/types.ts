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
  tags?: string[];
  frontmatter?: Record<string, unknown>;
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
