# Implementation Summary: Know when a marketplace package has a new version

**Created:** 2026-09-23
**Last Updated:** 2026-09-23
**Spec:** specs/marketplace-version-truth/02-specification.md

## Progress

**Status:** Complete (3.1, the live verification, runs after this PR merges)
**Tasks Completed:** 16 / 17

## Tasks Completed

### Session 1 - 2026-09-23

**Workers:** dor2244-p1-marketplace, dor2244-p2-dorkos (implementation); dor2244-p1-review, dor2244-p2-review (adversarial review)

- Task #1.1: Bump flow to 0.7.3 in every version file (dork-labs/marketplace#38) — worker: dor2244-p1-marketplace
- Task #1.2: Repo version-agreement check — worker: dor2244-p1-marketplace
- Task #1.3: Bump-on-change check — worker: dor2244-p1-marketplace
- Task #1.4: Run both checks in the schemas workflow — worker: dor2244-p1-marketplace
- Task #2.1: Version primitives in @dorkos/marketplace — worker: dor2244-p2-dorkos
- Task #2.2: VERSION_MISMATCH + declaredVersion — worker: dor2244-p2-dorkos
- Task #2.3: sourceKeyOf normalizer — worker: dor2244-p2-dorkos
- Task #2.4: Record entryVersion and sourceKey at install — worker: dor2244-p2-dorkos
- Task #2.5: lookupCommitSha + resolveLatest — worker: dor2244-p2-dorkos
- Task #2.6: Total installed-identity reader — worker: dor2244-p2-dorkos
- Task #2.7: UpdateFlow rewrite (DOR-2251) — worker: dor2244-p2-dorkos
- Task #2.8: Route 404 + memo clear on refresh — worker: dor2244-p2-dorkos
- Task #2.9: CLI dorkos update — worker: dor2244-p2-dorkos
- Task #2.10: App toast for unknown checks — worker: dor2244-p2-dorkos
- Task #2.11: ENTRY_VERSION_MISMATCH — worker: dor2244-p2-dorkos
- Task #2.12: Docs, changelog, stale comments — worker: dor2244-p2-dorkos

**Workspace:** dorkos worktree `~/.dork/workspaces/dorkos/DOR-2244` (branch `DOR-2244`); dork-labs/marketplace worktree `marketplace-worktrees/DOR-2244` (branch `DOR-2244-version-gates`, merged as `ee1c8eb` in #38).

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/features/marketplace/model/use-update-with-toast.ts`
- `apps/server/src/routes/marketplace.ts`
- `apps/server/src/services/core/openapi-registry.ts`
- `apps/server/src/services/marketplace/flows/update.ts`
- `apps/server/src/services/marketplace/installed-metadata.ts`
- `apps/server/src/services/marketplace/installed-scanner.ts`
- `apps/server/src/services/marketplace/lib/install-roots.ts`
- `apps/server/src/services/marketplace/lib/source-provenance.ts`
- `apps/server/src/services/marketplace/marketplace-installer.ts`
- `apps/server/src/services/marketplace/package-fetcher.ts`
- `apps/server/src/services/marketplace/package-resolver.ts`
- `apps/server/src/services/marketplace/source-resolvers/git-subdir.ts`
- `apps/server/src/services/marketplace/source-resolvers/github.ts`
- `apps/server/src/services/marketplace/source-resolvers/relative-path.ts`
- `apps/server/src/services/marketplace/source-resolvers/url.ts`
- `apps/server/src/services/marketplace/types.ts`
- `changelog/unreleased/260923-133311-update-check-sees-new-versions.md`
- `contributing/marketplace-installs.md`
- `contributing/marketplace-packages.md`
- `contributing/marketplace-registry.md`
- `docs/api/openapi.json`
- `docs/guides/cli-usage.mdx`
- `docs/marketplace/index.mdx`
- `packages/cli/src/commands/update.ts`
- `packages/cli/src/commands/validate-source-paths.ts`
- `packages/marketplace/src/index.ts`
- `packages/marketplace/src/package-validator.ts`
- `packages/marketplace/src/package-version.ts`
- `packages/marketplace/src/source-resolver.ts`
- `packages/shared/src/marketplace-schemas.ts`

**Test files:**

- `apps/client/src/layers/features/marketplace/__tests__/use-update-with-toast.test.tsx`
- `apps/server/src/routes/__tests__/marketplace.test.ts`
- `apps/server/src/services/marketplace-mcp/__tests__/install-approval-binding.test.ts`
- `apps/server/src/services/marketplace/__tests__/flows/update.test.ts`
- `apps/server/src/services/marketplace/__tests__/install-address-policy.test.ts`
- `apps/server/src/services/marketplace/__tests__/installed-metadata.test.ts`
- `apps/server/src/services/marketplace/__tests__/installed-scanner.test.ts`
- `apps/server/src/services/marketplace/__tests__/integration.test.ts`
- `apps/server/src/services/marketplace/__tests__/marketplace-installer.test.ts`
- `apps/server/src/services/marketplace/__tests__/package-resolver.test.ts`
- `apps/server/src/services/marketplace/lib/__tests__/install-roots.test.ts`
- `apps/server/src/services/marketplace/lib/__tests__/source-provenance.test.ts`
- `apps/server/src/services/marketplace/source-resolvers/__tests__/git-subdir.test.ts`
- `apps/server/src/services/marketplace/source-resolvers/__tests__/github.test.ts`
- `apps/server/src/services/marketplace/source-resolvers/__tests__/relative-path.test.ts`
- `apps/server/src/services/marketplace/source-resolvers/__tests__/url.test.ts`
- `packages/cli/src/__tests__/update.test.ts`
- `packages/cli/src/commands/__tests__/validate-source-paths.test.ts`
- `packages/marketplace/src/__tests__/package-validator.test.ts`
- `packages/marketplace/src/__tests__/package-version.test.ts`
- `packages/marketplace/src/__tests__/source-resolver.test.ts`

## Known Issues

- **Direct installs from a non-default ref** (`name@url`) can't happen today: both direct forms resolve to `ref: 'main'`, `subpath: ''`. So there's a comment in `findTarget` instead of a note. Giving install requests a structured source is a separate change.
- **Every update request scans every scope** before the flow scans again. A name-less CLI run does it once per package. Handed to DOR-2194, whose all-packages route should scan once.
- **Out of scope, filed separately:**
  - DOR-2248: a cached tree can differ from its commit key.
  - DOR-2249: the package cache has no pruning owner.
  - DOR-2245: reinstall wipes a package's settings.
  - DOR-2246: flow's validator rejects configs missing defaulted fields.
- The Installed list now also shows Claude-Code-only installs that fail today's validator. This is intended (installed trees are never gated).

## Implementation Notes

### Session 1

- **Order:** the marketplace landed first (#38, flow 0.7.3 plus the version-agreement and bump-on-change checks). DorkOS now refuses packages whose version files disagree.
- **Review:** each branch had an independent adversarial review (opus) with mutation testing, and the fixes were delta-verified.
  - Marketplace: 3 should-fix and 7 nits, all fixed.
  - DorkOS: 3 should-fix and 4 nits. 3 fixed with tests, 1 unreachable today and commented, 1 handed to DOR-2194.
- **Two deliberate deviations from the task text:**
  - The new installer types moved to `types.ts`, and `lib/source-provenance.ts` was added, to keep the installer under the 500-line limit.
  - The 2.8 approval test uses the gate's fail-closed path, because `marketplace.install` is `act` tier and agents are allowed.
