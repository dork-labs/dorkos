# Implementation Summary: Community context and navigation contract

**Created:** 2026-09-20
**Last Updated:** 2026-09-21
**Spec:** specs/community-switcher-navigation/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 0 / 11

## Tasks Completed

### Session 1 - 2026-09-20

**Task 1.2 in progress:** Persist owner-scoped order and qualified view state.

- Added a versioned, bounded owner-qualified config block and append-only migration.
- Added operation-based relative ordering over the latest saved state, with authoritative pruning.
- Added server-only room reauthorization before saving or restoring a remembered destination.
- Added browser transport methods whose responses contain only the current owner's state.
- Fenced draft rendering and late receipts when the local owner changes, and clear Community query
  data before publishing sign-out.
- Corrected the stale rapid A→B→A failure bullet to match the accepted epoch contract.

**Task 1.1 in progress:** Define the browser-safe navigation descriptor contract.

- Added stable installation and `community:<local-ref>` identities without exposing remote storage
  URLs through icon metadata.
- Kept membership lifecycle, local connection state, and network availability as independent axes.
- Bounded aggregate attention and enforced that direct mentions are a subset of unread activity.
- Left remote projection integration behind DOR-2173/DOR-2175 rather than inferring tenant
  lifecycle or a zero count from the current singleton API.

## Files Modified/Created

**Source files:**

- `packages/shared/src/config-schema.ts`
- `packages/shared/src/community-navigation.ts`
- `packages/shared/src/community-connections.ts`
- `apps/server/src/services/communities/community-navigation-preferences.ts`
- `apps/server/src/routes/community-connections.ts`
- `apps/client/src/layers/shared/lib/transport/community-methods.ts`
- `apps/client/src/layers/entities/community/model/use-community-navigation.ts`
- `apps/client/src/layers/widgets/room-view/model/use-remote-community-drafts.ts`
- `apps/client/src/layers/features/auth/model/use-auth-session.ts`

**Test files:**

- Owner-qualified ordering and destination helper tests.
- Config migration, disclosure, and write-policy drift guards.
- Preference-service concurrency, cleanup, and reauthorization tests.
- HTTP route and browser transport tests.
- Draft owner-switch and auth cache-isolation tests.

## Known Issues

- Task 1.2 is not complete until the wider Community query/cache namespace participates in the
  explicit owner and authorization-generation boundary required by tasks 1.3 and 1.4.
- The implementation is stacked on accepted DOR-2191 head
  `1d3be34510d072831cb58d49052879332dc96c1c`; do not open a PR until that dependency lands and the
  branch is reconciled with current `main`.

## Implementation Notes

### Session 1

- Isolated worktree: `/Users/doriancollier/.codex/worktrees/community-switcher-view-state/dorkos`
- Branch: `codex/community-switcher-view-state`
- Pinned base: `74f6737866e865c3b511485fe70a312a713fdf19`
- Accepted dependency merge commit in this branch: `64a8a3e2d0280878c2effb932c51ba99ed9dc8fc`
- The worktree has no local `.dork/flow/flow-state.json`; provenance is recorded here without writing to another checkout.
- Focused verification on 2026-09-21: 54 tests passed; server, client, and shared typechecks passed;
  changed-file ESLint passed. Config-manager's complete targeted suite passed 359/359.
