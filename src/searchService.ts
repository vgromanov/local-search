import { TFile } from "obsidian";
import type { App } from "obsidian";
import { DataviewFilter } from "./dataview";
import { LocalModelClient } from "./modelClient";
import type { LocalSmartLookupSettings, SearchOptions, SearchResult } from "./types";
import { cosineSimilarity, JsonVectorStore } from "./vectorStore";

export class SearchService {
  constructor(
    private app: App,
    private store: JsonVectorStore,
    private modelClient: LocalModelClient,
    private dataviewFilter: DataviewFilter,
    private getSettings: () => LocalSmartLookupSettings
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const settings = this.getSettings();
    const limit = Math.max(1, options.limit ?? settings.defaultLimit);
    const [queryVector] = await this.modelClient.embed([trimmed]);
    const dataviewPaths = options.allowedPaths
      ?? await this.dataviewFilter.resolvePaths(
        options.dataviewSource ?? settings.defaultDataviewSource,
        options.dataviewQuery
      );

    const candidates = this.store.all()
      .filter((record) => !dataviewPaths || dataviewPaths.has(record.path))
      .map((record) => ({
        ...record,
        score: cosineSimilarity(queryVector, record.vector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit * 4, limit));

    const reranked = await this.modelClient.rerank(trimmed, candidates);
    return reranked.slice(0, limit);
  }

  async openResult(result: SearchResult): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
