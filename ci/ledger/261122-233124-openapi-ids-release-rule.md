---
id: 261122-233124
title: The API document carries the product version; the release rule and the export follow it
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4980 makes `docs/api/openapi.json` carry the product version. Three pipeline-adjacent
files follow: `scripts/export-openapi.ts` reads the repo `VERSION` and fails loudly instead
of writing `0.0.0`; the release-branch contents rule (`packages/cli/scripts/release-branch/`
`rules.ts` and `proof.ts`) accepts that file in a release commit when its only change is
`info.version` becoming the release version; `scripts/vitest.repo.config.ts` lists the new
`openapi-version.test.ts` as a repo-wide suite.

No gate's retries, shards, timeout or required status changes, and no metric should move,
so this is hygiene. Without the rule change, a release PR into `release/v*` would deadlock
between `openapi-fresh` (regenerates the document) and `release-branch-contents` (refused
the file). Revert if a release PR's `release-branch-contents` or `openapi-fresh` goes red on
the API document.
