---
id: 261123-194934
title: a pull request whose diff no browser leg loads skips the four PR smoke shards
kind: experiment
status: proposed
actor: agent
gates:
  - wf.browser-test.text-only-scope
  - wf.browser-test.browser-smoke
  - wf.browser-test.browser-test
  - wf.scripts-test.fixtures
prs: []
hypothesis:
  metric: 'tracked.job-minutes-per-merged-pr'
  baseline: 1052.4
  baseline_source: 'origin/ci-steward-data:reports/2026-W47.md, job minutes per merged PR (338865 job minutes in all). Direct reading for the shape this targets: replaying scripts/browser-smoke-scope.sh over the last 400 first-parent commits on main (2026-11-14 to 2026-11-23, base 1ba6bd079d) scores 44 (11%) as touching nothing a browser leg loads: desktop-only fixes, test-only and fixture-suite changes, workflow and ledger changes, docs, research and changelog notes.'
  target: 1040
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-5111. browser-test.yml runs four `browser-smoke` shards (a server and client build,
Chromium, and the `@smoke` Playwright set, about 20 minutes each) on every pull request
push, inside the required `browser-test` check. A PR that only changes another workflow,
a server test folder, a fixture suite, a ledger entry or the docs pays that for code no
page loads. The text-only lane (261120-043306) already lets a string-only change skip the
smoke; nothing let a change that is not code a browser runs skip it.

The change: `scripts/browser-smoke-scope.sh`, deny by default. Every changed path (both
sides of a rename) must be on its inert list, or the smoke runs: the root CHANGELOG.md and
README.md, `changelog/`, `docs/`, `blog/`, `research/`, Markdown under `contributing/`,
`ci/ledger/`, every workflow but browser-test.yml, `scripts/__tests__/` and
`scripts/test-*.sh`, `__tests__` folders at a package root or under its `src/` (never in
apps/e2e), and five workspaces outside the browser apps' dependency closure
(apps/design-system, apps/desktop, apps/site, packages/ci-steward, packages/evals), minus
their package.json and ci-steward's `bin/` (heavy-run-lock.sh sources it on every e2e run).
Client and server source, apps/e2e, every package the browser apps reach, any
package.json, the lockfile, root config, `scripts/` itself and browser-test.yml run the
smoke. `scripts/test-browser-smoke-scope.sh` pins every entry and near-miss, and checks
the inert workspaces against the real tree on every run: a new dependency on one, or a
code path into one from the browser apps, the packages they reach or the scripts the
smoke runs, turns it red.

A new step in the `text-only-scope` job runs the script from the BASE commit on a pull
request (not into `release/`) the text-only lane left on `full`. On `false` it sets the
job's `browser` output to `none`, the answer the fan-in already accepts, so browser-smoke
is skipped and `browser-test` passes. No new `if:`, no path filter, and the required
context still reports on both events. A `merge_group` build and the main canary never
reach the script: they always run the six browser shards and the first-run journey, so
the queue stays the safety net under a wrong "no browser" verdict.

Measure: per skipped PR push, the four smoke jobs' minutes (about 80 job-minutes), and the
count of runs whose log says "No-browser lane". At about 11% of merges the scored per-PR
mean may move by less than its weekly noise; read the direct counts if it comes back
`inconclusive`.

Revert, or shorten the inert list, if a queue ejection or a red main canary traces to a
change this lane let skip the PR smoke, or if any run whose diff touches apps/client,
apps/server outside its test folders, apps/e2e or a package in the browser apps' closure
logs "No-browser lane".
