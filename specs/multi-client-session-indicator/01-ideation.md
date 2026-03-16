---
slug: multi-client-session-indicator
number: 142
created: 2026-03-16
status: ideation
---

# Multi-Client Session Indicator

**Slug:** multi-client-session-indicator
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/multi-client-session-indicator

---

## 1) Intent & Assumptions

- **Task brief:** Add a visual indicator when multiple clients are connected to the same session via SSE. Users currently have no way to know if another browser tab, Obsidian plugin, or external MCP client is also connected, causing confusion when messages appear "from nowhere" or when two clients send messages concurrently. P2 punch list item #18 from the Agent SDK audit.
- **Assumptions:**
  - The server already tracks SSE connections per session via `SessionBroadcaster` (which has an unused `getClientCount()` method)
  - Client identity can be derived from a prefix convention on the existing `X-Client-Id` header (`web-`, `obsidian-`, `mcp-`)
  - This is a single-user product — all clients belong to the same operator, so exposing client types is safe
  - The `StatusLine` compound component is the correct placement for this indicator
- **Out of scope:**
  - Real-time collaborative editing or cursor presence
  - Conflict resolution UI beyond existing `SESSION_LOCKED` error
  - Multi-user session support
  - Per-message client attribution in JSONL transcripts

## 2) Pre-reading Log

- `specs/cross-client-session-sync/02-specification.md`: Spec #25 documents existing sync infrastructure — Phase 1 polling, Phase 2 file watching via SessionBroadcaster. Established the `sync_connected` and `sync_update` SSE event types.
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`: Core SSE connection manager. Tracks clients per session in `Map<sessionId, Set<Response>>` with `totalClientCount`. Has `getClientCount(sessionId)` method that is **currently unused**. Sends `sync_connected` on client registration.
- `apps/server/src/routes/sessions.ts`: GET `/api/sessions/:id/stream` endpoint establishes SSE connection. Reads `X-Client-Id` from POST messages (line 153). Calls `runtime.watchSession()` with optional `clientId`. Currently sends `sync_connected` with only `sessionId`.
- `apps/server/src/services/runtimes/claude-code/session-lock.ts`: Session write lock manager. Tracks `clientId`, `acquiredAt`, `ttl` per lock. Prevents concurrent writes.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Client-side SSE listener. Establishes EventSource to `/api/sessions/{sessionId}/stream`. Listens for `sync_connected` (currently ignored) and `sync_update` (invalidates TanStack Query).
- `apps/client/src/layers/features/status/ui/StatusLine.tsx`: Compound component managing animated status bar items. `StatusLine` root + `StatusLine.Item` sub-component with `AnimatePresence` for entry/exit animations. Items receive data via props.
- `apps/client/src/layers/features/status/ui/CostItem.tsx`: Reference implementation — 15-line functional component for a status bar item. Clean pattern to follow.
- `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx`: Data fetching & composition layer for the status bar. Fetches git status, session status, server config via TanStack Query. Composes items into `StatusLine`.
- `contributing/design-system.md`: Design system guide — 8pt grid spacing, Lucide icons, `text-xs`/`text-2xs` typography scale, muted foreground colors for secondary info.
- `packages/shared/src/schemas.ts`: StreamEvent discriminated union. Already includes `sync_connected` and `sync_update` types. New event types need Zod schemas added here.
- `research/20260316_multi_client_session_indicator.md`: Research report covering presence patterns across developer tools, 5 approach comparison, heartbeat/ghost connection strategies.

## 3) Codebase Map

**Primary Components/Modules:**

Server-side:
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` — SSE connection manager. Has `registerClient()`, `getClientCount()`, broadcasts to all connected clients per session.
- `apps/server/src/routes/sessions.ts` — HTTP route handler for SSE stream and message sending. Reads `X-Client-Id` header.
- `apps/server/src/services/runtimes/claude-code/session-lock.ts` — Write lock manager per session/client.
- `packages/shared/src/schemas.ts` — Zod schemas for all StreamEvent types including `sync_connected`.

Client-side:
- `apps/client/src/layers/features/status/ui/StatusLine.tsx` — Compound component for animated status bar items.
- `apps/client/src/layers/features/status/ui/CostItem.tsx` — Reference 15-line status bar item component.
- `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx` — Composition layer that wires data into StatusLine items.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — SSE listener for sync events.

**Shared Dependencies:**
- `@dorkos/shared/schemas` — StreamEvent types
- `@dorkos/shared/types` — Transport interface (already accepts `clientId`)
- `lucide-react` — Icons (`Users`, `Lock`)
- `motion` — Animations (via StatusLine's existing AnimatePresence)

**Data Flow:**
```
Client connects → GET /api/sessions/:id/stream
  → SessionBroadcaster.registerClient(sessionId, res, clientId)
  → Broadcaster counts clients for this session
  → Broadcasts presence_update to ALL connected clients for this session
  → Client receives presence_update via EventSource
  → Updates local state (count, types, lockInfo)
  → StatusLine.Item renders badge (hidden if count ≤ 1)

Client disconnects → response close event
  → SessionBroadcaster removes client from Set
  → Broadcasts updated presence_update to remaining clients
```

**Feature Flags/Config:** None needed. Visibility controlled by existing `StatusLine.Item` `visible` prop (`visible={clientCount > 1}`).

**Potential Blast Radius:**
- Direct: ~5 files (broadcaster, sessions route, schemas, ChatStatusSection, new ClientsItem component)
- Indirect: None — StatusLine is designed for extension, schemas are additive
- Tests: SessionBroadcaster tests (new count/broadcast behavior), new ClientsItem component test, integration test for presence_update SSE

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

Research report: `research/20260316_multi_client_session_indicator.md`

**Potential solutions:**

**1. Status Bar Badge (StatusLine.Item)**
- A new `StatusLine.Item` with `itemKey="clients"` and `visible={clientCount > 1}`. Shows a count badge (e.g., "2 clients" with a Users icon). Hidden in the common single-client case. Follows the exact pattern of CostItem and GitStatusItem.
- Pros: Follows established pattern exactly; animate-in/out is free via existing AnimatePresence; zero noise when solo; cleanly separates count from lock state
- Cons: Small target; less noticeable on first encounter
- Complexity: Low (~40–60 lines server-side, ~80 lines client-side)
- Maintenance: Low

**2. Session Header Indicator**
- Small pill near the session title in the chat header area.
- Pros: More visually prominent
- Cons: No dedicated chat header component exists; would require touching multiple components; sidebar items already dense
- Complexity: Medium
- Maintenance: Medium

**3. Tooltip/Popover with Details (Enhancement of #1)**
- The badge from Approach 1 opens a popover on click listing each client type and its connection duration.
- Pros: Progressive disclosure — detail on demand
- Cons: Additional state; touch interaction awkward on small targets
- Complexity: Low–Medium (v2 enhancement on top of Approach 1)
- Maintenance: Low

**4. Toast Notification on Connect/Disconnect**
- Ephemeral toast when a client joins or leaves the session.
- Pros: Cannot be missed
- Cons: NN/g classifies toasts as inappropriate for system-generated events outside the user's task; Obsidian plugin reconnections cause noisy churn
- Complexity: Low
- Maintenance: Low — but wrong UX

**5. Inline Message Annotation**
- Annotate each message with its originating client.
- Pros: Full audit trail
- Cons: Visual clutter on every message; requires tracking message origin in JSONL; high complexity
- Complexity: High
- Maintenance: High

**Security considerations:**
- Exposing client type labels is acceptable for a single-user tool
- Do NOT expose raw client UUIDs in UI
- Client type is inferred from ID prefix convention, not verified identity

**Performance considerations:**
- `presence_update` events fire only on connect/disconnect, not per-message — negligible throughput
- Piggybacks on the already-open sync SSE stream
- Heartbeat: 30-second `:\n\n` comment writes to detect ghost connections; 60-second idle TTL before removing from count
- Client state needs only a `useState` — no new store slice

**Recommendation:** Status Bar Badge (Approach 1) with types-on-hover popover (Approach 3) as the implementation target.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Indicator placement | Status bar badge (`StatusLine.Item`) | Follows existing CostItem/GitStatusItem pattern exactly. AnimatePresence for free. Hidden when solo — zero noise in the common case. "Less, but better." |
| 2 | Client type visibility | Count + types on hover (popover) | Badge shows "2 clients"; tooltip/popover shows "Web browser, Obsidian plugin". Requires client ID prefix convention (`web-xxx`, `obsidian-xxx`, `mcp-xxx`) tracked in SessionBroadcaster. Progressive disclosure. |
| 3 | Message arrival cue | Subtle badge pulse | The client count badge briefly pulses when a `sync_update` arrives from another client's message. Low-key but noticeable — provides "someone else is here" awareness without over-notification. |
| 4 | Lock state integration | Amber lock icon when locked | When another client holds the write lock, badge shifts to amber with a Lock icon ("Locked by another client"). Explains why send might fail with SESSION_LOCKED before it happens. Single indicator for both count and lock state. |
