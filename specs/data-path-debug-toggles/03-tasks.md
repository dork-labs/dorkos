# Data Path Debug Toggles — Task Breakdown

**Spec:** `specs/data-path-debug-toggles/02-specification.md`
**Generated:** 2026-03-17

## Summary

6 tasks across 3 phases to add two Settings toggles that independently disable the Persistent SSE connection (cross-client sync) and Message Polling (periodic history refetch) in the chat client.

---

## Phase 1: Store & Hook (3 tasks)

### 1.1 — Add enableCrossClientSync and enableMessagePolling to app store

**Size:** Small | **Priority:** High | **Dependencies:** None

Add two new persisted boolean settings to the Zustand app store following the existing `BOOL_KEYS`/`BOOL_DEFAULTS` pattern. Both default to `true`. Changes to `AppState` interface, `BOOL_KEYS`, `BOOL_DEFAULTS`, and store implementation in `app-store.ts`. `resetPreferences()` automatically covers them via the `...BOOL_DEFAULTS` spread.

**File:** `apps/client/src/layers/shared/model/app-store.ts`

---

### 1.2 — Guard Persistent SSE effect with enableCrossClientSync toggle

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.3

Add `enableCrossClientSync` selector from the store, add an early return (`if (!enableCrossClientSync) return;`) in the Persistent SSE `useEffect`, and include it in the dependency array. When disabled, React's cleanup closes the EventSource and the re-run hits the early return.

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

---

### 1.3 — Guard Message Polling with enableMessagePolling toggle

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2

Add `enableMessagePolling` selector from the store and add an early return (`if (!enableMessagePolling) return false;`) in the TanStack Query `refetchInterval` callback. The closure captures the value and TanStack Query re-evaluates on each tick, so toggling takes effect immediately.

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

---

## Phase 2: Settings UI (1 task)

### 2.1 — Add Diagnostics section with toggle switches to AdvancedTab

**Size:** Small | **Priority:** High | **Dependencies:** 1.1

Add a "Diagnostics" section above the Danger Zone in `AdvancedTab.tsx` with two `Switch` toggles for "Cross-client sync" and "Message polling". Each has a label and descriptive subtitle. Uses `useAppStore` selectors wired to the store setters.

**File:** `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`

---

## Phase 3: Tests (2 tasks)

### 3.1 — Add store persistence tests for debug toggle settings

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 3.2

Add 6 tests to the existing `app-store.test.ts`: default value, localStorage persistence, and `resetPreferences` reset behavior for each of the two new toggles. Follows the existing `vi.resetModules()` + dynamic import pattern.

**File:** `apps/client/src/layers/shared/model/__tests__/app-store.test.ts`

---

### 3.2 — Add conditional SSE and polling tests to use-chat-session test

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.2, 1.3 | **Parallel with:** 3.1

Update `MockEventSource` to track instances via a static array. Update the `useAppStore` mock to support overriding the new toggle values. Add tests verifying no EventSource is created when `enableCrossClientSync` is `false`, and that EventSource IS created when `true`.

**File:** `apps/client/src/layers/features/chat/__tests__/use-chat-session.test.tsx`

---

## Dependency Graph

```
1.1 (store)
├── 1.2 (SSE guard) ──┐
├── 1.3 (polling guard)├── 3.2 (hook tests)
├── 2.1 (settings UI)  │
└── 3.1 (store tests) ─┘
```

## Files Modified

| File                                                                       | Tasks    |
| -------------------------------------------------------------------------- | -------- |
| `apps/client/src/layers/shared/model/app-store.ts`                         | 1.1      |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`           | 1.2, 1.3 |
| `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`              | 2.1      |
| `apps/client/src/layers/shared/model/__tests__/app-store.test.ts`          | 3.1      |
| `apps/client/src/layers/features/chat/__tests__/use-chat-session.test.tsx` | 3.2      |
