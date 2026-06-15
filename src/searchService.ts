import { TFile } from "obsidian";
import type { App } from "obsidian";
import { DataviewFilter } from "./dataview";
import { LocalModelClient } from "./modelClient";
import type { LocalSmartLookupSettings, SearchOptions, SearchResult } from "./types";
import { LanceVectorStore } from "./vectorStore";

type ScoreAccessor = (result: SearchResult) => number | undefined;

export class SearchService {
  constructor(
    private app: App,
    private store: LanceVectorStore,
    private modelClient: LocalModelClient,
    private dataviewFilter: DataviewFilter,
    private getSettings: () => LocalSmartLookupSettings
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

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

    const [queryVector] = await this.modelClient.embed([trimmed]);
    const vectorPromise = this.store.search(queryVector, legOptions);
    const lexicalPromise = settings.useLexical
      ? this.store.searchLexical(trimmed, legOptions)
      : Promise.resolve<SearchResult[]>([]);

    const [vectorHits, lexicalHits] = await Promise.all([vectorPromise, lexicalPromise]);

    // Merge the two retrieval legs into a single candidate set keyed by chunk id,
    // carrying each leg's native score (cosine distance vs. BM25 _score).
    const byId = new Map<string, SearchResult>();
    for (const hit of vectorHits) {
      byId.set(hit.id, { ...hit });
    }
    for (const hit of lexicalHits) {
      const existing = byId.get(hit.id);
      if (existing) {
        existing.ftsScore = hit.ftsScore;
      } else {
        byId.set(hit.id, { ...hit });
      }
    }

    // Pre-rank by vector + lexical so we can bound how many docs hit the
    // (relatively expensive) cross-encoder when both legs are wide.
    let candidates = Array.from(byId.values());
    const vectorRanks = assignRanks(candidates, (r) => r.score, (r) => r.distance !== undefined);
    const lexicalRanks = assignRanks(candidates, (r) => r.ftsScore, (r) => r.ftsScore !== undefined);

    const poolSize = Math.max(limit, settings.rerankPoolSize);
    if (candidates.length > poolSize) {
      candidates = [...candidates]
        .sort((a, b) =>
          rrf([
            [lexicalRanks.get(b.id), settings.rrfWeightLexical],
            [vectorRanks.get(b.id), settings.rrfWeightVector]
          ], settings.rrfK)
          - rrf([
            [lexicalRanks.get(a.id), settings.rrfWeightLexical],
            [vectorRanks.get(a.id), settings.rrfWeightVector]
          ], settings.rrfK)
        )
        .slice(0, poolSize);
    }

    // Cross-encoder pass: attaches rerankScore (may saturate to 1.0 for several
    // clearly-relevant docs — that's precisely why we fuse on rank, not score).
    const reranked = await this.modelClient.rerank(trimmed, candidates);
    const rerankRanks = assignRanks(reranked, (r) => r.rerankScore, (r) => r.rerankScore !== undefined);

    for (const result of reranked) {
      result.vectorRank = vectorRanks.get(result.id);
      result.lexicalRank = lexicalRanks.get(result.id);
      result.rerankRank = rerankRanks.get(result.id);
      result.fusedScore = rrf([
        [result.rerankRank, settings.rrfWeightRerank],
        [result.vectorRank, settings.rrfWeightVector],
        [result.lexicalRank, settings.rrfWeightLexical]
      ], settings.rrfK);
    }

    reranked.sort((a, b) => (b.fusedScore ?? 0) - (a.fusedScore ?? 0));
    return reranked.slice(0, limit);
  }

  async openResult(result: SearchResult): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}

/**
 * Competition ranking (1-based) over the subset of items that carry a signal.
 * Ties share a rank so a saturated signal can't dominate the fusion; items
 * without the signal are omitted and contribute nothing to RRF for that leg.
 */
function assignRanks(
  items: SearchResult[],
  getScore: ScoreAccessor,
  hasSignal: (item: SearchResult) => boolean
): Map<string, number> {
  const scored = items
    .filter((item) => hasSignal(item) && typeof getScore(item) === "number")
    .sort((a, b) => (getScore(b) as number) - (getScore(a) as number));

  const ranks = new Map<string, number>();
  let previousScore: number | null = null;
  let previousRank = 0;
  scored.forEach((item, index) => {
    const score = getScore(item) as number;
    const rank = previousScore !== null && score === previousScore ? previousRank : index + 1;
    previousScore = score;
    previousRank = rank;
    ranks.set(item.id, rank);
  });
  return ranks;
}

/** Weighted Reciprocal Rank Fusion: sum of w / (k + rank) over present legs. */
function rrf(legs: Array<[number | undefined, number]>, k: number): number {
  let score = 0;
  for (const [rank, weight] of legs) {
    if (typeof rank === "number") {
      score += weight / (k + rank);
    }
  }
  return score;
}
