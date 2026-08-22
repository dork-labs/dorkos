---
id: 260822-083229
title: Room management lives in the right panel's contribution registry, not a modal
status: accepted
created: 2026-08-22
spec: one-bar-header
superseded-by: null
amends: null
---

# 260822-083229. Room management lives in the right panel's contribution registry, not a modal

## Status

Accepted — shipped in PR #1174 (DOR-1403).

## Context

Room management (members, add-agents, topic, loudness, archive) lived in a modal `RoomDetailsDialog` opened from three doors. Sessions, meanwhile, already had a tabbed right panel built on the `RightPanelContribution` slot registry, with contextual tabs auto-selected over the global Pulse tab. The two surface models were diverging.

## Decision

Rooms adopt the session model: a **Room** tab registered as a `RightPanelContribution` (visible on room routes, priority set to beat a lingering Profile tab), hosting the former dialog's composition in panel layout. All doors go through one seam, `openRoomPanel(focus, roomId)` — the bar's members chip, the empty room's add-agents prompt, and the sidebar row menu — and a pending focus request survives in-flight navigation (released only when the on-screen room _changes_ to one the request wasn't about). The dialog is deleted.

## Consequences

- Rooms and sessions now share one side-surface model; future room surfaces (files, canvas) are contribution registrations, not new modals.
- The panel resolves the room the route shows — there is no global "selected room" state to drift.
- Mobile renders through the panel's existing overlay mode (safe-area padded); the modal's focus-trap a11y is replaced by explicit focus placement per door.
- The release-on-route-change semantics are subtle and pinned by mutation-proof tests; a future change to how Home resolves #team must re-check them (documented at the effect).
