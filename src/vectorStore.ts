import type { DataAdapter, Plugin } from "obsidian";
import { normalizePath } from "obsidian";
import type { VectorRecord } from "./types";

type StoredIndex = {
  version: 1;
  updatedAt: string;
  records: VectorRecord[];
};

export class JsonVectorStore {
  private records = new Map<string, VectorRecord>();
  private indexPath: string;

  constructor(private plugin: Plugin, private adapter: DataAdapter) {
    this.indexPath = normalizePath(`${plugin.manifest.dir ?? ".obsidian/plugins/local-smart-lookup"}/vectors.json`);
  }

  async load(): Promise<void> {
    if (!(await this.adapter.exists(this.indexPath))) {
      this.records.clear();
      return;
    }
    const json = JSON.parse(await this.adapter.read(this.indexPath)) as StoredIndex;
    this.records = new Map((json.records ?? []).map((record) => [record.id, record]));
  }

  async save(): Promise<void> {
    const payload: StoredIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      records: Array.from(this.records.values())
    };
    await this.adapter.write(this.indexPath, JSON.stringify(payload, null, 2));
  }

  all(): VectorRecord[] {
    return Array.from(this.records.values());
  }

  count(): number {
    return this.records.size;
  }

  paths(): Set<string> {
    return new Set(Array.from(this.records.values()).map((record) => record.path));
  }

  replacePath(path: string, records: VectorRecord[]): void {
    for (const [id, record] of this.records.entries()) {
      if (record.path === path) this.records.delete(id);
    }
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }

  removeMissingPaths(existingPaths: Set<string>): number {
    let removed = 0;
    for (const [id, record] of this.records.entries()) {
      if (!existingPaths.has(record.path)) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  if (aMag === 0 || bMag === 0) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}
