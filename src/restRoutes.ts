import type LocalSmartLookupPlugin from "./main";
import {
  FilterCompileError,
  compileFilter
} from "./filterCompiler";
import { SCHEMA_VER } from "./schema";
import type { ObsidianRestPublicApi } from "./types";

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
