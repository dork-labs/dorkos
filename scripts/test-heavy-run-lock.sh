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
#   * A SIGNAL NEVER BECOMES A PASS (DOR-4616) — a run stopped by INT, QUIT,
#     TERM or HUP exits 128+n even when its command caught the signal and
#     exited 0, as turbo does.
#   * IT DEGRADES RATHER THAN REFUSES — no perl, an unwritable lock directory
#     and `DORKOS_HEAVY_LOCK=0` all still run the command.
#   * IT USES ONLY A DIRECTORY THAT IS OURS (DOR-3509) — a symlinked or
#     foreign lock directory is refused, and a planted symlink slot file is
#     never followed (the previous script truncated the file it pointed at).
#   * THE GATE IS THE LINE (DOR-4209) — the copy run inside the app's turn
#     takes no slot here and asks no load a second time.
#   * THE ORDER LINE (DOR-4209, DOR-4901) — with --label, only the order
#     file's top label starts; it leaves the line when it ends or with
#     --done; and a top label with no live run for the
#     stale bound moves down one place, with a note and its owner told, while
#     a top label that is running (or held for a pid, as QA's drivers are) is
#     never moved.
#   * AN --insert WITH NO POSITION (DOR-5065) — goes where its ticket ranks in
#     one `flow order --json` call: release rows first, never past a running
#     line, no ticket or no rank to the end with a note, and a flow that is
#     missing, failing, slow or printing junk never blocks the write.
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
  DORKOS_HEAVY_MAX_LOAD DORKOS_HEAVY_TEST_MAX_LOAD DORKOS_IGNORE_LOAD DORKOS_HEAVY_LOAD_WAIT_SECONDS DORKOS_HEAVY_LOAD_POLL_SECONDS \
  CI_STEWARD_TIMINGS_FILE CI_STEWARD_RUN_ID DORKOS_HEAVY_ORDER_DIR DORKOS_HEAVY_LABEL \
  DORKOS_HEAVY_ORDER_LOCK_WAIT DORKOS_HEAVY_ORDER_TEST_CORRUPT \
  DORKOS_HEAVY_ORDER_STALE_SECONDS DORKOS_LOAD_GATE_IN_TURN DORKOS_HEAVY_NOTIFY \
  DORKOS_HEAVY_SECOND_SWAP_MAX_MB DORKOS_HEAVY_SECOND_FREE_MIN_PCT DORKOS_HEAVY_SECOND_SWAP_GROWTH_MAX_MB \
  DORKOS_HEAVY_SECOND_MAX_LOAD DORKOS_HEAVY_SECOND_DISK_MIN_GB
# This machine's real load must never decide a case: a busy host would make
# every --job case below wait out the load bound. The load cases set their own.
export DORKOS_HEAVY_LOADAVG_CMD='echo 0.00'
# Nor its real memory, load or disk: by default the reading is unreadable, so a
# second label in line waits exactly as it did before DOR-5073. The DOR-5073
# cases set their own.
export DORKOS_HEAVY_MACHINE_CMD='false'
# Nor the real work order: an --insert with no position asks `flow order` where
# a label goes (DOR-5065), and this checkout may have flow installed. By default
# there is no flow, so a label goes to the end as it always did; the DOR-5065
# cases bring their own fake.
export DORKOS_HEAVY_FLOW_CMD=/nonexistent/flow
unset DORKOS_HEAVY_FLOW_TIMEOUT
# These cases are about this lock alone. A --job also waits in the app's line
# for heavy jobs (DOR-4209), whose folder is this machine's real one; that line
# has its own suite, scripts/test-load-gate-turn.sh, over a throwaway folder.
export DORKOS_LOAD_GATE_LINE=0

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
echo "== a signal never becomes a pass (DOR-4616) =="

# turbo catches a signal, shuts its tasks down and exits 0. bash, waiting on a
# foreground command that caught SIGINT and exited 0, carries on as though
# nothing happened, so a Ctrl-C'd `pnpm verify` step used to exit 0 here. The
# command below does what turbo does. It is started through perl because a
# background job of this non-interactive shell ignores INT and QUIT, which a
# wrapper run from a terminal does not.
start_catcher() {
  local locks=$1 secs=$2 lock=$3 pidf
  pidf=$(mktemp "$work/catcher.XXXXXX")
  DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_LOCK="$lock" PIDF="$pidf" \
    perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; exec @ARGV or die "exec: $!\n"' \
    bash "$CHECK" bash -c "trap 'exit 0' INT QUIT TERM; echo \$\$ >\"\$PIDF\"; sleep $secs & wait \$!" \
    >/dev/null 2>&1 &
  wrapper=$!
  own_pids+=("$wrapper")
  for _ in $(seq 1 50); do
    [ -s "$pidf" ] && break
    sleep 0.1
  done
  catcher=$(cat "$pidf")
  for p in $(tree_pids "$catcher"); do own_pids+=("$p"); done
}

for lock in 1 0; do
  label='capped'
  [ "$lock" = 0 ] && label='with the cap off'
  locks=$(new_locks)
  start_catcher "$locks" 30 "$lock"
  # What a terminal's Ctrl-C does: the signal reaches the wrapper and its command.
  kill -INT "$wrapper" "$catcher"
  wait "$wrapper" 2>/dev/null
  check_eq "a Ctrl-C'd run whose command exits 0 exits 130 ($label)" 130 "$?"
  if [ "$lock" = 1 ]; then
    sleep 0.5
    if slot_locked "$locks" 1; then not_ok "a Ctrl-C'd run left its slot locked"; else ok "a Ctrl-C'd run releases its slot"; fi
  fi
done

locks=$(new_locks)
start_catcher "$locks" 30 1
kill -QUIT "$wrapper" "$catcher"
wait "$wrapper" 2>/dev/null
check_eq 'a QUIT run whose command exits 0 exits 131' 131 "$?"

# INT to the wrapper alone: the command never hears of it and finishes, but the
# run was asked to stop, so it does not report a pass.
locks=$(new_locks)
start_catcher "$locks" 1 1
kill -INT "$wrapper"
wait "$wrapper" 2>/dev/null
check_eq 'an INT to the wrapper alone still exits 130' 130 "$?"

# TERM and HUP need no trap: the wrapper dies of the signal, which is never 0.
for sig in TERM HUP; do
  locks=$(new_locks)
  start_catcher "$locks" 30 1
  kill "-$sig" "$wrapper" "$catcher"
  wait "$wrapper" 2>/dev/null
  status=$?
  [ "$sig" = TERM ] && want=143 || want=129
  check_eq "a $sig run whose command exits 0 exits $want" "$want" "$status"
done
locks=$(new_locks)
start_catcher "$locks" 30 1
kill -TERM "$wrapper"
wait "$wrapper" 2>/dev/null
check_eq 'a TERM to the wrapper alone exits 143' 143 "$?"

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
# The property is "it never queued", and the exact output above already proves
# it: a call that waited prints the queueing line. check_lacks only gives that a
# clearer failure message. The clock is a backstop against a silent wait, so its
# bound sits well under the 20s wait rather than at the cost of starting bash and
# perl twice, which a loaded machine stretches past 2s (DOR-2021).
check_lacks 'a nested call never queues behind its parent' 'queueing' "$out"
check_le 'a nested call does not wait on its parent' 10 "$(($(date +%s) - started))"

locks=$(new_locks)
start_holder "$locks" 30
started=$(date +%s)
out=$(CI=true DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=20 \
  bash "$CHECK" bash -c 'echo ci-ran' 2>&1)
check_eq 'under CI the command runs with no lock message' 'ci-ran' "$out"
# Same backstop as the nested case: the exact output above already proves no
# lock message, so the clock only has to stay well under the 20s wait.
check_le 'under CI nothing waits' 10 "$(($(date +%s) - started))"
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
echo "== a test run (--tests) waits under the lower bar of 16 (DOR-4646) =="

test_env() { load_env DORKOS_HEAVY_TEST_MAX_LOAD=16 "$@"; }

# 20 is under a job's 24 and over a test run's 16: the one reading that tells
# the two bars apart.
locks=$(new_locks)
echo 20.00 >"$loadf"
started=$(date +%s)
out=$(test_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 \
  bash "$CHECK" --job bash -c 'echo job-at-20' 2>&1)
check_eq 'a plain job at load 20 runs at once' 'job-at-20' "$out"
check_le 'a plain job at load 20 does not wait' 2 "$(($(date +%s) - started))"

locks=$(new_locks)
: >"$notes"
echo 20.00 >"$loadf"
(sleep 2 && echo 16.00 >"$loadf") &
own_pids+=("$!")
started=$(date +%s)
out=$(test_env DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 DORKOS_HEAVY_LOAD_POLL_SECONDS=0.3 \
  bash "$CHECK" --tests bash -c 'echo tests-ran-at-16' 2>&1)
status=$?
elapsed=$(($(date +%s) - started))
check_eq 'a test run that waited out the load exits 0' 0 "$status"
check_contains 'a test run at load 20 says it is waiting for load' 'waiting for load' "$out"
check_contains 'and the load it waits on' '20.00' "$out"
check_contains 'a test run runs once the load is 16 (at the bar, not over it)' 'tests-ran-at-16' "$out"
if [ "$elapsed" -ge 2 ]; then ok "the test run waited for the load to drop (${elapsed}s)"; else not_ok "the test run ran over 16 (${elapsed}s)"; fi
check_contains 'the test run wait is recorded as load_wait' '"o":"load_wait"' "$(cat "$notes")"

locks=$(new_locks)
echo 40.00 >"$loadf"
started=$(date +%s)
out=$(test_env CI=true DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 \
  bash "$CHECK" --tests bash -c 'echo ci-tests' 2>&1)
check_eq 'under CI a test run never waits' 'ci-tests' "$out"
check_le 'under CI a test run starts at once' 2 "$(($(date +%s) - started))"

# DORKOS_IGNORE_LOAD=1: a person's way past the load alone, said and recorded.
locks=$(new_locks)
: >"$notes"
echo 40.00 >"$loadf"
started=$(date +%s)
out=$(test_env DORKOS_IGNORE_LOAD=1 DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 \
  bash "$CHECK" --tests bash -c 'echo ignored-the-load' 2>&1)
check_contains 'DORKOS_IGNORE_LOAD=1 runs a test run over the bar' 'ignored-the-load' "$out"
check_contains 'DORKOS_IGNORE_LOAD=1 says so' 'DORKOS_IGNORE_LOAD=1' "$out"
check_le 'DORKOS_IGNORE_LOAD=1 does not wait' 2 "$(($(date +%s) - started))"
check_contains 'DORKOS_IGNORE_LOAD=1 is recorded as load_ignored' '"o":"load_ignored"' "$(cat "$notes")"



echo ""
echo "== the gate is the line: a run inside the app's turn goes straight through (DOR-4209) =="

# The only slot is held and the load is far over the bar: a copy run inside a
# gate turn must not wait on either, because the turn already judged both.
locks=$(new_locks)
start_holder "$locks" 30
echo 90.00 >"$loadf"
started=$(date +%s)
out=$(load_env DORKOS_LOAD_GATE_IN_TURN=1 DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_SLOTS=1 \
  DORKOS_HEAVY_LOAD_WAIT_SECONDS=20 DORKOS_HEAVY_WAIT_SECONDS=20 \
  bash "$CHECK" --job bash -c 'printf "in-turn:%s" "$DORKOS_HEAVY_SLOT_HELD"' 2>&1)
check_eq 'inside a gate turn the command runs at once, told it holds a slot' '0:in-turn:1' "$?:$out"
check_le 'inside a gate turn nothing waits' 2 "$(($(date +%s) - started))"
out=$(load_env DORKOS_LOAD_GATE_IN_TURN=1 DORKOS_HEAVY_LOCK_DIR="$locks" bash "$CHECK" --tests bash -c 'exit 5' 2>&1)
check_eq 'inside a gate turn the exit code is kept' 5 "$?"
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null
echo ""
echo "== the order line: only the top label starts (DOR-4209) =="

# An order folder of its own per case, standing in for ~/.dork/load-gate.
new_coord() { mktemp -d "$work/order.XXXXXX"; }
order_env() { env DORKOS_HEAVY_ORDER_DIR="$1" DORKOS_HEAVY_LOCK_DIR="$2" "${@:3}"; }

# No order file: a labelled run is a plain job.
coord=$(new_coord)
locks=$(new_locks)
out=$(order_env "$coord" "$locks" bash "$CHECK" --label 'pr1-verify' bash -c 'echo no-order-ran' 2>&1)
check_eq 'with no order file a labelled run runs' '0:no-order-ran' "$?:$out"

# The order folder is made on first use, closed to others.
coord="$work/made-on-first-use"
locks=$(new_locks)
out=$(order_env "$coord" "$locks" bash "$CHECK" --status 2>&1)
check_eq '--status with no folder yet exits 0' 0 "$?"
check_eq 'the order folder is made, mode 700' 700 "$(perl -e 'printf "%o", (stat shift)[2] & 0777' "$coord")"
# A symlink in its place is refused, and the run goes on with no order.
coord_target=$(new_coord)
printf 'someone-else\n' >"$coord_target/heavy-order"
ln -s "$coord_target" "$work/order-link"
out=$(order_env "$work/order-link" "$locks" bash "$CHECK" --label 'mine' bash -c 'echo ran-without-order' 2>&1)
check_contains 'a symlinked order folder is refused' 'is not a folder you own' "$out"
check_contains 'and the run goes on with no order' 'ran-without-order' "$out"

# A waiter on this lock (the fall-through when the gate is not reached) sees the label.
coord=$(new_coord)
locks=$(new_locks)
order_env "$coord" "$locks" DORKOS_HEAVY_SLOTS=1 bash "$CHECK" --label 'first' sleep 30 >/dev/null 2>&1 &
holder=$!
own_pids+=("$holder")
await_locked "$locks" 1 || not_ok 'the first labelled run never took slot-1'
out=$(order_env "$coord" "$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=1 bash "$CHECK" --label 'second' bash -c 'echo second-ran' 2>&1)
check_contains 'a waiter sees the holder label' '[first]' "$out"
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null

# Two in line: the second is refused at once, runs nothing, and is told who is next.
coord=$(new_coord)
locks=$(new_locks)
printf '  a-verify  \n\nb-verify\nc-build\n' >"$coord/heavy-order"
started=$(date +%s)
out=$(order_env "$coord" "$locks" bash "$CHECK" --label 'b-verify' bash -c 'echo b-ran' 2>&1)
status=$?
check_eq 'a label that is not on top exits 75' 75 "$status"
check_lacks 'and runs nothing' 'b-ran' "$out"
check_contains 'it is told who is next' "Next is 'a-verify'" "$out"
check_contains 'the refusal keeps the old [heavy] REFUSE (order) words' '[heavy] REFUSE (order)' "$out"
check_le 'a refusal is immediate' 2 "$(($(date +%s) - started))"

# The top label runs, keeps its exit code, and leaves the line when it ends.
out=$(order_env "$coord" "$locks" bash "$CHECK" --label 'a-verify' bash -c 'echo a-ran; exit 3' 2>&1)
check_eq 'the top label runs and keeps its exit code' '3' "$?"
check_contains 'the top label command ran' 'a-ran' "$out"
check_eq 'it left the line when it ended; blank lines and others stay' \
  "$(printf '\nb-verify\nc-build')" "$(cat "$coord/heavy-order")"
out=$(order_env "$coord" "$locks" bash "$CHECK" --label 'b-verify' bash -c 'echo b-ran-now' 2>&1)
check_eq 'the next label now runs' '0:b-ran-now' "$?:$out"

# --done: a job that ran outside this script leaves the line.
out=$(order_env "$coord" "$locks" bash "$CHECK" --done 'c-build' 2>&1)
check_eq '--done exits 0' 0 "$?"
check_contains '--done says who is next' "popped 'c-build'" "$out"
check_eq '--done removed the line' '' "$(awk 'NF' "$coord/heavy-order")"

# --status lists the line and marks the running top.
coord=$(new_coord)
locks=$(new_locks)
printf 'run-me\nwait-me\n' >"$coord/heavy-order"
order_env "$coord" "$locks" bash "$CHECK" --label 'run-me' sleep 30 >/dev/null 2>&1 &
holder=$!
own_pids+=("$holder")
await_locked "$locks" 1 || not_ok 'run-me never took a slot'
out=$(order_env "$coord" "$locks" bash "$CHECK" --status 2>&1)
check_contains '--status lists the line' '2. wait-me' "$out"
check_contains '--status marks the running top' '1. run-me (running)' "$out"
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null

# A labelled run refused for the load ran nothing, so it keeps its place.
coord=$(new_coord)
locks=$(new_locks)
printf 'loaded\nbehind\n' >"$coord/heavy-order"
echo 60.00 >"$loadf"
out=$(load_env DORKOS_HEAVY_COORD_DIR="$coord" DORKOS_HEAVY_LOCK_DIR="$locks" DORKOS_HEAVY_LOAD_WAIT_SECONDS=1 \
  DORKOS_HEAVY_LOAD_POLL_SECONDS=0.3 bash "$CHECK" --label 'loaded' bash -c 'echo should-not-run' 2>&1)
check_eq 'a load-refused labelled run exits 75' 75 "$?"
check_lacks 'and runs nothing' 'should-not-run' "$out"
check_eq 'and keeps its place on top' 'loaded' "$(awk 'NF { print; exit }' "$coord/heavy-order")"

# CI and a nested call never check the order.
coord=$(new_coord)
locks=$(new_locks)
printf 'someone-else\n' >"$coord/heavy-order"
out=$(order_env "$coord" "$locks" CI=true bash "$CHECK" --label 'mine' bash -c 'echo ci-ran' 2>&1)
check_eq 'under CI the order is not checked' '0:ci-ran' "$?:$out"
out=$(order_env "$coord" "$locks" DORKOS_HEAVY_SLOT_HELD=1 bash "$CHECK" --label 'mine' bash -c 'echo nested-ran' 2>&1)
check_eq 'a nested call is not checked' '0:nested-ran' "$?:$out"

echo ""
echo "== a top label with no live run moves down one place (DOR-4901) =="

stale_env() { order_env "$1" "$2" DORKOS_HEAVY_ORDER_STALE_SECONDS=2 "${@:3}"; }

# The Nov 21 case: the top never starts, the slots are empty, the next waits.
coord=$(new_coord)
locks=$(new_locks)
printf 'never-starts\nwaiting\nthird\n' >"$coord/heavy-order"
# The owner's notify program, named in the caller's own environment.
notify_bin="$work/notify-owner"
printf '#!/usr/bin/env bash\nprintf "%%s|%%s\\n" "$1" "$2" >>"%s/told"\n' "$coord" >"$notify_bin"
chmod +x "$notify_bin"
# A planted executable in the order folder must never run (Security S1, Nov 21).
printf '#!/usr/bin/env bash\n: >"%s/planted-ran"\n' "$coord" >"$coord/heavy-notify"
chmod +x "$coord/heavy-notify"
stale_env() { order_env "$1" "$2" DORKOS_HEAVY_ORDER_STALE_SECONDS=2 DORKOS_HEAVY_NOTIFY="$notify_bin" "${@:3}"; }
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'waiting' bash -c 'echo too-early' 2>&1)
check_eq 'before the bound the next label is still refused' 75 "$?"
sleep 3
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'waiting' bash -c 'echo waiting-ran' 2>&1)
check_eq 'after the bound the next label runs' 0 "$?"
check_contains 'its command ran' 'waiting-ran' "$out"
check_contains 'whoever moved it is told' "moved 'never-starts' down one place, below 'waiting'" "$out"
check_eq 'the idle top moved down ONE place and was not deleted' \
  "$(printf 'never-starts\nthird')" "$(cat "$coord/heavy-order")"
check_contains 'a dated note is written' "moved 'never-starts' down one place" "$(cat "$coord/heavy-order-notes.md")"
for _ in $(seq 1 20); do
  [ -s "$coord/told" ] && break
  sleep 0.1
done
check_contains 'its owner is told through DORKOS_HEAVY_NOTIFY' 'never-starts|' "$(cat "$coord/told" 2>/dev/null)"
sleep 0.5
if [ -e "$coord/planted-ran" ]; then not_ok 'an executable heavy-notify in the order folder was run'; else ok 'an executable heavy-notify in the order folder is never run'; fi
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'third' bash -c 'echo x' 2>&1)
check_contains 'the moved label is back on top, so the one below waits again' "Next is 'never-starts'" "$out"
printf 'other\nnever-starts\n' >"$coord/heavy-order"
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'never-starts' bash -c 'echo x' 2>&1)
check_contains 'the owner is told when it next asks' "about 'never-starts'" "$out"

# A top label that is running is never moved, however long it runs.
coord=$(new_coord)
locks=$(new_locks)
printf 'long-run\npatient\n' >"$coord/heavy-order"
stale_env "$coord" "$locks" bash "$CHECK" --label 'long-run' sleep 30 >/dev/null 2>&1 &
holder=$!
own_pids+=("$holder")
await_locked "$locks" 1 || not_ok 'long-run never took a slot'
stale_env "$coord" "$locks" bash "$CHECK" --label 'patient' true >/dev/null 2>&1
sleep 3
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'patient' bash -c 'echo jumped' 2>&1)
check_eq 'a running top is never moved' 75 "$?"
check_eq 'the line is unchanged' "$(printf 'long-run\npatient')" "$(cat "$coord/heavy-order")"
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null

# Waiting for a slot counts as live too: the claim is taken before the wait.
coord=$(new_coord)
locks=$(new_locks)
printf 'queued-top\nbehind-it\n' >"$coord/heavy-order"
start_holder "$locks" 30
order_env "$coord" "$locks" DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_ORDER_STALE_SECONDS=2 DORKOS_HEAVY_WAIT_SECONDS=30 \
  bash "$CHECK" --label 'queued-top' true >/dev/null 2>&1 &
waiter=$!
own_pids+=("$waiter")
sleep 1
stale_env "$coord" "$locks" bash "$CHECK" --label 'behind-it' true >/dev/null 2>&1
sleep 3
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'behind-it' bash -c 'echo jumped' 2>&1)
check_eq 'a top waiting for a slot is never moved' 75 "$?"
signal_tree KILL "$waiter"
signal_tree KILL "$holder"
wait "$waiter" "$holder" 2>/dev/null

# The QA case (DOR-4901 comment): a driver that runs outside this script, with
# every slot empty of commands. Held for its pid, it keeps its place and a slot.
coord=$(new_coord)
locks=$(new_locks)
printf 'qa-driver\nnext-pr\n' >"$coord/heavy-order"
sleep 30 &
driver=$!
own_pids+=("$driver")
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'qa-driver' --hold "$driver" 2>&1)
check_eq '--label --hold returns at once' 0 "$?"
if slot_locked "$locks" 1; then ok '--label --hold holds a slot for the driver'; else not_ok '--label --hold took no slot'; fi
stale_env "$coord" "$locks" bash "$CHECK" --label 'next-pr' true >/dev/null 2>&1
sleep 3
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'next-pr' bash -c 'echo jumped' 2>&1)
check_eq 'a held driver is never moved while it lives' 75 "$?"
check_eq 'the held line is unchanged' "$(printf 'qa-driver\nnext-pr')" "$(cat "$coord/heavy-order")"
kill -KILL "$driver" 2>/dev/null
wait "$driver" 2>/dev/null
# Its beat ages out after two minutes; age it by hand rather than wait.
for b in "$coord"/heavy-claims/*.beat; do touch -t 202001010000 "$b"; done
stale_env "$coord" "$locks" bash "$CHECK" --label 'next-pr' true >/dev/null 2>&1
sleep 3
out=$(stale_env "$coord" "$locks" bash "$CHECK" --label 'next-pr' bash -c 'echo next-pr-ran' 2>&1)
check_contains 'once the driver is gone, its idle line moves down' 'next-pr-ran' "$out"

# Alone in line: there is nobody to let past, so it stays.
coord=$(new_coord)
locks=$(new_locks)
printf 'lonely\n' >"$coord/heavy-order"
stale_env "$coord" "$locks" bash "$CHECK" --status >/dev/null 2>&1
sleep 3
stale_env "$coord" "$locks" bash "$CHECK" --status >/dev/null 2>&1
check_eq 'a lone idle top is not moved' 'lonely' "$(cat "$coord/heavy-order")"
if [ -e "$coord/heavy-order-notes.md" ]; then not_ok 'a note was written for a lone top'; else ok 'and no note is written'; fi

echo ""
echo "== the second label may start beside the top while the machine is healthy (DOR-5073) =="

# The machine is faked: DORKOS_HEAVY_MACHINE_CMD prints "<swap MB> <free %>
# <5-minute load> <free disk GB>", and a swap sample from 700 s ago is planted
# so the growth check has something to measure against. 12 GB is 12288 MB, so
# 11.9 / 12.0 / 12.1 GB are 12185.6 / 12288 / 12390.4.
memf="$work/machine"
mem_env() { order_env "$1" "$2" DORKOS_HEAVY_MACHINE_CMD="cat $memf" "${@:3}"; }
# try_label <label> <reading> [<swap MB 700 s ago> | none] [<age of that sample, s>]
# runs <label> against a fresh top/second/third line, leaving "<exit>:<output>"
# in $out. By default the old sample has the same swap, so growth is 0.
try_label() {
  local old=${3:-} age=${4:-700}
  coord=$(new_coord)
  locks=$(new_locks)
  printf 'top-job\nsecond-job\nthird-job\n' >"$coord/heavy-order"
  printf '%s\n' "$2" >"$memf"
  [ -n "$old" ] || old=$(printf '%s' "$2" | awk '{ print $1 }')
  [ "$old" = none ] || [ -z "$old" ] || printf '%s %s\n' "$(($(date +%s) - age))" "$old" >"$coord/heavy-swap-samples"
  out=$(mem_env "$coord" "$locks" bash "$CHECK" --label "$1" bash -c "echo $1-ran" 2>&1)
  out="$?:$out"
}
starts() { check_contains "$1" '0:' "${out:0:2}"; }
refused() { check_contains "$1" '75:' "${out:0:3}"; }

try_label second-job '12185.6 41 1.0 200'
starts 'a healthy machine: the second starts'
check_contains 'its command ran' 'second-job-ran' "$out"
check_contains 'it says why it may start' "may start beside 'top-job'" "$out"
check_eq 'it left the line when it ended; the top keeps its place' \
  "$(printf 'top-job\nthird-job')" "$(cat "$coord/heavy-order")"

# Swap used: under 12288 MB.
try_label second-job '12288 41 1.0 200'
refused 'swap 12.0 GB: the second is refused'
check_contains 'and told why' 'swap used is 12288 MB, at or over 12288 MB' "$out"
check_contains 'and who is next' "Next is 'top-job'" "$out"
check_contains 'and that it may try again soon' 'Try again in a few minutes' "$out"
check_lacks 'and runs nothing' 'second-job-ran' "$out"
try_label second-job '12390.4 41 1.0 200'
refused 'swap 12.1 GB: the second is refused'

# Free memory: at least 40%.
try_label second-job '0 39 1.0 200'
refused 'free 39%: the second is refused'
check_contains 'and told why' 'free memory is 39%, under 40%' "$out"
try_label second-job '0 40 1.0 200'
starts 'free 40%: the second starts'
try_label second-job '0 41 1.0 200'
starts 'free 41%: the second starts'
try_label second-job '12390.4 39 1.0 200'
refused 'both over (12.1 GB, 39%): the second is refused'
try_label second-job '12185.6 40 1.0 200'
starts 'both just inside (11.9 GB, 40%): the second starts'
try_label second-job '12185.6 39 1.0 200'
refused 'swap fine but free 39%: the second is refused'
try_label second-job '12288 40 1.0 200'
refused 'free fine but swap 12.0 GB: the second is refused'

# Swap growth: at most 512 MB over 10 minutes.
try_label second-job '1512 50 1.0 200' 1000
starts 'swap grew 512 MB: the second starts'
try_label second-job '1513 50 1.0 200' 1000
refused 'swap grew 513 MB: the second is refused'
check_contains 'and told why' 'swap grew from 1000 to 1513 MB' "$out"
try_label second-job '1511.5 50 1.0 200' 1000
starts 'swap grew 511.5 MB: the second starts'
try_label second-job '1000 50 1.0 200' none
refused 'no swap sample from 10 minutes ago: the second is refused'
check_contains 'and told one was just taken' 'one was just taken' "$out"
check_eq 'and the sample is recorded' 1 "$(awk 'END { print NR }' "$coord/heavy-swap-samples")"
try_label second-job '1000 50 1.0 200' 1000 300
refused 'a sample only 5 minutes old: the second is refused'
try_label second-job '1000 50 1.0 200' 1000 2000
refused 'a sample over 30 minutes old: the second is refused'
try_label second-job '1000 50 1.0 200' 1000 1700
starts 'a sample 28 minutes old: the second starts'

# 5-minute load: under 16.
try_label second-job '0 50 15.99 200'
starts 'load 15.99: the second starts'
try_label second-job '0 50 16 200'
refused 'load 16: the second is refused'
check_contains 'and told why' 'the 5-minute load is 16, at or over 16' "$out"
try_label second-job '0 50 16.01 200'
refused 'load 16.01: the second is refused'

# Free disk: at least 50 GB.
try_label second-job '0 50 1.0 49.99'
refused 'disk 49.99 GB: the second is refused'
check_contains 'and told why' 'free disk is 49.99 GB, under 50 GB' "$out"
try_label second-job '0 50 1.0 50'
starts 'disk 50 GB: the second starts'
try_label second-job '0 50 1.0 50.01'
starts 'disk 50.01 GB: the second starts'

# A reading that cannot be had, or makes no sense, counts as unhealthy.
try_label second-job '' none
refused 'no reading: the second is refused'
check_contains 'and told it could not be read' 'could not all be read' "$out"
try_label second-job '0 50 1.0' none
refused 'a reading missing the disk: the second is refused'
try_label second-job 'lots 50 1.0 200' none
refused 'a malformed reading: the second is refused'
try_label second-job '-5 50 1.0 200' none
refused 'a negative reading: the second is refused'
try_label second-job '1e3 50 1.0 200' none
refused 'an exponent reading: the second is refused'
# A limit that is not a number refuses rather than turning into 0.
coord=$(new_coord)
locks=$(new_locks)
printf 'top-job\nsecond-job\n' >"$coord/heavy-order"
printf '0 50 1.0 200\n' >"$memf"
printf '%s 0\n' "$(($(date +%s) - 700))" >"$coord/heavy-swap-samples"
out=$(mem_env "$coord" "$locks" DORKOS_HEAVY_SECOND_DISK_MIN_GB=lots bash "$CHECK" --label second-job bash -c 'echo x' 2>&1)
check_eq 'a limit that is not a number refuses the second' 75 "$?"
check_contains 'and says so' 'is not a number' "$out"

# The top always may start; the third never does.
try_label top-job '99999 0 99 0' none
starts 'the top starts however bad the machine is'
check_contains 'its command ran' 'top-job-ran' "$out"
try_label third-job '0 100 0 999'
refused 'the third never starts, however healthy the machine is'
check_lacks 'and runs nothing' 'third-job-ran' "$out"
check_lacks 'and is not told about the machine' 'REFUSE (machine)' "$out"

# Two at once: the second starts while the top is running.
coord=$(new_coord)
locks=$(new_locks)
printf 'top-job\nsecond-job\n' >"$coord/heavy-order"
printf '0 100 0 999\n' >"$memf"
printf '%s 0\n' "$(($(date +%s) - 700))" >"$coord/heavy-swap-samples"
mem_env "$coord" "$locks" bash "$CHECK" --label 'top-job' sleep 30 >/dev/null 2>&1 &
holder=$!
own_pids+=("$holder")
await_locked "$locks" 1 || not_ok 'top-job never took a slot'
out=$(mem_env "$coord" "$locks" bash "$CHECK" --label 'second-job' bash -c 'echo beside-ran' 2>&1)
check_eq 'the second runs while the top runs' 0 "$?"
check_contains 'its command ran' 'beside-ran' "$out"
check_eq 'the running top keeps its place' 'top-job' "$(awk 'NF' "$coord/heavy-order")"
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null

# A second starting beside an idle top does not restart the top's idle clock,
# so an idle top still moves down on time. Wide margins: without the guard the
# clock restarts at the second's exit, 2 s in, so a 6 s bound would not be
# reached until 8 s; this checks at 7 s.
coord=$(new_coord)
locks=$(new_locks)
printf 'idle-top\nsecond-job\nthird-job\n' >"$coord/heavy-order"
printf '0 100 0 999\n' >"$memf"
printf '%s 0\n' "$(($(date +%s) - 700))" >"$coord/heavy-swap-samples"
mem_env "$coord" "$locks" DORKOS_HEAVY_ORDER_STALE_SECONDS=6 bash "$CHECK" --status >/dev/null 2>&1
sleep 2
out=$(mem_env "$coord" "$locks" DORKOS_HEAVY_ORDER_STALE_SECONDS=6 bash "$CHECK" --label 'second-job' bash -c 'echo ok' 2>&1)
check_contains 'the second ran beside the idle top' 'may start beside' "$out"
sleep 5
mem_env "$coord" "$locks" DORKOS_HEAVY_ORDER_STALE_SECONDS=6 bash "$CHECK" --status >/dev/null 2>&1
check_eq 'the idle top moved down on its own clock' \
  "$(printf 'third-job\nidle-top')" "$(awk 'NF' "$coord/heavy-order")"

echo ""
echo "== the order line takes commands, never a hand edit (DOR-5079) =="

# Each command, with its exit code first, as "rc:output".
ord() { local c=$1 l=$2; shift 2; out=$(order_env "$c" "$l" bash "$CHECK" "$@" 2>&1); echo "$?:$out"; }
# The same, with one VAR=value setting for the run.
ordv() { local c=$1 l=$2 v=$3; shift 3; out=$(order_env "$c" "$l" "$v" bash "$CHECK" "$@" 2>&1); echo "$?:$out"; }
line_of() { awk 'NF' "$1/heavy-order" | tr '\n' '|'; }

coord=$(new_coord)
locks=$(new_locks)
check_contains '--list on an empty line says so' '0:[heavy] order: (empty: no order)' "$(ord "$coord" "$locks" --list)"
check_contains '--insert adds at the end' "0:[heavy] order: insert 'alpha' done" "$(ord "$coord" "$locks" --insert alpha)"
ord "$coord" "$locks" --insert beta >/dev/null
check_contains '--insert --top goes first' '  1  no ticket   gamma' "$(ord "$coord" "$locks" --insert gamma --top)"
ord "$coord" "$locks" --insert delta --after gamma >/dev/null
ord "$coord" "$locks" --insert eps --before beta >/dev/null
ord "$coord" "$locks" --insert zeta --at 2 >/dev/null
check_eq 'after, before and --at place the label' 'gamma|zeta|delta|alpha|eps|beta|' "$(line_of "$coord")"
check_contains '--list numbers the line' '  6  no ticket   beta' "$(ord "$coord" "$locks" --list)"

# A duplicate insert, an unknown label, a bad anchor: refused (2), nothing changed.
before=$(line_of "$coord")
r=$(ord "$coord" "$locks" --insert beta)
check_contains 'a duplicate insert is refused (2)' "2:[heavy] REFUSE (order): 'beta' is already in the line (#6); use --move" "$r"
r=$(ord "$coord" "$locks" --move nobody --top)
check_contains 'moving an unknown label is refused (2)' "2:[heavy] REFUSE (order): 'nobody' is not in the line" "$r"
r=$(ord "$coord" "$locks" --remove nobody --reason 'made-up')
check_contains 'removing an unknown label is refused (2)' "2:" "$r"
r=$(ord "$coord" "$locks" --insert omega --after nobody)
check_contains 'an anchor not in the line is refused (2)' "anchor 'nobody' is not in the line" "$r"
r=$(ord "$coord" "$locks" --move beta --after beta)
check_contains 'a label placed after itself is refused' "cannot be placed after itself" "$r"
r=$(ord "$coord" "$locks" --insert omega --at 9)
check_contains '--at out of range is refused' '--at 9 is out of range (1..7)' "$r"
r=$(ord "$coord" "$locks" --move beta)
check_contains '--move needs a position' '2:[heavy] usage: a position is required' "$r"
r=$(ord "$coord" "$locks" --insert omega --sideways)
check_contains 'an unknown position is a usage error' "unknown position '--sideways'" "$r"
r=$(ord "$coord" "$locks" --insert 'bad\label')
check_contains 'a label outside the allowed set is refused (2)' '2:[heavy] REFUSE (label)' "$r"
r=$(ord "$coord" "$locks" --label 'bad;label' bash -c 'echo ran')
check_contains 'a run with a bad label is refused (2) and runs nothing' '2:[heavy] REFUSE (label)' "$r"
r=$(ord "$coord" "$locks" --insert 'two  spaces')
check_contains 'a label with two spaces in a row is refused (it could never leave)' '2:[heavy] REFUSE (label)' "$r"
r=$(ord "$coord" "$locks" --insert omega --at 99999999999999999999999)
check_contains 'an --at too big for a number is refused, as live does' '2:[heavy] REFUSE (order): --at' "$r"
r=$(ord "$coord" "$locks" --remove beta)
check_contains '--remove needs --reason' '2:[heavy] REFUSE (order): --remove needs --reason' "$r"
check_eq 'none of the refusals changed the line' "$before" "$(line_of "$coord")"

r=$(ord "$coord" "$locks" --move beta --top)
check_contains '--move --top moves it first' '  1  no ticket   beta' "$r"
r=$(ord "$coord" "$locks" --remove eps --reason 'made-up: no longer needed')
check_eq '--remove with a reason drops it' 'beta|gamma|zeta|delta|alpha|' "$(line_of "$coord")"
check_contains 'and the reason is in the log' 'made-up: no longer needed' "$(cat "$coord/heavy-order.log")"
r=$(ord "$coord" "$locks" --done never-there)
check_contains '--done on an unknown label is a no-op (0)' "0:[heavy] order: popped 'never-there'" "$r"
check_contains 'and is logged as not in line' 'not-in-line (no change)' "$(cat "$coord/heavy-order.log")"
r=$(ord "$coord" "$locks" --done alpha)
check_contains '--done leaves the line' "next is 'beta'" "$r"
check_eq 'only that label left' 'beta|gamma|zeta|delta|' "$(line_of "$coord")"
check_eq 'every write is one log line, refusals none' 10 "$(wc -l <"$coord/heavy-order.log" | tr -d ' ')"
r=$(ord "$coord" "$locks" --help)
check_contains '--help prints the usage (2)' '2:usage: heavy-run-lock.sh --label' "$r"

# A hand edit is said out loud and logged; the write still goes ahead.
printf 'hand-added\n' >>"$coord/heavy-order"
r=$(ord "$coord" "$locks" --insert theta)
check_contains 'a hand edit is noticed' 'was changed outside heavy-run-lock.sh' "$r"
check_contains 'and the write still went ahead' "insert 'theta' done" "$r"
check_contains 'and it is logged' 'external-edit-detected' "$(cat "$coord/heavy-order.log")"
r=$(ord "$coord" "$locks" --list)
check_lacks 'a managed write leaves no warning behind' 'changed outside' "$r"

# The verify: a write that would lose or gain a label writes nothing (3).
before=$(line_of "$coord")
r=$(ordv "$coord" "$locks" DORKOS_HEAVY_ORDER_TEST_CORRUPT=drop-first --insert iota)
check_contains 'a write that would lose a label is refused (3)' '3:[heavy] REFUSE (order verify)' "$r"
check_contains 'and names what would be lost' "would be LOST: 'beta'" "$r"
r=$(ordv "$coord" "$locks" DORKOS_HEAVY_ORDER_TEST_CORRUPT=dup-last --move beta --at 2)
check_contains 'a write that would duplicate a label is refused (3)' 'would be ADDED/DUPLICATED' "$r"
check_eq 'and nothing was written' "$before" "$(line_of "$coord")"

# The lock is a kernel flock on heavy-order.lock (DOR-5082). hold_order_lock
# <coord> <seconds> holds it from another process, the way a slow writer
# would, until `<coord>/release` appears or the seconds run out, and returns
# once it is held; the holder's pid is in $holder.
hold_order_lock() {
  rm -f -- "$1/held" "$1/release"
  # shellcheck disable=SC2016 # a perl program, not a shell expansion
  perl -MFcntl=:flock -e '
    open(my $f, ">>", $ARGV[0]) or exit 1;
    flock($f, LOCK_EX) or exit 1;
    open(my $r, ">", $ARGV[2]) or exit 1;
    close $r;
    for (1 .. $ARGV[1] * 20) {
      last if -e $ARGV[3];
      select(undef, undef, undef, 0.05);
    }' "$1/heavy-order.lock" "$2" "$1/held" "$1/release" &
  holder=$!
  own_pids+=("$holder")
  for _ in $(seq 1 100); do
    [ -f "$1/held" ] && return 0
    sleep 0.05
  done
  return 1
}

# A held lock refuses a write in time (4) and changes nothing.
hold_order_lock "$coord" 60 || not_ok 'the test holder never took the order lock'
started=$(date +%s)
r=$(ordv "$coord" "$locks" DORKOS_HEAVY_ORDER_LOCK_WAIT=1 --insert kappa)
check_contains 'a held lock refuses the write (4)' '4:[heavy] order: lock busy for 1s, nothing changed' "$r"
check_le 'within its wait' 3 "$(($(date +%s) - started))"
r=$(ordv "$coord" "$locks" DORKOS_HEAVY_ORDER_LOCK_WAIT=1 --done beta)
check_eq 'a --done that cannot lock exits 4' 4 "${r%%:*}"
check_contains 'and says so loudly' "[heavy] ORDER POP FAILED" "$r"
check_eq 'and the label is still in line' "$before" "$(line_of "$coord")"
# A holder that dies, however it dies, lets go at once: nothing waits for a
# lock to look old, so nothing can take over a live one.
kill -KILL "$holder" 2>/dev/null
wait "$holder" 2>/dev/null
r=$(ordv "$coord" "$locks" DORKOS_HEAVY_ORDER_LOCK_WAIT=1 --insert kappa)
check_contains 'a holder killed with SIGKILL frees the lock at once' "0:[heavy] order: insert 'kappa' done" "$r"
# An old lock folder from the mkdir lock this replaced means nothing now.
mkdir "$coord/heavy-order.lock.d"
r=$(ordv "$coord" "$locks" DORKOS_HEAVY_ORDER_LOCK_WAIT=1 --insert lambda)
check_contains 'an old heavy-order.lock.d folder blocks nothing' "0:[heavy] order: insert 'lambda' done" "$r"

# A slow write keeps every other writer out until it ends (DOR-5082): two
# writers that arrive while the lock is held both wait, then both land.
coord=$(new_coord)
locks=$(new_locks)
ord "$coord" "$locks" --insert first >/dev/null
hold_order_lock "$coord" 60 || not_ok 'the test holder never took the order lock'
order_env "$coord" "$locks" bash "$CHECK" --insert waiter-1 >/dev/null 2>&1 &
w1=$!
order_env "$coord" "$locks" bash "$CHECK" --insert waiter-2 >/dev/null 2>&1 &
w2=$!
own_pids+=("$w1" "$w2")
sleep 1
check_eq 'no writer gets in while a slow write holds the lock' 'first|' "$(line_of "$coord")"
# Still running means still waiting: the check above saw writers held off,
# not writers that had yet to start.
if kill -0 "$w1" 2>/dev/null && kill -0 "$w2" 2>/dev/null; then
  ok 'both writers are still waiting for it'
else
  not_ok 'both writers are still waiting for it'
fi
touch "$coord/release"
wait "$holder" 2>/dev/null
wait "$w1"
c1=$?
wait "$w2"
c2=$?
check_eq 'both waiting writers finish once it lets go' '0 0' "$c1 $c2"
check_eq 'and both land' 'first|waiter-1|waiter-2|' "$(awk 'NF' "$coord/heavy-order" | LC_ALL=C sort | tr '\n' '|')"

# Concurrent writes all land: none lost, none doubled.
coord=$(new_coord)
locks=$(new_locks)
pids=()
for i in 1 2 3 4 5 6 7 8; do
  order_env "$coord" "$locks" bash "$CHECK" --insert "job-$i" >/dev/null 2>&1 &
  pids+=("$!")
done
codes=''
for p in "${pids[@]}"; do
  wait "$p"
  codes="$codes $?"
done
# Every exit code, so a writer that failed is told apart from one that was lost.
check_eq 'every concurrent insert exits 0' ' 0 0 0 0 0 0 0 0' "$codes"
check_eq 'eight concurrent inserts all land' 8 "$(awk 'NF' "$coord/heavy-order" | sort -u | wc -l | tr -d ' ')"
check_eq 'and none is doubled' 8 "$(awk 'NF' "$coord/heavy-order" | wc -l | tr -d ' ')"

# Writes while a top row is running: a release row jumps in behind it, the
# running top can be moved past or removed, and its own end changes nothing else.
coord=$(new_coord)
locks=$(new_locks)
ord "$coord" "$locks" --insert running-job >/dev/null
ord "$coord" "$locks" --insert waiting-job >/dev/null
order_env "$coord" "$locks" bash "$CHECK" --label 'running-job' sleep 30 >/dev/null 2>&1 &
holder=$!
own_pids+=("$holder")
await_locked "$locks" 1 || not_ok 'running-job never took a slot'
ord "$coord" "$locks" --insert 'release v9.9.9 QA gate' --after running-job >/dev/null
check_eq 'a release row goes in right behind the running job' \
  'running-job|release v9.9.9 QA gate|waiting-job|' "$(line_of "$coord")"
ord "$coord" "$locks" --move waiting-job --top >/dev/null
check_eq 'a row can move to the top while another runs' \
  'waiting-job|running-job|release v9.9.9 QA gate|' "$(line_of "$coord")"
r=$(ord "$coord" "$locks" --remove running-job --reason 'made-up: superseded')
check_contains 'the running row can be removed, with a reason' "remove 'running-job' done" "$r"
signal_tree TERM "$holder"
wait "$holder" 2>/dev/null
check_eq 'the removed job ending changes nothing else' 'waiting-job|release v9.9.9 QA gate|' "$(line_of "$coord")"
r=$(ord "$coord" "$locks" --list)
check_lacks 'and a run leaving the line leaves no hand-edit warning' 'changed outside' "$r"

# A labelled run leaving the line keeps the stored hash in step, and logs it.
coord=$(new_coord)
locks=$(new_locks)
ord "$coord" "$locks" --insert solo >/dev/null
ord "$coord" "$locks" --insert after-solo >/dev/null
order_env "$coord" "$locks" bash "$CHECK" --label solo bash -c 'true' >/dev/null 2>&1
check_eq 'the run left the line' 'after-solo|' "$(line_of "$coord")"
check_contains 'the run'"'"'s leaving is logged' "	done	solo	was #1" "$(cat "$coord/heavy-order.log")"
r=$(ord "$coord" "$locks" --insert next)
check_lacks 'and the next write sees no hand edit' 'changed outside' "$r"

# The old script's run form, `<label> -- <command>`, still works after --label.
r=$(ord "$coord" "$locks" --label after-solo -- bash -c 'echo dashdash-ran')
check_contains 'a -- after --label <label> is taken, and the command runs' '0:' "${r:0:2}"
check_contains 'the command after -- ran' 'dashdash-ran' "$r"

echo "== an --insert with no position goes where its ticket ranks (DOR-5065) =="
# A fake flow: records each call, then prints the fixture, fails, hangs or
# prints junk as FLOW_MODE says. In flight: DOR-50, then DOR-60. Ranks: DOR-1
# 1, DOR-10 2, DOR-20 3, DOR-30 4, DOR-40 5; DOR-99 held (unranked); anything
# else is not an open item.
flow_bin="$work/fake-flow"
cat >"$flow_bin" <<'FLOW'
#!/usr/bin/env bash
[ -n "${FLOW_CALLS:-}" ] && echo "$*" >>"$FLOW_CALLS"
case "${FLOW_MODE:-}" in
  fail) echo 'flow: unknown verb order' >&2; exit 2 ;;
  slow) sleep 6 ;;
  slowish) sleep 2 ;;
  junk) echo 'not json'; exit 0 ;;
esac
cat <<'JSON'
{"v":1,"generatedAt":"2026-11-23T00:00:00Z","issues":[
 {"place":1,"identifier":"DOR-1"},{"place":2,"identifier":"DOR-10"},
 {"place":3,"identifier":"DOR-20"},{"place":4,"identifier":"DOR-30"},
 {"place":5,"identifier":"DOR-40"}],
 "inFlight":[{"identifier":"DOR-50"},{"identifier":"DOR-60"}],
 "held":[{"identifier":"DOR-99","reason":"blocked"}],"needsTriage":[],"dorian":[]}
JSON
FLOW
chmod +x "$flow_bin"
calls="$work/flow-calls"
# rk <coord> <locks> <args...>: one command with the fake flow, as "rc:output".
rk() {
  local c=$1 l=$2
  shift 2
  out=$(order_env "$c" "$l" DORKOS_HEAVY_FLOW_CMD="$flow_bin" FLOW_CALLS="$calls" \
    FLOW_MODE="${FLOW_MODE:-}" DORKOS_HEAVY_FLOW_TIMEOUT="${FLOW_TIMEOUT:-10}" \
    DORKOS_HEAVY_FLOW_REFRESH_TIMEOUT="${FLOW_REFRESH:-10}" DORKOS_HEAVY_RANKS_MAX_AGE="${RANKS_MAX_AGE:-1800}" \
    bash "$CHECK" "$@" 2>&1)
  echo "$?:$out"
}
last_log() { tail -n 1 "$1/heavy-order.log" | awk -F '\t' '{ print $2 "|" $3 "|" $4 }'; }

coord=$(new_coord)
locks=$(new_locks)
rk "$coord" "$locks" --insert 'pr DOR-30 build' >/dev/null
r=$(rk "$coord" "$locks" --insert 'dor-10 lower case')
check_contains 'a ranked label goes in front of a lower-ranked one' "0:[heavy] order: insert 'dor-10 lower case' done (by rank: DOR-10: rank 2)" "$r"
check_eq 'the ticket is found in any case' 'dor-10 lower case|pr DOR-30 build|' "$(line_of "$coord")"
check_eq 'and the log says the work order placed it' 'insert|dor-10 lower case|by rank: DOR-10: rank 2 -> #1' "$(last_log "$coord")"
r=$(rk "$coord" "$locks" --insert 'misc job')
check_eq 'a label with no ticket goes to the end' 'dor-10 lower case|pr DOR-30 build|misc job|' "$(line_of "$coord")"
check_eq 'with a note in the log' 'insert|misc job|by rank: no ticket in the label: at the end -> #3' "$(last_log "$coord")"
rk "$coord" "$locks" --insert 'DOR-20 middle' >/dev/null
check_eq 'a ranked label goes between the two it ranks between' \
  'dor-10 lower case|DOR-20 middle|pr DOR-30 build|misc job|' "$(line_of "$coord")"
rk "$coord" "$locks" --insert 'DOR-40 last ranked' >/dev/null
check_eq 'a line with no ticket counts as lowest' \
  'dor-10 lower case|DOR-20 middle|pr DOR-30 build|DOR-40 last ranked|misc job|' "$(line_of "$coord")"
rk "$coord" "$locks" --insert 'DOR-30 second' >/dev/null
check_eq 'an equal rank goes behind the one already there' \
  'dor-10 lower case|DOR-20 middle|pr DOR-30 build|DOR-30 second|DOR-40 last ranked|misc job|' "$(line_of "$coord")"
r=$(rk "$coord" "$locks" --insert 'DOR-99 held')
check_contains 'a ticket flow does not rank goes to the end, with a note' "(by rank: DOR-99: unranked in flow order: at the end)" "$r"
r=$(rk "$coord" "$locks" --insert 'DOR-7777 closed')
check_contains 'so does a ticket flow does not list at all' "(by rank: DOR-7777: unranked in flow order: at the end)" "$r"
rk "$coord" "$locks" --insert 'DOR-1 urgent' >/dev/null
check_eq 'an unranked line in the middle is passed by a better one' 'DOR-1 urgent' "$(awk 'NF' "$coord/heavy-order" | head -n 1)"

# Release rows go first, behind release rows already there; ranked labels never pass one.
rk "$coord" "$locks" --insert 'rel-9.9.9' >/dev/null
rk "$coord" "$locks" --insert 'qa-gate-9.9.9' >/dev/null
rk "$coord" "$locks" --insert 'qa-row-1 DOR-30' >/dev/null
check_eq 'release rows go first, in the order they came' 'rel-9.9.9|qa-gate-9.9.9|qa-row-1 DOR-30|DOR-1 urgent|' \
  "$(awk 'NF' "$coord/heavy-order" | head -n 4 | tr '\n' '|')"
rk "$coord" "$locks" --remove 'DOR-1 urgent' --reason 'made-up: test' >/dev/null
rk "$coord" "$locks" --insert 'DOR-1 again' >/dev/null
check_eq 'a ranked label never passes a release row' 'DOR-1 again' "$(awk 'NF' "$coord/heavy-order" | sed -n 4p)"

# --list: one short rank column, from ONE flow call for the whole line, and
# none while the kept ranks are fresh.
: >"$calls"
r=$(RANKS_MAX_AGE=0 rk "$coord" "$locks" --list)
check_eq '--list asks flow once for the whole line' 1 "$(wc -l <"$calls" | tr -d ' ')"
check_eq 'and asks for the whole order as JSON' 'order --json' "$(head -n 1 "$calls")"
: >"$calls"
rk "$coord" "$locks" --list >/dev/null
rk "$coord" "$locks" --insert 'DOR-20 from kept ranks' >/dev/null
check_eq 'fresh kept ranks ask flow nothing' 0 "$(wc -l <"$calls" | tr -d ' ')"
check_contains '--list shows a release row' '  1  release     rel-9.9.9' "$r"
check_contains '--list shows a rank' '  4  rank 1      DOR-1 again' "$r"
check_contains '--list shows an unranked ticket' 'unranked    DOR-99 held' "$r"
check_contains '--list shows a label with no ticket' 'no ticket   misc job' "$r"
: >"$calls"
RANKS_MAX_AGE=0 rk "$coord" "$locks" --insert 'DOR-20 one call' >/dev/null
check_eq 'an insert and its listing ask flow once in all' 1 "$(wc -l <"$calls" | tr -d ' ')"
: >"$calls"
RANKS_MAX_AGE=0 rk "$coord" "$locks" --insert 'no ticket here' >/dev/null
RANKS_MAX_AGE=0 rk "$coord" "$locks" --insert 'rel-1.0.0-two' >/dev/null
coord2=$(new_coord)
RANKS_MAX_AGE=0 rk "$coord2" "$locks" --insert 'plain' >/dev/null
check_eq 'no ticket, a release row, and the listing after a write ask flow nothing' 0 "$(wc -l <"$calls" | tr -d ' ')"

# A person's placement says so in the log.
rk "$coord" "$locks" --move 'misc job' --top >/dev/null
check_eq 'a --move is logged as a person'"'"'s' 'move|misc job|by hand: top -> #1' "$(last_log "$coord")"
rk "$coord" "$locks" --insert 'DOR-10 placed' --after 'misc job' >/dev/null
check_eq 'so is an --insert that names its place' "insert|DOR-10 placed|by hand: after 'misc job' -> #2" "$(last_log "$coord")"

# A running line is never passed: a release row lands behind it.
coord=$(new_coord)
locks=$(new_locks)
rk "$coord" "$locks" --insert 'DOR-40 running' >/dev/null
rk "$coord" "$locks" --insert 'misc waiting' >/dev/null
sleep 30 &
driver=$!
own_pids+=("$driver")
order_env "$coord" "$locks" bash "$CHECK" --label 'DOR-40 running' --hold "$driver" >/dev/null 2>&1
rk "$coord" "$locks" --insert 'rel-2.0.0' >/dev/null
rk "$coord" "$locks" --insert 'DOR-1 best' >/dev/null
check_eq 'a release row and a better rank both land behind a running line' \
  'DOR-40 running|rel-2.0.0|DOR-1 best|misc waiting|' "$(line_of "$coord")"
kill -KILL "$driver" 2>/dev/null
wait "$driver" 2>/dev/null

# Flow missing, failing, slow or printing junk: the label goes to the end, with
# a note, and the write goes ahead (exit 0). Never a blocked line.
for mode in missing fail junk slow; do
  coord=$(new_coord)
  locks=$(new_locks)
  order_env "$coord" "$locks" bash "$CHECK" --insert 'DOR-40 there' >/dev/null 2>&1
  start=$(date +%s)
  if [ "$mode" = missing ]; then
    r=$(order_env "$coord" "$locks" bash "$CHECK" --insert 'DOR-1 new' 2>&1)
    r="$?:$r"
  else
    r=$(FLOW_MODE=$mode FLOW_TIMEOUT=1 FLOW_REFRESH=2 rk "$coord" "$locks" --insert 'DOR-1 new')
  fi
  took=$(($(date +%s) - start))
  check_contains "flow $mode: the insert still succeeds" "0:[heavy] order: insert 'DOR-1 new' done" "$r"
  check_eq "flow $mode: the label goes to the end" 'DOR-40 there|DOR-1 new|' "$(line_of "$coord")"
  check_contains "flow $mode: the log says why" 'by rank: DOR-1: no rank (' "$(last_log "$coord")"
  check_contains "flow $mode: --list shows the rank as unknown" 'unknown     DOR-1 new' "$r"
  check_le "flow $mode: the lookup is capped" 4 "$took"
done
check_contains 'a slow flow is named as still running' 'flow order is still running after 1s' "$r"
coord=$(new_coord)
r=$(FLOW_MODE=fail rk "$coord" "$locks" --insert 'DOR-1 x')
check_contains 'a failing flow is named, with the version that has order' 'flow order failed (exit 2; Flow 0.100.0 or later has it)' "$r"
r=$(FLOW_MODE=junk rk "$coord" "$locks" --list)
check_contains 'junk from flow is named' 'no ranks: flow order printed no work order' "$r"

# Work in flight ranks ahead of every queued issue, in flight order.
coord=$(new_coord)
locks=$(new_locks)
rk "$coord" "$locks" --insert 'DOR-1 best todo' >/dev/null
rk "$coord" "$locks" --insert 'DOR-60 in review' >/dev/null
r=$(rk "$coord" "$locks" --insert 'DOR-50 in progress')
check_eq 'work in flight goes ahead of the best queued issue, in flight order' \
  'DOR-50 in progress|DOR-60 in review|DOR-1 best todo|' "$(line_of "$coord")"
check_contains 'and --list says it is in flight' '  1  in flight   DOR-50 in progress' "$r"
check_eq 'and the log says so' 'insert|DOR-50 in progress|by rank: DOR-50: in flight -> #1' "$(last_log "$coord")"

# A ticket id must not be glued to a letter or digit before it.
r=$(rk "$coord" "$locks" --insert 'xdor-10 glued')
check_contains 'xdor-10 names no ticket' '(by rank: no ticket in the label: at the end)' "$r"
r=$(rk "$coord" "$locks" --insert 'pr/DOR-10 slash')
check_contains 'pr/DOR-10 names DOR-10' '(by rank: DOR-10: rank 2)' "$r"

# Nothing ranked goes at or above the LAST release row or running line.
coord=$(new_coord)
locks=$(new_locks)
rk "$coord" "$locks" --insert 'DOR-40 running second' >/dev/null
sleep 30 &
driver=$!
own_pids+=("$driver")
order_env "$coord" "$locks" bash "$CHECK" --label 'DOR-40 running second' --hold "$driver" >/dev/null 2>&1
rk "$coord" "$locks" --insert 'misc first' --top >/dev/null
rk "$coord" "$locks" --insert 'DOR-1 best' >/dev/null
check_eq 'a ranked label never goes above a running line, even second in line' \
  'misc first|DOR-40 running second|DOR-1 best|' "$(line_of "$coord")"
kill -KILL "$driver" 2>/dev/null
wait "$driver" 2>/dev/null
coord=$(new_coord)
rk "$coord" "$locks" --insert 'misc a' >/dev/null
rk "$coord" "$locks" --insert 'rel-1' --at 2 >/dev/null
rk "$coord" "$locks" --insert 'misc b' >/dev/null
rk "$coord" "$locks" --insert 'rel-2' >/dev/null
check_eq 'a release row goes behind the last release row, wherever it is' 'misc a|rel-1|rel-2|misc b|' "$(line_of "$coord")"
rk "$coord" "$locks" --insert 'DOR-1 best' >/dev/null
check_eq 'and a ranked label never goes above it' 'misc a|rel-1|rel-2|DOR-1 best|misc b|' "$(line_of "$coord")"

# The refresh marker: a stale one is cleared, a live one is respected, and of
# two near-simultaneous starts only one asks flow.
coord=$(new_coord)
mkdir -p "$coord"
printf '%s\n' "$$" >"$coord/heavy-order.ranks.run"
perl -e 'utime time - 100, time - 100, $ARGV[0]' "$coord/heavy-order.ranks.run"
: >"$calls"
r=$(FLOW_REFRESH=10 rk "$coord" "$locks" --insert 'DOR-1 after stale')
check_eq 'a marker older than the cap plus 30 s is stale, and a refresh runs' 1 "$(wc -l <"$calls" | tr -d ' ')"
check_contains 'and the label is placed by rank' '(by rank: DOR-1: rank 1)' "$r"
coord=$(new_coord)
printf '%s\n' "$$" >"$coord/heavy-order.ranks.run"
: >"$calls"
r=$(FLOW_TIMEOUT=1 rk "$coord" "$locks" --insert 'DOR-1 behind live')
check_eq 'a fresh marker with a live pid starts no second refresh' 0 "$(wc -l <"$calls" | tr -d ' ')"
check_contains 'and the label waits out the cap at the end' 'flow order is still running after 1s' "$r"
coord=$(new_coord)
: >"$calls"
FLOW_MODE=slowish FLOW_TIMEOUT=6 rk "$coord" "$locks" --insert 'DOR-1 first racer' >"$work/race1" &
race1=$!
FLOW_MODE=slowish FLOW_TIMEOUT=6 rk "$coord" "$locks" --insert 'DOR-10 second racer' >"$work/race2" &
race2=$!
wait "$race1" "$race2"
check_eq 'two near-simultaneous starts ask flow once' 1 "$(wc -l <"$calls" | tr -d ' ')"
check_eq 'and both are placed by rank' 'DOR-1 first racer|DOR-10 second racer|' "$(line_of "$coord")"

# The listing after a write reads kept ranks only: no flow call, no wait.
coord=$(new_coord)
order_env "$coord" "$locks" bash "$CHECK" --insert 'DOR-1 a' >/dev/null 2>&1
order_env "$coord" "$locks" bash "$CHECK" --insert 'DOR-10 b' >/dev/null 2>&1
: >"$calls"
start=$(date +%s)
r=$(FLOW_MODE=slow FLOW_TIMEOUT=5 rk "$coord" "$locks" --move 'DOR-10 b' --top)
took=$(($(date +%s) - start))
check_eq 'a --move asks flow nothing' 0 "$(wc -l <"$calls" | tr -d ' ')"
check_le 'and does not wait for it' 2 "$took"
check_contains 'its listing says the ranks are not kept' 'no kept ranks' "$r"

# The real lookup, with the hook unset, from a checkout with no flow installed.
norepo="$work/norepo"
mkdir -p "$norepo/scripts/lib"
cp "$(dirname "$CHECK")/heavy-run-lock.sh" "$norepo/scripts/"
cp "$(dirname "$CHECK")"/lib/heavy-order*.sh "$norepo/scripts/lib/"
coord=$(new_coord)
r=$(env -u DORKOS_HEAVY_FLOW_CMD DORKOS_HEAVY_ORDER_DIR="$coord" DORKOS_HEAVY_LOCK_DIR="$locks" \
  bash "$norepo/scripts/heavy-run-lock.sh" --insert 'DOR-1 nowhere' 2>&1)
check_contains 'with no flow installed the label goes to the end, saying why' \
  "0:[heavy] order: insert 'DOR-1 nowhere' done (by rank: DOR-1: no rank (flow is not installed): at the end)" "$?:$r"

# A refresh that outlives the wait lands for the next command.
coord=$(new_coord)
order_env "$coord" "$locks" bash "$CHECK" --insert 'DOR-40 there' >/dev/null 2>&1
r=$(FLOW_MODE=slowish FLOW_TIMEOUT=1 rk "$coord" "$locks" --insert 'DOR-1 early')
check_contains 'a refresh still running leaves the label at the end' 'flow order is still running after 1s' "$r"
sleep 3
r=$(FLOW_MODE=fail rk "$coord" "$locks" --list)
check_contains 'and the next command reads the ranks it kept' 'rank 1      DOR-1 early' "$r"
check_lacks 'without asking flow again' 'no ranks' "$r"

# Old ranks: used, and said to be old, while a refresh fails or runs long;
# ranks over a day old are not used at all.
age_ranks() { perl -e 'utime time - $ARGV[0], time - $ARGV[0], $ARGV[1]' "$2" "$1/heavy-order.ranks"; }
age_ranks "$coord" 3600
r=$(FLOW_MODE=slow FLOW_TIMEOUT=1 FLOW_REFRESH=2 rk "$coord" "$locks" --insert 'DOR-10 by old ranks')
check_eq 'an hour-old rank still places a label' 'DOR-10 by old ranks|DOR-40 there|DOR-1 early|' "$(line_of "$coord")"
check_contains 'and the log says the ranks are old' 'by rank: DOR-10: rank 2 (ranks 60 min old: flow order is still running after 1s' "$(last_log "$coord")"
sleep 2
age_ranks "$coord" 90000
r=$(FLOW_MODE=fail rk "$coord" "$locks" --insert 'DOR-20 too old')
check_eq 'ranks over a day old are not used' 'DOR-10 by old ranks|DOR-40 there|DOR-1 early|DOR-20 too old|' "$(line_of "$coord")"

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
