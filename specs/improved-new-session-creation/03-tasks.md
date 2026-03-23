# Improved New Session Creation — Task Breakdown

**Spec:** `specs/improved-new-session-creation/02-specification.md`
**Generated:** 2026-03-23
**Mode:** Full decomposition

---

## Phase 1: Core Refactor

### 1.1 — Add router loader to /session route for auto-selection

**Size:** Medium | **Priority:** High | **Dependencies:** None

Add a `loader` to the `/session` route in `router.tsx` that reads the TanStack Query cache synchronously and redirects to the most recent cached session (or generates a speculative UUID) when no `?session=` param is present. Uses `replace: true` to keep browser history clean. No async fetching — purely synchronous cache read.

**Files:** `apps/client/src/router.tsx`

---

### 1.2 — Update SessionSidebar to use speculative UUID and remove intentionallyNullRef

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Refactor `SessionSidebar.tsx`: change `handleNewSession` to call `setActiveSession(crypto.randomUUID())` instead of `setActiveSession(null)`. Remove the `intentionallyNullRef` declaration, the auto-select `useEffect`, and the `intentionallyNullRef.current = true` line in `handleDashboard`.

**Files:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

---

### 1.3 — Remove null branch from executeSubmission and add speculative UUID optimistic insert

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2

Replace `let targetSessionId = sessionId; if (!targetSessionId) { ... }` with `const targetSessionId = sessionId!` and a cache-existence check that inserts an optimistic session for speculative UUIDs not yet in the TanStack Query cache. Remove the `onSessionIdChangeRef.current?.(targetSessionId)` call that was inside the null-branch.

**Files:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

---

## Phase 2: Tests

### 2.1 — Update SessionSidebar tests for UUID-based new session flow

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.2, 2.3

Update the "New session" click test to assert `mockSetSessionId` is called with a UUID string (not null). Remove the "auto-selects first session" test. Add a test verifying unique UUIDs on consecutive clicks.

**Files:** `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx`

---

### 2.2 — Update use-chat-session-core tests for speculative UUID flow

**Size:** Medium | **Priority:** High | **Dependencies:** 1.3 | **Parallel with:** 2.1, 2.3

Remove any null-branch session creation tests. Add two new tests: (1) verify `insertOptimisticSession` fires for a speculative UUID not in cache, (2) verify no duplicate insert when session already exists in cache.

**Files:** `apps/client/src/layers/features/chat/__tests__/use-chat-session-core.test.tsx`

---

### 2.3 — Add router loader tests for /session route

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 2.1, 2.2

Extract the loader into a named `sessionRouteLoader` function (exported with `@internal` tag). Create `apps/client/src/__tests__/router.test.ts` with six tests: no redirect when param present, redirect to cached session, redirect to new UUID, dir param preservation (two cases), and correct cache key usage.

**Files:** `apps/client/src/router.tsx`, `apps/client/src/__tests__/router.test.ts` (new)

---

## Phase 3: Cleanup

### 3.1 — Remove dead imports and verify full test suite passes

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.1, 2.2, 2.3

Audit all modified files for dead imports. Run the full test suite (`pnpm test -- --run`) and type checker (`pnpm typecheck`). Verify `intentionallyNull` pattern is completely gone from the codebase. Confirm embedded mode (Obsidian) is unaffected.

**Files:** Minor import cleanup if needed

---

## Dependency Graph

```
1.1 (Router loader)
├── 1.2 (SessionSidebar) ──→ 2.1 (Sidebar tests)
├── 1.3 (use-chat-session) ──→ 2.2 (Chat tests)
└── 2.3 (Router tests)
                                    ↓
                              3.1 (Cleanup)
```

Tasks 1.2 and 1.3 can run in parallel after 1.1. All Phase 2 tests can run in parallel. Phase 3 runs after all Phase 2 tasks complete.
