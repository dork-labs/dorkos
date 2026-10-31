#!/usr/bin/env bash
# Fixture suite for scripts/heavy-run-lock.sh, the host-wide cap on concurrent
# heavy local runs (DOR-2160, host-wide since DOR-3274).
#
#   bash scripts/test-heavy-run-lock.sh
#   CHECK=/path/to/other.sh bash scripts/test-heavy-run-lock.sh
#
# CHECK exists so a candidate rewrite can be run against the same fixtures, and
# so the previous behaviour can be too. Against the per-clone mkdir lock this
# replaced, the host-wide case, the wrapper-SIGKILL case, the nested-call case,
# the CI case and the "says what it waits on" case all fail.
#
# WHY THIS SUITE IS WORTH ITS LINES
#
# A lock every heavy command on the machine goes through has two failure modes
# that matter more than all the others, and they pull in opposite directions.
#
# It WEDGES: a holder SIGKILLed by the kernel never comes back to release
# anything, or a nested call waits on the slot its own parent holds, and no
# build or commit on the machine ever returns.
#
# Or it QUIETLY STOPS CAPPING: the slots are per clone, or a holder's death is
# missed, and two agents each start a full sweep. Nothing fails, and the host
# panics (2026-10-24).
#
# So the cases split into three groups:
#
#   * IT CAPS — two runs with one slot serialise, across two unrelated
#     checkouts and outside any checkout, and a waiter names what it waits on.
#   * IT NEVER WEDGES — a SIGKILLed holder (the whole tree, or only the
#     wrapper) frees its slot at once; a live holder is waited for and then
#     given up on; a nested call runs straight through; CI never waits.
#   * IT DEGRADES RATHER THAN REFUSES — no perl, an unwritable lock directory
#     and `DORKOS_HEAVY_LOCK=0` all still run the command.
#
# Hermetic: every case gets its own DORKOS_HEAVY_LOCK_DIR, and the commands are
# `sleep` and `echo`, never turbo or this repo's suites, so it needs no
# `pnpm install`. Bounds are driven to the smallest values that still prove what
# each case claims.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/heavy-run-lock.sh}"

# CI sets these, and the wrapper rightly runs uncapped under them. Every case
# below except the CI one is about the capped path.
unset CI DORKOS_HEAVY_SLOT_HELD DORKOS_HEAVY_LOCK DORKOS_HEAVY_WAIT_SECONDS DORKOS_HEAVY_SLOTS

work=$(mktemp -d)
# Only ever the pids this suite itself forked, by the pid, never by name
# (Hard Rule 7): other agents and the operator's dev server run on this machine.
own_pids=()
cleanup() {
  for p in ${own_pids[@]+"${own_pids[@]}"}; do kill -KILL "$p" 2>/dev/null; done
  rm -rf "$work"
}
trap cleanup EXIT

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  printf 'ok   %s\n' "$1"
}
not_ok() {
  fail=$((fail + 1))
  printf 'FAIL %s\n' "$1"
}

check_eq() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then ok "$name"; else not_ok "$name — wanted $want, got $got"; fi
}

check_contains() {
  local name="$1" needle="$2" hay="$3"
  if printf '%s' "$hay" | grep -qF -- "$needle"; then ok "$name"; else not_ok "$name — '$needle' not in: $hay"; fi
}

check_lacks() {
  local name="$1" needle="$2" hay="$3"
  if printf '%s' "$hay" | grep -qF -- "$needle"; then not_ok "$name — '$needle' found in: $hay"; else ok "$name"; fi
}

check_le() {
  local name="$1" most="$2" got="$3"
  if [ "$got" -le "$most" ]; then ok "$name (${got}s)"; else not_ok "$name — took ${got}s, bound ${most}s"; fi
}

# A fresh lock directory, standing in for this host's.
new_locks() { mktemp -d "$work/locks.XXXXXX"; }

new_repo() {
  local d
  d=$(mktemp -d "$work/repo.XXXXXX")
  git init -q "$d"
  printf '%s' "$d"
}

# True while some process holds an exclusive lock on the slot file. Asked of the
# kernel, which is the only thing that knows: the file itself stays either way.
slot_locked() {
  perl -MFcntl=:flock -e 'open(my $f, "<", $ARGV[0]) or exit 1; exit(flock($f, LOCK_SH | LOCK_NB) ? 1 : 0)' "$1/slot-$2"
}

# Wait (bounded) until slot $2 in $1 is locked, so no case races its holder.
await_locked() {
  for _ in $(seq 1 30); do
    slot_locked "$1" "$2" && return 0
    sleep 0.1
  done
  return 1
}

# Every descendant of $1, plus $1, deepest first. `pgrep -P` matches on
# parentage, never on a name (Hard Rule 7).
tree_pids() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do tree_pids "$child"; done
  printf '%s\n' "$pid"
}

signal_tree() {
  local sig=$1 root=$2 p
  for p in $(tree_pids "$root"); do kill "-$sig" "$p" 2>/dev/null; done
}

# Start a holder of the only slot in $1, running `sleep $2`, in the background.
# No subshell, so `$holder` is the wrapper's own pid: the one it records.
start_holder() {
  DORKOS_HEAVY_LOCK_DIR="$1" DORKOS_HEAVY_SLOTS=1 bash "$CHECK" sleep "$2" >/dev/null 2>&1 &
  holder=$!
  own_pids+=("$holder")
  await_locked "$1" 1 || not_ok "the holder never took slot-1, so the next case proves nothing"
}

echo "== the happy path must be invisible =="

locks=$(new_locks)
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" bash "$CHECK" bash -c 'echo hello-from-the-gate' 2>&1)
check_eq 'a passing command exits 0' 0 "$?"
check_eq 'its output is forwarded, and nothing else is printed' 'hello-from-the-gate' "$out"
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" bash "$CHECK" bash -c 'exit 7' 2>&1)
check_eq 'a failing command keeps its exit code' 7 "$?"
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" bash "$CHECK" --job bash -c 'echo as-a-job' 2>&1)
check_eq '--job is not passed to the command' 'as-a-job' "$out"
sleep 0.5
if slot_locked "$locks" 1; then
  not_ok 'the slot is still locked after the command finished'
else
  ok 'the slot is released when the command finishes'
fi
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" bash "$CHECK" bash -c 'printf %s "$DORKOS_HEAVY_SLOT_HELD"' 2>&1)
check_eq 'the command is told it holds a slot' 1 "$out"

echo ""
echo "== it must actually cap, host-wide =="

# One slot, two runs in two UNRELATED checkouts: the per-clone lock let these
# overlap, which is how jobs it never saw panicked the host. Measured by wall
# time, because overlapping is the thing being prevented.
locks=$(new_locks)
repo_a=$(new_repo)
repo_b=$(new_repo)
started=$(date +%s)
(cd "$repo_a" && DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 bash "$CHECK" sleep 2) >/dev/null 2>&1 &
one=$!
own_pids+=("$one")
await_locked "$locks" 1
(cd "$repo_b" && DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 bash "$CHECK" sleep 2) >/dev/null 2>&1 &
two=$!
own_pids+=("$two")
wait "$one" "$two" 2>/dev/null
elapsed=$(($(date +%s) - started))
if [ "$elapsed" -ge 4 ]; then
  ok "two checkouts with one slot serialised (${elapsed}s for two 2s runs)"
else
  not_ok "two checkouts with one slot overlapped (${elapsed}s for two 2s runs)"
fi

# Outside any checkout too: a build started from a scratch directory is as
# heavy as one started in a worktree.
locks=$(new_locks)
start_holder "$locks" 30
out=$(cd "$work" && DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=1 \
  bash "$CHECK" bash -c 'echo outside-a-checkout' 2>&1)
check_contains 'outside a checkout a run still queues behind the holder' 'busy' "$out"
check_contains 'outside a checkout the command still runs' 'outside-a-checkout' "$out"

# A waiter says what it waits on: the holder's pid, its command and where.
check_contains 'a waiter names the holder command' 'sleep 30' "$out"
check_contains 'a waiter names the holder pid' "pid $holder" "$out"
check_contains 'a waiter names where the holder runs' "(in " "$out"
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null

echo ""
echo "== a dead holder must free its slot at once =="

# THE CASE THE DESIGN EXISTS FOR. A holder SIGKILLed by the kernel runs no trap.
# The slot is a flock, so the kernel drops it with the process: the next run
# must go straight through, not sit out any bound.
locks=$(new_locks)
start_holder "$locks" 60
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null
started=$(date +%s)
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=30 \
  bash "$CHECK" bash -c 'echo got-through' 2>&1)
status=$?
check_eq 'the next run after a killed holder exits 0' 0 "$status"
check_eq 'it ran without waiting or warning' 'got-through' "$out"
check_le 'a SIGKILLed holder does not wedge the next run' 2 "$(($(date +%s) - started))"
if [ -e "$locks/slot-1" ]; then
  ok 'the slot file outlives its holder, and that is harmless'
else
  not_ok 'the slot file vanished, so this case did not exercise a leftover file'
fi

# Only the WRAPPER killed, its command left running: the slot is the wrapper's,
# and its sidecar must notice and let go within moments.
locks=$(new_locks)
start_holder "$locks" 60
# Its `sleep 60` and sidecar outlive it; remember them by pid for cleanup.
for p in $(tree_pids "$holder"); do own_pids+=("$p"); done
kill -KILL "$holder" 2>/dev/null
wait "$holder" 2>/dev/null
released=0
for _ in $(seq 1 20); do
  if ! slot_locked "$locks" 1; then
    released=1
    break
  fi
  sleep 0.1
done
check_eq 'a SIGKILLed wrapper releases its slot within two seconds' 1 "$released"

echo ""
echo "== waiting must be bounded, and giving up must run rather than hang =="

locks=$(new_locks)
start_holder "$locks" 30
started=$(date +%s)
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=2 DORKOS_HEAVY_POLL_SECONDS=0.3 \
  bash "$CHECK" bash -c 'echo ran-anyway' 2>&1)
status=$?
check_eq 'giving up on the wait still exits 0' 0 "$status"
check_contains 'giving up runs the command rather than skipping it' 'ran-anyway' "$out"
check_contains 'giving up says so' 'running anyway' "$out"
check_le 'the wait is bounded against a 2s bound' 5 "$(($(date +%s) - started))"
if slot_locked "$locks" 1; then
  ok 'a live holder keeps its slot while a waiter gives up'
else
  not_ok 'a waiter took a slot whose holder was still alive'
fi

# A second waiter queues behind the first and both are bounded: the queue lock
# must not turn one waiter's bound into the next one's wedge.
started=$(date +%s)
(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=2 bash "$CHECK" true) >/dev/null 2>&1 &
w1=$!
own_pids+=("$w1")
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=2 \
  bash "$CHECK" bash -c 'echo second-waiter-ran' 2>&1)
wait "$w1" 2>/dev/null
check_contains 'a second queued waiter still runs' 'second-waiter-ran' "$out"
check_le 'two queued waiters are each bounded' 5 "$(($(date +%s) - started))"

# When the holder finishes, the waiter takes the slot rather than timing out.
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null
start_holder "$locks" 1
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=20 DORKOS_HEAVY_POLL_SECONDS=0.2 \
  bash "$CHECK" bash -c 'echo took-the-freed-slot' 2>&1)
check_contains 'a waiter takes a slot as soon as it frees' 'took-the-freed-slot' "$out"
check_lacks 'and does not report giving up' 'running anyway' "$out"
wait "$holder" 2>/dev/null

echo ""
echo "== an interrupted run must release its slot =="

locks=$(new_locks)
start_holder "$locks" 30
signal_tree TERM "$holder"
wait "$holder" 2>/dev/null
sleep 0.5
if slot_locked "$locks" 1; then not_ok 'a TERMed run left its slot locked'; else ok 'a TERMed run releases its slot'; fi

echo ""
echo "== it must never deadlock on itself or block CI =="

# A nested call — `pnpm verify` running lint, a build inside a test script —
# must not wait on the slot its own parent holds. With one slot this would hang
# to the bound and then run uncapped; it must run at once.
locks=$(new_locks)
started=$(date +%s)
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=20 \
  bash "$CHECK" bash "$CHECK" bash -c 'echo nested-ran' 2>&1)
check_eq 'a nested call runs straight through' 'nested-ran' "$out"
check_le 'a nested call does not wait on its parent' 2 "$(($(date +%s) - started))"

locks=$(new_locks)
start_holder "$locks" 30
started=$(date +%s)
out=$(CI=true DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=20 \
  bash "$CHECK" bash -c 'echo ci-ran' 2>&1)
check_eq 'under CI the command runs with no lock message' 'ci-ran' "$out"
check_le 'under CI nothing waits' 2 "$(($(date +%s) - started))"
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null

echo ""
echo "== it must degrade rather than refuse =="

locks=$(new_locks)
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOCK=0 bash "$CHECK" bash -c 'echo cap-switched-off' 2>&1)
check_eq 'the cap can be switched off for one run' 'cap-switched-off' "$out"

out=$(bash "$CHECK" 2>&1)
check_eq 'no command at all is a usage error, not a pass' 2 "$?"

out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_PERL="$work/no-such-perl" bash "$CHECK" bash -c 'echo ran-without-perl' 2>&1)
check_eq 'without perl the command still runs' 0 "$?"
check_contains 'without perl it says so' 'no perl' "$out"
check_contains 'without perl the output is forwarded' 'ran-without-perl' "$out"

# An existing but UNWRITABLE lock directory satisfies `mkdir -p`; without the
# probe every run would wait out its bound and blame busy slots.
locks=$(new_locks)
chmod 500 "$locks"
started=$(date +%s)
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_WAIT_SECONDS=30 bash "$CHECK" bash -c 'echo ran-despite-unwritable-dir' 2>&1)
status=$?
chmod 700 "$locks"
check_eq 'an unwritable lock directory still runs the command' 0 "$status"
check_contains 'an unwritable lock directory does not swallow the output' 'ran-despite-unwritable-dir' "$out"
check_contains 'an unwritable lock directory says what is wrong' 'cannot write' "$out"
check_le 'an unwritable lock directory costs no wait' 2 "$(($(date +%s) - started))"

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
