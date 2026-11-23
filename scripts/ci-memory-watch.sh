#!/usr/bin/env bash
# Watch a CI runner's memory across a job, and say afterwards how close it came (DOR-4813).
#
#   bash scripts/ci-memory-watch.sh start    # before the heavy steps: sample every 5s
#   bash scripts/ci-memory-watch.sh report   # last step, `if: always()`: print what was seen
#
# WHY. credential-free-build died mid-build again and again with a bare `Killed`
# on a tsc child, "the runner has received a shutdown signal", or "the hosted
# runner lost communication with the server". Each is the shape of a 16 GB
# runner running out of memory, and none of them proves it: the job's own log
# stops at the moment that would have said so. This leaves the proof behind
# either way. A red run shows the peak, the kernel's OOM lines and which
# folders held the memory; a green run shows the headroom it had, which is the
# number any future change to `--concurrency` or the heap has to be read
# against.
#
# WHAT IT RECORDS, AND WHAT IT NEVER DOES. Every sample is one line: the time,
# memory used and available, swap used, and the three biggest processes by
# resident memory, each as its name, its working folder (relative to the
# checkout, which is how a tsc child names its package) and its RSS. Never a
# command line: a process's arguments can carry a token, and this prints into
# a public log.
#
# IT NEVER FAILS THE JOB. `report` always exits 0, so a green build is never
# turned red by its own diagnostics. If the runner died outright ("lost
# communication", or often "the runner has received a shutdown signal"),
# `report` may never run at all; nothing inside a job can survive that, and the
# missing report is itself the sign.
#
# Linux only (it reads /proc). Run it through the scrub like every other step:
#   bash scripts/run-credential-free.sh bash scripts/ci-memory-watch.sh <start|report>
set -u

LOG="${RUNNER_TEMP:-/tmp}/ci-memory-watch.log"
INTERVAL="${CI_MEMORY_WATCH_INTERVAL:-5}"
ROOT="${GITHUB_WORKSPACE:-$PWD}"

# One meminfo field in MB.
mem_mb() { awk -v k="$1:" '$1 == k { print int($2 / 1024) }' /proc/meminfo; }

# The three biggest processes: name, folder (relative to the checkout) and RSS in MB.
# One grep over every status file, not one awk per process: cheap on a busy 4-vCPU
# runner, and grep carries on past a process that exits mid-read (mawk would stop).
top_procs() {
  local pid rss comm cwd
  grep -H '^VmRSS:' /proc/[0-9]*/status 2>/dev/null \
    | awk -F'[/: \t]+' '{ print $(NF - 1), $3 }' \
    | sort -rn | head -3 | while read -r rss pid; do
    comm=$(cat "/proc/$pid/comm" 2>/dev/null || echo '?')
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo '?')
    cwd=${cwd#"$ROOT"/}
    printf '%s@%s:%sMB ' "$comm" "$cwd" "$((rss / 1024))"
  done
}

sample() {
  local total avail swap_total swap_free
  total=$(mem_mb MemTotal)
  avail=$(mem_mb MemAvailable)
  swap_total=$(mem_mb SwapTotal)
  swap_free=$(mem_mb SwapFree)
  printf '%s used_mb=%s avail_mb=%s swap_used_mb=%s top=%s\n' \
    "$(date -u +%H:%M:%S)" "$((total - avail))" "$avail" "$((swap_total - swap_free))" "$(top_procs)"
}

start() {
  if [ ! -r /proc/meminfo ]; then
    echo "ci-memory-watch: no /proc/meminfo here; nothing to watch"
    return 0
  fi
  : > "$LOG"
  # setsid + nohup: the loop outlives this step and runs until the job ends,
  # when the runner reaps it with every other orphan.
  setsid nohup bash -c "while :; do bash '$0' sample >> '$LOG' 2>/dev/null; sleep '$INTERVAL'; done" \
    > /dev/null 2>&1 < /dev/null &
  echo "ci-memory-watch: sampling every ${INTERVAL}s into $LOG"
  free -m
}

report() {
  echo "== memory now"
  free -m || true
  if [ -s "$LOG" ]; then
    local samples peak
    samples=$(wc -l < "$LOG" | tr -d ' ')
    # The sample with the most memory used. Matched as a whole field: `swap_used_mb=`
    # also ends in `used_mb=`, and a loose match picks the most swap instead.
    peak=$(awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^used_mb=/) { v = substr($i, 9) + 0; if (v >= max) { max = v; line = $0 } } } END { print line }' "$LOG")
    echo "== peak of $samples samples (every ${INTERVAL}s)"
    echo "$peak"
    echo "== the last 12 samples"
    tail -12 "$LOG"
    {
      echo "### Runner memory (DOR-4813)"
      echo ""
      echo "Peak of $samples samples: \`$peak\`"
    } >> "${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true
  else
    echo "== no samples (the watch did not start, or never wrote)"
  fi
  echo "== kernel out-of-memory lines"
  local oom
  oom=$({ sudo -n dmesg -T 2>/dev/null || dmesg -T 2>/dev/null; } \
    | grep -iE 'out of memory|oom-kill|oom_reaper|killed process' | tail -20)
  echo "${oom:-(none)}"
  echo "== biggest processes now"
  top_procs
  echo
  return 0
}

case "${1:-}" in
  start) start ;;
  sample) sample ;;
  report) report || true ;;
  *)
    echo "usage: $0 start|report" >&2
    exit 2
    ;;
esac
exit 0
