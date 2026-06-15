import { App, PluginSettingTab, Setting } from "obsidian";
import type LocalSmartLookupPlugin from "./main";
import type { LocalSmartLookupSettings } from "./types";

export const DEFAULT_SETTINGS: LocalSmartLookupSettings = {
  embeddingBaseUrl: "http://127.0.0.1:11434",
  embeddingModel: "nomic-embed-text",
  embeddingPath: "/v1/embeddings",
  rerankBaseUrl: "http://127.0.0.1:11434",
  rerankModel: "",
  rerankPath: "/v1/rerank",
  useRerank: false,
  chunkSize: 1200,
  chunkOverlap: 180,
  defaultLimit: 10,
  defaultDataviewSource: "",
  useLexical: true,
  candidateMultiplier: 4,
  rerankPoolSize: 50,
  rrfK: 60,
  rrfWeightRerank: 1,
  rrfWeightVector: 0.6,
  rrfWeightLexical: 0.4
};

function numberSetting(value: string, fallback: number, min: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

export class LocalSmartLookupSettingTab extends PluginSettingTab {
  plugin: LocalSmartLookupPlugin;

  constructor(app: App, plugin: LocalSmartLookupPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Embedding server")
      .setDesc("Local oMLX or OpenAI-compatible base URL.")
      .addText((text) => text
        .setPlaceholder("http://127.0.0.1:11434")
        .setValue(this.plugin.settings.embeddingBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.embeddingBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Embedding path")
      .addText((text) => text
        .setPlaceholder("/v1/embeddings")
        .setValue(this.plugin.settings.embeddingPath)
        .onChange(async (value) => {
          this.plugin.settings.embeddingPath = value.trim() || DEFAULT_SETTINGS.embeddingPath;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Embedding model")
      .addText((text) => text
        .setPlaceholder("nomic-embed-text")
        .setValue(this.plugin.settings.embeddingModel)
        .onChange(async (value) => {
          this.plugin.settings.embeddingModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Use local reranker")
      .setDesc("Reranks the vector candidates through a local endpoint after semantic retrieval.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useRerank)
        .onChange(async (value) => {
          this.plugin.settings.useRerank = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Rerank server")
      .addText((text) => text
        .setPlaceholder("http://127.0.0.1:11434")
        .setValue(this.plugin.settings.rerankBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.rerankBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Rerank path")
      .addText((text) => text
        .setPlaceholder("/v1/rerank")
        .setValue(this.plugin.settings.rerankPath)
        .onChange(async (value) => {
          this.plugin.settings.rerankPath = value.trim() || DEFAULT_SETTINGS.rerankPath;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Rerank model")
      .addText((text) => text
        .setPlaceholder("local-reranker")
        .setValue(this.plugin.settings.rerankModel)
        .onChange(async (value) => {
          this.plugin.settings.rerankModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Lexical (BM25) fusion")
      .setDesc("Add a full-text BM25 retrieval leg and fuse it with vector + rerank via Reciprocal Rank Fusion. Recovers exact-term matches and breaks reranker score ties.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useLexical)
        .onChange(async (value) => {
          this.plugin.settings.useLexical = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("RRF k")
      .setDesc("Reciprocal Rank Fusion constant. Higher flattens the contribution of top ranks.")
      .addText((text) => text
        .setPlaceholder("60")
        .setValue(String(this.plugin.settings.rrfK))
        .onChange(async (value) => {
          this.plugin.settings.rrfK = numberSetting(value, DEFAULT_SETTINGS.rrfK, 1);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("RRF weights (rerank / vector / lexical)")
      .setDesc("Relative authority of each ranked leg in the fusion.")
      .addText((text) => text
        .setPlaceholder("1")
        .setValue(String(this.plugin.settings.rrfWeightRerank))
        .onChange(async (value) => {
          this.plugin.settings.rrfWeightRerank = numberSetting(value, DEFAULT_SETTINGS.rrfWeightRerank, 0);
          await this.plugin.saveSettings();
        }))
      .addText((text) => text
        .setPlaceholder("0.6")
        .setValue(String(this.plugin.settings.rrfWeightVector))
        .onChange(async (value) => {
          this.plugin.settings.rrfWeightVector = numberSetting(value, DEFAULT_SETTINGS.rrfWeightVector, 0);
          await this.plugin.saveSettings();
        }))
      .addText((text) => text
        .setPlaceholder("0.4")
        .setValue(String(this.plugin.settings.rrfWeightLexical))
        .onChange(async (value) => {
          this.plugin.settings.rrfWeightLexical = numberSetting(value, DEFAULT_SETTINGS.rrfWeightLexical, 0);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Candidate multiplier")
      .setDesc("Per-leg over-fetch factor before fusion (limit x multiplier).")
      .addText((text) => text
        .setPlaceholder("4")
        .setValue(String(this.plugin.settings.candidateMultiplier))
        .onChange(async (value) => {
          this.plugin.settings.candidateMultiplier = Math.round(numberSetting(value, DEFAULT_SETTINGS.candidateMultiplier, 1));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Rerank pool size")
      .setDesc("Maximum merged candidates sent to the cross-encoder per search.")
      .addText((text) => text
        .setPlaceholder("50")
        .setValue(String(this.plugin.settings.rerankPoolSize))
        .onChange(async (value) => {
          this.plugin.settings.rerankPoolSize = Math.round(numberSetting(value, DEFAULT_SETTINGS.rerankPoolSize, 1));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Default Dataview source")
      .setDesc("Optional Dataview source filter, for example #research or \"Projects\".")
      .addText((text) => text
        .setPlaceholder("#research or \"Projects\"")
        .setValue(this.plugin.settings.defaultDataviewSource)
        .onChange(async (value) => {
          this.plugin.settings.defaultDataviewSource = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Default result count")
      .addText((text) => text
        .setPlaceholder("10")
        .setValue(String(this.plugin.settings.defaultLimit))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.defaultLimit = Number.isFinite(parsed) ? Math.max(1, parsed) : DEFAULT_SETTINGS.defaultLimit;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Chunk size")
      .setDesc("Approximate characters per indexed chunk.")
      .addText((text) => text
        .setPlaceholder("1200")
        .setValue(String(this.plugin.settings.chunkSize))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.chunkSize = Number.isFinite(parsed) ? Math.max(300, parsed) : DEFAULT_SETTINGS.chunkSize;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Chunk overlap")
      .addText((text) => text
        .setPlaceholder("180")
        .setValue(String(this.plugin.settings.chunkOverlap))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.chunkOverlap = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_SETTINGS.chunkOverlap;
          await this.plugin.saveSettings();
        }));
  }
}
