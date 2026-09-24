#!/usr/bin/env bash
# Run a heavy local gate under a machine-wide cap on how many of them may run
# at once (DOR-2160).
#
#   bash scripts/heavy-run-lock.sh <command> [args...]
#
# It forwards the command's output and exit code unchanged, so on a quiet
# machine it is invisible: the first slot is free, the acquire costs one
# `mkdir`, and the command starts.
#
# WHY THIS EXISTS
#
# This box runs several agents and the operator's own dev server on 14 cores.
# Each agent's pre-push gate is `turbo test --affected --concurrency=1`, which
# runs one package suite at a time but lets that suite keep its own worker pool
# — about one worker per core. One of those is a full machine. Four at once is
# four machines' worth of work on one machine, and the measured result is a load
# average around 500, a kernel killing background processes for memory, and a
# push that ran for 22 minutes and died on a tree its change never touched.
#
# Nothing coordinated them, because nothing could: each gate runs in its own
# worktree, in its own shell, started by its own agent, and none of them can see
# the others. What they DO share is the clone — every worktree of it resolves
# `git rev-parse --git-common-dir` to the same directory, which is already where
# the local timings live. A lock there is visible to all of them and to nobody
# else.
#
# WHAT IT GUARANTEES, AND WHAT IT REFUSES TO
#
# It caps concurrency. It does NOT promise you a slot, and that is deliberate:
# a gate that can block forever is a gate that gets bypassed, and a bypassed
# gate protects nothing. So every path out of the acquire loop is bounded.
#
#   * A slot is free                  -> take it, run, release it on exit.
#   * Every slot is held, but one holder is DEAD (killed, crashed, SIGKILLed
#     with no chance to release) -> reclaim that slot and take it. A stale lock
#     cannot wedge the next run; the fixture suite proves it by SIGKILLing a
#     holder and running again.
#   * Every slot is held by something alive, for longer than the wait bound
#     -> RUN ANYWAY, loudly, and record it. Skipping the command would be the
#     other option and is rejected: the command this guards is a commit's lint
#     (typecheck too, until it left the hook on 2026-09-24), whose whole value
#     is the verdict, and a gate that
#     sometimes silently declines to answer is worse than one that sometimes
#     adds to the load. Nothing above this wrapper bounds the run, so "run
#     anyway" really does mean uncapped — which is why it is recorded as
#     `lock_timeout` rather than passed over in silence.
#
# There is no queue, no fairness and no ordering. Waiters poll. Under contention
# that is not the fairest design, but it is the one with no state to corrupt:
# the only durable artifact is a directory that either exists or does not.
#
# WHY `mkdir` AND NOT A LOCK FILE
#
# `mkdir` on one directory is atomic on every filesystem that matters, needs no
# `flock` (absent on macOS), no `flock(1)` (absent on macOS), and leaves nothing
# to interpret: the slot is taken exactly when the directory exists. A lock FILE
# needs a create-exclusive plus a separate write, and the window between them is
# where a killed holder leaves a lock nobody can explain.
#
# RECLAIMING A DEAD HOLDER, WITHOUT STEALING A LIVE ONE
#
# A holder writes `<slot>/owner` as `<pid> <epoch-seconds>` and removes the slot
# on the way out, including on INT, TERM and HUP. SIGKILL runs nothing, so a
# slot outlives its holder often enough to matter.
#
# A waiter treats a slot as reclaimable when its owner's pid is gone, when it
# has been held past MAX_HOLD_SECONDS, or when it has no owner file at all and
# its directory is older than OWNERLESS_GRACE_MINUTES. That last clause is not
# decoration: without it, the gap between a holder's `mkdir` and its `printf`
# reads as abandonment, and a fresh acquire gets reclaimed out from under a live
# run. `reclaimable` argues it at length, with the pid-reuse hole it does not
# close.
#
# Reclaiming is a `mv` into a name claimed with `mkdir`, followed by `rm -rf` —
# never a bare `rm -rf` on the live path. Two waiters reclaiming at once both
# `mv`, one wins, and the loser's `mv` fails because the source is gone, so
# neither deletes a directory the other is using. After the `mv` the owner
# string is re-read from the moved copy, and a change means a NEW holder took
# the slot in that window, so it goes straight back.
#
# THE CLAIMS THIS MAKES ARE NARROW ON PURPOSE. Those two steps make a reclaim
# race harmless; they do not make the design race-FREE, and an earlier draft of
# this header said they did. A reclaim that slips through leaves one extra
# concurrent run, bounded by the slot count; it cannot wedge anything, because
# taking a slot is `mkdir` and only one process can win that. The complementary
# half is in `release`, which re-reads the owner before removing anything, so a
# process whose slot was reclaimed and re-let cannot delete the new holder's.
#
# WHEN THE RELEASE TRAP ACTUALLY RUNS, stated because it is not instant.
#
# The wrapped command runs in the FOREGROUND, so this stays a transparent
# wrapper: same stdin, same terminal, same exit code. The price is the shell's
# own rule that a trap set in a script runs only once the foreground command has
# returned. A signal delivered to THIS process alone therefore releases the slot
# when the command finishes, not when the signal arrives.
#
# Every real path delivers to the child as well, so in practice the release is
# immediate: a Ctrl-C at the terminal signals the whole foreground process
# group, and the pre-push watchdog's stop walks the process tree and signals
# each pid in it. The remaining case — somebody signalling this pid by hand — is
# covered by the reclaim above rather than by the trap: the slot outlives the
# run for at most as long as the command does, and a slot whose owner is gone is
# taken by the next waiter without waiting. Moving the command to the background
# to get prompt traps would buy nothing here and would cost the wrapper its
# transparency (a background job's stdin is /dev/null in a non-interactive
# shell).
#
# HARD RULE 7. Nothing here kills anything. It reads `kill -0` to ask whether a
# pid exists, which sends no signal, and it signals no process by name, by group
# or at all. The only thing it removes is a directory it created or one whose
# owner it has established is gone.
#
# ENVIRONMENT
#   DORKOS_HEAVY_SLOTS          concurrent heavy runs allowed (ci/config.yaml
#                               local.heavy_run_slots; 3 if that cannot be read)
#   DORKOS_HEAVY_WAIT_SECONDS   how long to wait for a slot before running
#                               anyway (ci/config.yaml local.heavy_lock_wait_seconds)
#   DORKOS_HEAVY_MAX_HOLD_SECONDS  a slot held longer than this is reclaimable
#   DORKOS_HEAVY_POLL_SECONDS   how often to retry (1)
#   DORKOS_HEAVY_LOCK=0         switch the cap off entirely for one run
# The fixture suite (scripts/test-heavy-run-lock.sh) drives every path through
# them with second-scale values.
#
# WHAT IT RECORDS
#
# Waiting and giving up are both facts about this machine that no exit status
# carries, so both are written to the local timings as `O` note lines against
# the running hook command (`ci_steward_note`, packages/ci-steward/bin/time-wrap.sh):
# `lock_wait <seconds>` when a slot cost a measurable wait, and `lock_timeout
# <seconds>` when the wait bound ran out and the command ran uncapped. Outside a
# hook the note function is a no-op, so this script stays usable by hand.

set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "heavy-run-lock.sh: no command given" >&2
  exit 2
fi

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$here/.." && pwd)

# Notes are best-effort and must never fail a gate, exactly as the time-wrap's
# own writes are. Sourcing is guarded so a checkout without the file still runs.
# shellcheck source=../packages/ci-steward/bin/time-wrap.sh
if [ -r "$repo_root/packages/ci-steward/bin/time-wrap.sh" ]; then
  . "$repo_root/packages/ci-steward/bin/time-wrap.sh"
fi
if ! command -v ci_steward_note >/dev/null 2>&1; then
  ci_steward_note() { :; }
fi

# The default slot count lives in ci/config.yaml so the number is in the fenced
# file the steward reads, not only in a script. Read with sed rather than a YAML
# parser because this runs before (and without) any node_modules;
# packages/ci-steward/src/__tests__/local.test.ts pins the two together so the
# fallback below can never quietly become the real value.
config_number() {
  sed -n "s/^  $1: *\([0-9][0-9]*\).*/\1/p" "$repo_root/ci/config.yaml" 2>/dev/null | head -n 1
}

SLOTS="${DORKOS_HEAVY_SLOTS:-$(config_number heavy_run_slots)}"
SLOTS="${SLOTS:-3}"
WAIT_SECONDS="${DORKOS_HEAVY_WAIT_SECONDS:-$(config_number heavy_lock_wait_seconds)}"
WAIT_SECONDS="${WAIT_SECONDS:-45}"
MAX_HOLD_SECONDS="${DORKOS_HEAVY_MAX_HOLD_SECONDS:-$(config_number heavy_lock_max_hold_seconds)}"
MAX_HOLD_SECONDS="${MAX_HOLD_SECONDS:-900}"
POLL_SECONDS="${DORKOS_HEAVY_POLL_SECONDS:-1}"

run_uncapped() {
  "$@"
  exit $?
}

[ "${DORKOS_HEAVY_LOCK:-1}" = 0 ] && run_uncapped "$@"
case $SLOTS in '' | *[!0-9]* | 0) run_uncapped "$@" ;; esac

common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
  common=$(git rev-parse --git-common-dir 2>/dev/null) || common=''
# Outside a git checkout there is nothing every worktree shares, so there is no
# machine-wide cap to enforce. Run rather than refuse: this wraps a gate.
[ -n "$common" ] || run_uncapped "$@"
case $common in /* | [A-Za-z]:/*) ;; *) common="$PWD/$common" ;; esac

lock_root="$common/ci-steward/heavy-locks"
mkdir -p "$lock_root" 2>/dev/null || run_uncapped "$@"

# WRITABILITY IS A SEPARATE QUESTION FROM EXISTENCE, and getting them confused
# is a failure that looks exactly like success. `mkdir -p` returns 0 for a
# directory that is already there, including one this user cannot write. Every
# `mkdir` of a slot then fails, no slot can ever be taken, and the loop below
# waits out the whole bound and reports that all slots are busy when not one of
# them is — so every gate on the machine pays the full wait and then runs
# anyway, forever, with a message that names the wrong problem. One probe
# answers it: take a slot-shaped directory and give it straight back.
probe="$lock_root/.probe-$$"
if ! mkdir -- "$probe" 2>/dev/null; then
  echo "[heavy-run-lock] cannot write ${lock_root} — running without the machine-wide cap." >&2
  run_uncapped "$@"
fi
rmdir -- "$probe" 2>/dev/null

now() { date +%s; }

owner_of() { cat -- "$1/owner" 2>/dev/null; }

held=''
release() {
  # ONLY IF IT IS STILL OURS. `held` is set once, by the mkdir that created the
  # slot — but a slot can change hands underneath us: another waiter that judged
  # this process dead may already have reclaimed it and handed it to a live
  # holder. Releasing on the strength of `held` alone would then delete a
  # stranger's live slot, and because that stranger goes on running with no lock,
  # the cap degrades a little further with every occurrence and never recovers.
  # Re-reading the owner is one `cat` on a path we are about to remove anyway.
  [ -n "$held" ] || return 0
  case "$(owner_of "$held")" in
    "$$ "*) rm -rf -- "$held" 2>/dev/null ;;
  esac
  held=''
}
trap 'release' EXIT
# Without these, an interrupted gate leaves its slot behind for MAX_HOLD_SECONDS
# and every other agent pays for it. Each keeps its conventional status.
trap 'release; exit 130' INT
trap 'release; exit 143' TERM
trap 'release; exit 129' HUP

# Minutes an owner-less slot must have existed before it counts as abandoned.
# Whole minutes because that is the smallest unit `find -mmin` takes on both BSD
# and GNU, and `find` is the only portable way to ask a directory's age without
# `stat`, whose flags differ between them.
OWNERLESS_GRACE_MINUTES=1

# True when the slot at $1 is held by a process that is gone, or held past the
# ceiling.
#
# THE OWNER-LESS WINDOW, which an earlier version got wrong and for which
# deleting a live slot was the punishment. Taking a slot is two steps: `mkdir`
# publishes it, and the `printf` that writes `owner` lands a moment later (it
# forks `date` first). Between them the slot exists with no owner file. Reading
# "no owner" as "abandoned" made every fresh acquire reclaimable by whoever
# polled inside that window, and the reclaim then deleted a slot whose holder
# was seconds into a real run.
#
# So an owner-less slot is judged by the only other thing that can date it: the
# directory's own mtime, which `mkdir` sets. Younger than the grace, it is an
# acquire in progress and is left alone; older, nobody ever wrote an owner and
# it is genuinely abandoned. A minute is enormous against a window measured in
# milliseconds, and the price of being generous is that one truly abandoned
# owner-less slot -- a holder SIGKILLed between its `mkdir` and its `printf` --
# waits a minute instead of no time at all.
#
# PID REUSE is the residual hole, named here rather than solved. Asking the
# kernel whether a pid exists answers "some process holds it", not "the process
# that wrote this owner file holds it". After a wrap-around a dead holder's pid
# can be live again, and this will call its slot held until MAX_HOLD_SECONDS
# retires it. That fails in the safe direction -- a slot stays held too long, so
# the cap is briefly tighter than configured and a waiter gives up and runs
# uncapped -- and the ceiling bounds how long it lasts. Closing it properly
# means comparing process start times, which has no portable spelling across
# macOS, Linux and Windows Git Bash.
reclaimable() {
  local slot=$1 line pid started
  line=$(owner_of "$slot")
  if [ -z "$line" ]; then
    # No owner: abandoned only if the directory itself is older than the grace.
    [ -n "$(find "$lock_root" -maxdepth 1 -name "${slot##*/}" -mmin "+$OWNERLESS_GRACE_MINUTES" 2>/dev/null)" ]
    return $?
  fi
  pid=${line%% *}
  started=${line##* }
  case $pid in '' | *[!0-9]*) return 0 ;; esac
  case $started in '' | *[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || return 0
  [ "$(($(now) - started))" -ge "$MAX_HOLD_SECONDS" ]
}

# Move a stale slot out of the way and delete it. Puts it back when the owner
# changed under us, which means a live holder took it after we sampled it.
reclaim() {
  local slot=$1 before dead
  before=$(owner_of "$slot")
  # The graveyard name is CLAIMED with mkdir, not merely composed. Two reclaims
  # by the same pid in the same second would otherwise pick the same name, and
  # `mv dir existing-dir` moves the source INSIDE the target rather than
  # failing -- which buries a slot one level down where nothing looks for it and
  # leaks the directory forever. mkdir refuses a name that exists, so the loser
  # gives up and re-polls instead.
  dead="$lock_root/.dead-$$-$(now)-${slot##*/}"
  mkdir -- "$dead" 2>/dev/null || return 1
  rmdir -- "$dead" 2>/dev/null || return 1
  mv -- "$slot" "$dead" 2>/dev/null || return 1
  if [ "$(owner_of "$dead")" != "$before" ]; then
    mv -- "$dead" "$slot" 2>/dev/null
    return 1
  fi
  rm -rf -- "$dead" 2>/dev/null
  return 0
}

# How many slots are occupied right now, for the record rather than for any
# decision: the decision is the mkdir.
occupied() {
  local n=0 k
  for ((k = 1; k <= SLOTS; k++)); do
    [ -d "$lock_root/slot-$k" ] && n=$((n + 1))
  done
  printf '%s' "$n"
}

started=$(now)
notified=0
while :; do
  for ((k = 1; k <= SLOTS; k++)); do
    slot="$lock_root/slot-$k"
    # Taken, but by a holder that is gone: clear it and try the same slot again
    # in the same pass, so a stale lock costs no poll interval at all.
    if ! mkdir -- "$slot" 2>/dev/null; then
      reclaimable "$slot" && reclaim "$slot" && mkdir -- "$slot" 2>/dev/null || continue
    fi
    printf '%s %s\n' "$$" "$(now)" >"$slot/owner" 2>/dev/null
    held=$slot
    break
  done
  [ -n "$held" ] && break

  waited=$(($(now) - started))
  if [ "$waited" -ge "$WAIT_SECONDS" ]; then
    ci_steward_note lock_timeout "$waited"
    {
      echo "[heavy-run-lock] all ${SLOTS} heavy-run slots busy after ${waited}s — running anyway,"
      echo "                 uncapped. The machine is already saturated and this run adds to it;"
      echo "                 nothing above this wrapper bounds how long it takes. Recorded as"
      echo "                 lock_timeout in the local timings."
    } >&2
    break
  fi
  if [ "$notified" = 0 ]; then
    notified=1
    echo "[heavy-run-lock] $(occupied)/${SLOTS} heavy runs already going on this machine — waiting up to ${WAIT_SECONDS}s for a slot." >&2
  fi
  sleep "$POLL_SECONDS"
done

waited=$(($(now) - started))
[ "$waited" -gt 0 ] && [ -n "$held" ] && ci_steward_note lock_wait "$waited"

"$@"
status=$?
release
exit "$status"
