#!/usr/bin/env bash
# Smoke POST /graph/traverse/ against a live Local REST API + Local Smart Lookup.
# Requires: OBSIDIAN_API_KEY, curl, python3
# Optional:
#   GRAPH_SCOPE          shape-check prefix (default Projects/)
#   GRAPH_START          id or path; dependents walk (direction in). Unset skips.
#   GRAPH_EXPORT_SCOPE   prefix for one start-less export. Unset skips.
# GRAPH_BASE overrides the default https://127.0.0.1:27124 (SI_BASE is also honored).
set -euo pipefail

BASE="${GRAPH_BASE:-${SI_BASE:-https://127.0.0.1:27124}}"
AUTH_HEADER="Authorization: Bearer ${OBSIDIAN_API_KEY:?OBSIDIAN_API_KEY is required}"
SCOPE="${GRAPH_SCOPE:-Projects/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1 — $2"; fail=$((fail + 1)); }

curl_json() {
  local path="$1" out="$2" body="$3"
  curl -sk --max-time 90 -o "$out" -w "%{http_code}" -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" -d @"$body" "$BASE$path"
}

echo "Graph smoke against $BASE"

# --- unauth ---
unauth=$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"id_field":"id","edges":[{"source":"depends_on"}],"direction":"out"}' \
  "$BASE/graph/traverse/" || true)
if [[ "$unauth" == "401" ]]; then
  ok "auth rejects unauthenticated POST /graph/traverse/"
else
  bad "auth" "expected 401 got $unauth"
fi

# --- shape on a small scope ---
python3 - "$SCOPE" > "$TMP/shape_req.json" <<'PY'
import json, sys
print(json.dumps({
  "scope": sys.argv[1],
  "id_field": "id",
  "edges": [{"source": "related_projects"}],
  "direction": "out",
  "include": ["status", "$path"],
  "limit_nodes": 20,
}))
PY
code=$(curl_json /graph/traverse/ "$TMP/shape.json" "$TMP/shape_req.json")
if [[ "$code" == "200" ]] && python3 -c '
import json
d=json.load(open("'"$TMP"'/shape.json"))
for key in ("nodes", "edges", "unresolved", "conflicts", "cycles", "truncated", "index_ready"):
    assert key in d, key
assert isinstance(d["truncated"], bool)
assert isinstance(d["index_ready"], bool)
assert d["nodes"], "expected at least one node"
node=d["nodes"][0]
assert "id" in node and "path" in node and isinstance(node["depth"], int)
assert "$path" in node.get("fields", {})
'; then
  ok "POST /graph/traverse/ shape"
else
  bad "shape" "http=$code body=$(head -c 240 "$TMP/shape.json" 2>/dev/null || true)"
fi

# --- optional: dependents of GRAPH_START (direction in, with depth) ---
if [[ -n "${GRAPH_START:-}" ]]; then
  python3 - "${GRAPH_EXPORT_SCOPE:-$SCOPE}" "$GRAPH_START" > "$TMP/dep_req.json" <<'PY'
import json, sys
print(json.dumps({
  "scope": sys.argv[1],
  "id_field": "id",
  "edges": [{"source": "depends_on"}],
  "start": [sys.argv[2]],
  "direction": "in",
  "include": ["status"],
  "max_depth": None,
}))
PY
  code=$(curl_json /graph/traverse/ "$TMP/dep.json" "$TMP/dep_req.json")
  if [[ "$code" == "200" ]] && python3 -c '
import json
d=json.load(open("'"$TMP"'/dep.json"))
assert d["nodes"], "expected the start node"
assert all(isinstance(n.get("depth"), int) for n in d["nodes"])
assert isinstance(d["edges"], list)
assert isinstance(d["index_ready"], bool)
'; then
    ok "GRAPH_START dependents"
  else
    bad "GRAPH_START dependents" "http=$code body=$(head -c 300 "$TMP/dep.json" 2>/dev/null || true)"
  fi
else
  echo "SKIP  GRAPH_START (unset)"
fi

# --- optional: one-request scope export, including a sectioned $body edge ---
if [[ -n "${GRAPH_EXPORT_SCOPE:-}" ]]; then
  python3 - "$GRAPH_EXPORT_SCOPE" > "$TMP/whole_req.json" <<'PY'
import json, sys
print(json.dumps({
  "scope": sys.argv[1],
  "id_field": "id",
  "edges": [
    {"source": "depends_on"},
    {"source": "$body", "sections": ["Definition of Done", "Definition"]},
  ],
  "direction": "out",
  "include": ["status"],
}))
PY
  code=$(curl_json /graph/traverse/ "$TMP/whole.json" "$TMP/whole_req.json")
  if [[ "$code" == "200" ]] && python3 -c '
import json
d=json.load(open("'"$TMP"'/whole.json"))
assert d["nodes"], "expected a scope export"
assert isinstance(d["edges"], list)
assert isinstance(d["truncated"], bool)
assert isinstance(d["index_ready"], bool)
assert all(n.get("depth") == 0 for n in d["nodes"])
'; then
    ok "GRAPH_EXPORT_SCOPE"
  else
    bad "GRAPH_EXPORT_SCOPE" "http=$code body=$(head -c 300 "$TMP/whole.json" 2>/dev/null || true)"
  fi
else
  echo "SKIP  GRAPH_EXPORT_SCOPE (unset)"
fi

# --- rejections ---
python3 - <<'PY' > "$TMP/dir_req.json"
import json
print(json.dumps({
  "scope": "Projects/",
  "id_field": "id",
  "edges": [{"source": "depends_on"}],
  "direction": "sideways",
}))
PY
code=$(curl_json /graph/traverse/ "$TMP/dir.json" "$TMP/dir_req.json")
if [[ "$code" == "400" ]]; then
  ok "bad direction → 400"
else
  bad "bad direction" "http=$code"
fi

python3 - <<'PY' > "$TMP/edges_req.json"
import json
print(json.dumps({
  "scope": "Projects/",
  "id_field": "id",
  "edges": [],
  "direction": "out",
}))
PY
code=$(curl_json /graph/traverse/ "$TMP/edges.json" "$TMP/edges_req.json")
if [[ "$code" == "400" ]]; then
  ok "empty edges → 400"
else
  bad "empty edges" "http=$code"
fi

echo
echo "Results: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
