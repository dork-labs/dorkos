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
  printf '{"v":1,"e":"S","h":"%s","c":"%s","id":"%s","pp":%s,"t":%s}\n' \
    "$_cst_h" "$_cst_c" "$_cst_id" "${PPID:-0}" "$_cst_t" >>"$_cst_file" 2>/dev/null || return 0
  trap '_cst_end $?' EXIT
  trap '_cst_signal 1' HUP
  trap '_cst_signal 2' INT
  trap '_cst_signal 15' TERM
  return 0
}

_cst_end() {
  printf '{"v":1,"e":"E","h":"%s","c":"%s","id":"%s","pp":%s,"t":%s,"x":%s}\n' \
    "$_cst_h" "$_cst_c" "$_cst_id" "${PPID:-0}" "$(date +%s 2>/dev/null || echo 0)" "$1" \
    >>"$_cst_file" 2>/dev/null
}

_cst_signal() {
  trap - EXIT HUP INT TERM
  _cst_end $((128 + $1))
  exit $((128 + $1))
}
