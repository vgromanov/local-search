import { Notice, TFile } from "obsidian";
import type { App, DataAdapter, Plugin } from "obsidian";
import { normalizePath } from "obsidian";
import type { IndexDecision } from "./vectorStore";
import type { VaultIndexer } from "./indexer";
import type { LanceVectorStore } from "./vectorStore";

type QueueItem = {
  path: string;
  enqueuedAt: string;
  updatedAt: string;
  attempts: number;
  lastError: string;
};

type StoredQueue = {
  version: 1;
  items: QueueItem[];
};

export type QueueStats = {
  queued: number;
  isProcessing: boolean;
  processingPath: string;
  processed: number;
  embedded: number;
  metadataOnly: number;
  unchanged: number;
  failed: number;
  lastError: string;
};

function emptyStats(): QueueStats {
  return {
    queued: 0,
    isProcessing: false,
    processingPath: "",
    processed: 0,
    embedded: 0,
    metadataOnly: 0,
    unchanged: 0,
    failed: 0,
    lastError: ""
  };
}

function countsAsEmbedded(decision: IndexDecision): boolean {
  return decision === "missing" || decision === "content-changed" || decision === "config-changed";
}

export class PersistentIndexQueue {
  private items = new Map<string, QueueItem>();
  private queuePath: string;
  private timer: number | null = null;
  private stopped = false;
  private stats: QueueStats = emptyStats();

  constructor(
    private app: App,
    private plugin: Plugin,
    private adapter: DataAdapter,
    private indexer: VaultIndexer,
    private store: LanceVectorStore
  ) {
    const pluginDir = normalizePath(plugin.manifest.dir ?? ".obsidian/plugins/local-smart-lookup");
    this.queuePath = normalizePath(`${pluginDir}/index-queue.json`);
  }

  async load(): Promise<void> {
    if (!(await this.adapter.exists(this.queuePath))) return;
    const stored = JSON.parse(await this.adapter.read(this.queuePath)) as StoredQueue;
    this.items = new Map((stored.items ?? []).map((item) => [item.path, item]));
    this.updateQueuedCount();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): QueueStats {
    this.updateQueuedCount();
    return { ...this.stats };
  }

  async enqueuePath(path: string, delayMs = 750): Promise<void> {
    this.setQueuedPath(path);
    await this.save();
    this.schedule(delayMs);
  }

  async enqueueVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const existingPaths = new Set(files.map((file) => file.path));
    await this.store.removeMissingPaths(existingPaths);
    for (const file of files) {
      this.setQueuedPath(file.path);
    }
    await this.save();
    this.schedule(0);
    new Notice(`Local Smart Lookup queued ${files.length} markdown files.`);
  }

  schedule(delayMs = 750): void {
    if (this.stopped || this.stats.isProcessing) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.process();
    }, delayMs);
  }

  private async process(): Promise<void> {
    if (this.stopped || this.stats.isProcessing) return;
    this.stats.isProcessing = true;

    try {
      while (!this.stopped && this.items.size > 0) {
        const item = this.nextItem();
        if (!item) break;
        this.items.delete(item.path);
        this.stats.processingPath = item.path;
        this.updateQueuedCount();
        await this.save();

        const file = this.app.vault.getAbstractFileByPath(item.path);
        if (!(file instanceof TFile) || file.extension !== "md") {
          this.stats.processed++;
          continue;
        }

        try {
          const decision = await this.indexer.indexFile(file);
          this.stats.processed++;
          if (countsAsEmbedded(decision)) this.stats.embedded++;
          if (decision === "metadata-only") this.stats.metadataOnly++;
          if (decision === "unchanged") this.stats.unchanged++;
          this.stats.lastError = "";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.stats.failed++;
          this.stats.lastError = message;
          this.items.set(item.path, {
            ...item,
            attempts: item.attempts + 1,
            lastError: message,
            updatedAt: new Date().toISOString()
          });
          await this.save();
          new Notice(`Local Smart Lookup queue paused: ${message}`);
          break;
        }
      }
    } finally {
      this.stats.processingPath = "";
      this.stats.isProcessing = false;
      this.updateQueuedCount();
      await this.save();
      if (!this.stopped && this.items.size > 0) this.schedule(10_000);
    }
  }

  private nextItem(): QueueItem | null {
    return Array.from(this.items.values())
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0] ?? null;
  }

  private setQueuedPath(path: string): void {
    const now = new Date().toISOString();
    const existing = this.items.get(path);
    this.items.set(path, {
      path,
      enqueuedAt: existing?.enqueuedAt ?? now,
      updatedAt: now,
      attempts: existing?.attempts ?? 0,
      lastError: existing?.lastError ?? ""
    });
  }

  private async save(): Promise<void> {
    this.updateQueuedCount();
    const stored: StoredQueue = {
      version: 1,
      items: Array.from(this.items.values()).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    };
    await this.adapter.write(this.queuePath, JSON.stringify(stored, null, 2));
  }

  private updateQueuedCount(): void {
    this.stats.queued = this.items.size;
  }
}
