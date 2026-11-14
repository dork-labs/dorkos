#!/usr/bin/env bash
# open-pr-cap.sh — refuse to open another pull request while too many are open
# (DOR-3341).
#
# Usage:
#   open-pr-cap.sh [--repo OWNER/NAME] [--p0 "REASON"]
#
# Run it before `gh pr create`. Review is one serial line (Security, QA, the
# designer); lanes that open PRs faster than it clears turn every new PR into a
# pileup, and on 2026-10-26 there were 25 open at once. At the cap, keep
# building locally and commit; open the PR when one lands.
#
# Counts open, non-draft PRs. The cap is DORKOS_OPEN_PR_CAP (default 8). A P0
# may pass the cap with --p0 and a reason, which is printed so it is on record.
#
# Exit codes: 0 ok to open one; 1 at or over the cap; 2 usage error, or the
# count could not be read. A failed `gh` is never read as zero open PRs.
set -euo pipefail

repo=""
p0=""
p0_given=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || { echo "open-pr-cap: --repo needs OWNER/NAME" >&2; exit 2; }
      repo="$2"
      shift 2
      ;;
    --p0)
      [ $# -ge 2 ] || { echo "open-pr-cap: --p0 needs a reason" >&2; exit 2; }
      p0="$2"
      p0_given=1
      shift 2
      ;;
    *)
      echo "open-pr-cap: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$p0_given" = 1 ] && [ -z "${p0//[[:space:]]/}" ]; then
  echo "open-pr-cap: --p0 needs a reason, not an empty string" >&2
  exit 2
fi

cap="${DORKOS_OPEN_PR_CAP:-8}"
case "$cap" in
  '' | *[!0-9]* | 0*)
    echo "open-pr-cap: DORKOS_OPEN_PR_CAP must be a positive whole number, got '$cap'" >&2
    exit 2
    ;;
esac

if [ -z "$repo" ]; then
  repo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || {
    echo "open-pr-cap: could not tell which repository this is; pass --repo OWNER/NAME" >&2
    exit 2
  }
fi

# The limit is a ceiling on what `gh` returns, not on what exists: a full page
# means the count is unknown, so it refuses rather than guess low.
limit=200
list=$(gh pr list --repo "$repo" --state open --limit "$limit" --json number,isDraft,title) || {
  echo "open-pr-cap: could not count open PRs in $repo" >&2
  exit 2
}
total=$(jq 'length' <<<"$list") || { echo "open-pr-cap: could not read the PR list" >&2; exit 2; }
if [ "$total" -ge "$limit" ]; then
  echo "open-pr-cap: $total or more open PRs in $repo, too many to count reliably" >&2
  exit 2
fi
open=$(jq '[.[] | select(.isDraft | not)] | length' <<<"$list")

if [ "$open" -lt "$cap" ]; then
  echo "open PRs: $open of $cap; ok to open one"
  exit 0
fi

if [ "$p0_given" = 1 ]; then
  echo "open PRs: $open of $cap; opening anyway as a P0: $p0" >&2
  exit 0
fi

{
  echo "open PRs: $open of $cap. Do not open another: finish or land one first, or keep building locally. A P0 may pass with --p0 \"<reason>\"."
  jq -r '.[] | select(.isDraft | not) | "  #\(.number) \(.title)"' <<<"$list"
} >&2
exit 1
