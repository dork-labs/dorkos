---
id: 261102-193853
title: The two-desktop journey job builds what its script imports, and a failure leaves something to read
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.community-two-desktop.journey
prs: []
ratchet-release: []
field-changes: []
---

## Why

The first dispatch of `community-two-desktop.yml` at `v0.129.0` (run 41511053420) failed in 0.2 s, at "Run the journey", before any journey step. The script imports `@dorkos/shared` as soon as it loads, and its own `--build` builds only Desktop and the Space server, later. Nothing had built `@dorkos/shared`, so `dist/community-wire.js` was missing. The upload found no run folder, so the artifact was empty.

## What changes

A step builds everything `@dorkos/e2e` depends on (`turbo run build --filter='@dorkos/e2e^...'`) before the journey. The journey's console output is kept as `journey-output.log` and uploaded with the receipt. A last step writes each setup step's outcome to the job summary, whatever failed.

Reproduced without dispatching: in a clean worktree at `v0.129.0` with this harness, the script failed with the same `ERR_MODULE_NOT_FOUND`. After building `@dorkos/shared` it loaded and stopped at its opt-in check, as it should.

## Hypothesis

Dispatches of this job that end before the journey's first step go from 1 of 1 to 0 over the 14 days after merge. QA reads it from the run list; no collector metric covers it yet.

Revert if the extra build step makes the job time out.
