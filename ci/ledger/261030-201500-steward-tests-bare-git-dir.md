---
id: 261030-201500
title: The steward's observe tests name their bare origins with --git-dir
kind: hygiene
status: proposed
actor: agent
gates: []
prs: [3288]
ratchet-release: []
field-changes: []
---

The `observe.test.ts`, `daily-report.test.ts` and `data-branch.test.ts` helpers now
pass `--git-dir <origin>` when they target a bare origin, instead of running git
inside it by working directory.

Why: DorkOS agent shells inject `safe.bareRepository=explicit`, so git refuses to
discover a bare repository and these tests failed on every agent machine. CI doesn't
set that, so it stayed green.

This is a hygiene change: only test helpers change, and it claims no speed or flake
improvement in CI.
