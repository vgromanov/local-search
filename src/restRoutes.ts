import type LocalSmartLookupPlugin from "./main";
import type { ObsidianRestPublicApi } from "./types";

function readJsonBody(req: unknown): Record<string, unknown> {
  const request = req as {
    body?: unknown;
    json?: unknown;
  };
  if (request.body && typeof request.body === "object") return request.body as Record<string, unknown>;
  if (request.json && typeof request.json === "object") return request.json as Record<string, unknown>;
  return {};
}

function sendError(api: ObsidianRestPublicApi, res: unknown, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (api.sendError) {
    api.sendError(res, status, message);
    return;
  }
  api.sendSuccess(res, { ok: false, error: message, status });
}

export function registerRestRoutes(plugin: LocalSmartLookupPlugin): void {
  const api = (plugin.app as unknown as {
    plugins?: {
      plugins?: Record<string, { getPublicApi?: (manifest: unknown) => ObsidianRestPublicApi | null }>;
    };
  }).plugins?.plugins?.["obsidian-api"]?.getPublicApi?.(plugin.manifest);

  if (!api) return;

  api.addRoute("/local-smart-lookup/status/")
    .get?.(async (_req, res) => {
      api.sendSuccess(res, {
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
        api.sendSuccess(res, { results });
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });

  api.addRoute("/local-smart-lookup/reindex/")
    .post?.(async (_req, res) => {
      try {
        await plugin.indexQueue.enqueueVault();
        api.sendSuccess(res, {
          index: await plugin.indexer.status(),
          queue: plugin.indexQueue.status()
        });
      } catch (error) {
        sendError(api, res, 500, error);
      }
    });
}
