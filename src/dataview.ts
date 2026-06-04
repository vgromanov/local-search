import type { App } from "obsidian";
import type { DataviewApi } from "./types";

function extractPath(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    file?: { path?: string };
    path?: string;
    value?: unknown;
  };
  if (typeof candidate.file?.path === "string") return candidate.file.path;
  if (typeof candidate.path === "string") return candidate.path;
  if (candidate.value) return extractPath(candidate.value);
  return null;
}

function extractPaths(value: unknown, paths = new Set<string>()): Set<string> {
  const direct = extractPath(value);
  if (direct) paths.add(direct);

  if (Array.isArray(value)) {
    value.forEach((item) => extractPaths(item, paths));
  } else if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    if (Array.isArray(objectValue.values)) extractPaths(objectValue.values, paths);
    if (Array.isArray(objectValue.rows)) extractPaths(objectValue.rows, paths);
    if (Array.isArray(objectValue.children)) extractPaths(objectValue.children, paths);
  }
  return paths;
}

export class DataviewFilter {
  constructor(private app: App) {}

  get api(): DataviewApi | null {
    return (this.app as unknown as { plugins?: { plugins?: Record<string, { api?: DataviewApi }> } })
      .plugins?.plugins?.dataview?.api ?? null;
  }

  async resolvePaths(source?: string, query?: string): Promise<Set<string> | null> {
    const api = this.api;
    if (!api) return null;

    if (query?.trim() && api.query) {
      const result = await api.query(query.trim());
      return extractPaths(result);
    }

    if (source?.trim() && api.pages) {
      return extractPaths(api.pages(source.trim()));
    }

    return null;
  }
}
