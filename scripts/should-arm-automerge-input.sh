#!/usr/bin/env bash
# Build the payload scripts/should-arm-automerge.sh decides on, from the three
# answers .github/workflows/merge-tail.yml gets from GitHub about one pull
# request — or refuse, when one of those answers is not really an answer.
#
# Why this is its own script: the gate is affirmative ("anything unknown is a
# SKIP"), but it can only be as honest as its input, and the input used to be
# built by inline jq that read a FAILED GraphQL answer as a clean one. GitHub's
# GraphQL API reports an error as a body, `{"data": null, "errors": [...]}`,
# and `.data.repository.pullRequest.mergeQueueEntry // null` on that body is
# `null` ("not queued"), while counting its unresolved review threads gives 0
# ("none open"): two green signals made out of a failure (DOR-2271). Here each
# answer is proven to be one before any field is read from it, and every
# refusal is pinned by scripts/test-should-arm-automerge-input.sh.
#
# Usage:
#   scripts/should-arm-automerge-input.sh <meta.json> <checks.json> <graphql.json>
#
#   meta.json     `gh pr view --json number,state,isDraft,mergeStateStatus,
#                 autoMergeRequest,reviewDecision,labels,headRefOid`
#   checks.json   `gh pr checks --json name,bucket`, or `[]` when gh said the
#                 pull request has no checks; anything else is unreadable, and
#                 merge-tail writes gh's error text here so the skip names it
#   graphql.json  the body of merge-tail's GraphQL query (mergeQueueEntry,
#                 reviewThreads, the head commit's check suites, and the recent
#                 REMOVED_FROM_MERGE_QUEUE_EVENTs), as gh prints it on stdout —
#                 which it does for an error too, while exiting non-zero
#
# Prints the payload (one JSON document) and exits 0, or prints exactly one
# line and exits 1:
#   SKIP could-not-read-pr               meta.json is not a pull request object
#   SKIP could-not-read-checks (…)       checks.json is not a list
#   SKIP could-not-read-graphql (…)      graphql.json is not JSON (a proxy's HTML, nothing)
#   SKIP graphql-error (…)               GitHub reported an error, even alongside data
#   SKIP could-not-read-pull-request (…) JSON, but no pull request object in it
#   SKIP could-not-read-queue-entry      the pull request carries no mergeQueueEntry field
#   SKIP could-not-read-review-threads   the review-thread list is not a list
#
# ANY reported error refuses, not only a null `data`. GraphQL answers a failed
# field by nulling it and listing it in `errors`, and the fields here fail
# toward permission when nulled: a nulled `mergeQueueEntry` reads as "not
# queued" and a nulled check-suite list under a queue removal reads as "that
# ejection failed nothing". Nothing in the answer says which fields are the
# nulled ones except `errors` itself, so a partial answer is no answer.
#
# A gap with no error reported keeps its old meaning. A head commit that does
# not match `headRefOid` (a push landed between the reads) gives `headSince:
# null`, and a timeline that is not a list gives `queueRemovals: null`; the gate
# reads both as unknown history and skips.

set -uo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <meta.json> <checks.json> <graphql.json>" >&2
  exit 2
fi
meta=$1 checks=$2 graphql=$3

# One line for the log: newlines flattened, cut short; never blank.
excerpt() {
  local line
  line=$(tr '\n' ' ' | sed 's/ *$//' | cut -c1-160)
  echo "${line:-empty answer}"
}

jq -e 'type == "object"' "$meta" >/dev/null 2>&1 \
  || { echo "SKIP could-not-read-pr"; exit 1; }
jq -e 'type == "array"' "$checks" >/dev/null 2>&1 \
  || { echo "SKIP could-not-read-checks ($(excerpt < "$checks" 2>/dev/null))"; exit 1; }

if ! jq -e 'type == "object"' "$graphql" >/dev/null 2>&1; then
  echo "SKIP could-not-read-graphql ($(excerpt < "$graphql" 2>/dev/null))"
  exit 1
fi

# `errors` present at all, in any shape but an empty list, is an error.
errors=$(jq -r 'if has("errors") and .errors != null and .errors != [] then
                  [ (.errors | if type == "array" then .[] else . end)
                    | if type == "object"
                      then ((.type // "ERROR") + ": " + (.message // "no message"))
                      else tostring end ]
                  | join("; ")
                else empty end' "$graphql" 2>/dev/null) || errors="unparseable errors field"
if [[ -n "$errors" ]]; then
  echo "SKIP graphql-error ($(excerpt <<<"$errors"))"
  exit 1
fi

if ! jq -e '(.data.repository.pullRequest | type) == "object"' "$graphql" >/dev/null 2>&1; then
  echo "SKIP could-not-read-pull-request ($(jq -r '.message // "no data"' "$graphql" 2>/dev/null | excerpt))"
  exit 1
fi
jq -e '.data.repository.pullRequest | has("mergeQueueEntry")' "$graphql" >/dev/null 2>&1 \
  || { echo "SKIP could-not-read-queue-entry"; exit 1; }
jq -e '(.data.repository.pullRequest.reviewThreads.nodes | type) == "array"' "$graphql" >/dev/null 2>&1 \
  || { echo "SKIP could-not-read-review-threads"; exit 1; }

# The queue's memory is flattened into the two fields the gate reads; see the
# gate's header for what `headSince` and `queueRemovals` mean and why.
jq -s '
  .[0] as $meta | .[1] as $checks | .[2].data.repository.pullRequest as $p
  | ($p.commits.nodes[0].commit? // null) as $head
  | $meta + {
      checks: $checks,
      mergeQueueEntry: $p.mergeQueueEntry,
      unresolvedThreads: ([$p.reviewThreads.nodes[] | select(.isResolved == false)] | length),
      headSince: (if $head != null and $head.oid == $meta.headRefOid
                  then ([$head.checkSuites.nodes[]?.createdAt] | min)
                  else null end),
      queueRemovals: (if ($p.timelineItems.nodes? | type) == "array"
                      then [$p.timelineItems.nodes[]
                            | {at: .createdAt, reason,
                               failedChecks: ([.beforeCommit.checkSuites.nodes[]?
                                               .checkRuns.nodes[]?.name] | unique)}]
                      else null end) }' \
  "$meta" "$checks" "$graphql" 2>/dev/null \
  || { echo "SKIP could-not-read-pull-request (unexpected shape)"; exit 1; }
