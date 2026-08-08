#!/usr/bin/env bash
# Smoke frontmatter_keys routes against a live Local REST API + Local Smart Lookup.
# Requires: OBSIDIAN_API_KEY, curl, python3
set -euo pipefail

BASE="${SI_BASE:-https://127.0.0.1:27124}"
AUTH_HEADER="Authorization: Bearer ${OBSIDIAN_API_KEY:?OBSIDIAN_API_KEY is required}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1 — $2"; fail=$((fail + 1)); }

curl_json() {
  local method="$1" path="$2" out="$3"
  local code
  if [[ "$method" == "GET" ]]; then
    code=$(curl -sk --max-time 60 -o "$out" -w "%{http_code}" -H "$AUTH_HEADER" "$BASE$path")
  else
    code=$(curl -sk --max-time 60 -o "$out" -w "%{http_code}" -H "$AUTH_HEADER" "$BASE$path")
  fi
  echo "$code"
}

echo "frontmatter_keys smoke against $BASE"

code=$(curl_json GET /frontmatter_keys/ "$TMP/keys.json")
if [[ "$code" == "200" ]] && python3 -c '
import json
d=json.load(open("'"$TMP"'/keys.json"))
assert isinstance(d, list)
if d:
  assert "name" in d[0] and "count" in d[0] and "type" in d[0]
  counts=[x["count"] for x in d]
  assert counts == sorted(counts, reverse=True)
'; then
  ok "GET /frontmatter_keys/"
else
  bad "GET /frontmatter_keys/" "http=$code body=$(head -c 200 "$TMP/keys.json")"
fi

unauth=$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/frontmatter_keys/" || true)
if [[ "$unauth" == "401" ]]; then
  ok "auth rejects unauthenticated /frontmatter_keys/"
else
  bad "auth" "expected 401 got $unauth"
fi

# Prefer a real key from inventory when present; else probe unknown → [].
probe_key=$(python3 -c '
import json
d=json.load(open("'"$TMP"'/keys.json"))
print(d[0]["name"] if d else "___missing_key_rvg76___")
')
encoded=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$probe_key")
code=$(curl_json GET "/frontmatter_keys/${encoded}/" "$TMP/files.json")
if [[ "$code" == "200" ]] && python3 -c '
import json,sys
key=sys.argv[1]
d=json.load(open("'"$TMP"'/files.json"))
assert isinstance(d, list)
if key != "___missing_key_rvg76___":
  assert all("filename" in x for x in d)
  assert len(d) >= 1
else:
  assert d == []
' "$probe_key"; then
  ok "GET /frontmatter_keys/{name}/"
else
  bad "GET /frontmatter_keys/{name}/" "http=$code key=$probe_key body=$(head -c 200 "$TMP/files.json")"
fi

# Explicit unknown key → empty list (not 404)
code=$(curl_json GET "/frontmatter_keys/___definitely_unused_rvg76___/" "$TMP/empty.json")
if [[ "$code" == "200" ]] && python3 -c 'import json; assert json.load(open("'"$TMP"'/empty.json")) == []'; then
  ok "unknown key returns []"
else
  bad "unknown key" "http=$code body=$(head -c 200 "$TMP/empty.json")"
fi

echo
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
