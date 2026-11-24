#!/usr/bin/env bash
# Pins watch-prs.sh's event vocabulary: every classification branch has a
# fixture, so a refactor that drops or reorders a rule goes red here. Also
# pins the remedy text each token prints, the collector's derivations, and the
# loop's refusal to go quiet when `gh` fails.
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

base='{"state":"OPEN","mergeState":"BLOCKED","failing":[],"unresolvedThreads":0,"queued":false,"queuePos":null,"queueState":null,"autoMerge":true,"ejectionReason":null,"checksReported":12,"cyclesQueued":0}'
unarmed=$(jq -c '.autoMerge=false' <<<"$base")

check merged            "$(jq -c '.state="MERGED"' <<<"$base")"                                    "MERGED"
check closed            "$(jq -c '.state="CLOSED"' <<<"$base")"                                    "CLOSED"
check conflicting       "$(jq -c '.mergeState="DIRTY"' <<<"$base")"                                "CONFLICTING"
check failing           "$(jq -c '.failing=["typecheck","test"]' <<<"$base")"                      "FAILING(typecheck,test)"
check ejected           "$(jq -c '.ejectionReason="failed_checks"' <<<"$base")"                    "EJECTED(failed_checks)"
# ejection outranks a red check: the queue drop is the event nothing else reports
check ejected_over_fail "$(jq -c '.ejectionReason="failed_checks" | .failing=["test"]' <<<"$base")" "EJECTED(failed_checks)"
# the FIRST failed-checks ejection since the last commit is still plain EJECTED
# (85% re-pass unchanged); only a repeat on the same code earns its own token
check ejected_first     "$(jq -c '.ejectionReason="failed_checks" | .failedEjectionsSinceChange=1' <<<"$base")" "EJECTED(failed_checks)"
check ejected_repeat    "$(jq -c '.ejectionReason="failed_checks" | .failedEjectionsSinceChange=2' <<<"$base")" "EJECTED_REPEAT(failed_checks,2)"
check ejected_repeat_k3 "$(jq -c '.ejectionReason="failed_checks" | .failedEjectionsSinceChange=3' <<<"$base")" "EJECTED_REPEAT(failed_checks,3)"
# a repeat count only means something for failed_checks: a conflict is always its own cause
check ejected_conflict  "$(jq -c '.ejectionReason="merge_conflict" | .failedEjectionsSinceChange=4' <<<"$base")" "EJECTED(merge_conflict)"
# STALLED_IN_QUEUE is measured by queue age now. The old input shape (zero
# `gh pr checks` rows for 5 cycles) is unreachable on a real queued PR and must
# no longer mean anything: it reads as the healthy QUEUED it always was.
check stalled_queue     "$(jq -c '.queued=true | .queuePos=1 | .queuedMinutes=120' <<<"$base")"    "STALLED_IN_QUEUE(120)"
check stalled_threshold "$(jq -c '.queued=true | .queuePos=1 | .queuedMinutes=90' <<<"$base")"     "STALLED_IN_QUEUE(90)"
check queued_young      "$(jq -c '.queued=true | .queuePos=1 | .queuedMinutes=89' <<<"$base")"     "QUEUED(1)"
check old_stall_shape   "$(jq -c '.queued=true | .queuePos=4 | .checksReported=0 | .cyclesQueued=6' <<<"$base")" "QUEUED(4)"
check queued_ok         "$(jq -c '.queued=true | .queuePos=2 | .cyclesQueued=2' <<<"$base")"        "QUEUED(2)"
# a queued entry GitHub marked UNMERGEABLE is a stuck dead entry, not a healthy QUEUED
check stuck_unmergeable "$(jq -c '.queued=true | .queuePos=2 | .queueState="UNMERGEABLE"' <<<"$base")" "STUCK_UNMERGEABLE"
# a non-UNMERGEABLE queue state is left untouched: AWAITING_CHECKS is a normal queued PR
check queued_awaiting    "$(jq -c '.queued=true | .queuePos=3 | .queueState="AWAITING_CHECKS"' <<<"$base")" "QUEUED(3)"
# EJECTED still outranks a stuck entry: the queue drop is the more specific cause
check ejected_over_stuck "$(jq -c '.queued=true | .queueState="UNMERGEABLE" | .ejectionReason="failed_checks"' <<<"$base")" "EJECTED(failed_checks)"
# a named red check outranks the generic stuck entry: FAILING points at the actual cause
check fail_over_stuck    "$(jq -c '.queued=true | .queueState="UNMERGEABLE" | .failing=["test"]' <<<"$base")" "FAILING(test)"
# but a stuck entry outranks a stall: UNMERGEABLE is a definite dead entry, not merely slow
check stuck_over_stalled "$(jq -c '.queued=true | .queueState="UNMERGEABLE" | .queuedMinutes=120' <<<"$base")" "STUCK_UNMERGEABLE"
# a cancelled check stalls merge-tail forever (should-arm: cancelled-checks)
check cancelled         "$(jq -c '.cancelled=["review"]' <<<"$unarmed")"                            "CANCELLED(review)"
check fail_over_cancel  "$(jq -c '.cancelled=["review"] | .failing=["lint"]' <<<"$base")"           "FAILING(lint)"
# threads: an armed or queued PR merges with them open, so the token says so
check threads_armed     "$(jq -c '.unresolvedThreads=3' <<<"$base")"                                "UNRESOLVED_THREADS(3,armed)"
check threads_queued    "$(jq -c '.unresolvedThreads=1 | .autoMerge=false | .queued=true | .queuePos=1' <<<"$base")" "UNRESOLVED_THREADS(1,armed)"
check threads           "$(jq -c '.unresolvedThreads=3' <<<"$unarmed")"                             "UNRESOLVED_THREADS(3)"
# a hold label always wins over "green and unarmed": UNARMED_CLEAN used to tell
# the agent to merge a held PR directly
check held_clean        "$(jq -c '.mergeState="CLEAN" | .labels=["hold"]' <<<"$unarmed")"          "HELD_BY_LABEL(hold)"
check held_case         "$(jq -c '.mergeState="CLEAN" | .labels=["docs","WIP"]' <<<"$unarmed")"    "HELD_BY_LABEL(wip)"
check held_do_not_merge "$(jq -c '.labels=["do-not-merge"]' <<<"$unarmed")"                        "HELD_BY_LABEL(do-not-merge)"
check held_armed        "$(jq -c '.labels=["blocked"]' <<<"$base")"                                 "HELD_BY_LABEL(blocked,armed)"
check held_over_threads "$(jq -c '.labels=["hold"] | .unresolvedThreads=2' <<<"$unarmed")"         "HELD_BY_LABEL(hold)"
check not_a_hold_label  "$(jq -c '.mergeState="CLEAN" | .labels=["holdout","skip-changelog"]' <<<"$unarmed")" "AUTO_MERGE_OFF"
# green with auto-merge off: nothing will merge it (the token was UNARMED_CLEAN
# while agents armed PRs by hand; DOR-2558 renamed it for auto-merge at open)
check auto_merge_off    "$(jq -c '.mergeState="CLEAN"' <<<"$unarmed")"                              "AUTO_MERGE_OFF"
# after a failed-checks ejection of this head, re-arming is the ejection's call
check auto_merge_off_ejected "$(jq -c '.mergeState="CLEAN" | .failedEjectionsSinceChange=1' <<<"$unarmed")" "AUTO_MERGE_OFF(ejected,1)"
check auto_merge_off_repeat  "$(jq -c '.mergeState="CLEAN" | .failedEjectionsSinceChange=2' <<<"$unarmed")" "AUTO_MERGE_OFF(ejected,2)"
check auto_merge_off_ejected_reason "$(jq -c '.mergeState="CLEAN" | .failedEjectionsSinceChange=1 | .lastRemovalReasonSinceChange="failed_checks"' <<<"$unarmed")" "AUTO_MERGE_OFF(ejected,1)"
# every queue removal since the last change counts, and carries its reason: a
# manual or timed-out removal is not an ejection to re-queue after
check auto_merge_off_manual  "$(jq -c '.mergeState="CLEAN" | .lastRemovalReasonSinceChange="manual"' <<<"$unarmed")" "AUTO_MERGE_OFF(dequeued,manual)"
check auto_merge_off_timeout "$(jq -c '.mergeState="CLEAN" | .lastRemovalReasonSinceChange="checks_timed_out"' <<<"$unarmed")" "AUTO_MERGE_OFF(dequeued,checks_timed_out)"
# the latest removal wins: a failed ejection then a manual dequeue is manual
check auto_merge_off_manual_last "$(jq -c '.mergeState="CLEAN" | .failedEjectionsSinceChange=1 | .lastRemovalReasonSinceChange="manual"' <<<"$unarmed")" "AUTO_MERGE_OFF(dequeued,manual)"
# UNSTABLE is CLEAN with a non-required check red; only the excluded Vercel
# check reaches here (any other red is FAILING above)
check auto_merge_off_unstable "$(jq -c '.mergeState="UNSTABLE"' <<<"$unarmed")" "AUTO_MERGE_OFF"
check auto_merge_off_unstable_ejected "$(jq -c '.mergeState="UNSTABLE" | .failedEjectionsSinceChange=1' <<<"$unarmed")" "AUTO_MERGE_OFF(ejected,1)"
# threads block nothing now, so a green unarmed PR with threads is still off
check auto_merge_off_over_threads "$(jq -c '.mergeState="CLEAN" | .unresolvedThreads=2' <<<"$unarmed")" "AUTO_MERGE_OFF"
check clean_armed       "$(jq -c '.mergeState="CLEAN"' <<<"$base")"                                 "PENDING"
check pending           "$base"                                                                     "PENDING"
# a conflict outranks failing checks: a DIRTY PR gets no CI, so reds are stale
check dirty_over_fail   "$(jq -c '.mergeState="DIRTY" | .failing=["test"]' <<<"$base")"             "CONFLICTING"

# --- Remedy tier -----------------------------------------------------------
# The line an agent acts on is the remedy printed after the token, so its text
# is pinned too. The rule every remedy obeys: nothing here multiplies load or
# steps around the queue. One push starts 19 to 25 jobs against a 60-job pool
# shared by every agent, and 20 agents obeying one remedy at once is the
# normal case, not the edge case.
remedy_of() { "$SCRIPT" --remedy "$1" 1931; }
remedy_has() { # $1 name, $2 token, $3 fixed string that must appear
  case "$(remedy_of "$2")" in
    *"$3"*) : ;;
    *) echo "FAIL $1: remedy for '$2' lacks '$3': $(remedy_of "$2")" >&2; fail=1 ;;
  esac
}
remedy_lacks() { # $1 name, $2 token, $3 extended regex that must NOT match
  if remedy_of "$2" | grep -Ei -- "$3" >/dev/null; then
    echo "FAIL $1: remedy for '$2' matches /$3/: $(remedy_of "$2")" >&2
    fail=1
  fi
}

ACTIONABLE=(
  'EJECTED(failed_checks)' 'EJECTED_REPEAT(failed_checks,2)' 'EJECTED(merge_conflict)'
  'EJECTED(invalid_merge_commit)' 'EJECTED(git_tree_invalid)' 'EJECTED(manual)'
  'EJECTED(checks_timed_out)' 'EJECTED(something_new)' 'CONFLICTING' 'FAILING(test)'
  'CANCELLED(review)' 'STUCK_UNMERGEABLE' 'STALLED_IN_QUEUE(120)' 'HELD_BY_LABEL(hold)'
  'HELD_BY_LABEL(hold,armed)' 'UNRESOLVED_THREADS(2)' 'UNRESOLVED_THREADS(2,armed)'
  'AUTO_MERGE_OFF' 'AUTO_MERGE_OFF(ejected,1)' 'AUTO_MERGE_OFF(ejected,2)'
  'AUTO_MERGE_OFF(dequeued,manual)' 'AUTO_MERGE_OFF(dequeued,checks_timed_out)'
  'AUTO_MERGE_OFF(dequeued,invalid_merge_commit)' 'HELD_BY_LABEL(blocked,armed)'
  'WATCHER BLIND(3 cycles)'
)
for token in "${ACTIONABLE[@]}"; do
  [ -n "$(remedy_of "$token")" ] || { echo "FAIL remedy_present: '$token' has no remedy" >&2; fail=1; }
  # No remedy anywhere may send an agent around the queue or re-roll CI.
  remedy_lacks no_update_branch "$token" 'update-branch'
  remedy_lacks no_admin "$token" '--admin|break-glass'
  remedy_lacks no_squash_flag "$token" '--squash'
  remedy_lacks no_direct_merge "$token" 'gh pr merge [0-9<]'
  remedy_lacks no_empty_commit_advice "$token" '(^|[^r] )push an empty commit|allow-empty'
  # merge-tail, arm-door and arm.sh are gone from main (DOR-5124)
  remedy_lacks no_retired_arming "$token" 'merge-tail|arm-door|arm\.sh'
done
# Informational tokens print no remedy: each line is a model wakeup.
for token in MERGED CLOSED 'QUEUED(2)' PENDING; do
  [ -z "$(remedy_of "$token")" ] || { echo "FAIL remedy_absent: '$token' has a remedy" >&2; fail=1; }
done
# The first failed-checks ejection is a WAIT, never an action on the branch.
remedy_has wait_on_first_ejection 'EJECTED(failed_checks)' 'Do not push and do not rerun'
remedy_has rearm_after_flake 'EJECTED(failed_checks)' 'gh pr merge --auto 1931'
remedy_has first_ejection_cites_rate 'EJECTED(failed_checks)' '85%'
remedy_has repeat_is_real 'EJECTED_REPEAT(failed_checks,2)' 'treat it as real'
# The same check failing twice on one head is a regression only the queue sees
# (#1964: re-armed unchanged four times, 17 queue builds). Never re-arm it.
remedy_has repeat_not_requeued 'EJECTED_REPEAT(failed_checks,2)' 'do not re-queue it'
remedy_has repeat_names_pr 'EJECTED_REPEAT(failed_checks,2)' 'pr-1931-'
remedy_has timeout_is_not_yours 'EJECTED(checks_timed_out)' 'Do not push and do not rerun'
remedy_has stall_is_not_yours 'STALLED_IN_QUEUE(120)' 'Do not push, rerun or re-queue'
# FAILING: rerun one job for a failure that is not yours; never an empty commit.
remedy_has failing_rerun 'FAILING(test)' 'gh run rerun <run-id> --failed'
remedy_has failing_never_empty 'FAILING(test)' 'Never push an empty commit'
# After an ejection, AUTO_MERGE_OFF never says to turn auto-merge back on:
# the same job failing twice must not be re-armed (#1964).
remedy_lacks ejected_off_no_rearm 'AUTO_MERGE_OFF(ejected,2)' 'gh pr merge'
remedy_has ejected_off_fix 'AUTO_MERGE_OFF(ejected,2)' 'fix it and push'
# one ejection: read the job, then re-queue once if it is plainly not yours
remedy_has ejected_once_requeue 'AUTO_MERGE_OFF(ejected,1)' 'gh pr merge --auto 1931'
remedy_has ejected_once_reads_job 'AUTO_MERGE_OFF(ejected,1)' 'Read the failing merge-group job first'
# a manual or timed-out removal never comes with a command to re-queue
remedy_lacks manual_no_rearm 'AUTO_MERGE_OFF(dequeued,manual)' 'gh pr merge'
remedy_has manual_reads_why 'AUTO_MERGE_OFF(dequeued,manual)' 'on purpose'
remedy_lacks timeout_no_rearm 'AUTO_MERGE_OFF(dequeued,checks_timed_out)' 'gh pr merge'
remedy_has timeout_is_stall 'AUTO_MERGE_OFF(dequeued,checks_timed_out)' 'Do not push or rerun'
remedy_lacks other_removal_no_rearm 'AUTO_MERGE_OFF(dequeued,invalid_merge_commit)' 'gh pr merge'
remedy_has other_removal_names_reason 'AUTO_MERGE_OFF(dequeued,invalid_merge_commit)' 'invalid_merge_commit'
# hold is enforced by the required not-held check; the other hold labels are not
remedy_has hold_armed_not_held 'HELD_BY_LABEL(hold,armed)' 'not-held'
remedy_lacks hold_armed_no_disarm 'HELD_BY_LABEL(hold,armed)' 'disable-auto'
remedy_has held_armed_disarm 'HELD_BY_LABEL(blocked,armed)' 'gh pr merge --disable-auto 1931'
remedy_has blind_names_checks 'WATCHER BLIND(3 cycles)' 'gh auth status'
# Without a PR the placeholder stays readable.
case "$("$SCRIPT" --remedy 'EJECTED(merge_conflict)')" in
  *'gh pr merge --auto <n>'*) : ;;
  *) echo "FAIL remedy_placeholder: expected '<n>' without a PR" >&2; fail=1 ;;
esac

# --- Probe-seam tier -------------------------------------------------------
# The classify() tier above never touches the collection code that builds its
# input, so it could not have caught DOR-1630: `gh pr checks` exits 1 on a
# real failure and 8 while pending — BY DESIGN — and the old collector piped
# that command straight into awk/grep/jq, letting `gh`'s own exit code ride
# `set -o pipefail` into the `|| failing='[]'` fallback and wipe out a
# genuinely-collected failing-checks list exactly when there was one to
# report. This tier drives the REAL collection path (snapshot(), via the
# read-only `--probe PR` seam) against a stubbed `gh` placed earlier on PATH,
# so it exercises the exact command substitutions the bug lived in.
STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

cat > "$STUB_DIR/gh" <<'STUBEOF'
#!/usr/bin/env bash
# Canned `gh` for the probe-seam tests. Scenario is driven by env vars:
#   STUB_GH_CHECKS_OUTPUT  literal `gh pr checks` stdout (TSV; may be empty)
#   STUB_GH_CHECKS_EXIT    exit code `gh pr checks` should return
set -euo pipefail
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  if [ "${STUB_GH_REPO_VIEW_FAIL:-0}" = "1" ]; then
    exit 1
  fi
  echo '{"owner":{"login":"acme"},"name":"repo"}'
  exit 0
fi
if [ "$1" = "api" ]; then
  # STUB_GH_API_FAIL=1 makes the GraphQL call die the way a logged-out or
  # rate-limited `gh` does, for the WATCHER BLIND loop tier.
  if [ "${STUB_GH_API_FAIL:-0}" = "1" ]; then
    echo "HTTP 401: Bad credentials" >&2
    exit 1
  fi
  # The PR number is the `-F n=<pr>` argument.
  pr=""
  for arg in "$@"; do case "$arg" in n=*) pr=${arg#n=} ;; esac; done
  # STUB_GH_API_SEQ is a directory of 1.json, 2.json, ...: call k answers with
  # k.json, and the last file keeps answering after that, so a PR can change
  # state between cycles (an ejection only counts once the watcher has seen
  # the PR without it).
  if [ -n "${STUB_GH_API_SEQ:-}" ]; then
    k=$(( $(cat "$STUB_GH_API_SEQ/count" 2>/dev/null || echo 0) + 1 ))
    echo "$k" > "$STUB_GH_API_SEQ/count"
    [ -f "$STUB_GH_API_SEQ/$k.json" ] || k=$(ls "$STUB_GH_API_SEQ" | grep -c '\.json$')
    cat "$STUB_GH_API_SEQ/$k.json"
    exit 0
  fi
  # STUB_GH_API_JSON_<pr> answers for one PR when several are watched.
  per_pr="STUB_GH_API_JSON_$pr"
  if [ -n "$pr" ] && [ -n "${!per_pr:-}" ]; then
    printf '%s\n' "${!per_pr}"
    exit 0
  fi
  # STUB_GH_API_JSON overrides the PR shape; the default is one fixed,
  # uninteresting PR, because most of this tier is only about how `failing`
  # and `checksReported` get collected, not about classify() precedence.
  if [ -n "${STUB_GH_API_JSON:-}" ]; then
    printf '%s\n' "$STUB_GH_API_JSON"
    exit 0
  fi
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"state":"OPEN","mergeStateStatus":"BLOCKED","autoMergeRequest":{"enabledAt":"2026-01-01T00:00:00Z"},"mergeQueueEntry":null,"reviewThreads":{"nodes":[]},"timelineItems":{"nodes":[]}}}}}
JSON
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  if [ -n "${STUB_GH_CHECKS_OUTPUT:-}" ]; then
    printf '%s\n' "$STUB_GH_CHECKS_OUTPUT"
  fi
  exit "${STUB_GH_CHECKS_EXIT:-0}"
fi
echo "stub gh: unhandled invocation: $*" >&2
exit 99
STUBEOF
chmod +x "$STUB_DIR/gh"

probe_check() { # $1 name, $2 checks stdout, $3 checks exit, $4 expected failing json,
                 # $5 expected checksReported, $6 expected script exit (default 0),
                 # $7 expected .state (default OPEN)
  local expected_script_exit="${6:-0}"
  local expected_state="${7:-OPEN}"
  local snap script_exit
  script_exit=0
  snap=$(STUB_GH_CHECKS_OUTPUT="$2" STUB_GH_CHECKS_EXIT="$3" PATH="$STUB_DIR:$PATH" "$SCRIPT" --probe 42) || script_exit=$?
  if [ "$script_exit" != "$expected_script_exit" ]; then
    echo "FAIL $1 (script exit): expected '$expected_script_exit', got '$script_exit'" >&2
    fail=1
  fi
  local got_state
  got_state=$(jq -r .state <<<"$snap")
  if [ "$got_state" != "$expected_state" ]; then
    echo "FAIL $1 (state): expected '$expected_state', got '$got_state'" >&2
    fail=1
  fi
  # An ERR snapshot is only the {"state":"ERR"} sentinel — no failing/
  # checksReported fields exist to compare, ERR is the whole signal.
  if [ "$expected_state" = "ERR" ]; then
    return
  fi
  local got_failing got_reported
  got_failing=$(jq -c .failing <<<"$snap")
  got_reported=$(jq -r .checksReported <<<"$snap")
  if [ "$got_failing" != "$4" ]; then
    echo "FAIL $1 (failing): expected '$4', got '$got_failing'" >&2
    fail=1
  fi
  if [ "$got_reported" != "$5" ]; then
    echo "FAIL $1 (checksReported): expected '$5', got '$got_reported'" >&2
    fail=1
  fi
}

CHECKS_PASS=$'typecheck\tpass\t1s\turl\tok\nbuild\tpass\t2s\turl\tok'
CHECKS_FAIL_NONVERCEL=$'typecheck\tfail\t1s\turl\tbroke\nbuild\tpass\t2s\turl\tok'
CHECKS_FAIL_VERCEL_ONLY=$'Vercel\tfail\t1s\turl\tbroke\nbuild\tpass\t2s\turl\tok'
CHECKS_PENDING=$'typecheck\tpending\t0s\turl\t\nbuild\tpass\t2s\turl\tok'

probe_check probe_all_pass         "$CHECKS_PASS"             0 '[]'            2
# THE regression cell: gh exits 1 on a real failure. Fails against the
# unfixed script, where the pipefail bug wipes this back to '[]'.
probe_check probe_nonvercel_fail   "$CHECKS_FAIL_NONVERCEL"   1 '["typecheck"]' 2
probe_check probe_vercel_only_fail "$CHECKS_FAIL_VERCEL_ONLY" 1 '[]'            2
probe_check probe_checks_pending   "$CHECKS_PENDING"          8 '[]'            2
# Empty stdout + an exit code `gh pr checks` actually uses (0, 1, or 8) is a
# real zero-check PR, NOT a dead call — gh's exit code tracks the checks
# bucket, not whether any checks exist. Must read as a normal empty snapshot:
# no ERR, exit 0.
probe_check probe_zero_check_pr    ""                         8 '[]'            0
# Empty stdout + an exit code OUTSIDE {0,1,8}: gh itself failed to talk to
# GitHub (auth, network, rate limit — 4 stands in for "something else" here).
# Must NOT read as a healthy zero-check PR: emits the {"state":"ERR"}
# sentinel and a non-zero script exit so the watch loop's transient-retry
# path owns it instead of reporting a false-healthy PENDING forever.
probe_check probe_gh_hard_failure  ""                         4 '[]'            0 1 ERR

# Cancelled checks are collected beside failures (merge-tail refuses both).
CHECKS_CANCEL=$'review\tcancel\t0s\turl\t\nbuild\tpass\t2s\turl\tok'
cancel_snap=$(STUB_GH_CHECKS_OUTPUT="$CHECKS_CANCEL" STUB_GH_CHECKS_EXIT=0 PATH="$STUB_DIR:$PATH" "$SCRIPT" --probe 42)
[ "$(jq -c .cancelled <<<"$cancel_snap")" = '["review"]' ] || { echo "FAIL probe_cancelled: $(jq -c .cancelled <<<"$cancel_snap")" >&2; fail=1; }

# The collector's own derivations from the GraphQL shape: every unresolved
# thread counts (outdated too, like merge-tail); labels come through; queue
# age is computed from enqueuedAt; and only failed-checks ejections AFTER the
# last commit or force-push count toward a repeat.
RICH_PR='{"data":{"repository":{"pullRequest":{"state":"OPEN","mergeStateStatus":"BLOCKED","isDraft":false,
  "labels":{"nodes":[{"name":"hold"}]},"autoMergeRequest":null,
  "mergeQueueEntry":{"position":1,"state":"AWAITING_CHECKS","enqueuedAt":"2020-01-01T00:00:00Z"},
  "reviewThreads":{"nodes":[{"isResolved":false,"isOutdated":true},{"isResolved":false,"isOutdated":false},{"isResolved":true,"isOutdated":false}]},
  "timelineItems":{"nodes":[
    {"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-08-25T04:00:00Z","reason":"failed_checks"},
    {"__typename":"PullRequestCommit"},
    {"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-08-25T05:00:00Z","reason":"failed_checks"},
    {"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-08-25T06:00:00Z","reason":"manual"},
    {"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-08-25T07:00:00Z","reason":"failed_checks"}]}}}}}'
rich=$(STUB_GH_API_JSON="$RICH_PR" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 PATH="$STUB_DIR:$PATH" "$SCRIPT" --probe 42)
probe_field() { # $1 name, $2 jq filter, $3 expected
  local got
  got=$(jq -c "$2" <<<"$rich")
  [ "$got" = "$3" ] || { echo "FAIL $1: expected '$3', got '$got'" >&2; fail=1; }
}
probe_field probe_threads_include_outdated .unresolvedThreads 2
probe_field probe_labels .labels '["hold"]'
probe_field probe_repeat_since_change .failedEjectionsSinceChange 2
probe_field probe_removals_since_change .removalsSinceChange 3
probe_field probe_last_removal_since_change .lastRemovalReasonSinceChange '"failed_checks"'
probe_field probe_last_ejection .lastEjectionReason '"failed_checks"'
probe_field probe_queue_age_known '.queuedMinutes > 1000' true
# A force-push is a change too: nothing after it means no repeat.
FORCE_PUSHED=$(jq -c '.data.repository.pullRequest.timelineItems.nodes += [{"__typename":"HeadRefForcePushedEvent"}]' <<<"$RICH_PR")
rich=$(STUB_GH_API_JSON="$FORCE_PUSHED" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 PATH="$STUB_DIR:$PATH" "$SCRIPT" --probe 42)
probe_field probe_force_push_resets .failedEjectionsSinceChange 0
probe_field probe_force_push_resets_removals .removalsSinceChange 0
probe_field probe_force_push_resets_reason .lastRemovalReasonSinceChange null
# No queue entry means no queue age, never a crash.
rich=$(STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 PATH="$STUB_DIR:$PATH" "$SCRIPT" --probe 42)
probe_field probe_unqueued_age .queuedMinutes null

# --- Argument-validation tier -----------------------------------------------
# Help and malformed options must finish before either external side effect in
# the watch path. These stubs turn an accidental `gh` or `sleep` invocation into
# an immediate, recorded failure instead of touching GitHub or hanging the test.
NO_SIDE_EFFECT_DIR="$STUB_DIR/no-side-effects"
mkdir "$NO_SIDE_EFFECT_DIR"
SIDE_EFFECT_LOG="$STUB_DIR/side-effects.log"
for command in gh sleep; do
  cat > "$NO_SIDE_EFFECT_DIR/$command" <<'STUBEOF'
#!/usr/bin/env bash
printf '%s\n' "${0##*/}" >> "$SIDE_EFFECT_LOG"
exit 97
STUBEOF
  chmod +x "$NO_SIDE_EFFECT_DIR/$command"
done

arg_check() { # $1 name, $2 expected exit, $3 stdout kind, remaining args = argv
  local name="$1" expected_exit="$2" stdout_kind="$3"
  shift 3
  local out_file="$STUB_DIR/$name.out" err_file="$STUB_DIR/$name.err" exit_code=0
  : > "$SIDE_EFFECT_LOG"
  SIDE_EFFECT_LOG="$SIDE_EFFECT_LOG" PATH="$NO_SIDE_EFFECT_DIR:$PATH" \
    "$SCRIPT" "$@" >"$out_file" 2>"$err_file" || exit_code=$?
  if [ "$exit_code" != "$expected_exit" ]; then
    echo "FAIL $name: expected exit '$expected_exit', got '$exit_code'" >&2
    fail=1
  fi
  case "$stdout_kind" in
    help)
      if [ "$(cat "$out_file")" != "usage: watch-prs.sh [--interval s] [--max-cycles n] [--once] [--exit-on-action | --no-exit-on-action] PR... | --classify | --remedy TOKEN [PR] | --probe PR" ] || [ -s "$err_file" ]; then
        echo "FAIL $name: help must print only usage on stdout" >&2
        fail=1
      fi ;;
    error)
      if [ -s "$out_file" ] || ! grep -q '^usage:' "$err_file"; then
        echo "FAIL $name: invalid input must print usage only on stderr" >&2
        fail=1
      fi ;;
  esac
  if [ -s "$SIDE_EFFECT_LOG" ]; then
    echo "FAIL $name: invoked forbidden command(s): $(tr '\n' ' ' < "$SIDE_EFFECT_LOG")" >&2
    fail=1
  fi
}

arg_check help_long 0 help --help
arg_check help_short 0 help -h
arg_check unknown_option 2 error --wat
arg_check unknown_short_option 2 error -x
arg_check missing_pr 2 error
arg_check probe_missing_pr 2 error --probe
arg_check probe_next_option 2 error --probe --once
arg_check probe_next_short_option 2 error --probe -h
arg_check probe_extra_arg 2 error --probe 42 43
arg_check remedy_missing_token 2 error --remedy
arg_check interval_missing 2 error --interval
arg_check interval_next_option 2 error --interval --once 42
arg_check interval_zero 2 error --interval 0 42
arg_check interval_non_numeric 2 error --interval soon 42
arg_check interval_mixed_suffix 2 error --interval 12oops 42
arg_check interval_leading_zero 2 error --interval 012 42
arg_check interval_overflow 2 error --interval 2147483648 42
arg_check interval_giant 2 error --interval 999999999999999999999999999999 42
arg_check max_cycles_missing 2 error --max-cycles
arg_check max_cycles_next_option 2 error --max-cycles --once 42
arg_check max_cycles_negative 2 error --max-cycles -1 42
arg_check max_cycles_non_numeric 2 error --max-cycles many 42
arg_check max_cycles_mixed_suffix 2 error --max-cycles 12oops 42
arg_check max_cycles_leading_zero 2 error --max-cycles 012 42
arg_check max_cycles_overflow 2 error --max-cycles 2147483648 42
arg_check max_cycles_giant 2 error --max-cycles 999999999999999999999999999999 42

# The bounded valid modes still reach the existing collector. `--once` exits
# before sleeping; `--max-cycles 1` expires before sleeping while retaining 0
# as the documented unbounded value.
valid_watch_check() { # $1 name, $2 expected exit, remaining args = argv
  local name="$1" expected_exit="$2" expected_output="$3"
  shift 3
  local exit_code=0 out
  out=$(STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 PATH="$STUB_DIR:$PATH" "$SCRIPT" "$@") || exit_code=$?
  if [ "$exit_code" != "$expected_exit" ]; then
    echo "FAIL $name: expected exit '$expected_exit', got '$exit_code'" >&2
    fail=1
  fi
  if [ "$out" != "$expected_output" ]; then
    echo "FAIL $name: expected output '$expected_output', got '$out'" >&2
    fail=1
  fi
}
valid_watch_check valid_once 0 "" --interval 1 --once 42
valid_watch_check valid_bounded_watch 3 "WATCHER EXPIRED after 1 cycles — PRs still open; check them directly" --max-cycles 1 42

# --- Loop tier: a watcher that cannot see must say so --------------------------
# A failing GraphQL call used to be retried in silence forever, so a logged-out
# or rate-limited watcher looked exactly like a quiet healthy one. It now
# prints ONE `WATCHER BLIND` line after 3 failed cycles (not one per cycle),
# and a --once watcher says it on its only cycle. `sleep` is stubbed to a
# no-op so the loop runs its cycles without waiting. Captured stdout is not a
# TTY, so exit-on-action is on by default: the streaming cells pass
# --no-exit-on-action, and the default cells expect exit 10 and the summary.
LOOP_DIR="$STUB_DIR/loop"
mkdir "$LOOP_DIR"
printf '#!/usr/bin/env bash\nexit 0\n' > "$LOOP_DIR/sleep"
chmod +x "$LOOP_DIR/sleep"
blind_check() { # $1 name, $2 expected exit, $3 expected stdout, remaining args = argv
  local name="$1" expected_exit="$2" expected_output="$3"
  shift 3
  local exit_code=0 out
  out=$(STUB_GH_API_FAIL=1 STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
    PATH="$LOOP_DIR:$STUB_DIR:$PATH" "$SCRIPT" "$@") || exit_code=$?
  [ "$exit_code" = "$expected_exit" ] || { echo "FAIL $name: expected exit '$expected_exit', got '$exit_code'" >&2; fail=1; }
  [ "$out" = "$expected_output" ] || { echo "FAIL $name: expected output '$expected_output', got '$out'" >&2; fail=1; }
}
BLIND_REMEDY=$("$SCRIPT" --remedy 'WATCHER BLIND(3 cycles)' 42)
blind_check blind_after_three_cycles 3 "PR #42 -> WATCHER BLIND(3 cycles) :: $BLIND_REMEDY
WATCHER EXPIRED after 5 cycles — PRs still open; check them directly" --no-exit-on-action --interval 1 --max-cycles 5 42
blind_check blind_once 10 "PR #42 -> WATCHER BLIND(1 cycles) :: $("$SCRIPT" --remedy 'WATCHER BLIND(1 cycles)' 42)
NEEDS ACTION: PR #42 WATCHER BLIND(1 cycles). Act on each line above, then re-launch the watcher for any PR still open." --once 42
blind_check blind_short_watch 3 "PR #42 -> WATCHER BLIND(2 cycles) :: $("$SCRIPT" --remedy 'WATCHER BLIND(2 cycles)' 42)
WATCHER EXPIRED after 2 cycles — PRs still open; check them directly" --no-exit-on-action --interval 1 --max-cycles 2 42
# A background watcher that goes blind wakes you on the cycle it says so.
blind_check blind_wakes_background 10 "PR #42 -> WATCHER BLIND(3 cycles) :: $BLIND_REMEDY
NEEDS ACTION: PR #42 WATCHER BLIND(3 cycles). Act on each line above, then re-launch the watcher for any PR still open." --interval 1 --max-cycles 5 42

# A reported line carries its remedy after ` :: `, from the same remedy() the
# --remedy seam prints, so the two cannot drift.
HELD_PR='{"data":{"repository":{"pullRequest":{"state":"OPEN","mergeStateStatus":"CLEAN","labels":{"nodes":[{"name":"hold"}]},"autoMergeRequest":null,"mergeQueueEntry":null,"reviewThreads":{"nodes":[]},"timelineItems":{"nodes":[]}}}}}'
held_out=$(STUB_GH_API_JSON="$HELD_PR" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 PATH="$STUB_DIR:$PATH" "$SCRIPT" --once 42) || true
[ "$held_out" = "PR #42 -> HELD_BY_LABEL(hold) :: $("$SCRIPT" --remedy 'HELD_BY_LABEL(hold)' 42)" ] || {
  echo "FAIL held_line: got '$held_out'" >&2; fail=1; }

# --- Exit-on-action tier (DOR-2558) -------------------------------------------
# A harness tells an agent about a background shell only when it EXITS, so a
# watcher that keeps looping after a PR needs action writes its best line to a
# file nobody reads (#2333 and #2335 sat ejected and conflicting for hours).
# With stdout not a TTY (a background task, a pipe, this test's capture),
# exit-on-action is on by default: the watcher finishes the cycle, so every PR
# gets its line, then prints one NEEDS ACTION summary and exits 5. On a TTY it
# streams as before. `sleep` is a no-op, so an unfixed watcher would run on to
# its WATCHER EXPIRED line (exit 3) instead.
pr_json() { # $1 mergeStateStatus, $2 autoMergeRequest json, $3 timeline nodes json
  printf '{"data":{"repository":{"pullRequest":{"state":"OPEN","mergeStateStatus":"%s","labels":{"nodes":[]},"autoMergeRequest":%s,"mergeQueueEntry":null,"reviewThreads":{"nodes":[]},"timelineItems":{"nodes":%s}}}}}' "$1" "$2" "$3"
}
ARMED='{"enabledAt":"2026-01-01T00:00:00Z"}'
SUMMARY_TAIL=". Act on each line above, then re-launch the watcher for any PR still open."
action_check() { # $1 name, $2 expected exit, $3 expected stdout, remaining args = argv
  local name="$1" expected_exit="$2" expected_output="$3"
  shift 3
  local exit_code=0 out
  out=$(PATH="$LOOP_DIR:$STUB_DIR:$PATH" "$SCRIPT" "$@") || exit_code=$?
  [ "$exit_code" = "$expected_exit" ] || { echo "FAIL $name: expected exit '$expected_exit', got '$exit_code'" >&2; fail=1; }
  [ "$out" = "$expected_output" ] || { echo "FAIL $name: expected output '$expected_output', got '$out'" >&2; fail=1; }
}
line_for() { # $1 PR, $2 token: the report line the loop prints
  printf 'PR #%s -> %s :: %s' "$1" "$2" "$("$SCRIPT" --remedy "$2" "$1")"
}

# CONFLICTING
STUB_GH_API_JSON="$(pr_json DIRTY "$ARMED" '[]')" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
  action_check exit_conflicting 10 "$(line_for 42 CONFLICTING)
NEEDS ACTION: PR #42 CONFLICTING$SUMMARY_TAIL" --interval 1 --max-cycles 3 42
# FAILING
STUB_GH_API_JSON="$(pr_json BLOCKED "$ARMED" '[]')" STUB_GH_CHECKS_OUTPUT="$CHECKS_FAIL_NONVERCEL" STUB_GH_CHECKS_EXIT=1 \
  action_check exit_failing 10 "$(line_for 42 'FAILING(typecheck)')
NEEDS ACTION: PR #42 FAILING(typecheck)$SUMMARY_TAIL" --interval 1 --max-cycles 3 42
# AUTO_MERGE_OFF: green, and nothing is going to merge it
STUB_GH_API_JSON="$(pr_json CLEAN null '[]')" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
  action_check exit_auto_merge_off 10 "$(line_for 42 AUTO_MERGE_OFF)
NEEDS ACTION: PR #42 AUTO_MERGE_OFF$SUMMARY_TAIL" --interval 1 --max-cycles 3 42
# CANCELLED: a cancelled check never turns green by itself
STUB_GH_API_JSON="$(pr_json BLOCKED "$ARMED" '[]')" STUB_GH_CHECKS_OUTPUT="$CHECKS_CANCEL" STUB_GH_CHECKS_EXIT=0 \
  action_check exit_cancelled 10 "$(line_for 42 'CANCELLED(review)')
NEEDS ACTION: PR #42 CANCELLED(review)$SUMMARY_TAIL" --interval 1 --max-cycles 3 42
# EJECTED: an ejection counts only once the watcher saw the PR without it, so
# cycle 1 is a quiet queued PR and cycle 2 carries the removal event.
SEQ_DIR="$STUB_DIR/seq-ejected"
mkdir "$SEQ_DIR"
pr_json BLOCKED "$ARMED" '[]' > "$SEQ_DIR/1.json"
pr_json BLOCKED null '[{"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-08-25T04:00:00Z","reason":"failed_checks"}]' > "$SEQ_DIR/2.json"
STUB_GH_API_SEQ="$SEQ_DIR" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
  action_check exit_ejected 10 "$(line_for 42 'EJECTED(failed_checks)')
NEEDS ACTION: PR #42 EJECTED(failed_checks)$SUMMARY_TAIL" --interval 1 --max-cycles 4 42

# A relaunch after an ejection sees a green PR with auto-merge off. It wakes
# you with the ejection's own advice (read the job, re-queue once if it is not
# yours), never a bare "turn it back on"; if you chose to wait, you leave the
# PR out of the relaunch.
EJECTED_GREEN='{"data":{"repository":{"pullRequest":{"state":"OPEN","mergeStateStatus":"CLEAN","labels":{"nodes":[]},"autoMergeRequest":null,"mergeQueueEntry":null,"reviewThreads":{"nodes":[]},"timelineItems":{"nodes":[{"__typename":"PullRequestCommit"},{"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-08-25T04:00:00Z","reason":"failed_checks"}]}}}}}'
STUB_GH_API_JSON="$EJECTED_GREEN" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
  action_check relaunch_after_ejection 10 "$(line_for 42 'AUTO_MERGE_OFF(ejected,1)')
NEEDS ACTION: PR #42 AUTO_MERGE_OFF(ejected,1)$SUMMARY_TAIL" --interval 1 --max-cycles 2 42
# The collector carries a manual removal through to the token, end to end.
DEQUEUED_GREEN='{"data":{"repository":{"pullRequest":{"state":"OPEN","mergeStateStatus":"CLEAN","labels":{"nodes":[]},"autoMergeRequest":null,"mergeQueueEntry":null,"reviewThreads":{"nodes":[]},"timelineItems":{"nodes":[{"__typename":"PullRequestCommit"},{"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-08-25T04:00:00Z","reason":"failed_checks"},{"__typename":"RemovedFromMergeQueueEvent","createdAt":"2026-08-25T05:00:00Z","reason":"manual"}]}}}}}'
STUB_GH_API_JSON="$DEQUEUED_GREEN" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
  action_check relaunch_after_dequeue 10 "$(line_for 42 'AUTO_MERGE_OFF(dequeued,manual)')
NEEDS ACTION: PR #42 AUTO_MERGE_OFF(dequeued,manual)$SUMMARY_TAIL" --interval 1 --max-cycles 2 42

# States that need nobody's hand do not end the watch: a held PR waits for
# whoever set the label, a pending one for its checks.
HELD_ARMED='{"data":{"repository":{"pullRequest":{"state":"OPEN","mergeStateStatus":"BLOCKED","labels":{"nodes":[{"name":"hold"}]},"autoMergeRequest":null,"mergeQueueEntry":null,"reviewThreads":{"nodes":[]},"timelineItems":{"nodes":[]}}}}}'
STUB_GH_API_JSON="$HELD_ARMED" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
  action_check held_keeps_watching 3 "$(line_for 42 'HELD_BY_LABEL(hold)')
WATCHER EXPIRED after 2 cycles — PRs still open; check them directly" --interval 1 --max-cycles 2 42

# Several PRs: the cycle finishes first, so the healthy PR is still read and
# the summary names only the PR that needs action.
STUB_GH_API_JSON_41="$(pr_json BLOCKED "$ARMED" '[]')" STUB_GH_API_JSON_42="$(pr_json DIRTY "$ARMED" '[]')" \
  STUB_GH_API_JSON_43="$(pr_json CLEAN null '[]')" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
  action_check exit_names_each_pr 10 "$(line_for 42 CONFLICTING)
$(line_for 43 AUTO_MERGE_OFF)
NEEDS ACTION: PR #42 CONFLICTING, PR #43 AUTO_MERGE_OFF$SUMMARY_TAIL" --interval 1 --max-cycles 3 41 42 43

# --no-exit-on-action keeps the old streaming watch off a TTY (for Monitor).
STUB_GH_API_JSON="$(pr_json DIRTY "$ARMED" '[]')" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
  action_check no_exit_streams 3 "$(line_for 42 CONFLICTING)
WATCHER EXPIRED after 2 cycles — PRs still open; check them directly" --no-exit-on-action --interval 1 --max-cycles 2 42

# The TTY default, through a real pseudo-terminal: the watcher's stdout is a
# TTY, so it streams and expires instead of exiting on the conflict;
# --exit-on-action turns it back on there. Python's pty module, not script(1):
# BSD and util-linux script differ in flags and in how they treat a closed
# stdin, and this runs the same way on macOS and on the Linux runners.
command -v python3 >/dev/null || { echo "test-watch-prs: the TTY cells need python3 on PATH" >&2; exit 1; }
in_tty() { # argv = command; prints its output (\r removed) and exits with its code
  python3 -c '
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out = b""
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
sys.stdout.buffer.write(out.replace(b"\r", b""))
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
' "$@"
}
tty_check() { # $1 name, $2 expected exit, $3 expected last line, remaining args = watcher argv
  local name="$1" expected_exit="$2" expected_last="$3"
  shift 3
  local exit_code=0 out
  out=$(set -o pipefail; STUB_GH_API_JSON="$(pr_json DIRTY "$ARMED" '[]')" STUB_GH_CHECKS_OUTPUT="$CHECKS_PASS" STUB_GH_CHECKS_EXIT=0 \
    PATH="$LOOP_DIR:$STUB_DIR:$PATH" in_tty "$SCRIPT" "$@") || exit_code=$?
  [ "$exit_code" = "$expected_exit" ] || { echo "FAIL $name: expected exit '$expected_exit', got '$exit_code' (output: $out)" >&2; fail=1; }
  [ "$(printf '%s\n' "$out" | grep -v '^$' | tail -1)" = "$expected_last" ] || {
    echo "FAIL $name: expected last line '$expected_last', got: $out" >&2; fail=1; }
  case "$out" in *"$(line_for 42 CONFLICTING)"*) : ;; *) echo "FAIL $name: no CONFLICTING line: $out" >&2; fail=1 ;; esac
}
tty_check tty_default_streams 3 "WATCHER EXPIRED after 2 cycles — PRs still open; check them directly" --interval 1 --max-cycles 2 42
tty_check tty_exit_on_action 10 "NEEDS ACTION: PR #42 CONFLICTING$SUMMARY_TAIL" --exit-on-action --interval 1 --max-cycles 2 42

# AUTO_MERGE_OFF's remedy reads main's ci/required-checks.json the way
# scripts/open-pr.sh does: once main requires not-held, release-window and
# pr-gates, auto-merge is safe to turn back on; before that, the maintainer
# merges and nobody arms by hand. A copy of the watcher in a scratch repo reads
# that repo's origin/main, so both answers run the real lookup.
remedy_repo() { # $1 dir, $2 required contexts json array
  mkdir -p "$1/ci"
  cp "$SCRIPT" "$1/watch-prs.sh"
  printf '{"contexts":%s}\n' "$2" > "$1/ci/required-checks.json"
  git -C "$1" init -q
  git -C "$1" add ci/required-checks.json
  git -C "$1" -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null commit -qm fixture
  git -C "$1" update-ref refs/remotes/origin/main HEAD
}
remedy_repo "$STUB_DIR/live" '["typecheck","not-held","release-window","pr-gates"]'
remedy_repo "$STUB_DIR/not-live" '["typecheck","not-held","release-window"]'
live=$("$STUB_DIR/live/watch-prs.sh" --remedy AUTO_MERGE_OFF 1931)
not_live=$("$STUB_DIR/not-live/watch-prs.sh" --remedy AUTO_MERGE_OFF 1931)
mkdir "$STUB_DIR/no-repo"
cp "$SCRIPT" "$STUB_DIR/no-repo/watch-prs.sh"
unreadable=$(GIT_CEILING_DIRECTORIES="$STUB_DIR" "$STUB_DIR/no-repo/watch-prs.sh" --remedy AUTO_MERGE_OFF 1931)
has() { # $1 name, $2 text, $3 fixed string that must appear
  case "$2" in *"$3"*) : ;; *) echo "FAIL $1: lacks '$3': $2" >&2; fail=1 ;; esac
}
lacks() { # $1 name, $2 text, $3 fixed string that must NOT appear
  case "$2" in *"$3"*) echo "FAIL $1: has '$3': $2" >&2; fail=1 ;; *) : ;; esac
}
has live_turns_it_on "$live" 'gh pr merge --auto 1931'
# Only the three sanctioned uses of `gh pr merge --auto` (contributing/ci.md).
has live_after_ejection "$live" 'ejected for a failure plainly not yours'
has live_pre_nov24 "$live" 'opened before Nov 24'
has live_draft_or_hold "$live" 'a draft you marked ready or a hold you lifted'
has live_never_direct "$live" 'Never merge it directly'
has not_live_names_gate "$not_live" 'pr-gates'
has not_live_maintainer "$not_live" 'the maintainer merges it'
lacks not_live_no_arm_command "$not_live" 'gh pr merge'
has unreadable_maintainer "$unreadable" 'the maintainer merges it'
lacks unreadable_no_arm_command "$unreadable" 'gh pr merge'

# --- `gh repo view` death tier -----------------------------------------------
# SKILL.md's rule for this script: "a watcher that dies must say so." This is
# the one call with no {"state":"ERR"}-and-retry path below it, so its
# failure has to be its own announced exit rather than a wall of silence.
repo_view_guard_check() {
  local out exit_code
  exit_code=0
  out=$(STUB_GH_REPO_VIEW_FAIL=1 PATH="$STUB_DIR:$PATH" "$SCRIPT" --probe 42 2>&1) || exit_code=$?
  if [ "$exit_code" != 4 ]; then
    echo "FAIL repo_view_guard (exit): expected '4', got '$exit_code'" >&2
    fail=1
  fi
  case "$out" in
    *"WATCHER DIED"*) : ;;
    *)
      echo "FAIL repo_view_guard (message): expected output to mention WATCHER DIED, got: $out" >&2
      fail=1 ;;
  esac
}
repo_view_guard_check

if [ "$fail" = 1 ]; then echo "test-watch-prs: FAILED" >&2; exit 1; fi
echo "test-watch-prs: all classifications, remedies, probe-seam, loop and exit-on-action scenarios pinned"
