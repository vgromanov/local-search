#!/usr/bin/env bash
# Smoke all Semantic Index (/si/*) endpoints against a live Local REST API.
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
  shift 3
  local code
  if [[ "$method" == "GET" ]]; then
    code=$(curl -sk --max-time 60 -o "$out" -w "%{http_code}" -H "$AUTH_HEADER" "$BASE$path")
  else
    code=$(curl -sk --max-time 180 -o "$out" -w "%{http_code}" -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" -d @"$1" "$BASE$path")
  fi
  echo "$code"
}

echo "SI smoke against $BASE"

# --- health ---
code=$(curl_json GET /si/health/ "$TMP/health.json")
if [[ "$code" == "200" ]] && python3 -c 'import json; d=json.load(open("'"$TMP"'/health.json")); assert d.get("ok") is True'; then
  ok "GET /si/health/"
else
  bad "GET /si/health/" "http=$code body=$(head -c 200 "$TMP/health.json")"
fi

# --- unauth ---
unauth=$(curl -sk --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/si/health/" || true)
if [[ "$unauth" == "401" ]]; then
  ok "auth rejects unauthenticated /si/health/"
else
  bad "auth" "expected 401 got $unauth"
fi

# --- index_info ---
code=$(curl_json GET /si/index_info/ "$TMP/index_info.json")
if [[ "$code" == "200" ]]; then
  ok "GET /si/index_info/"
else
  bad "GET /si/index_info/" "http=$code"
fi

# --- embed_text ---
python3 - <<'PY' > "$TMP/embed_req.json"
import json
print(json.dumps({"texts": ["si smoke probe phrase"], "normalize": True}))
PY
code=$(curl_json POST /si/embed_text/ "$TMP/embed.json" "$TMP/embed_req.json")
if [[ "$code" == "200" ]]; then
  python3 - <<PY
import json
ii=json.load(open("$TMP/index_info.json"))
em=json.load(open("$TMP/embed.json"))
assert em["embed_dim"] == ii["embed_dim"], (em["embed_dim"], ii["embed_dim"])
assert em["vectors"] and len(em["vectors"][0]) == ii["embed_dim"]
# determinism: second call identical
print("ok")
PY
  ok "POST /si/embed_text/ (dim matches index_info)"
else
  bad "POST /si/embed_text/" "http=$code"
fi

# embed determinism
code2=$(curl_json POST /si/embed_text/ "$TMP/embed2.json" "$TMP/embed_req.json")
if [[ "$code2" == "200" ]] && python3 -c 'import json; a=json.load(open("'"$TMP"'/embed.json")); b=json.load(open("'"$TMP"'/embed2.json")); assert a["vectors"]==b["vectors"]'; then
  ok "embed_text determinism"
else
  bad "embed_text determinism" "http=$code2"
fi

# --- query_metadata ---
python3 - <<'PY' > "$TMP/qm_req.json"
import json
print(json.dumps({"fields": ["path", "uuid", "id"], "where": "type = 'project'", "limit": 5}))
PY
code=$(curl_json POST /si/query_metadata/ "$TMP/qm.json" "$TMP/qm_req.json")
if [[ "$code" == "200" ]] && python3 -c 'import json; d=json.load(open("'"$TMP"'/qm.json")); assert "rows" in d and d["rows"]'; then
  ok "POST /si/query_metadata/"
  CHUNK=$(python3 -c 'import json; print(json.load(open("'"$TMP"'/qm.json"))["rows"][0]["id"])')
else
  bad "POST /si/query_metadata/" "http=$code"
  CHUNK=""
fi

# bad field
python3 - <<'PY' > "$TMP/qm_bad.json"
import json
print(json.dumps({"fields": ["not_a_field"], "limit": 1}))
PY
code=$(curl_json POST /si/query_metadata/ "$TMP/qm_bad_out.json" "$TMP/qm_bad.json")
if [[ "$code" == "400" ]]; then
  ok "query_metadata unknown field → 400"
else
  bad "query_metadata bad field" "http=$code"
fi

if [[ -n "$CHUNK" ]]; then
  # --- knn ---
  python3 - <<PY > "$TMP/knn_req.json"
import json
print(json.dumps({"chunk_id": "$CHUNK", "k": 10, "where": "type = 'project'"}))
PY
  code=$(curl_json POST /si/knn/ "$TMP/knn.json" "$TMP/knn_req.json")
  if [[ "$code" == "200" ]] && python3 -c '
import json
d=json.load(open("'"$TMP"'/knn.json"))
hits=d["hits"]
assert hits and hits[0]["distance"] < 1e-4
dists=[h["distance"] for h in hits]
assert dists==sorted(dists)
'; then
    ok "POST /si/knn/ (self-hit + monotonic)"
  else
    bad "POST /si/knn/" "http=$code"
  fi

  # knn determinism
  code=$(curl_json POST /si/knn/ "$TMP/knn2.json" "$TMP/knn_req.json")
  if [[ "$code" == "200" ]] && python3 -c 'import json; a=json.load(open("'"$TMP"'/knn.json")); b=json.load(open("'"$TMP"'/knn2.json")); assert a["hits"]==b["hits"]'; then
    ok "knn determinism"
  else
    bad "knn determinism" "http=$code"
  fi

  # --- count_neighbors ---
  python3 - <<PY > "$TMP/cn_req.json"
import json
print(json.dumps({
  "chunk_id": "$CHUNK",
  "threshold": 0.25,
  "group_by": "uuid",
  "where": "type = 'project'"
}))
PY
  code=$(curl_json POST /si/count_neighbors/ "$TMP/cn.json" "$TMP/cn_req.json")
  if [[ "$code" == "200" ]] && python3 -c '
import json
d=json.load(open("'"$TMP"'/cn.json"))
assert sum(d["counts"].values())==d["total_hits"]
assert d["distinct_groups"]==len(d["counts"])
'; then
    ok "POST /si/count_neighbors/"
  else
    bad "POST /si/count_neighbors/" "http=$code body=$(head -c 200 "$TMP/cn.json")"
  fi

  # exactness vs knn
  python3 - <<PY > "$TMP/knn_exact.json"
import json
print(json.dumps({
  "chunk_id": "$CHUNK",
  "k": 1000,
  "threshold": 0.25,
  "where": "type = 'project'"
}))
PY
  code=$(curl_json POST /si/knn/ "$TMP/knn_e.json" "$TMP/knn_exact.json")
  if [[ "$code" == "200" ]] && python3 -c '
import json
cn=json.load(open("'"$TMP"'/cn.json"))
knn=json.load(open("'"$TMP"'/knn_e.json"))
assert cn["total_hits"]==len(knn["hits"]), (cn["total_hits"], len(knn["hits"]))
'; then
    ok "count_neighbors exactness vs knn"
  else
    bad "count_neighbors exactness" "http=$code"
  fi
fi

# --- get_vectors paging ---
python3 - <<'PY' > "$TMP/gv1.json"
import json
print(json.dumps({"where": "type = 'project'", "limit": 40, "include_text": False}))
PY
code=$(curl_json POST /si/get_vectors/ "$TMP/gv_page1.json" "$TMP/gv1.json")
if [[ "$code" == "200" ]]; then
  python3 - <<'PY'
import json, urllib.request, ssl, os
BASE=os.environ.get("SI_BASE", "https://127.0.0.1:27124")
key=os.environ["OBSIDIAN_API_KEY"]
ctx=ssl._create_unverified_context()

def post(body):
    req=urllib.request.Request(
        BASE+"/si/get_vectors/",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, context=ctx, timeout=180) as resp:
        return json.load(resp)

ids=[]
cursor=None
while True:
    body={"where": "type = 'project'", "limit": 40}
    if cursor: body["cursor"]=cursor
    d=post(body)
    for it in d["items"]:
        ids.append(it["chunk_id"])
        assert len(it["vector"]) > 0
    cursor=d.get("next_cursor")
    if not cursor: break

assert len(ids)==len(set(ids))
# second pass identical order
ids2=[]
cursor=None
while True:
    body={"where": "type = 'project'", "limit": 40}
    if cursor: body["cursor"]=cursor
    d=post(body)
    ids2.extend(it["chunk_id"] for it in d["items"])
    cursor=d.get("next_cursor")
    if not cursor: break
assert ids==ids2
print(len(ids))
PY
  ok "POST /si/get_vectors/ (complete + stable cursor)"
else
  bad "POST /si/get_vectors/" "http=$code"
fi

# --- filter validate ---
python3 - <<'PY' > "$TMP/fv_req.json"
import json
print(json.dumps({"where": "type = 'project'", "limit": 2}))
PY
code=$(curl_json POST /si/filter/validate/ "$TMP/fv.json" "$TMP/fv_req.json")
if [[ "$code" == "200" ]]; then
  ok "POST /si/filter/validate/"
else
  bad "POST /si/filter/validate/" "http=$code"
fi

# --- search_vault_local unchanged (legacy route still up) ---
python3 - <<'PY' > "$TMP/search_req.json"
import json
print(json.dumps({"query": "local search semantic index", "limit": 3}))
PY
code=$(curl -sk --max-time 60 -o "$TMP/search.json" -w "%{http_code}" -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" -d @"$TMP/search_req.json" \
  "$BASE/local-smart-lookup/search/" || true)
if [[ "$code" == "200" ]]; then
  ok "legacy /local-smart-lookup/search/ still works"
else
  bad "legacy search" "http=$code"
fi

echo
echo "Results: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
