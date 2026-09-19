#!/bin/bash
# Fetch every Actions workflow run for dork-labs/dorkos created 2026-08-20..2026-09-19,
# one day at a time (the runs endpoint caps any single filtered query at 1000 results).
# Output: runs/<day>.json (array of trimmed run objects) and runs_all.json (merged).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p runs
d=2026-08-20
while [[ "$d" < "2026-09-20" ]]; do
  if [[ ! -s runs/$d.json || "$d" == "2026-09-19" ]]; then
    gh api --paginate "repos/dork-labs/dorkos/actions/runs?created=$d&per_page=100" \
      --jq '.workflow_runs[] | {id, name, path, event, status, conclusion, created_at, run_started_at, updated_at, run_attempt, head_branch, head_sha, run_number, pull_requests: [.pull_requests[].number]}' \
      | jq -s . > runs/$d.json
    echo "$d $(jq length runs/$d.json)"
  fi
  d=$(date -j -v+1d -f %Y-%m-%d "$d" +%Y-%m-%d)
done
jq -s 'add' runs/*.json > runs_all.json
jq length runs_all.json
