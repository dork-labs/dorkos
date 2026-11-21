#!/usr/bin/env bash
# hold-reason-check.sh — a `hold` label must come with a reason.
#
#   scripts/hold-reason-check.sh <pr-number>
#
# Passes when the PR has no `hold` label, or when one of its comments starts
# with `hold:` and says something after it. Fails otherwise, naming the fix.
# Run by .github/workflows/hold-reason.yml, an advisory check (never required).
#
# WHY. merge-tail and the arm script both refuse a held PR, and neither lifts
# `hold`: only whoever set it can. A hold with no reason names nobody, so
# nobody lifts it. On 2026-11-20 a brief told agents to open security-path PRs
# with `hold` and 19 PRs sat for 9 hours. scripts/open-pr.sh posts the reason
# itself (`--hold "<reason>"`); this check covers every other way a hold goes
# on, including Codex and OpenCode agents, which run no Claude hooks.
#
# The reason may lag the label by a few seconds (open-pr.sh opens the PR with
# the label, then comments), so a missing reason is re-read HOLD_REASON_TRIES
# times (default 3), HOLD_REASON_WAIT seconds apart (default 15), before it
# fails.
#
# Reads PR metadata only, through `gh api` (GH overrides the binary); it never
# needs the PR's code. REPO defaults to $GITHUB_REPOSITORY, then
# dork-labs/dorkos.
#
# Exit codes: 0 no hold, or a hold with a reason; 1 a hold with no reason;
# 2 usage, or GitHub could not be read.
set -euo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
tries=${HOLD_REASON_TRIES:-3}
wait=${HOLD_REASON_WAIT:-15}
pr=${1:-}
[ $# -eq 1 ] && [[ "$pr" =~ ^[1-9][0-9]*$ ]] || {
  echo "usage: hold-reason-check.sh <pr-number>" >&2
  exit 2
}
[[ "$tries" =~ ^[1-9][0-9]*$ ]] && [[ "$wait" =~ ^[0-9]+$ ]] || {
  echo "hold-reason-check: HOLD_REASON_TRIES must be a positive number and HOLD_REASON_WAIT a whole number" >&2
  exit 2
}

attempt=1
while :; do
  labels=$("$GH" api "repos/$REPO/issues/$pr/labels?per_page=100" --jq '.[].name') || {
    echo "hold-reason-check: could not read the labels of #$pr" >&2
    exit 2
  }
  if ! grep -qxF hold <<<"$labels"; then
    echo "OK: #$pr has no hold label"
    exit 0
  fi
  # One JSON string per comment, so a multi-line body stays one record.
  bodies=$("$GH" api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" --jq '.[].body | tojson') || {
    echo "hold-reason-check: could not read the comments of #$pr" >&2
    exit 2
  }
  reason=$(jq -r 'select(test("^\\s*hold:\\s*\\S")) | sub("^\\s+"; "") | split("\n")[0]' <<<"$bodies" | tail -1) || {
    echo "hold-reason-check: could not read the comments of #$pr" >&2
    exit 2
  }
  if [ -n "$reason" ]; then
    echo "OK: #$pr is held: $reason"
    exit 0
  fi
  [ "$attempt" -lt "$tries" ] || break
  attempt=$((attempt + 1))
  sleep "$wait"
done

cat >&2 <<EOF
FAIL: #$pr has the hold label and no comment saying why.
A hold with no reason names nobody to lift it, so the PR waits forever.
Whoever added it: comment "hold: <reason, and who lifts it>", or take the label off.
Opening a PR on hold: scripts/open-pr.sh --hold "<reason>" does both at once.
EOF
exit 1
