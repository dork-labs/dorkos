---
id: 261125-125850
title: List the work-order callers suite as repo-wide (DOR-5064)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

`scripts/__tests__/work-order-callers.test.ts` reads `contributing/prioritization.md`, `.dork/HEARTBEAT.md` and `AGENTS.md` and fails when one of them names a way to pick the next work without `flow order`. It reads files across the repo, so it joins the repo-wide suites in `scripts/repo-wide-suites.ts`, the way every other repo-reading suite does. Nothing measurable should move: one small suite, milliseconds. Revert if it ever flakes or blocks an unrelated PR, which would mean its phrase match is too broad.
