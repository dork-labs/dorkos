---
id: 261115-151842
title: The real Codex binary suites also run on a hosted macOS runner, path-filtered and never required
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.codex-binary-macos.codex-binary-macos
prs: []
ratchet-release: []
field-changes: []
---

## Why

`test.yml`'s `codex-sandbox` runs the four real Codex binary suites on Linux only. The release gate for 0.135.11 needs a macOS result too, and the only way to get one was to run the binary on the team's Mac, which is off limits.

## What changes

- **A new workflow, `codex-binary-macos.yml`, one job on `macos-latest`.** Same four files and the same two protected probes as `codex-sandbox`, minus the bubblewrap setup. No secrets, read-only token, `persist-credentials: false`.
- **Runs on a pull request only when it can matter:** the Codex runtime folder, `apps/server/package.json`, `pnpm-lock.yaml` (a Codex bump), `VERSION` (every release PR) or the workflow itself. Also `workflow_dispatch`. Never on `merge_group`, never required, so no census entry and no deadlock risk.
- **Skips are allowed** because many app-server rows are Linux-only by design. A missing binary still fails: each file must pass at least one test and the binary-missing placeholder must not appear.

Expected cost: one macOS job per matching PR, a handful a week. Revert if it is red for reasons nobody reads, or if it holds macOS runners a release needs.
