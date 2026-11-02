---
id: 261102-210116
title: The two-desktop job's test app can be launched by Playwright, and a crash still writes a receipt
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

Run 41521611799 passed the build, Postgres and steps 1-4 at `v0.129.0`, then died at step 5: Playwright's `electron.launch` threw "Process failed to launch!". The shipped app turns the `enableNodeCliInspectArguments` fuse off (DOR-3053, #3220), and Playwright drives Electron through `--inspect`, so it could not launch the app at all. Playwright threw that error uncaught, so the run died with no `receipt.json`.

## What changes

- **The workflow builds and packages the app in its own step.** It uses the same commands as the journey's `--build`, but with `-c.electronFuses.enableNodeCliInspectArguments=true`, for this test build only.
- **A check step runs before the journey.** It confirms the binary runs (`ELECTRON_RUN_AS_NODE=1 … --version`), prints its signature, reads the inspect fuse back, and fails unless the fuse is on.
- **The journey runs without `--build`,** with `DEBUG=pw:browser*`.
- **The journey's own `--build` uses the same override.**
- **A crash outside a step still writes a receipt.** The journey handles an uncaught exception or rejection itself: it marks the step under way as failed, writes the receipt and cleans up.

## Hypothesis

Dispatches that fail before step 6 go from 2 of 2 to 0 over the 14 days after merge. QA reads it from the run list; no collector metric covers it yet.

Revert if a dispatch shows the override did not take and the launch still fails.
