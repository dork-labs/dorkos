#!/usr/bin/env bash
# Fixture suite for scripts/heavy-run-lock.sh, the machine-wide cap on
# concurrent heavy local gates (DOR-2160).
#
#   bash scripts/test-heavy-run-lock.sh
#   CHECK=/path/to/other.sh bash scripts/test-heavy-run-lock.sh
#
# CHECK exists so a candidate rewrite can be run against the same fixtures, and
# so the pre-change behaviour can be too. The behaviour this replaced is one
# line — `exec "$@"`, no cap at all — and the concurrency cases below fail
# against exactly that stand-in:
#
#   printf '#!/usr/bin/env bash\nexec "$@"\n' > /tmp/old.sh
#   CHECK=/tmp/old.sh bash scripts/test-heavy-run-lock.sh
#
# WHY THIS SUITE IS WORTH ITS LINES
#
# A lock in a push hook has one failure mode that matters more than all the
# others: it wedges the push. Not slowly — forever, on a machine where the
# holder was SIGKILLed by a kernel reclaiming memory and will never come back to
# release anything. That is not a hypothetical here; it is the same machine, on
# the same day, that killed three background processes for memory while a
# 22-minute pre-push died on a tree it never touched.
#
# So the cases split into two groups and the second is the important one:
#
#   * IT CAPS — two runs at once with one slot really do serialise. Without
#     this the whole change is decoration.
#
#   * IT NEVER WEDGES — a dead holder's slot is reclaimed, a live holder's
#     slot is waited for and then given up on, and neither path ever blocks
#     past its bound. `a SIGKILLed holder does not wedge the next run` is the
#     case the whole design is for.
#
# Hermetic: throwaway git repos and `sleep`, never turbo or this repo's suites,
# so it needs no `pnpm install`. Bounds are driven to the smallest values that
# still prove what each case claims, because the thing under test is partly a
# clock and a clock cannot be shown to fire without letting time pass.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/heavy-run-lock.sh}"

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

check_contains() {
  local name="$1" needle="$2" hay="$3"
  if printf '%s' "$hay" | grep -qF -- "$needle"; then
    pass=$((pass + 1))
    printf 'ok   %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL %s — %q not found in:\n%s\n' "$name" "$needle" "$hay"
  fi
}

# A throwaway clone. The lock lives under the clone's git common dir, so each
# case gets its own and cases cannot see each other's slots.
new_repo() {
  local d
  d=$(mktemp -d "$work/repo.XXXXXX")
  git init -q "$d"
  printf '%s' "$d"
}

lock_dir() { printf '%s' "$1/.git/ci-steward/heavy-locks"; }

# Every descendant of $1, plus $1, deepest first. Recursive because the tree
# here is three deep — the suite's subshell, the wrapper, and the command it is
# running — and a signal that stops at the wrapper does not reach the thing the
# wrapper is waiting on. `pgrep -P` matches on parentage, never on a name
# (Hard Rule 7).
tree_pids() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do tree_pids "$child"; done
  printf '%s\n' "$pid"
}

# Signal a tree this suite forked, by pid.
signal_tree() {
  local sig=$1 root=$2 p
  for p in $(tree_pids "$root"); do kill "-$sig" "$p" 2>/dev/null; done
}

echo "== the happy path must be invisible =="

# If the wrapper is not transparent when a slot is free it is not deployable,
# whatever else it gets right: every gate on a quiet machine goes through here.
repo=$(new_repo)
out=$(cd "$repo" && bash "$CHECK" bash -c 'echo hello-from-the-gate; exit 0' 2>&1)
status=$?
check_eq 'a passing command exits 0' 0 "$status"
check_contains 'its output is forwarded' 'hello-from-the-gate' "$out"

out=$(cd "$repo" && bash "$CHECK" bash -c 'exit 7' 2>&1)
check_eq 'a failing command keeps its exit code' 7 "$?"

# The slot must be gone afterwards, or the second push on this machine pays for
# the first one having finished.
if [ -d "$(lock_dir "$repo")/slot-1" ]; then
  fail=$((fail + 1))
  printf 'FAIL the slot was not released after the command finished\n'
else
  pass=$((pass + 1))
  printf 'ok   the slot is released when the command finishes\n'
fi

echo ""
echo "== it must actually cap concurrency =="

# One slot, two runs: the second cannot start until the first is done, so the
# two cannot overlap. Measured by total wall time rather than by peeking at the
# lock, because overlapping is the thing being prevented, not the mechanism.
repo=$(new_repo)
started=$(date +%s)
(cd "$repo" && DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=30 bash "$CHECK" sleep 2) &
one=$!
own_pids+=("$one")
sleep 0.3
(cd "$repo" && DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=30 bash "$CHECK" sleep 2) &
two=$!
own_pids+=("$two")
wait "$one" "$two" 2>/dev/null
elapsed=$(($(date +%s) - started))
if [ "$elapsed" -ge 4 ]; then
  pass=$((pass + 1))
  printf 'ok   two runs with one slot serialised (%ss for two 2s runs)\n' "$elapsed"
else
  fail=$((fail + 1))
  printf 'FAIL two runs with one slot overlapped (%ss for two 2s runs)\n' "$elapsed"
fi

echo ""
echo "== a dead holder must never wedge the next run =="

# THE CASE THE DESIGN EXISTS FOR. A holder SIGKILLed by the kernel runs no trap
# and releases nothing, so its slot outlives it. Every slot is taken and the
# owner is gone: the next run must reclaim it and go, promptly, and not sit out
# even the wait bound — so the bound here is 30s and the assertion is that it
# finished in a small fraction of that.
repo=$(new_repo)
(cd "$repo" && DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=30 bash "$CHECK" sleep 60) &
holder=$!
own_pids+=("$holder")
# Wait for the slot to exist rather than sleeping a guessed amount.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -d "$(lock_dir "$repo")/slot-1" ] && break
  sleep 0.3
done
if [ ! -d "$(lock_dir "$repo")/slot-1" ]; then
  fail=$((fail + 1))
  printf 'FAIL the holder never took a slot, so the reclaim case proves nothing\n'
fi
# SIGKILL the tree this suite started, by pid. `sleep` is a child of the
# wrapper, and killing only the wrapper would leave a live `sleep` that the
# reclaim could legitimately wait for.
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null
if [ ! -d "$(lock_dir "$repo")/slot-1" ]; then
  fail=$((fail + 1))
  printf 'FAIL the killed holder released its slot, so this is not the stale-lock case\n'
else
  pass=$((pass + 1))
  printf 'ok   a SIGKILLed holder really does leave its slot behind\n'
fi

started=$(date +%s)
out=$(cd "$repo" && DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=30 bash "$CHECK" bash -c 'echo got-through' 2>&1)
status=$?
elapsed=$(($(date +%s) - started))
check_eq 'the next run after a killed holder exits 0' 0 "$status"
check_contains 'the next run after a killed holder really ran' 'got-through' "$out"
if [ "$elapsed" -le 5 ]; then
  pass=$((pass + 1))
  printf 'ok   a SIGKILLed holder does not wedge the next run (%ss, bound was 30s)\n' "$elapsed"
else
  fail=$((fail + 1))
  printf 'FAIL the next run waited %ss behind a dead holder\n' "$elapsed"
fi

echo ""
echo "== waiting must be bounded, and giving up must run rather than hang =="

# Every slot held by something ALIVE, which is the case a reclaim must not
# touch. Waiting is right, waiting forever is not: the bound expires and the
# command runs uncapped, loudly. Skipping would be the other defensible choice
# and is rejected in the script's header — a silently skipped test gate is a
# failure this repo has already had.
repo=$(new_repo)
(cd "$repo" && DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=30 bash "$CHECK" sleep 30) &
holder=$!
own_pids+=("$holder")
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -d "$(lock_dir "$repo")/slot-1" ] && break
  sleep 0.3
done
started=$(date +%s)
out=$(cd "$repo" && DORKOS_HEAVY_SLOTS=1 DORKOS_HEAVY_WAIT_SECONDS=2 DORKOS_HEAVY_POLL_SECONDS=0.3 \
  bash "$CHECK" bash -c 'echo ran-anyway' 2>&1)
status=$?
elapsed=$(($(date +%s) - started))
check_eq 'giving up on the wait still exits 0' 0 "$status"
check_contains 'giving up runs the command rather than skipping it' 'ran-anyway' "$out"
check_contains 'giving up says so' 'running anyway' "$out"
if [ "$elapsed" -le 6 ]; then
  pass=$((pass + 1))
  printf 'ok   the wait is bounded (%ss against a 2s bound)\n' "$elapsed"
else
  fail=$((fail + 1))
  printf 'FAIL the wait ran to %ss against a 2s bound\n' "$elapsed"
fi
# The live holder must still have its slot: a reclaim here would be the bug.
if [ -d "$(lock_dir "$repo")/slot-1" ]; then
  pass=$((pass + 1))
  printf 'ok   a live holder keeps its slot while a waiter gives up\n'
else
  fail=$((fail + 1))
  printf 'FAIL a waiter reclaimed a slot whose holder was still alive\n'
fi
signal_tree KILL "$holder"
wait "$holder" 2>/dev/null

echo ""
echo "== an interrupted run must release its slot =="

# Ctrl-C is an everyday way a gate ends, and the pre-push watchdog stopping a
# run over budget is the other. Without the traps the slot survives until
# MAX_HOLD_SECONDS and every other agent on the machine pays for it.
#
# The signal goes to the TREE, which is what both of those really do — a Ctrl-C
# reaches the whole foreground process group and the watchdog walks the process
# tree — and it is what the trap needs, because a trap set in a script runs only
# once its foreground command has returned. Signalling this pid alone would
# release the slot when `sleep 30` finished, 30 seconds later; that case is
# covered by the reclaim above rather than by the trap, and the script's header
# says so.
repo=$(new_repo)
(cd "$repo" && bash "$CHECK" sleep 30) &
holder=$!
own_pids+=("$holder")
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -d "$(lock_dir "$repo")/slot-1" ] && break
  sleep 0.3
done
signal_tree TERM "$holder"
wait "$holder" 2>/dev/null
sleep 0.5
if [ -d "$(lock_dir "$repo")/slot-1" ]; then
  fail=$((fail + 1))
  printf 'FAIL a TERMed run left its slot behind\n'
else
  pass=$((pass + 1))
  printf 'ok   a TERMed run releases its slot\n'
fi

echo ""
echo "== it must degrade rather than refuse =="

# Outside a git checkout there is nothing every worktree shares, so there is no
# machine-wide cap to enforce. This wraps a GATE: refusing would turn a missing
# lock directory into a failed push.
out=$(cd "$work" && bash "$CHECK" bash -c 'echo no-repo-still-runs' 2>&1)
check_eq 'outside a checkout the command still runs' 0 "$?"
check_contains 'outside a checkout the output is still forwarded' 'no-repo-still-runs' "$out"

repo=$(new_repo)
out=$(cd "$repo" && DORKOS_HEAVY_LOCK=0 bash "$CHECK" bash -c 'echo cap-switched-off' 2>&1)
check_eq 'the cap can be switched off for one run' 0 "$?"
check_contains 'switched off, the command still runs' 'cap-switched-off' "$out"

out=$(cd "$repo" && bash "$CHECK" 2>&1)
check_eq 'no command at all is a usage error, not a pass' 2 "$?"

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
