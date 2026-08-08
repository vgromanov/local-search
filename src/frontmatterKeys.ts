import type { App, TFile } from "obsidian";

export type FrontmatterKeyEntry = {
  name: string;
  count: number;
  type: string;
};

export type FrontmatterKeyFileEntry = {
  filename: string;
};

type PropertyTypeResolver = (name: string) => string | null | undefined;

type FrontmatterSnapshot = {
  path: string;
  keys: string[];
};

/**
 * Infer a coarse Obsidian Properties-style type from a YAML value when
 * metadataTypeManager / Dataview has no assigned type.
 */
export function inferFrontmatterType(value: unknown): string {
  if (value === null || value === undefined) return "text";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return "multitext";
    return "multitext";
  }
  if (typeof value === "string") {
    // Obsidian date properties are often YYYY-MM-DD strings.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return "date";
    return "text";
  }
  if (typeof value === "object") return "text";
  return "text";
}

export function sortFrontmatterKeyEntries(entries: FrontmatterKeyEntry[]): FrontmatterKeyEntry[] {
  return [...entries].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Build vault-wide property inventory from note frontmatter snapshots.
 * Counts are note counts (one per path), not chunk counts.
 */
export function buildFrontmatterKeyInventory(
  notes: FrontmatterSnapshot[],
  resolveType: PropertyTypeResolver,
  sampleValues: Map<string, unknown> = new Map()
): FrontmatterKeyEntry[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const seen = new Set<string>();
    for (const key of note.keys) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const entries: FrontmatterKeyEntry[] = [];
  for (const [name, count] of counts) {
    const assigned = resolveType(name);
    const type = assigned && assigned.trim()
      ? assigned.trim()
      : inferFrontmatterType(sampleValues.get(name));
    entries.push({ name, count, type });
  }
  return sortFrontmatterKeyEntries(entries);
}

export function filesForFrontmatterKey(
  notes: FrontmatterSnapshot[],
  key: string
): FrontmatterKeyFileEntry[] {
  const target = key.trim();
  if (!target) return [];
  const files: FrontmatterKeyFileEntry[] = [];
  for (const note of notes) {
    if (note.keys.includes(target)) {
      files.push({ filename: note.path });
    }
  }
  files.sort((a, b) => a.filename.localeCompare(b.filename));
  return files;
}

function readAssignedPropertyType(app: App, name: string): string | null {
  const typeManager = (app as unknown as {
    metadataTypeManager?: {
      getPropertyInfo?: (key: string) => { type?: string } | null | undefined;
      getTypeInfo?: (key: string) => { type?: string } | null | undefined;
      getAssignedType?: (key: string) => string | null | undefined;
    };
  }).metadataTypeManager;

  if (!typeManager) return null;

  const assigned = typeManager.getAssignedType?.(name);
  if (typeof assigned === "string" && assigned.trim()) return assigned.trim();

  const info = typeManager.getPropertyInfo?.(name) ?? typeManager.getTypeInfo?.(name);
  if (info && typeof info.type === "string" && info.type.trim()) return info.type.trim();

  return null;
}

function collectFrontmatterSnapshots(app: App): {
  notes: FrontmatterSnapshot[];
  sampleValues: Map<string, unknown>;
} {
  const files = app.vault.getMarkdownFiles() as TFile[];
  const notes: FrontmatterSnapshot[] = [];
  const sampleValues = new Map<string, unknown>();

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter || typeof frontmatter !== "object") {
      notes.push({ path: file.path, keys: [] });
      continue;
    }
    const keys = Object.keys(frontmatter).filter((key) => key !== "position");
    notes.push({ path: file.path, keys });
    for (const key of keys) {
      if (!sampleValues.has(key)) {
        sampleValues.set(key, (frontmatter as Record<string, unknown>)[key]);
      }
    }
  }

  return { notes, sampleValues };
}

/** Live vault inventory via metadataCache + Properties type manager. */
export function listFrontmatterKeysFromVault(app: App): FrontmatterKeyEntry[] {
  const { notes, sampleValues } = collectFrontmatterSnapshots(app);
  return buildFrontmatterKeyInventory(
    notes,
    (name) => readAssignedPropertyType(app, name),
    sampleValues
  );
}

/** Live vault files that have `key` set in frontmatter. Unknown key → []. */
export function listFrontmatterKeyFilesFromVault(app: App, key: string): FrontmatterKeyFileEntry[] {
  const { notes } = collectFrontmatterSnapshots(app);
  return filesForFrontmatterKey(notes, key);
}
