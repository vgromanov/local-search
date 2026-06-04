# Local Smart Lookup

Local Smart Lookup is a small Obsidian plugin prototype for question-first semantic search over a vault.

It is inspired by Smart Lookup's useful boundary:

- Ask a plain-language question.
- Retrieve candidates by meaning, not exact text.
- Preview the best matches before trusting them.

This implementation is intentionally local-first:

- Embeddings are requested from a local oMLX/OpenAI-compatible model server.
- Vectors are stored locally in the vault plugin folder.
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
  "dataviewQuery": "LIST FROM #research WHERE status = \"active\""
}
```

## Development

```bash
npm install
npm run build
```

Copy or symlink `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/local-smart-lookup/
```
