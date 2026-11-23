# shellcheck shell=bash
# Writing the ORDER line by command, never by hand (DOR-5079). Sourced by
# scripts/heavy-run-lock.sh after scripts/lib/heavy-order.sh; not run on its own.
#
#   bash scripts/heavy-run-lock.sh --list
#   bash scripts/heavy-run-lock.sh --insert <label> [--after <l> | --before <l> | --at <N> | --top]
#                                  (no position: where the label's ticket ranks; heavy-order-rank.sh)
#   bash scripts/heavy-run-lock.sh --move <label> (--after <l> | --before <l> | --at <N> | --top)
#   bash scripts/heavy-run-lock.sh --remove <label> --reason "<why>"
#   bash scripts/heavy-run-lock.sh --done <label>
#
# WHY THIS EXISTS. On 2026-11-22 two full-file rewrites of the order file by
# hand silently dropped other chats' queued labels. The coordinator's own order
# script (.temp/coord/heavy.sh) answered with these commands; this file carries
# them into the committed line with the same names, output and exit codes, so
# that script can be retired with a drop-in swap. What the swap must keep:
#
#   * Every write takes the order lock (the same one the run path takes), re-reads
#     the file inside it, builds the new line in a temp file in the same folder,
#     and VERIFIES that the new labels are exactly the old ones minus what this
#     command removes plus what it adds. On a mismatch it writes nothing and
#     exits 3, naming the labels that would be lost or gained.
#   * A lock it cannot get within DORKOS_HEAVY_ORDER_LOCK_WAIT seconds (30)
#     changes nothing and exits 4. The run path's own lock never refuses (a
#     gate that refuses gets skipped); a write can, since a person retries it.
#   * One label per line, trimmed; blank lines dropped. Labels match
#     ORDER_LABEL_RE, checked at every entry point (exit 2 otherwise).
#   * Each managed write stores the file's sha256 in heavy-order.sum and appends
#     one line to heavy-order.log: UTC time, op, label, detail, caller, reason,
#     tab-separated. A file whose hash differs from the stored one was edited by
#     hand: that is said out loud and logged, and the write still goes ahead
#     from the current file.
#
# Exit codes: 0 ok, 2 refused (bad usage, a duplicate, a missing label or
# anchor), 3 the verify refused the write, 4 the lock was not had in time.
#
# Nothing here signals a process (Hard Rule 7). The caller is named by its
# parent's process NAME only (`ps -o comm=`), never a command line.

# 1-120 of A-Z a-z 0-9 space # + . _ : / ( ) @ -, starting with a letter, digit
# or #. No backslash, quote, tab or newline can reach awk or a log field.
ORDER_LABEL_RE='^[A-Za-z0-9#][A-Za-z0-9 #+._:/()@-]{0,119}$'

# order_valid <what> <value>: fail with the reason when value is not a label.
# Two spaces in a row are refused too: --label and --done collapse them, so a
# label stored with them could never be matched to leave the line.
order_valid() {
  local what=$1 v=$2 nl='
'
  case "$v" in
    *"$nl"* | *' ' | *'  '*) ;;
    *) [[ "$v" =~ $ORDER_LABEL_RE ]] && return 0 ;;
  esac
  echo "[heavy] REFUSE (label): $what '$(printf '%s' "$v" | tr '\n\t' '??')' is not allowed. Use 1-120 of A-Z a-z 0-9 space # + . _ : / ( ) @ -, starting with a letter, digit or #, not ending in a space, with no two spaces in a row." >&2
  return 2
}

order_trim() { printf '%s' "$1" | awk '{ gsub(/^[ \t]+|[ \t]+$/, ""); print }'; }

order_usage() {
  cat >&2 <<'USAGE'
usage: heavy-run-lock.sh --label <label> [--tests] <command...>
       heavy-run-lock.sh --list
       heavy-run-lock.sh --status
       heavy-run-lock.sh --insert <label> [--after <label> | --before <label> | --at <N> | --top]
                         (no position: release rows first, else where the label's DOR-id ranks)
       heavy-run-lock.sh --move <label> (--after <label> | --before <label> | --at <N> | --top)
       heavy-run-lock.sh --remove <label> --reason "<text>"
       heavy-run-lock.sh --done <label>
USAGE
}

# Line number of the first line equal to $1 in file $2 (passed by ENVIRON: no escapes).
order_pos() { L="$1" awk 'BEGIN { l = ENVIRON["L"] } $0 == l { print NR; exit }' "$2"; }

# The write lock, strictly: the run path's flock (order_flock), but a write
# that cannot have it in time refuses (exit 4) rather than going ahead
# unlocked. A writer that died let go of it when it died (DOR-5082).
order_lock_strict() {
  local wait="${DORKOS_HEAVY_ORDER_LOCK_WAIT:-30}"
  case $wait in '' | *[!0-9]*) wait=30 ;; esac
  order_flock "$wait"
  case $? in
    0) return 0 ;;
    1) echo "[heavy] order: lock busy for ${wait}s, nothing changed" >&2 ;;
    *) echo "[heavy] order: no lock, nothing changed" >&2 ;;
  esac
  return 4
}

# Test-only fault injection, honoured only in a folder under the temp dir: the
# verify step is otherwise unreachable, and a check nobody has watched refuse
# is not known to work.
order_test_corrupt() {
  local tmp dir last
  [ -n "${DORKOS_HEAVY_ORDER_TEST_CORRUPT:-}" ] || return 0
  tmp=$(cd -P "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)
  dir=$(cd -P "$ORDER_DIR" 2>/dev/null && pwd -P)
  # A temp folder that cannot be resolved must not widen the gate to every folder.
  [ -n "$tmp" ] && [ -n "$dir" ] || return 0
  case "$dir/" in
    "$tmp"/*) ;;
    *) return 0 ;;
  esac
  case "$DORKOS_HEAVY_ORDER_TEST_CORRUPT" in
    drop-first) awk 'NR > 1' "$1" >"$1.x" && mv -f -- "$1.x" "$1" ;;
    dup-last)
      last=$(tail -n 1 "$1")
      printf '%s\n' "$last" >>"$1"
      ;;
  esac
}

# order_write_locked <op> <label> <mode> <anchor> <reason>, the lock held.
#   op: insert | move | remove | done; mode: end | top | after | before | at.
order_write_locked() {
  local op=$1 label=$2 mode=$3 anchor=$4 reason=$5
  local old="$ORDER_FILE.old.$$" cand="$ORDER_FILE.tmp.$$" exp="$ORDER_FILE.exp.$$"
  local n lost extra detail pos rc=0 note=''
  order_external_check log
  if [ -f "$ORDER_FILE" ]; then
    awk '{ gsub(/^[ \t]+|[ \t]+$/, "") } NF' "$ORDER_FILE" >"$old" || return 2
  else
    : >"$old"
  fi
  n=$(awk 'END { print NR }' "$old")
  order_has() { L="$1" awk 'BEGIN { l = ENVIRON["L"] } $0 == l { f = 1; exit } END { exit !f }' "$old"; }
  case "$op" in
    insert)
      if order_has "$label"; then
        echo "[heavy] REFUSE (order): '$label' is already in the line (#$(order_pos "$label" "$old")); use --move" >&2
        rc=2
      fi
      ;;
    move | remove)
      order_has "$label" || { echo "[heavy] REFUSE (order): '$label' is not in the line" >&2; rc=2; }
      ;;
    done)
      if ! order_has "$label"; then
        order_log "done" "$label" "not-in-line (no change)" ""
        rm -f -- "$old"
        return 0
      fi
      ;;
  esac
  # DOR-5065: an --insert with no position goes where its ticket ranks
  # (scripts/lib/heavy-order-rank.sh), placed against the line as it is now.
  if [ "$rc" = 0 ] && [ "$mode" = rank ]; then
    order_rank_place "$label" "$old"
    # shellcheck disable=SC2154 # set by order_rank_place
    note=$r_note
    if [ -n "$r_at" ]; then
      mode='at'
      anchor=$r_at
    else
      mode=end
    fi
  fi
  if [ "$rc" = 0 ]; then
    case "$mode" in
      after | before)
        if [ "$anchor" = "$label" ]; then
          echo "[heavy] REFUSE (order): '$label' cannot be placed $mode itself" >&2
          rc=2
        elif ! order_has "$anchor"; then
          echo "[heavy] REFUSE (order): anchor '$anchor' is not in the line" >&2
          rc=2
        fi
        ;;
      at)
        local max=$((n + 1))
        [ "$op" = move ] && max=$n
        # The live script's form: a number too big for `[` errors, which refuses.
        { [ "$anchor" -ge 1 ] && [ "$anchor" -le "$max" ]; } 2>/dev/null || {
          echo "[heavy] REFUSE (order): --at $anchor is out of range (1..$max)" >&2
          rc=2
        }
        ;;
    esac
  fi
  if [ "$rc" != 0 ]; then
    rm -f -- "$old"
    return "$rc"
  fi
  # remove/done/move drop the FIRST matching line; insert/move then place the
  # label by mode. Positions for move count after the label is taken out.
  OP="$op" L="$label" MODE="$mode" A="$anchor" awk '
    BEGIN { op = ENVIRON["OP"]; l = ENVIRON["L"]; mode = ENVIRON["MODE"]; a = ENVIRON["A"] }
    { if (op != "insert" && !gone && $0 == l) { gone = 1; next } line[++k] = $0 }
    END {
      if (op == "remove" || op == "done") { for (i = 1; i <= k; i++) print line[i]; exit }
      placed = 0
      if (mode == "top" || (mode == "at" && a == 1)) { print l; placed = 1 }
      for (i = 1; i <= k; i++) {
        if (!placed && mode == "before" && line[i] == a) { print l; placed = 1 }
        print line[i]
        if (!placed && mode == "after" && line[i] == a) { print l; placed = 1 }
        if (!placed && mode == "at" && i == a - 1) { print l; placed = 1 }
      }
      if (!placed) print l
    }' "$old" >"$cand" || { rm -f -- "$old" "$cand"; return 2; }
  order_test_corrupt "$cand"
  # Expected multiset: old, minus the label once for remove/done/move, plus it
  # once for insert/move.
  OP="$op" L="$label" awk '
    BEGIN { op = ENVIRON["OP"]; l = ENVIRON["L"] }
    op != "insert" && !gone && $0 == l { gone = 1; next } { print }
    END { if (op == "insert" || op == "move") print l }' "$old" >"$exp"
  LC_ALL=C sort "$exp" >"$old.s"
  LC_ALL=C sort "$cand" >"$cand.s"
  if ! cmp -s "$old.s" "$cand.s"; then
    lost=$(LC_ALL=C comm -23 "$old.s" "$cand.s" | awk '{ printf "%s%s", (NR > 1 ? ", " : ""), "\x27" $0 "\x27" }')
    extra=$(LC_ALL=C comm -13 "$old.s" "$cand.s" | awk '{ printf "%s%s", (NR > 1 ? ", " : ""), "\x27" $0 "\x27" }')
    echo "[heavy] REFUSE (order verify): $op '$label' would change labels it should not. Nothing was written." >&2
    [ -n "$lost" ] && echo "[heavy]   would be LOST: $lost" >&2
    [ -n "$extra" ] && echo "[heavy]   would be ADDED/DUPLICATED: $extra" >&2
    order_log "verify-refused" "$label" "op=$op lost=${lost:-none} extra=${extra:-none}" "$reason"
    rm -f -- "$old" "$cand" "$exp" "$old.s" "$cand.s"
    return 3
  fi
  if ! mv -f -- "$cand" "$ORDER_FILE"; then
    echo "[heavy] order: could not replace heavy-order; nothing changed" >&2
    rm -f -- "$old" "$cand" "$exp" "$old.s" "$cand.s"
    return 2
  fi
  order_sum_store
  case "$mode" in after | before) detail="$mode '$anchor'" ;; at) detail="at $anchor" ;; *) detail=$mode ;; esac
  # Who chose the place: the work order, or a person (a --move, or an
  # --insert that named its position). A person's moves are what DOR-5065
  # counts in this log.
  if [ -n "$note" ]; then
    detail="by rank: $note"
  elif [ "$op" = move ] || { [ "$op" = insert ] && [ "$mode" != end ]; }; then
    detail="by hand: $detail"
  fi
  case "$op" in remove | done) detail="was #$(order_pos "$label" "$old")" ;; esac
  pos=$(order_pos "$label" "$ORDER_FILE")
  [ -n "$pos" ] && detail="$detail -> #$pos"
  order_log "$op" "$label" "$detail" "$reason"
  ORDER_PLACE_NOTE=$note
  rm -f -- "$old" "$exp" "$old.s" "$cand.s"
  return 0
}

# order_write <op> <label> <mode> <anchor> <reason>: the strict lock, then the write.
order_write() {
  local rc
  order_lock_strict || return 4
  # A Ctrl-C mid-write must not leave the lock, or half-built files, behind.
  trap 'order_unlock; rm -f -- "$ORDER_FILE".old.$$ "$ORDER_FILE".tmp.$$ "$ORDER_FILE".exp.$$ "$ORDER_FILE".old.$$.s "$ORDER_FILE".tmp.$$.s; exit 130' INT TERM
  order_write_locked "$@"
  rc=$?
  trap - INT TERM
  order_unlock
  return "$rc"
}

# The line, numbered, as the coordinator's script printed it, with each
# label's rank. With $1 = kept, the ranks are only the kept ones: no flow call
# and no wait (the listing printed after a write).
order_list() {
  order_external_check
  if [ ! -f "$ORDER_FILE" ] || ! awk 'NF { f = 1; exit } END { exit !f }' "$ORDER_FILE"; then
    echo "[heavy] order: (empty: no order)"
    return 0
  fi
  # The rank column (DOR-5065): one flow call for the whole line, and only
  # when some label names a ticket.
  local l n=0
  grep -qiE '(^|[^A-Za-z0-9])dor-[0-9]+' "$ORDER_FILE" && order_ranks_load "${1:-}"
  while IFS= read -r l; do
    n=$((n + 1))
    printf '%3d  %-10s  %s\n' "$n" "$(order_rank_column "$l")" "$l"
  done < <(order_lines)
  [ "${ORDER_RANKS_STATE:-}" = off ] && echo "[heavy] order: no ranks: $ORDER_RANKS_WHY"
  [ -n "${ORDER_RANKS_OLD:-}" ] && echo "[heavy] order: $ORDER_RANKS_OLD"
  return 0
}

# Parse a position from "$@": sets o_mode / o_anchor. $1 is required|optional.
order_parse_pos() {
  o_mode=$1
  o_anchor=''
  case "${2:-}" in
    '')
      [ "$1" = required ] && { echo "[heavy] usage: a position is required (--after/--before/--at/--top)" >&2; return 2; }
      o_mode=end
      return 0
      ;;
    --top)
      o_mode=top
      shift 2
      [ $# -eq 0 ] || { echo "[heavy] usage: unexpected '$1'" >&2; return 2; }
      return 0
      ;;
    --after | --before | --at)
      o_mode=${2#--}
      o_anchor=${3:-}
      [ -n "$o_anchor" ] || { echo "[heavy] usage: $2 needs a value" >&2; return 2; }
      if [ "$o_mode" = at ]; then
        case "$o_anchor" in *[!0-9]*) echo "[heavy] usage: --at needs a number" >&2; return 2 ;; esac
      else
        order_valid anchor "$o_anchor" || return 2
      fi
      shift 3
      [ $# -eq 0 ] || { echo "[heavy] usage: unexpected '$1'" >&2; return 2; }
      return 0
      ;;
    *)
      echo "[heavy] usage: unknown position '$2'" >&2
      return 2
      ;;
  esac
}

# --list, --insert, --move and --remove. Prints, and returns the exit code.
order_command() {
  local op label rc
  case "$1" in
    --list)
      order_list
      return 0
      ;;
  esac
  op=${1#--}
  label=${2:-}
  [ -n "$label" ] || { order_usage; return 2; }
  order_valid label "$label" || return 2
  shift 2
  if [ "$op" = remove ]; then
    if [ "${1:-}" != --reason ] || [ -z "$(order_trim "${2:-}")" ] || [ $# -ne 2 ]; then
      echo "[heavy] REFUSE (order): --remove needs --reason \"<why>\" (a finished job uses --done)" >&2
      order_usage
      return 2
    fi
    order_write remove "$label" end '' "$2"
    rc=$?
  else
    if [ "$op" = move ]; then
      order_parse_pos required "$@" || { order_usage; return 2; }
    else
      order_parse_pos optional "$@" || { order_usage; return 2; }
      # No position: the work order decides (DOR-5065). The ranks are fetched
      # here, before the lock, so a slow tracker holds no other writer up.
      if [ "$o_mode" = end ]; then
        o_mode=rank
        [ -n "$(order_ticket_of "$label")" ] && ! order_is_release "$label" && order_ranks_load
      fi
    fi
    order_write "$op" "$label" "$o_mode" "$o_anchor" ''
    rc=$?
  fi
  if [ "$rc" = 0 ]; then
    echo "[heavy] order: $op '$label' done${ORDER_PLACE_NOTE:+ (by rank: $ORDER_PLACE_NOTE)}"
    order_list kept
  fi
  return "$rc"
}

# --done <label>: leave the line, logged, under the strict lock. A label not in
# the line is a logged no-op (exit 0). A lock not had in time leaves the label
# in line, says so loudly, and exits 4.
order_done_command() {
  local label=$1 rc
  order_valid label "$label" || return 2
  order_lock_strict
  rc=$?
  if [ "$rc" = 4 ]; then
    echo "[heavy] ORDER POP FAILED: could not get the heavy-order lock (waited up to ${DORKOS_HEAVY_ORDER_LOCK_WAIT:-30}s), so '$label' is STILL IN LINE and will block the queue. Clear it with: heavy-run-lock.sh --done '$label'" >&2
    order_log "pop-refused-lock-timeout" "$label" "lock wait ${DORKOS_HEAVY_ORDER_LOCK_WAIT:-30}s; label left in line; clear with --done" ""
    return 4
  fi
  order_write_locked 'done' "$label" end '' ''
  rc=$?
  claim_drop "$label"
  order_rotate_stale
  order_unlock
  [ "$rc" = 0 ] && echo "[heavy] order: popped '$label'; next is '$(order_top)'"
  return "$rc"
}
