# Implementation Summary: Check and apply updates across every installed package in one request

**Created:** 2026-09-23
**Last Updated:** 2026-09-23
**Spec:** specs/marketplace-update-all/02-specification.md

## Progress

**Status:** In review. One follow-up is sequenced after DOR-2248 (below).
**Tasks Completed:** 8 / 8

## Tasks Completed

### Session 1 - 2026-09-23

**Workers:** unknown (one implementer, working sequentially in worktree `DOR-2194`, base `3b36e3876`)

- 1.1 The ordered promise pool moved to `@dorkos/shared/map-with-concurrency`, and the session fan-out imports it.
- 1.2 `scanInstallationRecords(dorkHome, { agents } | { projectPath })`; the three list helpers are views over it.
- 1.3 `UpdateFlow.run` reads records, and its apply stays in the matched installation's scope (the global → project move fix). `name` is now required.
- 1.4 `UpdateFlow.checkInstallations` and `selectInstallations`, with the error naming every unmatched name.
- 2.1 `GET` / `POST /api/marketplace/updates`.
- 2.2 Shared wire types, OpenAPI paths, regenerated `docs/api/openapi.json` and the API pages.
- 3.1 A name-less `dorkos update` is one request.
- 3.2 The contributing guide, user docs, one changelog fragment (the five seeded stubs folded into it), and this record.

## Files Modified/Created

**Source files:**

- `packages/shared/src/map-with-concurrency.ts` (new), `packages/shared/package.json` (export), `packages/shared/src/marketplace-schemas.ts`
- `apps/server/src/services/session/agent-session-fanout.ts`
- `apps/server/src/services/marketplace/installed-scanner.ts`, `flows/update.ts`
- `apps/server/src/services/marketplace/flows/uninstall.ts`, `lib/locate-install.ts` (comments only)
- `apps/server/src/routes/marketplace.ts`, `apps/server/src/services/core/openapi-registry.ts`
- `packages/cli/src/commands/update.ts`
- `docs/api/openapi.json`, `docs/api/api/marketplace/updates/{get,post}.mdx`, `docs/marketplace/index.mdx`, `docs/guides/cli-usage.mdx`, `contributing/marketplace-installs.md`
- `decisions/260923-163034-updates-are-per-installation-in-their-own-scope.md` (draft ADR) and `decisions/manifest.json`

**Test files:**

- `packages/shared/src/__tests__/map-with-concurrency.test.ts` (new)
- `apps/server/src/services/marketplace/__tests__/installed-scanner.test.ts`
- `apps/server/src/services/marketplace/__tests__/flows/update.test.ts`
- `apps/server/src/services/marketplace/__tests__/integration.test.ts`
- `apps/server/src/routes/__tests__/marketplace.test.ts`
- `apps/server/src/services/core/__tests__/export-openapi.test.ts`
- `packages/cli/src/__tests__/update.test.ts`

## Known Issues

- **DOR-2248's typed git errors** (`GitRefNotFoundError`, `GitCommitNotFoundError`, `GitRemoteUnreachableError`, `GitFetchError`, in `lib/git-tree.ts` on that branch) are not mapped by `mapErrorToStatus` yet, because they do not exist on this base. A check already carries them as a per-installation `unknown` with DOR-2248's plain message, since `resolveLatest` turns every throw into `unresolved`. A failed reinstall in the all-packages door already carries them as that installation's `applyError`. What remains is the status for an error that escapes a route: the per-package apply, and anything the doors throw outside a check. Proposed: 404 for ref or commit not found, 502 for unreachable or fetch failed, each with the error's own message. This lands once DOR-2248 has merged.
- The per-package route still notifies `onPluginsChanged` with the request's `projectPath` after reinstalling a package that turned out to be global. That is harmless (the runtime rescans global plugins on every refresh, and auto-projection re-syncs a project that did not change), and it is left alone so the route's contract stays unchanged.

## Implementation Notes

### Session 1

- **Deviation from the issue:** `UpdateFlow.run({})` never walked agent scopes, so the "capability that exists" was only half there. The door scans every scope itself, through the scanner.
- **Deviation from the spec:** `mapWithConcurrency` lives in `@dorkos/shared`, not `apps/server/src/lib`, which is at the 25-file directory limit the pre-commit `dir-size` gate enforces. The spec and tasks record this.
- **Found and fixed:** an apply named with `--project` moved a globally installed package into that project. Reproduced with the real installer before the fix; the flow unit test and the integration test both fail on the base.
- **Mutation-checked:** reinstall scope, project precedence, the concurrency cap, the `selectInstallations` refusal, per-installation apply isolation, the memo clear after apply, caller spelling in the notification, the batch-approval refusal, a failed reinstall firing no refresh, and GET never applying. Each mutation turned at least one test red.
