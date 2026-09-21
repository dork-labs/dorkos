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

**Tasks 1.2–1.4 in progress:** Fence browser data at the local-owner boundary.

- Added an opaque server-resolved owner key to the authenticated navigation bootstrap and made it a
  compare-only request precondition, never caller-selected authority.
- Invalidated the monotonic owner generation synchronously before sign-in, sign-up, sign-out, and
  auth-required transitions; protected queries, streams, drafts, receipts, and connection UI now
  stay unresolved until the server confirms the new owner.
- Qualified Community content keys by confirmed owner and authorization generation, and discard
  late reads, stream events, polling results, action results, and read-cursor completions after that
  generation changes.
- Added a cross-tab cookie-switch refusal so data returned for owner B cannot be stored under an
  already confirmed owner-A namespace.

**Tasks 1.3–1.4 in progress:** Fence content at the committed route boundary.

- Added a monotonically increasing route generation committed from successful router loads; the
  qualified community, room, and thread destination is the generation identity.
- Qualified room, history, roster, agent, and stream caches by the confirmed owner and route
  generation while preserving the owner/ref prefix used for revocation cleanup.
- Guarded late reads, stream events, action results, read cursors, agent enrollment, delivery
  receipts, and retry rows against both owner authorization and the captured route generation.
- Added a rapid A→B→A regression proving that an earlier A response cannot populate the returned A
  view even when owner authority never changes.

**Task 2.1–2.2 in progress:** Expose the route-owned context in persistent navigation.

- Extended the existing sidebar identity trigger into a keyboard-accessible context menu with the
  installation fixed first and connected Communities in the owner's saved order.
- Reauthorize a remembered room before navigation commits; a failed target read keeps the old
  route, label, and content intact.
- Render one contextual navigation body at a time. Installation routes retain Now/Today/Library;
  Community routes show only the selected Community's loading, unavailable, reconnect, empty, or
  channel state.
- Preserve an explicit Community route even when it has no readable room so the content surface
  shows a safe empty frame instead of falling back to local rooms.

## Files Modified/Created

**Source files:**

- `packages/shared/src/config-schema.ts`
- `packages/shared/src/community-navigation.ts`
- `packages/shared/src/community-connections.ts`
- `apps/server/src/services/communities/community-navigation-preferences.ts`
- `apps/server/src/routes/community-connections.ts`
- `apps/client/src/layers/shared/lib/transport/community-methods.ts`
- `apps/client/src/layers/entities/community/model/use-community-navigation.ts`
- `apps/client/src/layers/entities/community/model/use-community-connections.ts`
- `apps/client/src/layers/entities/community/model/use-remote-community.ts`
- `apps/client/src/layers/entities/community/model/use-remote-community-stream.ts`
- `apps/client/src/layers/shared/model/navigation/community-route-epoch.ts`
- `apps/client/src/router.tsx`
- `apps/client/src/layers/features/dashboard-sidebar/ui/CommunityContextSwitcher.tsx`
- `apps/client/src/layers/features/dashboard-sidebar/ui/CommunityChannelGroups.tsx`
- `apps/client/src/layers/features/dashboard-sidebar/ui/SidebarHeaderBlock.tsx`
- `apps/client/src/layers/features/dashboard-sidebar/ui/SidebarZones.tsx`
- `apps/client/src/layers/widgets/room-view/ui/ChannelsPage.tsx`
- `apps/client/src/layers/widgets/room-view/model/use-remote-community-drafts.ts`
- `apps/client/src/layers/widgets/room-view/ui/RemoteCommunityAgents.tsx`
- `apps/client/src/layers/widgets/room-view/ui/RemoteCommunitySurface.tsx`
- `apps/client/src/layers/features/auth/model/use-auth-session.ts`

**Test files:**

- Owner-qualified ordering and destination helper tests.
- Config migration, disclosure, and write-policy drift guards.
- Preference-service concurrency, cleanup, and reauthorization tests.
- HTTP route and browser transport tests.
- Draft owner-switch and auth cache-isolation tests.

## Known Issues

- The desktop switcher and contextual body are present; the persistent phone trigger and full
  bottom-sheet interaction remain in Task 2.3.
- Effective `read`, `post`, and `enrollAgent` capabilities will come from the reviewed Community
  administration contract. The local app must consume that server projection rather than infer
  write access from lifecycle, membership, or a restored read-only connection.
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
- Owner-boundary verification on 2026-09-21: 71 focused tests passed after one test-fixture cache-key
  correction; client and server typechecks passed; client, server, and shared lint completed with
  no errors (existing repository warnings remain).
- Route-boundary verification on 2026-09-21: 33 focused tests passed, including rapid A→B→A query,
  stream, receipt, and draft fencing; client typecheck and changed-file lint completed with no new
  errors (the pre-existing stream effect warning remains).
- Desktop context checkpoint on 2026-09-21: the focused header, contextual navigation, qualified
  channel route, and authority suites passed; client typecheck passed. The switch waits for
  destination reauthorization before committing and focuses the selected menu row when opened.
