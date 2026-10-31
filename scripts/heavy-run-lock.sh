#!/usr/bin/env bash
# Run a heavy local command under a HOST-WIDE cap on how many of them may run at
# once (DOR-2160, made host-wide in DOR-3274).
#
#   bash scripts/heavy-run-lock.sh [--job] <command> [args...]
#   pnpm heavy <command> [args...]          (the same, with --job)
#
# It forwards the command's output and exit code unchanged, so on a quiet
# machine it is invisible: the first slot is free and the command starts.
#
# WHY THIS EXISTS
#
# This box runs several agents and the operator's own dev server on 14 cores.
# One full build, typecheck or test sweep keeps about one worker per core, so
# four at once is four machines' worth of work on one. That has been measured
# twice: a load average around 500 with the kernel killing processes for memory
# (DOR-2160), and on 2026-10-24 a load of ~40 with 12 GB of disk gone that
# panicked the Mac and took the whole team down for hours (DOR-3274).
#
# The first version capped one command (the commit lint) per CLONE, in the
# clone's git common dir. The panic came from jobs it never saw: builds and
# typechecks run by hand, other clones, other repos. So the slots now live in
# one directory per user on the host, `/tmp/dorkos-heavy-locks-<uid>`, which
# every worktree, clone and agent on the machine shares, and the root `build`,
# `typecheck`, `test` and `verify` scripts take a slot too.
#
# HOW A SLOT IS HELD: BY A PROCESS, NOT BY A FILE
#
# A slot is an exclusive `flock` on `<dir>/slot-<k>`. macOS has no `flock(1)`,
# so a small perl sidecar (perl ships with macOS and every Linux CI image) takes
# the lock and holds it for as long as this wrapper is alive, then exits. The
# kernel drops a flock when the last descriptor on it closes, so:
#
#   * a holder that dies in ANY way (SIGKILL, a kernel OOM kill, a crash)
#     releases its slot at once. There is no stale lock to detect, no pid to
#     second-guess, no reclaim race and nothing to clean up. The slot files
#     stay on disk, but a file nobody has locked means "free";
#   * the sidecar watches this wrapper's pid and exits within a fifth of a
#     second of it going, so the wrapper's own death releases the slot too;
#   * the wrapped command is never handed the lock descriptor, so a daemon it
#     leaves behind (turbo's, esbuild's) cannot keep a slot forever.
#
# WHAT IT GUARANTEES, AND WHAT IT REFUSES TO
#
# It caps concurrency. It does NOT promise a slot, because a wait that can last
# forever is a wait that gets bypassed. Every path out is bounded:
#
#   * A slot is free -> take it, run, release it on exit.
#   * Every slot is held -> QUEUE. Waiters line up on `<dir>/queue` (a blocking
#     flock, so they are served roughly in arrival order) and the one at the
#     head takes the next free slot. While waiting, it prints what it waits on:
#     each holder's pid, age, command and directory.
#   * The wait bound runs out -> RUN ANYWAY, loudly, and record it as
#     `lock_timeout`. A commit's lint waits `heavy_lock_wait_seconds` (45 s);
#     a `--job` (a build, typecheck or full test run) waits
#     `heavy_job_wait_seconds` (30 min), because a job running uncapped is the
#     very thing that panicked the host.
#
# IT NEVER DEADLOCKS. A slot is released by the holder's death, a wait is
# bounded, and a nested call (`pnpm verify` running lint, a build inside a test
# script) sees DORKOS_HEAVY_SLOT_HELD and runs straight through rather than
# waiting on the slot its own parent holds.
#
# IT NEVER BLOCKS CI. With `CI` set (GitHub Actions sets it) it runs the command
# directly: a runner is one job on its own machine, and nothing there shares it.
#
# IT DEGRADES RATHER THAN REFUSES. No perl, an unwritable lock directory or a
# sidecar that dies before answering each print one line and run the command
# uncapped: this wraps gates, and a gate that refuses to run is a gate that gets
# skipped.
#
# HARD RULE 7. Nothing here kills anything. The sidecar asks whether a pid
# exists with `kill 0`, which sends no signal, and it signals no process at all.
#
# ENVIRONMENT
#   DORKOS_HEAVY_SLOTS          concurrent heavy runs allowed (ci/config.yaml
#                               local.heavy_run_slots; 3 if that cannot be read)
#   DORKOS_HEAVY_WAIT_SECONDS   how long to wait for a slot before running
#                               anyway; defaults to local.heavy_lock_wait_seconds,
#                               or local.heavy_job_wait_seconds with --job
#   DORKOS_HEAVY_POLL_SECONDS   how often the head of the queue retries (1)
#   DORKOS_HEAVY_LOCK_DIR       where the slots live (/tmp/dorkos-heavy-locks-<uid>)
#   DORKOS_HEAVY_LOCK=0         switch the cap off entirely for one run
#   DORKOS_HEAVY_PERL           the perl to use (perl); the fixtures point it at
#                               a missing path to prove the no-perl fallback
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

job=0
if [ "${1:-}" = --job ]; then
  job=1
  shift
fi

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

# The default numbers live in ci/config.yaml so they are in the fenced file the
# steward reads, not only in a script. Read with sed rather than a YAML parser
# because this runs before (and without) any node_modules;
# packages/ci-steward/src/__tests__/local.test.ts pins the fallbacks below to
# the config so a fallback can never quietly become the real value.
config_number() {
  sed -n "s/^  $1: *\([0-9][0-9]*\).*/\1/p" "$repo_root/ci/config.yaml" 2>/dev/null | head -n 1
}

SLOTS="${DORKOS_HEAVY_SLOTS:-$(config_number heavy_run_slots)}"
SLOTS="${SLOTS:-3}"
GATE_WAIT_SECONDS="$(config_number heavy_lock_wait_seconds)"
GATE_WAIT_SECONDS="${GATE_WAIT_SECONDS:-45}"
JOB_WAIT_SECONDS="$(config_number heavy_job_wait_seconds)"
JOB_WAIT_SECONDS="${JOB_WAIT_SECONDS:-1800}"
if [ "$job" = 1 ]; then
  WAIT_SECONDS="${DORKOS_HEAVY_WAIT_SECONDS:-$JOB_WAIT_SECONDS}"
else
  WAIT_SECONDS="${DORKOS_HEAVY_WAIT_SECONDS:-$GATE_WAIT_SECONDS}"
fi
POLL_SECONDS="${DORKOS_HEAVY_POLL_SECONDS:-1}"
PERL="${DORKOS_HEAVY_PERL:-perl}"

run_uncapped() {
  "$@"
  exit $?
}

[ "${DORKOS_HEAVY_LOCK:-1}" = 0 ] && run_uncapped "$@"
# Nested inside a run that already holds a slot (or already gave up waiting for
# one): waiting again would wait on our own parent.
[ -n "${DORKOS_HEAVY_SLOT_HELD:-}" ] && run_uncapped "$@"
case "${CI:-}" in '' | 0 | false) ;; *) run_uncapped "$@" ;; esac
case $SLOTS in '' | *[!0-9]* | 0) run_uncapped "$@" ;; esac

if ! command -v "$PERL" >/dev/null 2>&1; then
  echo "[heavy-run-lock] no perl on PATH — running without the host-wide cap." >&2
  run_uncapped "$@"
fi

lock_dir="${DORKOS_HEAVY_LOCK_DIR:-/tmp/dorkos-heavy-locks-$(id -u)}"
# -m on the lock directory only, which is the intent: its parents are /tmp.
# shellcheck disable=SC2174
mkdir -p -m 700 -- "$lock_dir" 2>/dev/null
# WRITABILITY IS A SEPARATE QUESTION FROM EXISTENCE. `mkdir -p` returns 0 for a
# directory that is there but unwritable, and every slot open would then fail,
# so every waiter would sit out its whole bound and blame busy slots. One probe
# answers it.
probe="$lock_dir/.probe-$$"
if ! (: >"$probe") 2>/dev/null; then
  echo "[heavy-run-lock] cannot write ${lock_dir} — running without the host-wide cap." >&2
  run_uncapped "$@"
fi
rm -f -- "$probe"

# The sidecar. Arguments: lock dir, slots, wait bound, poll interval, the pid to
# hold the slot for, and a one-line description of the holder for waiters.
# It prints exactly one line on stdout — `acquired <waited>` or `timeout
# <waited>` — and, once acquired, holds the slot until that pid is gone.
# shellcheck disable=SC2016
holder_src='
use strict;
use warnings;
use Fcntl qw(:flock O_RDWR O_CREAT);
use Time::HiRes qw(sleep time);

my ($dir, $slots, $wait, $poll, $owner, $what) = @ARGV;
my $start = time;
my $deadline = $start + $wait;
STDOUT->autoflush(1);

sub left { my $l = $deadline - time; return $l > 0 ? $l : 0 }
sub done { print STDOUT "$_[0] ", int(time - $start), "\n"; close STDOUT }

sub slot_path { "$dir/slot-$_[0]" }

sub try_slot {
  my ($k) = @_;
  sysopen(my $fh, slot_path($k), O_RDWR | O_CREAT, 0600) or return;
  return $fh if flock($fh, LOCK_EX | LOCK_NB);
  close $fh;
  return;
}

sub try_any {
  for my $k (1 .. $slots) { my $fh = try_slot($k); return ($fh, $k) if $fh }
  return;
}

# Who holds each busy slot. A slot file with no lock on it is free whatever it
# says, so only locked files are read; a holder fills its file in just after
# locking, so a blank one is an acquire in progress.
sub holders {
  my @out;
  for my $k (1 .. $slots) {
    open(my $fh, "<", slot_path($k)) or next;
    if (flock($fh, LOCK_SH | LOCK_NB)) { close $fh; next }
    my $line = <$fh>;
    close $fh;
    if (defined $line && $line =~ /^(\d+) (\d+) (.*)$/) {
      my $age = int(time - $2);
      push @out, sprintf("slot-%d: pid %s, %dm%02ds, %s", $k, $1, $age / 60, $age % 60, $3);
    } else {
      push @out, "slot-$k: taking it now";
    }
  }
  return @out;
}

sub say_waiting {
  my @h = holders();
  printf STDERR "[heavy-run-lock] all %d heavy-run slots on this machine are busy — queueing, up to %ds more:\n",
    $slots, int(left());
  print STDERR "                 $_\n" for @h;
}

my ($fh, $k) = try_any();
unless ($fh) {
  say_waiting();
  # Line up behind the other waiters. The queue lock is held only while waiting,
  # so the head of the queue is the only one polling slots.
  my $queue;
  sysopen($queue, "$dir/queue", O_RDWR | O_CREAT, 0600) or undef $queue;
  if ($queue) {
    my $ok = eval {
      local $SIG{ALRM} = sub { die "timeout\n" };
      my $l = left();
      die "timeout\n" if $l <= 0;
      alarm(int($l) + 1);
      flock($queue, LOCK_EX) or die "timeout\n";
      alarm 0;
      1;
    };
    alarm 0;
    unless ($ok) { close $queue; undef $queue }
  }
  my $last_said = time;
  while (left() > 0) {
    ($fh, $k) = try_any();
    last if $fh;
    if (time - $last_said >= 60) { say_waiting(); $last_said = time }
    sleep($poll);
  }
  close $queue if $queue;
}

unless ($fh) {
  printf STDERR "[heavy-run-lock] still no free slot after %ds — running anyway, uncapped. The machine is\n",
    int(time - $start);
  print STDERR "                 already saturated and this run adds to it. Recorded as lock_timeout.\n";
  done("timeout");
  exit 0;
}

# Say who holds it, then hold it for as long as the owner lives.
truncate($fh, 0);
syswrite($fh, sprintf("%d %d %s\n", $owner, int(time), $what));
my $release = sub { truncate($fh, 0); close $fh; exit 0 };
$SIG{TERM} = $SIG{HUP} = $release;
done("acquired");
sleep(0.2) while kill(0, $owner);
$release->();
'

describe="$(printf '%s' "$*" | tr '\n' ' ' | cut -c1-160) (in $PWD)"

# Process substitution keeps the wrapped command in the FOREGROUND of this
# shell: same stdin, same terminal, same exit code. fd 9 carries the sidecar's
# one answer and is closed before the command runs, so the command inherits
# nothing of the lock.
exec 9< <(exec "$PERL" -e "$holder_src" -- "$lock_dir" "$SLOTS" "$WAIT_SECONDS" "$POLL_SECONDS" "$$" "$describe")
verdict=''
waited=0
read -r verdict waited <&9
exec 9<&-

case $verdict in
  acquired)
    [ "${waited:-0}" -gt 0 ] 2>/dev/null && ci_steward_note lock_wait "$waited"
    ;;
  timeout)
    ci_steward_note lock_timeout "$waited"
    ;;
  *)
    echo "[heavy-run-lock] the lock helper exited without an answer — running without the host-wide cap." >&2
    ;;
esac

# Exported even after a timeout: a nested call must not queue a second time
# behind slots its own parent already gave up waiting for.
export DORKOS_HEAVY_SLOT_HELD=1
"$@"
exit $?
