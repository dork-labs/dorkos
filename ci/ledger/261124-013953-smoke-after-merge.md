---
id: 261124-013953
title: Desktop packaged smoke and the CLI smoke jobs run after merge only, not on pull requests
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.desktop-smoke.packaged-runtime
  - wf.cli-smoke-test.build-tarball
prs: []
ratchet-release: []
field-changes: []
---

DOR-5130, approved by Dorian Nov 24. Week of Nov 16-22: the desktop packaged smoke failed 29 of 108
PR runs (mostly noise, 1,884 runner-minutes); the five CLI smoke jobs ran ~550 times a week on PRs
(~5,000 runner-minutes) and failed none. Both are advisory and already ran on push to main, so the
PR trigger goes; after-merge-alert.yml already watches "Desktop Smoke" and "CLI Smoke Test" and tells
the author of a merge that breaks them. Desktop keeps its ref-keyed concurrency (scarce macOS runner).

Baseline: ~6,900 PR runner-minutes a week on these, 29 red PR checks.
Target: 0 on PRs; any break they catch reaches its author within one push run.
Evaluate: Dec 1.

Revert if they start catching real breaks after merge more than once a week.
