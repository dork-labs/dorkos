# Tasks: Fix Chat Streaming & Model Selector Bugs

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-03-10
**Mode:** Full

---

## Phase 1: Bug Fixes

All tasks in a single phase. Tasks 1.1 and 1.2 are independent and can run in parallel. Task 1.3 (tests) depends on both fixes. Task 1.4 (verification) depends on tests.

### Task 1.1 — Add streaming guard to history seed effect

**Size:** Small | **Priority:** High | **Parallel with:** 1.2

Add `if (isStreaming) return;` guard to the initial-seed branch of the history seeding effect in `use-chat-session.ts` (line ~211). This prevents stale server history from overwriting optimistic user messages when `sessionId` changes mid-stream during create-on-first-message. The effect already has `isStreaming` in its dependency array, so seeding defers until streaming completes.

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`
**Change:** 3 lines added (guard + comment) inside the `!historySeededRef.current` branch.

---

### Task 1.2 — Implement convergence effect for optimistic query state

**Size:** Small | **Priority:** High | **Parallel with:** 1.1

Replace the eager `setLocalModel(null)` / `setLocalPermissionMode(null)` in the `updateSession` success path with a convergence `useEffect` that clears optimistic state only when `session?.model === localModel`. This eliminates the one-frame render gap where the RadioGroup value mismatches all item values.

**File:** `apps/client/src/layers/entities/session/model/use-session-status.ts`
**Changes:**

- Add `useEffect` to React import
- Remove eager clear from success path (~2 lines removed)
- Add convergence `useEffect` (~8 lines added)
- Error/catch path unchanged (still clears optimistic state on failure)

---

### Task 1.3 — Add regression tests for both bug fixes

**Size:** Medium | **Priority:** High | **Depends on:** 1.1, 1.2

Two test targets:

1. **`use-chat-session-relay.test.ts`** (existing) — Add `describe('history seeding during streaming')` block verifying that optimistic messages survive mid-stream sessionId changes.

2. **`use-session-status.test.ts`** (new) — Three test cases:
   - Holds optimistic model until server confirms via query cache
   - Reverts optimistic model on PATCH failure
   - Applies convergence to permissionMode consistently

---

### Task 1.4 — Verify typecheck and full test suite pass

**Size:** Small | **Priority:** Medium | **Depends on:** 1.3

Run `pnpm typecheck && pnpm test -- --run` to verify no regressions. All existing and new tests must pass with exit code 0.

---

## Dependency Graph

```
1.1 (streaming guard) ──┐
                         ├── 1.3 (tests) ── 1.4 (verify)
1.2 (convergence effect)─┘
```
