#!/bin/bash
# Re-fetch days whose per-day query hit the 1000-result cap, in 2-hour windows.
set -euo pipefail
cd "$(dirname "$0")"
for f in runs/*.json; do
  d=$(basename $f .json)
  [[ $(jq length $f) -ge 1000 ]] || continue
  : > runs/$d.parts
  for h in 00 02 04 06 08 10 12 14 16 18 20 22; do
    e=$(printf %02d $((10#$h+1)))
    q="$d""T$h:00:00Z..$d""T$e:59:59Z"
    gh api --paginate "repos/dork-labs/dorkos/actions/runs?created=$q&per_page=100" \
      --jq '.workflow_runs[] | {id, name, path, event, status, conclusion, created_at, run_started_at, updated_at, run_attempt, head_branch, head_sha, run_number, pull_requests: [.pull_requests[].number]}' >> runs/$d.parts
    c=$(gh api "repos/dork-labs/dorkos/actions/runs?created=$q&per_page=1" --jq .total_count)
    [[ $c -ge 1000 ]] && echo "WARN $q still capped $c"
  done
  jq -s 'unique_by(.id)' runs/$d.parts > runs/$d.json && rm runs/$d.parts
  echo "$d $(jq length runs/$d.json)"
done
jq -s 'add | unique_by(.id)' runs/*.json > runs_all.json
jq length runs_all.json
