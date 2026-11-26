#!/usr/bin/env bash
# not-held-check.sh — fail while a pull request carries the `hold` label.
#
# --help
# Purpose: fail while a pull request carries the `hold` label.
# Runs in: the required `not-held` check.
# To fix:  whoever set `hold` takes it off when the reason is gone; the check
#          re-runs and the PR goes on.
# Usage:   scripts/not-held-check.sh <pr-number>
# --help end
#
#   scripts/not-held-check.sh <pr-number>
#
# The decision behind .github/workflows/not-held.yml (DOR-5103, under DOR-5098:
# every merge gate in the cloud, then auto-merge at PR open). Once PRs turn on
# auto-merge when they open, `hold` has to stop a merge by itself: GitHub will
# not merge or enqueue a PR while a required check is red, so `not-held` is how
# a hold becomes a gate GitHub enforces rather than a rule a local arm script
# remembers. Taking the label off re-runs the check and the PR goes on.
#
# Fixtures: scripts/test-not-held-check.sh. hold-reason-check.sh is the
# separate advisory rule that a hold says why; this script prints that reason
# when there is one, so the red check names who lifts it.
#
# Reads PR metadata only, through `gh api` (GH overrides the binary); it never
# needs the PR's code. REPO defaults to $GITHUB_REPOSITORY, then
# dork-labs/dorkos.
#
# Exit codes: 0 no hold; 1 held; 2 usage, or GitHub could not be read (a gate
# that cannot read the labels fails closed).

# --help (DOR-4950). A gate checked out alone, as the PR-side gates are, runs without it.
gate_help="$(dirname "$0")/lib/gate-help.sh"
# shellcheck source=lib/gate-help.sh
[ ! -r "$gate_help" ] || . "$gate_help"

set -euo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
pr=${1:-}
[ $# -eq 1 ] && [[ "$pr" =~ ^[1-9][0-9]*$ ]] || {
  echo "usage: not-held-check.sh <pr-number>" >&2
  exit 2
}

labels=$("$GH" api "repos/$REPO/issues/$pr/labels?per_page=100" --jq '.[].name') || {
  echo "not-held-check: could not read the labels of #$pr" >&2
  exit 2
}
if ! grep -qxF hold <<<"$labels"; then
  echo "OK: #$pr is not held"
  exit 0
fi

# Best effort: the latest `hold: <reason>` comment, so the red check says why.
reason=$("$GH" api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" --jq '.[].body | tojson' 2>/dev/null |
  jq -r 'select(test("^\\s*hold:\\s*\\S")) | sub("^\\s+"; "") | split("\n")[0]' 2>/dev/null | tail -1) || reason=""

{
  echo "HELD: #$pr has the hold label, so it cannot merge."
  if [ -n "$reason" ]; then
    echo "Reason given: $reason"
  else
    echo "No comment starting \"hold:\" says why (the hold-reason check flags that)."
  fi
  echo "Whoever set it lifts it by taking the label off; this check then re-runs and passes."
} >&2
exit 1
