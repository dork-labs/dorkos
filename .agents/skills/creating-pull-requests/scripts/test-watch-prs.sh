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

base='{"state":"OPEN","mergeState":"BLOCKED","failing":[],"unresolvedThreads":0,"queued":false,"queuePos":null,"queueState":null,"autoMerge":true,"ejectionReason":null,"checksReported":12,"cyclesQueued":0}'

check merged            "$(jq -c '.state="MERGED"' <<<"$base")"                                    "MERGED"
check closed            "$(jq -c '.state="CLOSED"' <<<"$base")"                                    "CLOSED"
check conflicting       "$(jq -c '.mergeState="DIRTY"' <<<"$base")"                                "CONFLICTING"
check failing           "$(jq -c '.failing=["typecheck","test"]' <<<"$base")"                      "FAILING(typecheck,test)"
check ejected           "$(jq -c '.ejectionReason="failed_checks"' <<<"$base")"                    "EJECTED(failed_checks)"
# ejection outranks a red check: the queue drop is the event nothing else reports
check ejected_over_fail "$(jq -c '.ejectionReason="failed_checks" | .failing=["test"]' <<<"$base")" "EJECTED(failed_checks)"
check stalled_queue     "$(jq -c '.queued=true | .checksReported=0 | .cyclesQueued=6' <<<"$base")" "STALLED_IN_QUEUE"
check queued_ok         "$(jq -c '.queued=true | .queuePos=2 | .cyclesQueued=2' <<<"$base")"        "QUEUED(2)"
# a queued entry GitHub marked UNMERGEABLE is a stuck dead entry, not a healthy QUEUED
check stuck_unmergeable "$(jq -c '.queued=true | .queuePos=2 | .queueState="UNMERGEABLE"' <<<"$base")" "STUCK_UNMERGEABLE"
# a non-UNMERGEABLE queue state is left untouched: AWAITING_CHECKS is a normal queued PR
check queued_awaiting    "$(jq -c '.queued=true | .queuePos=3 | .queueState="AWAITING_CHECKS"' <<<"$base")" "QUEUED(3)"
# EJECTED still outranks a stuck entry: the queue drop is the more specific cause
check ejected_over_stuck "$(jq -c '.queued=true | .queueState="UNMERGEABLE" | .ejectionReason="failed_checks"' <<<"$base")" "EJECTED(failed_checks)"
# a named red check outranks the generic stuck entry: FAILING points at the actual cause
check fail_over_stuck    "$(jq -c '.queued=true | .queueState="UNMERGEABLE" | .failing=["test"]' <<<"$base")" "FAILING(test)"
# but a stuck entry outranks STALLED_IN_QUEUE: UNMERGEABLE is a definite dead entry, not merely quiet
check stuck_over_stalled "$(jq -c '.queued=true | .queueState="UNMERGEABLE" | .checksReported=0 | .cyclesQueued=6' <<<"$base")" "STUCK_UNMERGEABLE"
check threads           "$(jq -c '.unresolvedThreads=3' <<<"$base")"                                "UNRESOLVED_THREADS(3)"
check unarmed_clean     "$(jq -c '.mergeState="CLEAN" | .autoMerge=false' <<<"$base")"              "UNARMED_CLEAN"
check clean_armed       "$(jq -c '.mergeState="CLEAN"' <<<"$base")"                                 "PENDING"
check pending           "$base"                                                                     "PENDING"
# a conflict outranks failing checks: a DIRTY PR gets no CI, so reds are stale
check dirty_over_fail   "$(jq -c '.mergeState="DIRTY" | .failing=["test"]' <<<"$base")"             "CONFLICTING"

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
  # One fixed, uninteresting PR shape: this tier is only about how `failing`
  # and `checksReported` get collected, not about classify() precedence.
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
      if [ "$(cat "$out_file")" != "usage: watch-prs.sh [--interval s] [--max-cycles n] [--once] PR... | --classify | --probe PR" ] || [ -s "$err_file" ]; then
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
echo "test-watch-prs: all classifications and probe-seam scenarios pinned"
