# Task Breakdown: Relay, Mesh & Telegram Adapter — Code Review Remediation Round 2

**Spec:** `specs/relay-mesh-telegram-review-fixes-r2/02-specification.md`
**Generated:** 2026-02-28
**Mode:** Full decomposition
**Total Tasks:** 9 (across 3 phases)
**Issues Covered:** 6 critical (C1-C6), 10 important (I1-I10) = 16 total

---

## Phase 1: Telegram Adapter Fixes

### Task 1.1 — Fix reconnection bot leak and timer cancellation (C1, C2)

| Field             | Value    |
| ----------------- | -------- |
| **Size**          | Medium   |
| **Priority**      | High     |
| **Dependencies**  | None     |
| **Parallel with** | 1.2, 1.3 |

**File:** `packages/relay/src/adapters/telegram-adapter.ts`

**C1:** `handlePollingError()` creates a new `Bot` instance without calling `this.bot.stop()` on the old one, leaking the previous grammy polling loop.

**C2:** The `setTimeout` return value is discarded. If `stop()` is called during the delay window, the timer fires and creates a zombie polling loop. The reconnect guard only checks `'disconnected'` but `stop()` transitions through `'stopping'` first.

**Changes:**

1. Add `private reconnectTimer: ReturnType<typeof setTimeout> | null = null` field
2. In `handlePollingError`: assign timer to `this.reconnectTimer`, make callback `async`, add `'stopping'` state check, call `this.bot?.stop()` before creating new bot
3. In `stop()`: call `clearTimeout(this.reconnectTimer)` and null the field before unsubscribing signals

**Tests:** Reconnection stops old bot, `stop()` clears timer, timer doesn't fire after `stop()`.

---

### Task 1.2 — Fix webhook error handler leak and connection cleanup (I1, I2)

| Field             | Value    |
| ----------------- | -------- |
| **Size**          | Small    |
| **Priority**      | Medium   |
| **Dependencies**  | None     |
| **Parallel with** | 1.1, 1.3 |

**File:** `packages/relay/src/adapters/telegram-adapter.ts`

**I1:** Change `server.on('error', reject)` to `server.once('error', reject)` in webhook startup.

**I2:** Add `server.closeAllConnections()` before `server.close()` in `stopWebhookServer()` to destroy keep-alive connections.

**Tests:** Verify `once` usage, verify `closeAllConnections()` called before `close()`.

---

### Task 1.3 — Reject float chat IDs in extractChatId (I3)

| Field             | Value    |
| ----------------- | -------- |
| **Size**          | Small    |
| **Priority**      | Medium   |
| **Dependencies**  | None     |
| **Parallel with** | 1.1, 1.2 |

**File:** `packages/relay/src/adapters/telegram-adapter.ts`

Replace `Number.isFinite(id)` with `Number.isInteger(id)` in both the group format and DM format branches of `extractChatId()`.

**Tests:** Float values rejected in both DM and group formats.

---

## Phase 2: Relay Subsystem Fixes

### Task 2.1 — Fix BindingStore skipNextReload race with generation counter (C3)

| Field             | Value    |
| ----------------- | -------- |
| **Size**          | Medium   |
| **Priority**      | High     |
| **Dependencies**  | None     |
| **Parallel with** | 2.2, 2.3 |

**File:** `apps/server/src/services/relay/binding-store.ts`

Replace the `skipNextReload` boolean with a `saveGeneration` / `lastReloadedGeneration` counter pair. Each save increments `saveGeneration`. The chokidar handler skips reload when `lastReloadedGeneration < saveGeneration` (catching up to current generation).

**Tests:** Rapid successive saves do not trigger spurious reloads.

---

### Task 2.2 — Prevent duplicate dispatch between DeliveryPipeline and WatcherManager (C4)

| Field             | Value    |
| ----------------- | -------- |
| **Size**          | Medium   |
| **Priority**      | High     |
| **Dependencies**  | None     |
| **Parallel with** | 2.1, 2.3 |

**Files:**

- `packages/relay/src/delivery-pipeline.ts` — add `recentlyDispatched` set + `wasDispatched()` method
- `packages/relay/src/watcher-manager.ts` — accept `wasDispatched` callback, skip in `handleNewMessage`
- `packages/relay/src/relay-core.ts` — wire callback from pipeline to watcher

Set is capped at 10,000 entries to prevent unbounded growth.

**Tests:** `wasDispatched()` returns true, set is capped, watcher skips dispatched messages.

---

### Task 2.3 — Add Zod validation, SSE write guards, and sessionMap validation (I4, I5, I6)

| Field             | Value    |
| ----------------- | -------- |
| **Size**          | Medium   |
| **Priority**      | Medium   |
| **Dependencies**  | None     |
| **Parallel with** | 2.1, 2.2 |

**Files:**

- `apps/server/src/routes/relay.ts` — Zod schemas for 3 adapter routes (I4), `writableEnded` guards on SSE stream (I5)
- `apps/server/src/services/relay/binding-router.ts` — validate `sessionMap` JSON shape in `loadSessionMap()` (I6)

**Tests:** `loadSessionMap` handles non-array JSON, filters malformed entries.

---

## Phase 3: Mesh & Transport Fixes

### Task 3.1 — Fix Transport bypass in useMeshScanRoots with updateConfig method (C5)

| Field             | Value         |
| ----------------- | ------------- |
| **Size**          | Medium        |
| **Priority**      | High          |
| **Dependencies**  | None          |
| **Parallel with** | 3.2, 3.3, 3.4 |

**Files:**

- `packages/shared/src/transport.ts` — add `updateConfig()` to interface
- `apps/client/src/layers/shared/lib/http-transport.ts` — implement via `fetchJSON`
- `apps/client/src/layers/shared/lib/direct-transport.ts` — implement via `configManager.applyPatch`
- `apps/client/src/layers/entities/mesh/model/use-mesh-scan-roots.ts` — use `transport.updateConfig()`
- `packages/test-utils/` — add `updateConfig` to mock transport

**Tests:** `useMeshScanRoots` calls `transport.updateConfig()` instead of raw fetch.

---

### Task 3.2 — Complete compensating transaction in MeshCore register methods (C6)

| Field             | Value         |
| ----------------- | ------------- |
| **Size**          | Small         |
| **Priority**      | High          |
| **Dependencies**  | None          |
| **Parallel with** | 3.1, 3.3, 3.4 |

**File:** MeshCore service file (likely `apps/server/src/services/mesh/mesh-core.ts`)

Add `await removeManifest(candidate.path)` (in `register()`) and `await removeManifest(projectPath)` (in `registerByPath()`) to the Relay failure catch blocks, alongside the existing `registry.remove()` calls.

**Tests:** Both methods remove manifest file when Relay registration fails.

---

### Task 3.3 — Remove dead CrossNamespaceEdge animation and fix handleNodeClick stale closure (I7, I8)

| Field             | Value         |
| ----------------- | ------------- |
| **Size**          | Medium        |
| **Priority**      | Medium        |
| **Dependencies**  | None          |
| **Parallel with** | 3.1, 3.2, 3.4 |

**Files:**

- `apps/client/src/layers/features/mesh/ui/CrossNamespaceEdge.tsx` — remove dead `<animateMotion>` block (I7)
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` — use `layoutedNodesRef` in `handleNodeClick`, remove `layoutedNodes` from deps (I8)

**Tests:** CrossNamespaceEdge has no `<animateMotion>` or `<circle>` elements.

---

### Task 3.4 — Prevent ELK layout thrashing and extract relativeTime utility (I9, I10)

| Field             | Value         |
| ----------------- | ------------- |
| **Size**          | Medium        |
| **Priority**      | Medium        |
| **Dependencies**  | None          |
| **Parallel with** | 3.1, 3.2, 3.3 |

**Files:**

- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` — add `topologyFingerprint` memo, use as ELK effect dependency (I9)
- `apps/client/src/layers/features/mesh/lib/relative-time.ts` — new shared utility (I10)
- `apps/client/src/layers/features/mesh/ui/AgentNode.tsx` — remove inline `relativeTime`, import from shared (I10)
- `AgentHealthDetail.tsx` — remove inline `relativeTime`, import from shared (I10)

**Tests:** Layout not re-triggered on identical refetch, `relativeTime` handles null/NaN/future/all granularities.

---

## Dependency Graph

All tasks within each phase are independent and can be executed in parallel.

```
Phase 1 (all parallel):  1.1  1.2  1.3
Phase 2 (all parallel):  2.1  2.2  2.3
Phase 3 (all parallel):  3.1  3.2  3.3  3.4
```

Phases should be executed in order (1 -> 2 -> 3) to minimize risk, but there are no hard cross-phase dependencies. All tasks within a phase can run simultaneously.

## Issue-to-Task Mapping

| Issue | Severity  | Task | Description                                   |
| ----- | --------- | ---- | --------------------------------------------- |
| C1    | Critical  | 1.1  | Stop old bot before reconnection              |
| C2    | Critical  | 1.1  | Track reconnect timer for cancellation        |
| C3    | Critical  | 2.1  | Fix BindingStore skipNextReload race          |
| C4    | Critical  | 2.2  | Prevent duplicate dispatch                    |
| C5    | Critical  | 3.1  | Fix Transport bypass in useMeshScanRoots      |
| C6    | Critical  | 3.2  | Complete compensating transaction in MeshCore |
| I1    | Important | 1.2  | Webhook error handler leak                    |
| I2    | Important | 1.2  | Destroy keep-alive connections                |
| I3    | Important | 1.3  | Reject float chat IDs                         |
| I4    | Important | 2.3  | Add Zod validation to adapter routes          |
| I5    | Important | 2.3  | Check writableEnded before SSE writes         |
| I6    | Important | 2.3  | Validate sessionMap JSON shape                |
| I7    | Important | 3.3  | Remove dead CrossNamespaceEdge animation      |
| I8    | Important | 3.3  | Fix handleNodeClick stale closure             |
| I9    | Important | 3.4  | Prevent ELK layout thrashing on refetch       |
| I10   | Important | 3.4  | Extract relativeTime to shared utility        |
