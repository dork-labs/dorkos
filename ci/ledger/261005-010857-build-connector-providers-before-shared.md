---
id: 261005-010857
title: Build connector-providers before shared wherever shared is built standalone
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.community-pg, wf.test.community-packaged]
prs: []
ratchet-release: []
field-changes: []
---

DOR-2715 moves the connector schemas out of `@dorkos/shared` into
`@dork-labs/connector-providers`, which is now published to npm with built
`.d.ts` types, and `@dorkos/shared` re-exports them under its old subpaths. So
`@dorkos/shared` cannot typecheck or build until `@dork-labs/connector-providers`
has a `dist/`, exactly as it already needs `@dork-labs/cloud-api` built first.

Turbo's `^build` covers every task that goes through it. The places that build
shared by hand, in a fixed order, now build connector-providers right after
cloud-api: the `community-pg` job in `test.yml`, `apps/community/Dockerfile`
(which also copies the package in) and `apps/community/acceptance/Dockerfile`.
`scripts/community-packaged-scope.sh` gains `packages/connector-providers/`
beside `packages/cloud-api/`, for the same reason that one is there: the image
builds it before shared. Its fixture suite pins the new entry.

`scripts/check-copy-spec-drift.ts` adds `packages/connector-providers/src` to
its copy roots. Without it, the move reads as the connector labels being
deleted from the app, and the advisory check goes red on copy that still renders.

Hygiene, not an experiment: no gate timing or catch rate should move beyond the
few seconds one more `tsc` costs. Revert the order change only together with the
move itself; without it, those jobs fail to build shared at all.
