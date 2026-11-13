#!/usr/bin/env bash
# No script or workflow here may pipe into `grep -q`.
#
# WHY. Most of these scripts, and every workflow step that names `shell: bash`
# or sets it itself, run under `set -o pipefail`, and `grep -q` exits at its
# first match. If the writer on the left is still writing, it dies of SIGPIPE,
# and pipefail reports the WHOLE PIPELINE as failed — on the very input that
# matched. Bash writes `printf '%s' "$output"` a line at a time, so a match on
# an early line is enough. On a loaded two-core runner
# `printf '%s' "$out" | grep -qF x` reported a miss 76 times in 5,000 with x
# plainly in $out, and the here-string form 0 times (dorkos-cloud #463,
# 2026-11-13).
#
# IT FAILS OPEN AS OFTEN AS IT FAILS CLOSED. Under `if ! … | grep -q`, or an
# `if` whose then-branch is the refusal, a SIGPIPE turns "found" into "not
# found": the "the refusal never echoes the tag" tests in
# test-release-version.sh, test-wait-for-npm.sh and test-npm-tarball-sha256.sh
# could pass with the echo right there in their input.
#
# THE TWO SAFE SHAPES:
#   grep <<<"$output" -qF -- "$expected"      no pipe, so no writer to kill
#   cmd | grep -F -- "$expected" >/dev/null   grep reads to EOF, so no early exit
#
#   bash scripts/test-no-early-exit-grep.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# A pipe (not the `||` of an or-list) into a grep whose options include -q.
# `-[A-Za-z]*q` catches -q, -qF, -qiE, -Fq; `--quiet` and `--silent` are the
# long spellings of the same flag. Comment lines are dropped separately below.
pattern='(^|[^|])\|[[:space:]]*grep([[:space:]]+-[A-Za-z]+)*[[:space:]]+(-[A-Za-z]*q|--quiet|--silent)'
comment='^[^:]+:[0-9]+:[[:space:]]*#'

# Every shell script and workflow this repo runs, but this file, whose own
# fixtures below are the bad spellings.
self=$repo_root/scripts/$(basename "${BASH_SOURCE[0]}")
files=()
for file in "$repo_root"/scripts/*.sh "$repo_root"/.claude/hooks/*.sh \
  "$repo_root"/.claude/scripts/*.sh "$repo_root"/.agents/skills/*/scripts/*.sh \
  "$repo_root"/.github/workflows/*.yml; do
  [ -f "$file" ] && [ "$file" != "$self" ] && files+=("$file")
done
# A file list this short would mean a moved directory, and an empty scan
# passes by vacuum.
if [ "${#files[@]}" -lt 50 ]; then
  printf 'FAIL  only %s files to scan; the globs above no longer match this repo\n' "${#files[@]}" >&2
  exit 1
fi
found=$(LC_ALL=C grep -nE -- "$pattern" "${files[@]}" 2>/dev/null | LC_ALL=C grep -vE -- "$comment")
if [ -n "$found" ]; then
  printf 'FAIL  a pipe into grep -q, which pipefail turns into a coin toss:\n' >&2
  printf '%s\n' "$found" | sed "s|^$repo_root/||; s|^|        |" >&2
  printf '        Use  grep <<<"$x" -q …  or  cmd | grep … >/dev/null  (see this file'"'"'s header).\n' >&2
  exit 1
fi

# THE DETECTOR MUST BE ABLE TO FAIL. Four spellings it has to catch, and the
# safe shapes it has to leave alone.
fail=0
check() {
  LC_ALL=C grep -E -- "$pattern" <<<"x:1:$1" | LC_ALL=C grep -vE -- "$comment" >/dev/null
}
for bad in \
  "printf '%s' \"\$out\" | grep -qF x" \
  "if ! cmd | grep -iq x; then" \
  "node g.js 2>&1 | grep --quiet x" \
  "  | grep -qx 're-review'; then"; do
  if ! check "$bad"; then
    printf 'FAIL  the detector missed: %s\n' "$bad" >&2
    fail=1
  fi
done
for good in \
  "grep <<<\"\$out\" -qF -- x" \
  "cmd | grep -F -- x >/dev/null" \
  "jq -e . f >/dev/null || grep -q x err.txt" \
  "  # a comment about printf | grep -q"; do
  if check "$good"; then
    printf 'FAIL  the detector flagged a safe shape: %s\n' "$good" >&2
    fail=1
  fi
done
[ "$fail" -eq 0 ] || exit 1

printf 'no-early-exit-grep: no pipe into grep -q in %s scripts and workflows\n' "${#files[@]}"
