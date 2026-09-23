---
slug: community-switcher-navigation
number: 260920-205153
created: 2026-09-20
status: decomposed
linear-issue: DOR-2183
project: Community Navigation
---

# Community switcher implementation plan

`03-tasks.json` is canonical. This view summarizes the four execution phases and tracker ownership.

## Phase 1 — Context foundation (DOR-2184)

- [x] **1.1** Define authorized navigation descriptors and mention/activity summaries. _#1986 (7f90b1c17) mention/unread aggregates and #1992 (d5d73c251) descriptors: `packages/shared/src/community-navigation.ts`, owner-only `routes/community-connections.ts`, with contract and transport tests._
- [x] **1.2** Persist owner-scoped manual order and qualified last destination, scroll, and draft state. _#1992: versioned owner-qualified `ui.communityNavigation.*` config with migration, `community-navigation-preferences.ts` (concurrent ordering, pruning, server-side reauthorization of a remembered room), with config-migration, disclosure and preference-service tests._
- [ ] **1.3** Make the qualified route the selection authority and implement keyed switch epochs, cancellation, and stream teardown. _Built in #1992 (`community-route-epoch.ts`, route-committed epochs, keyed surface, A→B→A regression). Open: a failed switch reverts silently instead of announcing the failure; the fix is in PR #2015, still open._
- [x] **1.4** Bind sends, uploads, retries, receipts, drafts, and read cursors to their source destination. _Built in #1992/#2002 (source-bound sends, receipts, cursors and drafts carrying owner, route and connection generations; `remote-community-drafts.test.tsx`). DOR-2241 (branch `feat/community-draft-restore`): an unsent draft now comes back after A→B→A, from the in-memory `entities/community` draft store keyed by owner, owner epoch, connection ref and generation, room and thread; it is erased when that connection ends and when the local owner changes (`community-drafts.test.ts`, the draft case in `community-rapid-switch.test.tsx`, and `community-switcher.spec.ts`)._

The phase gate is a route-driven context model that cannot render or mutate across owner/community boundaries. Reads and streams must pass both the current view epoch and owner/session/connection authorization generation. Only an exact source-bound idempotent mutation receipt may settle after an ordinary switch, and it cannot replace newer-epoch cache data; invalid authority discards every outcome. Tasks 1.1 and 1.2 may run in parallel; 1.3 consumes both, and 1.4 consumes the switch contract.

## Phase 2 — Responsive switcher (DOR-2184)

- [ ] **2.1** Build the shared switcher model and desktop popover in persistent sidebar chrome. _Built in #1992 (`CommunityContextSwitcher.tsx` in the sidebar header, keyboard navigation, move controls, attention labels). Open: PR #2015, still open, makes ⌘⇧K work inside text fields (including the composer) and lets the desktop popover scroll with many Communities._
- [x] **2.2** Render either the complete installation navigation or one Community's contextual navigation and offline state. _#1992: `CommunityChannelGroups.tsx` renders only the Community named by the route, and installation routes keep Now/Today/Library; offline, reconnect, empty and unavailable states in `ChannelsPage.tsx`/`RemoteCommunitySurface.tsx`._
- [x] **2.3** Build the phone trigger and bottom sheet without adding a fifth bottom tab. _Built in #1992/#2002 (one top-bar trigger, bottom sheet below 768px, 44px rows, search at eight); #2015 added the sheet's `menu` parent and 200% zoom scrolling. DOR-2240 (#2038): every page the switcher can land on now has a heading (`PageHeading` in `shared/ui`, undrawn; a Community page reads "Alpha · General"), and a phone choice that lands puts focus on it. Proven by `SidebarHeaderBlock.test.tsx` (focus after a phone choice) and `community-switcher-access.spec.ts` (phone heading focus at 390px)._

These tasks share the frozen model and may run in parallel after their listed Phase 1 dependencies. The phase gate is complete pointer, keyboard, desktop, and narrow-width navigation with one active contextual body.

## Phase 3 — Lifecycle actions (DOR-2185)

- [ ] **3.1** Route Add, Connect, Join, Create, Deploy, Invite, Leave, Disconnect, and Sign out through DOR-2179. _Built in #2002: Manage submenu (Invite, Settings, Leave open the Community's own pages; Disconnect ends only the local connection) and an Add submenu (Connect, Join with an invitation, Run your own community). Open: DOR-2242, Create community is not in the switcher because the connection descriptor carries no host-operator signal; sign-out stays on the Community's own site._
- [x] **3.2** Route tenant administration through DOR-2175, invalidate authority before cleanup, and clear state on authoritative removal/revocation. _#2002: per-connection generation in `shared/lib/community-authority-state.ts`, `endCommunityConnection` (tombstone, then erase, then route away), the app-level `use-community-revocation-cleanup.ts` watcher, and tenant-qualified settings routes; `community-lifecycle.test.tsx`, `community-context-actions.test.ts`, `use-community-revocation-cleanup.test.tsx`, and `community-switcher.spec.ts` (5/5)._

This phase starts only after the referenced tenancy, administration, and membership contracts are implemented. The gate is exact authority separation and lifecycle cleanup without affecting another Community.

## Phase 4 — Isolation proof (DOR-2186)

- [ ] **4.1** Prove rapid-switch and A→B→A epoch rejection, exact-record mutation settlement, delayed completion after revocation/owner change, same-host, independent-host, cache, and standalone isolation. _Open: the proof is PR #2015 (`community-rapid-switch.test.tsx`, `community-switching-proof.spec.ts`), still open._
- [ ] **4.2** Prove keyboard, screen reader, touch, responsive, reduced-motion, zoom, long-label, and fifty-destination behavior. _Open: the proof is PR #2015 (`community-switcher-access.spec.ts`), still open; it reports heading focus after a phone selection (DOR-2240) as not met._

Both proof tasks run in parallel after Phase 3. Neither configuration inspection nor unit tests alone satisfy the gate; browser evidence must exercise the real shell and delayed network/stream behavior.
