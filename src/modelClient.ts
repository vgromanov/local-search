import { requestUrl } from "obsidian";
import type { LocalSmartLookupSettings, SearchResult } from "./types";

type EmbeddingResponse = {
  data?: Array<{ embedding: number[] }>;
  embeddings?: number[][];
  embedding?: number[];
};

type RerankItem = {
  index?: number;
  document?: string;
  relevance_score?: number;
  score?: number;
};

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}

export class LocalModelClient {
  constructor(private getSettings: () => LocalSmartLookupSettings) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const settings = this.getSettings();
    const response = await requestUrl({
      url: joinUrl(settings.embeddingBaseUrl, settings.embeddingPath),
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        model: settings.embeddingModel,
        input: texts
      })
    });

    const json = response.json as EmbeddingResponse;
    if (Array.isArray(json.data)) {
      return json.data.map((item) => item.embedding);
    }
    if (Array.isArray(json.embeddings)) {
      return json.embeddings;
    }
    if (Array.isArray(json.embedding)) {
      return [json.embedding];
    }
    throw new Error("Embedding response did not include vectors.");
  }

  async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    const settings = this.getSettings();
    if (!settings.useRerank || !settings.rerankModel || results.length === 0) {
      return results;
    }

    const response = await requestUrl({
      url: joinUrl(settings.rerankBaseUrl, settings.rerankPath),
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        model: settings.rerankModel,
        query,
        documents: results.map((result) => result.text)
      })
    });

    const raw = response.json as { results?: RerankItem[] } | RerankItem[];
    const items = Array.isArray(raw) ? raw : raw.results;
    if (!Array.isArray(items)) return results;

    const byIndex = new Map<number, number>();
    items.forEach((item, fallbackIndex) => {
      const index = typeof item.index === "number" ? item.index : fallbackIndex;
      const score = typeof item.relevance_score === "number" ? item.relevance_score : item.score;
      if (typeof score === "number") byIndex.set(index, score);
    });

    return results
      .map((result, index) => ({ ...result, rerankScore: byIndex.get(index) }))
      .sort((a, b) => (b.rerankScore ?? b.score) - (a.rerankScore ?? a.score));
  }
}
