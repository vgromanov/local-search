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
  basename: string;
  mtime: number;
  position: number;
  text: string;
}

export interface VectorRecord extends VaultChunk {
  vector: number[];
}

export interface SearchOptions {
  limit?: number;
  dataviewSource?: string;
  dataviewQuery?: string;
  allowedPaths?: Set<string>;
}

export interface SearchResult extends VaultChunk {
  score: number;
  rerankScore?: number;
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
  sendSuccess: (res: unknown, body: unknown) => void;
  sendError?: (res: unknown, status: number, message: string) => void;
}

export type FileWithContent = {
  file: TFile;
  content: string;
};
