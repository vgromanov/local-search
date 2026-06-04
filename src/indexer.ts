import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import { LocalModelClient } from "./modelClient";
import type { LocalSmartLookupSettings, VaultChunk, VectorRecord } from "./types";
import { JsonVectorStore } from "./vectorStore";

function chunkText(file: TFile, text: string, chunkSize: number, overlap: number): VaultChunk[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
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
        id: `${file.path}#${position}`,
        path: file.path,
        basename: file.basename,
        mtime: file.stat.mtime,
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

  constructor(
    private app: App,
    private store: JsonVectorStore,
    private modelClient: LocalModelClient,
    private getSettings: () => LocalSmartLookupSettings
  ) {}

  status() {
    return {
      isIndexing: this.isIndexing,
      indexedChunks: this.store.count(),
      indexedFiles: this.store.paths().size,
      lastIndexedAt: this.lastIndexedAt
    };
  }

  async indexVault(): Promise<void> {
    if (this.isIndexing) return;
    this.isIndexing = true;
    try {
      const files = this.app.vault.getMarkdownFiles();
      const existingPaths = new Set(files.map((file) => file.path));
      this.store.removeMissingPaths(existingPaths);

      for (const file of files) {
        await this.indexFile(file);
      }
      await this.store.save();
      this.lastIndexedAt = new Date().toISOString();
      new Notice(`Local Smart Lookup indexed ${files.length} markdown files.`);
    } finally {
      this.isIndexing = false;
    }
  }

  async indexFile(file: TFile): Promise<void> {
    const existing = this.store.all().filter((record) => record.path === file.path);
    if (existing.length > 0 && existing.every((record) => record.mtime === file.stat.mtime)) {
      return;
    }

    const settings = this.getSettings();
    const content = await this.app.vault.cachedRead(file);
    const chunks = chunkText(file, content, settings.chunkSize, settings.chunkOverlap);
    const vectors = await this.modelClient.embed(chunks.map((chunk) => chunk.text));
    const records: VectorRecord[] = chunks.map((chunk, index) => ({
      ...chunk,
      vector: vectors[index]
    })).filter((record) => Array.isArray(record.vector) && record.vector.length > 0);

    this.store.replacePath(file.path, records);
  }
}
