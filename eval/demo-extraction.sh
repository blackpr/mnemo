#!/usr/bin/env bash
# End-to-end demo: retain a few Subject turns into bank-demo, let the extraction worker run,
# then show the facts, a recall, a point-in-time recall and the per-episode cost ledger.
# Requires: server running (npm start), .demo-key holding the token printed by `admin issue-key`
# (chmod 600), docker container mem-db for the SQL views.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
BASE="http://localhost:$PORT/v1/banks/bank-demo"
KEY="$(cat .demo-key)"
auth=(-H "authorization: Bearer $KEY" -H "content-type: application/json")

retain() { # $1 = occurredAt, $2 = text, $3 = role (default user)
  curl -s -X POST "$BASE/episodes" "${auth[@]}" \
    -d "$(jq -cn --arg t "$2" --arg at "$1" --arg role "${3:-user}" '{source:"claude-code", role:$role, text:$t, occurredAt:$at}')" | jq -r .episodeId
}

echo "== retaining episodes =="
retain "2026-01-10T09:00:00Z" "Hi! I'm Vangelis. I live in Berlin and I mostly code in TypeScript. My editor is VS Code."
retain "2026-01-10T09:00:30Z" "Nice to meet you. What are you working on?" assistant
retain "2026-01-10T09:01:00Z" "A self-hosted memory layer for AI assistants, it's called mem. Postgres with pgvector underneath. I hate monorepos, so it is one package."
retain "2026-03-02T18:00:00Z" "I switched to neovim last week, VS Code felt slow on the big repo."
retain "2026-06-15T10:00:00Z" "Big news: I moved to Lisbon in June. Berlin winters were too much. Also my API key is sk-ant-api03-THIS-SHOULD-NEVER-BE-STORED-1234567890"
retain "2026-06-15T10:00:20Z" "Congrats on the move! Lisbon is great in summer." assistant

echo
echo "== waiting for the extraction worker (6 episodes) =="
for i in $(seq 1 120); do
  status="$(docker exec mem-db psql -U mem -d mem -tAc "select coalesce(string_agg(status||':'||n, ' '),'') from (select status, count(*) n from extraction.runs group by status) s")"
  settled="$(docker exec mem-db psql -U mem -d mem -tAc "select count(*) from extraction.runs where status in ('done','skipped','dead')")"
  printf "\r  runs: %-60s" "$status"
  [ "$settled" = "6" ] && break
  sleep 2
done
echo
sleep 2  # let the relay index the facts the extraction produced

echo
echo "== extraction.runs (cost ledger) =="
docker exec mem-db psql -U mem -d mem -c "select left(episode_id,8) ep, status, reason, attempts, input_tokens, output_tokens, latency_ms, candidates, asserted, superseded, invalidated, historical, rejected, left(error,60) error from extraction.runs order by claimed_at"

echo "== current facts =="
curl -s "$BASE/facts" "${auth[@]}" | jq -r '(.facts // ("error: " + tostring | error)) | .[] | "- \(.statement)  [since \(.validity.validFrom[:10]) · \(.provenance.confirmation) · faithfulness \(.provenance.faithfulness)]"'

echo
echo "== all facts incl. history (SQL) =="
docker exec mem-db psql -U mem -d mem -c "select left(id,8) id, statement, valid_from::date, valid_to::date, retracted_at is not null as retracted, left(supersedes_id,8) supersedes, invalidation->>'reason' reason from memory.facts order by valid_from, recorded_at"

echo "== recall: where does the user live? (now) =="
curl -s -X POST "$BASE/recall" "${auth[@]}" -d '{"query":"where does the user live","limit":3}' | jq -r '(.facts // ("error: " + tostring | error)) | .[] | "- \(.statement)  (score \(.score|tostring|.[0:5]))"'
echo "== recall: where did the user live as of 2026-02-01? =="
curl -s -X POST "$BASE/recall" "${auth[@]}" -d '{"query":"where does the user live","limit":3,"asOf":"2026-02-01T00:00:00Z"}' | jq -r '(.facts // ("error: " + tostring | error)) | .[] | "- \(.statement)"'
echo "== recall: which editor? =="
curl -s -X POST "$BASE/recall" "${auth[@]}" -d '{"query":"which editor does the user use","limit":3}' | jq -r '(.facts // ("error: " + tostring | error)) | .[] | "- \(.statement)"'

echo
echo "== audit trail (actions only) =="
docker exec mem-db psql -U mem -d mem -tAc "select action || ' x' || count(*) from governance.audit_log group by action order by min(seq)"
