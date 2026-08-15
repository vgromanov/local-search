# AGENTS.md — Local Smart Lookup (`llm-search` / `local-search`)

## After building or updating this plugin

Obsidian loads `main.js` from the vault plugin folder. A TypeScript rebuild does
**not** apply until the plugin (or app) is reloaded.

For Obsidian to pick up the updated plugin, trigger reload via the Obsidian MCP /
Local REST API **command interface**:

| | |
|---|---|
| **MCP server** | `user-obsidian-mcp` (also exposed as `plugin-grok-memory-grok-memory` / Plane A) |
| **Tool** | `execute_command` |
| **Command id** | `app:reload` (`Reload app without saving`) |
| **When** | After `npm run build` (or copying `main.js` into the vault plugin dir) so live `search_vault_local` / UI search use the new code |

Example MCP call:

```json
{ "commandId": "app:reload" }
```

Then re-run smoke searches. Do **not** assume a rebuild alone refreshed the
running plugin.

## Dataview path filters

- Prefer `dataviewQuery` (full `LIST` / `TABLE` / `TASK` / `CALENDAR`).
- `dataviewSource` is a **backward-compatible alias**: bare sources are wrapped as
  `LIST FROM <source>` and executed via Dataview **`api.query`**.
- **Never** walk Dataview `api.pages()` DataArrays for path extraction — DataArray
  Proxies auto-flatten via `.to(prop)` and following `.value` stack-overflows.
  Path extraction must prefer `.file.path` / Link `.path` and must not follow
  DataArray `.value`.

## Tests

```bash
npm test
npm run build
```
