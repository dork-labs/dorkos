#!/usr/bin/env bash
# pr-age-list.sh — list open pull requests older than N days, oldest first, for
# a standup to mark each one ship, split or close (DOR-3341).
#
# Usage:
#   pr-age-list.sh [--repo OWNER/NAME] [--days N]     # N defaults to 3
#
# A report, not a gate: it exits 0 whatever it finds. It exits 2 on a usage
# error or when the list could not be read, so an empty report always means
# "none that old", never "gh failed". PR_AGE_NOW (an ISO time) pins "now" for
# tests.
set -euo pipefail

repo=""
days=3
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || { echo "pr-age-list: --repo needs OWNER/NAME" >&2; exit 2; }
      repo="$2"
      shift 2
      ;;
    --days)
      [ $# -ge 2 ] || { echo "pr-age-list: --days needs a number" >&2; exit 2; }
      days="$2"
      shift 2
      ;;
    *)
      echo "pr-age-list: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$days" in
  '' | *[!0-9]* | 0*)
    echo "pr-age-list: --days must be a positive whole number, got '$days'" >&2
    exit 2
    ;;
esac

if [ -z "$repo" ]; then
  repo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || {
    echo "pr-age-list: could not tell which repository this is; pass --repo OWNER/NAME" >&2
    exit 2
  }
fi

limit=200
list=$(gh pr list --repo "$repo" --state open --limit "$limit" \
  --json number,title,createdAt,isDraft,labels,url) || {
  echo "pr-age-list: could not list open PRs in $repo" >&2
  exit 2
}
if [ "$(jq 'length' <<<"$list")" -ge "$limit" ]; then
  echo "pr-age-list: $limit or more open PRs in $repo; the list would be cut short" >&2
  exit 2
fi

# jq does the date math so it reads the same on macOS and Linux. GitHub's
# createdAt is whole-second UTC ("…T12:00:00Z"), which fromdateiso8601 takes.
old=$(jq -r --argjson days "$days" '
  (if ($ENV.PR_AGE_NOW // "") != "" then ($ENV.PR_AGE_NOW | fromdateiso8601) else now end) as $now
  | [ .[]
      | ($now - (.createdAt | fromdateiso8601)) as $seconds
      | select($seconds > $days * 86400)
      | . + { age: (($seconds / 86400) | floor) } ]
  | sort_by(.createdAt)
  | .[]
  | "#\(.number)  \(.age)d  \(.title)\(if .isDraft then " (draft)" else "" end)\(if (.labels | length) > 0 then "  [labels: \(.labels | map(.name) | join(", "))]" else "" end)  -> ship / split / close?"
' <<<"$list") || { echo "pr-age-list: could not read the PR list" >&2; exit 2; }

if [ -z "$old" ]; then
  echo "No open PRs older than $days days."
else
  echo "$old"
fi
