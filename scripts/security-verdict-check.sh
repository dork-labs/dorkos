#!/usr/bin/env bash
# security-verdict-check.sh — did the cloud Security lens pass this exact head?
#
#   scripts/security-verdict-check.sh <pr-number> <head-sha>
#
# The decision behind the `security-verdict` job in
# .github/workflows/claude-code-review.yml (DOR-5099, under DOR-5098: every
# merge gate in the cloud). The reviewer posts its Security verdict through
# `scripts/review-gh.sh security-verdict`, which writes one fixed marker line:
#
#   <!-- dorkos-security-verdict v1 head=<sha> verdict=pass|fail musts=<n> cats=<list|-> -->
#
# This reads the PR's comments, keeps those written by a bot (the reviewer posts
# as the action's App), takes the newest marker naming <head-sha>, and passes
# only when it says `pass`. No marker for this head is a fail: an unreviewed head
# is not a reviewed one. Only the marker is read; the rest of the comment is
# ignored, so prose in a comment cannot pass the check.
#
# Advisory for now: the cloud and local Security reviews are compared before it
# becomes required.
#
# Reads only, through `gh api` (GH overrides the binary). REPO defaults to
# $GITHUB_REPOSITORY, then dork-labs/dorkos.
#
# Exit codes: 0 pass; 1 fail, or no verdict for this head; 2 usage, or GitHub
# could not be read. Fixtures: scripts/test-security-verdict-check.sh.
set -euo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
pr=${1:-}
head=${2:-}
[ $# -eq 2 ] && [[ "$pr" =~ ^[1-9][0-9]*$ ]] && [[ "$head" =~ ^[0-9a-f]{40}$ ]] || {
  echo "usage: security-verdict-check.sh <pr-number> <40-hex head sha>" >&2
  exit 2
}

# One JSON record per bot comment: created_at and body.
records=$("$GH" api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" \
  --jq '.[] | select(.user.type == "Bot") | {created_at, body} | tojson') || {
  echo "security-verdict-check: could not read the comments of #$pr" >&2
  exit 2
}

# The newest marker for this head, as "verdict musts cats".
marker=$(jq -rs --arg head "$head" '
  [ .[]
    | . as $c
    | ($c.body | capture("<!-- dorkos-security-verdict v1 head=(?<h>[0-9a-f]{40}) verdict=(?<v>pass|fail) musts=(?<m>[0-9]{1,2}) cats=(?<c>[a-z,-]+) -->")?) as $k
    | select($k != null and $k.h == $head)
    | {at: $c.created_at, v: $k.v, m: $k.m, c: $k.c} ]
  | sort_by(.at) | last // empty
  | "\(.v) \(.m) \(.c)"' <<<"$records") || {
  echo "security-verdict-check: could not parse the comments of #$pr" >&2
  exit 2
}

if [ -z "$marker" ]; then
  echo "FAIL: no Security lens verdict for #$pr at ${head:0:7}. The cloud review has not judged this head." >&2
  exit 1
fi
read -r verdict musts cats <<<"$marker"
if [ "$verdict" = pass ]; then
  echo "OK: the Security lens passed #$pr at ${head:0:7}."
  exit 0
fi
echo "FAIL: the Security lens found $musts Must(s) on #$pr at ${head:0:7} (categories: $cats)." >&2
exit 1
