import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  modelAuthHeaders,
  postModelJson,
  rejectedApiKeyMessage,
  resolveModelAuth,
  type ModelHttpRequest,
  type ModelHttpRequestInit
} from "./modelAuth.ts";

const SECRET = "sk-test-omlx-key-should-not-leak";

const authSettings = {
  embeddingApiKey: SECRET,
  embeddingApiKeyHeader: "",
  rerankApiKey: "",
  rerankApiKeyHeader: ""
};

function responder(status: number, text: string, seen: ModelHttpRequestInit[]): ModelHttpRequest {
  return async (init) => {
    seen.push(init);
    return { status, text };
  };
}

describe("model auth headers", () => {
  it("sends no header when the key is empty", () => {
    assert.deepEqual(modelAuthHeaders("embedding", "  ", ""), {});
    assert.deepEqual(modelAuthHeaders("embedding", "", "x-api-key"), {});
  });

  it("defaults to Authorization Bearer", () => {
    assert.deepEqual(modelAuthHeaders("embedding", SECRET, ""), {
      Authorization: `Bearer ${SECRET}`
    });
    assert.deepEqual(modelAuthHeaders("embedding", SECRET, " authorization "), {
      Authorization: `Bearer ${SECRET}`
    });
  });

  it("sends the raw key in a custom header", () => {
    assert.deepEqual(modelAuthHeaders("rerank", SECRET, "x-api-key"), {
      "x-api-key": SECRET
    });
  });

  it("rejects a header name or key that could break the request, without echoing the key", () => {
    assert.throws(
      () => modelAuthHeaders("embedding", SECRET, "Bad Header"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /embedding API key header name/);
        assert.equal(error.message.includes(SECRET), false);
        return true;
      }
    );
    assert.throws(
      () => modelAuthHeaders("rerank", `abc\n${SECRET}`, "x-api-key"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /rerank API key contains a control character/);
        assert.equal(error.message.includes(SECRET), false);
        return true;
      }
    );
  });
});

describe("resolveModelAuth", () => {
  it("uses the embedding key and header for rerank when those are empty", () => {
    assert.deepEqual(
      resolveModelAuth({ ...authSettings, embeddingApiKeyHeader: "x-api-key" }, "rerank"),
      { apiKey: SECRET, headerName: "x-api-key" }
    );
  });

  it("prefers a rerank key and header when set", () => {
    assert.deepEqual(
      resolveModelAuth({
        ...authSettings,
        rerankApiKey: "rerank-secret",
        rerankApiKeyHeader: "api-key"
      }, "rerank"),
      { apiKey: "rerank-secret", headerName: "api-key" }
    );
  });

  it("treats a whitespace-only rerank key as empty", () => {
    assert.equal(
      resolveModelAuth({ ...authSettings, rerankApiKey: "   " }, "rerank").apiKey,
      SECRET
    );
  });
});

describe("postModelJson", () => {
  it("omits the auth header and does not put the key in the body when the key is empty", async () => {
    const seen: ModelHttpRequestInit[] = [];
    const json = await postModelJson(responder(200, JSON.stringify({ data: [{ embedding: [1] }] }), seen), {
      url: "http://127.0.0.1:8000/v1/embeddings",
      endpoint: "embedding",
      apiKey: "",
      headerName: "x-api-key",
      body: { model: "m", input: ["note"] }
    });
    assert.deepEqual(json, { data: [{ embedding: [1] }] });
    assert.equal(seen[0].headers, undefined);
    assert.equal(seen[0].body.includes(SECRET), false);
    assert.equal(seen[0].throw, false);
  });

  it("sends Bearer auth and keeps the key out of the URL and body", async () => {
    const seen: ModelHttpRequestInit[] = [];
    await postModelJson(responder(200, "{\"ok\":true}", seen), {
      url: "https://api.example/v1/embeddings",
      endpoint: "embedding",
      apiKey: `  ${SECRET}  `,
      headerName: "",
      body: { model: "m", input: ["chunk"] }
    });
    assert.deepEqual(seen[0].headers, { Authorization: `Bearer ${SECRET}` });
    assert.equal(seen[0].url.includes(SECRET), false);
    assert.equal(seen[0].body.includes(SECRET), false);
  });

  it("turns 401 and 403 into a clear error and drops the response body", async () => {
    for (const status of [401, 403]) {
      await assert.rejects(
        postModelJson(responder(status, `invalid ${SECRET}`, []), {
          url: "http://127.0.0.1:8000/v1/rerank",
          endpoint: "rerank",
          apiKey: SECRET,
          headerName: "",
          body: { model: "r", query: "q", documents: ["d"] }
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, rejectedApiKeyMessage("rerank"));
          assert.equal(error.message.includes(SECRET), false);
          return true;
        }
      );
    }
  });

  it("redacts the key from other HTTP error bodies", async () => {
    await assert.rejects(
      postModelJson(responder(500, `upstream blew up with ${SECRET}`, []), {
        url: "http://127.0.0.1:8000/v1/embeddings",
        endpoint: "embedding",
        apiKey: SECRET,
        headerName: "",
        body: { model: "m", input: ["x"] }
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 500/);
        assert.match(error.message, /\[redacted\]/);
        assert.equal(error.message.includes(SECRET), false);
        return true;
      }
    );
  });

  it("does not echo a transport error that contains the key", async () => {
    const request = async () => {
      throw new Error(`socket hang up Authorization: Bearer ${SECRET}`);
    };
    await assert.rejects(
      postModelJson(request, {
        url: "http://127.0.0.1:8000/v1/embeddings",
        endpoint: "embedding",
        apiKey: SECRET,
        headerName: "",
        body: { model: "m", input: [] }
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "The embedding server request failed");
        assert.equal(error.message.includes(SECRET), false);
        return true;
      }
    );
  });

  it("keeps a harmless transport error", async () => {
    const request = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
    };
    await assert.rejects(
      postModelJson(request, {
        url: "http://127.0.0.1:8000/v1/embeddings",
        endpoint: "embedding",
        apiKey: "",
        headerName: "",
        body: {}
      }),
      /ECONNREFUSED/
    );
  });
});
