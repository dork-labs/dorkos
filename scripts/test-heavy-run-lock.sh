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
#   * IT USES ONLY A DIRECTORY THAT IS OURS (DOR-3509) — a symlinked or
#     foreign lock directory is refused, and a planted symlink slot file is
#     never followed (the previous script truncated the file it pointed at).
#   * --hold (DOR-3274 Phase 2) — a slot taken for another pid, as a bare
#     `turbo` run does, is held until that pid ends and leaves no output open;
#     a nested call inside a turbo task, which has lost the env, still sees
#     its ancestor's slot.
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
unset CI DORKOS_HEAVY_SLOT_HELD DORKOS_HEAVY_LOCK DORKOS_HEAVY_WAIT_SECONDS DORKOS_HEAVY_SLOTS \
  DORKOS_HEAVY_MAX_LOAD DORKOS_HEAVY_LOAD_WAIT_SECONDS DORKOS_HEAVY_LOAD_POLL_SECONDS \
  CI_STEWARD_TIMINGS_FILE CI_STEWARD_RUN_ID
# This machine's real load must never decide a case: a busy host would make
# every --job case below wait out the load bound. The load cases set their own.
export DORKOS_HEAVY_LOADAVG_CMD='echo 0.00'

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
  if grep <<<"$hay" -qF -- "$needle"; then ok "$name"; else not_ok "$name — '$needle' not in: $hay"; fi
}

check_lacks() {
  local name="$1" needle="$2" hay="$3"
  if grep <<<"$hay" -qF -- "$needle"; then not_ok "$name — '$needle' found in: $hay"; else ok "$name"; fi
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
echo "== it must only use a lock directory that is ours (DOR-3509) =="

# /tmp is shared by every user, so the default name can be taken first. A
# symlink there would aim our slot writes and truncates at the squatter's pick.
target=$(mktemp -d "$work/target.XXXXXX")
ln -s "$target" "$work/squatted"
for spelling in "$work/squatted" "$work/squatted/"; do
  out=$(DORKOS_HEAVY_LOCK_DIR="$spelling" bash "$CHECK" bash -c 'echo ran-beside-symlink' 2>&1)
  check_eq "a symlinked lock directory ($spelling) still runs the command" 0 "$?"
  check_contains "a symlinked lock directory ($spelling) is refused" 'it is a symlink' "$out"
  check_contains "a symlinked lock directory ($spelling) keeps the output" 'ran-beside-symlink' "$out"
done
check_eq 'nothing is written through a symlinked lock directory' '' "$(ls -A "$target")"

# Owned by someone else: /tmp itself is root's, on macOS behind /private/tmp.
others=/tmp
[ -L "$others" ] && others=/private/tmp
if [ "$(id -u)" = 0 ]; then
  ok 'a lock directory owned by another user is refused (skipped: running as root)'
else
  out=$(DORKOS_HEAVY_LOCK_DIR="$others" bash "$CHECK" bash -c 'echo ran-beside-foreign-dir' 2>&1)
  check_eq 'a lock directory owned by another user still runs the command' 0 "$?"
  check_contains 'a lock directory owned by another user is refused' 'is owned by uid' "$out"
  check_contains 'a lock directory owned by another user keeps the output' 'ran-beside-foreign-dir' "$out"
fi

# Ours but open to others (an older version, or by hand) is closed, not refused.
locks=$(new_locks)
chmod 777 "$locks"
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" bash "$CHECK" bash -c 'echo ran-in-open-dir' 2>&1)
check_eq 'a lock directory of ours open to others still caps quietly' 'ran-in-open-dir' "$out"
# shellcheck disable=SC2012 # one known path; `stat` flags differ by platform
check_eq 'and is closed to group and other' 'drwx------' "$(ls -ld "$locks" | cut -c1-10)"

# A slot file planted as a symlink is never followed: the run takes the next
# slot and the file the link names keeps its contents.
locks=$(new_locks)
printf 'keep me\n' >"$work/victim"
ln -s "$work/victim" "$locks/slot-1"
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=2 bash "$CHECK" bash -c 'echo ran-past-planted-slot' 2>&1)
check_eq 'a planted symlink slot does not stop the run' 'ran-past-planted-slot' "$out"
check_eq 'a planted symlink slot is never written through' 'keep me' "$(cat "$work/victim")"

# A HARD link is a second name for the same file, so O_NOFOLLOW cannot see it,
# and it can sit in a directory that is ours. Security's probe on #3368 emptied a
# 35-byte canary this way. A slot file with another name is refused; the queue
# file too, when every slot is busy and the run has to line up.
locks=$(new_locks)
printf 'canary: never empty this\n' >"$work/canary"
ln "$work/canary" "$locks/slot-1"
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=2 bash "$CHECK" bash -c 'echo ran-past-hard-link' 2>&1)
check_eq 'a hard-linked slot does not stop the run' 'ran-past-hard-link' "$out"
check_eq 'a hard-linked slot is never truncated or written' 'canary: never empty this' "$(cat "$work/canary")"
locks=$(new_locks)
printf 'canary: never empty this\n' >"$work/canary2"
ln "$work/canary2" "$locks/slot-1"
ln "$work/canary2" "$locks/queue"
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=1 \
  bash "$CHECK" bash -c 'echo ran-past-hard-linked-queue' 2>&1)
check_contains 'with every slot hard-linked the run still goes ahead' 'ran-past-hard-linked-queue' "$out"
check_eq 'a hard-linked queue is never written' 'canary: never empty this' "$(cat "$work/canary2")"

# The write check no longer leaves a probe file behind.
probes=$(cd "$locks" && for f in .probe*; do [ -e "$f" ] && printf '%s ' "$f"; done)
check_eq 'no probe file is left in the lock directory' '' "$probes"

echo ""
echo "== --hold takes a slot for another process, for a bare turbo run (DOR-3274 Phase 2) =="

locks=$(new_locks)
sleep 30 &
owner=$!
own_pids+=("$owner")
started=$(date +%s)
# Command substitution waits for EOF on stdout and stderr: a sidecar that kept
# either open would hold this line until the owner died, and so would turbo.
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 bash "$CHECK" --job --hold "$owner" turbo build 2>&1)
check_eq '--hold exits 0' 0 "$?"
check_eq '--hold prints nothing on a free slot' '' "$out"
check_le '--hold returns once the slot is taken' 2 "$(($(date +%s) - started))"
if await_locked "$locks" 1; then ok '--hold leaves the slot locked for its owner'; else not_ok '--hold did not keep the slot'; fi
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=1 bash "$CHECK" bash -c 'echo behind-turbo' 2>&1)
check_contains 'a waiter behind --hold names the owner pid' "pid $owner" "$out"
check_contains 'a waiter behind --hold names the turbo run' 'turbo build' "$out"
kill -KILL "$owner" 2>/dev/null
wait "$owner" 2>/dev/null
released=0
for _ in $(seq 1 20); do
  if ! slot_locked "$locks" 1; then
    released=1
    break
  fi
  sleep 0.1
done
check_eq '--hold releases the slot within two seconds of its owner ending' 1 "$released"

out=$(DORKOS_HEAVY_LOCK_DIR="$locks" bash "$CHECK" --hold not-a-pid 2>&1)
check_eq '--hold without a pid is a usage error' 2 "$?"

locks=$(new_locks)
out=$(CI=true DORKOS_HEAVY_LOCK_DIR="$locks" bash "$CHECK" --job --hold "$$" turbo build 2>&1)
check_eq '--hold under CI exits 0 and says nothing' '0:' "$?:$out"
if slot_locked "$locks" 1 2>/dev/null; then not_ok '--hold under CI took a slot'; else ok '--hold under CI takes no slot'; fi

# turbo runs tasks in strict env mode, so DORKOS_HEAVY_SLOT_HELD does not reach
# a nested call inside a task. A holder that is our own ancestor is enough.
locks=$(new_locks)
started=$(date +%s)
out=$(DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=20 \
  bash "$CHECK" env -u DORKOS_HEAVY_SLOT_HELD bash "$CHECK" bash -c 'echo nested-without-env' 2>&1)
check_eq 'a nested call that lost the env still runs straight through' 'nested-without-env' "$out"
check_le 'a nested call that lost the env does not wait on its ancestor' 2 "$(($(date +%s) - started))"

echo ""
echo "== a heavy job waits for the load to drop, then refuses (exit 75) =="

# The load is faked: DORKOS_HEAVY_LOADAVG_CMD prints the 1-minute average the
# wrapper reads, here from a file a case can change while a run waits. Max 24,
# as configured, and second-scale waits.
loadf="$work/load"
notes="$work/notes.jsonl"
: >"$notes"
load_env() {
  env DORKOS_HEAVY_LOADAVG_CMD="cat $loadf" DORKOS_HEAVY_MAX_LOAD=24 \
    CI_STEWARD_TIMINGS_FILE="$notes" CI_STEWARD_RUN_ID=fixture "$@"
}

locks=$(new_locks)
echo 5.10 >"$loadf"
started=$(date +%s)
out=$(load_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 \
  bash "$CHECK" --job bash -c 'echo ran-under-the-max' 2>&1)
check_eq 'a job under the max load exits 0' 0 "$?"
check_eq 'a job under the max load runs at once and says nothing' 'ran-under-the-max' "$out"
check_le 'a job under the max load does not wait' 2 "$(($(date +%s) - started))"

# Over the max, then the load drops: the job waits for it, then runs.
locks=$(new_locks)
: >"$notes"
echo 40.00 >"$loadf"
(sleep 2 && echo 3.00 >"$loadf") &
own_pids+=("$!")
started=$(date +%s)
out=$(load_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 DORKOS_HEAVY_LOAD_POLL_SECONDS=0.3 \
  bash "$CHECK" --job bash -c 'echo ran-once-the-load-dropped' 2>&1)
status=$?
elapsed=$(($(date +%s) - started))
check_eq 'a job that waited out the load exits 0' 0 "$status"
check_contains 'a job that waited out the load runs' 'ran-once-the-load-dropped' "$out"
check_contains 'a waiting job says the load it waits on' '40.00' "$out"
check_lacks 'a job that waited out the load does not refuse' 'refusing' "$out"
if [ "$elapsed" -ge 2 ]; then ok "it waited for the load to drop (${elapsed}s)"; else not_ok "it ran before the load dropped (${elapsed}s)"; fi
check_le 'and ran soon after it did' 6 "$elapsed"
check_contains 'the wait is recorded as load_wait' '"o":"load_wait"' "$(cat "$notes")"

# Over the max the whole time: exit 75, the load and the slot holders printed,
# and the command never runs.
locks=$(new_locks)
: >"$notes"
echo 41.37 >"$loadf"
DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=2 bash "$CHECK" sleep 30 >/dev/null 2>&1 &
holder=$!
own_pids+=("$holder")
await_locked "$locks" 1 || not_ok 'the holder never took slot-1, so the holder line proves nothing'
started=$(date +%s)
out=$(load_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=2 DORKOS_HEAVY_LOAD_WAIT_SECONDS=2 \
  DORKOS_HEAVY_LOAD_POLL_SECONDS=0.3 bash "$CHECK" --job bash -c 'echo must-not-run' 2>&1)
status=$?
check_eq 'a job over the max load the whole time exits 75' 75 "$status"
check_lacks 'a refused job never runs its command' 'must-not-run' "$out"
check_contains 'a refused job prints the load' '41.37' "$out"
check_contains 'a refused job prints the max' '24' "$out"
check_contains 'a refused job names the slot holders' "pid $holder" "$out"
check_contains 'a refused job says how to run it anyway' 'DORKOS_HEAVY_LOCK=0' "$out"
check_le 'the load wait is bounded against a 2s bound' 5 "$(($(date +%s) - started))"
check_contains 'the refusal is recorded as load_refused with the load' '"o":"load_refused","d":41' "$(cat "$notes")"
if slot_locked "$locks" 2; then not_ok 'a refused job holds a slot'; else ok 'a refused job holds no slot'; fi
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null

# THE COMMIT GATE NEVER REFUSES. Without --job the load is not checked at all:
# a gate that refuses is a gate that gets skipped.
locks=$(new_locks)
echo 99.00 >"$loadf"
started=$(date +%s)
out=$(load_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 \
  bash "$CHECK" bash -c 'echo the-gate-ran' 2>&1)
check_eq 'the commit gate over the max load exits 0' 0 "$?"
check_eq 'the commit gate over the max load runs at once and says nothing' 'the-gate-ran' "$out"
check_le 'the commit gate does not wait on the load' 2 "$(($(date +%s) - started))"

# DORKOS_HEAVY_LOCK=0 is still the way out, and now it leaves a note.
: >"$notes"
out=$(load_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOCK=0 DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 \
  bash "$CHECK" --job bash -c 'echo opted-out' 2>&1)
check_eq 'DORKOS_HEAVY_LOCK=0 runs a job over the max load' 'opted-out' "$out"
check_contains 'DORKOS_HEAVY_LOCK=0 is recorded as lock_off' '"o":"lock_off"' "$(cat "$notes")"

started=$(date +%s)
out=$(load_env CI=true DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 \
  bash "$CHECK" --job bash -c 'echo ci-over-load' 2>&1)
check_eq 'under CI the load is not checked' 'ci-over-load' "$out"
check_le 'under CI nothing waits on the load' 2 "$(($(date +%s) - started))"

# A load that cannot be read is not a reason to refuse: it degrades.
locks=$(new_locks)
out=$(env DORKOS_HEAVY_LOADAVG_CMD="false" DORKOS_HEAVY_MAX_LOAD=24 DORKOS_HEAVY_LOCK_DIR="$locks" \
  DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 bash "$CHECK" --job bash -c 'echo unreadable-load' 2>&1)
check_eq 'an unreadable load runs the job' 0 "$?"
check_contains 'an unreadable load keeps the output' 'unreadable-load' "$out"

# A nested job whose parent holds a slot is not checked again, even after the
# parent's own run pushed the load up, and even when turbo dropped the env.
locks=$(new_locks)
echo 5.00 >"$loadf"
started=$(date +%s)
out=$(load_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 bash "$CHECK" --job \
  bash -c "echo 60.00 >'$loadf' && env -u DORKOS_HEAVY_SLOT_HELD bash '$CHECK' --job bash -c 'echo nested-over-load'" 2>&1)
check_eq 'a nested job is not refused for the load its parent made' 'nested-over-load' "$out"
check_le 'a nested job does not wait on the load' 2 "$(($(date +%s) - started))"

# --hold (a bare turbo run's slot) is not load-checked: its helper never fails
# a run, so a refusal there would only be a lost slot.
locks=$(new_locks)
echo 60.00 >"$loadf"
sleep 30 &
owner=$!
own_pids+=("$owner")
started=$(date +%s)
out=$(load_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 \
  bash "$CHECK" --job --hold "$owner" turbo build 2>&1)
check_eq '--hold over the max load still takes the slot' '0:' "$?:$out"
check_le '--hold does not wait on the load' 2 "$(($(date +%s) - started))"
kill -KILL "$owner" 2>/dev/null
wait "$owner" 2>/dev/null

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
