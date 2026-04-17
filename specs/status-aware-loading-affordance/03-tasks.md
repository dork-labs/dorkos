# Tasks: Status-Aware Loading Affordance for `system_status.status`

**Spec**: [`specs/status-aware-loading-affordance/02-specification.md`](./02-specification.md)
**Slug**: `status-aware-loading-affordance`
**Mode**: Full
**Generated**: 2026-04-17

---

## Overview

This feature threads the structured `system_status.data.status` field (landed end-to-end in spec 245) into the per-session Zustand store and renders a status-aware variant of the `system-message` rung in `ChatStatusStrip`. The backend plumbing is already in place — every change lives in the client.

**Execution order** follows spec §12, which is the path that keeps the tree compiling at each step: type → store → setter → stream handler → hook/panel pass-through → renderer → tests → docs.

**Target**: 8 tasks across 5 phases. Small, linear feature.

---

## Phase 1 — Foundation (types + store)

Widen the store's `systemStatus` slot from `string | null` to a structured record. This cascades compile errors that later phases resolve.

### 1.1 Add `SystemStatusState` interface and widen session store types

- Add `SystemStatusState { message: string; status: string | null }` in `apps/client/src/layers/shared/model/chat-message-types.ts`, re-export from `apps/client/src/layers/features/chat/model/chat-types.ts`.
- Update `SessionState.systemStatus` in `apps/client/src/layers/entities/session/model/session-chat-store.ts` to `SystemStatusState | null`.
- `DEFAULT_SESSION_STATE.systemStatus` stays `null`.
- Placed in `shared/` so both the entity store and the feature-layer hook can import without crossing FSD layer boundaries.

**Dependencies**: none
**Size**: small

### 1.2 Widen `setSystemStatus` setter signatures in `useSessionStoreActions`

- Update `SessionStoreActions.setSystemStatus` and `setSystemStatusWithClear` to accept `SystemStatusState | null`.
- Update both setter implementations; rename `message` parameter → `payload`.
- Widen `StreamEventDeps.setSystemStatus` in `stream-event-types.ts:48` to the struct.
- `use-stream-handler.ts:34` and `use-session-submit.ts:48` inherit the new type via `SessionStoreActions['setSystemStatusWithClear']` — no manual edit.

**Dependencies**: 1.1
**Size**: small

---

## Phase 2 — Wiring (stream handler + pass-through)

Fix every call site that previously passed a raw string. Handler cases plus the hook/panel pass-through.

### 2.1 Forward `system_status.status` through `stream-event-handler` and `api_retry`

- `system_status` case: `setSystemStatus({ message, status: status ?? null })`.
- `api_retry` case: wrap the synthesized retry string in `{ message, status: null }`; switch literal `…` to `\u2026` for consistency with the rest of the strip.
- `done` case: `setSystemStatus(null)` stays unchanged.

**Dependencies**: 1.2
**Size**: small

### 2.2 Propagate `SystemStatusState` through `useChatSession` and `ChatPanel`

- Verify `useChatSession.ts` return type picks up the widened store type automatically; add an explicit annotation only if TypeScript flags the field.
- `ChatPanel.tsx` pass-through at lines 222-232 needs no logic change — the prop forwards the struct through.
- Once `ChatStatusStripProps.systemStatus` is widened in Phase 3, this compiles cleanly.

**Dependencies**: 2.1
**Size**: small

---

## Phase 3 — Renderer (`deriveStatusCopy` + `ChatStatusStrip`)

### 3.1 Add `deriveStatusCopy` and route structured status through `ChatStatusStrip`

- Add `deriveStatusCopy(status): string | null` — pure switch on `'requesting'` / `'compacting'` / default, returning `'Thinking\u2026'` / `'Compacting context\u2026'` / `null`.
- Widen `StripStateInput.systemStatus`, `UseStripStateInput.systemStatus`, and `ChatStatusStripProps.systemStatus` to `SystemStatusState | null`.
- Update priority-3 branch in `deriveStripState`:
  ```ts
  if (input.systemStatus) {
    const { message, status } = input.systemStatus;
    const copy = deriveStatusCopy(status) ?? message;
    return { type: 'system-message', message: copy, icon: deriveSystemIcon(copy) };
  }
  ```
- `SystemMessageContent` renderer and icon-derivation call site stay untouched — they operate on the final string.

**Dependencies**: 2.2
**Size**: medium

---

## Phase 4 — Tests (unit + component + handler)

### 4.1 Unit + component tests for `deriveStatusCopy`

- Update existing `ChatStatusStrip.test.tsx` cases to pass `{ message, status: null }` instead of bare strings.
- Add `describe('deriveStatusCopy', ...)` block (4 cases: requesting, compacting, unknown, null/undefined).
- Add 2 new `deriveStripState` cases: known status → calm copy; unknown status → raw `message` fallback.
- Add the component-level render test called out in spec §8.3:
  ```tsx
  expect(screen.getByTestId('chat-status-strip-system-message')).toHaveTextContent(
    'Thinking\u2026'
  );
  ```

**Dependencies**: 3.1
**Parallel with**: 4.2
**Size**: medium

### 4.2 Extend `stream-event-handler-status` test for the `status` field

- Update the existing `system_status` test to assert the struct shape `{ message, status: null }` (no-status case).
- Add a new assertion for `{ message, status: 'requesting' }` forwarding.
- `done`-clears test stays unchanged (`null` passes through).

**Dependencies**: 3.1
**Parallel with**: 4.1
**Size**: small

---

## Phase 5 — Docs & housekeeping

### 5.1 Update spec 245 cross-reference, run verification pipeline

- Update `specs/claude-agent-sdk-upgrade-0.2.112/04-implementation.md` deferred-work bullet for Task 5.4 to point at this spec.
- Advance this spec's manifest status to `implemented` via the `managing-specs` tooling.
- Run: `pnpm typecheck && pnpm lint && pnpm test -- --run`.
- Optional manual smoke: `pnpm dev`, confirm "Thinking…" during `requesting` and "Compacting context…" during `compacting` against a live SDK ≥ 0.2.108.

**Dependencies**: 4.1, 4.2
**Size**: small

---

## Dependency Graph

```
1.1 → 1.2 → 2.1 → 2.2 → 3.1 ─┬─ 4.1 ─┐
                              │        ├─ 5.1
                              └─ 4.2 ─┘
```

## Parallelization

- **Phase 4 tasks** (4.1 and 4.2) can run in parallel — they touch disjoint files (`ChatStatusStrip.test.tsx` vs `stream-event-handler-status.test.ts`).
- All other tasks are strictly sequential to keep the tree compiling at each step (spec §12 ordering).

## Critical Path

1.1 → 1.2 → 2.1 → 2.2 → 3.1 → (4.1 || 4.2) → 5.1
