---
id: 261117-211123
title: List the deprecation-deadline scripts suite as repo-wide
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4188 adds `scripts/__tests__/deprecated-removal.test.ts`, which reads the
root `VERSION` and `packages/eslint-config`. `repo-wide-suites.test.ts` refuses
a suite that sits on neither list, so the new suite joins `REPO_WIDE_SUITES` in
`scripts/vitest.repo.config.ts`: one line, in alphabetical order. That means it
also runs in the merge queue, the same as the other suites that read outside
`scripts/`.

Nothing measurable should move. One more small suite (41 cases, about a
second) runs in the repo-wide scripts step. No retry, skip, shard, worker cap,
required check, gate, steward or judge changes.

Revert if the suite turns out to read only `scripts/` (move it to
`HERMETIC_SUITES`), or if it makes the repo-wide step time out.
