import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type { SearchResult } from "./types";
import type LocalSmartLookupPlugin from "./main";

export const VIEW_TYPE_LOCAL_SMART_LOOKUP = "local-smart-lookup-view";

export class LocalSmartLookupView extends ItemView {
  private queryInput!: HTMLInputElement;
  private dataviewInput!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: LocalSmartLookupPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LOCAL_SMART_LOOKUP;
  }

  getDisplayText(): string {
    return "Local Smart Lookup";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("local-smart-lookup-view");

    const toolbar = root.createDiv({ cls: "local-smart-lookup-toolbar" });
    this.queryInput = toolbar.createEl("input", {
      type: "search",
      placeholder: "Ask about an idea in your vault"
    });
    const searchButton = toolbar.createEl("button", { text: "Search" });

    const actionRow = root.createDiv({ cls: "local-smart-lookup-action-row" });
    const indexButton = actionRow.createEl("button", { text: "Index vault" });
    const refreshButton = actionRow.createEl("button", { text: "Refresh status" });

    const filterRow = root.createDiv({ cls: "local-smart-lookup-filter-row" });
    this.dataviewInput = filterRow.createEl("input", {
      type: "text",
      placeholder: "Dataview source filter"
    });
    this.dataviewInput.value = this.plugin.settings.defaultDataviewSource;

    this.statusEl = root.createDiv({ cls: "local-smart-lookup-status" });
    this.resultsEl = root.createDiv({ cls: "local-smart-lookup-results" });

    this.queryInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.runSearch();
    });
    searchButton.addEventListener("click", () => void this.runSearch());
    indexButton.addEventListener("click", () => void this.runIndex());
    refreshButton.addEventListener("click", () => void this.renderStatus());

    void this.renderStatus();
    this.renderEmpty("Type a question to search indexed notes by meaning.");
  }

  private async renderStatus(): Promise<void> {
    const status = await this.plugin.indexer.status();
    this.statusEl.setText(`${status.indexedFiles} files, ${status.indexedChunks} chunks indexed${status.isIndexing ? " · indexing" : ""}`);
  }

  private renderEmpty(text: string): void {
    this.resultsEl.empty();
    this.resultsEl.createDiv({ cls: "local-smart-lookup-empty", text });
  }

  private async runIndex(): Promise<void> {
    try {
      this.renderEmpty("Indexing markdown files...");
      await this.plugin.indexer.indexVault();
      await this.renderStatus();
      this.renderEmpty("Index ready. Ask a question to search.");
    } catch (error) {
      new Notice(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`);
      this.renderEmpty("Indexing failed. Check your local embedding server settings.");
    }
  }

  private async runSearch(): Promise<void> {
    const query = this.queryInput.value.trim();
    if (!query) return;

    try {
      this.renderEmpty("Searching...");
      const results = await this.plugin.searchService.search(query, {
        dataviewSource: this.dataviewInput.value.trim()
      });
      this.renderResults(results);
    } catch (error) {
      new Notice(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
      this.renderEmpty("Search failed. Check your local model server and index status.");
    }
  }

  private renderResults(results: SearchResult[]): void {
    this.resultsEl.empty();
    if (results.length === 0) {
      this.renderEmpty("No semantic matches found.");
      return;
    }

    for (const result of results) {
      const item = this.resultsEl.createDiv({ cls: "local-smart-lookup-result" });
      const title = item.createDiv({ cls: "local-smart-lookup-result-title" });
      const button = title.createEl("button", { text: result.path });
      button.addEventListener("click", () => void this.plugin.searchService.openResult(result));
      title.createSpan({
        cls: "local-smart-lookup-score",
        text: `score ${(result.rerankScore ?? result.score).toFixed(3)}`
      });
      item.createDiv({
        cls: "local-smart-lookup-excerpt",
        text: result.text.slice(0, 700)
      });
    }
  }
}
