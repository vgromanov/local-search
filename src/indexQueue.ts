import { Notice, TFile } from "obsidian";
import type { App, DataAdapter, Plugin } from "obsidian";
import { normalizePath } from "obsidian";
import type { CompactResult, IndexDecision, LanceVectorStore } from "./vectorStore";
import { formatBytes } from "./vectorStore";
import type { VaultIndexer } from "./indexer";

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
  private maintenanceRunning = false;

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
    }
    this.timer = null;
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

  /**
   * In-place LanceDB reclaim. Requires idle queue (no items / not processing).
   */
  async compactNow(): Promise<CompactResult> {
    this.assertIdleForMaintenance("compact");
    this.maintenanceRunning = true;
    try {
      new Notice("Local Smart Lookup: compacting index (search may slow)...");
      const result = await this.store.compactUntilStable(3);
      await this.indexer.persistIndexMeta();
      new Notice(
        `Local Smart Lookup: compact done — ${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)} (${result.passes} pass${result.passes === 1 ? "" : "es"}).`
      );
      return result;
    } finally {
      this.maintenanceRunning = false;
    }
  }

  /**
   * Wipe on-disk LanceDB and re-enqueue full vault reindex. Hours of downtime possible.
   */
  async wipeAndReindex(): Promise<void> {
    this.assertIdleForMaintenance("wipe");
    this.maintenanceRunning = true;
    try {
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
      this.items.clear();
      await this.save();
      new Notice("Local Smart Lookup: wiping index...");
      await this.store.wipeIndex();
      // Populate queue while maintenance blocks schedule(); arm timer in finally.
      const files = this.app.vault.getMarkdownFiles();
      for (const file of files) {
        this.setQueuedPath(file.path);
      }
      await this.save();
      new Notice(`Local Smart Lookup: wipe complete — queued ${files.length} files for reindex.`);
    } finally {
      this.maintenanceRunning = false;
      if (!this.stopped && this.items.size > 0) {
        this.schedule(0);
      }
    }
  }

  schedule(delayMs = 750): void {
    if (this.stopped || this.stats.isProcessing || this.maintenanceRunning) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.process();
    }, delayMs);
  }

  private assertIdleForMaintenance(action: string): void {
    if (this.maintenanceRunning) {
      throw new Error(`Another index maintenance task is already running.`);
    }
    if (this.stats.isProcessing || this.items.size > 0) {
      throw new Error(
        `Cannot ${action} while the index queue is busy (${this.items.size} queued). Wait until it drains.`
      );
    }
  }

  private async process(): Promise<void> {
    if (this.stopped || this.stats.isProcessing || this.maintenanceRunning) return;
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
      if (!this.stopped && this.items.size > 0) {
        this.schedule(10_000);
      } else if (!this.stopped && !this.maintenanceRunning) {
        // Queue drained: fold new fragments into vector + FTS indexes and prune
        // old Lance versions so disk usage stays bounded.
        await this.store.optimize();
        await this.store.ensureLexicalIndex();
        await this.indexer.persistIndexMeta();
      }
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
