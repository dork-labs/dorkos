---
id: 261031-091600
title: The file-size ratchet compares a queue build against main, not the previous queue entry
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

The `typecheck` job's file-size ratchet (DOR-2822) passes `--base` to `check:max-lines`, which refuses a hand-raised `scripts/max-lines/baseline.json`. It used `HEAD^1` on every event. In a queue build `HEAD^1` is the previous entry's queue commit, so the raise check saw only the newest entry.

On `merge_group` it now uses `merge_group.base_sha`, which is `main`, so the check covers every entry in the build. `pull_request` and the canary keep `HEAD^1`, where it already is the base.

Why now: under a HEADGREEN queue (ledger 261031-091500) an earlier entry merges on the last entry's build, and its own build is not awaited. Before this, a raise in that earlier entry was judged only in that unawaited build. The PR run already catches it, so this closes a narrow queue-only gap rather than an open one. No time or failure-rate change is expected.
