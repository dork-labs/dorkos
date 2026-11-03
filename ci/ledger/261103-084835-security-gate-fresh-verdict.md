---
id: 261103-084835
title: security-gate waits for main's fresh verdict on PRs into main, so a first run after a label stops going red
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

## Why

The gate and `security-review-initialize` start on the same label event. The gate read the old status 1-5s before the verdict wrote the new one, so the first run after a PR became approved went red until someone reran it. On the marketplace copy that was 3 of 3 (DOR-3710).

## What changes

- **On a PR into main,** once the labels the gate reads pass, it polls this head's `security-review` for up to 90s, for a finished status newer than the last label change, push, force push, base change and the event's own `updated_at`. A stale or pending status is never judged on. If time runs out, or a time is unreadable, it fails.
- **A PR into any other base, and the merge queue,** judge the status they read, as before. Main's verdict only runs for PRs into main.
- **One deadline** covers base-move restarts, so the waits can't reach the job's 5-minute limit.

## Hypothesis

First runs that go red after a label and pass on rerun go from most of them to 0 over the 14 days after merge. Security reads it from the run list; no collector metric covers it yet.

Revert if a labelled PR into main times out at 90s with a verdict that did run, or if a PR passes on a status older than its last label change.
