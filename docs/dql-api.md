# Dataview DQL (`POST /dataview/query/`)

Read-only Dataview query route on Local Smart Lookup. It runs Dataview
`api.query` and returns JSON. It does not run DataviewJS, inline JavaScript,
or `api.pages()`.

Auth is the Local REST bearer token. The path has a trailing slash.
A missing bearer is `401` from Local REST, before this handler runs.

`search_vault_local` `dataviewQuery` is a different feature: it only narrows
which notes semantic search may return. This route returns the DQL result.

## Request

```json
{
  "query": "TABLE status, owner FROM \"Projects\" WHERE status = \"active\"",
  "limit": 500,
  "timeout_ms": 5000
}
```

| Field | Default | Rule |
|-------|---------|------|
| `query` | — | Required string. Blank is `400` `` `query` must be a string `` |
| `limit` | `500` | Positive number, then floored. Clamped to the plugin setting `dataviewQueryMaxRows` (default cap **5000**). `0`, negative, or non-finite is `400` `` `limit` must be a positive number `` |
| `timeout_ms` | `5000` | Same clamping against `dataviewQueryMaxTimeoutMs` (default cap **30000**). Invalid values are `400` `` `timeout_ms` must be a positive number `` |

A non-object body is `400` `` `query` must be a string ``.

### Queries that are accepted

`TABLE`, `LIST`, and `TASK`, including `GROUP BY` and `SORT`. Quoted strings
and `//` line comments are ignored by the syntax check. The query sent to
Dataview is unchanged.

### Queries that are rejected (`400`)

| Message | When |
|---------|------|
| `Only TABLE, LIST, and TASK queries are supported` | The query does not start with one of those keywords |
| `CALENDAR queries are not supported` | `CALENDAR`, or a result whose type is `calendar` |
| `dataviewjs is not supported` | The word `dataviewjs` outside a quoted string or `//` comment |
| `Inline JavaScript ($=) is not supported` | `$=` outside a quoted string or comment |
| `JavaScript expressions are not supported` | A `function` keyword used as a call, or `=>` |

Dataview parse failures are also `400`. The message is Dataview's error
string, including the parser position when Dataview provides one.

## Response

`200` JSON. `truncated` is `true` when the row cap drops at least one leaf.
`index_ready` is a boolean on every success.

### `TABLE`

```json
{
  "type": "table",
  "headers": ["File", "status", "owner"],
  "rows": [
    { "file": "Projects/example.md", "status": "active", "owner": "owner" }
  ],
  "truncated": false,
  "index_ready": true
}
```

The file column is the object key `file` and the value is a vault path.
Other headers keep their query names. A repeated header becomes `name`,
`name_2`, `name_3`.

### `LIST`

```json
{
  "type": "list",
  "items": ["Projects/example.md"],
  "truncated": false,
  "index_ready": true
}
```

A `LIST` of pairs is `{ "key", "value" }` objects.

### `TASK`

```json
{
  "type": "task",
  "tasks": [
    {
      "path": "Projects/example.md",
      "line": 12,
      "text": "Record the result",
      "completed": false,
      "status": " ",
      "section": "Definition of Done"
    }
  ],
  "truncated": false,
  "index_ready": true
}
```

`section` is omitted when the task has none. `line` is 0-based as Dataview
reports it.

### `GROUP BY`

Grouped rows, items, and tasks are nested:

```json
{ "key": "active", "rows": [ { "file": "Projects/example.md", "status": "active" } ] }
```

The leaf cap applies to leaves inside groups. An emptied group is dropped
and `truncated` is `true`.

### Ordering

Without `SORT`, leaves and groups are ordered by vault path ascending
(a group's path is its smallest child path). With `SORT`, Dataview's order
is kept.

### Values

| Dataview value | JSON |
|----------------|------|
| Link | Vault path string |
| Date or duration | ISO-8601 string |
| Null or missing | `null` |
| Non-finite number | `null` |

Dataview also exposes a lowercased copy of each frontmatter key. That
duplicate is not emitted. The original key is kept. Strings longer than
100000 characters are sliced. Nesting deeper than 32 becomes `null`. Those
serializer cuts do **not** set `truncated`. `truncated` means the row cap
only.

The route never reads a DataArray `.value`. Lists are materialized with
`.array()`.

## `index_ready`

`true` only when all of the following hold:

- Dataview's index reports `initialized === true`
- The Obsidian metadata cache object exists
- That cache does not report `initialized === false`
- The cache's in-progress task count or pending queue, when readable, is `0`

`false` means a read can be stale, especially right after a filesystem write.
The route still returns `200`. It does not wait for the index.

## Other statuses

| Status | Message |
|--------|---------|
| `401` | Local REST, missing or bad bearer |
| `408` | `Dataview query timed out` (the route's `timeout_ms` deadline) |
| `500` | `Dataview query failed`, or the thrown error message |
| `503` | `Dataview plugin is not available` |

Error bodies are whatever Local REST's error helper writes for that status
and message. They are not the success shape above.

## Smoke

Requires Local REST and `OBSIDIAN_API_KEY`:

```bash
./scripts/smoke_dql.sh
```

`DQL_BASE` overrides the default `https://127.0.0.1:27124`.
