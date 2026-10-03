import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { settingsFromStoredData } from "./storedSettings.ts";
import type { LocalSmartLookupSettings } from "./types.ts";

const defaults = {
  embeddingBaseUrl: "http://127.0.0.1:11434",
  embeddingModel: "nomic-embed-text",
  embeddingPath: "/v1/embeddings",
  embeddingApiKey: "",
  embeddingApiKeyHeader: "",
  rerankBaseUrl: "http://127.0.0.1:11434",
  rerankModel: "",
  rerankPath: "/v1/rerank",
  rerankApiKey: "",
  rerankApiKeyHeader: "",
  useRerank: false,
  chunkSize: 1200,
  chunkOverlap: 180,
  defaultLimit: 10,
  defaultDataviewSource: "",
  useLexical: true,
  candidateMultiplier: 4,
  rerankPoolSize: 50,
  rrfK: 60,
  rrfWeightRerank: 1,
  rrfWeightVector: 0.6,
  rrfWeightLexical: 0.4,
  rerankMaxChars: 0,
  queryInstruction: "",
  collapseByNote: true
} satisfies LocalSmartLookupSettings;

describe("settingsFromStoredData", () => {
  it("copies a legacy apiKey into the embedding key and drops the old field", () => {
    const settings = settingsFromStoredData(defaults, {
      embeddingModel: "Qwen3-Embedding-4B-4bit-DWQ",
      apiKey: "  legacy-key  "
    });
    assert.equal(settings.embeddingApiKey, "legacy-key");
    assert.equal(settings.embeddingModel, "Qwen3-Embedding-4B-4bit-DWQ");
    assert.equal(Object.hasOwn(settings, "apiKey"), false);
    assert.equal(JSON.stringify(settings).includes("\"apiKey\""), false);
  });

  it("does not overwrite an embedding API key with the legacy field", () => {
    const settings = settingsFromStoredData(defaults, {
      embeddingApiKey: "current",
      apiKey: "legacy-key"
    });
    assert.equal(settings.embeddingApiKey, "current");
    assert.equal(Object.hasOwn(settings, "apiKey"), false);
  });

  it("fills missing key fields from defaults", () => {
    const settings = settingsFromStoredData(defaults, null);
    assert.equal(settings.embeddingApiKey, "");
    assert.equal(settings.rerankApiKey, "");
    assert.equal(settings.embeddingApiKeyHeader, "");
  });
});
