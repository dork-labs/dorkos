---
slug: server-client-code-review-fixes
number: 75
created: 2026-02-28
status: specified
---

# Server & Client Code Review Fixes

**Slug:** server-client-code-review-fixes
**Author:** Claude Code
**Date:** 2026-02-28
**Branch:** fix/code-review-fixes-r1
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Fix 12 verified issues from a comprehensive code review of `apps/server/` and `apps/client/`, covering race conditions, security hardening, React rendering bugs, accessibility, and code quality.
- **Assumptions:**
  - All fixes are backward-compatible (no API changes visible to external consumers)
  - The relay and mesh subsystems are feature-flagged, so relay/mesh fixes only affect users with those features enabled
  - The options ref-stabilization fix inside `useChatSession` preserves the existing public API
- **Out of scope:**
  - New features or refactors beyond the identified issues
  - Test coverage expansion (tests for fixes only if existing tests break)
  - Performance profiling beyond the identified re-render cascade
  - The `eventQueueNotify` overwrite pattern (low severity, design choice — works correctly under the session lock)

## 2) Pre-reading Log

- `apps/server/src/routes/sessions.ts`: Double lock release between `res.on('close')` and `finally` block; GET messages handler and PATCH handler verified as non-issues
- `apps/server/src/services/relay/binding-router.ts`: `inFlight` map never cleaned up on promise rejection — permanently blocks session creation for that key
- `apps/server/src/app.ts`: `cors()` called with no options, defaults to `Access-Control-Allow-Origin: *`
- `apps/server/src/routes/relay.ts`: SSE stream accepts arbitrary `subject` query param passed directly to `relayCore.subscribe()`
- `apps/server/src/services/relay/binding-store.ts`: `skipNextReload` boolean flag is consumed by wrong chokidar event under concurrent writes
- `apps/server/src/services/core/agent-manager.ts`: `eventQueueNotify` overwrite is low severity — verified as working correctly under session lock
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Inline `useCallback` inside options object + `taskState`/`celebrations` object deps cause options instability
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: `options` in `useMemo` dep array is always new reference → `streamEventHandler` recreates every render → EventSource reconnects every render when relay enabled
- `apps/client/src/layers/features/chat/model/use-file-autocomplete.ts`: Imports `FileEntry` type from `features/files` — FSD cross-feature model violation
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: `currentPartsRef.current` text parts mutated in place during `text_delta`
- `apps/client/src/layers/features/chat/ui/StreamingText.tsx`: `LinkSafetyModal` backdrop uses `role="button"` instead of proper dialog ARIA
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Duplicates sessions query instead of using `useSessions()` entity hook
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`: `JSON.parse(e.data)` without try/catch in SSE listeners
- `apps/client/src/layers/features/chat/model/use-task-state.ts`: `handleTaskEvent` already stabilized with `useCallback([], [])` — no fix needed

## 3) Codebase Map

**Primary components/modules:**

| File                                                                    | Role                            | Issue                                            |
| ----------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| `apps/server/src/routes/sessions.ts`                                    | Session CRUD + SSE streaming    | S1: Double lock release                          |
| `apps/server/src/services/relay/binding-router.ts`                      | Adapter-agent session routing   | S2: inFlight promise leak                        |
| `apps/server/src/app.ts`                                                | Express app factory             | S3: CORS wildcard                                |
| `apps/server/src/routes/relay.ts`                                       | Relay HTTP endpoints + SSE      | S4: Unvalidated subscription pattern             |
| `apps/server/src/services/relay/binding-store.ts`                       | JSON-backed binding persistence | S5: skipNextReload race                          |
| `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`                 | Chat panel orchestrator         | C1: Options instability source                   |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`        | Chat session hook               | C2: streamEventHandler cascade + history seeding |
| `apps/client/src/layers/features/chat/model/use-file-autocomplete.ts`   | File autocomplete hook          | C3: FSD layer violation                          |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts`    | SSE event processor             | C4: Mutable ref parts                            |
| `apps/client/src/layers/features/chat/ui/StreamingText.tsx`             | Markdown + link safety modal    | C5: ARIA roles                                   |
| `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`    | Session list sidebar            | C6: Duplicated query                             |
| `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts` | Relay SSE event stream          | C7: Uncaught JSON.parse                          |

**Shared dependencies:**

- `apps/server/src/services/core/agent-manager.ts` — session lock manager (affected by S1)
- `apps/client/src/layers/entities/session/model/use-sessions.ts` — canonical sessions query hook (C6 should use this)
- `@dorkos/shared/relay-schemas.ts` — relay envelope types (consumed by C7)

**Data flow (C1/C2 cascade):**

```
ChatPanel renders
  → new options object literal created (always new reference)
  → useChatSession receives new options
  → useMemo([sessionId, options]) recreates streamEventHandler
  → useEffect([streamEventHandler]) fires
  → EventSource closed and reopened (when relay enabled)
  → repeat every render
```

**Potential blast radius:**

- Direct: 12 files
- Indirect: Components consuming `useChatSession` (just `ChatPanel`)
- Tests: May need updates for `use-chat-session` if tests exist

## 4) Root Cause Analysis

N/A — these are code review findings, not user-reported bugs.

## 5) Research

Since all issues have well-defined fixes with established patterns, no external research was needed.

**Fix patterns by category:**

**1. Race conditions (S1, S2, S5):**

- S1: Idempotent release via boolean guard (`releaseLockOnce`)
- S2: `finally` block for `inFlight.delete(key)` — standard promise cleanup
- S5: Write generation counter instead of boolean flag

**2. Security hardening (S3, S4):**

- S3: Configurable CORS origin via `DORKOS_CORS_ORIGIN` env var, defaulting to localhost
- S4: Prefix whitelist for relay subscription patterns

**3. React rendering (C1, C2, C4):**

- C1+C2: Ref-stabilize callbacks inside `useChatSession` (proven pattern from useSWR, React Hook Form)
- C4: Replace mutation with new object creation

**4. Code quality (C3, C5, C6, C7):**

- C3: Move `FileEntry` type to shared location
- C5: Correct ARIA roles on modal
- C6: Replace inline `useQuery` with `useSessions()` hook
- C7: Wrap `JSON.parse` in try/catch

## 6) Decisions

| #   | Decision                          | Choice                                                                      | Rationale                                                                                 |
| --- | --------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | CORS configuration approach       | Configurable via `DORKOS_CORS_ORIGIN` env var, default to localhost origins | Flexible without being wide open. Auto-includes tunnel URL when tunnel is enabled.        |
| 2   | Relay SSE subscription security   | Prefix whitelist                                                            | Prevents cross-session snooping. Only allows patterns the client should legitimately see. |
| 3   | ChatPanel options instability fix | Ref-stabilize inside `useChatSession`                                       | Least churn, callers don't change, proven pattern used by useSWR and React Hook Form.     |
