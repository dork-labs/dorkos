#!/usr/bin/env bash
# Remove the temp folders our test suites made and never cleaned up from the
# per-user temp folder ($TMPDIR, /var/folders/<xx>/<id>/T on macOS).
#
# Why this exists: on 2026-10-01 this Mac's $TMPDIR held about 46,000 top-level
# entries and grew by about 4,000 a day. Most were `mkdtemp` folders from
# vitest suites that never removed them (migration fixtures, boundary roots,
# error-report homes), and since every one of them is written, read and then
# left behind, about 60% of the machine's file-system events came from there.
# Fixing each leaking test is the real cure; this is the backstop for the ones
# not fixed yet and the ones a crashed or killed test run strands.
#
# What it removes, and the conditions that ALL have to hold:
#
#   shape     a top-level entry of $TMPDIR (never deeper) whose name is one of
#             the ALLOWLIST prefixes below, then `-`, then exactly six letters
#             or digits: the shape Node's `mkdtemp(prefix + '-')` makes. Any
#             other name is never looked at, however old. Symlinks are skipped.
#   age       nothing inside it, at any depth down to $MAX_DEPTH, and not the
#             entry itself, was modified within the age floor (default 24 h).
#             A folder some part of which we cannot read is kept.
#   unused    no process on the machine has a file open under it, or its
#             working directory in it, according to one `lsof` taken right
#             before removal. If `lsof` is missing or fails, nothing is removed.
#
# Never removed, by construction: anything outside $TMPDIR (the root is checked
# before anything runs, every candidate is `$TMPDIR/<one name>` with no slash in
# the name, `find` never follows symlinks and `rm -rf` removes a symlink, never
# what it points to), and anything not on the allowlist: system and app folders
# such as com.apple.*, TemporaryItems or node-compile-cache are not on it.
#
# Exit status: 0 when the sweep ran (also when nothing matched). 1 when a step
# failed: lsof could not be read, a listing failed, or a removal failed. 2 on
# bad usage, when not run by bash, or when $TMPDIR is unset or is not the
# per-user temp folder.
#
# Usage:
#   sweep-test-tmp.sh [--dry-run] [--min-age-hours N] [--prefix-file FILE]
#
#   --dry-run          print what would be removed; remove nothing
#   --min-age-hours N  age floor (default 24, or $DORKOS_TMP_SWEEP_MIN_AGE_HOURS)
#   --prefix-file FILE extra prefixes, one per line (`#` comments and blank lines
#                      ignored), for test suites that live outside this repo.
#                      Each must be 3 or more of [A-Za-z0-9._-] and is matched
#                      literally, with the same `-XXXXXX` suffix rule.
#
# The root check: $TMPDIR must resolve (symlinks followed) to exactly
# /private/var/folders/<a>/<b>/T, a directory the current user owns. That is
# what macOS hands every user; anything else (unset, /, /tmp, a home folder,
# a subfolder of T) is refused. The one exception is the fixture suite: with
# DORKOS_TMP_SWEEP_FIXTURE_ROOT=1 a root that contains a file named
# .dorkos-tmp-sweep-fixture is accepted too, so the tests can run on Linux CI
# against a fake folder. A real temp folder never holds that file.
#
# Scheduling: the LaunchAgent template at
# scripts/launchd/ai.dorkos.docker-orphan-sweep.plist.example runs this sweep
# first and the Docker orphan sweep second, every six hours, so a sleeping
# Docker never stops the temp sweep. launchd does not always set $TMPDIR, so the
# template fills it from `getconf DARWIN_USER_TEMP_DIR` when it is missing.
#
# Written for the bash 3.2 that ships as /bin/bash on macOS (no associative
# arrays, no mapfile), because that is the shell launchd runs it with.
#
# Tested by scripts/test-sweep-test-tmp.sh (a fake root, a stub lsof).

# Bash only, and not bash pretending to be sh (macOS's /bin/sh is bash in POSIX
# mode, which accepts this file and then differs in small ways nobody tested).
case ":${SHELLOPTS:-}:" in *:posix:*) posix=1 ;; *) posix=0 ;; esac
if [ -z "${BASH_VERSION:-}" ] || [ "$posix" = 1 ]; then
  echo "sweep-test-tmp.sh: run it with bash (e.g. /bin/bash $0)" >&2
  exit 2
fi
set -euo pipefail
export LC_ALL=C

# Prefixes this repo's own test suites pass to mkdtemp, each verified against
# the call that makes it. Bash ERE fragments, anchored and suffixed below, so
# keep them narrow: a prefix here is a promise that every folder of that shape
# in $TMPDIR is a test's leftover. Add one only with the test that makes it.
ALLOWLIST=(
  # packages/db migration tests: a copy of the migrations folder per test.
  'dorkos-0[0-9]{3}'
  'dorkos-before-[0-9]{1,4}'
  # apps/server marketplace-mcp tool tests: a directory-boundary root per test.
  'mcp-install-boundary'
  'mcp-uninstall-boundary'
  'mcp-uninstall-notify'
  'mcp-integration-staged'
  'tool-install-staged'
  'approval-flow-staged'
  'tier-act-staged'
  # apps/server config, error-report, route and service tests.
  'dorkos-pre-579'
  'dorkos-post-579'
  'dorkos-invalid-579'
  'srv-err'
  'route-err'
  'term-route'
  'term-test'
  'term-ws'
  'dorkos-adapters'
  'dorkos-persist'
  'agent-defaults'
  'dorkos-otel'
  'dorkos-ai-obs'
  'dorkos-move-route-test'
  'dorkos-move-staging-test'
  'dorkos-move-parts-test'
  'dork-probe-route'
  'dorkos-mcp-tool-server'
  'dorkos-recording'
  'dorkos-raw-auth'
  'dork-ext-approval'
  'dorkos-plugin-ext-approval'
  'dorkos-orphan'
  'dorkos-root'
  'dorkos-config-reconcile'
  'dorkos-route-room'
  'skills-watcher-home'
  'skills-watcher-repo'
  'status-hydration'
  'dork-app-actions'
  'task-watcher'
  # packages/*: cli, mesh, relay, harness.
  'cli-err'
  'doctor-file'
  'mesh-denial-test'
  'relay-sqlite-test'
  'harness-gitignore-home'
  'harness-gitignore-repo'
  'harness-claudeonly'
  # apps/community integration tests.
  'erasure-journal'
  'erasure-backup'
  'community-admin-blobs'
  # scripts/ and .claude/scripts/ tests.
  'check-any'
  'check-any-bare'
  'docs-coverage-map'
  'origin-janitor'
  'community-release-assets'
  'smoke-e2e-[a-z0-9-]{1,40}'
)

DRY_RUN=0
MIN_AGE_HOURS="${DORKOS_TMP_SWEEP_MIN_AGE_HOURS:-24}"
PREFIX_FILE=""
# How deep the age check looks. Test leftovers are a few levels deep; a cap
# keeps one pathological tree from making the sweep crawl.
MAX_DEPTH=8

usage() {
  echo "usage: $0 [--dry-run] [--min-age-hours N] [--prefix-file FILE]" >&2
}

errors=0
note_error() {
  echo "error: $*" >&2
  errors=$((errors + 1))
}

human_kb() {
  awk -v k="$1" 'BEGIN {
    b = k * 1024; split("B kB MB GB TB", u, " "); i = 1
    while (b >= 1000 && i < 5) { b /= 1000; i++ }
    if (i == 1) printf "%dB\n", b; else printf "%.2f%s\n", b, u[i]
  }'
}

# The physical path of the temp root, or a refusal. Exit 2 from main on refusal.
resolve_root() {
  local raw="${TMPDIR:-}" phys
  if [[ -z "$raw" ]]; then
    echo "$0: TMPDIR is not set; refusing to sweep" >&2
    return 1
  fi
  if ! phys="$(cd -P -- "$raw" 2>/dev/null && pwd -P)"; then
    echo "$0: TMPDIR ($raw) is not a directory; refusing to sweep" >&2
    return 1
  fi
  if [[ "${DORKOS_TMP_SWEEP_FIXTURE_ROOT:-}" == 1 && -f "$phys/.dorkos-tmp-sweep-fixture" ]]; then
    echo "$phys"
    return 0
  fi
  if ! [[ "$phys" =~ ^/private/var/folders/[A-Za-z0-9_+-]+/[A-Za-z0-9_+-]+/T$ ]]; then
    echo "$0: TMPDIR ($raw -> $phys) is not the per-user temp folder under /var/folders; refusing to sweep" >&2
    return 1
  fi
  if [[ ! -O "$phys" ]]; then
    echo "$0: $phys is not owned by $(id -un); refusing to sweep" >&2
    return 1
  fi
  echo "$phys"
}

# One ERE alternation of every allowed prefix: the built-in list plus the
# literal ones from --prefix-file (dots escaped).
build_pattern() {
  local alt="" p line
  for p in "${ALLOWLIST[@]}"; do alt="${alt:+$alt|}$p"; done
  if [[ -n "$PREFIX_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%%#*}"
      line="$(printf '%s' "$line" | tr -d '[:space:]')"
      [[ -z "$line" ]] && continue
      if ! [[ "$line" =~ ^[A-Za-z0-9._-]{3,}$ ]]; then
        echo "$0: bad prefix in $PREFIX_FILE: '$line' (3 or more of A-Z a-z 0-9 . _ -)" >&2
        return 1
      fi
      alt="$alt|${line//./\\.}"
    done <"$PREFIX_FILE"
  fi
  echo "^($alt)-[A-Za-z0-9]{6}$"
}

# Top-level names under $1 (one per line) that are on the list $2 names, read
# from stdin: every path under the root maps to its first component.
top_level_names() {
  local root="$1"
  awk -v r="$root/" 'index($0, r) == 1 { s = substr($0, length(r) + 1); sub(/\/.*/, "", s); if (s != "") print s }' | sort -u
}

main() {
  while (($# > 0)); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --min-age-hours)
        [[ $# -ge 2 ]] || { usage; return 2; }
        MIN_AGE_HOURS="$2"
        shift
        ;;
      --prefix-file)
        [[ $# -ge 2 ]] || { usage; return 2; }
        PREFIX_FILE="$2"
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage
        return 2
        ;;
    esac
    shift
  done
  # No leading zeros (octal) and a bounded size (overflow): both would shrink
  # the floor, which is the deleting direction.
  if ! [[ "$MIN_AGE_HOURS" =~ ^(0|[1-9][0-9]{0,5})$ ]]; then
    echo "$0: --min-age-hours takes a whole number of hours, 0 to 999999, with no leading zeros" >&2
    return 2
  fi
  if [[ -n "$PREFIX_FILE" && ! -r "$PREFIX_FILE" ]]; then
    echo "$0: cannot read --prefix-file $PREFIX_FILE" >&2
    return 2
  fi

  local root pattern
  root="$(resolve_root)" || return 2
  pattern="$(build_pattern)" || return 2

  local work
  work="$(mktemp -d "${root}/dorkos-tmp-sweep.XXXXXXXX")" || {
    echo "error: could not make a work folder" >&2
    return 1
  }
  # shellcheck disable=SC2064 # expand now: $work is fixed for this run
  trap "rm -rf -- '$work'" EXIT

  local mode=""
  if ((DRY_RUN)); then mode="(dry run) "; fi
  echo "test tmp sweep ${mode}at $(date -u +%Y-%m-%dT%H:%M:%SZ) in $root"

  # 1. Every top-level directory or regular file (never a symlink), by name.
  if ! find "$root" -mindepth 1 -maxdepth 1 \( -type d -o -type f \) -print >"$work/all" 2>"$work/find.err"; then
    note_error "could not list $root: $(head -3 "$work/find.err")"
    return 1
  fi
  local total
  total="$(wc -l <"$work/all" | tr -d ' ')"
  top_level_names "$root" <"$work/all" >"$work/names"
  # grep -E exits 1 on no match and 2 on a real error; only 2 is a failure.
  local rc=0
  grep -E -- "$pattern" "$work/names" >"$work/candidates" || rc=$?
  if ((rc > 1)); then
    note_error "could not match names against the allowlist"
    return 1
  fi
  local candidates
  candidates="$(wc -l <"$work/candidates" | tr -d ' ')"

  # 2. Young: anything under a candidate (or the candidate itself) modified
  #    within the floor. One find over all candidates, never following links.
  #    A path find could not read keeps its whole entry.
  local minutes=$((MIN_AGE_HOURS * 60))
  : >"$work/young.paths"
  : >"$work/unreadable.paths"
  if [[ -s "$work/candidates" ]]; then
    rc=0
    # xargs appends its arguments last, and find wants its paths first, so the
    # paths go through a tiny bash that puts them in front of the expression.
    sed "s|^|$root/|" "$work/candidates" | tr '\n' '\0' |
      xargs -0 /bin/bash -c 'find -P "$@" -maxdepth '"$MAX_DEPTH"' -mmin -'"$minutes"' -print' find \
        >"$work/young.paths" 2>"$work/age.err" || rc=$?
    if ((rc != 0)) || [[ -s "$work/age.err" ]]; then
      # Every complaint must name a path under the root, so we know which entry
      # to keep. Anything else and we cannot tell what is safe: remove nothing.
      # BSD find writes `find: /p: reason`, GNU find `find: '/p': reason`.
      sed -n -E "s|^find: '?(/[^']*)'?: [^:]*$|\\1|p" "$work/age.err" >"$work/unreadable.paths"
      if [[ "$(wc -l <"$work/unreadable.paths")" -ne "$(wc -l <"$work/age.err")" ]] ||
        awk -v r="$root/" 'index($0, r) != 1 { bad = 1 } END { exit !bad }' "$work/unreadable.paths"; then
        note_error "the age check failed in a way we cannot attribute; removed nothing: $(head -3 "$work/age.err")"
        return 1
      fi
    fi
  fi
  top_level_names "$root" <"$work/young.paths" >"$work/young"
  top_level_names "$root" <"$work/unreadable.paths" >"$work/unreadable"

  # 3. In use: one lsof for the whole machine, taken after the age check so it
  #    is as close to removal as it can be. Names (n) and working directories
  #    are both reported as n-lines in field output.
  if ! command -v lsof >/dev/null 2>&1; then
    note_error "lsof is not installed, so we cannot tell what is in use; removed nothing"
    return 1
  fi
  rc=0
  lsof -n -P -w -F n >"$work/lsof" 2>/dev/null || rc=$?
  # lsof exits 1 for many soft reasons (a process that exited mid-scan) while
  # still printing everything else. Empty output is the failure we cannot use.
  if ((rc > 1)) || ! grep -q '^n' "$work/lsof"; then
    note_error "lsof did not answer (exit $rc); removed nothing"
    return 1
  fi
  # lsof reports physical paths; the root is physical too. Also accept the
  # /var spelling in case a process opened it that way.
  sed -n 's/^n//p' "$work/lsof" | sed "s|^/var/folders/|/private/var/folders/|" |
    top_level_names "$root" >"$work/inuse"

  # 4. The removable set: candidates that are neither young, unreadable nor in use.
  sort -u "$work/young" "$work/unreadable" "$work/inuse" >"$work/keep"
  comm -23 "$work/candidates" "$work/keep" >"$work/remove"
  local n_young n_unread n_inuse n_remove
  n_young="$(comm -12 "$work/candidates" "$work/young" | wc -l | tr -d ' ')"
  n_unread="$(comm -12 "$work/candidates" "$work/unreadable" | wc -l | tr -d ' ')"
  n_inuse="$(comm -12 "$work/candidates" "$work/inuse" | wc -l | tr -d ' ')"
  n_remove="$(wc -l <"$work/remove" | tr -d ' ')"

  # 5. Sizes (for the log), then remove one by one.
  : >"$work/sizes"
  if [[ -s "$work/remove" ]]; then
    sed "s|^|$root/|" "$work/remove" | tr '\n' '\0' |
      xargs -0 du -P -sk 2>/dev/null >"$work/sizes" || true
  fi
  local removed=0 name out
  : >"$work/removed"
  while IFS= read -r name; do
    # Belt and braces: one path component, no traversal, not a symlink.
    [[ -n "$name" && "$name" != */* && "$name" != . && "$name" != .. ]] || continue
    [[ -L "$root/$name" ]] && continue
    if ((DRY_RUN)); then
      echo "$name" >>"$work/removed"
      removed=$((removed + 1))
      continue
    fi
    if ! out="$(rm -rf -- "${root:?}/$name" 2>&1)"; then
      note_error "could not remove $root/$name: $out"
      continue
    fi
    echo "$name" >>"$work/removed"
    removed=$((removed + 1))
  done <"$work/remove"

  # 6. The log: one line per prefix, then the totals.
  local verb=removed
  if ((DRY_RUN)); then verb="would remove"; fi
  # du prints `<kb><tab><path>`; every removed name ends in `-XXXXXX`, so the
  # prefix is the name minus its last seven characters.
  local by_prefix freed_kb
  by_prefix="$(awk -F '\t' -v r="$root/" '
    FNR == NR { if (index($2, r) == 1) kb[substr($2, length(r) + 1)] = $1; next }
    { p = substr($0, 1, length($0) - 7); c[p]++; s[p] += kb[$0]; t += kb[$0] }
    END { for (p in c) printf "%d\t%d\t%s\n", c[p], s[p], p; printf "TOTAL\t%d\n", t }
  ' "$work/sizes" "$work/removed")"
  freed_kb="$(awk -F '\t' '$1 == "TOTAL" { print $2 }' <<<"$by_prefix")"
  awk -F '\t' '$1 != "TOTAL"' <<<"$by_prefix" | sort -t "$(printf '\t')" -k1,1nr |
    while IFS="$(printf '\t')" read -r count kb prefix; do
      [[ -n "$prefix" ]] || continue
      echo "  $verb $count $prefix-* ($(human_kb "$kb"))"
    done
  echo "test tmp: $verb $removed of $candidates allowlisted entries ($(human_kb "${freed_kb:-0}")); kept $n_young younger than ${MIN_AGE_HOURS}h, $n_inuse in use, $n_unread unreadable; $total top-level entries before"
  if ((n_remove != removed)) && ((errors == 0)); then
    echo "note: $((n_remove - removed)) entries were skipped as symlinks or odd names"
  fi

  if ((errors > 0)); then
    echo "test tmp sweep: finished with $errors error(s)" >&2
    return 1
  fi
}

main "$@"
