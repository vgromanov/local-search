import type {
  DegradedLeg,
  LocalSmartLookupSettings,
  SearchOptions,
  SearchResponse,
  SearchResult
} from "./types";

type ScoreAccessor = (result: SearchResult) => number | undefined;

export type PipelineSettings = Pick<
  LocalSmartLookupSettings,
  | "useLexical"
  | "useRerank"
  | "rerankModel"
  | "rerankPoolSize"
  | "rerankMaxChars"
  | "rrfK"
  | "rrfWeightRerank"
  | "rrfWeightVector"
  | "rrfWeightLexical"
  | "queryInstruction"
  | "collapseByNote"
>;

/** Retrieval backends the pipeline fuses; any of them may throw when its server is down. */
export interface SearchLegs {
  embed(text: string): Promise<number[]>;
  vectorSearch(vector: number[], options: SearchOptions): Promise<SearchResult[]>;
  lexicalSearch(query: string, options: SearchOptions): Promise<SearchResult[]>;
  rerank(query: string, candidates: SearchResult[], options?: RerankOptions): Promise<SearchResult[]>;
}

export interface RerankOptions {
  /** Truncate each document sent to the reranker; returned results keep their full text. */
  maxChars?: number;
}

export interface PipelineRequest {
  query: string;
  limit: number;
  /** Options passed to each retrieval leg (filters + per-leg overfetch limit). */
  legOptions: SearchOptions;
  collapse?: boolean;
  queryInstruction?: string;
  rerankPoolSize?: number;
  rerankMaxChars?: number;
}

/** Document text for the cross-encoder; a positive `maxChars` truncates it. */
export function rerankDocument(text: string, maxChars?: number): string {
  return maxChars && maxChars > 0 && text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Request overrides may only make reranking cheaper than the settings allow:
 * a smaller pool (never below `limit`) and a tighter document cap.
 */
export function effectiveRerankBudget(
  request: Pick<PipelineRequest, "limit" | "rerankPoolSize" | "rerankMaxChars">,
  settings: Pick<PipelineSettings, "rerankPoolSize" | "rerankMaxChars">
): { poolSize: number; maxChars: number } {
  const positive = (n: number | undefined) => typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  const requestedPool = positive(request.rerankPoolSize);
  const pool = requestedPool === undefined ? settings.rerankPoolSize : Math.min(settings.rerankPoolSize, requestedPool);
  const caps = [positive(settings.rerankMaxChars), positive(request.rerankMaxChars)]
    .filter((n): n is number => n !== undefined);
  return {
    poolSize: Math.max(request.limit, pool),
    maxChars: caps.length ? Math.min(...caps) : 0
  };
}

/**
 * Qwen3-Embedding is instruction-aware on the query side only; documents are
 * embedded raw, so changing the instruction never requires a reindex.
 */
export function applyQueryInstruction(instruction: string | undefined, query: string): string {
  return instruction ? `${instruction}${query}` : query;
}

/**
 * Hybrid vector + BM25 + cross-encoder search fused with weighted RRF.
 * Each leg degrades independently: reranker down → vector+lexical RRF,
 * embedder/vector store down → lexical-only. Throws only when no retrieval
 * leg produced candidates.
 */
export async function runHybridSearch(
  request: PipelineRequest,
  settings: PipelineSettings,
  legs: SearchLegs,
  onDegrade?: (leg: DegradedLeg, error: unknown) => void
): Promise<SearchResponse> {
  const { query, limit, legOptions } = request;
  const degraded: DegradedLeg[] = [];
  const failures: unknown[] = [];
  const markDegraded = (leg: DegradedLeg, error: unknown) => {
    degraded.push(leg);
    failures.push(error);
    onDegrade?.(leg, error);
  };

  const instruction = request.queryInstruction ?? settings.queryInstruction;
  const vectorPromise = (async () => {
    const vector = await legs.embed(applyQueryInstruction(instruction, query));
    return legs.vectorSearch(vector, legOptions);
  })().catch((error: unknown) => {
    markDegraded("vector", error);
    return null;
  });
  const lexicalPromise = settings.useLexical
    ? legs.lexicalSearch(query, legOptions).catch((error: unknown) => {
      markDegraded("lexical", error);
      return null;
    })
    : Promise.resolve<SearchResult[]>([]);

  const [vectorHits, lexicalHits] = await Promise.all([vectorPromise, lexicalPromise]);
  if (vectorHits === null && (lexicalHits === null || !settings.useLexical)) {
    throw noLegsError(failures);
  }

  // Merge the two retrieval legs into a single candidate set keyed by chunk id,
  // carrying each leg's native score (cosine distance vs. BM25 _score).
  const byId = new Map<string, SearchResult>();
  for (const hit of vectorHits ?? []) {
    byId.set(hit.id, { ...hit });
  }
  for (const hit of lexicalHits ?? []) {
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

  const { poolSize, maxChars } = effectiveRerankBudget(request, settings);
  if (candidates.length > poolSize) {
    const preRank = (r: SearchResult) => rrf([
      [lexicalRanks.get(r.id), settings.rrfWeightLexical],
      [vectorRanks.get(r.id), settings.rrfWeightVector]
    ], settings.rrfK);
    candidates = [...candidates].sort((a, b) => preRank(b) - preRank(a)).slice(0, poolSize);
  }

  // Cross-encoder pass: attaches rerankScore (may saturate to 1.0 for several
  // clearly-relevant docs — that's precisely why we fuse on rank, not score).
  let reranked = candidates;
  if (settings.useRerank && settings.rerankModel && candidates.length > 0) {
    try {
      reranked = await legs.rerank(query, candidates, maxChars > 0 ? { maxChars } : undefined);
    } catch (error) {
      markDegraded("rerank", error);
    }
  }
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
  const collapse = request.collapse ?? settings.collapseByNote;
  const ranked = collapse ? collapseByNote(reranked) : reranked;
  return { results: ranked.slice(0, limit), degraded };
}

/**
 * Keep the best-ranked chunk per note (input must already be sorted best-first);
 * `matchedChunks` records how many candidate chunks that note contributed.
 */
export function collapseByNote(sorted: SearchResult[]): SearchResult[] {
  const byPath = new Map<string, SearchResult>();
  for (const result of sorted) {
    const best = byPath.get(result.path);
    if (best) {
      best.matchedChunks = (best.matchedChunks ?? 1) + 1;
    } else {
      byPath.set(result.path, { ...result, matchedChunks: 1 });
    }
  }
  return Array.from(byPath.values());
}

function noLegsError(failures: unknown[]): Error {
  const messages = failures.map((error) => error instanceof Error ? error.message : String(error));
  return new Error(`Search unavailable: all retrieval legs failed (${messages.join("; ")})`);
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
