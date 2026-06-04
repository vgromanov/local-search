import { createHash } from "crypto";
import { Notice, TFile } from "obsidian";
import type { App, CachedMetadata } from "obsidian";
import { LocalModelClient } from "./modelClient";
import type { LocalSmartLookupSettings, VaultChunk, VectorRecord } from "./types";
import type { IndexDecision } from "./vectorStore";
import { LanceVectorStore } from "./vectorStore";

type PreparedDocument = {
  content: string;
  body: string;
  contentHash: string;
  bodyHash: string;
  frontmatterHash: string;
  chunkingConfigHash: string;
  embeddingModel: string;
  metadata: Omit<VectorRecord, "id" | "position" | "text" | "vector">;
};

type IndexStats = {
  scanned: number;
  embedded: number;
  metadataOnly: number;
  unchanged: number;
  removed: number;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripFrontmatter(content: string): { body: string; rawFrontmatter: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized, rawFrontmatter: "" };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { body: normalized, rawFrontmatter: "" };
  }
  const closeEnd = normalized.indexOf("\n", end + 4);
  return {
    rawFrontmatter: normalized.slice(0, closeEnd === -1 ? normalized.length : closeEnd),
    body: closeEnd === -1 ? "" : normalized.slice(closeEnd + 1)
  };
}

function folderFor(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(stringList);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function extractInlineTags(body: string, cache: CachedMetadata | null): string[] {
  const fromCache = (cache?.tags ?? []).map((item) => item.tag).map(normalizeTag);
  const fromBody = Array.from(body.matchAll(/(^|\s)#([A-Za-z0-9/_-]+)/g)).map((match) => match[2]);
  return unique([...fromCache, ...fromBody]);
}

function valueAsString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(valueAsString).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function chunkText(file: TFile, body: string, metadata: PreparedDocument["metadata"], chunkSize: number, overlap: number): VaultChunk[] {
  const clean = body.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const chunks: VaultChunk[] = [];
  const step = Math.max(1, chunkSize - overlap);
  let start = 0;
  let position = 0;

  while (start < clean.length) {
    const end = Math.min(clean.length, start + chunkSize);
    let sliceEnd = end;
    if (end < clean.length) {
      const paragraphBreak = clean.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + chunkSize * 0.5) {
        sliceEnd = paragraphBreak;
      }
    }
    const chunk = clean.slice(start, sliceEnd).trim();
    if (chunk) {
      chunks.push({
        id: `${file.path}#${metadata.bodyHash.slice(0, 12)}#${position}`,
        path: file.path,
        folder: metadata.folder,
        basename: file.basename,
        mtime: file.stat.mtime,
        size: file.stat.size,
        position,
        text: chunk
      });
      position++;
    }
    start = sliceEnd >= clean.length ? clean.length : Math.max(sliceEnd - overlap, start + step);
  }

  return chunks;
}

export class VaultIndexer {
  private isIndexing = false;
  private lastIndexedAt = "";
  private lastStats: IndexStats = { scanned: 0, embedded: 0, metadataOnly: 0, unchanged: 0, removed: 0 };

  constructor(
    private app: App,
    private store: LanceVectorStore,
    private modelClient: LocalModelClient,
    private getSettings: () => LocalSmartLookupSettings
  ) {}

  async status() {
    return {
      isIndexing: this.isIndexing,
      indexedChunks: await this.store.count(),
      indexedFiles: (await this.store.paths()).size,
      lastIndexedAt: this.lastIndexedAt,
      lastStats: this.lastStats
    };
  }

  async indexVault(): Promise<IndexStats> {
    if (this.isIndexing) return this.lastStats;
    this.isIndexing = true;
    const stats: IndexStats = { scanned: 0, embedded: 0, metadataOnly: 0, unchanged: 0, removed: 0 };
    try {
      const files = this.app.vault.getMarkdownFiles();
      const existingPaths = new Set(files.map((file) => file.path));
      stats.removed = await this.store.removeMissingPaths(existingPaths);

      for (const file of files) {
        const decision = await this.indexFile(file);
        stats.scanned++;
        if (decision === "unchanged") stats.unchanged++;
        if (decision === "metadata-only") stats.metadataOnly++;
        if (decision === "missing" || decision === "content-changed" || decision === "config-changed") stats.embedded++;
      }
      this.lastStats = stats;
      this.lastIndexedAt = new Date().toISOString();
      new Notice(`Local Smart Lookup indexed ${stats.embedded} files, skipped ${stats.unchanged}.`);
      return stats;
    } finally {
      this.isIndexing = false;
    }
  }

  async indexFile(file: TFile): Promise<IndexDecision> {
    const prepared = await this.prepareDocument(file);
    const existing = await this.store.stateForPath(file.path);
    const decision = this.store.decideIndex(existing, prepared);

    if (decision === "unchanged") {
      return decision;
    }

    if (decision === "metadata-only") {
      await this.store.updatePathMetadata(file.path, prepared.metadata);
      return decision;
    }

    const settings = this.getSettings();
    const chunks = chunkText(file, prepared.body, prepared.metadata, settings.chunkSize, settings.chunkOverlap);
    const vectors = await this.modelClient.embed(chunks.map((chunk) => chunk.text));
    const records: VectorRecord[] = chunks.map((chunk, index) => ({
      ...chunk,
      ...prepared.metadata,
      vector: vectors[index],
      embeddingDim: vectors[index]?.length ?? 0
    })).filter((record) => Array.isArray(record.vector) && record.vector.length > 0);

    await this.store.replacePath(file.path, records);
    return decision;
  }

  async renameFile(oldPath: string, file: TFile): Promise<void> {
    await this.store.renamePath(oldPath, file.path, file.basename, folderFor(file.path));
  }

  private async prepareDocument(file: TFile): Promise<PreparedDocument> {
    const settings = this.getSettings();
    const content = await this.app.vault.cachedRead(file);
    const { body, rawFrontmatter } = stripFrontmatter(content);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter ?? {};
    const frontmatterTags = unique(stringList(frontmatter.tags).map(normalizeTag));
    const inlineTags = extractInlineTags(body, cache);
    const tags = unique([...frontmatterTags, ...inlineTags]);
    const aliases = unique(stringList(frontmatter.aliases ?? frontmatter.alias));
    const frontmatterKeys = Object.keys(frontmatter).sort((a, b) => a.localeCompare(b));
    const chunkingConfigHash = hash(JSON.stringify({
      chunkSize: settings.chunkSize,
      chunkOverlap: settings.chunkOverlap,
      indexedBody: "markdown-body-v1"
    }));

    const metadata: PreparedDocument["metadata"] = {
      path: file.path,
      folder: folderFor(file.path),
      basename: file.basename,
      mtime: file.stat.mtime,
      size: file.stat.size,
      contentHash: hash(content),
      bodyHash: hash(body),
      frontmatterHash: hash(rawFrontmatter || stableJson(frontmatter)),
      chunkingConfigHash,
      embeddingModel: settings.embeddingModel,
      embeddingDim: 0,
      indexedAt: new Date().toISOString(),
      tags,
      inlineTags,
      frontmatterTags,
      aliases,
      frontmatter,
      frontmatterKeys,
      title: valueAsString(frontmatter.title),
      status: valueAsString(frontmatter.status),
      project: valueAsString(frontmatter.project),
      type: valueAsString(frontmatter.type)
    };

    return {
      content,
      body,
      contentHash: metadata.contentHash,
      bodyHash: metadata.bodyHash,
      frontmatterHash: metadata.frontmatterHash,
      chunkingConfigHash,
      embeddingModel: settings.embeddingModel,
      metadata
    };
  }
}
