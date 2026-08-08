import type LocalSmartLookupPlugin from "./main";
import {
  FilterCompileError,
  compileFilter,
  normalizeKeysetPage
} from "./filterCompiler";
import {
  listFrontmatterKeyFilesFromVault,
  listFrontmatterKeysFromVault
} from "./frontmatterKeys";
import { l2Normalize } from "./modelClient";
import { QUERYABLE_FIELDS, SCHEMA_VER } from "./schema";
import type { ObsidianRestPublicApi } from "./types";

const EMBED_BATCH_MAX = 64;
const EMBED_TEXT_MAX_CHARS = 32_000;
const QUERY_METADATA_MAX_LIMIT = 5000;
const QUERY_METADATA_DEFAULT_LIMIT = 500;
const KNN_MAX_K = 1000;
const KNN_DEFAULT_K = 50;
const COUNT_GROUP_BY = new Set(["uuid", "project", "workspace", "date_bucket", "path"]);
const GET_VECTORS_DEFAULT_LIMIT = 512;
const GET_VECTORS_MAX_LIMIT = 1000;

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

type ResolvedQueryVector =
  | { ok: true; vector: number[] }
  | { ok: false; status: number; message: string };

async function resolveSiQueryVector(
  plugin: LocalSmartLookupPlugin,
  body: Record<string, unknown>
): Promise<ResolvedQueryVector> {
  const hasVector = Array.isArray(body.vector);
  const hasChunkId = typeof body.chunk_id === "string" && body.chunk_id.trim().length > 0;

  if (hasVector && hasChunkId) {
    return { ok: false, status: 400, message: "Provide exactly one of `vector` or `chunk_id`" };
  }
  if (!hasVector && !hasChunkId) {
    return { ok: false, status: 400, message: "Request requires `vector` or `chunk_id`" };
  }

  const meta = await plugin.vectorStore.readIndexMeta();
  const sample = await plugin.vectorStore.sampleIndexedEmbedding();
  const indexDim = meta?.embedding_dim || sample?.embeddingDim || 0;

  let queryVector: number[];
  if (hasChunkId) {
    const resolved = await plugin.vectorStore.getVectorByChunkId(String(body.chunk_id).trim());
    if (!resolved) {
      return { ok: false, status: 404, message: `Unknown chunk_id: ${String(body.chunk_id).trim()}` };
    }
    queryVector = resolved.vector;
  } else {
    const raw = body.vector as unknown[];
    if (raw.length === 0 || raw.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
      return { ok: false, status: 400, message: "`vector` must be a non-empty array of finite numbers" };
    }
    queryVector = raw as number[];
  }

  if (indexDim > 0 && queryVector.length !== indexDim) {
    return {
      ok: false,
      status: 400,
      message: `Vector dim ${queryVector.length} does not match index dim ${indexDim}`
    };
  }

  return { ok: true, vector: queryVector };
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

  api.addRoute("/si/knn/")
    .post?.(async (req, res) => {
      try {
        const body = readJsonBody(req);

        if (body.metric !== undefined && body.metric !== null && body.metric !== "cosine") {
          sendError(api, res, 400, "Only metric `cosine` is supported");
          return;
        }

        let k = KNN_DEFAULT_K;
        if (body.k !== undefined && body.k !== null) {
          if (typeof body.k !== "number" || !Number.isFinite(body.k) || body.k < 1) {
            sendError(api, res, 400, "`k` must be a positive number");
            return;
          }
          k = Math.min(KNN_MAX_K, Math.floor(body.k));
        }

        let threshold: number | undefined;
        if (body.threshold !== undefined && body.threshold !== null) {
          if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold) || body.threshold < 0) {
            sendError(api, res, 400, "`threshold` must be a non-negative number (cosine distance)");
            return;
          }
          threshold = body.threshold;
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

        const resolved = await resolveSiQueryVector(plugin, body);
        if (!resolved.ok) {
          sendError(api, res, resolved.status, resolved.message);
          return;
        }

        const hits = await plugin.vectorStore.siKnn({
          vector: resolved.vector,
          k,
          threshold,
          whereSql,
          bypassVectorIndex: true
        });
        sendJson(api, res, {
          hits,
          k,
          metric: "cosine",
          threshold: threshold ?? null,
          bypass_vector_index: true
        });
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  api.addRoute("/si/count_neighbors/")
    .post?.(async (req, res) => {
      try {
        const body = readJsonBody(req);

        if (body.metric !== undefined && body.metric !== null && body.metric !== "cosine") {
          sendError(api, res, 400, "Only metric `cosine` is supported");
          return;
        }

        if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold) || body.threshold < 0) {
          sendError(api, res, 400, "`threshold` must be a non-negative number (cosine distance, inclusive `<=`)");
          return;
        }
        const threshold = body.threshold;

        if (typeof body.group_by !== "string" || !COUNT_GROUP_BY.has(body.group_by)) {
          sendError(
            api,
            res,
            400,
            "`group_by` must be one of: uuid, project, workspace, date_bucket, path"
          );
          return;
        }
        const groupBy = body.group_by;

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

        const resolved = await resolveSiQueryVector(plugin, body);
        if (!resolved.ok) {
          sendError(api, res, resolved.status, resolved.message);
          return;
        }

        const rows = await plugin.vectorStore.siScanDistances({
          vector: resolved.vector,
          whereSql,
          groupBy,
          threshold
        });

        const counts: Record<string, number> = {};
        for (const row of rows) {
          const key = row.group;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        const totalHits = rows.length;
        const distinctGroups = Object.keys(counts).length;

        sendJson(api, res, {
          total_hits: totalHits,
          distinct_groups: distinctGroups,
          counts,
          threshold,
          metric: "cosine",
          group_by: groupBy
        });
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  api.addRoute("/si/get_vectors/")
    .post?.(async (req, res) => {
      try {
        const body = readJsonBody(req);
        if (body.offset !== undefined && body.offset !== null) {
          sendError(api, res, 400, "Numeric `offset` is not supported; use keyset `cursor` (last item `chunk_id`)");
          return;
        }

        let page;
        try {
          page = normalizeKeysetPage({
            cursor: body.cursor,
            limit: body.limit,
            defaultLimit: GET_VECTORS_DEFAULT_LIMIT,
            maxLimit: GET_VECTORS_MAX_LIMIT
          });
        } catch (error) {
          if (error instanceof FilterCompileError) {
            sendError(api, res, 400, error);
            return;
          }
          throw error;
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

        const includeText = body.include_text === true;
        const result = await plugin.vectorStore.getVectorsPage({
          whereSql,
          limit: page.limit,
          cursor: page.cursor,
          includeText
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

function readRouteParam(req: unknown, name: string): string {
  const request = req as {
    params?: Record<string, unknown>;
    param?: (key: string) => unknown;
  };
  const fromParams = request.params?.[name];
  if (typeof fromParams === "string") return fromParams;
  if (typeof request.param === "function") {
    const value = request.param(name);
    if (typeof value === "string") return value;
  }
  return "";
}

function registerFrontmatterKeyRoutes(plugin: LocalSmartLookupPlugin, api: RestApi): void {
  // Properties hygiene (vault metadata UX) — not under /si/* (SI = LanceDB mining).
  api.addRoute("/frontmatter_keys/")
    .get?.(async (_req, res) => {
      try {
        sendJson(api, res, listFrontmatterKeysFromVault(plugin.app));
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  // Unknown / unused key → empty list (not 404), matching agent-friendly tag tooling.
  api.addRoute("/frontmatter_keys/:name/")
    .get?.(async (req, res) => {
      try {
        const raw = readRouteParam(req, "name");
        let name = raw;
        try {
          name = decodeURIComponent(raw);
        } catch {
          name = raw;
        }
        sendJson(api, res, listFrontmatterKeyFilesFromVault(plugin.app, name));
      } catch (error) {
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

  registerFrontmatterKeyRoutes(plugin, api);
  registerSiRoutes(plugin, api);

  return () => api.unregister?.();
}
