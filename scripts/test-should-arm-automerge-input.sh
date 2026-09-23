#!/usr/bin/env bash
# Fixture suite for scripts/should-arm-automerge-input.sh, which turns what
# GitHub answered about one pull request into the payload the arming gate
# (scripts/should-arm-automerge.sh) decides on.
#
# It exists because the gate is only as honest as its input. The gate's own
# fixtures bend one field of a clean payload at a time; none of them can see a
# builder that reads a FAILED answer as a clean one. That is the failure pinned
# here: GitHub's GraphQL API answers an error with a body, not an empty stream —
# `{"data": null, "errors": [...]}` — and read loosely that body says "not in
# the merge queue, no open review threads, never ejected", which is three green
# signals made out of a failure (DOR-2271). Every refusal below is an answer
# that must never become a payload.
#
#   bash scripts/test-should-arm-automerge-input.sh
#   BUILDER=/path/to/other.sh bash scripts/test-should-arm-automerge-input.sh
#
# BUILDER exists so a candidate rewrite, or a deliberately loosened one, can be
# run against the same fixtures to show what it stops catching.
#
# Hermetic: fixture files in a temp dir, no network.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
builder=${BUILDER:-$repo_root/scripts/should-arm-automerge-input.sh}
gate=$repo_root/scripts/should-arm-automerge.sh

if ! command -v jq >/dev/null 2>&1; then
  echo "should-arm-automerge-input fixtures: needs jq on PATH" >&2
  exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0

HEAD=0123456789abcdef0123456789abcdef01234567

# `gh pr view --json number,state,isDraft,mergeStateStatus,autoMergeRequest,
# reviewDecision,labels,headRefOid` for a finished pull request.
meta() {
  cat <<JSON
{"number": 7, "state": "OPEN", "isDraft": false, "mergeStateStatus": "BEHIND",
 "autoMergeRequest": null, "reviewDecision": "APPROVED", "labels": [],
 "headRefOid": "$HEAD"}
JSON
}

checks() {
  echo '[{"name": "typecheck", "bucket": "pass"}, {"name": "review", "bucket": "pass"}]'
}

# The GraphQL answer for the same pull request, in the shape merge-tail's query
# asks for: not queued, one resolved thread, head pushed once, never ejected.
graphql() {
  cat <<JSON
{"data": {"repository": {"pullRequest": {
  "mergeQueueEntry": null,
  "reviewThreads": {"nodes": [{"isResolved": true}]},
  "commits": {"nodes": [{"commit": {"oid": "$HEAD",
    "checkSuites": {"nodes": [{"createdAt": "2026-09-21T15:05:00Z"},
                              {"createdAt": "2026-09-21T15:00:00Z"}]}}}]},
  "timelineItems": {"nodes": []}}}}}
JSON
}

# run <meta> <checks> <graphql>: the three answers as text, the builder's
# stdout into $out and its exit status into $rc.
run() {
  printf '%s' "$1" > "$tmp/meta.json"
  printf '%s' "$2" > "$tmp/checks.json"
  printf '%s' "$3" > "$tmp/gql.json"
  out=$("$builder" "$tmp/meta.json" "$tmp/checks.json" "$tmp/gql.json" 2>/dev/null)
  rc=$?
}

ok()  { pass=$(( pass + 1 )); }
bad() { fail=$(( fail + 1 )); printf 'FAIL  %-40s %s\n' "$1" "$2"; }

# refuses <name> <expected-prefix> <meta> <checks> <graphql>: the builder must
# exit non-zero and print one `SKIP <slug>` line, never a payload.
refuses() {
  local name=$1 want=$2
  run "$3" "$4" "$5"
  if [[ $rc -ne 0 && "$out" == "$want"* && "$out" != *$'\n'* ]]; then ok; else
    bad "$name" "expected rc!=0 and '${want}...', got rc=$rc: ${out:-<empty>}"
  fi
}

# builds <name> <jq-assertion> <meta> <checks> <graphql>: the builder must exit
# 0 with a payload the assertion holds for.
builds() {
  local name=$1 assertion=$2
  run "$3" "$4" "$5"
  if [[ $rc -eq 0 ]] && jq -e "$assertion" >/dev/null 2>&1 <<<"$out"; then ok; else
    bad "$name" "expected a payload where $assertion, got rc=$rc: ${out:-<empty>}"
  fi
}

# ── a clean answer builds the payload the gate arms on ─────────────────────
builds "clean answer" \
  '.number == 7 and .mergeQueueEntry == null and .unresolvedThreads == 0
   and .headSince == "2026-09-21T15:00:00Z" and .queueRemovals == []
   and (.checks | length) == 2' \
  "$(meta)" "$(checks)" "$(graphql)"

run "$(meta)" "$(checks)" "$(graphql)"
verdict=$("$gate" - <<<"$out" 2>/dev/null)
if [[ "$verdict" == "ARM" ]]; then ok; else bad "clean answer arms end to end" "got ${verdict:-<empty>}"; fi

builds "an empty errors array is no error" '.unresolvedThreads == 0' \
  "$(meta)" "$(checks)" "$(graphql | jq -c '. + {errors: []}')"
builds "queued PR keeps its queue entry" '.mergeQueueEntry.position == 2' \
  "$(meta)" "$(checks)" "$(graphql | jq -c '.data.repository.pullRequest.mergeQueueEntry = {position: 2, state: "QUEUED"}')"
builds "open threads are counted" '.unresolvedThreads == 2' \
  "$(meta)" "$(checks)" "$(graphql | jq -c '.data.repository.pullRequest.reviewThreads.nodes = [{isResolved: false}, {isResolved: true}, {isResolved: false}]')"
builds "no checks is a fact, not a failure" '.checks == []' \
  "$(meta)" '[]' "$(graphql)"
builds "ejections carry their failed checks" \
  '.queueRemovals == [{at: "2026-09-21T16:00:00Z", reason: null, failedChecks: ["browser-test"]}]' \
  "$(meta)" "$(checks)" "$(graphql | jq -c '.data.repository.pullRequest.timelineItems.nodes = [{createdAt: "2026-09-21T16:00:00Z", reason: null, beforeCommit: {checkSuites: {nodes: [{checkRuns: {nodes: [{name: "browser-test"}]}}]}}}]')"

# Structural gaps with NO error reported keep today's meaning: unknown history,
# which the gate itself turns into `SKIP queue-history-unknown`.
builds "push landed between the reads" '.headSince == null' \
  "$(meta)" "$(checks)" "$(graphql | jq -c '.data.repository.pullRequest.commits.nodes[0].commit.oid = "fff"')"
builds "no timeline is unknown history" '.queueRemovals == null' \
  "$(meta)" "$(checks)" "$(graphql | jq -c '.data.repository.pullRequest.timelineItems = null')"

# ── an error body is never a payload (DOR-2271) ────────────────────────────
# The exact body from the issue: no data at all, one error.
refuses "data null with errors" "SKIP graphql-error" \
  "$(meta)" "$(checks)" '{"data": null, "errors": [{"type": "INTERNAL", "message": "Something went wrong while executing your query."}]}'

# The body gh really returns for a pull request it cannot resolve (captured
# 2026-09-23 with `gh api graphql` against a number that does not exist).
refuses "pull request not found" "SKIP graphql-error" \
  "$(meta)" "$(checks)" '{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","path":["repository","pullRequest"],"locations":[{"line":1,"column":86}],"message":"Could not resolve to a PullRequest with the number of 99999999."}]}'

# A PARTIAL answer is as dangerous as an empty one. GraphQL nulls a field that
# failed and reports it in `errors`, and a nulled `mergeQueueEntry` reads as
# "not queued" while a nulled check-suite list reads as "never failed in the
# queue". So any reported error refuses, whatever else came back.
refuses "queue entry nulled by an error" "SKIP graphql-error" \
  "$(meta)" "$(checks)" "$(graphql | jq -c '. + {errors: [{type: "FORBIDDEN", path: ["repository", "pullRequest", "mergeQueueEntry"], message: "Resource not accessible by integration"}]}')"
refuses "failed checks nulled by an error" "SKIP graphql-error" \
  "$(meta)" "$(checks)" "$(graphql | jq -c '.data.repository.pullRequest.timelineItems.nodes = [{createdAt: "2026-09-21T16:00:00Z", reason: null, beforeCommit: {checkSuites: null}}] | . + {errors: [{type: "FORBIDDEN", message: "Resource not accessible by integration"}]}')"

# The error's own words reach the log, so the skip explains itself.
run "$(meta)" "$(checks)" '{"data": null, "errors": [{"type": "INTERNAL", "message": "Something went wrong"}]}'
if [[ "$out" == *"Something went wrong"* ]]; then ok; else bad "error message is logged" "got ${out:-<empty>}"; fi

# Bodies that are not a GraphQL answer at all.
refuses "data null, no errors"      "SKIP could-not-read-pull-request" "$(meta)" "$(checks)" '{"data": null}'
refuses "REST-style error object"   "SKIP could-not-read-pull-request" "$(meta)" "$(checks)" '{"message": "Bad credentials", "documentation_url": "https://docs.github.com/rest"}'
refuses "empty body"                "SKIP could-not-read-graphql"      "$(meta)" "$(checks)" ''
refuses "HTML from a proxy"         "SKIP could-not-read-graphql"      "$(meta)" "$(checks)" '<html><body>502 Bad Gateway</body></html>'
refuses "errors not an array"       "SKIP graphql-error"               "$(meta)" "$(checks)" "$(graphql | jq -c '. + {errors: "boom"}')"

# The two fields the gate needs a definite answer for.
refuses "queue entry missing" "SKIP could-not-read-queue-entry" \
  "$(meta)" "$(checks)" "$(graphql | jq -c 'del(.data.repository.pullRequest.mergeQueueEntry)')"
refuses "review threads missing" "SKIP could-not-read-review-threads" \
  "$(meta)" "$(checks)" "$(graphql | jq -c '.data.repository.pullRequest.reviewThreads = null')"
refuses "review thread nodes not a list" "SKIP could-not-read-review-threads" \
  "$(meta)" "$(checks)" "$(graphql | jq -c '.data.repository.pullRequest.reviewThreads.nodes = {}')"

# ── the other two reads ────────────────────────────────────────────────────
# An unreadable check list is not "no checks": the workflow writes `[]` only
# when gh said there are none, and leaves anything else for this to refuse.
refuses "checks empty file"     "SKIP could-not-read-checks" "$(meta)" ''                                "$(graphql)"
refuses "checks error object"   "SKIP could-not-read-checks" "$(meta)" '{"message": "Server Error"}'     "$(graphql)"
refuses "pr metadata not json"  "SKIP could-not-read-pr"     'HTTP 502'                                   "$(checks)" "$(graphql)"
refuses "pr metadata not object" "SKIP could-not-read-pr"    '[]'                                         "$(checks)" "$(graphql)"

# Usage errors refuse too, rather than printing a payload from nothing.
out=$("$builder" 2>/dev/null); rc=$?
if [[ $rc -ne 0 && "$out" != *"{"* ]]; then ok; else bad "no arguments" "got rc=$rc: ${out:-<empty>}"; fi

echo
echo "should-arm-automerge-input fixtures: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
