---
id: 261115-164021
title: Run the app frame's cross-app page spec in real Chromium on PRs that touch the frame
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.app-frame-browser.gesture-spec
prs: []
ratchet-release: []
field-changes: []
---

## Why

`apps/e2e/tests/extensions/app-navigate-gesture.spec.ts` checks when one app may open another app's page (DOR-3293). It lives in the `chromium-extension-seams` project, which only the merge queue runs. Its unit tests fake the browser's user activation, so a frame change could pass every PR check and red only in the queue, as an ejection. Security asked for it to run on the PRs that touch the frame.

## What changes

- **A new workflow, `app-frame-browser.yml`, with one job.** It runs on `pull_request` only, with a `paths:` filter: `apps/client/src/layers/features/extensions/frame/**`, the spec, its fixture and the workflow itself. It runs that one spec on that one project, with no site or production leg.
- **Not required, and it cannot be.** A path-filtered workflow reports nothing when skipped. No `merge_group` trigger: the queue's browser shards already run the spec. The required set and browser-test.yml are untouched.
- **`timeout-minutes: 30`.** About 8 minutes of setup and build (browser-test.yml's measured fixed cost), 3 to 5 of boot, about 2 for the spec.

Revert if it reds on PRs where the queue's run of the same spec stays green (the PR leg is then testing something the queue isn't), or if frame PRs stop being rare enough for one extra job to matter.
