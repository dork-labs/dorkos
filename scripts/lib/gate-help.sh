# shellcheck shell=bash
# Every gate's --help (DOR-4950), for bash gates. Sourced as a gate's first
# command, before it does any work:
#
#   gate_help="$(dirname "$0")/lib/gate-help.sh"
#   [ ! -r "$gate_help" ] || . "$gate_help"
#
# The guard is for the PR-side gates, whose workflows check out main's copy of
# the one script and nothing beside it: there the gate runs as before, and only
# --help is missing, which no workflow asks for.
#
# When the gate's first argument (after a leading `--`) is --help or -h, it
# prints the block of the gate's own header between a line `# --help` and a line
# `# --help end`, without the `# `, and exits 0. Otherwise it changes nothing.
# gate-help.mjs beside this file reads the same block the same way for the
# JavaScript and TypeScript gates; it says what the block holds.

case "${1:-}" in
  --) __gate_help_first=${2:-} ;;
  *) __gate_help_first=${1:-} ;;
esac
case "$__gate_help_first" in
  -h | --help)
    awk '
      { line = $0; sub(/^[ \t]*#[ \t]?/, "", line); sub(/[ \t]+$/, "", line) }
      inside && line == "--help end" { exit }
      inside { print line }
      line == "--help" { inside = 1 }
    ' "$0"
    exit 0
    ;;
esac
unset __gate_help_first
