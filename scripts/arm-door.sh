#!/usr/bin/env bash
# The merge queue's door for the arm rule: a pull request enters the queue only
# through the local arm script, which runs every gate first (Security's label at
# the head, QA's and the designer's sign-offs, a verify proof or a logged
# waiver) and then stamps the head with an `arm-record` commit status naming the
# agent and session that armed it. A pull request queued any other way (a bare
# `gh pr merge --auto`, a GraphQL enqueue, merge-tail) has no stamp at its head,
# and .github/workflows/arm-door.yml takes it back out (DOR-4648).
#
# Why this exists: every agent acts on GitHub as one login, so nothing on
# GitHub told the arm script's queueing apart from any other. On 2026-11-17 and
# 11-18 two pull requests reached the queue past it (#3913 by a bare
# `gh pr merge`, #3934 by merge-tail's schedule eight seconds before QA's
# label). A
# stamp is not a signature: any session holding the same login can post one,
# so this stops the mistakes seen so far, not a session set on lying. Per-role
# GitHub Apps are the real fix (DOR-3183).
#
# Like queue-repeat-guard.sh, it DEQUEUES only on proof: statuses it cannot read
# keep the entry, since the queue still runs every required check on it.
#
# Usage:
#   scripts/arm-door.sh verdict <statuses.json>
#       <statuses.json> is the JSON array of the head commit's statuses
#       (`gh api --paginate repos/<repo>/commits/<sha>/statuses` slurped with
#       `jq -s add`). Prints one line:
#         KEEP armed <description>     the newest arm-record is `success`
#         DEQUEUE no-arm-record        the head was never stamped
#         DEQUEUE arm-record-<state>   the newest stamp is not `success`
#         KEEP unreadable-statuses     not a JSON array (exit 2)
#   scripts/arm-door.sh comment <pr> <head-sha> <reason>
#       prints the note left on the pull request, once per head

set -uo pipefail

CONTEXT=arm-record

usage() {
  echo "usage: $0 verdict <statuses.json> | comment <pr> <head-sha> <reason>" >&2
  exit 2
}

cmd=${1:-}
shift || :

case "$cmd" in
  verdict)
    src=${1:-}
    [[ -n "$src" ]] || usage
    if ! jq -e 'type == "array"' "$src" >/dev/null 2>&1; then
      echo "KEEP unreadable-statuses"
      exit 2
    fi
    # The newest stamp wins, by creation time and then id, so a later
    # `failure` (an arm that did not finish) undoes an earlier `success`.
    newest=$(jq -r --arg c "$CONTEXT" '
      [.[] | select(type == "object" and .context == $c)]
      | sort_by(.created_at // "", .id // 0) | last
      | if . == null then "" else "\(.state // "unknown")\t\(.description // "")" end' "$src" 2>/dev/null) \
      || { echo "KEEP unreadable-statuses"; exit 2; }
    if [[ -z "$newest" ]]; then
      echo "DEQUEUE no-arm-record"
      exit 0
    fi
    state=${newest%%$'\t'*}
    desc=${newest#*$'\t'}
    if [[ "$state" == "success" ]]; then
      echo "KEEP armed $desc"
    else
      echo "DEQUEUE arm-record-$state"
    fi
    ;;

  comment)
    pr=${1:-} head=${2:-} reason=${3:-}
    [[ -n "$pr" && -n "$head" && -n "$reason" ]] || usage
    echo "**Taken out of the merge queue.** This commit (\`${head:0:7}\`) was queued without the arm script, so its checks were skipped: Security's label at this head, QA's and the designer's sign-offs, and the verify proof."
    echo
    echo "**What to do:** arm it through the arm script, not \`gh pr merge\`. The script runs those checks, marks this commit as armed, and the queue then lets it in."
    echo
    echo "<sub>reason: $reason</sub>"
    echo
    echo "<!-- arm-door head=$head -->"
    ;;

  *) usage ;;
esac
