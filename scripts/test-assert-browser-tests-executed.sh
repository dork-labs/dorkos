#!/usr/bin/env bash
# Fixtures for scripts/assert-browser-tests-executed.sh.
#
# That script is a gate, and the failure mode of a gate is silent: a refusal that
# quietly stops matching keeps returning success, and the first symptom is a
# browser suite that has not run for a month. So every case below bends ONE thing
# about a known-good run, and asserts the script names that thing — the same
# shape scripts/test-should-arm-automerge.sh uses for the same reason.
#
# Each case builds a synthetic workspace in a temp dir and points the script at
# it with WORKSPACE_ROOT, so these never read this repo's real apps/e2e and can
# never red-light an unrelated PR.
#
# Run directly, or via `pnpm test:scripts` from the repo root.

set -uo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
subject="$script_dir/assert-browser-tests-executed.sh"

pass=0
fail=0

# Build a synthetic workspace.
#   $1 — root to build under
# Creates two ordinary specs, the opt-in auth spec, the grep-filtered
# @integration spec, and EVERY registered module (plain .ts files a spec imports
# — see REGISTERED_MODULES in the subject). The report has both ordinary specs
# and the modules running, the auth spec skipped, and the @integration spec
# absent entirely (grepInvert drops it from collection, so it never reaches the
# report). That is the known-good run every case below bends exactly one thing
# about.
#
# The module list here MIRRORS the subject's, and must: the subject refuses a
# REGISTERED_MODULES entry that is not on disk, so a module added there and not
# here fails every case at once for a reason that has nothing to do with the
# thing each case is bending.
make_workspace() {
  local root=$1
  mkdir -p "$root/apps/e2e/tests/settings" "$root/apps/e2e/tests/chat" \
    "$root/apps/e2e/tests/dashboard-sidebar" "$root/apps/e2e/test-results"
  : >"$root/apps/e2e/tests/alpha.spec.ts"
  : >"$root/apps/e2e/tests/beta.spec.ts"
  : >"$root/apps/e2e/tests/settings/auth-login.spec.ts"
  : >"$root/apps/e2e/tests/chat/send-message.spec.ts"
  : >"$root/apps/e2e/tests/chat/session-read-state.ts"
  : >"$root/apps/e2e/tests/dashboard-sidebar/now-survives-reload.ts"
  : >"$root/apps/e2e/tests/dashboard-sidebar/send-lands-in-today.ts"
  cat >"$root/apps/e2e/test-results/results.json" <<'JSON'
{
  "suites": [
    { "title": "alpha.spec.ts", "file": "alpha.spec.ts",
      "specs": [ { "title": "alpha runs", "file": "alpha.spec.ts",
                   "tests": [ { "status": "expected" } ] } ] },
    { "title": "beta.spec.ts", "file": "beta.spec.ts",
      "specs": [ { "title": "beta runs", "file": "beta.spec.ts",
                   "tests": [ { "status": "expected" } ] } ] },
    { "title": "chat/session-read-state.ts", "file": "chat/session-read-state.ts",
      "specs": [ { "title": "the module's suite runs", "file": "chat/session-read-state.ts",
                   "tests": [ { "status": "expected" } ] } ] },
    { "title": "dashboard-sidebar/now-survives-reload.ts", "file": "dashboard-sidebar/now-survives-reload.ts",
      "specs": [ { "title": "the second module's suite runs", "file": "dashboard-sidebar/now-survives-reload.ts",
                   "tests": [ { "status": "expected" } ] } ] },
    { "title": "dashboard-sidebar/send-lands-in-today.ts", "file": "dashboard-sidebar/send-lands-in-today.ts",
      "specs": [ { "title": "the third module's suite runs", "file": "dashboard-sidebar/send-lands-in-today.ts",
                   "tests": [ { "status": "expected" } ] } ] },
    { "title": "settings", "file": "settings/auth-login.spec.ts", "specs": [],
      "suites": [ { "title": "Auth", "file": "settings/auth-login.spec.ts",
                    "specs": [ { "title": "auth runs", "file": "settings/auth-login.spec.ts",
                                 "tests": [ { "status": "skipped" } ] } ] } ] }
  ],
  "stats": { "expected": 5, "unexpected": 0, "flaky": 0, "skipped": 1 }
}
JSON
}

# Assert the script's exit status, and (when failing) that its message names the
# thing that was bent.
#   $1 — case name
#   $2 — workspace root
#   $3 — expected exit: 0 or 1
#   $4 — substring the output must contain (may be empty)
check() {
  local name=$1 root=$2 want=$3 needle=${4:-}
  local out status
  out=$(WORKSPACE_ROOT="$root" "$subject" 2>&1)
  status=$?

  if [ "$status" -ne "$want" ]; then
    printf 'FAIL  %s\n      expected exit %s, got %s\n      output: %s\n' \
      "$name" "$want" "$status" "$out"
    fail=$((fail + 1))
    return
  fi
  if [ -n "$needle" ] && [[ "$out" != *"$needle"* ]]; then
    printf 'FAIL  %s\n      exit %s was right, but the message never mentioned %s\n      output: %s\n' \
      "$name" "$status" "'$needle'" "$out"
    fail=$((fail + 1))
    return
  fi
  printf 'ok    %s\n' "$name"
  pass=$((pass + 1))
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The known-good run. If this case ever fails, every refusal below is meaningless
# because the script is rejecting healthy input.
make_workspace "$tmp/healthy"
# The count is the FIXTURE's, not the real suite's — two ordinary specs plus one
# test per registered module — so it moves when make_workspace does and never
# because somebody added a browser test.
check 'a healthy run passes' "$tmp/healthy" 0 '5 test(s) executed'

# A spec on disk that the run never collected — the testIgnore/testMatch hole.
make_workspace "$tmp/uncollected"
: >"$tmp/uncollected/apps/e2e/tests/gamma.spec.ts"
check 'a spec the run never collected is named' "$tmp/uncollected" 1 'gamma.spec.ts'

# A spec parked outside testDir, where nothing will ever collect it.
make_workspace "$tmp/stray"
mkdir -p "$tmp/stray/apps/e2e/old"
: >"$tmp/stray/apps/e2e/old/legacy.spec.ts"
check 'a spec outside tests/ is named' "$tmp/stray" 1 'old/legacy.spec.ts'

# Every test in a spec skipped — a dead webServer leg or an inverted skip guard.
make_workspace "$tmp/allskipped"
python3 - "$tmp/allskipped/apps/e2e/test-results/results.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for s in d['suites']:
    if s['file'] == 'beta.spec.ts':
        s['specs'][0]['tests'][0]['status'] = 'skipped'
d['stats'] = {"expected": 2, "unexpected": 0, "flaky": 0, "skipped": 2}
json.dump(d, open(p, 'w'))
PY
check 'a spec whose tests all skipped is named' "$tmp/allskipped" 1 'beta.spec.ts'

# The opt-in spec RAN, so its exemption is stale.
make_workspace "$tmp/stale"
python3 - "$tmp/stale/apps/e2e/test-results/results.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for s in d['suites']:
    if s['file'] == 'settings/auth-login.spec.ts':
        s['suites'][0]['specs'][0]['tests'][0]['status'] = 'expected'
d['stats'] = {"expected": 4, "unexpected": 0, "flaky": 0, "skipped": 0}
json.dump(d, open(p, 'w'))
PY
check 'a stale OPT_IN exemption is named' "$tmp/stale" 1 'OPT_IN_SPECS'

# The @integration spec appears in the report — either E2E_INTEGRATION leaked
# into CI (spending real model credit per run) or the file gained an untagged
# test. Both must be loud.
make_workspace "$tmp/filteredRan"
python3 - "$tmp/filteredRan/apps/e2e/test-results/results.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['suites'].append({
    "title": "chat", "file": "chat/send-message.spec.ts",
    "specs": [{"title": "sends", "file": "chat/send-message.spec.ts",
               "tests": [{"status": "expected"}]}]})
d['stats'] = {"expected": 4, "unexpected": 0, "flaky": 0, "skipped": 1}
json.dump(d, open(p, 'w'))
PY
check 'an @integration spec appearing in the run is refused' "$tmp/filteredRan" 1 'FILTERED_SPECS'

# An exemption naming a spec that no longer exists — a list nobody maintains.
make_workspace "$tmp/deadExemption"
rm "$tmp/deadExemption/apps/e2e/tests/chat/send-message.spec.ts"
check 'an exemption naming a deleted spec is refused' "$tmp/deadExemption" 1 'does not exist on disk'

# A report describing a checkout that is not this one — a stale results.json.
make_workspace "$tmp/staleReport"
rm "$tmp/staleReport/apps/e2e/tests/beta.spec.ts"
check 'a report naming a deleted spec is refused' "$tmp/staleReport" 1 'do not exist on disk'

# --- REGISTERED_MODULES, in both directions ---------------------------------
#
# A module is not a spec, so `find -name '*.spec.ts'` cannot police it. These
# four cases are what stops "not a spec" from quietly becoming "not checked".

# The module stops being registered — the import deleted, the register call
# dropped, the importing spec renamed. On disk and healthy-looking, absent from
# every run. This is the exact guarantee the list exists to preserve, and the
# case that would have passed if registered modules were simply waved through.
make_workspace "$tmp/moduleUnregistered"
python3 - "$tmp/moduleUnregistered/apps/e2e/test-results/results.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['suites'] = [s for s in d['suites'] if s['file'] != 'chat/session-read-state.ts']
d['stats'] = {"expected": 2, "unexpected": 0, "flaky": 0, "skipped": 1}
json.dump(d, open(p, 'w'))
PY
check 'a registered module missing from the run is named' \
  "$tmp/moduleUnregistered" 1 'chat/session-read-state.ts'

# The module is collected but everything in it skipped — held to assertion 3
# exactly as a spec is, rather than counting as present-and-therefore-fine.
make_workspace "$tmp/moduleSkipped"
python3 - "$tmp/moduleSkipped/apps/e2e/test-results/results.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for s in d['suites']:
    if s['file'] == 'chat/session-read-state.ts':
        s['specs'][0]['tests'][0]['status'] = 'skipped'
d['stats'] = {"expected": 2, "unexpected": 0, "flaky": 0, "skipped": 2}
json.dump(d, open(p, 'w'))
PY
check 'a registered module whose tests all skipped is named' \
  "$tmp/moduleSkipped" 1 'chat/session-read-state.ts'

# An entry naming a module that no longer exists — the same "list nobody
# maintains" refusal the exemption lists get.
make_workspace "$tmp/deadModule"
rm "$tmp/deadModule/apps/e2e/tests/chat/session-read-state.ts"
check 'a REGISTERED_MODULES entry naming a deleted file is refused' \
  "$tmp/deadModule" 1 'does not exist on disk'

# The mirror, and the reason the list is a door rather than an amnesty: a
# non-spec file in the report that nobody listed is still a stale report. Without
# this, "ignore anything that is not a *.spec.ts" would have been an equally
# green fix and a far worse one.
make_workspace "$tmp/unlistedModule"
python3 - "$tmp/unlistedModule/apps/e2e/test-results/results.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['suites'].append({
    "title": "chat/rogue-module.ts", "file": "chat/rogue-module.ts",
    "specs": [{"title": "rogue runs", "file": "chat/rogue-module.ts",
               "tests": [{"status": "expected"}]}]})
d['stats'] = {"expected": 4, "unexpected": 0, "flaky": 0, "skipped": 1}
json.dump(d, open(p, 'w'))
PY
check 'a non-spec file in the report that nobody registered is refused' \
  "$tmp/unlistedModule" 1 'chat/rogue-module.ts'

# A failing test must not be certified as a healthy run.
make_workspace "$tmp/red"
python3 - "$tmp/red/apps/e2e/test-results/results.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['stats']['unexpected'] = 1
json.dump(d, open(p, 'w'))
PY
check 'a failed test fails the assertion' "$tmp/red" 1 'did not pass'

# No report at all — the suite never started, or --reporter replaced the json one.
make_workspace "$tmp/noreport"
rm "$tmp/noreport/apps/e2e/test-results/results.json"
check 'a missing report is refused' "$tmp/noreport" 1 'no Playwright JSON report'

# A report that exists but is not a Playwright report.
make_workspace "$tmp/garbage"
echo '{"hello":"world"}' >"$tmp/garbage/apps/e2e/test-results/results.json"
check 'a non-Playwright report is refused' "$tmp/garbage" 1 'not a Playwright JSON report'

# The zero-test run: a report Playwright really does write when a webServer leg
# times out (verified: stats all zero, exit 1). The gate must not certify it.
make_workspace "$tmp/empty"
cat >"$tmp/empty/apps/e2e/test-results/results.json" <<'JSON'
{ "suites": [], "stats": { "expected": 0, "unexpected": 0, "flaky": 0, "skipped": 0 } }
JSON
check 'a run that executed nothing is refused' "$tmp/empty" 1 'exist on disk but no test'

# A stats block that exists but lost its numeric fields — what a JSON-reporter
# shape change looks like. Before the guard, bash compared "" with -ne, printed
# "integer expression expected" to stderr, and the gate EXITED 0 having checked
# nothing: the fail-open this suite exists to make impossible. The suites here
# are the healthy workspace's, so only the stats shape is wrong — the refusal
# must come from the shape guard, not from a spec-set mismatch.
make_workspace "$tmp/statsless"
jq '.stats = {}' "$tmp/healthy/apps/e2e/test-results/results.json" \
  >"$tmp/statsless/apps/e2e/test-results/results.json"
check 'a stats block with no numbers is refused, not skipped past' \
  "$tmp/statsless" 1 'no longer carries numeric'

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
