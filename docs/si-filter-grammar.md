# SI filter grammar

Semantic Index (`/si/*`) filter compiler for Local Smart Lookup.

## Safety model

Callers may pass either a **structured** `filter` object or a **string** `where`.
Both are compiled to an AST and **re-emitted** as LanceDB SQL. Caller text is
never passed through to `.where()` unmodified.

## Endpoints (scaffold)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/si/health/` | Liveness: `{ ok, version, schema_ver, chunks, indexReady }` |
| `POST` | `/si/filter/validate/` | Compile + live count/sample against the index |

Auth: Local REST API bearer token (same as `/local-smart-lookup/*`).
All SI paths use **trailing slashes**.

### `POST /si/filter/validate/`

Request (one of `where` or `filter`):

```json
{ "where": "type = 'session-summary' AND mtime > 1781000000", "limit": 5 }
```

```json
{
  "filter": {
    "and": [
      { "field": "type", "op": "=", "value": "session-summary" },
      { "field": "mtime", "op": ">", "value": 1781000000 }
    ]
  }
}
```

Success `200`:

```json
{ "sql": "(...)", "row_count": 123, "sample": [{ "id": "...", "path": "...", "uuid": "..." }] }
```

Bad filter `400` (via REST `sendError`): message names unknown field/operator.

## Queryable fields

| Friendly name | Column |
|---------------|--------|
| `id` | `id` (chunk PK) |
| `path`, `folder`, `basename` | same |
| `mtime`, `size`, `position` | same (numeric) |
| `title`, `status`, `project`, `type` | same |
| `uuid` / `session_uuid` | `uuid` |
| `workspace` | `workspace` |
| `date_bucket` / `date` | `date_bucket` |
| `signal_kind`, `workflow_id` | same |
| `schema_ver` | `schema_ver` |

Unknown field → `400` with `Unknown field: <name>`.

## Operators

`=`, `!=`, `>`, `>=`, `<`, `<=`, `IN`, plus `AND` / `OR` / `NOT` and parentheses.

Caps: max 64 leaf clauses, depth 8, string length 2048, `IN` list 64, input 4096.

## Pagination (SI convention)

Keyset on chunk `id` (not numeric `offset`). Cursor = last returned `id`.
Helpers: `normalizeKeysetPage`, `keysetPredicate` in `src/filterCompiler.ts`.

## Distance threshold (SI convention)

LanceDB cosine `_distance = 1 − cosine_similarity` ∈ `[0, 2]`.
SI endpoints keep hits with `_distance <= threshold` (`distanceWithinThreshold`).

Exact neighbor scans (later `count_neighbors`) must use:
`prefilter` + `bypassVectorIndex` + `limit >= countRows(where)`, and must **not**
select the `vector` column when only counting.

## Envelope

SI success payloads are minimal JSON objects (no required `ok: true` wrapper),
matching existing `/local-smart-lookup/search/` style. Errors use Local REST
`sendError` (HTTP status + message).
