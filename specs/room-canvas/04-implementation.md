# Implementation Summary: Canvas and Browser in rooms

**Created:** 2026-09-12
**Last Updated:** 2026-09-12
**Spec:** specs/room-canvas/02-specification.md
**Umbrella:** DOR-1995 (Linear project "Canvas and Browser in Rooms")

## Progress

**Status:** Complete
**Tasks Completed:** 7 / 7

Every phase ran in its own worktree, passed an adversarial review per `REVIEW.md` before its PR opened, and was verified in a browser at 1440 and 390 on the test-mode stack. The spec itself landed in PR #1801.

## Tasks Completed

- 1.1 DOR-1996 — [P0a] Generate one UI catalog, teach `apply_layout`, and land notify-and-reconcile — PR #1805
- 1.2 DOR-1997 — [P0b] Render `dorkos-ui` fences in room message bodies — PR #1804
- 1.3 DOR-1998 — [P1] Split the Browser into its own right-panel tab on `/session` — PR #1807
- 2.1 DOR-1999 — [P2a] Build the server-owned room canvas: table, service, and turn routing — PR #1808
- 2.2 DOR-2000 — [P2b] Build the room canvas client: shared tabs, live frames, human doors — PR #1809
- 2.3 DOR-2001 — [P2c] Document the room canvas and the Browser tab — PR #1811
- 3.1 DOR-2002 — [P3] Add pins, tab presence, and the #team board — PR #1812

## What shipped

- Rooms have a **Canvas tab** and a **Browser tab** in the right panel, the same two tabs a session has. The Browser is its own tab on both routes (ADR `260911-200304`).
- The room canvas is **server-owned**: `canvas_documents` rows keyed by scope, one writer (`RoomCanvasService.apply`), a `canvas` frame on the room stream modelled on `reaction` (no seq, resync on resume) (ADR `260911-200301`).
- An agent's `control_ui` and `browser_*` calls in a room turn are **routed by turn context** at the session-event seam: the claude-code handler applies synchronously and stamps the event `applied`; unstamped events (other runtimes, test mode) are applied by the collector's tap (ADR `260911-200303`).
- A canvas change **never triggers a turn**: a per-turn ledger posts one coalesced line at the end of the turn, capped by `rooms.maxCanvasOpsPerTurn` (default 3) (ADR `260911-200302`).
- Agents can read what is on the canvas through the `rooms.read_canvas` capability; humans edit with a 15 s edit-lock heartbeat; members see an unread dot only when another author opened or updated a document.
- Pins, who-is-looking-at-which-tab presence, and the #team board (P3).

## Files Modified/Created (main paths)

**Server:** `apps/server/src/services/rooms/canvas/{room-canvas-service,canvas-document-store,document-key}.ts`, `routes/room-canvas.ts`, `services/runtimes/shared/ui-tool-contract.ts` (generated catalogs, `documentId`), `services/runtimes/claude-code/mcp-tools/ui-tools.ts`, `services/session/session-event-normalizer.ts` (carries `applied`), `packages/db` migration for `canvas_documents`.

**Client:** `apps/client/src/layers/shared/model/app-store/{app-store-canvas,app-store-room-canvas}.ts` (two views over one store; the room slice), `features/canvas/ui/{CanvasViews,CanvasHeader}.tsx`, `features/canvas/ui/room/*`, `app/init-extensions.ts` (the `browser` right-panel contribution, gated on `Transport.supportsWorkbenchServe`).

**Docs:** `docs/guides/workbench.mdx`, `docs/concepts/rooms.mdx`, `docs/guides/generative-ui.mdx`, `.claude/commands/chat/rooms-test.md`.

## Follow-ups

- The follow-on spec `specs/canvas-agent-seat/` (DOR-2004) carries the session canvas to the server, lets an agent drive the browser, adds recording and attachments, runtime parity, follow mode, document threads, merge preview and `control_ui.target`.
- DOR-2012: the `skills-watcher` "fifty start/stop cycles" test flakes under load and blocked two pushes.
- DOR-1807 (merge Files, Canvas and Terminal into one Workspace tab) was linked, not adopted; reconcile there when it is picked up.
