#!/usr/bin/env bash
# Pins watch-prs.sh's event vocabulary: every classification branch has a
# fixture, so a refactor that drops or reorders a rule goes red here.
# Run directly, or via the PR-verification checklist when touching the script.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$DIR/watch-prs.sh"
fail=0

check() { # $1 name, $2 fixture json, $3 expected token
  local got
  got=$(printf '%s' "$2" | "$SCRIPT" --classify)
  if [ "$got" != "$3" ]; then
    echo "FAIL $1: expected '$3', got '$got'" >&2
    fail=1
  fi
}

base='{"state":"OPEN","mergeState":"BLOCKED","failing":[],"unresolvedThreads":0,"queued":false,"queuePos":null,"autoMerge":true,"ejectionReason":null,"checksReported":12,"cyclesQueued":0}'

check merged            "$(jq -c '.state="MERGED"' <<<"$base")"                                    "MERGED"
check closed            "$(jq -c '.state="CLOSED"' <<<"$base")"                                    "CLOSED"
check conflicting       "$(jq -c '.mergeState="DIRTY"' <<<"$base")"                                "CONFLICTING"
check failing           "$(jq -c '.failing=["typecheck","test"]' <<<"$base")"                      "FAILING(typecheck,test)"
check ejected           "$(jq -c '.ejectionReason="failed_checks"' <<<"$base")"                    "EJECTED(failed_checks)"
# ejection outranks a red check: the queue drop is the event nothing else reports
check ejected_over_fail "$(jq -c '.ejectionReason="failed_checks" | .failing=["test"]' <<<"$base")" "EJECTED(failed_checks)"
check stalled_queue     "$(jq -c '.queued=true | .checksReported=0 | .cyclesQueued=6' <<<"$base")" "STALLED_IN_QUEUE"
check queued_ok         "$(jq -c '.queued=true | .queuePos=2 | .cyclesQueued=2' <<<"$base")"        "QUEUED(2)"
check threads           "$(jq -c '.unresolvedThreads=3' <<<"$base")"                                "UNRESOLVED_THREADS(3)"
check unarmed_clean     "$(jq -c '.mergeState="CLEAN" | .autoMerge=false' <<<"$base")"              "UNARMED_CLEAN"
check clean_armed       "$(jq -c '.mergeState="CLEAN"' <<<"$base")"                                 "PENDING"
check pending           "$base"                                                                     "PENDING"
# a conflict outranks failing checks: a DIRTY PR gets no CI, so reds are stale
check dirty_over_fail   "$(jq -c '.mergeState="DIRTY" | .failing=["test"]' <<<"$base")"             "CONFLICTING"

if [ "$fail" = 1 ]; then echo "test-watch-prs: FAILED" >&2; exit 1; fi
echo "test-watch-prs: all classifications pinned"
