#!/usr/bin/env bash
# Fixture suite for scripts/pre-push-watchdog.sh, the DOR-473 stall guard.
#
#   bash scripts/test-pre-push-watchdog.sh
#   CHECK=/path/to/other.sh bash scripts/test-pre-push-watchdog.sh
#
# CHECK exists so a candidate rewrite can be run against the same fixtures, and
# so the pre-fix behaviour can be run against them too. The behaviour this guard
# replaced is one line — `exec "$@"`, run the command with no bound at all — and
# every timeout case below was confirmed to fail against exactly that
# stand-in before the real script was written. That is the red-before evidence,
# and it is reproducible in ten seconds:
#
#   printf '#!/usr/bin/env bash\nexec "$@"\n' > /tmp/old.sh
#   CHECK=/tmp/old.sh bash scripts/test-pre-push-watchdog.sh
#
# WHY THIS SUITE IS WORTH ITS LINES
#
# A watchdog is a guard, and a guard nobody has watched fail is not known to
# work. This one has two failure directions and they are not symmetric:
#
#   * TOO EAGER — killing a push that was working. That would be worse than the
#     bug: the gate would go from "sometimes hangs" to "sometimes lies", and
#     the `--no-verify` habit the whole ticket is about would come straight
#     back, with better justification. `a slow but talking run is left alone`
#     below is the case that pins it, and it is the reason the primary bound is
#     silence rather than duration at all.
#
#   * TOO SLACK — passing a stall through, or half-killing it. Both fail
#     quietly: an unbounded run just sits there looking like a slow one (which
#     is the original bug verbatim), and a TERM that reaches the child but not
#     its workers leaks a wedged vitest per push onto the machine that could
#     least afford one.
#
# Every case is hermetic — throwaway temp dirs and shell fixtures, never turbo,
# vitest or this repo's real suites — so it needs no `pnpm install` and keeps
# passing when the real gate's contents change.
#
# WHAT IT COSTS, and why that is accepted. This suite runs in `test:scripts`,
# so it is roughly half a minute added to every `pnpm verify`. Almost all of
# that is deliberate waiting: the thing under test is a clock, and a bound
# cannot be shown to fire without letting time pass. The bounds were driven down
# as far as they can go while still proving what each case claims — a stall bound
# of 2s, a run that talks every 0.5s for 4s, a 3s ceiling — and the remainder is
# the irreducible part.
#
# The alternative was not running it locally, which is precisely the hole
# `shell-suite-parity.test.ts` beside it exists to document: the process-guard
# fixtures sat in CI and not in `test:scripts`, so `pnpm verify` came back green
# having never executed the guard that stops one agent killing another's dev
# server. Half a minute is the price of this one not being in that position.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/pre-push-watchdog.sh}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0
fail=0

# Report one assertion. Kept tiny and used everywhere so a case that needs
# several checks reads as several lines rather than a nested conditional.
#   $1 case name  $2 expected  $3 actual
check_eq() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    pass=$((pass + 1))
    printf 'ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL %s — wanted %q, got %q\n' "$name" "$want" "$got"
  fi
}

# Assert a fixed string appears in some text, printing the text when it does
# not. Used for the diagnostic assertions, where "it exited 124" is only half
# the requirement — the other half is that the message says what was running.
#   $1 case name  $2 needle  $3 haystack
check_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    pass=$((pass + 1))
    printf 'ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL %s — output does not contain %q\n---\n%s\n---\n' "$name" "$needle" "$haystack"
  fi
}

# The mirror of check_contains, for the things the diagnostic must NOT say.
#   $1 case name  $2 needle  $3 haystack
check_lacks() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    fail=$((fail + 1))
    printf 'FAIL %s — output contains %q\n---\n%s\n---\n' "$name" "$needle" "$haystack"
  else
    pass=$((pass + 1))
    printf 'ok   %s\n' "$name"
  fi
}

# Run the watchdog over a shell snippet with second-scale bounds, capturing its
# merged output and exit code into `out` and `status`.
#   $1 stall seconds  $2 max seconds  $3 heartbeat seconds  $4.. the command
run_watchdog() {
  local stall="$1" max="$2" heartbeat="$3"
  shift 3
  out=$(
    DORKOS_PREPUSH_STALL_SECONDS="$stall" \
      DORKOS_PREPUSH_MAX_SECONDS="$max" \
      DORKOS_PREPUSH_HEARTBEAT_SECONDS="$heartbeat" \
      DORKOS_PREPUSH_POLL_SECONDS=0.2 \
      bash "$CHECK" "$@" 2>&1
  )
  status=$?
}

echo "== a healthy run must be untouched: same output, same exit code =="

# If the watchdog is not transparent on the happy path it is not deployable,
# whatever else it gets right. Every push that behaves goes through here.
run_watchdog 30 60 60 bash -c 'echo hello-from-the-gate; exit 0'
check_eq 'a passing command exits 0' 0 "$status"
check_contains 'a passing command has its output forwarded' 'hello-from-the-gate' "$out"

# A real test failure must still read as a test failure. Swallowing the exit
# code would turn the gate into decoration.
run_watchdog 30 60 60 bash -c 'echo tests-went-red; exit 3'
check_eq 'a failing command keeps its exit code' 3 "$status"
check_contains 'a failing command has its output forwarded' 'tests-went-red' "$out"

echo ""
echo "== the case the whole design turns on: slow is not stalled =="

# The gate's slowest legitimate run is minutes long. A duration-based timeout
# tuned to catch a hang promptly would kill it, so the primary bound is silence
# instead. This case is what makes that claim testable: four seconds of work
# under a two-second bound, surviving only because it never stops talking for
# more than half of one.
#
# If this ever goes red, the watchdog has started failing honest pushes and the
# right response is to widen the bound, never to delete the case.
run_watchdog 2 60 60 bash -c 'for i in 1 2 3 4 5 6 7 8; do echo "suite $i passed"; sleep 0.5; done'
check_eq 'a slow but talking run is left alone' 0 "$status"
check_contains 'a slow but talking run finishes its work' 'suite 8 passed' "$out"

echo ""
echo "== a stall must be stopped, and must say what it was stopped on =="

# The bug itself: a command that stops making progress and never comes back.
# The old behaviour sat here for the full sleep and then exited 0.
started=$(date +%s)
run_watchdog 2 60 60 bash -c 'echo "@dorkos/relay:test: RUN src/__tests__/watcher-manager.test.ts"; sleep 20'
elapsed=$(($(date +%s) - started))
check_eq 'a stalled command exits 124' 124 "$status"
[ "$elapsed" -lt 15 ] && elapsed_ok=bounded || elapsed_ok="waited ${elapsed}s"
check_eq 'a stalled command is stopped promptly, not after the sleep' bounded "$elapsed_ok"

# Exiting 124 is worth little on its own — the ticket's complaint was that a
# stall was ILLEGIBLE, so the message has to name the workload. Three separate
# facts, because a message carrying only one of them still leaves the reader
# guessing: which bound fired, what the gate was running, and what the run was
# last doing when it stopped.
check_contains 'the timeout says which bound fired' 'DORKOS_PREPUSH_STALL_SECONDS' "$out"
check_contains 'the timeout names the command it was running' 'sleep 20' "$out"
check_contains 'the timeout quotes the last thing the run said' '@dorkos/relay:test' "$out"
check_contains 'the timeout distinguishes a stall from a test failure' 'not a test failure' "$out"
check_contains 'the timeout offers the deliberate bypass' '--no-verify' "$out"

# A shell that reaps a job it killed announces it unprompted, on the same
# stderr, immediately above the report:
#   pre-push-watchdog.sh: line NN: 12345 Terminated: 15  "$@" > "$log" 2>&1
# It names a line number in the watchdog and reads as the watchdog having
# crashed, so it is the first thing a reader misreads after a stall. Neither
# redirecting `wait` nor `disown` suppressed it — both were tried — and the
# window-scoped stderr park that finally did is exactly the kind of fix that
# gets tidied away later by someone who cannot see what it was for.
check_lacks 'the diagnostic is not preceded by shell job-control noise' 'Terminated:' "$out"

echo ""
echo "== the ceiling must catch what silence cannot see =="

# Silence is blind to a run that is stuck in a loop but still printing. That is
# the whole job of the second bound, and without a case here it would be
# untested code that only ever runs on the worst day.
# The loop is bounded at ~30s rather than written as `while true` so that the
# suite still TERMINATES when it is pointed at a stand-in with no watchdog in
# it. That matters: the red-before run is the evidence that these cases can
# fail, and a case that hangs forever under the old behaviour cannot be shown
# failing, only shown hanging. 30s is far past the 3s ceiling under test.
run_watchdog 60 3 60 bash -c 'for _ in $(seq 150); do echo still-going; sleep 0.2; done'
check_eq 'a chatty run that never ends hits the ceiling' 124 "$status"
check_contains 'the ceiling says which bound fired' 'DORKOS_PREPUSH_MAX_SECONDS' "$out"

echo ""
echo "== stopping a stall must not leak the processes underneath it =="

# The stall being guarded against is a wedged vitest, and vitest is never the
# process this script forked — it is turbo's child, or a worker under that. A
# TERM that reaches only the direct child leaves the wedged process alive, so
# the gate would "recover" by leaking one stuck process per push onto a machine
# already running several agents. This case fails against any fix that signals
# the child alone.
#
# The grandchild deliberately outlives its parent (60s against 20s), so the
# assertion cannot be satisfied by simply waiting: under a stand-in with no
# watchdog the parent returns at 20s with the grandchild still very much alive,
# and this case goes red rather than passing by coincidence.
#
# The grandchild's own stdout is sent to /dev/null on purpose. `run_watchdog`
# captures through `$( )`, which waits for the write end of its pipe to close —
# so a grandchild still holding that pipe makes the capture block until the
# grandchild exits, and the case then "passes" against a stand-in that never
# killed anything, purely because the assertion ran after the process had died
# of old age. Detaching its stdout is what makes the case falsifiable.
pidfile="$work/grandchild.pid"
run_watchdog 2 90 60 bash -c "sleep 60 >/dev/null 2>&1 & echo \$! > '$pidfile'; sleep 20"
check_eq 'the leaked-process case reached the timeout' 124 "$status"
grandchild=$(cat "$pidfile" 2>/dev/null || echo missing)
if [ "$grandchild" = missing ]; then
  fail=$((fail + 1))
  printf 'FAIL the fixture never recorded a grandchild pid\n'
elif kill -0 "$grandchild" 2>/dev/null; then
  fail=$((fail + 1))
  printf 'FAIL a grandchild process survived the timeout (pid %s)\n' "$grandchild"
  kill "$grandchild" 2>/dev/null
else
  pass=$((pass + 1))
  printf 'ok   the whole process tree is stopped, not just the direct child\n'
fi

echo ""
echo "== Ctrl-C must stop the run too, not just abandon it =="

# The most likely way this gate ever ends, because it is what everyone did for
# the whole life of the bug: interrupt it at the terminal. bash sets SIGINT to
# SIG_IGN in a command started with `&` when job control is off, so a Ctrl-C
# that kills the watchdog does NOT reach the gate it forked — turbo and every
# vitest under it get reparented to init and keep running invisibly. Against the
# version before the traps: signal the watchdog, and the child shell and its
# grandchildren are all still alive three seconds later.
#
# `set -m` before backgrounding is what makes this a faithful model rather than
# a convenient one: with job control on, the watchdog gets its own process group
# and therefore actually RECEIVES SIGINT, exactly as it would from a terminal.
# Without it bash hands the watchdog the very SIG_IGN the bug is about, so the
# watchdog's own INT trap can never fire and the case cannot go green at all —
# measured by deleting the line: the signal is swallowed, the command runs to
# completion, and the case fails with exit 0 against the 130 it wants. It is a
# precondition for the test being runnable, not a subtle correctness trap.
#
#   $1 signal name  $2 expected exit code
run_interrupt_case() {
  local signal="$1" want_status="$2"
  local pidfile="$work/interrupt-$signal.pid"
  rm -f "$pidfile"

  set -m
  DORKOS_PREPUSH_STALL_SECONDS=120 DORKOS_PREPUSH_MAX_SECONDS=120 \
    DORKOS_PREPUSH_HEARTBEAT_SECONDS=120 DORKOS_PREPUSH_POLL_SECONDS=0.2 \
    bash "$CHECK" bash -c "sleep 60 >/dev/null 2>&1 & echo \$! > '$pidfile'; sleep 60" \
    >/dev/null 2>&1 &
  local watchdog=$!
  set +m

  # Wait for the fixture to have forked its grandchild, so the case can never
  # pass by signalling a tree that does not exist yet.
  local waited=0
  while [ ! -s "$pidfile" ] && [ "$waited" -lt 100 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  local grandchild
  grandchild=$(cat "$pidfile" 2>/dev/null || echo '')
  if [ -z "$grandchild" ]; then
    fail=$((fail + 1))
    printf 'FAIL SIG%s — the fixture never forked a grandchild to orphan\n' "$signal"
    kill "$watchdog" 2>/dev/null
    return
  fi

  kill -"$signal" "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  local got=$?
  sleep 1

  check_eq "SIG$signal exits $want_status, not silently" "$want_status" "$got"

  if kill -0 "$grandchild" 2>/dev/null; then
    fail=$((fail + 1))
    printf 'FAIL SIG%s left the run orphaned (pid %s still alive)\n' "$signal" "$grandchild"
    kill "$grandchild" 2>/dev/null
  else
    pass=$((pass + 1))
    printf 'ok   SIG%s stops the whole run instead of orphaning it\n' "$signal"
  fi
}

# BOTH SIGNALS ARE RUN because they fail the old code in DIFFERENT PLACES, and
# each one alone would look like a passing case. Measured five trials each
# against the version before the traps, stable 5/5 in both directions:
#
#   SIGINT  — exits 0 and leaves nothing behind. Exit 0 is the serious half: a
#             Ctrl-C'd push reported SUCCESS, which is the fail-open outcome the
#             whole design refuses everywhere else. Its orphan assertion passes.
#   SIGTERM — exits 143 correctly but orphans the run every single time. Its
#             exit-code assertion passes.
#
# So the exit-code half carries SIGINT and the orphan half carries SIGTERM.
# Deleting either signal would leave a case that still reads as thorough while
# no longer noticing one of the two real defects.
run_interrupt_case INT 130
run_interrupt_case TERM 143

echo ""
echo "== forwarded output must be byte-exact, not merely present =="

# The log is appended to by a live process while the watchdog reads it, so a
# naive "print everything past the last offset" re-prints whatever arrived
# between sampling the size and doing the read. It fails intermittently and
# quietly: measured on the version before the fix, one run in three of a
# 10000-line command came out at 10728 lines and the other two were exact.
#
# Duplication is worse than it sounds. Nothing crashes; a developer just sees a
# test failure printed twice, or a suite that appears to have run twice, and has
# no reason to suspect the hook rather than their own code.
#
# Repeated because the bug is a RACE — a single exact run proves nothing, since
# two of every three were already exact while it was broken. A tight poll and a
# large line count maximise the number of reads that can straddle a write.
lines=10000
volume_ok=1
volume_seen=''
for _ in 1 2 3; do
  got_lines=$(
    DORKOS_PREPUSH_STALL_SECONDS=60 DORKOS_PREPUSH_MAX_SECONDS=60 \
      DORKOS_PREPUSH_HEARTBEAT_SECONDS=60 DORKOS_PREPUSH_POLL_SECONDS=0.05 \
      bash "$CHECK" bash -c "for i in \$(seq $lines); do echo \"line-\$i\"; done" 2>/dev/null | wc -l
  )
  got_lines=$((got_lines))
  volume_seen="${volume_seen:+$volume_seen, }$got_lines"
  [ "$got_lines" -eq "$lines" ] || volume_ok=0
done
check_eq "every byte is forwarded exactly once (3 runs of $lines lines: $volume_seen)" 1 "$volume_ok"

echo ""
echo "== a run in progress must look like a run in progress =="

# lefthook buffers a command's output until the command exits, so the terminal
# is empty for the whole of a healthy run and identical for the whole of a hung
# one. Forwarding output incrementally is what breaks that tie, and it is only
# observable while the command is still running — which is what this case
# arranges.
stream_out="$work/stream.log"
DORKOS_PREPUSH_STALL_SECONDS=30 DORKOS_PREPUSH_MAX_SECONDS=60 \
  DORKOS_PREPUSH_HEARTBEAT_SECONDS=60 DORKOS_PREPUSH_POLL_SECONDS=0.2 \
  bash "$CHECK" bash -c 'echo EARLY-LINE; sleep 3' >"$stream_out" 2>&1 &
streamer=$!
sleep 1
if grep -qF EARLY-LINE "$stream_out" 2>/dev/null; then
  pass=$((pass + 1))
  printf 'ok   output is forwarded while the command is still running\n'
else
  fail=$((fail + 1))
  printf 'FAIL nothing was forwarded 1s in; a stall would look identical to progress\n'
fi
wait "$streamer" 2>/dev/null

echo ""
echo "== a quiet run must announce itself before any bound fires =="

# The heartbeat is what makes a stall legible in the first seconds rather than
# at the timeout, which for the real bounds is minutes away. It must name the
# command, or it is just a spinner.
run_watchdog 6 60 1 bash -c 'echo starting-up; sleep 3'
check_eq 'a quiet run that recovers still exits 0' 0 "$status"
check_contains 'a quiet run is reported while it is still allowed to be quiet' '[pre-push]' "$out"
check_contains 'the heartbeat names the command it is waiting on' 'sleep 3' "$out"

echo ""
echo "== misuse must be loud =="

# A wiring mistake in lefthook.yml that dropped the command must not silently
# succeed and wave the push through.
out=$(bash "$CHECK" 2>&1)
status=$?
check_eq 'no command at all is an error, not a pass' 2 "$status"

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
