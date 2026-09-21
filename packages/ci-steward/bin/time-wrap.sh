# shellcheck shell=sh
# CI Steward time-wrap (plans/ci-steward-plan.md §4.5): records when each
# lefthook command starts and ends, so local hook times are measured, not
# guessed. POSIX sh only: it runs under dash, bash, ksh and zsh's sh mode.
#
# Sourced, never executed, as the first line of every lefthook command:
#
#   [ -r packages/ci-steward/bin/time-wrap.sh ] && . packages/ci-steward/bin/time-wrap.sh && ci_steward_time_wrap <hook> <command>
#   <the command's own body, byte for byte what it was>
#
# (A function rather than `. file <args>`, because dash ignores arguments to `.`.
# The `[ -r ]` guard means a checkout without this file, say an old branch,
# runs the hook exactly as before, just untimed.)
#
# Sourcing keeps the hook's own shell as the parent of the real command. No new
# process sits between lefthook and the command, so its stdin (the pre-push ref
# list), its exit status and the signals it receives are exactly what they were.
# The function appends a START line now and sets an EXIT trap that appends the
# END line with the exit status. The trap does not call `exit`, so the shell
# still leaves with the status the command set.
#
# A signal is different. Without a trap, macOS /bin/sh (bash) runs the EXIT trap
# with status 0 when SIGTERM arrives, recording a killed hook as a pass, and
# dash runs none at all. So INT, TERM and HUP get their own trap: write END with
# 128+n, the status a shell reports for a signal death, then exit with it.
# DorkOS stops a session's processes with SIGTERM, so this is the common kill.
# The shell runs the trap once its foreground command has returned; the group
# kill that delivers the signal reaches that command too.
#
# SIGKILL runs no trap at all: a START with no END, older than the ceiling
# (ci/config.yaml local.killed_after_seconds), is how `ci-steward local-export`
# counts that kind of kill. Younger, it is "running or killed", never "killed".
#
# The file is `$(git rev-parse --git-common-dir)/ci-steward/local-timings.jsonl`,
# shared by every worktree of the clone; it must match local.timings_file in
# ci/config.yaml (a test pins the two together). Every failure in here is
# swallowed: a broken timings file must never fail or change a hook.
# CI_STEWARD_TIMINGS=0 switches it off.
#
# THE MACHINE IS PART OF THE MEASUREMENT (DOR-2160). A hook's wall time on this
# box is mostly a fact about the box: several agents plus the operator's own dev
# server share 14 cores and 48 GiB, and while the numbers this file records were
# being called "the pre-push gate is slow", the load average sat around 500 and
# 15.9 GB of a 17.4 GB swap file was in use. So every S, E and O line carries
# four fields about the machine at that instant:
#
#   l  1-minute load average        n  online cores
#   m  available memory, MiB        s  swap in use, MiB
#
# Each is `null` when the platform will not say — a fact, not a zero — so this
# degrades in silence on Windows Git Bash, where none of the probes exist.
#
# `m` MEANS DIFFERENT THINGS ON THE TWO PLATFORMS, and pretending otherwise
# would be the dishonest option. On Linux it is MemAvailable, the kernel's own
# estimate of what a new process could get, which is the right number. macOS has
# no equivalent: it compresses memory, so its large "inactive" pool is neither
# free nor reclaimable at a knowable rate, and counting it would report 15 GB
# available on a machine that is swapping hard. So on macOS `m` is free pages
# only, which understates — and `s` is the honest signal there. Read them
# together, and see the `machine_*` thresholds in ci/config.yaml, which fire on
# either.
#
# THE COST IS ONE FORK. On Linux the load and memory probes are shell reads of
# /proc, no fork at all. On macOS one `sysctl -n` returns all four values in a
# single call: measured 20 ms per event line while the machine was at load 561,
# which is the pessimistic end of the range — against hook runs whose p90 was
# 26.6 minutes. Cores come from one `getconf`, memoised for the life of the
# shell. Nothing here may become the reason a hook is slow.
#
# NOTES ARE THE THIRD EVENT TYPE. `ci_steward_note <key> [number]` appends an
# `O` line under the running command's id, for an outcome the exit status
# cannot carry: today, a heavy-run slot that was waited for, and one that was
# never granted so the command ran uncapped. A gate whose protection quietly
# stopped applying must be visible in the data, and "it exited 0" is exactly the
# shape of silence. Child processes get it too: the run's identity is exported, so a
# script the hook invokes can source this file and write a note against the same
# run.
ci_steward_time_wrap() {
  [ "${CI_STEWARD_TIMINGS:-1}" = 0 ] && return 0
  _cst_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
    _cst_dir=$(git rev-parse --git-common-dir 2>/dev/null) || return 0
  # An absolute path, POSIX or Windows (Git Bash prints C:/...).
  case $_cst_dir in /* | [A-Za-z]:/*) ;; *) _cst_dir="$PWD/$_cst_dir" ;; esac
  _cst_file="$_cst_dir/ci-steward/local-timings.jsonl"
  mkdir -p "$_cst_dir/ci-steward" 2>/dev/null || return 0
  _cst_h=$1
  _cst_c=$2
  _cst_t=$(date +%s 2>/dev/null) || return 0
  _cst_id="$$-$_cst_t"
  _cst_n=$(_cst_cores)
  printf '{"v":1,"e":"S","h":"%s","c":"%s","id":"%s","pp":%s,"t":%s,%s}\n' \
    "$_cst_h" "$_cst_c" "$_cst_id" "${PPID:-0}" "$_cst_t" "$(_cst_machine)" \
    >>"$_cst_file" 2>/dev/null || return 0
  CI_STEWARD_HOOK=$_cst_h
  CI_STEWARD_COMMAND=$_cst_c
  CI_STEWARD_RUN_ID=$_cst_id
  CI_STEWARD_TIMINGS_FILE=$_cst_file
  export CI_STEWARD_HOOK CI_STEWARD_COMMAND CI_STEWARD_RUN_ID CI_STEWARD_TIMINGS_FILE
  trap '_cst_end $?' EXIT
  trap '_cst_signal 1' HUP
  trap '_cst_signal 2' INT
  trap '_cst_signal 15' TERM
  return 0
}

# The four machine fields, as a ready-made JSON fragment: `"l":..,"n":..,"m":..,"s":..`.
#
# Built as one string rather than three variables because every caller is a
# command substitution, and a subshell's assignments do not come back. Each
# value is validated to digits (and a dot, for the load) before it is printed,
# so a platform that answers with something unexpected costs a JSON null rather
# than a torn line that breaks the whole file's parse.
_cst_machine() {
  _cst_l=null
  _cst_m=null
  _cst_s=null
  _cst_sw=''
  if [ -r /proc/loadavg ]; then
    # No fork on Linux: both files are shell reads.
    read -r _cst_l _cst_junk </proc/loadavg 2>/dev/null || _cst_l=null
    _cst_sw_total='' _cst_sw_free=''
    while read -r _cst_k _cst_v _cst_junk; do
      case $_cst_k in
        MemAvailable:) _cst_m=$((_cst_v / 1024)) ;;
        SwapTotal:) _cst_sw_total=$_cst_v ;;
        SwapFree:) _cst_sw_free=$_cst_v ;;
      esac
    done </proc/meminfo 2>/dev/null
    if [ -n "$_cst_sw_total" ] && [ -n "$_cst_sw_free" ]; then
      _cst_s=$(((_cst_sw_total - _cst_sw_free) / 1024))
    fi
  elif command -v sysctl >/dev/null 2>&1; then
    # macOS/BSD, one call for all of it. `vm.loadavg` prints `{ 1.2 3.4 5.6 }`
    # and `vm.swapusage` prints `total = 17408.00M  used = 15881.62M  ...`,
    # both C locale and dot-decimal whatever the user's locale is.
    #
    # Matched on CONTENT, not on line number: a key `sysctl` cannot answer is
    # simply absent from the output, and an ordinal parse would then read the
    # next value as this one. Only the two bare integers are ordinal, and they
    # are requested in that order.
    eval "$(sysctl -n vm.loadavg vm.swapusage vm.page_free_count hw.pagesize 2>/dev/null |
      awk '/^\{/            { if ($2 ~ /^[0-9.]+$/) l = $2; next }
           /^total = /      { u = $6; sub(/M$/, "", u); s = int(u); next }
           /^[0-9]+$/       { if (pages == "") pages = $1; else if (psize == "") psize = $1 }
           END {
             if (l != "") printf "_cst_l=%s\n", l
             if (s != "") printf "_cst_sw=%d\n", s
             if (pages != "" && psize != "") printf "_cst_m=%d\n", pages * psize / 1048576
           }')"
    [ -n "${_cst_sw:-}" ] && _cst_s=$_cst_sw
  fi
  case $_cst_l in '' | *[!0-9.]*) _cst_l=null ;; esac
  case $_cst_m in '' | *[!0-9]*) [ "$_cst_m" = null ] || _cst_m=null ;; esac
  case $_cst_s in '' | *[!0-9]*) [ "$_cst_s" = null ] || _cst_s=null ;; esac
  printf '"l":%s,"n":%s,"m":%s,"s":%s' "$_cst_l" "$(_cst_cores)" "$_cst_m" "$_cst_s"
}

# Online cores, or `null`. Memoised in `_cst_n`, which the caller sets once in
# the hook's own shell so the command substitutions below inherit it: the count
# cannot change under a hook run, and a `getconf` per line would be waste.
_cst_cores() {
  if [ -z "${_cst_n:-}" ]; then
    _cst_n=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || _cst_n=''
    [ -n "$_cst_n" ] || _cst_n=$(nproc 2>/dev/null) || _cst_n=''
    case $_cst_n in '' | *[!0-9]*) _cst_n=null ;; esac
  fi
  printf '%s' "$_cst_n"
}

# One outcome the exit status cannot carry, against the running command.
#
#   ci_steward_note lock_timeout           a flag: the thing happened
#   ci_steward_note lock_wait 37           the same, with one number
#
# The key is restricted to lowercase and underscores and the number to digits,
# so neither can break the line's JSON; anything else is dropped rather than
# written. Safe to call when no wrap is running (it does nothing), and safe to
# call from a child process that sourced this file (the identity is exported).
ci_steward_note() {
  [ "${CI_STEWARD_TIMINGS:-1}" = 0 ] && return 0
  [ -n "${CI_STEWARD_TIMINGS_FILE:-}" ] || return 0
  case ${1:-} in '' | *[!a-z_]*) return 0 ;; esac
  case ${2:-} in
    '') _cst_d=null ;;
    *[!0-9]*) _cst_d=null ;;
    *) _cst_d=$2 ;;
  esac
  printf '{"v":1,"e":"O","h":"%s","c":"%s","id":"%s","t":%s,"o":"%s","d":%s,%s}\n' \
    "${CI_STEWARD_HOOK:-}" "${CI_STEWARD_COMMAND:-}" "${CI_STEWARD_RUN_ID:-}" \
    "$(date +%s 2>/dev/null || echo 0)" "$1" "$_cst_d" "$(_cst_machine)" \
    >>"$CI_STEWARD_TIMINGS_FILE" 2>/dev/null
  return 0
}

_cst_end() {
  printf '{"v":1,"e":"E","h":"%s","c":"%s","id":"%s","pp":%s,"t":%s,"x":%s,%s}\n' \
    "$_cst_h" "$_cst_c" "$_cst_id" "${PPID:-0}" "$(date +%s 2>/dev/null || echo 0)" "$1" \
    "$(_cst_machine)" \
    >>"$_cst_file" 2>/dev/null
}

_cst_signal() {
  trap - EXIT HUP INT TERM
  _cst_end $((128 + $1))
  exit $((128 + $1))
}
