import { Notice, Plugin, TFile } from "obsidian";
import { DataviewFilter } from "./dataview";
import { PersistentIndexQueue } from "./indexQueue";
import { VaultIndexer } from "./indexer";
import { LocalModelClient } from "./modelClient";
import { registerRestRoutes } from "./restRoutes";
import { SearchService } from "./searchService";
import { DEFAULT_SETTINGS, LocalSmartLookupSettingTab } from "./settings";
import type { LocalSmartLookupSettings } from "./types";
import { LanceVectorStore } from "./vectorStore";
import { LocalSmartLookupView, VIEW_TYPE_LOCAL_SMART_LOOKUP } from "./view";

export default class LocalSmartLookupPlugin extends Plugin {
  settings: LocalSmartLookupSettings;
  modelClient: LocalModelClient;
  vectorStore: LanceVectorStore;
  indexer: VaultIndexer;
  indexQueue: PersistentIndexQueue;
  searchService: SearchService;
  dataviewFilter: DataviewFilter;
  unregisterRestRoutes: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.modelClient = new LocalModelClient(() => this.settings);
    this.vectorStore = new LanceVectorStore(this, this.app.vault.adapter);
    await this.vectorStore.load();
    this.dataviewFilter = new DataviewFilter(this.app);
    this.indexer = new VaultIndexer(this.app, this.vectorStore, this.modelClient, () => this.settings);
    this.indexQueue = new PersistentIndexQueue(this.app, this, this.app.vault.adapter, this.indexer, this.vectorStore);
    await this.indexQueue.load();
    this.searchService = new SearchService(this.app, this.vectorStore, this.modelClient, this.dataviewFilter, () => this.settings);

    this.registerView(
      VIEW_TYPE_LOCAL_SMART_LOOKUP,
      (leaf) => new LocalSmartLookupView(leaf, this)
    );

    this.addRibbonIcon("search", "Open Local Smart Lookup", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-local-smart-lookup",
      name: "Open Local Smart Lookup",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "index-local-smart-lookup",
      name: "Index vault for Local Smart Lookup",
      callback: () => void this.indexQueue.enqueueVault()
    });

    this.addCommand({
      id: "rebuild-lexical-index-local-smart-lookup",
      name: "Rebuild lexical (BM25) index",
      callback: () => {
        new Notice("Local Smart Lookup: rebuilding lexical index...");
        void this.vectorStore.ensureLexicalIndex(true).then((ok) => {
          new Notice(ok
            ? "Local Smart Lookup: lexical index ready."
            : "Local Smart Lookup: lexical index build failed (see console).");
        });
      }
    });

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        void this.indexQueue.enqueuePath(file.path);
      }
    }));

    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        void this.indexQueue.enqueuePath(file.path);
      }
    }));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && file.extension === "md") {
        void this.indexer.renameFile(oldPath, file).then(() => this.indexQueue.enqueuePath(file.path, 0));
      }
    }));

    this.registerEvent(this.app.vault.on("delete", async () => {
      const markdownPaths = new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
      await this.vectorStore.removeMissingPaths(markdownPaths);
    }));

    this.addSettingTab(new LocalSmartLookupSettingTab(this.app, this));
    this.tryRegisterRestRoutes();
    this.registerEvent(this.app.workspace.on("obsidian-local-rest-api:loaded" as never, () => {
      this.tryRegisterRestRoutes();
    }));
    this.indexQueue.schedule(2_000);

    new Notice("Local Smart Lookup loaded.");
  }

  onunload(): void {
    this.unregisterRestRoutes?.();
    this.unregisterRestRoutes = null;
    this.indexQueue?.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_LOCAL_SMART_LOOKUP);
    this.vectorStore?.close();
  }

  tryRegisterRestRoutes(): void {
    if (this.unregisterRestRoutes) return;
    this.unregisterRestRoutes = registerRestRoutes(this);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_LOCAL_SMART_LOOKUP)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_LOCAL_SMART_LOOKUP, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
