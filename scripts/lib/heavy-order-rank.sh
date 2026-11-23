# shellcheck shell=bash
# repo_root is set by heavy-run-lock.sh; r_at and r_note are read by heavy-order-write.sh.
# shellcheck disable=SC2154,SC2034
# Where a new label lands when `--insert` names no position (DOR-5065). Sourced
# by scripts/heavy-run-lock.sh after heavy-order.sh and heavy-order-write.sh;
# not run on its own.
#
# WHY THIS EXISTS. On 2026-11-22 the order line took about twenty hand moves in
# one day, mostly to put a new label where its ticket's place in the work order
# said it should go. So `--insert <label>` with no --after/--before/--at/--top
# now does that itself:
#
#   * A release row (`rel-*`, `qa-gate-*`, `qa-row*`) goes first: behind any
#     release rows already there and behind whatever is running, ahead of
#     everything else (the PM's Nov 22 rule; contributing/ci.md).
#   * A label naming a ticket (`DOR-1234`, any case; the first one wins) goes
#     in front of the first line whose ticket ranks lower in `flow order`. A
#     line with no ticket, or whose ticket flow does not rank, counts as
#     lowest. A release row or a running line is never passed.
#   * Anything else goes to the end, with a note: a label with no ticket, a
#     ticket flow does not rank, or no rank to be had at all.
#
# A PR number (`#1234`) is not looked up: nothing in this repo maps one to its
# ticket without a network call, so name the ticket in the label.
#
# THE RANKS come from `flow order --json` (Flow 0.100.0 and later), one call
# for the whole line, never one per label. A real call pulls the whole backlog
# and took over two minutes on 2026-11-23, far too long to hold a write for. So
# the ranks are kept in the order folder:
#
#   heavy-order.ranks      "DOR-1<TAB>3" / "DOR-2<TAB>unranked", one per line;
#                          its age is the age of the ranks
#   heavy-order.ranks.run  the pid of a refresh in flight
#   heavy-order.ranks.err  why the last refresh failed
#
# Ranks younger than DORKOS_HEAVY_RANKS_MAX_AGE seconds (1800) are used as they
# are. Older or missing ones start a refresh in the background (one at a time,
# capped at DORKOS_HEAVY_FLOW_REFRESH_TIMEOUT seconds, 300) and the command
# waits up to DORKOS_HEAVY_FLOW_TIMEOUT seconds (10) for it. When it is not
# back in time, ranks up to a day old are used, and said to be old; with none,
# the label goes to the end with a note and the refresh lands for the next
# command. Flow missing, an install without `order`, a failure or output that
# is not the order: the same, with the reason. Ranking never blocks the line,
# and the wait is outside the order lock, so it never holds other writers up.
#
# Flow is the installed plugin at `.dork/plugins/flow` in this checkout, else
# in the main checkout (a worktree has none of its own), run as
# `node --experimental-strip-types <plugin>/scripts/flow.ts order --json` from
# this checkout's root. DORKOS_HEAVY_FLOW_CMD is a test hook, read from the
# caller's environment only: one program path, run as `<it> order --json`,
# never a shell string.
#
# Nothing here signals a process (Hard Rule 7): the refresh's cap is an alarm
# the kernel delivers to the flow process itself (perl's `alarm` survives
# `exec`), and "in flight" is a liveness probe that sends nothing.

# The first ticket id in label $1, upper-cased (DOR-1234), or nothing.
order_ticket_of() {
  printf '%s' "$1" | grep -oiE 'dor-[0-9]+' | head -n 1 | tr '[:lower:]' '[:upper:]'
}

# True when label $1 is a release row.
order_is_release() {
  case "$1" in rel-* | qa-gate-* | qa-row*) return 0 ;; esac
  return 1
}

# How to run flow, as words in ORDER_FLOW_ARGV, or fail with the reason in
# ORDER_RANKS_WHY.
order_flow_argv() {
  local root common
  ORDER_FLOW_ARGV=()
  if [ -n "${DORKOS_HEAVY_FLOW_CMD:-}" ]; then
    [ -x "$DORKOS_HEAVY_FLOW_CMD" ] || { ORDER_RANKS_WHY="DORKOS_HEAVY_FLOW_CMD is not a program"; return 1; }
    ORDER_FLOW_ARGV=("$DORKOS_HEAVY_FLOW_CMD")
    return 0
  fi
  root="$repo_root/.dork/plugins/flow"
  if [ ! -f "$root/scripts/flow.ts" ]; then
    common=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    root="${common%/.git}/.dork/plugins/flow"
  fi
  [ -f "$root/scripts/flow.ts" ] || { ORDER_RANKS_WHY="flow is not installed"; return 1; }
  command -v node >/dev/null 2>&1 || { ORDER_RANKS_WHY="node is not on PATH"; return 1; }
  ORDER_FLOW_ARGV=(node --experimental-strip-types --disable-warning=ExperimentalWarning "$root/scripts/flow.ts")
}

# One refresh, run in the background by order_ranks_load: ask flow, and on
# success replace heavy-order.ranks in one rename; else write why to .err.
order_ranks_refresh() {
  local cap out rc why=''
  cap="${DORKOS_HEAVY_FLOW_REFRESH_TIMEOUT:-300}"
  case $cap in '' | *[!0-9]* | 0) cap=300 ;; esac
  # $$ is the parent's pid in a subshell (and bash 3.2 has no BASHPID).
  out="$ORDER_RANKS_FILE.out.$$.$RANDOM"
  # Output to a file, not a pipe: a child flow left running must not hold a
  # read open past the cap.
  # shellcheck disable=SC2016 # a perl program, not a shell expansion
  (cd "$repo_root" && perl -e 'my $t = shift; alarm $t; exec { $ARGV[0] } @ARGV or exit 127' \
    "$cap" "${ORDER_FLOW_ARGV[@]}" order --json) </dev/null >"$out" 2>/dev/null
  rc=$?
  case $rc in
    0) ;;
    142) why="flow order took over ${cap}s" ;;
    *) why="flow order failed (exit $rc; Flow 0.100.0 or later has it)" ;;
  esac
  # shellcheck disable=SC2016 # a perl program, not a shell expansion
  if [ "$rc" = 0 ] && perl -MJSON::PP -e '
    local $/; my $d = eval { JSON::PP::decode_json(<STDIN>) };
    exit 3 unless ref $d eq "HASH" && ref $d->{issues} eq "ARRAY";
    for (@{ $d->{issues} }) {
      next unless ref $_ eq "HASH" && defined $_->{identifier} && defined $_->{place};
      printf "%s\t%s\n", uc $_->{identifier}, $_->{place} if $_->{place} =~ /^[0-9]+$/;
    }
    for my $k (qw(held needsTriage inFlight dorian)) {
      next unless ref $d->{$k} eq "ARRAY";
      for (@{ $d->{$k} }) { printf "%s\tunranked\n", uc $_->{identifier} if ref $_ eq "HASH" && defined $_->{identifier} }
    }' <"$out" >"$out.map" 2>/dev/null; then
    mv -f -- "$out.map" "$ORDER_RANKS_FILE" && rm -f -- "$ORDER_RANKS_FILE.err"
  else
    printf '%s\n' "${why:-flow order printed no work order}" >"$ORDER_RANKS_FILE.err"
  fi
  rm -f -- "$out" "$out.map"
  # Only one refresh runs at a time, so the marker is this one's.
  rm -f -- "$ORDER_RANKS_FILE.run"
  return 0
}

# True while a refresh is in flight (a liveness probe: no signal is sent).
order_ranks_running() {
  local pid
  pid=$(cat "$ORDER_RANKS_FILE.run" 2>/dev/null)
  case $pid in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

# The ranks for this command, once. Sets ORDER_RANKS_STATE (ok | off),
# ORDER_RANKS (the map), ORDER_RANKS_OLD (a note when they are old) and, when
# off, ORDER_RANKS_WHY.
order_ranks_load() {
  [ -n "${ORDER_RANKS_STATE:-}" ] && return 0
  local max wait age deadline
  ORDER_RANKS_STATE=off
  ORDER_RANKS=''
  ORDER_RANKS_WHY=''
  ORDER_RANKS_OLD=''
  ORDER_RANKS_FILE="$ORDER_DIR/heavy-order.ranks"
  max="${DORKOS_HEAVY_RANKS_MAX_AGE:-1800}"
  case $max in '' | *[!0-9]*) max=1800 ;; esac
  wait="${DORKOS_HEAVY_FLOW_TIMEOUT:-10}"
  case $wait in '' | *[!0-9]*) wait=10 ;; esac
  age=$(file_age "$ORDER_RANKS_FILE")
  if [ -z "$age" ] || [ "$age" -ge "$max" ]; then
    if order_flow_argv; then
      if ! order_ranks_running; then
        rm -f -- "$ORDER_RANKS_FILE.err"
        order_ranks_refresh </dev/null >/dev/null 2>&1 8>&- &
        printf '%s\n' "$!" >"$ORDER_RANKS_FILE.run"
        disown "$!" 2>/dev/null
      fi
      deadline=$(($(date +%s) + wait))
      while order_ranks_running && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.2; done
      if order_ranks_running; then
        ORDER_RANKS_WHY="flow order is still running after ${wait}s; the next command uses it"
      elif [ -f "$ORDER_RANKS_FILE.err" ]; then
        ORDER_RANKS_WHY=$(head -n 1 "$ORDER_RANKS_FILE.err")
      fi
    fi
    age=$(file_age "$ORDER_RANKS_FILE")
    # Ranks from the last day still beat none, said to be old.
    if [ -n "$age" ] && [ "$age" -ge "$max" ]; then
      [ "$age" -lt 86400 ] || return 0
      ORDER_RANKS_OLD="ranks $((age / 60)) min old: ${ORDER_RANKS_WHY:-no refresh}"
    fi
  fi
  [ -n "$age" ] || return 0
  ORDER_RANKS=$(cat "$ORDER_RANKS_FILE" 2>/dev/null) || return 0
  ORDER_RANKS_STATE=ok
  return 0
}

# Ticket $1's place in the work order, "unranked", or nothing when no ranks
# could be had. A ticket flow does not list at all is unranked too.
order_rank_of() {
  [ "${ORDER_RANKS_STATE:-}" = ok ] || return 0
  local r
  r=$(printf '%s\n' "$ORDER_RANKS" | T="$1" awk -F '\t' 'BEGIN { t = ENVIRON["T"] } $1 == t { print $2; exit }')
  printf '%s' "${r:-unranked}"
}

# The one short --list column for label $1: release, rank N, unranked,
# no ticket, or unknown (no ranks to be had).
order_rank_column() {
  local t r
  order_is_release "$1" && { printf 'release'; return 0; }
  t=$(order_ticket_of "$1")
  [ -n "$t" ] || { printf 'no ticket'; return 0; }
  r=$(order_rank_of "$t")
  case $r in
    '') printf 'unknown' ;;
    *[!0-9]*) printf 'unranked' ;;
    *) printf 'rank %s' "$r" ;;
  esac
}

# Where label $1 goes in line file $2 (trimmed, one label per line). Sets
# r_at (a 1-based place, or empty for the end) and r_note (why, for the log).
order_rank_place() {
  local label=$1 file=$2 ticket='' rank='' l lt lr i=0 release=0
  r_at=''
  if order_is_release "$label"; then
    release=1
    r_note='release row: first, behind release rows and running jobs'
  else
    ticket=$(order_ticket_of "$label")
    if [ -z "$ticket" ]; then
      r_note='no ticket in the label: at the end'
      return 0
    fi
    rank=$(order_rank_of "$ticket")
    case $rank in
      '')
        r_note="$ticket: no rank (${ORDER_RANKS_WHY:-unknown}): at the end"
        return 0
        ;;
      *[!0-9]*)
        r_note="$ticket: unranked in flow order: at the end"
        return 0
        ;;
    esac
    r_note="$ticket: rank $rank${ORDER_RANKS_OLD:+ ($ORDER_RANKS_OLD)}"
  fi
  while IFS= read -r l; do
    i=$((i + 1))
    order_is_release "$l" && continue
    claim_live "$l" && continue
    [ "$release" = 1 ] && { r_at=$i; return 0; }
    lt=$(order_ticket_of "$l")
    lr=''
    [ -n "$lt" ] && lr=$(order_rank_of "$lt")
    case $lr in '' | *[!0-9]*) r_at=$i; return 0 ;; esac
    [ "$lr" -gt "$rank" ] && { r_at=$i; return 0; }
  done <"$file"
  return 0
}
