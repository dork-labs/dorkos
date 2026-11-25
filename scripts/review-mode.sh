#!/usr/bin/env bash
# Decide which kind of automated review a run of claude-code-review.yml does:
# a full review, or a push re-check (the Security lens only).
#
# WHY A SCRIPT. Since Nov 24 (ledger review-spend) a push to a PR that has
# already had a full review runs the Security lens only. The mode used to be the
# reviewer's own call, made by reading the PR's comments inside the review. It
# is now made here, by the workflow, before the review starts, from comments the
# reviewer itself posted, and handed to the prompt as one explicit value
# (`REVIEW MODE: push-recheck` or `REVIEW MODE: full`). That makes the decision
# exact and testable: it reads only the reviewer's own account, it reads only
# summaries of a FULL review, and every case is pinned by
# scripts/test-review-mode.sh.
#
# THE RULE. push-recheck when BOTH hold, full otherwise:
#   1. the run was triggered by a push (`synchronize`); and
#   2. at least one top-level comment on the PR, written by `claude[bot]` (user
#      type Bot), is a full review's summary: its last line is the marker
#      scripts/review-gh.sh appends to every summary it posts,
#        <!-- dorkos-review-summary v1 head=<40-hex sha> mode=full -->
#      The helper writes that line itself, with the mode this workflow decided
#      (REVIEW_MODE), after whatever the reviewer wrote, so it records what the
#      workflow did rather than what any text says. A push re-check's summary is
#      marked mode=push-recheck and is NOT counted: a push re-check is only ever
#      owed to a PR that had a full review, so a chain of them always leads back
#      to a real one, and a PR whose only summaries are push re-checks gets a
#      full review. A summary marked mode=unknown (a run of an older workflow) is
#      not counted either.
#
# TRANSITION (delete after 2026-12-08, with LEGACY_CUTOFF and its fixtures).
# Summaries posted before the helper wrote markers carry none. For those, and
# only for comments created before LEGACY_CUTOFF, the earlier rule still
# applies: an unmarked `claude[bot]` comment carrying a full review's severity
# tally (the shapes the verdict probe in claude-code-review.yml accepts: "1
# important, 3 nits", "No blocking issues found", "No factual issues found"),
# that is not a push re-check's summary ("Push re-check: ...") and not the
# Security verdict. An unmarked comment created at or after the cutoff never
# counts, whatever it says.
#
# Every doubt resolves to `full`, which costs a little more and never skips the
# general review: a trigger other than a push, no qualifying comment, or (in the
# workflow) this script missing from the default branch or the comments
# unreadable.
#
# Usage:
#   scripts/review-mode.sh <event-action> <comments.json>
#   gh api --paginate repos/O/R/issues/N/comments | scripts/review-mode.sh synchronize -
#
# <event-action> is `github.event.action` (empty on a dispatch). The comments
# are the REST issue-comments payload: one JSON array, or several concatenated
# (what `gh api --paginate` prints). Unknown keys are ignored. When the trigger
# is not a push the comments are not read.
#
# Prints exactly one line, `push-recheck` or `full`. Exit 0 for a decision, 2
# when the arguments or the comments could not be read, so a broken input can
# never be mistaken for a decision (the workflow treats it as `full`).
set -euo pipefail

usage() {
  echo "usage: review-mode.sh <event-action> <comments.json | ->" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
action=$1
src=$2

if [ "$action" != synchronize ]; then
  echo full
  exit 0
fi

if [ "$src" = - ]; then
  input=$(cat)
else
  [ -r "$src" ] || usage
  input=$(cat "$src")
fi

# The marker that makes a comment a full review's summary, matched against the
# comment's last non-blank line.
MARKER_RE='^<!-- dorkos-review-summary v1 head=[0-9a-f]{40} mode=full -->$'

# TRANSITION only (see above): the tally shapes are the verdict probe's, kept
# identical on purpose (the fixture suite checks the two regexes still agree),
# and they count only on unmarked comments created before LEGACY_CUTOFF.
TALLY_RE='[0-9]+ important|[0-9]+ nits?|No blocking issues|No factual issues'
LEGACY_CUTOFF='2026-11-25T00:00:00Z'

# shellcheck disable=SC2016 # jq variables, not shell ones
decision=$(jq -rs --arg tally "$TALLY_RE" --arg marker "$MARKER_RE" --arg cutoff "$LEGACY_CUTOFF" '
  [ .[] | if type == "array" then .[] else . end ]
  | if all(.[]; type == "object") | not then error("not a list of comments") else . end
  | any(.[];
      ((.user | type) == "object"
        and .user.login == "claude[bot]"
        and .user.type == "Bot"
        and (.body | type) == "string")
      and ((.body | gsub("\r"; "") | sub("\\s+$"; "")) as $b
        | ($b | split("\n") | last // "") as $last
        | if ($last | startswith("<!-- dorkos-review-summary")) then
            ($last | test($marker))
          else
            ((.created_at | type) == "string"
              and .created_at < $cutoff
              and ($b | test("^\\s*Push re-check:") | not)
              and ($b | test("^\\s*<!-- dorkos-security-verdict") | not)
              and ($b | test($tally)))
          end))
  | if . then "push-recheck" else "full" end' <<<"$input" 2>/dev/null) || {
  echo "review-mode: could not read the comments" >&2
  exit 2
}

case "$decision" in
  push-recheck | full) echo "$decision" ;;
  *)
    echo "review-mode: unexpected decision '$decision'" >&2
    exit 2
    ;;
esac
