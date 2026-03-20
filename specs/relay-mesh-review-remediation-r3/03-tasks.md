# Relay, Mesh & Telegram Adapter — Code Review Remediation Round 3: Task Breakdown

**Spec:** `specs/relay-mesh-review-remediation-r3/02-specification.md`
**Generated:** 2026-03-01
**Mode:** Full decomposition

## Summary

| Phase     | Name                  | Tasks  | Findings Covered |
| --------- | --------------------- | ------ | ---------------- |
| 1         | Critical Fixes        | 4      | C1, C2, C3, C4   |
| 2         | High-Severity Fixes   | 10     | H1-H10           |
| 3         | Medium-Severity Fixes | 10     | M1-M21           |
| **Total** |                       | **24** | **36 findings**  |

---

## Phase 1: Critical Fixes

All Phase 1 tasks are independent and can run in parallel.

### 1.1 Add boundary validation to mesh route filesystem paths (C1)

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel:** 1.2, 1.3, 1.4

**Files:** `apps/server/src/routes/mesh.ts`

Add `validateBoundary()` calls to four endpoints that accept filesystem paths:

- `POST /discover` — validate each root path
- `POST /agents` — validate `projectPath`
- `POST /deny` — validate `path`
- `DELETE /denied/:encodedPath` — validate decoded path

All return 403 for paths outside the configured boundary. Tests verify 403 for out-of-boundary paths and 200/201 for valid paths.

---

### 1.2 Fix extractChatId accepting invalid chat ID 0 (C2)

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1, 1.3, 1.4

**Files:** `packages/relay/src/adapters/telegram-adapter.ts`

Add `if (!idStr) return null;` guard in the group branch of `extractChatId()` to prevent `Number("") === 0` from being treated as a valid chat ID.

---

### 1.3 Add SubscriptionRegistry.clear() and call from RelayCore.close() (C3)

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1, 1.2, 1.4

**Files:** `packages/relay/src/subscription-registry.ts`, `packages/relay/src/relay-core.ts`

Add `clear()` method to `SubscriptionRegistry` that empties `this.subscriptions` and persists empty state. Call from `RelayCore.close()` before watcher cleanup.

---

### 1.4 Wrap BindingRouter saveSessionMap calls in error handling (C4)

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1, 1.2, 1.3

**Files:** `apps/server/src/services/relay/binding-router.ts`

Wrap all three `saveSessionMap()` call sites in try/catch with `logger.warn()`. Session map persistence is best-effort; failures should not break session creation.

---

## Phase 2: High-Severity Fixes

All Phase 2 tasks are independent and can run in parallel.

### 2.1 Mask sensitive config in adapter-manager getAdapter() (H1)

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** All P2

**Files:** `apps/server/src/services/relay/adapter-manager.ts`

Update `getAdapter()` to call `maskSensitiveFields()` before returning, matching `listAdapters()` behavior. Tests verify tokens are replaced with `'****'`.

---

### 2.2 Consolidate duplicated types — eliminate relay types.ts / shared schema drift (H2)

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel:** All P2

**Files:** `packages/shared/src/relay-schemas.ts`, `packages/relay/src/types.ts`

Remove `Z` suffix from Zod-inferred type names, add deprecated re-exports. Replace 8 manually duplicated interfaces in `types.ts` with imports from `@dorkos/shared/relay-schemas`.

---

### 2.3 Extract shared payload extraction utility (H3)

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** All P2

**Files:** New `packages/relay/src/lib/payload-utils.ts`, `telegram-adapter.ts`, `claude-code-adapter.ts`

Create `extractPayloadContent()` utility. Remove duplicated implementations from both adapters. Add comprehensive test file.

---

### 2.4 Replace BindingStore writeGeneration with mtime-based self-write detection (H4)

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** All P2

**Files:** `apps/server/src/services/relay/binding-store.ts`

Replace `writeGeneration` counter with `lastWriteMtime` tracking. Compare `stat.mtimeMs` after writes to detect self-writes in chokidar handler.

---

### 2.5 Add DeliveryPipeline timer cleanup and close() method (H5)

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** All P2

**Files:** `packages/relay/src/delivery-pipeline.ts`, `packages/relay/src/relay-core.ts`

Track dedup timers in a `Set`, add `close()` that clears all timers. Call from `RelayCore.close()`.

---

### 2.6 Standardize adapter status mutation to immutable spread pattern (H6)

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel:** All P2

**Files:** `packages/relay/src/adapters/webhook-adapter.ts`, `packages/relay/src/adapters/claude-code-adapter.ts`

Replace all in-place status mutations (`this.status.state = ...`) with immutable spread pattern matching `telegram-adapter.ts`.

---

### 2.7 Fix O(n\*m) dead-letter lookup in conversations endpoint (H7)

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel:** All P2

**Files:** `apps/server/src/routes/relay.ts`

Pre-build `Map` from dead-letter list for O(1) lookups. Extract conversation-building logic into a helper function.

---

### 2.8 Consolidate TraceStoreLike interface into relay types.ts (H8)

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel:** All P2

**Files:** `packages/relay/src/types.ts`, `packages/relay/src/adapters/claude-code-adapter.ts`

Define single `TraceStoreLike` with both `insertSpan()` and `updateSpan()`. Remove duplicate from `claude-code-adapter.ts`.

---

### 2.9 Add SSE backpressure for slow relay clients (H9)

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel:** All P2

**Files:** `apps/server/src/routes/relay.ts`

Check `res.write()` return value in SSE stream. When it returns `false`, listen for `drain` event before resuming writes.

---

### 2.10 Fix adapter-delivery timer initialization (H10)

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel:** All P2

**Files:** `packages/relay/src/adapter-delivery.ts`

Type timer as `NodeJS.Timeout | undefined`, check `if (timer)` before `clearTimeout()` in `finally` block.

---

## Phase 3: Medium-Severity Fixes

### 3.1 Extract shared mesh registration logic and toManifest helper (M1, M2)

**Size:** Medium | **Priority:** Medium | **Dependencies:** None | **Parallel:** 3.2-3.6

**Files:** `packages/mesh/src/mesh-core.ts`

Extract `registerInternal()` helper for shared write/upsert/relay logic. Extract `toManifest()` helper to replace 4x repeated destructure pattern.

---

### 3.2 Deduplicate AgentNode card header into shared component (M3)

**Size:** Small | **Priority:** Low | **Dependencies:** None | **Parallel:** 3.1, 3.3-3.6

**Files:** `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`

Extract shared `CardHeader` component composed by both `DefaultCard` and `ExpandedCard`.

---

### 3.3 Fix MeshCore.getStatus() double-fetch and other mesh improvements (M4, M5, M6)

**Size:** Medium | **Priority:** Medium | **Dependencies:** None | **Parallel:** 3.1, 3.2, 3.4-3.6

**Files:** `packages/mesh/src/mesh-core.ts`, `use-mesh-discover.ts`, `routes/mesh.ts`

Single-pass `getStatus()`, discovery cache invalidation via `queryClient.invalidateQueries`, callerNamespace routing fix.

---

### 3.4 Schema improvements — AgentHealthStatus, UpdateAgentRequest, RelayBudget (M7, M9, M14, M18)

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.2 | **Parallel:** 3.1-3.3, 3.5, 3.6

**Files:** `packages/shared/src/mesh-schemas.ts`, `packages/shared/src/relay-schemas.ts`

Add 'unreachable' to health status enum. Derive `UpdateAgentRequestSchema` from `AgentManifestSchema.pick().partial()`. Add `.min(0)` to budget TTL.

---

### 3.5 Telegram adapter improvements — webhook cleanup, reconnect logging, caption tests (M8, M15, M20)

**Size:** Medium | **Priority:** Medium | **Dependencies:** None | **Parallel:** 3.1-3.4, 3.6

**Files:** `packages/relay/src/adapters/telegram-adapter.ts`, test file

Call `deleteWebhook()` on stop in webhook mode. Log terminal state on max reconnect exhaustion. Add caption-only message test.

---

### 3.6 Relay route fixes — dot params, adapter error map, Pulse path matching (M12, M13, M16)

**Size:** Medium | **Priority:** Medium | **Dependencies:** None | **Parallel:** 3.1-3.5

**Files:** `apps/server/src/routes/relay.ts`, `apps/server/src/routes/mesh.ts`

Wildcard route params for dotted subjects. Shared `ADAPTER_ERROR_STATUS` map. Exact `projectPath` matching for Pulse schedules.

---

### 3.7 Extract TopologyGraph into sub-modules (M10)

**Size:** Medium | **Priority:** Low | **Dependencies:** None | **Parallel:** 3.8-3.10

**Files:** New `elk-layout.ts`, new `build-topology-elements.ts`, `TopologyGraph.tsx`

Move `applyElkLayout` (~100 lines) and node/edge building (~150 lines) into separate files. Target: TopologyGraph under 500 lines.

---

### 3.8 Fix binding-router test envelopes and async watcher cleanup (M11, M17)

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel:** 3.7, 3.9, 3.10

**Files:** `binding-router.test.ts`, `watcher-manager.ts`, `relay-core.ts`

Correct budget fields in test envelopes. Make `stopWatcher()` async and await `watcher.close()`. Await in `unregisterEndpoint()`.

---

### 3.9 Reduce topology polling interval to 30 seconds (M19)

**Size:** Small | **Priority:** Low | **Dependencies:** None | **Parallel:** 3.7, 3.8, 3.10

**Files:** `use-mesh-topology.ts`

Change `refetchInterval` from 15000 to 30000.

---

### 3.10 Add payload extraction tests for edge cases (M20, M21)

**Size:** Small | **Priority:** Low | **Dependencies:** 2.3 | **Parallel:** 3.7-3.9

**Files:** `payload-utils.test.ts`, `telegram-adapter.test.ts`

Comprehensive edge case tests for `extractPayloadContent` and Telegram adapter payload handling.

---

## Dependency Graph

```
Phase 1 (all parallel):  1.1  1.2  1.3  1.4
                           |    |    |    |
Phase 2 (all parallel):  2.1  2.2  2.3  2.4  2.5  2.6  2.7  2.8  2.9  2.10
                                |    |
Phase 3:                       |    |
  3.4 depends on 2.2 --------'    |
  3.10 depends on 2.3 -----------'
  All other P3 tasks are independent
```

## Verification

After all tasks complete:

- `pnpm typecheck` — zero type errors
- `pnpm test -- --run` — all tests pass
- `pnpm build` — all packages build
- `pnpm lint` — no new lint errors
