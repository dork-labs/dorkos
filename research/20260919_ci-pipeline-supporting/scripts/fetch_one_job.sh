#!/bin/bash
# Fetch job + step timings for one run id into jobs/<id>.json.
id=$1; cd "$(dirname "$0")"
gh api "repos/dork-labs/dorkos/actions/runs/$id/jobs?per_page=100&filter=all" --jq "{run_id: $id, jobs: [.jobs[] | {id, name, status, conclusion, created_at, started_at, completed_at, run_attempt, runner_name, labels, steps: [.steps[]? | {name, conclusion, started_at, completed_at}]}]}" > jobs/$id.json 2>/dev/null || rm -f jobs/$id.json
