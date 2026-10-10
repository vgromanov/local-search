# Link graph (`POST /graph/traverse/`)

Read-only walk over the in-memory link graph built from Obsidian
`metadataCache`. The route does not parse markdown itself and does not run
Dataview.

Auth is the Local REST bearer token. The path has a trailing slash.
A missing bearer is `401` from Local REST, before this handler runs.

Recursion lives here. Neither JsonLogic nor DQL can walk a link closure.

## Request

```json
{
  "scope": "Notes/",
  "id_field": "id",
  "edges": [
    { "source": "depends_on" },
    { "source": "$body", "sections": ["Definition of Done", "Definition"] }
  ],
  "start": ["alpha"],
  "direction": "in",
  "max_depth": null,
  "include": ["status", "kind", "$path"],
  "limit_nodes": 2000,
  "limit_edges": 20000,
  "timeout_ms": 5000
}
```

| Field | Default | Rule |
|-------|---------|------|
| `scope` | `""` (whole vault) | String. A trailing slash matches descendants only. `Notes` also matches `Notes/a.md`. Trimmed before the index lookup |
| `id_field` | — | Required non-empty string. `400` `` `id_field` must be a non-empty string `` |
| `edges` | — | Required non-empty list. See below |
| `start` | omit | Ids or paths. Omit or `null` to export the scope. `[]` is `400` |
| `direction` | — | Required. `out`, `in`, or `both`. Anything else, including omission, is `400` `direction must be one of: out, in, both` |
| `max_depth` | `null` | Non-negative integer, or `null` / omit for no depth cap. `0` is the start nodes only |
| `include` | `[]` | Field names to project. Duplicates are ignored. Empty strings are `400` |
| `limit_nodes` | `2000` | Positive integer, clamped to **10000** |
| `limit_edges` | `20000` | Positive integer, clamped to **100000** |
| `timeout_ms` | `5000` | Positive integer, clamped to **30000** |

A non-object body is `400` `Request body must be a JSON object`.
A cap that is missing, `null` is the default. A cap that is not a positive
integer is `400` `` `<field>` must be a positive integer ``.

`direction` has no HTTP default. Callers that want outgoing edges must send
`"out"`.

### `edges[]`

| Field | Rule |
|-------|------|
| `source` | Required non-empty string. A frontmatter field name, or the reserved source `$body` |
| `sections` | `$body` only. Optional list of heading strings. A link is kept when its nearest heading or any ancestor heading is in the list. Omit or `[]` to keep every section |
| `embeds` | `$body` only. Optional boolean. `true` also indexes `CachedMetadata.embeds` |

`$body` edges come from the metadata cache, not from a markdown scan. The
recorded `section` is the nearest preceding heading, or `null` when the link
sits above the first heading.

Frontmatter edge values may be a scalar or a list of bare ids, wikilinks, or
paths. Resolution tries the `id_field` index, then link resolution.

### Reserved names

These three names are not frontmatter keys. In `include` they win over a
frontmatter field of the same name.

| Name | In `edges[].source` | In `include` |
|------|---------------------|--------------|
| `$body` | Wikilinks (and embeds when asked) from the note body | Note body with YAML frontmatter removed. Longer than 100000 characters is sliced and `truncated` is set. Unreadable notes are `null` |
| `$path` | Not an edge source | Vault path of the node. Does not read the file |
| `$mtime` | Not an edge source | `file.stat.mtime` in milliseconds, or `null` |

Putting `$body` in `include` on a start-less export returns every note body
in scope. Prefer `status` and `$path` unless the body is required.

## Response

`200` JSON.

```json
{
  "nodes": [
    {
      "id": "beta",
      "path": "Notes/beta.md",
      "depth": 1,
      "fields": { "status": "ready", "kind": "note", "$path": "Notes/beta.md" }
    }
  ],
  "edges": [
    { "from": "beta", "to": "alpha", "source": "depends_on" }
  ],
  "unresolved": [
    { "from": "beta", "value": "missing", "source": "depends_on" }
  ],
  "conflicts": [
    { "id": "shared", "paths": ["Notes/a.md", "Notes/b.md"] }
  ],
  "cycles": [["alpha", "beta"]],
  "truncated": false,
  "index_ready": true
}
```

| Field | Meaning |
|-------|---------|
| `nodes` | One object per selected note. `id` is the `id_field` scalar when that note owns it, otherwise the vault path. `depth` is `0` for start nodes and for every node in a start-less export |
| `edges` | Stored edges whose endpoints are both selected. `$body` edges include `section` (`string` or `null`). Frontmatter edges omit `section` |
| `unresolved` | Edge values that did not resolve, limited to selected sources. `$body` entries include `section` |
| `conflicts` | Ids claimed by more than one note, when one of those notes is selected. `paths` is sorted. The lexicographically first path owns the id; the others use their path as `id` |
| `cycles` | Strongly connected components of more than one id, using stored edge direction. A one-way link is not a cycle. `direction: "both"` changes which nodes are reached; it does not reverse stored edges for this list. Each component is sorted; the list of components is sorted |
| `truncated` | `true` when the node cap, the edge cap, or the deadline dropped work |
| `index_ready` | Whether the metadata cache looks settled. See below |

Order is stable:

- Nodes: `depth`, then `id`, then `path`
- Edges: `from`, `to`, `source`, then `section` (missing, then `null`, then text)

A start-less request exports the scope at depth `0`, then notes outside the
scope that an in-scope edge points at, until `limit_nodes`. Out-of-scope
notes are not a separate walk.

Unknown `start` values are `400` `Unknown start: <tokens>`.
A scope with no in-scope notes is `400` `scope has no notes`.

A deadline does **not** return `408`. The handler returns `200` with
`truncated: true` and the nodes reached so far. A note that was not read in
time has `null` include fields, except `$path`.

## `index_ready`

`true` when the metadata cache object exists, does not report
`initialized === false`, and its in-progress task count or pending queue,
when readable, is `0`.

This flag does not consult the Dataview index. `false` means the cache may
still be catching up after a filesystem write. The route still returns `200`.

## Other statuses

| Status | When |
|--------|------|
| `400` | Validation messages above, or a graph-index message that starts with `Graph ` (bad scope, id field, or edge list) |
| `401` | Local REST, missing or bad bearer |
| `500` | Unexpected throw. The message is the error text |

There is no `503` on this route. Error bodies are whatever Local REST's
error helper writes for that status and message.

## Smoke

Requires Local REST and `OBSIDIAN_API_KEY`:

```bash
./scripts/smoke_graph.sh
```

`GRAPH_BASE` overrides the default `https://127.0.0.1:27124`.
