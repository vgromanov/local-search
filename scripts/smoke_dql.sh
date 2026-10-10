#!/usr/bin/env bash
# Smoke POST /dataview/query/ against a live Local REST API + Local Smart Lookup.
# Requires: OBSIDIAN_API_KEY, curl, python3
# Optional: DQL_REFERENCE_QUERY (full DQL string). Unset skips that check.
# DQL_BASE overrides the default https://127.0.0.1:27124 (SI_BASE is also honored).
set -euo pipefail

BASE="${DQL_BASE:-${SI_BASE:-https://127.0.0.1:27124}}"
AUTH_HEADER="Authorization: Bearer ${OBSIDIAN_API_KEY:?OBSIDIAN_API_KEY is required}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1 — $2"; fail=$((fail + 1)); }

curl_json() {
  local method="$1" path="$2" out="$3"
  shift 3
  local code
  if [[ "$method" == "GET" ]]; then
    code=$(curl -sk --max-time 60 -o "$out" -w "%{http_code}" -H "$AUTH_HEADER" "$BASE$path")
  else
    code=$(curl -sk --max-time 60 -o "$out" -w "%{http_code}" -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" -d @"$1" "$BASE$path")
  fi
  echo "$code"
}

echo "DQL smoke against $BASE"

# --- unauth ---
unauth=$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" -d '{"query":"LIST FROM \"Projects\""}' \
  "$BASE/dataview/query/" || true)
if [[ "$unauth" == "401" ]]; then
  ok "auth rejects unauthenticated POST /dataview/query/"
else
  bad "auth" "expected 401 got $unauth"
fi

# --- shape ---
python3 - <<'PY' > "$TMP/list_req.json"
import json
print(json.dumps({"query": "LIST FROM \"Projects\"", "limit": 5}))
PY
code=$(curl_json POST /dataview/query/ "$TMP/list.json" "$TMP/list_req.json")
if [[ "$code" == "200" ]] && python3 -c '
import json
d=json.load(open("'"$TMP"'/list.json"))
assert d.get("type") == "list", d.get("type")
assert isinstance(d.get("items"), list)
assert isinstance(d.get("truncated"), bool)
assert isinstance(d.get("index_ready"), bool)
'; then
  ok "POST /dataview/query/ LIST shape"
else
  bad "LIST shape" "http=$code body=$(head -c 200 "$TMP/list.json" 2>/dev/null || true)"
fi

# --- optional acceptance query (set DQL_REFERENCE_QUERY to run it) ---
if [[ -n "${DQL_REFERENCE_QUERY:-}" ]]; then
  python3 - "$DQL_REFERENCE_QUERY" > "$TMP/ref_req.json" <<'PY'
import json, sys
print(json.dumps({"query": sys.argv[1], "limit": 50}))
PY
  code=$(curl_json POST /dataview/query/ "$TMP/ref.json" "$TMP/ref_req.json")
  if [[ "$code" == "200" ]] && python3 -c '
import json
d=json.load(open("'"$TMP"'/ref.json"))
assert d.get("type") in ("table", "list", "task")
assert isinstance(d.get("truncated"), bool)
assert isinstance(d.get("index_ready"), bool)
'; then
    ok "DQL_REFERENCE_QUERY"
  else
    bad "DQL_REFERENCE_QUERY" "http=$code body=$(head -c 300 "$TMP/ref.json" 2>/dev/null || true)"
  fi
else
  echo "SKIP  DQL_REFERENCE_QUERY (unset)"
fi

# --- rejections ---
python3 - <<'PY' > "$TMP/js_req.json"
import json
print(json.dumps({"query": "TABLE x FROM \"Projects\" WHERE dataviewjs"}))
PY
code=$(curl_json POST /dataview/query/ "$TMP/js.json" "$TMP/js_req.json")
if [[ "$code" == "400" ]]; then
  ok "dataviewjs → 400"
else
  bad "dataviewjs" "http=$code"
fi

python3 - <<'PY' > "$TMP/cal_req.json"
import json
print(json.dumps({"query": "CALENDAR file.mtime FROM \"Projects\""}))
PY
code=$(curl_json POST /dataview/query/ "$TMP/cal.json" "$TMP/cal_req.json")
if [[ "$code" == "400" ]]; then
  ok "CALENDAR → 400"
else
  bad "CALENDAR" "http=$code"
fi

python3 - <<'PY' > "$TMP/empty_req.json"
import json
print(json.dumps({"query": "   "}))
PY
code=$(curl_json POST /dataview/query/ "$TMP/empty.json" "$TMP/empty_req.json")
if [[ "$code" == "400" ]]; then
  ok "blank query → 400"
else
  bad "blank query" "http=$code"
fi

python3 - <<'PY' > "$TMP/limit_req.json"
import json
print(json.dumps({"query": "LIST FROM \"Projects\"", "limit": 0}))
PY
code=$(curl_json POST /dataview/query/ "$TMP/limit.json" "$TMP/limit_req.json")
if [[ "$code" == "400" ]]; then
  ok "limit 0 → 400"
else
  bad "limit 0" "http=$code"
fi

echo
echo "Results: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
