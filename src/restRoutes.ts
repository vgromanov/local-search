import type LocalSmartLookupPlugin from "./main";
import {
  FilterCompileError,
  compileFilter,
  normalizeKeysetPage
} from "./filterCompiler";
import { l2Normalize } from "./modelClient";
import { QUERYABLE_FIELDS, SCHEMA_VER } from "./schema";
import type { ObsidianRestPublicApi } from "./types";

const EMBED_BATCH_MAX = 64;
const EMBED_TEXT_MAX_CHARS = 32_000;
const QUERY_METADATA_MAX_LIMIT = 5000;
const QUERY_METADATA_DEFAULT_LIMIT = 500;

type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>;

type Route = {
  get?: (handler: RouteHandler) => unknown;
  post?: (handler: RouteHandler) => unknown;
};

type RestApi = ObsidianRestPublicApi & {
  addRoute: (path: string) => Route;
  unregister?: () => void;
};

type ExpressLikeResponse = {
  status?: (status: number) => ExpressLikeResponse;
  json?: (body: unknown) => void;
  send?: (body: unknown) => void;
};

function readJsonBody(req: unknown): Record<string, unknown> {
  const request = req as {
    body?: unknown;
    json?: unknown;
  };
  if (request.body && typeof request.body === "object") return request.body as Record<string, unknown>;
  if (request.json && typeof request.json === "object") return request.json as Record<string, unknown>;
  return {};
}

function sendJson(api: RestApi, res: unknown, body: unknown, status = 200): void {
  if (api.sendSuccess && status === 200) {
    api.sendSuccess(res, body);
    return;
  }

  const response = res as ExpressLikeResponse;
  if (response.status) response.status(status);
  if (response.json) {
    response.json(body);
    return;
  }
  if (response.send) {
    response.send(body);
  }
}

function sendError(api: RestApi, res: unknown, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (api.sendError) {
    api.sendError(res, status, message);
    return;
  }
  sendJson(api, res, { ok: false, error: message, status }, status);
}

function getRestApi(plugin: LocalSmartLookupPlugin): RestApi | null {
  const plugins = (plugin.app as unknown as {
    plugins?: {
      plugins?: Record<string, { getPublicApi?: (manifest: unknown) => RestApi | null }>;
    };
  }).plugins?.plugins;

  return plugins?.["obsidian-local-rest-api"]?.getPublicApi?.(plugin.manifest)
    ?? plugins?.["obsidian-api"]?.getPublicApi?.(plugin.manifest)
    ?? null;
}

async function handleEmbedText(plugin: LocalSmartLookupPlugin, api: RestApi, req: unknown, res: unknown): Promise<void> {
  const body = readJsonBody(req);
  if (!Array.isArray(body.texts)) {
    sendError(api, res, 400, "Request requires `texts` array");
    return;
  }
  if (body.texts.length === 0) {
    sendError(api, res, 400, "`texts` must be a non-empty array");
    return;
  }
  if (body.texts.length > EMBED_BATCH_MAX) {
    sendError(api, res, 400, `Batch size exceeds max ${EMBED_BATCH_MAX}`);
    return;
  }

  const normalize = body.normalize !== false;
  const vectors: Array<number[] | null> = new Array(body.texts.length).fill(null);
  const errors: Array<{ index: number; message: string }> = [];
  const validIndices: number[] = [];
  const validTexts: string[] = [];

  body.texts.forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push({ index, message: "Text must be a string" });
      return;
    }
    if (!item.trim()) {
      errors.push({ index, message: "Text is empty" });
      return;
    }
    if (item.length > EMBED_TEXT_MAX_CHARS) {
      errors.push({ index, message: `Text exceeds max length ${EMBED_TEXT_MAX_CHARS}` });
      return;
    }
    validIndices.push(index);
    validTexts.push(item);
  });

  let embedModel = plugin.settings.embeddingModel;
  let embedDim = 0;

  if (validTexts.length > 0) {
    const rawVectors = await plugin.modelClient.embed(validTexts);
    if (rawVectors.length < validTexts.length) {
      for (let i = rawVectors.length; i < validTexts.length; i++) {
        errors.push({ index: validIndices[i], message: "Embedding provider returned fewer vectors than inputs" });
      }
    }
    rawVectors.forEach((vector, offset) => {
      const index = validIndices[offset];
      if (!Array.isArray(vector) || vector.length === 0) {
        errors.push({ index, message: "Empty embedding vector" });
        return;
      }
      embedDim = embedDim || vector.length;
      if (normalize) {
        const normalized = l2Normalize(vector);
        if (!normalized) {
          errors.push({ index, message: "Zero vector cannot be L2-normalized" });
          return;
        }
        vectors[index] = normalized;
      } else {
        vectors[index] = vector;
      }
    });
  }

  if (!embedDim) {
    const sample = await plugin.vectorStore.sampleIndexedEmbedding();
    embedDim = sample?.embeddingDim ?? 0;
    if (sample?.embeddingModel) embedModel = sample.embeddingModel;
  }

  sendJson(api, res, {
    embed_model: embedModel,
    embed_dim: embedDim,
    vectors,
    errors
  });
}

function registerSiRoutes(plugin: LocalSmartLookupPlugin, api: RestApi): void {
  // Permanent liveness probe for mining clients (trailing slash required).
  api.addRoute("/si/health/")
    .get?.(async (_req, res) => {
      try {
        const chunkCount = await plugin.vectorStore.count();
        const meta = await plugin.vectorStore.readIndexMeta();
        sendJson(api, res, {
          ok: true,
          version: plugin.manifest.version,
          schema_ver: meta?.schema_ver || SCHEMA_VER,
          chunks: chunkCount,
          indexReady: chunkCount > 0
        });
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  api.addRoute("/si/index_info/")
    .get?.(async (_req, res) => {
      try {
        const settings = plugin.settings;
        const meta = await plugin.vectorStore.readIndexMeta();
        const regimes = await plugin.vectorStore.listIndexedEmbeddingRegimes();
        const chunkCount = await plugin.vectorStore.count();
        const docCount = (await plugin.vectorStore.paths()).size;

        const primary = regimes[0] ?? {
          embedding_model: meta?.embedding_model || "",
          embedding_dim: meta?.embedding_dim || 0
        };
        const mixed = regimes.length > 1;
        const settings_vs_index_mismatch = Boolean(
          primary.embedding_model
          && settings.embeddingModel
          && primary.embedding_model !== settings.embeddingModel
        );

        sendJson(api, res, {
          embed_model: primary.embedding_model || meta?.embedding_model || "",
          embed_dim: primary.embedding_dim || meta?.embedding_dim || 0,
          reranker: settings.rerankModel || "",
          schema_ver: meta?.schema_ver || SCHEMA_VER,
          metric: meta?.metric || "cosine",
          doc_count: docCount,
          chunk_count: chunkCount,
          built_at: meta?.built_at || "",
          // SI never applies the reranker; field is informational only.
          si_applies_rerank: false,
          mixed,
          regimes,
          settings_vs_index_mismatch
        });
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  api.addRoute("/si/embed_text/")
    .post?.(async (req, res) => {
      try {
        await handleEmbedText(plugin, api, req, res);
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  api.addRoute("/si/query_metadata/")
    .post?.(async (req, res) => {
      try {
        const body = readJsonBody(req);
        if (body.offset !== undefined && body.offset !== null) {
          sendError(api, res, 400, "Numeric `offset` is not supported; use keyset `cursor` (last row `id`)");
          return;
        }

        let page;
        try {
          page = normalizeKeysetPage({
            cursor: body.cursor,
            limit: body.limit,
            defaultLimit: QUERY_METADATA_DEFAULT_LIMIT,
            maxLimit: QUERY_METADATA_MAX_LIMIT
          });
        } catch (error) {
          if (error instanceof FilterCompileError) {
            sendError(api, res, 400, error);
            return;
          }
          throw error;
        }

        if (!Array.isArray(body.fields) || body.fields.length === 0) {
          sendError(api, res, 400, "Request requires non-empty `fields` array");
          return;
        }

        const fields: string[] = [];
        for (const field of body.fields) {
          if (typeof field !== "string" || !field.trim()) {
            sendError(api, res, 400, "Each field must be a non-empty string");
            return;
          }
          const column = QUERYABLE_FIELDS[field];
          if (!column) {
            sendError(api, res, 400, `Unknown field: ${field}`);
            return;
          }
          fields.push(column);
        }

        let whereSql: string | undefined;
        try {
          whereSql = compileFilter({ where: body.where, filter: body.filter });
        } catch (error) {
          if (error instanceof FilterCompileError) {
            sendError(api, res, 400, error);
            return;
          }
          throw error;
        }

        const result = await plugin.vectorStore.queryMetadataPage({
          whereSql,
          fields,
          limit: page.limit,
          cursor: page.cursor
        });
        sendJson(api, res, result);
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  /**
   * Compile + execute a filter against the live index.
   * Used for RVG-8 DoD and as a debug aid; later SI endpoints reuse compileFilter.
   *
   * Body: { where?: string, filter?: object, limit?: number }
   * Success: { sql, row_count, sample }
   * Bad filter: 400 via sendError
   */
  api.addRoute("/si/filter/validate/")
    .post?.(async (req, res) => {
      try {
        const body = readJsonBody(req);
        const sql = compileFilter({ where: body.where, filter: body.filter });
        const limit = typeof body.limit === "number" ? Math.min(20, Math.max(1, Math.floor(body.limit))) : 5;
        const rowCount = await plugin.vectorStore.countFiltered(sql);
        const sample = await plugin.vectorStore.sampleFiltered(sql, limit);
        sendJson(api, res, {
          sql: sql ?? null,
          row_count: rowCount,
          sample
        });
      } catch (error) {
        if (error instanceof FilterCompileError) {
          sendError(api, res, 400, error);
          return;
        }
        sendError(api, res, 500, error);
      }
    });
}

export function registerRestRoutes(plugin: LocalSmartLookupPlugin): (() => void) | null {
  const api = getRestApi(plugin);
  if (!api) return null;

  api.addRoute("/local-smart-lookup/status/")
    .get?.(async (_req, res) => {
      sendJson(api, res, {
        index: await plugin.indexer.status(),
        queue: plugin.indexQueue.status()
      });
    });

  api.addRoute("/local-smart-lookup/search/")
    .post?.(async (req, res) => {
      try {
        const body = readJsonBody(req);
        const query = typeof body.query === "string" ? body.query : "";
        const limit = typeof body.limit === "number" ? body.limit : undefined;
        const dataviewSource = typeof body.dataviewSource === "string" ? body.dataviewSource : undefined;
        const dataviewQuery = typeof body.dataviewQuery === "string" ? body.dataviewQuery : undefined;
        const where = typeof body.where === "string" ? body.where : undefined;
        const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
        const frontmatter = body.frontmatter && typeof body.frontmatter === "object" && !Array.isArray(body.frontmatter)
          ? body.frontmatter as Record<string, string | number | boolean>
          : undefined;
        const results = await plugin.searchService.search(query, {
          limit,
          dataviewSource,
          dataviewQuery,
          where,
          tags,
          frontmatter
        });
        sendJson(api, res, { results });
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  api.addRoute("/local-smart-lookup/reindex/")
    .post?.(async (_req, res) => {
      try {
        await plugin.indexQueue.enqueueVault();
        sendJson(api, res, {
          index: await plugin.indexer.status(),
          queue: plugin.indexQueue.status()
        });
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  registerSiRoutes(plugin, api);

  return () => api.unregister?.();
}
