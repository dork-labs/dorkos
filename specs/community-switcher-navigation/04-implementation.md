# Implementation Summary: Community context and navigation contract

**Created:** 2026-09-20
**Last Updated:** 2026-09-23
**Spec:** specs/community-switcher-navigation/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 4 / 11 (1.1, 1.2, 2.2 and 3.2; audited against main 5cd6dd794 on 2026-09-23)

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

**Task 2.3 in progress:** Reuse the context model in persistent phone chrome.

- Mount the same route-owned trigger in the phone's persistent top bar and render its destinations
  through the shared responsive menu, which becomes a safe-area-aware bottom sheet below 768px.
- Preserve the four existing bottom destinations and mount no duplicate sidebar body.
- Keep rows at the shared 44px phone target, add search at eight Communities, and expose explicit
  up/down order actions instead of touch drag.

### Session 2 - 2026-09-23

**Tasks 3.1 and 3.2:** Route lifecycle actions and clean up ended connections (DOR-2185).

- The switcher's selected Community gets a "Manage <name>" submenu: Invite people, Community
  settings and Leave community open `/c/<id>/settings[/<section>]` on the Community's pinned origin
  (the person's own sign-in rechecks there); Disconnect confirms in the app and ends only the local
  connection. Move up/down moved into the same submenu.
- "Add community" is a submenu of three separate paths: Connect (Connections › Messaging, the
  pairing flow), Join with an invitation (opens a validated invite link on its own site) and Run your
  own community (the CLI guide). Create is not offered: see decisions below.
- Added a per-connection generation beside the owner epoch. Removal or revocation tombstones that one
  ref first, then cancels and erases its cache, then routes away only if it was on screen; content
  guards, cache keys and draft/receipt addresses all carry the generation.
- An app-level watcher treats only a `connected` → `reconnect-required`/missing transition as
  authoritative; unverified (offline) access changes nothing.
- The Community app honours the settings deep link and falls back to a role-allowed section.

Decisions to confirm: Create community is hidden because the local descriptor carries no
host-operator signal; Community sign-out stays on the Community's site; Invite visibility uses
lifecycle + reachability because the descriptor carries no role, and the Community page rechecks.

### Session 3 - 2026-09-23 (status audit)

- Sessions 1 and 2 landed on main as #1986 (7f90b1c17, attention aggregates), #1992 (d5d73c251, the switcher, contextual navigation and phone sheet) and #2002 (538a6c580, lifecycle actions and connection cleanup).
- The Phase 4 proof is PR #2015, still open. Along the way it found and fixed four gaps: ⌘⇧K inside text fields, the unannounced failed switch, a missing `menu` parent on the phone sheet, and sheet and popover scrolling. Those fixes are not on main yet. It reports two other gaps as not met: DOR-2240 and DOR-2241.

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
- `apps/client/src/layers/features/dashboard-sidebar/ui/context/CommunityContextSwitcher.tsx`
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

- None beyond Remaining Work. The earlier notes are resolved on main: the effective-capability projection landed in #1984 (7d365fc36), and the DOR-2191 stacking dependency merged as #1957.

## Remaining Work

- **DOR-2240 (Task 2.3):** after a selection on the phone, focus should move to the target page's heading. `focusPageHeading` in `CommunityContextSwitcher.tsx` finds nothing because no route renders a heading inside `main`, so this needs a page-heading decision first.
- **DOR-2241 (Task 1.4):** a draft should be restored after A→B→A. Drafts live in the keyed room surface and are scoped to the route epoch, so leaving a room drops them. They never cross owners or Communities. Restoring them needs a draft-store design.
- **DOR-2242 (Task 3.1):** Create community should be in the switcher for a host operator. The local connection descriptor carries no host-operator signal, so this needs a small contract addition first.
- **PR #2015 (Tasks 1.3, 2.1, 2.3, 4.1, 4.2):** merging it lands the Phase 4 proof and its four fixes: failed-switch announcement, ⌘⇧K in text fields, the phone sheet's `menu` role, and popover and sheet scrolling.

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
- Phone context checkpoint on 2026-09-21: 74 focused switcher, responsive-menu, and shell tests
  passed; client typecheck and changed-file ESLint passed. The phone keeps its four bottom
  destinations, mounts one persistent top trigger, opens a bottom sheet, searches eight or more
  Communities, and exposes keyboard-safe order actions.
