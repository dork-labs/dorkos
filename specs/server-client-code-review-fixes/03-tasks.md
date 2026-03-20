# Task Breakdown: Server & Client Code Review Fixes

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-02-28
**Mode:** Full
**Total tasks:** 11 (4 server + 4 client critical + 3 client quality)

---

## Phase 1: Server Fixes

All Phase 1 tasks can run in parallel since they touch different files.

### Task 1.1 — Fix double lock release race condition in sessions.ts

| Field             | Value                                |
| ----------------- | ------------------------------------ |
| **ID**            | 1.1                                  |
| **Size**          | Small                                |
| **Priority**      | High                                 |
| **File**          | `apps/server/src/routes/sessions.ts` |
| **Dependencies**  | None                                 |
| **Parallel with** | 1.2, 1.3, 1.4                        |

**Issue (S1):** The POST `/api/sessions/:id/messages` handler has `res.on('close')` AND a `finally` block that both call `agentManager.releaseLock()`. Both fire on normal completion. If a new client acquires the lock between the two calls, the second release deletes the wrong client's lock.

**Fix:** Create a `releaseLockOnce` closure with a boolean guard. Replace all three `agentManager.releaseLock(sessionId, clientId)` calls (relay `finally`, legacy `res.on('close')`, legacy `finally`) with `releaseLockOnce()`.

---

### Task 1.2 — Fix inFlight promise permanently poisoned on failure in binding-router.ts

| Field             | Value                                              |
| ----------------- | -------------------------------------------------- |
| **ID**            | 1.2                                                |
| **Size**          | Small                                              |
| **Priority**      | High                                               |
| **File**          | `apps/server/src/services/relay/binding-router.ts` |
| **Dependencies**  | None                                               |
| **Parallel with** | 1.1, 1.3, 1.4                                      |

**Issue (S2):** In `getOrCreateSession`, the `inFlight.delete(key)` call is inside the success path. If `createNewSession()` throws, the rejected promise remains in `inFlight` permanently, blocking all future session creation for that key.

**Fix:** Move `this.inFlight.delete(key)` into a `finally` block inside the async IIFE.

---

### Task 1.3 — Restrict CORS from wildcard to localhost origins in app.ts

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| **ID**            | 1.3                                    |
| **Size**          | Medium                                 |
| **Priority**      | High                                   |
| **Files**         | `apps/server/src/app.ts`, `turbo.json` |
| **Dependencies**  | None                                   |
| **Parallel with** | 1.1, 1.2, 1.4                          |

**Issue (S3):** `app.use(cors())` defaults to `Access-Control-Allow-Origin: *`, allowing any website to read session data.

**Fix:** Add `buildCorsOrigin()` helper defaulting to localhost origins. Support `DORKOS_CORS_ORIGIN` env var override. Add dynamic middleware for tunnel URL. Add env var to `turbo.json` `globalPassThroughEnv`.

---

### Task 1.4 — Validate relay SSE subscription patterns in relay.ts

| Field             | Value                             |
| ----------------- | --------------------------------- |
| **ID**            | 1.4                               |
| **Size**          | Small                             |
| **Priority**      | High                              |
| **File**          | `apps/server/src/routes/relay.ts` |
| **Dependencies**  | None                              |
| **Parallel with** | 1.1, 1.2, 1.3                     |

**Issue (S4):** The GET `/stream` handler accepts arbitrary `subject` query param with default `'>'` (global wildcard). No validation prevents clients from subscribing to all relay traffic.

**Fix:** Add `ALLOWED_PREFIXES` whitelist and `validateSubscriptionPattern()` function. Change default from `'>'` to `'relay.human.console.>'`. Return 400 for invalid patterns. Implements the unaddressed consequence from ADR 0018.

---

## Phase 2: Client Critical Fixes

### Task 2.1 — Fix EventSource reconnection cascade in useChatSession and stream-event-handler

| Field             | Value                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- |
| **ID**            | 2.1                                                                                |
| **Size**          | Large                                                                              |
| **Priority**      | High                                                                               |
| **Files**         | `ChatPanel.tsx`, `use-chat-session.ts`, `stream-event-handler.ts`, `chat-types.ts` |
| **Dependencies**  | None                                                                               |
| **Parallel with** | None                                                                               |

**Issue (C1+C2):** Three compounding issues create a cascade:

1. `handleTaskEventWithCelebrations` depends on `taskState`/`celebrations` objects (new every render)
2. `onStreamingDone` is inline `useCallback` inside the options literal
3. `options` is always new reference, making `streamEventHandler` `useMemo` recreate every render
4. EventSource `useEffect` depends on `streamEventHandler`, so it reconnects every render

**Fix (4 parts):**

- **Part A:** Ref-stabilize callbacks in `useChatSession` — store option callbacks via refs, remove `options` from `useMemo` deps
- **Part B:** Update `createStreamEventHandler` to accept refs instead of options bag — change `StreamEventDeps` interface
- **Part C:** Fix `handleTaskEventWithCelebrations` — destructure stable refs from `taskState`/`celebrations`
- **Part D:** Fix incremental history seeding — use ID-based deduplication instead of array length comparison

---

### Task 2.2 — Fix FSD layer violation by moving FileEntry type to shared

| Field             | Value                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**            | 2.2                                                                                                                                     |
| **Size**          | Small                                                                                                                                   |
| **Priority**      | Medium                                                                                                                                  |
| **Files**         | `use-file-autocomplete.ts`, `FilePalette.tsx`, `files/index.ts`, new `shared/lib/file-types.ts`, `shared/lib/index.ts`, `ChatPanel.tsx` |
| **Dependencies**  | None                                                                                                                                    |
| **Parallel with** | 2.3                                                                                                                                     |

**Issue (C3):** `use-file-autocomplete.ts` (chat feature) imports `FileEntry` from `features/files` — a cross-feature model import violating FSD rules.

**Fix:** Move `FileEntry` interface to `shared/lib/file-types.ts`. Update imports in `FilePalette.tsx`, `use-file-autocomplete.ts`, `ChatPanel.tsx`. Re-export from `features/files/index.ts` for backward compat.

---

### Task 2.3 — Make streaming text_delta updates immutable in stream-event-handler.ts

| Field             | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| **ID**            | 2.3                                                                  |
| **Size**          | Small                                                                |
| **Priority**      | Medium                                                               |
| **File**          | `apps/client/src/layers/features/chat/model/stream-event-handler.ts` |
| **Dependencies**  | 2.1 (modifies same file)                                             |
| **Parallel with** | 2.2                                                                  |

**Issue (C4):** `lastPart.text += text` mutates in place; `parts.push()` mutates the array. React may not detect changes correctly.

**Fix:** Replace in-place mutation with immutable updates — create new arrays/objects using spread operators. Reassign `currentPartsRef.current` instead of mutating it.

---

## Phase 3: Client Quality Fixes

All Phase 3 tasks can run in parallel since they touch different files.

### Task 3.1 — Fix ARIA roles on LinkSafetyModal in StreamingText.tsx

| Field             | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| **ID**            | 3.1                                                         |
| **Size**          | Small                                                       |
| **Priority**      | Low                                                         |
| **File**          | `apps/client/src/layers/features/chat/ui/StreamingText.tsx` |
| **Dependencies**  | None                                                        |
| **Parallel with** | 3.2, 3.3                                                    |

**Issue (C5):** Backdrop uses `role="button"` and `tabIndex={0}` (wrong — it's not a button). Dialog content uses `role="presentation"` (provides no semantic meaning).

**Fix:** Remove `role="button"` and `tabIndex={0}` from backdrop. Add `aria-hidden="true"` to backdrop. Add `role="dialog"`, `aria-modal="true"`, `aria-label` to content div. Add `tabIndex={-1}` for programmatic focus. Move keyboard handling to content div.

---

### Task 3.2 — Deduplicate sessions query in SessionSidebar.tsx

| Field             | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| **ID**            | 3.2                                                                  |
| **Size**          | Small                                                                |
| **Priority**      | Low                                                                  |
| **File**          | `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` |
| **Dependencies**  | None                                                                 |
| **Parallel with** | 3.1, 3.3                                                             |

**Issue (C6):** Inline `useQuery` with `queryKey: ['sessions', selectedCwd]` duplicates the canonical `useSessions()` entity hook. Different configs (missing `refetchInterval`).

**Fix:** Replace inline `useQuery` with `useSessions()` from `@/layers/entities/session`. Remove `useQuery` from imports if no longer used.

---

### Task 3.3 — Add error handling to relay SSE JSON.parse in use-relay-event-stream.ts

| Field             | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| **ID**            | 3.3                                                                     |
| **Size**          | Small                                                                   |
| **Priority**      | Low                                                                     |
| **File**          | `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts` |
| **Dependencies**  | None                                                                    |
| **Parallel with** | 3.1, 3.2                                                                |

**Issue (C7):** Both `relay_message` and `relay_delivery` listeners call `JSON.parse(e.data)` without try/catch. Malformed JSON crashes the React component tree.

**Fix:** Wrap both `JSON.parse` calls in try/catch with `console.warn` for debugging.

---

## Phase 4: Validation

### Task 4.1 — Validate all fixes with lint, typecheck, and test suite

| Field             | Value                        |
| ----------------- | ---------------------------- |
| **ID**            | 4.1                          |
| **Size**          | Medium                       |
| **Priority**      | High                         |
| **Dependencies**  | All previous tasks (1.1-3.3) |
| **Parallel with** | None                         |

Run `pnpm typecheck`, `pnpm lint`, and `pnpm test -- --run` to verify all fixes. Fix any type errors from the `StreamEventDeps` interface change. Update tests that depend on the old `options` parameter shape.

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 (S1: sessions.ts)  ──┐
  1.2 (S2: binding-router) ─┤
  1.3 (S3: app.ts + turbo)  ├──→ Phase 4 (4.1: Validation)
  1.4 (S4: relay.ts)       ─┤
                             │
Phase 2:                     │
  2.1 (C1+C2: cascade fix) ─┤
  2.2 (C3: FSD violation)  ─┤
  2.3 (C4: immutable) ──────┤  (depends on 2.1)
                             │
Phase 3 (parallel):          │
  3.1 (C5: ARIA) ───────────┤
  3.2 (C6: dedup query) ────┤
  3.3 (C7: JSON.parse) ─────┘
```
