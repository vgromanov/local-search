# Semantic Index (`/si/*`) API

Read-only query surface for pattern mining and offline clustering over the
Local Smart Lookup LanceDB index. All routes require the Local REST bearer
token, use **trailing slashes**, and **never apply the cross-encoder reranker**.

Filter grammar: [si-filter-grammar.md](si-filter-grammar.md).

## Guarantees

| Guarantee | Detail |
|-----------|--------|
| No rerank | SI paths call the store directly; `si_applies_rerank` is always `false` |
| Cosine distance | `_distance = 1 − cosine_similarity`; thresholds are inclusive (`<=`) |
| Keyset paging | Cursor = last `id` / `chunk_id`; numeric `offset` is rejected |
| Model consistency | Vectors come from the same embedding regime as the live index |
| Auth | Missing bearer → `401` |

Regime source of truth: LanceDB store sample + `index-meta.json`
(`embed_model`, `embed_dim`, `schema_ver`, `metric`, `built_at`).

Projected chunk scalars (`schema_ver = 3`): `uuid`, `workspace`, `date_bucket`,
`signal_kind`, `workflow_id`, plus existing `type` / `project` / `status` / …

## Routes

### `GET /si/health/`

Liveness probe.

```json
{ "ok": true, "version": "0.1.0", "schema_ver": "3", "chunks": 19022, "indexReady": true }
```

### `GET /si/index_info/`

Index regime stamp for mining clients.

```json
{
  "embed_model": "Qwen3-Embedding-4B-4bit-DWQ",
  "embed_dim": 2560,
  "reranker": "…",
  "schema_ver": "3",
  "metric": "cosine",
  "doc_count": 2293,
  "chunk_count": 19022,
  "built_at": "…",
  "si_applies_rerank": false,
  "mixed": false,
  "regimes": [{ "embedding_model": "…", "embedding_dim": 2560 }],
  "settings_vs_index_mismatch": false
}
```

### `POST /si/embed_text/`

Embed arbitrary strings with the index model (L2-normalize default `true`).

Request:

```json
{ "texts": ["only touch the api layer"], "normalize": true }
```

Response:

```json
{
  "embed_model": "…",
  "embed_dim": 2560,
  "vectors": [[0.01, "…"]],
  "errors": [{ "index": 1, "message": "…" }]
}
```

Batch max 64; oversized/invalid items become per-item `errors` (others succeed).

### `POST /si/query_metadata/`

Metadata-only keyset scan (no embedding).

Request:

```json
{
  "where": "type = 'session-summary' AND mtime > 1781000000",
  "fields": ["path", "uuid", "mtime", "workspace"],
  "limit": 500,
  "cursor": null
}
```

Response: `{ "rows": […], "next_cursor": "…" | null }`.

Unknown field → `400`. Numeric `offset` → `400`.

### `POST /si/knn/`

Raw flat cosine neighbors (no rerank). Provide **exactly one** of `vector` or
`chunk_id`.

Request:

```json
{
  "chunk_id": "path.md#hash#0",
  "k": 50,
  "threshold": 0.25,
  "metric": "cosine",
  "where": "type = 'automation-pattern'"
}
```

Response:

```json
{
  "hits": [
    {
      "chunk_id": "…",
      "path": "…",
      "uuid": "…",
      "distance": 0.11,
      "metadata": { "type": "…", "workspace": "…", "date_bucket": "…", "…": "…" }
    }
  ],
  "k": 50,
  "metric": "cosine",
  "threshold": 0.25,
  "bypass_vector_index": true
}
```

Dim mismatch → `400`. Unknown `chunk_id` → `404`. `k` capped at 1000 (default 50).
Uses `bypassVectorIndex` + LanceDB prefilter for `where`.

### `POST /si/count_neighbors/`

**Exact** grouped counts within a cosine-distance threshold.

Request:

```json
{
  "vector": [0.01],
  "threshold": 0.18,
  "metric": "cosine",
  "group_by": "uuid",
  "where": "type = 'session-summary'"
}
```

`group_by` ∈ `uuid` | `project` | `workspace` | `date_bucket` | `path`.
Empty group keys are `""`.

Response:

```json
{
  "total_hits": 37,
  "distinct_groups": 12,
  "counts": { "<uuid-a>": 3, "<uuid-b>": 1 },
  "threshold": 0.18,
  "metric": "cosine",
  "group_by": "uuid"
}
```

Exactness knobs: `bypassVectorIndex` + prefilter + `limit >= countRows(where)` +
select **no** `vector` column. Inclusive threshold (`distance <= threshold`).
`sum(counts) == total_hits`.

### `POST /si/get_vectors/`

Cursor-paged vector export for offline clustering. Vectors are plain JSON
number arrays (no Float32 base64).

Request:

```json
{ "where": "type = 'session-summary'", "include_text": false, "limit": 512, "cursor": null }
```

Response:

```json
{
  "items": [
    {
      "chunk_id": "…",
      "path": "…",
      "uuid": "…",
      "vector": [0.01],
      "metadata": { "embedding_dim": 2560, "…": "…" }
    }
  ],
  "next_cursor": "…"
}
```

Default limit 512, max 1000. `include_text` opt-in. Numeric `offset` → `400`.

### `POST /si/filter/validate/`

Compile + live count/sample for filter debugging. See grammar doc.

## Smoke

```bash
export OBSIDIAN_API_KEY=…
./scripts/smoke_si.sh
```

Optional: `SI_BASE=https://127.0.0.1:27124`.
