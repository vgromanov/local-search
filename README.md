# Local Smart Lookup

Local Smart Lookup is a small Obsidian plugin prototype for question-first semantic search over a vault.

It is inspired by Smart Lookup's useful boundary:

- Ask a plain-language question.
- Retrieve candidates by meaning, not exact text.
- Preview the best matches before trusting them.

This implementation is intentionally local-first:

- Embeddings are requested from a local oMLX/OpenAI-compatible model server.
- Vectors and metadata are stored locally with embedded LanceDB in the vault plugin folder.
- Optional reranking can call a local rerank endpoint.
- Dataview can narrow the searchable path set before semantic ranking.
- If the REST API plugin is installed, this plugin registers extension routes.

## Expected local model server

By default the plugin calls:

- `POST http://127.0.0.1:11434/v1/embeddings`
- model: `nomic-embed-text`

The request follows OpenAI-compatible embedding shape:

```json
{
  "model": "nomic-embed-text",
  "input": ["text to embed"]
}
```

For reranking, configure a local endpoint that accepts:

```json
{
  "model": "your-reranker",
  "query": "question",
  "documents": ["candidate text"]
}
```

and returns either `results: [{ index, relevance_score }]` or an array of scored results.

## Index storage

The local index lives at:

```text
<vault>/.obsidian/plugins/local-smart-lookup/lancedb/
```

Each chunk row stores:

- embedding vector
- note path, folder, basename, mtime, and size
- full content hash, body hash, frontmatter hash, chunking config hash
- embedding model and embedding dimension
- frontmatter JSON plus common scalar fields: `title`, `status`, `project`, `type`
- frontmatter tags and inline tags

This lets the plugin make predictable reindex decisions:

- unchanged content is skipped
- frontmatter-only edits update metadata without re-embedding
- body, chunking, or embedding-model changes re-embed
- rename/move events update path metadata first, then verify whether content also changed

## Index queue

Indexing work is persisted at:

```text
<vault>/.obsidian/plugins/local-smart-lookup/index-queue.json
```

The queue is deduplicated by note path. If the same note changes several times while sync or editing is still active, only the latest queued version is processed. The queue is processed sequentially and resumes automatically after Obsidian restarts.

Full vault indexing now queues every markdown file instead of running one foreground batch. If the local embedding server is unavailable, the queue pauses on the failed file and retries after a delay.

## REST routes

When the REST API plugin with extension support is enabled, routes are registered under:

- `POST /local-smart-lookup/search/`
- `POST /local-smart-lookup/reindex/`
- `GET /local-smart-lookup/status/`

Search body:

```json
{
  "query": "local-first AI and user control strongest arguments",
  "limit": 10,
  "dataviewSource": "#research or \"Projects\"",
  "dataviewQuery": "LIST FROM #research WHERE status = \"active\"",
  "tags": ["research", "ai"],
  "frontmatter": {
    "status": "active",
    "project": "Local Search"
  },
  "where": "type = 'note'"
}
```

`tags`, `frontmatter`, and `where` are applied through LanceDB metadata filtering. Dataview remains optional for richer vault-specific filters.

## Development

```bash
npm install
npm run build
```

For development, symlink the whole repository into:

```text
<vault>/.obsidian/plugins/local-smart-lookup/
```

or copy `main.js`, `manifest.json`, `styles.css`, `package.json`, and `package-lock.json` there and run:

```bash
npm install --omit=dev
```

LanceDB is loaded from the plugin folder's local `node_modules`, so the runtime dependency must exist at:

```text
<vault>/.obsidian/plugins/local-smart-lookup/node_modules/@lancedb/lancedb/
```
