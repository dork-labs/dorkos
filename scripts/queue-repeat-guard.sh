#!/usr/bin/env bash
# The merge queue's door for the repeat-ejection rule: a pull request whose
# current head has already failed the same check twice in the queue is taken
# back out the moment it is queued again, whoever queued it.
#
# Why this exists: merge-tail already refuses to re-arm such a pull request
# (scripts/should-arm-automerge.sh, `SKIP repeat-queue-failure`), but merge-tail
# is not the only hand that arms. Agents arm their own PRs with
# `gh pr merge --auto`, and on a green PR that enqueues at once, past every
# merge-tail rule. Measured over 2026-10-16..10-30: 85 failed-checks ejections,
# 7 of them a third or later try of an unchanged head (#3104 alone was queued
# five times on one commit on 10-20, each try within a minute of the last
# ejection). Every one of those builds was red, and so was each build stacked
# behind it, because a merge-group build carries every pull request ahead of it.
# .github/workflows/queue-repeat-guard.yml runs on `merge_group`, so it sees
# every entry, and this script is the decision it makes.
#
# The rule is the one merge-tail uses, read from the same jq definition
# (`should-arm-automerge.sh --repeat-failure`), so the two cannot disagree about
# what a repeat is. Where they differ is the default: merge-tail ARMS only on
# proof, while this DEQUEUES only on proof. An unreadable payload or unknown
# history keeps the entry, because taking a pull request out of the queue on a
# guess is the more expensive mistake.
#
# One way past it: the `requeue-ok` label. It exists for the case merge-tail's
# comment already names, where the same check was red on `main` too and `main`
# is now fixed, so the old failures were not this branch's. It counts only when
# it was added after the last failed removal (`requeueOkAt` in the payload, the
# label's latest LabeledEvent), so it buys one more try, not a pass forever;
# the workflow takes a spent label off when it dequeues.
#
# Usage:
#   scripts/queue-repeat-guard.sh pr-from-ref <merge-group head ref>
#       prints the pull request number, or exits 1 when the ref is not a queue ref
#   scripts/queue-repeat-guard.sh verdict <payload.json>
#       payload as built by scripts/should-arm-automerge-input.sh, plus
#       `requeueOkAt` (when `requeue-ok` was last added, or null); prints one line:
#         DEQUEUE                     take it out; the repeated checks follow, one per line
#         KEEP requeue-ok             a person said this retry is wanted (label)
#         KEEP no-repeat              no required check failed twice on this head
#         KEEP required-checks-unknown  ci/required-checks.json could not be read
#         KEEP queue-history-unknown  the history could not be read
#         KEEP unreadable-payload     the payload is not JSON (exit 2)
#   scripts/queue-repeat-guard.sh comment <pr> <head-sha> <repeats-file>
#       prints the note left on the pull request
#
# The comment carries merge-tail's own marker for the same head, so the author
# is told once per head whichever of the two noticed first.

set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
gate=${ARM_GATE:-$here/should-arm-automerge.sh}
required_file=${REQUIRED_CHECKS:-$here/../ci/required-checks.json}
OVERRIDE_LABEL=requeue-ok

usage() {
  echo "usage: $0 pr-from-ref <ref> | verdict <payload.json> | comment <pr> <head-sha> <repeats-file>" >&2
  exit 2
}

cmd=${1:-}
shift || :

case "$cmd" in
  pr-from-ref)
    ref=${1:-}
    # refs/heads/gh-readonly-queue/<base>/pr-<n>-<40-hex base sha>. The base
    # branch is matched loosely (it may contain slashes); the tail is not.
    if [[ "$ref" =~ ^(refs/heads/)?gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]{40}$ ]]; then
      echo "${BASH_REMATCH[2]}"
      exit 0
    fi
    exit 1
    ;;

  verdict)
    src=${1:-}
    [[ -n "$src" ]] || usage
    if ! jq -e 'type == "object"' "$src" >/dev/null 2>&1; then
      echo "KEEP unreadable-payload"
      exit 2
    fi
    # --repeat-failure prints nothing both for "no repeats" and for unknown
    # history, so unknown is asked separately, the same way the gate asks it.
    known=$(jq -r '
      ((.queueRemovals | type) == "array")
      and ( (.headSince // null) != null
            or ([.queueRemovals[] | select(type == "object")
                 | select(((.failedChecks // []) | length) > 0)] | length) == 0 )' "$src" 2>/dev/null)
    if [[ "$known" != "true" ]]; then
      echo "KEEP queue-history-unknown"
      exit 0
    fi
    repeats=$("$gate" --repeat-failure "$src" 2>/dev/null) || { echo "KEEP unreadable-payload"; exit 2; }
    # Only a required check can eject, so only a required check can make a
    # repeat. Others fail in the queue without ejecting anything: security-gate
    # is red on every merge group that touches a security path, by design, so
    # two ejections for two different reasons would both list it and read as a
    # repeat. A required-check list that cannot be read keeps the entry.
    required=$(jq -r '.contexts[]? | strings' "$required_file" 2>/dev/null)
    if [[ -z "$required" ]]; then
      echo "KEEP required-checks-unknown"
      exit 0
    fi
    repeats=$(grep -Fx -f <(printf '%s\n' "$required") <<<"$repeats" || :)
    if [[ -z "$repeats" ]]; then
      echo "KEEP no-repeat"
      exit 0
    fi
    # The label buys the tries until the next failure: it counts only when it
    # was put on after the last failed removal. Never removed on the way in,
    # because GitHub rebuilds a queue entry each time an entry ahead of it
    # fails, and every rebuild raises this event again for the same try.
    if jq -e --arg l "$OVERRIDE_LABEL" --argjson req "$(jq -c '[.contexts[]? | strings]' "$required_file")" '
         ([(.labels // [])[] | (if type == "object" then (.name // "") else tostring end)
           | ascii_downcase] | index($l) != null)
         and ((.requeueOkAt // "") as $at
              | $at != ""
                and $at > ([(.queueRemovals // [])[] | select(type == "object")
                            | select(any((.failedChecks // [])[]; . as $c | $req | index($c)))
                            | (.at // "")]
                           | max // ""))' \
         "$src" >/dev/null 2>&1; then
      echo "KEEP requeue-ok"
      exit 0
    fi
    echo "DEQUEUE"
    printf '%s\n' "$repeats"
    ;;

  comment)
    pr=${1:-} head=${2:-} repeats=${3:-}
    [[ -n "$pr" && -n "$head" && -n "$repeats" ]] || usage
    echo "**Taken out of the merge queue.** The queue has already rejected this exact commit (\`${head:0:7}\`) twice, and the same check failed each time:"
    echo
    sed 's/.*/- `&`/' "$repeats"
    echo
    echo "A check that fails twice on unchanged code is most likely a real bug, not a flaky test. Trying a third time would fail again, and every pull request queued behind this one would fail with it. This pull request's own checks can all be green while this happens, because the browser tests run only in the merge queue."
    echo
    echo "**What to do:** open the failing job in the merge-group run (\`gh run list --event merge_group -L 100 --json headBranch,name,conclusion,databaseId\`, rows whose \`headBranch\` contains \`pr-$pr-\`), fix the cause and push. A new commit starts the count again."
    echo
    echo "If the same check was also red on \`main\` and \`main\` is now fixed, the failures were not this branch's: add the \`$OVERRIDE_LABEL\` label and queue it again. The label lets it through until the queue rejects it again."
    echo
    echo "<!-- merge-tail:repeat-queue-failure head=$head -->"
    ;;

  *) usage ;;
esac
