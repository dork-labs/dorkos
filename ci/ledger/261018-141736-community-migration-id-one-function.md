---
id: 261018-141736
title: The CLI and the release manifest compute the migration compatibility id with one function
kind: hygiene
status: proposed
actor: agent
gates: [wf.publish-community.build-and-publish]
prs: []
ratchet-release: []
field-changes: []
---

The space server's migration compatibility id was computed twice, by two
copies of the same loop: once in `packages/cli/scripts/build.ts` (baked into
the launcher) and once in `scripts/generate-community-release-manifest.ts`
(written into every release manifest the publish workflow attests). A launcher
refuses a release whose id differs from its own, so the two copies must agree
byte for byte, and nothing checked that they did (DOR-3006).

Both now call `communityMigrationCompatibilityId` in
`scripts/lib/community-migration-id.mjs`. The hash is unchanged: the same
`.sql` files in name order, each as its name, a NUL, its bytes and a NUL. The
space server's census (`apps/server/src/services/spaces/__tests__/promises/release-identity.test.ts`)
checks the function against that scheme, and that both producers call it on
the folder the server migrates from.

Hygiene, not an experiment: no gate timing or catch rate should move. Revert if
a release manifest's id ever differs from the one the same release's CLI bakes
in.
