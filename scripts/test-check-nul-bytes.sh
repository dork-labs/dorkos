#!/usr/bin/env bash
# Fixture suite for scripts/check-nul-bytes.sh, the DOR-1561 raw-NUL-byte guard.
#
# It exists because a guard nobody has watched fail is not known to work
# (DOR-1450 shipped the fix with no guard at all, and the same mistake — a
# composite-key separator pasted as a raw NUL byte instead of typed as the
# `\u0000` escape — happened again across five more files before DOR-1561 caught
# it). The interesting question is not "does it find a raw NUL" but "does it
# find one ONLY where it is the separator mistake, and stay quiet on genuine
# binary assets and on content that is deliberately under test".
#
# Every case builds a throwaway git repository under a temp dir and points the
# guard at it with ROOT, so the suite never depends on this checkout's real
# content — it keeps passing after someone edits real source, and it fails
# for the one reason it should: the guard stopped behaving. A real git repo is
# required (not just a directory of files, unlike check-banned-words.sh's
# fixtures) because the guard's file list comes from `git ls-files`.
#
#   bash scripts/test-check-nul-bytes.sh
#   CHECK=/path/to/other.sh bash scripts/test-check-nul-bytes.sh
#
# CHECK exists so a candidate rewrite can be run against the same fixtures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/check-nul-bytes.sh}"

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

pass=0
fail=0

# Build a throwaway git repo, write one file with raw-byte content (fed
# through python so the NUL byte lands literally, which no shell quoting
# mechanism does reliably), commit it, run the guard, assert on the exit code
# and, optionally, on how many lines it reported.
#   $1 human-readable case name
#   $2 expected exit code (0 green, 1 red)
#   $3 relative file path to create
#   $4 python byte-string literal for the file's exact bytes
#   $5 optional: a fixed-string pattern to count occurrences of in the
#      guard's output (e.g. 'src/two.ts:' to count reported hit lines).
#      A pure exit-code check cannot tell "found every occurrence" from
#      "found one and stopped" — a mutant that reports only the first hit per
#      file still exits 1 on a file with two. Omit to skip this assertion.
#   $6 required if $5 is given: the expected count.
run_case() {
  local name="$1" want="$2" path="$3" byte_literal="$4"
  local count_pattern="${5:-}" want_count="${6:-}"
  local tmp
  tmp=$(mktemp -d)
  (
    cd "$tmp" || exit 1
    git init -q -b main .
    mkdir -p "$(dirname "$path")"
    python3 -c "
import sys
open(sys.argv[1], 'wb').write($byte_literal)
" "$path"
    git add -A
    git commit -qm seed
  )

  local out got
  out=$(ROOT="$tmp" bash "$CHECK" 2>&1)
  got=$?

  local ok=1
  if [ "$got" -ne "$want" ]; then
    ok=0
  fi

  local got_count=""
  if [ -n "$count_pattern" ]; then
    got_count=$(printf '%s\n' "$out" | grep -cF -- "$count_pattern")
    [ "$got_count" -eq "$want_count" ] || ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    pass=$((pass + 1))
    if [ -n "$count_pattern" ]; then
      printf 'ok   %s (exit %s, %s occurrence(s) of %q)\n' "$name" "$got" "$got_count" "$count_pattern"
    else
      printf 'ok   %s (exit %s)\n' "$name" "$got"
    fi
  else
    fail=$((fail + 1))
    if [ -n "$count_pattern" ]; then
      printf 'FAIL %s — wanted exit %s and %s occurrence(s) of %q, got exit %s and %s\n%s\n' \
        "$name" "$want" "$want_count" "$count_pattern" "$got" "${got_count:-0}" "$out"
    else
      printf 'FAIL %s — wanted exit %s, got %s\n%s\n' "$name" "$want" "$got" "$out"
    fi
  fi
  rm -rf "$tmp"
}

echo "== the guard must go RED on a raw NUL byte in a text file =="

# The regression this whole gate exists to prevent: a composite-key separator
# pasted as a literal byte instead of typed as \u0000 — the exact shape of
# every one of the nine DOR-1561 occurrences.
run_case 'a raw NUL separator in a .ts file' 1 'src/keys.ts' \
  "b\"function key(a, b) { return \`\${a}\x00\${b}\`; }\n\""

# Not just .ts — the same mistake reached a markdown spec's example code too.
run_case 'a raw NUL byte in a .md file' 1 'specs/x.md' \
  "b\"the separator is \`\x00\`\n\""

# A file can hold more than one occurrence; both must be reported, not just
# the first (this is what actually happened in jsonl-frontier.ts and
# presence.ts). Exit-code alone cannot tell "reported both" from "reported
# one and stopped", so this pins the hit COUNT too.
run_case 'two raw NUL bytes in one file are both reported' 1 'src/two.ts' \
  "b\"// \`\x00\` is the separator\nconst k = a + '\x00' + b;\n\"" \
  'src/two.ts:' 2

# The marker is PER LINE, not per file — a mutant that exempts the whole file
# the moment any line carries the marker would pass every other case here
# (none of them mixes a marked and an unmarked line) and miss a real
# separator mistake sitting right beside a legitimate exemption. One marked
# line and one unmarked line in the same file must still exit 1, reporting
# only the unmarked one.
run_case 'a marked line does not exempt an unmarked line in the same file' 1 'src/mixed.test.ts' \
  "b\"const NUL = '\x00'; // nul-byte-allow: asserts how a literal NUL renders\nconst key = a + '\x00' + b;\n\"" \
  'src/mixed.test.ts:' 1

echo ""
echo "== the guard must stay GREEN on everything it should not flag =="

# The actual fix: the exact same runtime value, spelled as an escape.
run_case 'the \\u0000 escape passes' 0 'src/keys.ts' \
  "b\"function key(a, b) { return \`\${a}\\\\u0000\${b}\`; }\n\""

# A genuine binary asset legitimately contains NUL bytes as part of its
# format. The guard must never flag one — that would make the gate
# untrustworthy the first time someone adds an icon.
run_case 'a PNG with real NUL bytes in its format is not scanned' 0 'assets/logo.png' \
  "b'\\x89PNG\\r\\n\\x1a\\n\\x00\\x00\\x00\\rIHDR\\x00\\x00\\x00\\x01'"

# The escape hatch: content genuinely under test, not a separator mistake,
# marked with the same convention check-banned-words.sh uses (an inline
# marker plus a reason on the same line).
run_case 'a marked line is allowed' 0 'src/fixture.test.ts' \
  "b\"const NUL = '\x00'; // nul-byte-allow: asserts how a literal NUL renders\n\""

# The point of the whole design: clean source with no raw bytes at all.
run_case 'clean source passes' 0 'src/clean.ts' \
  "b\"export function add(a: number, b: number): number {\n  return a + b;\n}\n\""

echo ""
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
