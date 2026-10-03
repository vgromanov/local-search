import { requestUrl } from "obsidian";
import { postModelJson, resolveModelAuth, type ModelHttpRequest } from "./modelAuth";
import { rerankDocument, type RerankOptions } from "./searchPipeline";
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

/** L2-normalize; returns null for zero vectors (avoid divide-by-zero). */
export function l2Normalize(vector: number[]): number[] | null {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  if (sumSquares === 0) return null;
  const inv = 1 / Math.sqrt(sumSquares);
  return vector.map((value) => value * inv);
}

const obsidianModelRequest: ModelHttpRequest = async (init) => {
  const response = await requestUrl({
    url: init.url,
    method: init.method,
    contentType: init.contentType,
    headers: init.headers,
    body: init.body,
    throw: false
  });
  return { status: response.status, text: response.text };
};

export class LocalModelClient {
  constructor(
    private getSettings: () => LocalSmartLookupSettings,
    private request: ModelHttpRequest = obsidianModelRequest
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const settings = this.getSettings();
    const auth = resolveModelAuth(settings, "embedding");
    const json = await postModelJson(this.request, {
      url: joinUrl(settings.embeddingBaseUrl, settings.embeddingPath),
      endpoint: "embedding",
      apiKey: auth.apiKey,
      headerName: auth.headerName,
      body: {
        model: settings.embeddingModel,
        input: texts
      }
    }) as EmbeddingResponse;

    if (!json || typeof json !== "object") {
      throw new Error("Embedding response did not include vectors.");
    }
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

  async rerank(query: string, results: SearchResult[], options: RerankOptions = {}): Promise<SearchResult[]> {
    const settings = this.getSettings();
    if (!settings.useRerank || !settings.rerankModel || results.length === 0) {
      return results;
    }

    const auth = resolveModelAuth(settings, "rerank");
    const json = await postModelJson(this.request, {
      url: joinUrl(settings.rerankBaseUrl, settings.rerankPath),
      endpoint: "rerank",
      apiKey: auth.apiKey,
      headerName: auth.headerName,
      body: {
        model: settings.rerankModel,
        query,
        documents: results.map((result) => rerankDocument(result.text, options.maxChars))
      }
    }) as { results?: RerankItem[] } | RerankItem[] | null;

    if (!json || typeof json !== "object") {
      throw new Error("Rerank response did not include results.");
    }
    const items = Array.isArray(json) ? json : json.results;
    if (!Array.isArray(items)) throw new Error("Rerank response did not include results.");

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
