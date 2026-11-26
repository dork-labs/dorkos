#!/usr/bin/env bash
# attest-pr-check.sh — did this check already pass on the queue entry's PR head?
#
# --help
# Purpose: in the merge queue, say whether a check already passed on the entry's
#          PR head, so its heavy job can be skipped. Never fails.
# Runs in: the merge-group `attest` steps of `lint`, `credential-free-build`,
#          `openapi-fresh`, `fixtures` and `codex-sandbox-macos`.
# To fix:  nothing to fix: `attested=false` runs the real check. The reason is on
#          stderr.
# Usage:   scripts/attest-pr-check.sh <context> <merge-group-head-ref>
# --help end
#
#   scripts/attest-pr-check.sh <context> <merge-group-head-ref>
#
# DOR-5130 step 1 (ci-steward's docs/plan-ci-efficiency.md, agreed with an
# adversarial reviewer, Nov 24). Four required checks (lint,
# credential-free-build, openapi-fresh, fixtures) caught no real failure in 457
# queue builds in the week of Nov 16-22, but cost a full job per queue entry
# and ejected 10 builds a week on flakes. In a merge group, each of those
# workflows first runs this. When the same check already succeeded on the
# entry's pull request at its current head, the heavy job is skipped (a skipped
# required job reports success) and the push-to-main run plus
# after-merge-alert.yml are the backstop for a two-PR clash. Anything else runs
# the real check.
#
# Prints exactly one line for $GITHUB_OUTPUT: `attested=true` or
# `attested=false`, then a reason on stderr. It never fails: any doubt is
# `attested=false`, which runs the real check (fail toward running, never
# toward skipping).
#
# Attested only when all hold:
#   - the ref is a merge-queue ref naming one PR (queue-repeat-guard.sh);
#   - the PR is open, its head is a 40-hex SHA, and its base is main;
#   - the newest check run named <context> on that head was made by GitHub
#     Actions (app id 15368) and concluded `success`. On a PR's head commit
#     those come only from its pull_request runs: queue runs report on the
#     group commit, and no workflow here runs on a push to a PR branch.
#     `skipped`, `neutral`, a cancelled or still-running run does not attest.
#
# Reads only, through `gh api` (GH overrides the binary). REPO defaults to
# $GITHUB_REPOSITORY, then dork-labs/dorkos. Needs scripts/queue-repeat-guard.sh
# beside it. Fixtures: scripts/test-attest-pr-check.sh.

# --help (DOR-4950). A gate checked out alone, as the PR-side gates are, runs without it.
gate_help="$(dirname "$0")/lib/gate-help.sh"
# shellcheck source=lib/gate-help.sh
[ ! -r "$gate_help" ] || . "$gate_help"

set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ACTIONS_APP_ID=15368

no() {
  echo "attested=false"
  echo "attest-pr-check: not attested, running the real check: $*" >&2
  exit 0
}

ctx=${1:-}
ref=${2:-}
[[ "$ctx" =~ ^[a-z0-9][a-z0-9-]{0,60}$ ]] && [ -n "$ref" ] || no "usage: attest-pr-check.sh <context> <merge-group-head-ref>"

pr=$(bash "$here/queue-repeat-guard.sh" pr-from-ref "$ref" 2>/dev/null) || no "not a merge-queue ref: $ref"
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || no "no PR number in $ref"

pull=$("$GH" api "repos/$REPO/pulls/$pr" --jq '{state, head: .head.sha, base: .base.ref}' 2>/dev/null) || no "could not read #$pr"
state=$(jq -r '.state // ""' <<<"$pull" 2>/dev/null) || state=
head=$(jq -r '.head // ""' <<<"$pull" 2>/dev/null) || head=
base=$(jq -r '.base // ""' <<<"$pull" 2>/dev/null) || base=
[ "$state" = open ] || no "#$pr is $state, not open"
[ "$base" = main ] || no "#$pr targets $base, not main"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || no "#$pr has no readable head"

newest=$("$GH" api --paginate "repos/$REPO/commits/$head/check-runs?check_name=$ctx&per_page=100" \
  --jq '.check_runs[] | {app: .app.id, status, conclusion, started_at, url: .details_url} | tojson' 2>/dev/null) ||
  no "could not read $ctx check runs on #$pr's head ${head:0:7}"
verdict=$(jq -rs --argjson app "$ACTIONS_APP_ID" '
  [ .[] | select(.app == $app) ] | sort_by(.started_at // "") | last
  | if . == null then "none"
    elif .status != "completed" then "unfinished"
    else (.conclusion // "none") end' <<<"$newest" 2>/dev/null) || verdict=unreadable

[ "$verdict" = success ] || no "$ctx on #$pr's head ${head:0:7} is $verdict"
echo "attested=true"
echo "attest-pr-check: $ctx already succeeded on #$pr at ${head:0:7}; the queue skips it (DOR-5130)." >&2
