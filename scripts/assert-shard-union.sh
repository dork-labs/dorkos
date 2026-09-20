#!/usr/bin/env bash
# Prove that a sharded `turbo test` sweep collected test files from EVERY
# package — i.e. that the union of the shards is not quietly missing a suite.
#
# WHY THIS EXISTS. The merge-queue test sweep runs vitest with `--shard=N/4
# --passWithNoTests`. The flag is necessary (a package with three test files
# legitimately contributes zero files to one of four shards) but it removes
# vitest's own zero-files safety net: before sharding, a package whose include
# glob broke — or whose __tests__ directory was emptied by a bad refactor —
# exited 1 loudly ("No test files found"). With the flag, that package passes
# all four shards with zero tests executed, and assert-tests-executed.sh cannot
# see it either: it counts turbo TASKS, not test files, and the task "ran".
#
# So the safety net moves here, one level up: every shard records the test
# files vitest actually collected (json reporter), and the fan-in asserts that
# ACROSS THE UNION of all shards, every workspace package that declares a
# `test` script contributed at least one collected test file. That is the same
# strength as the pre-sharding net (per-package "zero matched files fails
# loudly"), restored at the only level that can tell "empty because sharded"
# from "empty because broken".
#
# This is deliberately the same shape as the browser-test workflow's union
# check (assert-browser-tests-executed.sh), which exists for the same reason
# one runner over: a partitioned run is only as honest as the proof that the
# partitions add back up.
#
# QUARANTINE (plan §4.9 L1). `--quarantined <file>` names the tests the CI
# Steward quarantine lane is absorbing, one `<file> › <title>` per line, as
# `ci-steward quarantine-list --runner vitest --lines` writes them. The lines
# carry no runner, so the filter belongs on that command: a Playwright entry
# reaching this file names a path relative to apps/e2e/tests, which is not a
# repo-relative test file and is skipped below rather than mistaken for one.
#
# Quarantine here is per TEST, decided by a gate that reads the reports, so it
# never excludes a file from the run: no `exclude`, no `testIgnore`, nothing
# removed from what vitest collects. The union is therefore exactly the union it
# would be with an empty lane, and this script's own assertion is unchanged.
#
# What the flag adds is the interlock: every quarantined vitest test's FILE must
# still appear in the union. If it does not, the file stopped being collected
# while a lane entry claimed to be watching it — which is precisely the "counts
# must account for quarantined tests explicitly, not silently lose them" rule,
# checked where the whole union is visible. Playwright entries in the list are
# ignored here; browser coverage is assert-browser-tests-executed.sh's.
#
# Usage:
#   scripts/assert-shard-union.sh [--quarantined <file>] <dir-of-shard-lists>
#
# <dir-of-shard-lists> holds one or more *.txt files, one collected test-file
# path per line, repo-relative (e.g. apps/server/src/__tests__/foo.test.ts).
# The workflow builds these from each shard's vitest json reports.
#
# WORKSPACE_ROOT overrides where the workspace manifests are looked up, so the
# fixture suite (scripts/test-assert-shard-union.sh) can drive this against
# synthetic workspaces in a temp dir. The apps/* and packages/* globs are
# hard-coded for the same bash+jq-only reason assert-tests-executed.sh gives:
# a third workspace glob added later leaves its packages uncounted here, and
# the count check in assert-tests-executed.sh fails loudly first.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace_root=${WORKSPACE_ROOT:-$repo_root}

fail() {
  printf 'assert-shard-union: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail 'jq is required but was not found on PATH.'

quarantined_file=''
while [ $# -gt 0 ]; do
  case "$1" in
  --quarantined)
    quarantined_file=${2:-}
    [ -n "$quarantined_file" ] || fail '--quarantined needs a file.'
    [ -f "$quarantined_file" ] || fail "no quarantine list at $quarantined_file.
The workflow writes it with \`ci-steward quarantine-list --lines\`, which always
succeeds and writes an empty file when nothing is quarantined. A MISSING file
means that step did not run, and this gate will not guess which it was."
    shift 2
    ;;
  --*) fail "unknown option: $1" ;;
  *) break ;;
  esac
done

lists_dir=${1:-}
[ -n "$lists_dir" ] || fail 'usage: assert-shard-union.sh [--quarantined <file>] <dir-of-shard-lists>'
[ -d "$lists_dir" ] || fail "shard-list directory not found: $lists_dir"

# The union lives in a FILE, and each package's membership test greps that
# file directly. The obvious pipe — printf "$union" | grep -q — is a bug under
# this script's own `set -o pipefail`: grep -q exits at the first match, printf
# takes SIGPIPE if it is still writing, and the pipeline reports failure for
# precisely the packages that DID match early. On the first live run that
# marked every apps/* package missing (they sort first in a ~600-line union)
# while every packages/* package passed (printf had drained by then). The
# fixture suite pins this with a union large enough to overflow a pipe buffer.
union_file=$(mktemp -t shard-union.XXXXXX)
trap 'rm -f "$union_file"' EXIT
cat "$lists_dir"/*.txt 2>/dev/null | sort -u > "$union_file"
[ -s "$union_file" ] || fail "no shard lists (or only empty ones) under $lists_dir.
Every shard uploads a shard-files-*.txt naming the test files vitest collected;
an empty union means no shard collected anything, which is not a passing sweep."

checked=0
missing=''
while IFS= read -r manifest; do
  if [ "$(jq -r 'if .scripts.test == null then "no" else "yes" end' "$manifest" 2>/dev/null)" = 'yes' ]; then
    checked=$((checked + 1))
    pkg_dir=$(dirname "$manifest")
    pkg_rel=${pkg_dir#"$workspace_root"/}
    if ! grep -q -- "^$pkg_rel/" "$union_file"; then
      missing="$missing  $pkg_rel"$'\n'
    fi
  fi
done < <(find "$workspace_root/apps" "$workspace_root/packages" \
  -mindepth 2 -maxdepth 2 -name package.json 2>/dev/null)

[ "$checked" -gt 0 ] || fail "found no workspace package declaring a \`test\` script under
$workspace_root/{apps,packages}. That is either the wrong root or a broken
checkout — either way this run proved nothing."

if [ -n "$missing" ]; then
  fail "these packages declare a \`test\` script but contributed ZERO collected test
files across every shard:
$missing
Under --passWithNoTests each shard reports green for such a package, so this
union check is the only thing that can see it. Check the package's vitest
include globs, whether its __tests__ files still exist, and whether the shard
collect step is reading its report."
fi

# A quarantined test's file must still be collected. Quarantine is per test and
# removes nothing from the run, so a file that vanished from the union did so
# for some other reason — and a lane entry watching a file nothing collects is
# a blind spot wearing a watchdog's collar.
quarantined_files=0
quarantined_skipped=0
if [ -n "$quarantined_file" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    file=${line%% › *}
    # Only a repo-relative workspace path is a vitest test file this check can
    # recognise. Anything else is counted and PRINTED rather than dropped in
    # silence: a line nothing here matches is a quarantine entry nothing here
    # watches, and the difference between "checked" and "skipped" is the whole
    # value of this line. `quarantine add` refuses such an entry for a vitest
    # quarantine; a Playwright entry reaching this file is the expected case,
    # and it is the browser gate's business.
    case "$file" in
    apps/*/*|packages/*/*) ;;
    *)
      quarantined_skipped=$((quarantined_skipped + 1))
      continue
      ;;
    esac
    quarantined_files=$((quarantined_files + 1))
    grep -q -Fx -- "$file" "$union_file" || fail "a QUARANTINED test's file contributed nothing to any shard: $file
Quarantine is per test and excludes no file, so this file stopped being
collected for another reason entirely — while a quarantine entry claimed to be
watching a test inside it. Release the entry (pnpm ci:quarantine remove), or
find out why the file is no longer collected."
  done <"$quarantined_file"
fi

total=$(wc -l < "$union_file" | tr -d ' ')
if [ -n "$quarantined_file" ]; then
  lane_note="$quarantined_files quarantined test file(s) still collected, $quarantined_skipped lane line(s) not a workspace test file and not checked here"
else
  lane_note='no quarantine list was given, so nothing was checked against one'
fi
printf 'assert-shard-union: %s package(s) all contributed to a union of %s collected test file(s); %s.\n' \
  "$checked" "$total" "$lane_note"
