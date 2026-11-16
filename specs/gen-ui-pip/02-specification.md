---
slug: gen-ui-pip
id: 260711-175135
created: 2026-07-11
status: specified
---

# Live gen-UI widgets in PIP — play tic-tac-toe while you work

**Status:** Approved
**Author:** Claude (flow SPECIFY, DOR-298)
**Date:** 2026-07-11

## Overview

Pop an interactive `dorkos-ui` widget (tic-tac-toe board, checklist, form) out of the transcript into the floating PIP panel as a **live session-bound view**: the panel follows the session's newest widget as the agent re-emits it each turn, interactions dispatch through the unchanged `WidgetActionProvider` pipeline, and the view stays live even when the operator opens a different session. Third and final piece of the PIP trio (DOR-296 primitive, DOR-297 MCP Apps).

## Background / Problem Statement

Board-game widgets are re-emitted every turn — the agent posts a fresh board each move and older boards go stale (superseded). A PIP'd widget therefore cannot be a snapshot of one message. Three verified gaps stand between today's code and a live off-route view:

1. **Liveness:** `StreamManager` owns exactly one active-session durable stream (`stream-manager.ts:190-191`); `attachSession(B)` closes session A's connection (`:448-465`), freezing any off-route view of A.
2. **Latest-widget signal:** `isLatestMessage` is computed positionally inside `MessageList` (`MessageList.tsx:153`) and exists nowhere else.
3. **Retention:** the stream store's LRU evicts idle sessions past 20 (`session-stream-store.ts:300-310`); an idle PIP'd session is evictable.

Everything else is already placement-agnostic: `WidgetRenderer` needs only `{document, sessionId, isLatestMessage}`, `WidgetFence` owns partial-parse latching, and `WidgetActionProvider` takes `sessionId` as a prop.

## Goals

- Pop out any parsed widget from the transcript; the panel follows the session's newest widget-bearing message, including mid-stream re-emissions.
- Interactions in PIP behave exactly as inline: synchronous dispatch latch, optimistic `<ui_action>` message, pending state, origin-aware celebrations, supersede-on-newer-message.
- The PIP'd session's stream stays live across route changes **and across switching the main view to a different session**.
- The PIP'd session is never LRU-evicted while pinned.

## Non-Goals

- Pinning a specific message's widget (v1 follows the live session — ideation D1).
- Restore-to-transcript navigation (close-only exit, like `mcp_app`; the host stays router-free).
- Mobile PIP (DOR-299), stacking/multi-session PIP (primitive D3: replace-on-open).
- Shared dispatch latch between inline and PIP instances (ideation D5: dual-live accepted, self-healing).
- Server changes (each per-session SSE connection is already independent and replay-durable).
- Obsidian embedded-mode guarantees (should work via the same store/transport seams; verified on web only).

## Technical Dependencies

None new. Merged DOR-296/297 surfaces (`PipContent`, `PIP_RENDERERS`, `openPip`), `useSessionStreamStore`, `StreamManager`, gen-ui pipeline.

## Detailed Design

### 1. `StreamManager` pinned session slot (the risk concentration)

New fields: `pinnedSessionId: string | null`, `pinnedCwd: string | null`, `pinnedConnection: SSEConnectionLike | null`.

**Invariant:** when `pinnedSessionId === attachedSessionId`, the sessions share the ACTIVE connection and `pinnedConnection` is `null` (exactly one owner per connection, never two references to one connection). `pinnedConnection` is non-null only while the pinned session differs from the attached one.

Public API (TSDoc'd):

- `pinSession(sessionId: string, cwd?: string | null): void` — idempotent. If `sessionId === attachedSessionId`: record the pin (shared, no new connection). Else: open `pinnedConnection` via the existing `openSessionStream` path (same store binding, same replay semantics). Re-pinning a different session unpins the old one first (single-instance panel → single pin).
- `unpinSession(): void` — close `pinnedConnection` if open; clear pin state. Never touches the active connection.
- `getPinnedSessionId(): string | null` — for tests/debug symmetry with the attached getter.

Transition table (each row gets a dedicated unit test):

| Current state                          | Event                          | Result                                                                                                                                           |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| pinned A, attached A (shared)          | `attachSession(B)`             | The active connection is **transferred to the pinned slot** (no close/reopen — zero gap), then a fresh active connection opens for B             |
| pinned A, attached B (own pinned conn) | `attachSession(A)`             | The pinned connection is **transferred to the active slot** (adopted), `pinnedConnection` becomes `null` (shared again); no duplicate connection |
| pinned A, attached B                   | `attachSession(C)`             | Normal active re-target B→C; pinned connection untouched                                                                                         |
| pinned A (any)                         | `unpinSession()`               | Own pinned connection closed if present; shared case leaves the active connection alone                                                          |
| pinned A, attached B                   | `pinSession(C)`                | Unpin A (close its connection), then pin C per `pinSession` rules                                                                                |
| any pinned state                       | transport rebuild (`:414-430`) | The rebuild path must also rebuild the pinned connection (mirroring its active-session reattach logic); pin state survives the rebuild           |

Transfers move the `SSEConnectionLike` reference between slots without calling `close()`/`connect()` — the connection object is session-bound, so re-targeting slots is pure bookkeeping. The existing "single-transition rule" comment (`stream-manager.ts:418-420`) is the precedent for avoiding flicker.

`attachSession`'s early-return guard (`:450-453`) is unchanged. `closeSessionStream` is only called when the outgoing active connection is neither shared-with-pin nor transferable to the pin.

### 2. Stream-store eviction pin

`useSessionStreamStore` gains `pinnedSessionId: string | null` + `setPinnedSession(id: string | null)`. The eviction loop in `touchAndGet` (`session-stream-store.ts:300-310`) additionally skips `id === state.pinnedSessionId`. Set/cleared by the same lifecycle that pins the stream (below), so store retention and stream liveness always agree.

### 3. `LiveSessionWidget` (new, in gen-ui — the feature that owns fence knowledge)

`apps/client/src/layers/features/gen-ui/ui/LiveSessionWidget.tsx`, exported from the gen-ui barrel. Props: `{ sessionId: string }`. Responsibilities:

- **Lifecycle effect:** on mount, `streamManager.pinSession(sessionId, cwd)` + `setPinnedSession(sessionId)`; on unmount (or `sessionId` change), unpin both. The cwd comes from the session's stream state or the attached cwd at pin time (implementer verifies which the open path needs; `openSessionStream` takes `cwd`).
- **Subscribe:** `useSessionStreamState(sessionId)` (feature → entity, legal).
- **Find the newest widget fence:** internal helper `findLatestWidgetFence(state): { code, isIncomplete, sourceMessageKey, isLatest, isStreaming } | null` — scans messages newest-first for the last ` ```dorkos-ui ` fence (last fence within the newest message that has one), and considers in-progress streaming text so a mid-emission board appears live with `isIncomplete: true`. Pure function, unit-tested; lives in `features/gen-ui/lib/`.
- **`isLatestMessage` re-derivation (ideation D4):** interactive iff the fence's source message is the newest message in the session projection — the exact mirror of `MessageList.tsx:153`'s positional rule (implementer reads `MessageList` to match array composition, including optimistic messages and in-progress turns, and encodes the parity in a test).
- **Render:** the existing `WidgetFence` with `{code, isIncomplete, sessionId, isLatestMessage, isStreaming}` — reusing its forward-only document latching rather than re-implementing parsing (ideation D8). Rendered element identity stays stable (module-scope component; no inline closures — the `StreamingText.tsx:40-49` hazard).
- **Empty state:** if the session has no widget fence (or the store has no session), render a quiet placeholder ("No live widget in this session") — reachable if the panel is open when a session's history is cleared.

### 4. PIP wiring (pip-panel + slice)

- `app-store-pip.ts`: `PipContent` gains `{ kind: 'widget'; sessionId: string; title: string }`.
- `PipHost.tsx`: `widget` entry in `PIP_RENDERERS` → a module-scope adapter rendering `<LiveSessionWidget sessionId={content.sessionId} />` (pure cross-feature UI composition). No `onRestore` (ideation D7). The exhaustive `never` guard forces this case at compile time.

### 5. Pop-out affordance (entry point)

In the transcript's widget fence chrome (`WidgetFence.tsx` or its fence wrapper — implementer picks the layer that has the hover container): a desktop-only (`useIsMobile()` guard) pop-out button, `PictureInPicture2` icon at the size matching adjacent chrome, `aria-label="Pop out into a floating window"`, shown when the fence has a successfully parsed document AND a `sessionId`. On click: `openPip({ kind: 'widget', sessionId, title: document.title ?? 'Widget' })`. Styling mirrors the DOR-297 header affordance. Must not interfere with widget interactions (positioned in chrome/overlay, not inside the widget tree).

### API / Data model changes

Client-only. No server or shared-package changes. No new localStorage keys.

## User Experience

1. The agent posts a tic-tac-toe board. Hovering the board (desktop) shows a pop-out button.
2. Click: the board appears in the floating panel at its remembered position; the inline board stays in the transcript.
3. The operator navigates anywhere — other pages, other sessions. The panel keeps showing the game; when the agent re-emits the board, the panel swaps to the newest one automatically.
4. Clicking a cell in the panel dispatches the move exactly as inline: optimistic mark, pending state, celebration from the clicked cell, board disabled once superseded by a newer message.
5. Opening a different widget or MCP app in PIP replaces the game (single instance). Closing the panel unpins the session; the transcript is untouched.
6. Below 768px nothing renders and affordances are hidden (primitive D2).

## Testing Strategy

- **Unit — StreamManager pin state machine** (fake `SSEConnectionLike`s, following existing stream-manager tests): every row of the transition table, plus: no duplicate connection when pinning the attached session; transfer preserves the connection object identity (no `close()` called); unpin of a shared pin leaves the active connection connected; transport rebuild restores both slots.
- **Unit — store eviction pin:** with 20+ sessions, the pinned idle session survives `touchAndGet` eviction; unpinning makes it evictable again.
- **Unit — `findLatestWidgetFence`:** newest-message-wins, last-fence-within-message, in-progress streaming fence with `isIncomplete`, sessions with no fences → null.
- **Component — `LiveSessionWidget`** (real store, seeded states): renders the latest board; appending a newer widget message swaps the rendered document (follow-the-live-game); appending a non-widget message flips to superseded (interaction disabled — parity with the transcript rule); a `ui` action still runs locally; an `agent` action dispatches via a mock transport with the right `sessionId` and posts the optimistic message; pin/unpin lifecycle calls fire on mount/unmount (spy on `streamManager`); empty state renders without crashing.
- **Component — pop-out affordance:** visible on a parsed widget with a session, hidden on mobile, `openPip` called with the right descriptor; a click on the affordance does not dispatch a widget action.
- **Component — PipHost:** `widget` kind routes to `LiveSessionWidget`; renderer identity stable across re-renders (extend the existing mount-count test).
- **Live proof (VERIFY stage):** play a real tic-tac-toe game in the dogfood cockpit with the board PIP'd, including a session switch mid-game — this is the operator's literal ask and the evidence bundle's centerpiece. If a live agent game is impractical in the run, drive a test-mode session and document the gap honestly.

## Performance Considerations

At most one extra SSE connection exists, and only while a PIP'd session differs from the active one (the three-connection ceiling: list + active + pinned). Fence scanning runs newest-first and short-circuits on the first widget-bearing message; re-parsing only occurs when that message's content changes (`WidgetFence` already memoizes/latches). The panel renders nothing when closed.

## Security Considerations

None new: widgets are first-party rendered content from the operator's own session transcript; dispatch rides the existing authenticated transport. The pinned stream uses the same auth/transport as the active one.

## Documentation

- Changelog fragment (user-facing — the headline of the trio).
- `docs/` check: if a gen-UI/widgets doc page exists, add the pop-out sentence (writing-for-humans register); skip silently if none mentions widgets.
- TSDoc on all new exports.

## Implementation Phases

- **Phase 1 — liveness plumbing:** StreamManager pinned slot + store eviction pin + unit tests (the state machine lands first and alone — it is the risk).
- **Phase 2 — the live view:** `findLatestWidgetFence` + `LiveSessionWidget` + tests.
- **Phase 3 — wiring + polish:** PipContent kind + PipHost case + pop-out affordance + changelog/docs + full verify + live browser proof.

(One PR; phases are ordering.)

## Open Questions

- ~~Does the server support a second concurrent per-session SSE consumer?~~ **(RESOLVED)** Answer: not needed — the pinned session and active session are different sessions, each with its own independent durable connection; the coinciding case shares one connection by design. Rationale: spec 255's per-connection snapshot/replay semantics; no server change.
- ~~Where does the fence-finding logic live?~~ **(RESOLVED)** Answer: inside gen-ui (`LiveSessionWidget` + `lib/find-latest-widget-fence`), consumed by pip-panel as pure UI composition. Rationale: keeps fence knowledge in the feature that owns it; avoids a gray-area cross-feature lib import.
- ~~Shared latch between inline and PIP instances?~~ **(RESOLVED)** Answer: no — dual-live accepted in v1 (ideation D5); the agent's next re-emission supersedes both. Rationale: consequences are mild and self-healing; the queue absorbs a mid-turn second action.

## Related ADRs

- `260711-175416-pip-liveness-via-pinned-background-stream-slot.md` (seeded from this spec)
- ADRs 260711-150550 / 260711-150551 (the primitive + descriptor pattern this consumes).

## References

- Linear: DOR-298 (this), DOR-296/297 (merged prerequisites, PRs #241/#244), DOR-299 (mobile follow-up).
- `specs/gen-ui-pip/01-ideation.md` — decisions D1–D8 with discovery line refs.
- `specs/pip-panel/` (primitive contracts), `specs/mcp-apps-host/` (consumer precedent).
- Key files: `stream-manager.ts:185-506`, `session-stream-store.ts:296-310, 444-653`, `widget-context.tsx:91-215`, `WidgetFence.tsx`, `WidgetRenderer.tsx`, `MessageList.tsx:153`, `StreamingText.tsx:33-70`, `PipHost.tsx`.
