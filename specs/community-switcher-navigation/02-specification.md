---
slug: community-switcher-navigation
number: 260920-205153
created: 2026-09-20
status: specified
linear-issue: DOR-2183
project: Community Navigation
---

# Community context and navigation contract

**Status:** Approved

**Date:** 2026-09-20

## Overview

The DorkOS app presents the local installation and every connected Community through one persistent context switcher. The selected context is always derived from a qualified route. Desktop uses a compact trigger and popover in persistent sidebar chrome; phone uses the same model in a bottom sheet opened from persistent top chrome. The contextual navigation underneath shows local DorkOS work or one Community's channels and settings, never a blended content surface.

## Goals

- Switch among the local installation, same-host tenants, and independent hosts without ambiguity.
- Preserve the last authorized channel, thread, scroll anchor, and draft independently for every owner, community, and room.
- Distinguish direct mentions from other unread activity without copying message content across tenants.
- Provide complete pointer, keyboard, screen-reader, narrow-width, offline, reload, and deep-link behavior.
- Prevent stale content, queries, streams, mutations, or notifications from appearing under another community during rapid switching.
- Route Add, Create, Join, Invite, Leave, and Settings to their proper authority boundaries.

## Non-goals

- Implementing multi-community persistence, admission, administration, or provider provisioning. DOR-2171, DOR-2175, and DOR-2179 own those contracts.
- A universal message search or combined content inbox across communities.
- Public tenant discovery, DorkOS Cloud organizations, cross-host account federation, or synchronizing manual order across installations.
- Replacing Home, Today, Library, the command palette, or the mobile bottom navigation.

## Context identity and descriptor

The client normalizes destinations into a discriminated `NavigationContextDescriptor`:

- `{ kind: 'installation', key: 'installation', label, icon }`
- `{ kind: 'community', key: 'community:' + ref, ref, remoteCommunityId, label, icon, pinnedOrigin, membershipState, connectionState, availability, unreadCount, mentionCount }`

`ref` is the local connection identity and scopes credentials and caches. `remoteCommunityId` qualifies same-host server requests. Labels and icons are presentation only and never authorize a request. The local server returns descriptors only for the authenticated local owner. Remote hosts return only memberships visible to the authenticated account; there is no public directory.

Lifecycle and connection state remain separate. A community may be active but offline, archived and readable, suspended, deletion-pending, disconnected, or pending approval. The switcher never infers revocation from a generic network error. DOR-2191's authoritative classification supplies disconnected/revoked state.

## Route and selection model

The URL is the only selected-context authority:

- Routes without a qualified Community address select the installation.
- `/channels?community=<ref>&id=<roomId>[&thread=<entryId>]` selects that Community.
- Tenant settings and membership routes carry the same local ref and remote UUID through their qualified route contract.
- A switch commits only when navigation commits. No global store changes the visible identity first.

Each community has a remembered last authorized destination: room ID, optional thread/root entry, and a bounded scroll anchor. The preference key includes local owner ID and connection ref; room data and drafts additionally include room ID. Remembered destinations are hints. On selection the server reauthorizes them. Missing, removed, private, archived, or stale rooms fall back to the first readable channel or a contextual empty state without revealing why a private ID failed.

The installation remembers its last local route separately. Back/forward navigates real context history. Reload and copied deep links derive the same active destination without reading a last-selected global value.

## Switch transaction and privacy boundary

Every context change follows one transaction:

1. Capture the target descriptor and destination while the current screen remains correctly labelled.
2. Navigate to the fully qualified target URL.
3. At route commit, increment a context epoch, key the contextual shell/body by destination key, and render the target skeleton or safe empty frame. Never retain the previous content DOM under the new label.
4. Cancel abortable TanStack Query reads under the previous community prefix, close its room/event streams, and detach its live subscriptions. Cached data may remain under its old qualified key for return navigation only while its owner/session/connection authorization generation remains valid.
5. Start only target-qualified descriptor, room, history, roster, attention, and stream reads.
6. Restore scroll only after the target room and anchor are authorized and rendered. Restore the target draft from its qualified key.

Late reads and SSE events carry the source community ref, context epoch, and an owner/session/connection authorization generation. They are discarded whenever either the captured epoch is no longer current or the captured authorization generation is invalid, including after A→B→A navigation; they never update an old source cache after the route has moved on. An ordinary context switch may retain already committed source-qualified cache data for return navigation while its authorization generation remains valid.

Sign-out, local-owner change, membership removal, and connection revocation first invalidate or tombstone the affected generation, then close work and clear caches, drafts, anchors, and streams before routing away. Every late query, event, optimistic commit, and retry result rechecks both guards before writing. A send/upload/retry captures `{ ref, remoteCommunityId, roomId, threadId, clientMutationId, contextEpoch, authorizationGeneration }` when submitted. Switching cannot retarget it. A source-bound mutation receipt is the sole epoch exception: while its captured authorization generation remains valid, it may settle only the exact idempotent record named by its source identity and `clientMutationId`. It cannot insert or replace room/history cache data for any newer epoch, clear a newer draft, or affect the visible target. The new context shows no success, failure, attachment, or optimistic row from it.

## Shell surfaces

### Desktop

A compact trigger lives in persistent sidebar header chrome above the contextual body. It shows the selected installation/community icon, name, state, and a chevron. The popover contains:

- the installation first;
- connected communities in manual order;
- mention count, then general unread signal, with accessible text;
- per-row offline/archived/pending/disconnected state;
- a final “Add community” action.

Opening focuses the selected row. Arrow keys move, Home/End jump, Enter/Space selects, and Escape closes and restores focus. Typeahead searches visible labels. `Cmd/Ctrl+Shift+K` opens the switcher from anywhere; no direct numeric shortcut is reserved. A row menu supports Move up/down, Community settings when authorized, and the exact membership/connection actions supplied by DOR-2179.

When the installation is selected, the existing Now/Today/Library model remains intact. When a Community is selected, the contextual body shows that Community's channels, saved/offline state, and tenant-scoped actions. Local agents and rooms do not disappear from storage; they are one switch away.

### Phone and narrow widths

The four existing bottom destinations remain unchanged. A persistent context trigger in the top bar opens a full-width bottom sheet with at least 44px rows, safe-area padding, search after eight visible communities, and the same order/status/action model. Selecting closes the sheet, commits navigation, and moves focus to the new page heading. Swipe dismissal and Escape cancel without changing context. Reordering uses explicit Move up/down actions rather than touch drag.

The sheet never mounts two active contextual bodies. Screen-reader labels include the destination name and state; badges are not color-only.

## Attention semantics

`mentionCount` means unread entries that directly address the signed-in member. `unreadCount` includes all unread entries, including mentions. The UI displays mentions as the primary badge and, when `unreadCount > mentionCount`, a quieter activity dot/count for the remainder. Counts are tenant-qualified, account-authorized, bounded for display, and contain no author, channel-private title, or message text.

Room rows follow the same rule. Marking one room read updates only its qualified cursor. Switching alone never marks content read. Aggregates refresh through tenant-scoped events or invalidation and cannot be combined under same-named rooms.

## Ordering and persistence

Manual order is stored in the local owner's DorkOS configuration as an ordered list of connection refs with a versioned schema migration. The installation is fixed first. Unknown/new refs append deterministically; removed refs are pruned after authoritative descriptor refresh; reconnected refs are treated as new unless the same credential record and ref survives. Writes use the config manager and work across concurrent windows without last-writer data loss.

Last destination and scroll anchors are bounded, owner-scoped preferences. Draft text and staged attachments remain in the existing qualified draft store and are never serialized into shared config. Signing out or changing local owner clears in-memory context and loads that owner's namespace before rendering descriptors.

## Lifecycle and action routing

“Add community” is a menu, not an authority shortcut:

- Connect existing community starts the DOR-2179 installation-pairing path.
- Join with invitation opens the clean tenant invitation path.
- Create community appears only to an authorized host operator and enters pending-owner creation.
- Deploy a new host opens the self-hosting guide/launcher and does not create a tenant.

Invite people, Community settings, Archive, Suspend, Delete, Transfer ownership, Leave community, Disconnect this installation, and Sign out route to DOR-2175/DOR-2179 controls. Visibility follows current authority; the server rechecks every action. A host operator is not granted content access by seeing host administration.

Archived communities remain selectable for authorized read-only history and owner restore/export controls. Suspended/deletion-pending communities show their safe state and allowed administrative path. Removed membership or revoked connection removes content immediately, closes streams, clears sensitive caches/view state, and routes to the installation or another authorized community.

## Failure and resume behavior

- Offline community: keep it selected, show saved channels/messages with a persistent “Offline” state, disable network-only actions, and retry without switching identity.
- Descriptor list unavailable: keep the route identity and show a contained retry state; never fall back to another community's cached descriptor/content.
- Stale deep link: return the non-disclosing tenant/room result, then offer the authorized channel list or installation.
- Switch request failure: remain in the old committed context with its old label and content; announce the failure.
- Rapid A→B→A: only the final epoch may render; B can update only B's cache after it is no longer visible and while B's captured authorization generation remains valid.
- Membership removal while open: invalidate A's authorization generation before canceling streams/queries and clearing state, then route away; delayed work from the old generation cannot repopulate A even after later A→B→A navigation.

## Accessibility and performance

The switcher is a named dialog/listbox pattern appropriate to the chosen Radix primitives, with one focus owner, predictable restore, visible focus, live state announcements, reduced-motion behavior, and no color-only signal. Desktop, 390px phone, zoomed 200%, pointer, keyboard, and screen reader are required evidence.

The initial shell fetches descriptors and aggregate counts, not every room history. Only the selected Community opens streams and detailed queries. Popover virtualization is unnecessary initially; searchable grouping begins after eight communities, and performance evidence covers 50 descriptors. Switching should show its safe target frame in the next paint and must never wait for the remote host before changing the labelled skeleton.

## Verification matrix

Use two owners; installation plus two tenants on host A and one tenant on host B; same-named channels; owner/admin/member roles; archived/removed membership; connected/revoked grants; online/offline hosts; two windows; desktop and phone viewports.

- Deep link, reload, back/forward, copied URL, and last-destination restore select the same authorized context.
- A→B and rapid A→B→A cancel/detach old work, show no old DOM frame, and accept no late event into the visible target.
- A send/upload submitted before switching remains bound to A; success/failure/receipt never appears in B. If A's membership, connection, session, or owner authority is invalidated before completion, the delayed result is discarded and cannot repopulate A after returning.
- Draft, scroll, thread, unread, mention, and mark-read state remain isolated for same room IDs across tenants/hosts/owners.
- Offline, stale, archived, suspended, removed, and revoked states route and announce truthfully without public enumeration.
- Keyboard, screen reader, reduced motion, 200% zoom, 390px touch, focus restoration, and manual reorder pass.
- Add/Create/Join/Invite/Leave/Settings/Disconnect/Sign out reach the correct upstream journey and preserve authority separation.
- Blocking DorkOS Cloud egress changes none of the behavior.

## Implementation phases

1. **Context foundation:** descriptor/attention contract, URL-derived selection, owner-scoped ordering and view-state keys, switch epoch/cancellation rules.
2. **Responsive switcher:** desktop popover, Community contextual sidebar, phone sheet, keyboard access, offline states.
3. **Lifecycle actions:** connect the accepted DOR-2175 and DOR-2179 routes and authoritative removal/revocation cleanup.
4. **Isolation proof:** browser race, accessibility, multi-host/same-host, lifecycle, performance, and standalone evidence.

## Open questions

None. Product and security choices are frozen for decomposition. Exact icon artwork may follow the existing generated-initial fallback until DOR-2175 tenant icons land.

## Related ADRs

- `decisions/260920-205153-route-owned-community-context.md`
- ADR 0005: Zustand UI state and TanStack Query server state
- DOR-2171 community tenancy contract (accepted branch/PR #1943; not assumed merged at authorship)
- DOR-2175 community administration lifecycle contract
- DOR-2179 membership journey contract

## References

- `apps/client/src/layers/features/dashboard-sidebar/ui/CommunityChannelGroups.tsx`
- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx`
- `apps/client/src/AppShell.tsx`
- `apps/client/src/layers/entities/community/model/use-community-connections.ts`
- `apps/client/src/layers/widgets/room-view/ui/RemoteCommunitySurface.tsx`
- `packages/shared/src/community-connections.ts`
