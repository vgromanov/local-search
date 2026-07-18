/**
 * Index schema regime for Local Smart Lookup.
 *
 * - Chunk primary key column: `id` (path#bodyHash#position)
 * - Note/session identifier column: `uuid` (from frontmatter.uuid ?? session_uuid)
 * - Absent scalars use empty string `""` — never null (Arrow null-type trap on createTable)
 * - Bump SCHEMA_VER whenever projected columns or their semantics change (triggers drop/recreate)
 */

export const SCHEMA_VER = "3";

export const INDEX_METRIC = "cosine" as const;

export type IndexMeta = {
  schema_ver: string;
  metric: typeof INDEX_METRIC;
  built_at: string;
  embedding_model: string;
  embedding_dim: number;
};

/** Friendly filter/group field → LanceDB column name. */
export const QUERYABLE_FIELDS: Record<string, string> = {
  id: "id",
  path: "path",
  folder: "folder",
  basename: "basename",
  mtime: "mtime",
  size: "size",
  position: "position",
  title: "title",
  status: "status",
  project: "project",
  type: "type",
  uuid: "uuid",
  session_uuid: "uuid",
  workspace: "workspace",
  date_bucket: "date_bucket",
  date: "date_bucket",
  signal_kind: "signal_kind",
  workflow_id: "workflow_id",
  schema_ver: "schema_ver"
};

export const SCALAR_FILTER_COLUMNS = [
  "title",
  "status",
  "project",
  "type",
  "uuid",
  "workspace",
  "date_bucket",
  "signal_kind",
  "workflow_id",
  "schema_ver"
] as const;

const DATE_BUCKET_RE = /^(\d{4}-\d{2}-\d{2})/;
const DAILY_PATH_RE = /(?:^|\/)Daily\/(\d{4}-\d{2}-\d{2})(?:\/|\.md$)/;

/** TZ-safe: string-slice YYYY-MM-DD; never toISOString(). */
export function normalizeDateBucket(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = DATE_BUCKET_RE.exec(trimmed);
    return match ? match[1] : "";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Obsidian sometimes stores dates as epoch ms — still avoid TZ shift by using UTC date parts only for numeric.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  if (typeof value === "object" && value !== null && "toISOString" in value && typeof (value as Date).toISOString === "function") {
    const iso = (value as Date).toISOString();
    return iso.slice(0, 10);
  }
  return "";
}

export function dateBucketFromPath(path: string): string {
  const match = DAILY_PATH_RE.exec(path);
  return match ? match[1] : "";
}

export function resolveDateBucket(frontmatterDate: unknown, path: string): string {
  const fromFm = normalizeDateBucket(frontmatterDate);
  if (fromFm) return fromFm;
  return dateBucketFromPath(path);
}

export function resolveNoteUuid(frontmatter: Record<string, unknown>): string {
  const uuid = frontmatter.uuid;
  const sessionUuid = frontmatter.session_uuid;
  if (uuid !== null && uuid !== undefined && String(uuid).trim()) return String(uuid).trim();
  if (sessionUuid !== null && sessionUuid !== undefined && String(sessionUuid).trim()) return String(sessionUuid).trim();
  return "";
}
