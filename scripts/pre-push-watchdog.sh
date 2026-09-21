#!/usr/bin/env bash
# Run the pre-push test gate under a watchdog that makes a stall visible and
# bounded instead of silent and endless (DOR-473).
#
#   bash scripts/pre-push-watchdog.sh <command> [args...]
#
# It forwards the command's output and exit code unchanged, so on every push
# that behaves it is invisible. The three things it adds only ever matter when
# something goes wrong.
#
# WHY THIS EXISTS
#
# `git push` from a worktree ran the gate and, under the multi-agent load that
# is this machine's normal condition, sat there. Not failing — hanging, with an
# empty terminal, for minutes, until it was killed by hand. `--no-verify`
# returned in seconds, so `--no-verify` became the habit, and a gate that is
# always skipped protects nothing while still costing everyone the minutes they
# waited before skipping it.
#
# Two separate mechanisms produced that experience, and this script answers
# both:
#
#   1. NOTHING BOUNDED THE RUN. `turbo test --concurrency=1` runs suites one at
#      a time, so one vitest process that never exits — an unclosed handle, a
#      watcher that never fires, a worker starved on a box already running
#      several agents — stops the whole gate forever. git waits on the hook, the
#      hook waits on turbo, turbo waits on vitest, and vitest is waiting on
#      nothing that will ever happen. There is no timeout anywhere in that
#      chain.
#
#   2. NOTHING SHOWED THE RUN. lefthook buffers a command's output and prints it
#      only once the command finishes. Measured against lefthook 2.1.12: a
#      command that echoes at t+0 and exits at t+8 has its echo appear at t+8.
#      So for the whole of a healthy run — ten minutes and counting, in the
#      measurement below — the terminal shows the lefthook banner and nothing
#      else, and a hung run looks exactly the same, forever. There is no way to
#      tell "compiling" from "wedged" by looking.
#
# WHAT IT DOES
#
#   * Streams the command's output as it arrives, so a run in progress looks
#     like a run in progress. `follow: true` on the hook is what lets that
#     reach the terminal; this script is what produces it incrementally.
#   * Prints a heartbeat naming the command and the last thing it said whenever
#     it has been quiet for a while, so a stall announces itself long before any
#     bound fires.
#   * Kills the run and explains it if the command goes quiet for
#     DORKOS_PREPUSH_STALL_SECONDS, or runs longer than
#     DORKOS_PREPUSH_MAX_SECONDS whatever it is printing.
#
# WHY A SILENCE BOUND AND NOT JUST A DURATION ONE
#
# A duration bound has to be set above the slowest legitimate push, and the
# slowest legitimate push here is a change to `packages/shared` on a loaded box:
# ~20 suites, serially, plus their `^build` dependencies. Any number that never
# kills that run is far too large to catch a hang promptly, so a duration-only
# bound is either a false failure or useless — pick one.
#
# Silence separates the two cases cleanly, because the failure mode is not
# "slow", it is "stopped". A healthy run talks constantly: vitest prints a line
# per test file and turbo prints a line per task boundary. A wedged one prints
# nothing at all, which is exactly the empty terminal the ticket described.
#
# THE DEFAULTS ARE MEASURED, not guessed. A real affected run on this machine
# under its normal multi-agent load — one file added to packages/icons, which
# resolves to 7 packages / 40 tasks / 6 suites including client and site — was
# timestamped line by line:
#
#   6638 lines over 599 seconds, and the LONGEST SILENCE IN IT WAS 16 SECONDS.
#   The whole distribution of gaps over 2s: 3s x3, 4s x9, 6s, 8s, 16s.
#
# So a 300s stall bound sits about nineteen times above the worst gap a healthy
# run produced, which is the margin that lets it be trusted, and a 60s heartbeat
# never fires on a working run (confirmed: it did not fire once in those 599s).
#
# That same measurement is why the ceiling is 7200s and not something tidier.
# The run above was STILL GOING at 599 seconds and still healthy; a
# `packages/shared` change is roughly three times its suite count. A ceiling
# anywhere near the length of an honest push would make this script the thing
# that breaks pushes, which is worse than the bug. It is a guarantee of
# termination, not a promptness bound — silence is what catches a hang quickly —
# so it belongs far above any plausible real run, covering only the one shape
# silence cannot see: something stuck in a loop that keeps talking.
#
# WHAT A TIMEOUT DOES, AND WHO DECIDES
#
# The default is fail-closed, exit 124 — the convention GNU `timeout` uses — so
# "the tests failed" and "the tests never finished" are distinguishable by a
# caller that cares, and are never confused for each other in a log. That is the
# right default for a script that knows nothing about its caller: "the gate did
# not answer" is not "the gate said yes", and a silent 0 would be a strictly
# worse version of the `--no-verify` habit, since at least `--no-verify` is
# typed on purpose.
#
# DORKOS_PREPUSH_ON_TIMEOUT=pass inverts it: the run is still stopped, still
# diagnosed at the same length, and still recorded — but the caller gets 0. That
# is not a softening of the argument above; it is the argument applied to a
# different caller. The pre-push gate now runs on a ~2-minute budget against a
# merge queue that runs the SAME suites, in full, on the real merged tree. On a
# machine at load ~500 the budget is reached by honest runs, so failing there
# would red a green tree several times a day and teach every agent to type
# `--no-verify` permanently — losing the formatting check and everything else
# with it. What makes `pass` honest rather than a lie is that it is never
# silent: the block below says the gate did not finish, and `ci_steward_note
# budget_exceeded` puts it in the local timings, so "how often does the local
# gate stop checking?" is a number in the daily report rather than a feeling.
# lefthook.yml is where that choice is made and argued; this script only obeys.
#
# ENVIRONMENT
#   DORKOS_PREPUSH_STALL_SECONDS      quiet time that counts as a stall (300)
#   DORKOS_PREPUSH_MAX_SECONDS        absolute ceiling on the whole run (7200)
#   DORKOS_PREPUSH_HEARTBEAT_SECONDS  how often to report a quiet run (60)
#   DORKOS_PREPUSH_POLL_SECONDS       how often to check on it (2)
#   DORKOS_PREPUSH_ON_TIMEOUT         fail (default, exit 124) or pass (exit 0)
# All four are read here and nowhere else; the fixture suite
# (scripts/test-pre-push-watchdog.sh) drives every path through them with
# second-scale values.
#
# WHAT THE WRAPPED COMMAND GETS, which is not quite what it would get unwrapped
#
#   * stdin is /dev/null. The command runs as a background job (`&`) with job
#     control off, which is how bash detaches it from the terminal. Nothing in
#     the gate reads stdin today — the hook's `run:` block drains git's ref list
#     in its own `while read` loop BEFORE reaching this script, so by then there
#     is nothing left to read anyway — but anyone moving this wrapper above that
#     loop would find the loop reading EOF immediately and the delete-only
#     skip silently never triggering. Move the loop, not the wrapper.
#   * stderr is merged into stdout. Both go to one log so the forwarded stream
#     preserves the interleaving a reader expects, and turbo's output arrives in
#     the order it was written. lefthook merges the two anyway, so this changes
#     nothing about what reaches the terminal; it does mean a caller cannot
#     separate the streams by redirecting one of them.
#   * exit code and output are otherwise passed through untouched.
#
# PROCESS CLEANUP, AND HARD RULE 7
#
# It kills the process TREE it started, never a name. The pids come from walking
# `pgrep -P` down from the one child pid this script itself forked, so the set is
# by construction exactly this run's descendants — the turbo process, its vitest
# child, that vitest's workers — and cannot contain another agent's dev server
# or the operator's. It signals those pids individually rather than signalling a
# process group, so there is no negative-pid kill anywhere in this file. Leaving
# them alive was never an option: the whole failure being fixed is a wedged
# vitest, and abandoning it would leak a stuck process per push on the machine
# least able to afford one.
#
# That reaper runs on EVERY exit this script can take other than the command's
# own — both timeouts and the INT/TERM/HUP traps installed after the fork. The
# traps are not decoration: without them Ctrl-C leaked the entire run, which is
# documented where they are installed.

set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "pre-push-watchdog.sh: no command given" >&2
  exit 2
fi

STALL_SECONDS="${DORKOS_PREPUSH_STALL_SECONDS:-300}"
MAX_SECONDS="${DORKOS_PREPUSH_MAX_SECONDS:-7200}"
HEARTBEAT_SECONDS="${DORKOS_PREPUSH_HEARTBEAT_SECONDS:-60}"
POLL_SECONDS="${DORKOS_PREPUSH_POLL_SECONDS:-2}"
ON_TIMEOUT="${DORKOS_PREPUSH_ON_TIMEOUT:-fail}"
case "$ON_TIMEOUT" in
  fail | pass) ;;
  *)
    echo "pre-push-watchdog.sh: DORKOS_PREPUSH_ON_TIMEOUT must be fail or pass, got '${ON_TIMEOUT}'" >&2
    exit 2
    ;;
esac
# 124 is GNU `timeout`'s "it did not finish"; 0 is "the caller has another gate".
TIMEOUT_EXIT=124
[ "$ON_TIMEOUT" = pass ] && TIMEOUT_EXIT=0

# Recording a cut-short gate is best-effort and never fails the run. Outside a
# lefthook command `ci_steward_note` is a no-op, so this stays usable by hand.
watchdog_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=../packages/ci-steward/bin/time-wrap.sh
if [ -r "$watchdog_dir/../packages/ci-steward/bin/time-wrap.sh" ]; then
  . "$watchdog_dir/../packages/ci-steward/bin/time-wrap.sh"
fi
command -v ci_steward_note >/dev/null 2>&1 || ci_steward_note() { :; }

# How long a TERMed process tree gets to exit before the survivors are KILLed.
GRACE_SECONDS=5

# The command as a human would have to type it, used in every message so a
# reader never has to go and look up what the gate was running.
command_line="$*"

# Spelled with an explicit directory and an explicit XXXXXX rather than
# `mktemp -t <name>`: BSD mktemp accepts a bare prefix there, GNU coreutils
# requires the template to carry at least three X's and errors out without them.
# The gate runs on macOS and its fixture suite runs on ubuntu, so only the
# portable spelling works in both places.
log=$(mktemp "${TMPDIR:-/tmp}/dorkos-prepush-watchdog.XXXXXX")
cleanup_log() { rm -f "$log"; }
trap cleanup_log EXIT

# Bytes of the log already forwarded to our stdout.
forwarded=0

# Print whatever the command has written since the last call, and report
# whether there was anything. Callers use the answer to decide whether the run
# is making progress; nothing else in this script looks at the log's size.
#
# THE `head -c` IS LOAD-BEARING, and its absence is a bug that hides for a long
# time. The log is being appended to by a live process while this reads it, so
# the size sampled on the line above is already stale: `tail -c "+N"` reads to
# the CURRENT end of file, which may be past `size` by whatever the command
# wrote in between. Those extra bytes get printed AND left uncounted, because
# `forwarded` is then set to the stale `size` — so the next call re-prints them.
# Measured on a command emitting 10000 lines under a 0.05s poll: one run in
# three came out at 10728 lines, a 7.3% duplication, and the other two were
# exact. That intermittency is the whole problem — it looks fine most of the
# time, and when it does not, a developer reading a doubled test failure has no
# reason to suspect the hook rather than their own code.
#
# Bounding the read to exactly the bytes that were counted makes the forwarded
# stream byte-exact regardless of what arrives mid-read; the remainder is simply
# picked up by the next poll, which is what `forwarded` is for.
flush_output() {
  local size
  size=$(wc -c <"$log")
  size=$((size))
  if [ "$size" -gt "$forwarded" ]; then
    tail -c "+$((forwarded + 1))" "$log" | head -c "$((size - forwarded))"
    forwarded=$size
    return 0
  fi
  return 1
}

# Every descendant of $1, plus $1 itself, deepest first — the order they have to
# be signalled in so a parent cannot respawn or orphan a child while the sweep
# is still running. `pgrep -P` is read-only and matches on parentage, never on a
# process name.
process_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    process_tree "$child"
  done
  printf '%s\n' "$pid"
}

# What the run was actually doing, as `ps` sees it right now. This is the half
# of the diagnostic that names the wedged process itself rather than the last
# thing it managed to say.
describe_tree() {
  local pid=$1 one pids=''
  # The comma list is built here rather than with `paste -sd,` so the script
  # depends on nothing but bash, ps and pgrep — the three things that are
  # certain to exist wherever a push happens.
  while IFS= read -r one; do
    pids="${pids:+$pids,}$one"
  done < <(process_tree "$pid")
  [ -n "$pids" ] || return 0
  ps -o pid=,etime=,command= -p "$pids" 2>/dev/null | head -n 20
}

# The last thing the command said, which for this gate is the most direct
# possible answer to "what was it running": turbo prefixes every line with the
# package and task it came from, so the tail names the suite.
last_output() {
  local tail_lines
  tail_lines=$(grep -v '^[[:space:]]*$' "$log" 2>/dev/null | tail -n 15)
  if [ -n "$tail_lines" ]; then
    printf '%s\n' "$tail_lines"
  else
    printf '  (the command produced no output at all)\n'
  fi
}

# Signal the run's own process tree, then report what it was. Split into TERM,
# a grace period, and KILL for the survivors, so a vitest that can still flush
# its reporter gets the chance and one that cannot still goes away.
stop_tree() {
  local root=$1 pid
  local -a pids=()
  while IFS= read -r pid; do pids+=("$pid"); done < <(process_tree "$root")
  [ "${#pids[@]}" -gt 0 ] || return 0

  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null; done
  local waited=0
  while [ "$waited" -lt "$GRACE_SECONDS" ]; do
    kill -0 "$root" 2>/dev/null || break
    sleep 1
    waited=$((waited + 1))
  done
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null; done
}

# Stop the run and swallow bash's own commentary on having done so.
#
# A shell that reaps a job killed by a signal announces it unprompted:
#   pre-push-watchdog.sh: line NN: 12345 Terminated: 15  "$@" > "$log" 2>&1
# printed to this script's stderr, immediately above the diagnostic. Neither
# redirecting `wait` nor `disown` suppresses it — the shell emits it when it
# notices the status change, which happens inside stop_tree's grace loop, before
# either of those runs. Measured: both were tried and the line survived both.
#
# So the notice is silenced by window instead: stderr is parked for exactly the
# span in which the reap can happen, and restored before anything is reported.
# It is worth the four lines because that stray line is the FIRST thing a reader
# sees after a stall, it names a line number in this file, and it reads as this
# script having crashed — the worst possible framing for the one message in the
# change that has to land at a glance.
#
# The window is deliberately narrow and always closed by the `restore` below, so
# a genuine error from anything else keeps its stderr.
stop_run_quietly() {
  exec 3>&2 2>/dev/null
  stop_tree "$child"
  disown "$child" 2>/dev/null || true
  # Let a reap that has not landed yet arrive while stderr is still parked.
  sleep 0.2
  exec 2>&3 3>&-
}

# The whole point of the exercise: say what was running, why it was stopped, and
# what to do about it, in a form that does not require the reader to already
# know this script exists.
report_timeout() {
  local reason=$1 elapsed=$2 tree=$3
  {
    echo ""
    echo "──────────────────────────────────────────────────────────────"
    echo "pre-push gate stopped after ${elapsed}s — ${reason}"
    echo ""
    echo "  command: ${command_line}"
    echo ""
    echo "  last output before it was stopped:"
    last_output | sed 's/^/    /'
    echo ""
    if [ -n "$tree" ]; then
      echo "  still running when it was stopped:"
      printf '%s\n' "$tree" | sed 's/^/    /'
      echo ""
    fi
    echo "  This is a stall, not a test failure — nothing said your code is"
    echo "  broken, and nothing said it is fine either."
    echo ""
    if [ "$ON_TIMEOUT" = pass ]; then
      echo "  THE PUSH IS GOING AHEAD. This gate is a smell test on a budget,"
      echo "  not the guarantee; the merge queue runs these suites in full on"
      echo "  the merged tree and is what decides whether your change lands."
      echo "  It is recorded as budget_exceeded in the local timings."
      echo ""
      echo "  Worth doing anyway:"
      echo "    * Run the suite named above on its own: pnpm vitest run <path>"
      echo "    * Watch the PR's checks rather than assuming this one covered you."
      echo "    * Give it longer for one run:"
      echo "        DORKOS_PREPUSH_MAX_SECONDS=900 git push"
    else
      echo "  The gate never finished, so the push is refused rather than"
      echo "  waved through."
      echo ""
      echo "  What to do:"
      echo "    * Push again — a stall under load often does not repeat."
      echo "    * Run the suite named above on its own: pnpm vitest run <path>"
      echo "    * Give it longer for one run:"
      echo "        DORKOS_PREPUSH_STALL_SECONDS=900 git push"
      echo "    * Bypass deliberately, having checked the packages you touched:"
      echo "        git push --no-verify"
    fi
    echo "──────────────────────────────────────────────────────────────"
  } >&2
}

"$@" >"$log" 2>&1 &
child=$!

# STOP THE RUN WHEN THIS SCRIPT IS INTERRUPTED, not just when it times out.
#
# Ctrl-C at the terminal is the single most likely way this gate ends, because
# it is what everyone did for the whole life of the bug. Without these traps it
# is also the one exit that leaks: bash sets SIGINT and SIGQUIT to SIG_IGN in a
# command started with `&` when job control is off, so a Ctrl-C that kills this
# script does NOT reach the gate it forked — turbo and every vitest under it are
# reparented to init and keep running, invisibly, on the machine least able to
# afford it. Measured on the version before these lines: signal the watchdog,
# and the child shell and its grandchildren are all still alive three seconds
# later. That is precisely the leak the PROCESS CLEANUP note above calls "never
# an option", and it was true of the timeout path only.
#
# Installed here rather than beside the EXIT trap because `stop_run_quietly`
# reads `$child`, and under `set -u` a signal arriving before the fork would
# abort in the handler. Nothing before this point has started anything to clean
# up, so the EXIT trap alone covers that window.
#
# Each signal keeps its own conventional status (128 + signal number) rather
# than collapsing to one code: a caller that distinguishes them should get the
# truth, and "interrupted" must never be mistaken for "timed out" (124) or
# "tests failed".
on_signal() {
  local name=$1 code=$2
  stop_run_quietly
  echo "[pre-push] interrupted (SIG${name}) — stopped the test run it had started." >&2
  exit "$code"
}
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

started=$(date +%s)
last_progress=$started
last_heartbeat=$started

while kill -0 "$child" 2>/dev/null; do
  now=$(date +%s)

  if flush_output; then
    last_progress=$now
    last_heartbeat=$now
  fi

  quiet=$((now - last_progress))
  elapsed=$((now - started))

  if [ "$quiet" -ge "$STALL_SECONDS" ]; then
    tree=$(describe_tree "$child")
    stop_run_quietly
    flush_output || true
    report_timeout "no output for ${quiet}s (DORKOS_PREPUSH_STALL_SECONDS=${STALL_SECONDS})" \
      "$elapsed" "$tree"
    ci_steward_note budget_exceeded "$elapsed"
    exit "$TIMEOUT_EXIT"
  fi

  if [ "$elapsed" -ge "$MAX_SECONDS" ]; then
    tree=$(describe_tree "$child")
    stop_run_quietly
    flush_output || true
    report_timeout "still running at the ceiling (DORKOS_PREPUSH_MAX_SECONDS=${MAX_SECONDS})" \
      "$elapsed" "$tree"
    ci_steward_note budget_exceeded "$elapsed"
    exit "$TIMEOUT_EXIT"
  fi

  # A run that has gone quiet says so while it is still allowed to be quiet,
  # which is what turns "the terminal is empty" into information.
  if [ "$((now - last_heartbeat))" -ge "$HEARTBEAT_SECONDS" ] && [ "$quiet" -gt 0 ]; then
    last_heartbeat=$now
    {
      echo "[pre-push] ${quiet}s with no output, ${elapsed}s in — still waiting on:"
      echo "           ${command_line}"
      echo "           giving up at ${STALL_SECONDS}s of silence."
    } >&2
  fi

  sleep "$POLL_SECONDS"
done

wait "$child"
status=$?
flush_output || true
exit "$status"
