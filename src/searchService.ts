import { TFile } from "obsidian";
import type { App } from "obsidian";
import { DataviewFilter } from "./dataview";
import { LocalModelClient } from "./modelClient";
import { runHybridSearch } from "./searchPipeline";
import type { LocalSmartLookupSettings, SearchOptions, SearchResponse, SearchResult } from "./types";
import { LanceVectorStore } from "./vectorStore";

export class SearchService {
  constructor(
    private app: App,
    private store: LanceVectorStore,
    private modelClient: LocalModelClient,
    private dataviewFilter: DataviewFilter,
    private getSettings: () => LocalSmartLookupSettings
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const trimmed = query.trim();
    if (!trimmed) return { results: [], degraded: [] };

    const settings = this.getSettings();
    const limit = Math.max(1, options.limit ?? settings.defaultLimit);
    const candidateMultiplier = Math.max(1, settings.candidateMultiplier);
    const overfetch = Math.max(limit * candidateMultiplier, limit);

    const dataviewPaths = options.allowedPaths
      ?? await this.dataviewFilter.resolvePaths(
        options.dataviewSource ?? settings.defaultDataviewSource,
        options.dataviewQuery
      );

    const legOptions: SearchOptions = {
      ...options,
      allowedPaths: dataviewPaths ?? undefined,
      limit: overfetch
    };

    return runHybridSearch(
      {
        query: trimmed,
        limit,
        legOptions,
        collapse: options.collapse,
        queryInstruction: options.queryInstruction
      },
      settings,
      {
        embed: async (text) => {
          const [vector] = await this.modelClient.embed([text]);
          if (!Array.isArray(vector) || vector.length === 0) {
            throw new Error("Embedding response did not include a query vector.");
          }
          return vector;
        },
        vectorSearch: (vector, opts) => this.store.search(vector, opts),
        lexicalSearch: (text, opts) => this.store.searchLexical(text, opts),
        rerank: (text, candidates) => this.modelClient.rerank(text, candidates)
      },
      (leg, error) => console.warn(`Local Smart Lookup: ${leg} leg unavailable, degrading search.`, error)
    );
  }

  async openResult(result: SearchResult): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
