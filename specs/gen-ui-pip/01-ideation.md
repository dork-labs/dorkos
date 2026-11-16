---
slug: gen-ui-pip
created: 2026-07-11
status: ideation
---

# Live gen-UI widgets in PIP — play tic-tac-toe while you work

**Slug:** gen-ui-pip
**Author:** Claude (flow IDEATE, DOR-298)
**Date:** 2026-07-11
**Tracker:** DOR-298 - Pop live gen-UI widgets into PIP — play tic-tac-toe while you work

---

## 1) Intent & Assumptions

- **Task brief:** Let the operator pop an interactive gen-UI widget (tic-tac-toe board, checklist, form) out of the chat transcript into the floating PIP panel, so the game stays visible and playable while they navigate to other sessions or pages. Distinct from MCP-app PIP (DOR-297): tic-tac-toe is a `dorkos-ui` fenced widget rendered from transcript text, re-emitted fresh by the agent every turn — so PIP cannot be a snapshot of one message; it must be a **live session-bound view that follows the newest widget**. Direct operator ask: "play tic-tac-toe in PIP, instead of just inline."
- **Assumptions:**
  - The DOR-296 primitive + host and the DOR-297 `mcp_app` kind are merged (`PipContent` union, module-scope `PIP_RENDERERS`, mobile guard, no `onRestore` convention for v1 kinds).
  - The widget pipeline is already placement-agnostic at the props boundary: `WidgetRenderer` needs only `{document, sessionId, isLatestMessage}`; `WidgetActionProvider` takes `sessionId` as a prop, never from route context (verified: `features/gen-ui/model/widget-context.tsx:91-104`).
  - Transcript state lives in `useSessionStreamStore` (Zustand keyed by `sessionId`), which survives route changes by design (module doc, `entities/session/model/session-stream-store.ts:6-19`).
- **Out of scope:**
  - Pinning a _specific_ message's widget (v1 follows the live session — decision D1).
  - Restore-to-transcript navigation from the panel (close-only exit, matching `mcp_app`; the host is router-free and must stay so).
  - Mobile (inherits DOR-296 D2 / follow-up DOR-299).
  - Multi-session PIP or stacking; a second PIP'd game replaces the first (primitive D3).
  - Obsidian embedded mode guarantees (works through the same store/transport seams; verified on web only — demo-claim gate).

## 2) Pre-reading Log

- Linear DOR-298 description — capture ground truth: follow-the-latest, interactions must ride `WidgetActionProvider` (latch, optimistic mark, origin-aware celebrations), session binding must survive navigation, scope question pin-vs-follow.
- Consumer discovery sweep (this flow run, verified with line refs):
  - `WidgetRenderer.tsx:7-53` — minimal portable surface `{document, sessionId, isLatestMessage}`.
  - `MessageList.tsx:153` — `isLatestMessage` is purely positional (`virtualRow.index === messages.length - 1`) and exists nowhere else; a PIP view must re-derive it from the store.
  - `widget-context.tsx:127-178` — `dispatchedRef` is a synchronous per-mount latch; `agent` dispatch posts an optimistic `<ui_action>` message via `setOptimisticUserMessage` and sets `triggerPending`.
  - `StreamingText.tsx:40-49` — fence renderers must keep module-scope identity or the widget tree remounts mid-interaction (hazard already encoded in `PIP_RENDERERS`).
  - `WidgetFence.tsx:8-33` — latches the last successfully-parsed `WidgetDocument` so a mid-stream board never flickers back to a skeleton; reusable outside the transcript.
  - `stream-manager.ts:1-9, 189-191, 447-465, 501-506` — **the hard constraint**: exactly one active-session durable stream (`sessionConnection` singular); `attachSession(B)` closes A's connection; `detachSession` exists but is never called (navigating to non-session routes leaves the stream running — favorable). No multi-session subscription exists today.
  - `session-stream-store.ts:296-310` — LRU eviction (`MAX_RETAINED_SESSIONS = 20`) skips sessions with `inProgressTurn` activity, but an **idle** PIP'd session is evictable.
- `specs/pip-panel/01-ideation.md` + `02-specification.md` — primitive contracts (D1–D9), renderer-map conventions.
- Server side (from spec 255 / AGENTS.md): the per-session SSE stream (`GET /api/sessions/:id/events`) is durable and per-connection (snapshot → replay → live); two different sessions streaming to one client are two independent connections — no server change anticipated.

## 3) Codebase Map

- **New renderer:** `features/pip-panel/ui/WidgetPipContent.tsx` — subscribes to `useSessionStreamState(sessionId)`, finds the newest `dorkos-ui` fence, feeds `WidgetFence`/`WidgetRenderer` (import from the `gen-ui` barrel — cross-feature UI composition, FSD-legal).
- **Union + map:** `app-store-pip.ts` gains `{ kind: 'widget'; sessionId: string; title: string }`; `PipHost.tsx` gains the `widget` case (the `never` guard makes this a compile error until added — by design).
- **Stream liveness:** `shared/lib/transport/stream-manager.ts` — a pinned/background session attachment so the PIP'd session keeps receiving events when the active slot re-targets.
- **Eviction pin:** `entities/session/model/session-stream-store.ts` — the LRU must not evict the PIP-pinned session.
- **Entry point:** the pop-out affordance on interactive widget fences in the transcript — `features/gen-ui/ui/WidgetFence.tsx` chrome (or the fence wrapper in `StreamingText`), desktop-only, calling `openPip`.
- **Blast radius:** gen-ui (affordance), pip-panel (renderer), shared/model (union), shared/lib/transport (stream manager), entities/session (eviction pin). No server changes.

## 4) Root Cause Analysis

Not a bug fix — omitted.

## 5) Research

**The one hard problem — off-route liveness.** Three options:

1. **Do nothing (accept staleness):** PIP'd game stays live only while the active stream points at its session (same session page or non-session routes). Opening a _different_ session freezes the game.
   - Pros: zero stream-manager work. Cons: fails the explicit ask ("navigates to other sessions or pages"); a frozen board that still accepts clicks is worse than no PIP.
2. **Background session slot in `StreamManager` (recommended):** PIP pins its session; the manager guarantees a durable connection for the pinned session — shared with the active slot when they coincide, opened as a second connection when the active slot re-targets away. Ref-count is trivial (single instance: one pinned id or null).
   - Pros: solves the real ask; bounded scope (one file owns connections); the durable-stream protocol (`Last-Event-ID` replay) already makes reconnects gap-free; the server treats each connection independently.
   - Cons: connection-budget grows to three (list + active + pinned); the attach/re-target dance needs careful sequencing tests.
3. **Per-session connection pool:** generalize to N sessions.
   - Pros: future-proof. Cons: unneeded generality for a single-instance panel; invites resource sprawl. Rejected for v1 (option 2 degrades into this later if needed).

**Recommendation:** Option 2, plus the eviction pin.

**Dual-instance dispatch (PIP + inline both mounted):** each rendered board has its own per-mount latch, so a user could dispatch from both surfaces once each. Consequences are mild and self-healing: the transcript's existing queue semantics absorb a second `ui_action` mid-turn, and the agent's next board re-emit supersedes both instances. Shipping v1 with dual-live instances documented (mirrors the existing behavior when a user clicks a board just as the agent re-emits); no shared-latch machinery.

## 6) Decisions

| #   | Decision                    | Choice                                                                                                                                                                                                                  | Rationale                                                                                                                                                |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Pin vs follow               | **Follow the live session**: the descriptor is session-bound (`{kind:'widget'; sessionId; title}`); the renderer always shows the session's newest widget-bearing message                                               | The agent re-emits the board every turn; a pinned message goes stale in one move. Matches the capture's own framing ("a live view bound to the session") |
| D2  | Liveness architecture       | Background/pinned session slot in `StreamManager` (option 2) + LRU eviction pin for the pinned session                                                                                                                  | The ask explicitly includes navigating to other sessions; §5 trade-offs                                                                                  |
| D3  | Interaction semantics       | Reuse the inline pipeline verbatim: `WidgetFence` → `WidgetRenderer` with `sessionId` + re-derived `isLatestMessage` (source message is the store's newest message); dispatch/optimistic/pending/celebrations unchanged | The pipeline is prop-driven by design; PIP must not fork behavior — same rules, different placement                                                      |
| D4  | `isLatestMessage` off-route | Re-derived in `WidgetPipContent` from `useSessionStreamState`: interactive iff the widget's source message is the last message (mirroring `MessageList`'s positional rule)                                              | Only place the signal can come from off-route; exact mirror avoids divergent supersede behavior between inline and PIP                                   |
| D5  | Dual-instance dispatch      | Accept both-live instances in v1; document it                                                                                                                                                                           | §5 — mild, self-healing consequences; shared-latch machinery is not worth v1 complexity                                                                  |
| D6  | Entry point                 | Hover/persistent pop-out affordance on interactive widget fences (desktop only, `PictureInPicture2`, mirrors the MCP block header affordance), calling `openPip({kind:'widget', sessionId, title})`                     | Consistent affordance language with DOR-297; desktop-only matches the primitive's mobile stance                                                          |
| D7  | Exit semantics              | Close-only (no `onRestore`), like `mcp_app`; closing unpins the stream + eviction pin                                                                                                                                   | Host stays router-free; the transcript still renders the board inline                                                                                    |
| D8  | Streaming behavior in PIP   | Feed the newest fence's raw code through `WidgetFence` (not a pre-parsed document) with the store-derived `isStreaming`, so mid-stream boards latch forward exactly as inline                                           | `WidgetFence` already owns partial-parse latching; re-implementing it would fork the hazard it solves                                                    |

**Next step:** move to SPECIFY. The stream-manager attach/re-target sequencing is the risk concentration — the spec must pin its state machine (pin/unpin, coincide/diverge transitions, reconnect) and its test plan before EXECUTE.
