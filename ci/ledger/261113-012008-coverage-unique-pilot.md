---
id: 261113-012008
title: An on-demand per-file coverage reading of shared or server, on CI only
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.coverage-unique.cover
  - wf.coverage-unique.combine
prs: []
ratchet-release: []
field-changes: []
---

## Why

Refs DOR-4190. Codebase Cleanup's Phase 4 prunes tests that add no unique
coverage, and its rule says to record what bug-catching value survives before a
deletion. Nothing in the repo says which test files reach source lines no other
file reaches. Finding out runs every test file on its own with coverage:
thousands of processes, which must never run on a team Mac.

## What changes

- **A new `workflow_dispatch` workflow, `coverage-unique`**, with one input:
  `package`, a choice of `shared` or `server`, mapped in the job to a fixed
  directory and package name and refused otherwise.
- **`cover`, 16 parallel chunks.** Each lists the package's own test files
  (`vitest list --filesOnly`, so the package's include and exclude apply), skips
  `*.binary.test.ts` (they need real runtime binaries CI runs elsewhere), and runs
  every 16th file of the sorted list on its own with v8 coverage and no retries.
  One file stops after 10 minutes and is recorded as a timeout.
- **`combine`** counts how many passing files reach each source line and writes
  `coverage-unique.json` and a summary: every passing test file with zero unique
  lines, largest first, with its length. Failed or timed-out files are left out
  of the counting and listed apart, so partial coverage cannot make a passing
  file look redundant. Kept 30 days.
- **Least access.** Workflow `permissions: {}`, each job `contents: read`, no
  secrets, `persist-credentials: false`, actions pinned to the SHAs this repo
  already uses.
- **One dev dependency:** `@vitest/coverage-v8` on `packages/shared` (the server
  already has it; the version is already in the lockfile).
- **Nothing else changes.** Not required, no PR, queue or push trigger, no effect
  on any gate that runs today.
- **`timeout-minutes: 120` per chunk is unmeasured.** Record the first run's
  times here and lower it.

**Read the output as a lead.** Zero unique lines means another file reaches the
same lines, not that it checks the same things. Lines that run when a module
loads are reached by every file that imports it, so they never count as unique.
The Stryker pilot and a reading of each file decide; protected test classes stay
whatever this says.

Revert if it is dispatched and its report is never read, or if a run holds 16
runners while the queue needed them.
