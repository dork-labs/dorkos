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

- **1.1** Define authorized navigation descriptors and mention/activity summaries.
- **1.2** Persist owner-scoped manual order and qualified last destination, scroll, and draft state.
- **1.3** Make the qualified route the selection authority and implement keyed switch epochs, cancellation, and stream teardown.
- **1.4** Bind sends, uploads, retries, receipts, drafts, and read cursors to their source destination.

The phase gate is a route-driven context model that cannot render or mutate across owner/community boundaries. It combines view epochs with an owner/session/connection authorization generation so cleared state cannot be repopulated by late work. Tasks 1.1 and 1.2 may run in parallel; 1.3 consumes both, and 1.4 consumes the switch contract.

## Phase 2 — Responsive switcher (DOR-2184)

- **2.1** Build the shared switcher model and desktop popover in persistent sidebar chrome.
- **2.2** Render either the complete installation navigation or one Community's contextual navigation and offline state.
- **2.3** Build the phone trigger and bottom sheet without adding a fifth bottom tab.

These tasks share the frozen model and may run in parallel after their listed Phase 1 dependencies. The phase gate is complete pointer, keyboard, desktop, and narrow-width navigation with one active contextual body.

## Phase 3 — Lifecycle actions (DOR-2185)

- **3.1** Route Add, Connect, Join, Create, Deploy, Invite, Leave, Disconnect, and Sign out through DOR-2179.
- **3.2** Route tenant administration through DOR-2175, invalidate authority before cleanup, and clear state on authoritative removal/revocation.

This phase starts only after the referenced tenancy, administration, and membership contracts are implemented. The gate is exact authority separation and lifecycle cleanup without affecting another Community.

## Phase 4 — Isolation proof (DOR-2186)

- **4.1** Prove rapid-switch, late-event/mutation, delayed completion after revocation/owner change, same-host, independent-host, cache, and standalone isolation.
- **4.2** Prove keyboard, screen reader, touch, responsive, reduced-motion, zoom, long-label, and fifty-destination behavior.

Both proof tasks run in parallel after Phase 3. Neither configuration inspection nor unit tests alone satisfy the gate; browser evidence must exercise the real shell and delayed network/stream behavior.
