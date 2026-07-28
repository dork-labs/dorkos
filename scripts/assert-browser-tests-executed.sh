#!/usr/bin/env bash
# Prove that a Playwright run actually executed browser tests.
#
# WHY THIS EXISTS. This is scripts/assert-tests-executed.sh's argument applied to
# a different runner. That script exists because `turbo test` can replay a cache
# hit in 280ms and print "successful"; read its header for the reasoning, which
# is not repeated here. Playwright has its own ways of exiting 0 having proved
# nothing, and they are worse because there is no cache to blame.
#
# What Playwright already catches, so this does not: a testDir that resolves to
# NOTHING at all. `playwright test` on an empty testDir prints "Error: No tests
# found" and exits 1 (verified on 1.59.1). The dangerous case is the partial one:
#
#   * A spec silently dropped from the run. `projects[].testIgnore` /
#     `testMatch` are hand-edited glob lists, and apps/e2e's are non-trivial —
#     chat-mock.spec.ts is ignored by one project and matched by the other, and
#     the two site specs are ignored unless the marketing-site leg is booted.
#     Widen one of those globs by accident and the file stops running while the
#     run still says "N passed" and exits 0. Verified: a config with
#     `testIgnore: ['**/beta.spec.ts']` over a two-spec tree reports "1 passed"
#     and exits 0.
#   * Everything in a spec skipped. Skips are not failures. A `test.skip()` guard
#     whose condition inverted, or a `beforeAll` that gave up, turns a suite into
#     skips and the run stays green.
#   * A spec file that moved out of testDir. It is still in the repo, still
#     imported by nothing, and simply never collected.
#
# So this reads Playwright's JSON report and asserts, against the FILESYSTEM
# rather than against Playwright's own opinion of what it should have run:
#
#   1. No *.spec.ts lives outside apps/e2e/tests, which is the only testDir the
#      config declares. A spec anywhere else is dead weight nothing runs.
#   2. Every *.spec.ts under apps/e2e/tests appears in the report. The
#      expectation comes from `find`, so adding a spec keeps the assertion honest
#      with nobody remembering to update a number.
#   3. Every one of those specs ran at least one test that was not skipped —
#      except the specs in OPT_IN_SPECS, which must have run NONE. Both
#      directions are checked, so a stale exemption fails as loudly as a missing
#      one.
#   4. At least one test executed overall, and none failed.
#
# Deliberately NOT a hard-coded total. "104 tests" goes stale the first time
# somebody adds a test, and a gate whose expectation is stale gets edited to
# match reality rather than the other way round.
#
# Usage:
#   scripts/assert-browser-tests-executed.sh [<results.json>]
#
# With no argument it reads apps/e2e/test-results/results.json, where the `json`
# reporter in apps/e2e/playwright.config.ts writes.
#
# NOTE: `--reporter=<x>` on the `playwright test` command line REPLACES the
# config's reporter list rather than adding to it, so a run invoked that way
# writes no JSON and this script has nothing to read. The CI job never passes
# `--reporter`.
#
# Paths in the report's `.file` are relative to Playwright's rootDir, which for
# this config is apps/e2e/tests (the common ancestor of every project's testDir)
# — NOT the package root. Both sides of every comparison below are normalized to
# that, which is why assertion 1 exists: it is what makes "relative to tests/"
# a complete description of the suite.
#
# WORKSPACE_ROOT overrides where apps/e2e and the report are looked up, so
# scripts/test-assert-browser-tests-executed.sh can drive this against synthetic
# trees in a temp dir; keeping the fixtures off this repo's real state is what
# stops them red-lighting unrelated PRs.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workspace_root=${WORKSPACE_ROOT:-$repo_root}
e2e_root="$workspace_root/apps/e2e"
tests_dir="$e2e_root/tests"

# Specs expected to run ZERO tests, with the reason each is exempt.
#
# Self-policing: assertion 3 fails if a listed spec DOES execute (the exemption
# went stale) as well as if an unlisted spec executes nothing. Adding a name here
# to turn a red job green is a visible act, not a silent one.
#
#   settings/auth-login.spec.ts — gated on DORKOS_E2E_AUTH. It mutates global
#     auth state (creates an owner, flips "require login"), so it is opt-in by
#     design; its own file header says so, and says what wiring it into CI would
#     need. Nothing sets DORKOS_E2E_AUTH, so it skips everywhere.
OPT_IN_SPECS=(
  'settings/auth-login.spec.ts'
)

fail() {
  printf 'assert-browser-tests-executed: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail 'jq is required but was not found on PATH.'

report=${1:-"$e2e_root/test-results/results.json"}

if [ ! -f "$report" ]; then
  fail "no Playwright JSON report at $report.
The run produced no machine-readable result, so it proved nothing. Either the
suite never started, or it was invoked with a --reporter flag that replaced the
config's json reporter."
fi

jq -e '.stats' "$report" >/dev/null 2>&1 ||
  fail "$report is not a Playwright JSON report (no .stats)."

[ -d "$tests_dir" ] || fail "no test directory at $tests_dir.
That is either the wrong root or a broken checkout — either way this run proved
nothing."

# 1. Nothing may sit outside the one testDir the config declares.
stray=$(cd "$e2e_root" && find . -name '*.spec.ts' \
  -not -path './node_modules/*' -not -path './tests/*' | sed 's|^\./||' | sort)
if [ -n "$stray" ]; then
  fail "these spec files are outside apps/e2e/tests, so nothing collects them:
$(printf '%s\n' "$stray" | sed 's/^/  /')
Move them under tests/ or delete them. A spec file no run can reach is not a
test, it is a file that looks like one."
fi

disk_specs=$(cd "$tests_dir" && find . -name '*.spec.ts' | sed 's|^\./||' | sort)
[ -n "$disk_specs" ] || fail "found no *.spec.ts under $tests_dir."

# Every spec in the report, with how many of its tests were NOT skipped.
# `.tests[].status` is Playwright's per-test outcome: expected | unexpected |
# flaky | skipped. Anything that is not "skipped" means a browser really ran it.
report_rows=$(jq -r '
  [ .suites[] | recurse(.suites[]?) | .specs[]? ] as $specs
  | ($specs | map(.file) | unique) as $files
  | $files[]
  | . as $f
  | ($specs | map(select(.file == $f) | .tests[]? | select(.status != "skipped")) | length) as $ran
  | "\($f)\t\($ran)"
' "$report" 2>/dev/null) || fail "could not read $report — unexpected JSON shape."

report_specs=$(printf '%s\n' "$report_rows" | cut -f1 | sort)

# 2. Nothing on disk may be missing from the run.
missing=$(comm -23 <(printf '%s\n' "$disk_specs") <(printf '%s\n' "$report_specs"))
if [ -n "$missing" ]; then
  fail "these spec files exist on disk but no test from them appears in the run:
$(printf '%s\n' "$missing" | sed 's/^/  /')
Playwright collected nothing from them and still exited 0. Check the projects'
testMatch/testIgnore globs, and whether the file was renamed."
fi

# The mirror: something ran that is not on disk means the report describes a
# different checkout — most often a stale results.json left by an earlier run,
# which would let a deleted spec keep certifying itself.
extra=$(comm -13 <(printf '%s\n' "$disk_specs") <(printf '%s\n' "$report_specs"))
if [ -n "$extra" ]; then
  fail "the run reports spec files that do not exist on disk:
$(printf '%s\n' "$extra" | sed 's/^/  /')
This report does not describe this checkout — most likely a stale
test-results/results.json left over from an earlier run."
fi

# 3. Per-spec: exactly the opt-in specs may have executed nothing.
is_opt_in() {
  local needle=$1 entry
  for entry in "${OPT_IN_SPECS[@]}"; do
    [ "$entry" = "$needle" ] && return 0
  done
  return 1
}

silent=''
stale_exemption=''
total_ran=0
while IFS=$'\t' read -r file ran; do
  [ -n "$file" ] || continue
  total_ran=$((total_ran + ran))
  if is_opt_in "$file"; then
    [ "$ran" -gt 0 ] && stale_exemption="$stale_exemption  $file ($ran executed)"$'\n'
  else
    [ "$ran" -eq 0 ] && silent="$silent  $file"$'\n'
  fi
done <<<"$report_rows"

if [ -n "$silent" ]; then
  fail "these spec files were collected but every one of their tests was skipped:
${silent%$'\n'}
A suite that skips is not a suite that passes. This is what a dead webServer leg,
a failed beforeAll, or a stray test.skip() looks like from outside."
fi

if [ -n "$stale_exemption" ]; then
  fail "these spec files are listed in OPT_IN_SPECS as never running, but ran:
${stale_exemption%$'\n'}
The exemption is stale. Remove it from OPT_IN_SPECS so the spec is held to the
same standard as every other."
fi

# 4. Totals, taken from Playwright's own tally rather than the per-spec walk, so
# a disagreement between the two surfaces here.
read -r stat_expected stat_unexpected stat_flaky stat_skipped < <(
  jq -r '[.stats.expected, .stats.unexpected, .stats.flaky, .stats.skipped] | @tsv' "$report"
)

[ "$total_ran" -gt 0 ] || fail "the run executed zero tests."

if [ "$stat_unexpected" -ne 0 ]; then
  fail "$stat_unexpected test(s) failed. The suite ran; it did not pass."
fi

printf 'assert-browser-tests-executed: %s test(s) executed across %s spec file(s) (%s expected, %s flaky, %s skipped across %s opt-in spec(s)).\n' \
  "$total_ran" "$(printf '%s\n' "$disk_specs" | wc -l | tr -d ' ')" \
  "$stat_expected" "$stat_flaky" "$stat_skipped" "${#OPT_IN_SPECS[@]}"

# Flaky tests passed on a retry, so they do not fail this gate — but a retry
# budget is exactly what quietly turns a real intermittent failure into a green
# check (apps/e2e/playwright.config.ts sets `retries: 2` under CI, which
# .github/workflows/test.yml's header argues against for the unit suite). Name
# them so the retry is visible rather than absorbed.
if [ "$stat_flaky" -ne 0 ]; then
  printf 'assert-browser-tests-executed: WARNING — %s test(s) only passed on a retry:\n' "$stat_flaky"
  jq -r '
    [ .suites[] | recurse(.suites[]?) | .specs[]? ][]
    | . as $s | .tests[]? | select(.status == "flaky")
    | "  \($s.file) › \($s.title)"
  ' "$report"
fi
