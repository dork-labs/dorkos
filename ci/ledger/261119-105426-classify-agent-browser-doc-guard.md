---
id: 261119-105426
title: List the Agent browser version guard as a repo-wide scripts suite
kind: hygiene
status: proposed
actor: agent
gates: []
prs: [4018]
ratchet-release: []
field-changes: []
---

DOR-4345 adds `scripts/__tests__/agent-browser-doc-versions.test.ts`, which
reads `docs/guides/agent-browser.mdx`, `packages/browser/package.json` and the
installed `playwright-core`'s `browsers.json`. `repo-wide-suites.test.ts`
refuses a suite that sits on neither list, so the new suite joins
`REPO_WIDE_SUITES` in `scripts/vitest.repo.config.ts`: one line, in
alphabetical order. That means it also runs in the merge queue, the same as the
other suites that read outside `scripts/`.

Nothing measurable should move. One more small suite (4 cases, well under a
second) runs in the repo-wide scripts step. No retry, skip, shard, worker cap,
required check, gate, steward or judge changes.

Revert if the suite turns out to read only `scripts/` (move it to
`HERMETIC_SUITES`), or if it makes the repo-wide step time out.
