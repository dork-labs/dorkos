# Multi-Client Session Indicator — Task Breakdown

**Spec:** `specs/multi-client-session-indicator/02-specification.md`
**Generated:** 2026-03-16

## Summary

6 tasks across 4 phases. This feature adds a real-time presence indicator to the status bar showing how many clients are connected to the current session. Hidden when solo, it animates in when a second client connects, shows a popover with client details, and pulses on sync updates.

## Phase 1: Shared Schema (1 task)

### 1.1 — Add PresenceUpdateEvent schema and presence_update event type to shared package [S]

Add `PresenceClientSchema` and `PresenceUpdateEventSchema` to `packages/shared/src/schemas.ts`. Add `'presence_update'` to `StreamEventTypeSchema` enum. Include `PresenceUpdateEventSchema` in the `StreamEventSchema` data union. Export types from `types.ts`.

**Files:** `packages/shared/src/schemas.ts`, `packages/shared/src/types.ts`

---

## Phase 2: Server Infrastructure (1 task)

### 2.1 — Refactor SessionBroadcaster to track client metadata and broadcast presence updates [L]

**Depends on:** 1.1

Replace `Map<string, Set<Response>>` with `Map<string, Map<string, ConnectedClient>>` to track client metadata (clientId, type, connection time). Activate the unused `_clientId` parameter. Add `inferClientType()` helper that detects `web-`, `obsidian-`, `mcp-` prefixes. Add `broadcastPresence()` method called on every register/deregister. Inject `SessionLockManager` to include lock state in presence updates. Add `getPresenceInfo()` public method.

Update constructor call site in `claude-code-runtime.ts` to pass lock manager. Update all existing broadcaster tests for new map structure. Add new tests for presence broadcasts, client type inference, and presence info retrieval.

**Files:** `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`, `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`, `apps/server/src/services/session/__tests__/session-broadcaster.test.ts`

---

## Phase 3: Client Integration (3 tasks)

### 3.1 — Add presence_update listener and pulse detection to use-chat-session hook [M]

**Depends on:** 1.1 | **Parallel with:** 2.1

Add `presenceInfo` and `presencePulse` state to the hook. Add `presence_update` EventSource listener to the persistent SSE connection. Detect sync_update events while multi-client to trigger a 1-second pulse. Clear presence on session change. Return both values from the hook.

**Files:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

### 3.2 — Create ClientsItem status bar component with icon states and pulse animation [M]

**Depends on:** 1.1 | **Parallel with:** 2.1, 3.1

Create `ClientsItem.tsx` in the status feature module. Shows Users icon + "{N} clients" in normal state, Lock icon + amber text when locked, scale pulse animation on sync. Includes a Popover listing connected client types with friendly names ("Web browser", "Obsidian plugin", etc.) and relative connection duration. Export from `features/status/index.ts` barrel.

**Files:** `apps/client/src/layers/features/status/ui/ClientsItem.tsx`, `apps/client/src/layers/features/status/index.ts`, `apps/client/src/layers/features/status/ui/__tests__/ClientsItem.test.tsx`

### 3.3 — Wire ClientsItem into ChatStatusSection [S]

**Depends on:** 3.1, 3.2

Add `presenceInfo` and `presencePulse` props to `ChatStatusSectionProps`. Thread from `useChatSession` through `ChatPanel` to `ChatStatusSection`. Render `ClientsItem` as a `StatusLine.Item` after the version item, visible only when `clientCount > 1`.

**Files:** `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx`, `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`

---

## Phase 4: Client ID Prefixing (1 task)

### 4.1 — Prefix web client clientId with web- for client type inference [S]

**Depends on:** 2.1

Change `HttpTransport` clientId generation from `crypto.randomUUID()` to `web-${crypto.randomUUID()}`. Expose `clientId` as optional on the `Transport` interface. Pass `clientId` as query parameter on SSE stream EventSource URL so the server can infer client type.

**Files:** `apps/client/src/layers/shared/lib/transport/http-transport.ts`, `packages/shared/src/transport.ts`, `apps/client/src/layers/features/chat/model/use-chat-session.ts`

---

## Dependency Graph

```
1.1 (schema)
 ├── 2.1 (server broadcaster)
 │    └── 4.1 (client ID prefixing)
 ├── 3.1 (hook listener) ──┐
 └── 3.2 (UI component) ───┤
                            └── 3.3 (wiring)
```

## Parallelism

- 2.1, 3.1, 3.2 can all proceed in parallel after 1.1
- 3.3 must wait for both 3.1 and 3.2
- 4.1 must wait for 2.1
