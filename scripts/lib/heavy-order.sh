# shellcheck shell=bash
# The ORDER line for heavy local runs (DOR-4209, DOR-4901). Sourced by
# scripts/heavy-run-lock.sh; not run on its own.
#
# WHY THIS EXISTS
#
# DorkOS's load gate is the one line for heavy jobs on this computer: first
# come, first served, with a person able to let a job through or move it to the
# front. A coordinator running many build chats needs one more thing the gate
# does not have: to say WHICH job goes next before those jobs exist (a release
# gate first, then the PRs in a chosen order). So a labelled run
# (`--label <label>`) checks an order file first. While the file has a line,
# only the label on its top line may start; anyone else is refused at once
# (exit 75, "try again later") and told who is next. The top label then waits
# in the gate like any job. A run leaves the line when it ends. A job that
# never runs through this script leaves with `--done <label>`. Runs with no
# label, and agents' own heavy commands, never read the order file.
#
# A TOP LINE THAT NEVER STARTS MOVES DOWN (DOR-4901). On 2026-11-21 the top
# line's owner never started, nothing was running, and eleven labels waited
# behind it for 17 minutes. So when the top label has had no live run for
# `DORKOS_HEAVY_ORDER_STALE_SECONDS` (900), the next call through this script
# moves it down ONE place, writes a dated note, and tells its owner: the note is
# printed to whoever moved it, handed to the command in the CALLER'S OWN
# `DORKOS_HEAVY_NOTIFY` when it is set, and shown to the owner the next time it
# asks. A line is never deleted, and a top label with a live run is never moved.
#
# The notify command comes from the environment, never from a file in the
# folder (Security, Nov 21): a file there would run inside whichever agent next
# moved a line, so anything able to write one file there could run code at that
# agent's level. An executable left in the folder is never run.
#
# "A live run" is a CLAIM: the top label writes one the moment it passes the
# order check, so a run still waiting in the gate counts as live. A job outside
# this script keeps its place for a pid's lifetime with
# `heavy-run-lock.sh --label <label> --hold <pid>`.
#
# THE FILES, all in the order folder: `DORKOS_HEAVY_ORDER_DIR`, else
# `load-gate/` in the DorkOS data folder (`$DORK_HOME`, else `~/.dork`), the
# same folder whose `config.json` holds the gate's settings. It is made (mode
# 700) on first use. Only the order file is yours to write by hand.
#   heavy-order          one label per line; blank lines are ignored, and each
#                        line is compared trimmed
#   heavy-order.top      written here: the top label and since when it has
#                        been idle
#   heavy-claims/        written here: one file per live top-of-line run
#   heavy-order-notes.md written here: one dated line per move
#
# HARD RULE 7. Nothing here signals a process. Liveness is `kill -0`, which
# sends nothing, plus a beat file the run touches every 30 seconds, because a
# sandboxed caller (Codex) can be told a live pid does not exist.

# The order folder: DORKOS_HEAVY_ORDER_DIR, else load-gate/ in the DorkOS data
# folder. A trailing slash is dropped so the symlink check below sees the link.
heavy_order_dir() {
  local d="${DORKOS_HEAVY_ORDER_DIR:-${DORK_HOME:-$HOME/.dork}/load-gate}"
  while [ "$d" != / ] && [ "${d%/}" != "$d" ]; do d=${d%/}; done
  printf '%s' "$d"
}

# Make the order folder if needed and confirm it is a real folder this user
# owns. Prints why not, and fails, otherwise: the order layer is then off.
order_dir_ready() {
  # -m on the order folder only, which is the intent: its parent is the data folder.
  # shellcheck disable=SC2174
  mkdir -p -m 700 -- "$1" 2>/dev/null
  if [ -L "$1" ] || [ ! -d "$1" ] || [ ! -O "$1" ] || [ ! -w "$1" ]; then
    echo "[heavy] order: $1 is not a folder you own and can write; the order line is off for this run." >&2
    return 1
  fi
}

# Trimmed, non-blank lines of the order file, one per line.
order_lines() {
  [ -f "$ORDER_FILE" ] || return 0
  awk 'NF { $1 = $1; print }' "$ORDER_FILE"
}

order_top() { order_lines | head -n 1; }

# Seconds since $1 was last modified, or empty when it cannot be read. perl,
# because `stat` flags differ between macOS and Linux.
file_age() {
  perl -e 'my @s = stat($ARGV[0]) or exit 1; print time - $s[9]' "$1" 2>/dev/null
}

# Serialise every write to the order file and the state beside it. mkdir is
# atomic; a lock older than 30 s belongs to a writer that died mid-write (a
# write takes milliseconds), so it is taken over. Bounded: after 10 s the write
# goes ahead unlocked rather than wedging every heavy run on the machine.
order_lock() {
  local age
  for _ in $(seq 1 100); do
    mkdir "$ORDER_LOCK" 2>/dev/null && return 0
    age=$(file_age "$ORDER_LOCK")
    if [ -n "$age" ] && [ "$age" -gt 30 ]; then
      rmdir "$ORDER_LOCK" 2>/dev/null
      continue
    fi
    sleep 0.1
  done
  echo "[heavy] order: the order file stayed locked for 10s; going ahead without the lock." >&2
  return 0
}
order_unlock() { rmdir "$ORDER_LOCK" 2>/dev/null; return 0; }

# Rewrite the order file through a temp file and a rename, so a reader never
# sees half of it. $@ is awk's arguments (options, then the program).
order_rewrite() {
  local tmp="$ORDER_FILE.tmp.$$"
  awk "$@" "$ORDER_FILE" >"$tmp" && mv -f -- "$tmp" "$ORDER_FILE"
  rm -f -- "$tmp"
}

# Remove the first line equal (trimmed) to $1. Other lines keep their exact text.
# shellcheck disable=SC2016 # awk programs, not shell expansions
order_pop() {
  [ -f "$ORDER_FILE" ] || return 0
  order_rewrite -v l="$1" '{ t = $0; gsub(/^[ \t]+|[ \t]+$/, "", t) } !done && t == l { done = 1; next } 1'
}

# Swap the top non-blank line with the next non-blank one: "down one place".
# shellcheck disable=SC2016 # an awk program, not a shell expansion
order_move_top_down() {
  [ -f "$ORDER_FILE" ] || return 0
  order_rewrite '
    { line[NR] = $0 }
    NF && !a { a = NR; next }
    NF && a && !b { b = NR }
    END {
      if (a && b) { t = line[a]; line[a] = line[b]; line[b] = t }
      for (i = 1; i <= NR; i++) print line[i]
    }'
}

# A claim's file name: a checksum of the label, so any label is a safe name.
claim_path() { printf '%s/claim-%s' "$CLAIMS_DIR" "$(printf '%s' "$1" | cksum | awk '{print $1}')"; }

# True when label $1 has a live claim: its pid exists (EPERM counts as alive)
# or its beat is under two minutes old.
claim_live() {
  local f pid err age
  f=$(claim_path "$1")
  [ -f "$f" ] || return 1
  age=$(file_age "$f.beat")
  [ -n "$age" ] && [ "$age" -lt 120 ] && return 0
  pid=$(awk -F '\t' 'NR == 1 { print $1 }' "$f" 2>/dev/null)
  case $pid in '' | *[!0-9]*) return 1 ;; esac
  err=$(kill -0 "$pid" 2>&1) && return 0
  case $err in *"No such process"*) return 1 ;; esac
  return 0
}

# Claim label $1 for pid $2. With $3 = 1 a beater touches the beat file every
# 30 s while that pid lives; its pid is left in ORDER_BEATER for the exit trap.
claim_take() {
  local f
  mkdir -p -- "$CLAIMS_DIR" 2>/dev/null || return 0
  f=$(claim_path "$1")
  printf '%s\t%s\t%s\n' "$2" "$(date +%s)" "$1" >"$f" 2>/dev/null
  touch "$f.beat" 2>/dev/null
  if [ "${3:-0}" = 1 ]; then
    (
      while kill -0 "$2" 2>/dev/null && [ -f "$f" ]; do
        touch "$f.beat" 2>/dev/null
        sleep 30
      done
    ) </dev/null >/dev/null 2>&1 &
    ORDER_BEATER=$!
    # Out of the job table, so stopping it at the end prints no "Terminated".
    disown "$ORDER_BEATER" 2>/dev/null
  fi
}

claim_drop() {
  local f
  f=$(claim_path "$1")
  rm -f -- "$f" "$f.beat"
}

# The newest note about label $1, if any: what its owner is told when it asks.
order_last_note_for() {
  [ -f "$NOTES_FILE" ] || return 0
  grep -F -- "'$1'" "$NOTES_FILE" 2>/dev/null | grep -F 'moved' | tail -n 1
}

# DOR-4901. Move an idle top line down one place once it has been idle for the
# stale bound. Call with the order lock held.
order_rotate_stale() {
  local top second now since state_label state_since note
  top=$(order_top)
  if [ -z "$top" ]; then
    rm -f -- "$TOP_STATE"
    return 0
  fi
  now=$(date +%s)
  state_label=''
  state_since=''
  if [ -f "$TOP_STATE" ]; then
    state_label=$(awk -F '\t' 'NR == 1 { print $2 }' "$TOP_STATE" 2>/dev/null)
    state_since=$(awk -F '\t' 'NR == 1 { print $1 }' "$TOP_STATE" 2>/dev/null)
  fi
  case $state_since in '' | *[!0-9]*) state_label='' ;; esac
  # A new top, or a top with a live run: its idle clock starts now.
  if [ "$state_label" != "$top" ] || claim_live "$top"; then
    printf '%s\t%s\n' "$now" "$top" >"$TOP_STATE" 2>/dev/null
    return 0
  fi
  [ $((now - state_since)) -ge "$ORDER_STALE_SECONDS" ] || return 0
  second=$(order_lines | sed -n 2p)
  # Alone in line: there is nobody to let past, so it stays.
  [ -n "$second" ] || return 0
  order_move_top_down
  since=$(date -r "$state_since" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || echo "epoch $state_since")
  note="- $(date '+%Y-%m-%d %H:%M %Z') (heavy-run-lock, DOR-4901): moved '$top' down one place, below '$second'. Reason: top of line since $since with no live run for $((now - state_since))s. Not deleted."
  printf '%s\n' "$note" >>"$NOTES_FILE" 2>/dev/null
  printf '%s\t%s\n' "$now" "$second" >"$TOP_STATE" 2>/dev/null
  echo "[heavy] order: $note" >&2
  # Run as `$DORKOS_HEAVY_NOTIFY <label> <note>`, in the background, its output
  # dropped. One program path, never a shell string: nothing here is eval'd.
  if [ -n "$NOTIFY_CMD" ] && [ -x "$NOTIFY_CMD" ]; then
    "$NOTIFY_CMD" "$top" "$note" </dev/null >/dev/null 2>&1 &
  fi
  return 0
}

# Set up the order layer's paths for order folder $1.
order_init() {
  ORDER_FILE="$1/heavy-order"
  ORDER_LOCK="$1/heavy-order.lock.d"
  TOP_STATE="$1/heavy-order.top"
  CLAIMS_DIR="$1/heavy-claims"
  NOTES_FILE="$1/heavy-order-notes.md"
  NOTIFY_CMD="${DORKOS_HEAVY_NOTIFY:-}"
  ORDER_STALE_SECONDS="${DORKOS_HEAVY_ORDER_STALE_SECONDS:-900}"
  case $ORDER_STALE_SECONDS in '' | *[!0-9]*) ORDER_STALE_SECONDS=900 ;; esac
  ORDER_BEATER=''
}

# --status: the order, who holds a claim, and the stale check, then exit 0.
order_status() {
  order_lock
  order_rotate_stale
  order_unlock
  local l n=0 mark
  echo "[heavy] order file: $ORDER_FILE"
  if [ -z "$(order_top)" ]; then
    echo "  (no order: a labelled run waits in the load gate like any job)"
  fi
  while IFS= read -r l; do
    n=$((n + 1))
    mark=''
    claim_live "$l" && mark=' (running)'
    echo "  $n. $l$mark"
  done < <(order_lines)
  [ -f "$TOP_STATE" ] && [ -n "$(order_top)" ] && ! claim_live "$(order_top)" &&
    echo "  top idle since: $(date -r "$(awk -F '\t' 'NR == 1 { print $1 }' "$TOP_STATE")" '+%Y-%m-%d %H:%M %Z' 2>/dev/null)"
  return 0
}
