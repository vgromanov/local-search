import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyQueryInstruction,
  collapseByNote,
  effectiveRerankBudget,
  rerankDocument,
  runHybridSearch,
  type PipelineSettings,
  type SearchLegs
} from "./searchPipeline.ts";
import type { SearchResult } from "./types.ts";

const SETTINGS: PipelineSettings = {
  useLexical: true,
  useRerank: true,
  rerankModel: "qwen3-reranker",
  rerankPoolSize: 50,
  rerankMaxChars: 0,
  rrfK: 60,
  rrfWeightRerank: 1,
  rrfWeightVector: 0.6,
  rrfWeightLexical: 0.4,
  queryInstruction: "Instruct: task\nQuery: ",
  collapseByNote: false
};

function chunk(path: string, position: number, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    id: `${path}#${position}`,
    path,
    folder: "",
    basename: path,
    mtime: 0,
    size: 0,
    position,
    text: `${path} chunk ${position}`,
    score: 0,
    ...extra
  };
}

const vectorHit = (path: string, position: number, score: number) =>
  chunk(path, position, { score, distance: 1 - score });
const lexicalHit = (path: string, position: number, ftsScore: number) =>
  chunk(path, position, { ftsScore });

type LegOverrides = Partial<SearchLegs> & { embedded?: string[] };

function legs(overrides: LegOverrides = {}): SearchLegs & { embedded: string[] } {
  const embedded: string[] = overrides.embedded ?? [];
  return {
    embedded,
    embed: overrides.embed ?? (async (text) => {
      embedded.push(text);
      return [1, 0];
    }),
    vectorSearch: overrides.vectorSearch ?? (async () => [
      vectorHit("a.md", 0, 0.9),
      vectorHit("b.md", 0, 0.8),
      vectorHit("a.md", 1, 0.7)
    ]),
    lexicalSearch: overrides.lexicalSearch ?? (async () => [
      lexicalHit("c.md", 0, 12),
      lexicalHit("b.md", 0, 10)
    ]),
    rerank: overrides.rerank ?? (async (_query, candidates) =>
      candidates.map((c) => ({ ...c, rerankScore: c.path === "c.md" ? 1 : 0.5 })))
  };
}

const request = (extra: Record<string, unknown> = {}) => ({
  query: "what did we decide",
  limit: 10,
  legOptions: {},
  ...extra
});

const paths = (results: SearchResult[]) => results.map((r) => `${r.path}#${r.position}`);
const down = async (): Promise<never> => {
  throw new Error("ECONNREFUSED");
};

describe("applyQueryInstruction", () => {
  it("prefixes the query when an instruction is set", () => {
    assert.equal(applyQueryInstruction("Instruct: t\nQuery: ", "q"), "Instruct: t\nQuery: q");
  });

  it("passes the query through when the instruction is empty or missing", () => {
    assert.equal(applyQueryInstruction("", "q"), "q");
    assert.equal(applyQueryInstruction(undefined, "q"), "q");
  });
});

describe("runHybridSearch query instruction", () => {
  it("applies the instruction to the embedded query only", async () => {
    let lexicalQuery = "";
    let rerankQuery = "";
    const l = legs({
      lexicalSearch: async (q) => {
        lexicalQuery = q;
        return [];
      },
      rerank: async (q, c) => {
        rerankQuery = q;
        return c;
      }
    });
    await runHybridSearch(request(), SETTINGS, l);
    assert.deepEqual(l.embedded, ["Instruct: task\nQuery: what did we decide"]);
    assert.equal(lexicalQuery, "what did we decide");
    assert.equal(rerankQuery, "what did we decide");
  });

  it("lets a request override or disable the instruction", async () => {
    const l = legs();
    await runHybridSearch(request({ queryInstruction: "" }), SETTINGS, l);
    await runHybridSearch(request({ queryInstruction: "X: " }), SETTINGS, l);
    assert.deepEqual(l.embedded, ["what did we decide", "X: what did we decide"]);
  });
});

describe("runHybridSearch degradation", () => {
  it("reports no degradation when all legs succeed", async () => {
    const { results, degraded } = await runHybridSearch(request(), SETTINGS, legs());
    assert.deepEqual(degraded, []);
    assert.ok(results.every((r) => r.rerankRank !== undefined));
    assert.equal(results.find((r) => r.path === "c.md")?.rerankRank, 1);
  });

  it("falls back to vector + lexical RRF when the reranker is down", async () => {
    const { results, degraded } = await runHybridSearch(request(), SETTINGS, legs({ rerank: down }));
    assert.deepEqual(degraded, ["rerank"]);
    assert.ok(results.every((r) => r.rerankRank === undefined && r.rerankScore === undefined));
    // b.md is on both legs, so it wins the two-leg fusion.
    assert.equal(paths(results)[0], "b.md#0");
    assert.equal(results.length, 4);
  });

  it("falls back to lexical-only when the embedder is down", async () => {
    const reported: string[] = [];
    const { results, degraded } = await runHybridSearch(
      request(),
      { ...SETTINGS, useRerank: false },
      legs({ embed: down }),
      (leg) => reported.push(leg)
    );
    assert.deepEqual(degraded, ["vector"]);
    assert.deepEqual(reported, ["vector"]);
    assert.deepEqual(paths(results), ["c.md#0", "b.md#0"]);
  });

  it("treats a vector store failure like an embedder failure", async () => {
    const { degraded, results } = await runHybridSearch(
      request(),
      SETTINGS,
      legs({ vectorSearch: down })
    );
    assert.deepEqual(degraded, ["vector"]);
    assert.equal(results.length, 2);
  });

  it("reports both legs when embedder and reranker are down", async () => {
    const { degraded, results } = await runHybridSearch(
      request(),
      SETTINGS,
      legs({ embed: down, rerank: down })
    );
    assert.deepEqual(degraded.sort(), ["rerank", "vector"]);
    assert.deepEqual(paths(results), ["c.md#0", "b.md#0"]);
  });

  it("keeps vector results when the lexical leg throws", async () => {
    const { degraded, results } = await runHybridSearch(
      request(),
      SETTINGS,
      legs({ lexicalSearch: down })
    );
    assert.deepEqual(degraded, ["lexical"]);
    assert.equal(results.length, 3);
  });

  it("throws when no retrieval leg is available", async () => {
    await assert.rejects(
      runHybridSearch(request(), SETTINGS, legs({ embed: down, lexicalSearch: down })),
      /all retrieval legs failed.*ECONNREFUSED/
    );
    await assert.rejects(
      runHybridSearch(request(), { ...SETTINGS, useLexical: false }, legs({ embed: down })),
      /all retrieval legs failed/
    );
  });

  it("does not call or flag the reranker when it is disabled", async () => {
    let called = false;
    const { degraded } = await runHybridSearch(
      request(),
      { ...SETTINGS, useRerank: false },
      legs({
        rerank: async (_q, c) => {
          called = true;
          return c;
        }
      })
    );
    assert.equal(called, false);
    assert.deepEqual(degraded, []);
  });
});

describe("collapse by note", () => {
  it("keeps the best chunk per note and counts merged chunks", () => {
    const collapsed = collapseByNote([
      chunk("a.md", 2),
      chunk("b.md", 0),
      chunk("a.md", 0),
      chunk("a.md", 5)
    ]);
    assert.deepEqual(paths(collapsed), ["a.md#2", "b.md#0"]);
    assert.deepEqual(collapsed.map((r) => r.matchedChunks), [3, 1]);
  });

  it("collapses by default via settings and fills the limit with distinct notes", async () => {
    const { results } = await runHybridSearch(
      request({ limit: 2 }),
      { ...SETTINGS, collapseByNote: true, useRerank: false },
      legs({
        vectorSearch: async () => [
          vectorHit("a.md", 0, 0.9),
          vectorHit("a.md", 1, 0.85),
          vectorHit("a.md", 2, 0.8),
          vectorHit("b.md", 0, 0.7)
        ],
        lexicalSearch: async () => []
      })
    );
    assert.deepEqual(paths(results), ["a.md#0", "b.md#0"]);
    assert.equal(results[0].matchedChunks, 3);
  });

  it("returns raw chunks when a request sets collapse: false", async () => {
    const { results } = await runHybridSearch(
      request({ collapse: false }),
      { ...SETTINGS, collapseByNote: true },
      legs()
    );
    assert.equal(results.filter((r) => r.path === "a.md").length, 2);
    assert.ok(results.every((r) => r.matchedChunks === undefined));
  });
});

describe("rerank budget", () => {
  it("request can lower but never raise the pool, and never below limit", () => {
    const settings = { rerankPoolSize: 50, rerankMaxChars: 0 };
    assert.equal(effectiveRerankBudget({ limit: 10 }, settings).poolSize, 50);
    assert.equal(effectiveRerankBudget({ limit: 10, rerankPoolSize: 20 }, settings).poolSize, 20);
    assert.equal(effectiveRerankBudget({ limit: 10, rerankPoolSize: 200 }, settings).poolSize, 50);
    assert.equal(effectiveRerankBudget({ limit: 10, rerankPoolSize: 3 }, settings).poolSize, 10);
    assert.equal(effectiveRerankBudget({ limit: 10, rerankPoolSize: 0 }, settings).poolSize, 50);
  });

  it("uses the tighter of the setting and request document caps", () => {
    assert.equal(effectiveRerankBudget({ limit: 5 }, { rerankPoolSize: 50, rerankMaxChars: 0 }).maxChars, 0);
    assert.equal(effectiveRerankBudget({ limit: 5, rerankMaxChars: 600 }, { rerankPoolSize: 50, rerankMaxChars: 0 }).maxChars, 600);
    assert.equal(effectiveRerankBudget({ limit: 5, rerankMaxChars: 900 }, { rerankPoolSize: 50, rerankMaxChars: 400 }).maxChars, 400);
    assert.equal(effectiveRerankBudget({ limit: 5 }, { rerankPoolSize: 50, rerankMaxChars: 400 }).maxChars, 400);
  });

  it("truncates only positive caps", () => {
    assert.equal(rerankDocument("abcdef", 3), "abc");
    assert.equal(rerankDocument("abcdef", 0), "abcdef");
    assert.equal(rerankDocument("abc", 10), "abc");
  });

  it("sends at most the request pool to the reranker with the document cap", async () => {
    let seen = 0;
    let options: { maxChars?: number } | undefined;
    const many = Array.from({ length: 30 }, (_, i) => vectorHit(`n${i}.md`, 0, 1 - i / 100));
    const { results } = await runHybridSearch(
      { ...request(), limit: 5, rerankPoolSize: 8, rerankMaxChars: 100 },
      SETTINGS,
      legs({
        vectorSearch: async () => many,
        lexicalSearch: async () => [],
        rerank: async (_q, c, o) => {
          seen = c.length;
          options = o;
          return c.map((r) => ({ ...r, rerankScore: 0.5 }));
        }
      })
    );
    assert.equal(seen, 8);
    assert.deepEqual(options, { maxChars: 100 });
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.text.startsWith("n")));
  });

  it("passes no rerank options by default", async () => {
    let options: unknown = "unset";
    await runHybridSearch(request(), SETTINGS, legs({
      rerank: async (_q, c, o) => {
        options = o;
        return c;
      }
    }));
    assert.equal(options, undefined);
  });
});
