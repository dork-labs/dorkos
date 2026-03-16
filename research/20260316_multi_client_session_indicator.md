---
title: "Multi-Client Session Indicator: UX Patterns & Implementation Approach"
date: 2026-03-16
type: external-best-practices
status: active
tags: [presence, SSE, session-locking, multi-client, status-line, UX]
feature_slug: multi-client-session-indicator
searches_performed: 8
sources_count: 22
---

## Research Summary

When multiple clients share a session (web tab + Obsidian plugin + MCP agent), users need just enough awareness to avoid confusion — not a full collaborative presence system. The right model is closer to tmux's "2 clients attached" indicator than Figma's avatar stacks. The server already tracks all necessary data (`SessionBroadcaster.getClientCount()`, `SessionLockManager`), so this is primarily a data-plumbing and UX-design problem. The recommended approach is a `StatusLine.Item` badge that only appears when count > 1, backed by a lightweight presence SSE event piggybacked on the existing sync stream.

## Key Findings

### 1. Presence Indicator Calibration for Developer Tools

The central question is not "how do we show presence" but "how much presence information is appropriate for a non-collaborative tool". Research across tmux, VS Code Live Share, and terminal emulators reveals a clear pattern:

- **tmux** shows "2 clients attached" in the status bar only when relevant — no avatars, no names, no persistent display when solo
- **VS Code Live Share** uses color-coded cursors and a named participant list because it is an explicitly collaborative tool
- **Figma** uses avatar stacks because users actively need to avoid editing the same component

DorkOS is closer to tmux: users share sessions across devices or between Obsidian and web, but do not simultaneously co-author messages. The appropriate presence level is therefore **count + type (web/obsidian/mcp), visible only when count > 1**, with a tooltip on hover for detail.

### 2. Ghost Connection Handling

SSE connections can enter a "TCP half-open" zombie state where the server believes a client is connected but the client has silently disconnected (network change, browser tab freeze, device sleep). Industry practice:

- Send heartbeat comment (`:\n\n`) every 15–30 seconds
- Clients set a timeout of `heartbeat_interval + buffer` (e.g., 45s) and reconnect if missed
- Server-side: detect `res.close` event reliably in Node/Express; treat absence of heartbeat ACK as signal to purge after TTL
- A 30-second heartbeat with 60-second server-side TTL for "ghost" cleanup is a reasonable default for DorkOS (consistent with how the existing `SessionLockManager` uses TTL expiry)

Key insight: the existing broadcaster already cleans up on `res.on('close')`. The risk is phantom counts between TCP drop and OS-level socket close (can be up to 2 minutes on some platforms). A server-side heartbeat write failure detection (`res.write()` returning false) combined with a 60-second idle timeout is sufficient.

### 3. Presence Event Transport

Two viable patterns for delivering client count updates to the web client:

**Option A: Piggyback on existing sync SSE stream (`/api/sessions/:id/stream`)**
- Add a `presence_update` event type alongside existing `sync_connected`/`sync_update`
- Broadcaster emits when count changes (on register/deregister)
- Zero new infrastructure; client already has an established SSE connection

**Option B: Dedicated REST poll (`/api/sessions/:id/presence`)**
- Client polls on interval (e.g., every 5s)
- Simple, resilient to SSE edge cases
- Adds latency; presence changes feel sluggish

Option A is strongly preferred. The sync SSE stream is already open and persistent. Emitting a `presence_update` event costs one `res.write()` call per connection when count changes. No new HTTP endpoints, no polling.

### 4. Client Type Identification

The server currently stores `clientId` in `SessionLockManager` (which client holds the write lock) and passes `_clientId` to `SessionBroadcaster.registerClient()` (currently unused). The `X-Client-Id` header is already sent by `HttpTransport`. The Obsidian plugin and MCP clients would need to send distinct client ID prefixes to allow type inference:

| Client | Suggested ID prefix | Type label |
|--------|---------------------|------------|
| Web browser | `web-{uuid}` | "web" |
| Obsidian plugin | `obsidian-{uuid}` | "obsidian" |
| MCP external agent | `mcp-{uuid}` | "mcp" |

The broadcaster can infer type from the prefix without a separate registry. However, exposing exact client types in the UI warrants a brief privacy consideration (see Security section).

### 5. UX Patterns: What to Show

After reviewing Carbon Design System, Material 3, NN/g indicators guide, and the existing StatusLine compound component:

**Show:**
- Small badge or dot in the StatusLine when `clientCount > 1`
- Count: "2 clients" or just "2" with an icon
- On hover/click: tooltip listing types ("1 web · 1 obsidian")
- Animation: animate-in/out following existing `StatusLine.Item` pattern

**Do not show:**
- Indicator when only 1 client (the normal case; don't add noise)
- Named user identifiers (this is single-user; all clients belong to the same operator)
- Full-screen banners or toasts for connect/disconnect (too disruptive for developer flow)

**Lock state differentiation:**
When the current client does NOT hold the write lock (another client is actively sending a message), the indicator should shift from a neutral count badge to a yellow/amber warning state: "locked by another client". The input box is already disabled in this state; the indicator provides the reason.

### 6. Toast vs Inline for Connect/Disconnect Events

NN/g guidelines and Carbon Design System are clear: toasts are for transient confirmations of user-initiated actions. A remote client connecting to YOUR session is a system event, not a user action. Displaying a toast for every connection event would be disruptive in a workflow where a user might bounce between Obsidian and web multiple times per session.

The correct pattern: **silent state update to the status badge**. The badge changes from hidden to "2 clients" with a smooth animate-in (the existing StatusLine.Item animation handles this). No toast. The count decrements silently when a client leaves.

Exception: if the session is *locked* (another client is actively writing), an inline "locked" state on the input area is appropriate — this is a blocking condition the user must be aware of. This is separate from the presence count.

## Detailed Analysis

### Server-Side Architecture

The server already has all building blocks:

```
SessionBroadcaster
  ├── clients: Map<sessionId, Set<Response>>   ← count per session
  ├── getClientCount(sessionId?)               ← already implemented
  └── registerClient / deregisterClient        ← hooks for presence events

SessionLockManager
  ├── getLockInfo(sessionId)                   ← which client holds write lock
  └── isLocked(sessionId, clientId?)           ← lock status
```

The only missing piece: when `registerClient` or `deregisterClient` fires, broadcast a `presence_update` event to all OTHER clients on that session. This requires:

1. Storing client type alongside the `Response` object (extend internal client tracking to `Map<sessionId, Map<clientId, { res: Response; type: ClientType }>>`)
2. Emitting `presence_update` events when count changes
3. Exposing lock holder type in the event (from `SessionLockManager.getLockInfo()`)

Estimated server-side change: ~40–60 lines in `session-broadcaster.ts` + minor route change to pass client type from `X-Client-Id` header.

### Client-Side Architecture

The sync stream is consumed by `use-chat-session.ts`. The `stream-event-handler.ts` processes `StreamEvent` types. The flow for integrating presence:

1. Add `presence_update` to the `StreamEvent` discriminated union in `@dorkos/shared/types`
2. Handle it in `stream-event-handler.ts` to update a Zustand slice or local state
3. Add a `useClientPresence(sessionId)` hook in `entities/session/model/` that derives `{ clientCount, lockHolder }` from the stream
4. Add a `ClientPresenceItem` component in `features/status/ui/`
5. Wire it into `ChatStatusSection.tsx` as a new `StatusLine.Item`

The `StatusLine.Item` system already handles animate-in/animate-out, separator management, and visibility gating. The new item is `visible={clientCount > 1}` — no infrastructure changes needed.

### Lock State Visual Treatment

Two distinct states need different visual treatment:

| State | Visual | Meaning |
|-------|--------|---------|
| `clientCount > 1`, no lock contention | Neutral badge: "2 clients" with users icon | Informational only |
| `clientCount > 1`, locked by other client | Amber badge: "locked" with lock icon | Input blocked |
| `clientCount == 1` | Hidden (StatusLine.Item visible=false) | Normal state |

The input disabling when locked is already implemented. The indicator provides the human reason.

### Privacy and Security Considerations

Exposing client type labels ("obsidian", "mcp") is safe for a single-user tool — all clients belong to the same operator. However:
- Do not expose raw client UUIDs in the UI (no user value, potential fingerprinting vector)
- Client type is inferred from a prefix convention, not from trust-verified identity
- If DorkOS ever supports multi-user sessions, this model would need revisiting

### Performance Considerations

- `presence_update` events fire only when client count changes — at most once per client connect/disconnect, not per-message. Negligible load.
- Heartbeat: existing SSE streams should already have heartbeat logic; if not, add 30s `:\n\n` comment writes. These are ~3 bytes and cost nothing.
- No polling required. No new HTTP endpoints required.
- Client count state can live in a simple `useState` in `use-chat-session.ts` or a dedicated hook — no Zustand slice needed unless presence state needs to be shared across components beyond `ChatStatusSection`.

## Comparison of Approaches

### 1. Status Bar Badge (Recommended)

**Description:** `StatusLine.Item` with `visible={clientCount > 1}`. Shows count and lock state. Tooltip on hover lists client types.

**Pros:**
- Consistent with existing StatusLine compound component pattern
- Already animates in/out via existing `AnimatePresence` infrastructure
- Non-disruptive: hidden when solo (the common case)
- Precise: distinguishes count-only from locked state

**Cons:**
- Small target; users may not notice it at first
- Requires piggybacking `presence_update` events on sync SSE stream

**Complexity:** Low
**Maintenance:** Low — follows established pattern, easy to extend

### 2. Session Header Indicator

**Description:** Small pill near session title in the sidebar or chat header.

**Pros:**
- More prominent, easier to notice on first encounter

**Cons:**
- Sidebar items are dense; a presence badge would need careful spacing
- Harder to integrate without touching more components
- Chat header area does not currently exist as a dedicated component

**Complexity:** Medium
**Maintenance:** Medium

### 3. Tooltip/Popover with Details (Enhancement of #1)

**Description:** Badge from Approach 1, but clicking opens a popover listing each connected client with type and connection duration.

**Pros:**
- Rich information available on demand without cluttering the UI
- Follows progressive disclosure principle

**Cons:**
- Additional complexity; requires managing popover state
- Tooltip on a small status item may be hard to trigger on touch

**Complexity:** Low-Medium (build on top of Approach 1)
**Maintenance:** Low — can be a v2 enhancement

### 4. Toast Notification on Connect/Disconnect

**Description:** Show ephemeral toast ("Obsidian client connected") when a client joins or leaves.

**Pros:**
- Very noticeable; cannot be missed

**Cons:**
- Disruptive to developer flow — NN/g explicitly warns against toasts for system events outside the user's current task
- Toasts for connection churn (Obsidian plugin reconnecting) would be noisy
- Accessibility barriers (screen reader interruption)

**Complexity:** Low
**Maintenance:** Low, but wrong UX choice

**Verdict: Do not use for connect/disconnect. Reserve toasts for blocking errors only.**

### 5. Inline Message Annotation

**Description:** Annotate each chat message with which client sent it ("sent from Obsidian").

**Pros:**
- Provides history of which client was active at each point

**Cons:**
- Visual clutter on every message
- The session model (shared JSONL) doesn't currently track originating client per-message
- Adds complexity to the message rendering layer

**Complexity:** High
**Maintenance:** High

**Verdict: Out of scope for the initial feature. Could be revisited if multi-user sessions are ever supported.**

## Sources & Evidence

- "Any number of tmux instances may connect to the same session" — [tmux Manual Page](https://man7.org/linux/man-pages/man1/tmux.1.html)
- "Toast notifications are more disruptive than inline notifications and are best used with system-generated messages that do not correspond to a specific section of the UI" — [Carbon Design System: Notifications](https://carbondesignsystem.com/patterns/notification-pattern/)
- "Badges show notifications, counts, or status information on navigation items and icons" — [Material Design 3: Badges](https://m3.material.io/components/badges/guidelines)
- "Status dots save space as compared to other UI elements like badges" — [Mobbin: Status Dot](https://mobbin.com/glossary/status-dot)
- "Heartbeat events sent periodically (~every 1 minute) to keep SSE connections alive" — [Datto Engineering Blog: SSE Live UI](https://datto.engineering/post/powering-a-live-ui-with-server-sent-events)
- "Without client-side timeout or heartbeat detection, SSE connections can wait indefinitely" — [SSE Starlette: Client Disconnection Detection](https://deepwiki.com/sysid/sse-starlette/3.5-client-disconnection-detection)
- Active vs inactive user sorting in avatar stacks — [Primer Avatar Stack](https://primer.style/components/avatar-stack/figma/)
- Indicators vs validations vs notifications taxonomy — [NN/g: Indicators, Validations, and Notifications](https://www.nngroup.com/articles/indicators-validations-notifications/)

## Research Gaps & Limitations

- No direct research on how VS Code or JetBrains handle multiple IDE windows on the same project folder (not a perfect analog but informative)
- Heartbeat frequency recommendation (30s) is based on general SSE practice; DorkOS may need tuning based on observed connection churn in production
- Client type inference via ID prefix is a convention, not enforced — could be bypassed by a custom MCP client that doesn't follow the prefix scheme

## Contradictions & Disputes

None significant. There is broad agreement in the literature that:
1. Non-collaborative tools should show less presence information than collaborative ones
2. System-initiated events (client connects) should not use toasts
3. The indicator should be hidden in the common case (single client) and appear only when relevant

## Search Methodology

- Searches performed: 8
- Most productive search terms: "SSE presence tracking multiple clients", "tmux multiple clients same session", "toast vs inline indicator presence", "ghost connection SSE heartbeat timeout"
- Primary sources: tmux man pages, Carbon Design System, Material Design 3, NN/g, Datto Engineering Blog, SSE Starlette docs, existing DorkOS codebase (`session-broadcaster.ts`, `session-lock.ts`, `StatusLine.tsx`, `ChatStatusSection.tsx`)
