#!/usr/bin/env bash
# Prove that a `turbo test` run actually executed tests.
#
# --help
# Purpose: prove a `turbo test` run executed tests, not a full cache replay or a
#          filter that matched nothing.
# Runs in: test.yml's `test-shard` jobs (behind the required `test`).
# To fix:  read the package it names: its test task was replayed from cache or
#          never ran. Check the turbo filter and the package's test script.
# Usage:   scripts/assert-tests-executed.sh [--packages <file>] [<summary.json>]
# --help end
#
# WHY THIS EXISTS. Turbo caches `test` (turbo.json: `"test": { "cache": true }`),
# and a full cache hit is nearly indistinguishable from a real run in the log:
#
#   Tasks:    2 successful, 2 total
#   Cached:   2 cached, 2 total
#     Time:   280ms >>> FULL TURBO
#
# Exit 0, "successful", no tests executed. A CI job that reports green off that
# is worse than no job at all, because it manufactures a signal nobody checks.
# The same shape hides the opposite failure: `turbo test --filter=<typo>` runs
# ZERO tasks and also exits 0.
#
# Neither failure is visible in turbo's own exit code, so this script reads the
# machine-readable run summary that `turbo test --summarize` writes to
# .turbo/runs/<id>.json and asserts two things about it:
#
#   1. Every `test` task in the run was a cache MISS — i.e. the suite really ran
#      rather than replaying a stored result.
#   2. The number of `test` tasks equals the number of workspace packages that
#      declare a `test` script, so a filter, a task-graph change or a silently
#      dropped package cannot shrink the run without anyone noticing.
#
# Deliberately NOT `--force` / TURBO_FORCE. Turning caching off is a policy, not
# a proof: nothing notices when someone removes the flag, it also discards the
# `^build` cache that `test` legitimately depends on, and it does not catch the
# zero-tasks case at all. Asserting on the summary keeps the cache and still
# fails loudly the day a cache replay reaches a gate.
#
# THE PLANNED SET (DOR-5130). A merge-queue build runs the suites its own
# change can reach (scripts/pr-test-plan.sh on HEAD^1..HEAD), not every suite.
# `--packages <file>` names that set, one repo-relative package directory per
# line (`apps/server`), and then the second assertion becomes: the `test` tasks
# that ran are EXACTLY those packages, no fewer and no others. Each named
# directory must be a workspace package that declares a `test` script, and an
# empty file is refused: the planner never selects nothing (it answers `full`),
# so an empty list means something upstream broke. Without the flag the
# expected set is every package that declares a `test` script, as before; the
# push run on main, the canary and release pull requests never pass it.
#
# Usage:
#   scripts/assert-tests-executed.sh [--packages <file>] [<summary.json>]
#
# With no summary argument it reads the most recently written summary under
# .turbo/runs/, which is where `--summarize` puts one file per run.
#
# WORKSPACE_ROOT overrides where the workspace manifests and .turbo/runs are
# looked up. It exists so scripts/test-assert-tests-executed.sh can drive this
# against synthetic workspaces in a temp dir; keeping the fixtures off this
# repo's real state is what stops them red-lighting unrelated PRs.

# --help (DOR-4950). A gate checked out alone, as the PR-side gates are, runs without it.
gate_help="$(dirname "$0")/lib/gate-help.sh"
# shellcheck source=lib/gate-help.sh
[ ! -r "$gate_help" ] || . "$gate_help"

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace_root=${WORKSPACE_ROOT:-$repo_root}

fail() {
  printf 'assert-tests-executed: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail 'jq is required but was not found on PATH.'

planned_file=''
while [ $# -gt 0 ]; do
  case "$1" in
  --packages)
    planned_file=${2:-}
    [ -n "$planned_file" ] || fail '--packages needs a file.'
    [ -f "$planned_file" ] || fail "no planned-packages list at $planned_file.
The workflow writes it from test-shard-count's plan just before this runs; a
MISSING file means that did not happen, and this gate will not guess the set."
    shift 2
    ;;
  --*) fail "unknown option: $1" ;;
  *) break ;;
  esac
done

summary=${1:-}
if [ -z "$summary" ]; then
  # turbo names run summaries with a base58 run id (e.g.
  # 3H745eI0wkC2N8QMRfnU7QbVySr.json), so there is no whitespace or glob
  # character for `ls` to mangle, and `-t` is the shortest way to take the
  # newest.
  # shellcheck disable=SC2012
  summary=$(ls -t "$workspace_root"/.turbo/runs/*.json 2>/dev/null | head -1)
fi

if [ -z "$summary" ] || [ ! -f "$summary" ]; then
  fail "no turbo run summary found under $workspace_root/.turbo/runs/.
Run the suite with --summarize so there is something to check:
  pnpm exec turbo test --summarize --continue -- --run"
fi

# Count the workspace packages that declare a `test` script. The COUNT is
# derived from the tree, so adding or removing a package keeps the assertion
# honest without anyone remembering to update a number here.
#
# The apps/* and packages/* globs below are hard-coded, not read from
# pnpm-workspace.yaml: this script runs on bash and jq alone, which is what lets
# the CI `fixtures` job skip a pnpm install, and neither reads YAML. Those are
# the workspace's only two globs today. A third one added later would not make
# this lie: its packages would go uncounted, `expected` would fall below the
# number of `test` tasks turbo really ran, and the equality check at the bottom
# would fail loudly rather than certify a shrunken run.
expected=0
while IFS= read -r manifest; do
  if [ "$(jq -r 'if .scripts.test == null then "no" else "yes" end' "$manifest" 2>/dev/null)" = 'yes' ]; then
    expected=$((expected + 1))
  fi
done < <(find "$workspace_root/apps" "$workspace_root/packages" \
  -mindepth 2 -maxdepth 2 -name package.json 2>/dev/null)

[ "$expected" -gt 0 ] || fail "found no workspace package declaring a \`test\` script under
$workspace_root/{apps,packages}. That is either the wrong root or a broken
checkout — either way this run proved nothing."

executed=$(jq -r '[.tasks[] | select(.task == "test")] | length' "$summary" 2>/dev/null) ||
  fail "could not read $summary — it is not valid turbo run-summary JSON."
[ -n "$executed" ] || fail "could not read $summary — it is not valid turbo run-summary JSON."

# `cache.status` is "MISS" when turbo actually executed the task and "HIT" when
# it replayed stored output. Anything that is not a MISS means no test process
# ran for that package during this run.
replayed=$(jq -r '.tasks[] | select(.task == "test" and .cache.status != "MISS") | .taskId' "$summary")

if [ -n "$replayed" ]; then
  fail "these test tasks were replayed from the turbo cache, so no tests actually ran:
$(printf '%s\n' "$replayed" | sed 's/^/  /')
A gate cannot certify a suite it did not execute. If this is CI, the runner is
restoring a turbo cache it should not have (remote cache, or a cache action over
.turbo/); if this is local, you are looking at a replay, not a result."
fi

if [ -n "$planned_file" ]; then
  planned=$(grep -v '^[[:space:]]*$' "$planned_file" | sort -u)
  [ -n "$planned" ] || fail "the planned-packages list $planned_file is empty.
The planner never selects nothing (it answers \`full\` instead), so an empty
plan means the plan was lost on the way here. This gate will not certify a run
against an empty set."
  while IFS= read -r dir; do
    case "$dir" in
    apps/*/* | packages/*/*) fail "planned package directory '$dir' is not a workspace package directory (apps/<name> or packages/<name>)." ;;
    apps/* | packages/*) ;;
    *) fail "planned package directory '$dir' is not a workspace package directory (apps/<name> or packages/<name>)." ;;
    esac
    [ "$(jq -r 'if .scripts.test == null then "no" else "yes" end' "$workspace_root/$dir/package.json" 2>/dev/null)" = 'yes' ] ||
      fail "planned package '$dir' has no package.json declaring a \`test\` script, so the plan names a suite that cannot run."
  done <<<"$planned"
  ran=$(jq -r '.tasks[] | select(.task == "test") | .directory // "?"' "$summary" | sort -u)
  not_run=$(comm -23 <(printf '%s\n' "$planned") <(printf '%s\n' "$ran"))
  unplanned=$(comm -13 <(printf '%s\n' "$planned") <(printf '%s\n' "$ran"))
  if [ -n "$not_run" ] || [ -n "$unplanned" ]; then
    fail "the test tasks that ran are not the planned set.
Planned but not run:
$(printf '%s\n' "${not_run:-  (none)}" | sed 's/^/  /')
Run but not planned:
$(printf '%s\n' "${unplanned:-  (none)}" | sed 's/^/  /')
Check the sweep's --filter list against test-shard-count's plan."
  fi
  count=$(printf '%s\n' "$planned" | wc -l | tr -d ' ')
  [ "$executed" -eq "$count" ] || fail "ran $executed test task(s) for $count planned package(s); a package ran more than once."
  printf 'assert-tests-executed: %s/%s planned package test suites executed (no cache replays); %s package(s) declare a test script.\n' \
    "$executed" "$count" "$expected"
  exit 0
fi

if [ "$executed" -ne "$expected" ]; then
  fail "ran $executed test task(s) but $expected workspace package(s) declare a \`test\` script.
The run covered less than the whole monorepo — check for a stray --filter, a
package whose \`test\` script disappeared, or tasks skipped by a failed
dependency."
fi

printf 'assert-tests-executed: %s/%s package test suites executed (no cache replays).\n' \
  "$executed" "$expected"
