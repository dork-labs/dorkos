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
#     `testMatch` / `grepInvert` are hand-edited filters, and apps/e2e's are
#     non-trivial — chat-mock.spec.ts is ignored by one project and matched by
#     the other, the two site specs are ignored unless the marketing-site leg is
#     booted, and every test in send-message.spec.ts is grep-filtered by its
#     @integration tag. Widen one of those by accident and a file stops running
#     while the run still says "N passed" and exits 0. Verified: a config with
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
#   2. Every *.spec.ts under apps/e2e/tests appears in the report — except the
#      FILTERED_SPECS, which must NOT appear at all (see that list). The
#      expectation comes from `find`, so adding a spec keeps the assertion
#      honest with nobody remembering to update a number.
#   3. Every collected spec ran at least one test that was not skipped — except
#      the specs in OPT_IN_SPECS, which must have run NONE.
#   4. At least one test executed overall, and none failed.
#
# A SPEC FILE IS NOT THE ONLY THING THAT DECLARES TESTS. apps/e2e has a second
# sanctioned shape, documented in its README under "Adding a mock-server suite":
# a plain `*.ts` MODULE exporting a register function, which a spec file imports
# and calls. The mock-server projects need it — `POST /api/test/reset` deletes
# every tracked session's transcript and `fullyParallel` puts separate spec FILES
# on concurrent workers, so a suite needing a transcript to survive cannot be its
# own spec; registering it into chat-mock.spec.ts puts it on that file's worker.
# Playwright reports such tests against the file that DECLARED them, so they
# arrive in the report under a name `find -name '*.spec.ts'` will never produce.
#
# Those modules are enumerated in REGISTERED_MODULES and held to exactly the
# standard a spec is: present on disk, present in the report, and having run
# something. What they are NOT is a hole — a reported file that is neither a spec
# on disk nor on that list still trips the stale-report check, so the list is the
# single sanctioned door rather than a general amnesty for non-spec files.
#
# All three lists are self-policing in both directions: a listed entry that stops
# matching its exemption fails as loudly as an unlisted file that starts needing
# one, and an entry naming a file that no longer exists fails too.
#
# Deliberately NOT a hard-coded total. "92 tests" goes stale the first time
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

# Specs expected to be COLLECTED but to run ZERO tests, with the reason each is
# exempt.
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

# Specs expected to be entirely ABSENT from the report.
#
# Every test in these files carries the @integration tag, and the chromium
# project's `grepInvert: /@integration/` (apps/e2e/playwright.config.ts) drops
# them from COLLECTION unless E2E_INTEGRATION=1. Unlike a skip, a grep-filtered
# test never reaches the report at all — which is why these cannot live in
# OPT_IN_SPECS, whose members must appear with zero executed. @integration
# specs drive a REAL model with real credentials and spend money per run, so a
# PR runner must never execute them.
#
# Self-policing both ways: if one of these appears in the report at all, either
# E2E_INTEGRATION leaked into CI (billing somebody on every PR) or the file
# gained an untagged test and the exemption is stale. Both fail loudly.
#
#   chat/send-message.spec.ts — one describe block, tagged @integration: real
#     agent turns awaiting real model responses.
FILTERED_SPECS=(
  'chat/send-message.spec.ts'
)

# Modules that declare tests without being spec files — see the header.
#
# Held to a spec's standard, not exempted from it. Each entry must exist on
# disk, must appear in the report, and must have run at least one test that was
# not skipped: they join `expected_specs` below, which is what hands them
# assertions 2 and 3 unchanged. So a module that silently stops being registered
# — the import deleted, the register call dropped, the spec that imports it
# renamed — fails exactly as loudly as a spec that stops being collected, which
# is the guarantee this gate exists for.
#
# And each must NOT be named `*.spec.ts`. That is not tidiness: every directory
# these modules live in is also a COCKPIT-leg directory, so the extension is the
# only thing keeping a test-mode module off the leg that drives a real, billable
# runtime. A rename would both put it there and double-count it here; refusing
# the name keeps the two facts from drifting apart.
#
#   chat/session-read-state.ts — cross-device read state for chat sessions
#     (DOR-1040). Registered into chat-mock.spec.ts, which is what puts it on
#     that file's worker and out of reach of its own beforeEach resets.
#   dashboard-sidebar/now-survives-reload.ts — the sidebar's Now zone surviving a
#     page load (DOR-1136). Registered into chat-mock.spec.ts for both reasons at
#     once: it drives the `error` and `demo-approval` scenarios, which exist only
#     behind DORKOS_TEST_RUNTIME, and it needs a session to outlive that file's
#     `POST /api/test/reset`. Its neighbours in tests/dashboard-sidebar/ are
#     ordinary cockpit specs, which is exactly why the extension matters here.
#   dashboard-sidebar/send-lands-in-today.ts — writing in a conversation puts it
#     in Today (DOR-1156). Registered into chat-mock.spec.ts because it drives
#     real sends, which are free and deterministic only against TestModeRuntime
#     — on the cockpit leg each one would bill the machine's own `claude`
#     sign-in. Same directory, same extension rule, same reason.
#   chat/interactive-prompts.ts — the prompts a turn STOPS on: tool approvals,
#     the batch bar, AskUserQuestion, MCP elicitation (capability rows
#     I-01…I-04, DOR-1214). Registered into chat-mock.spec.ts because every one
#     of its turns PARKS waiting for an answer, and that file's `POST
#     /api/test/reset` tears down every tracked session — a parked turn on a
#     concurrent worker would be disposed mid-click. Its scenarios exist only
#     behind DORKOS_TEST_RUNTIME, and tests/chat/ is a cockpit-leg directory, so
#     the extension is doing the same job it does for session-read-state.ts.
#   chat/live-turn-visibility.ts — what a live turn shows while it runs and how
#     Stop settles it (C-10, R-05, R-06, R-07, DOR-1214). Same registration and
#     the same extension rule: it holds a turn open across several assertions
#     using step barriers, which only survives on that file's sequential worker.
REGISTERED_MODULES=(
  'chat/composer-escape-and-ime.ts'
  'chat/interactive-prompts.ts'
  'chat/live-turn-visibility.ts'
  'chat/session-read-state.ts'
  'dashboard-sidebar/now-survives-reload.ts'
  'dashboard-sidebar/send-lands-in-today.ts'
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

# Exemptions must name files that still exist. An entry for a deleted spec is a
# list nobody is maintaining, and the next real exemption gets waved past it.
for entry in "${OPT_IN_SPECS[@]}" "${FILTERED_SPECS[@]}"; do
  [ -f "$tests_dir/$entry" ] || fail "an exemption names a spec that does not exist on disk: $entry
Remove it from OPT_IN_SPECS/FILTERED_SPECS in this script."
done

# The same rule for registered modules, plus the one about their name — see
# REGISTERED_MODULES for why the extension is load-bearing rather than cosmetic.
for entry in "${REGISTERED_MODULES[@]}"; do
  [ -f "$tests_dir/$entry" ] || fail "a registered module does not exist on disk: $entry
Remove it from REGISTERED_MODULES in this script, or restore the file."
  case "$entry" in
  *.spec.ts) fail "a registered module is named like a spec file: $entry
REGISTERED_MODULES is for modules a spec IMPORTS, which must not be collected as
specs themselves — in a cockpit-leg directory that is what keeps a test-mode
suite off the leg that drives a real, billable runtime. Either rename it back to
a plain .ts module, or drop it from this list because it is now an ordinary
spec." ;;
  esac
done

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

is_filtered() {
  local needle=$1 entry
  for entry in "${FILTERED_SPECS[@]}"; do
    [ "$entry" = "$needle" ] && return 0
  done
  return 1
}

# The @integration specs must be absent from the report entirely — see
# FILTERED_SPECS for why presence, not failure, is the alarm here.
present_filtered=''
while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  is_filtered "$spec" && present_filtered="$present_filtered  $spec"$'\n'
done <<<"$report_specs"
if [ -n "$present_filtered" ]; then
  fail "these spec files are @integration-only (FILTERED_SPECS) and must be
absent from a default run, but the report contains them:
${present_filtered%$'\n'}
Either E2E_INTEGRATION was set for this run — which drives a real model and
spends real credit, and must stay a deliberate local act — or the file gained a
test without the @integration tag, in which case remove it from FILTERED_SPECS."
fi

# What the report is EXPECTED to contain: everything on disk minus the
# grep-filtered specs, whose absence was just verified, PLUS the registered
# modules — which is the whole of their special handling. Folding them in here
# rather than checking them apart is what holds them to assertions 2 and 3
# verbatim: missing from the report, or present having run nothing, and the
# existing refusals name them.
expected_specs=''
while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  is_filtered "$spec" || expected_specs="$expected_specs$spec"$'\n'
done <<<"$disk_specs"
for entry in "${REGISTERED_MODULES[@]}"; do
  expected_specs="$expected_specs$entry"$'\n'
done
expected_specs=$(printf '%s' "$expected_specs" | sort -u)

# What the report is ALLOWED to contain at all. Registered modules are the only
# non-spec names admitted; anything else the report mentions is still a stale
# report. Deliberately NOT `expected_specs`: a FILTERED_SPEC that appears has
# already been refused above with a message about billing, and folding it in
# here would replace that with a vaguer one.
known_files=$(printf '%s\n' "$disk_specs" "${REGISTERED_MODULES[@]}" | sort -u)

# 2. Nothing expected may be missing from the run.
missing=$(comm -23 <(printf '%s\n' "$expected_specs") <(printf '%s\n' "$report_specs"))
if [ -n "$missing" ]; then
  fail "these test files exist on disk but no test from them appears in the run:
$(printf '%s\n' "$missing" | sed 's/^/  /')
Playwright collected nothing from them and still exited 0. Check the projects'
testMatch/testIgnore/grepInvert filters, whether the file was renamed, and —
for the site specs — whether the marketing-site leg booted (E2E_SITE). For a
REGISTERED_MODULES entry, check that the spec file which imports it still calls
its register function: a dropped call takes the whole suite out of every run
while leaving the module on disk looking healthy."
fi

# The mirror: something ran that is not on disk means the report describes a
# different checkout — most often a stale results.json left by an earlier run,
# which would let a deleted spec keep certifying itself.
extra=$(comm -13 <(printf '%s\n' "$known_files") <(printf '%s\n' "$report_specs"))
if [ -n "$extra" ]; then
  fail "the run reports test files that do not exist on disk:
$(printf '%s\n' "$extra" | sed 's/^/  /')
This report does not describe this checkout — most likely a stale
test-results/results.json left over from an earlier run.
If one of these IS a real file that declares tests without being a *.spec.ts —
a module a spec imports and registers — it belongs in REGISTERED_MODULES, which
holds it to the same standard rather than waving it through."
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
#
# The shape is asserted BEFORE the fields are read. Without this, a report
# whose .stats exists but lost its numeric fields (a reporter version changing
# shape) makes every [ -ne ] below evaluate against an empty string — bash
# prints "integer expression expected" to stderr and carries on, and the gate
# certifies a run it never actually checked. A guard that can fail open on the
# input drifting is the exact class this script exists to close.
jq -e '.stats | (has("expected") and has("unexpected") and has("flaky") and has("skipped"))
       and ([.expected, .unexpected, .flaky, .skipped] | all(type == "number"))' \
  "$report" >/dev/null 2>&1 || fail "the report's .stats block is missing or no longer carries numeric
expected/unexpected/flaky/skipped fields. Playwright's JSON reporter shape has
drifted (version bump?); this gate refuses to certify a report it cannot read.
Update this script's stats handling in the same change that bumps the reporter."
read -r stat_expected stat_unexpected stat_flaky stat_skipped < <(
  jq -r '[.stats.expected, .stats.unexpected, .stats.flaky, .stats.skipped] | @tsv' "$report"
)

[ "$total_ran" -gt 0 ] || fail "the run executed zero tests."

if [ "$stat_unexpected" -ne 0 ]; then
  fail "$stat_unexpected test(s) failed. The suite ran; it did not pass."
fi

expected_count=$(printf '%s\n' "$expected_specs" | wc -l | tr -d ' ')
printf 'assert-browser-tests-executed: %s test(s) executed across %s test file(s), %s of them registered module(s) (%s expected, %s flaky, %s skipped across %s opt-in spec(s); %s @integration spec(s) confirmed absent).\n' \
  "$total_ran" "$expected_count" "${#REGISTERED_MODULES[@]}" \
  "$stat_expected" "$stat_flaky" "$stat_skipped" "${#OPT_IN_SPECS[@]}" "${#FILTERED_SPECS[@]}"

# Flaky tests passed on a retry, so they do not fail this gate — but a retry
# budget is exactly what quietly turns a real intermittent failure into a green
# check (the workflow's header carries the argument for the current budget of
# one). Name them so every absorbed retry is visible in the job log rather than
# silent; a test that keeps appearing here is the signal to fix it or go to
# zero retries.
if [ "$stat_flaky" -ne 0 ]; then
  printf 'assert-browser-tests-executed: WARNING — %s test(s) only passed on a retry:\n' "$stat_flaky"
  jq -r '
    [ .suites[] | recurse(.suites[]?) | .specs[]? ][]
    | . as $s | .tests[]? | select(.status == "flaky")
    | "  \($s.file) › \($s.title)"
  ' "$report"
  # On a runner, a printf in a green job's collapsed step log is honest but
  # effectively invisible. A workflow command turns each absorbed retry into a
  # PR annotation, so pass-on-retry is seen without anyone opening the log.
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::warning title=browser suite passed on retry::%s test(s) only passed on a retry — see the assert step log for names. A test that keeps appearing here is the signal to fix it or drop the retry budget to zero.\n' "$stat_flaky"
  fi
fi
