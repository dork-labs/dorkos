---
slug: improved-new-session-creation
number: 171
created: 2026-03-23
status: draft
---

# Improved New Session Creation

**Status:** Draft
**Authors:** Claude Code, 2026-03-23
**Ideation:** `specs/improved-new-session-creation/01-ideation.md`
**Branch:** preflight/improved-new-session-creation

---

## Overview

Refactor the "new session" creation flow to eliminate the overloaded `sessionId === null` state. Currently, null means both "user wants a new session" and "no session selected, auto-pick one," requiring the fragile `intentionallyNullRef` guard in `SessionSidebar`. This refactor assigns a client UUID in the URL immediately on "New session" click (speculative UUID pattern, matching Claude.ai's approach) and moves auto-selection from a component-level `useEffect` to a TanStack Router `loader` for flash-free initial rendering.

## Background / Problem Statement

The current new session flow has a fundamental design flaw: `sessionId === null` is overloaded to represent two distinct states:

1. **"User wants a new, empty session"** — triggered by clicking "New session"
2. **"No session selected, auto-pick the most recent one"** — triggered on initial page load or directory change

The `intentionallyNullRef` in `SessionSidebar` disambiguates these states, but it's fragile. A race condition was already discovered where unstable callback references caused the auto-select effect to re-fire and override the user's intent. While a band-aid fix (stabilizing `setSessionId` with `useCallback` + persisting the flag until `activeSessionId` becomes non-null) addressed the immediate symptom, the overloaded null state remains a source of latent bugs.

## Goals

- Eliminate the overloaded `sessionId === null` state on the `/session` route entirely
- Remove the `intentionallyNullRef` mechanism and auto-select `useEffect` from `SessionSidebar`
- Move auto-selection logic to a TanStack Router `loader` that runs before component mount (no flash)
- Simplify `executeSubmission` in `useChatSession` by removing the null→UUID creation branch
- Preserve the existing `isRemappingRef` mechanism for client-UUID→server-ID remap during streaming
- Maintain backward compatibility with Obsidian embedded mode (Zustand path unchanged)

## Non-Goals

- Server-side changes (no new endpoints, no session store modifications)
- Draft/auto-save for unsent messages
- Changes to the Obsidian embedded mode (Zustand path is not affected)
- Changes to the remap mechanism in `stream-event-handler.ts`
- Changes to session SSE streaming or cross-client sync

## Technical Dependencies

- `crypto.randomUUID()` — available in Chrome 92+, Firefox 95+, Safari 15.4+, Node 19+, Obsidian's Electron
- `@tanstack/react-router` — `createRoute`, `redirect`, router context for `queryClient` access in `loader`
- `@tanstack/react-query` — `QueryClient` cache access for session list in the loader

## Detailed Design

### 1. Router Loader for Auto-Selection

Add a `loader` to the `/session` route in `router.tsx`. The loader reads the `?session=` search param and, if absent, redirects to the most recent session or generates a new UUID.

**File:** `apps/client/src/router.tsx`

```typescript
const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),
  component: SessionPage,
  loader: ({ context: { queryClient }, location }) => {
    const params = new URLSearchParams(location.searchStr);
    const session = params.get('session');

    // Session already specified — nothing to do
    if (session) return;

    // Read cached session list (may be stale or empty on first load)
    const dir = params.get('dir') ?? undefined;
    const sessions = queryClient.getQueryData<Session[]>(['sessions', dir ?? null]);

    if (sessions && sessions.length > 0) {
      // Auto-select most recent session
      throw redirect({
        to: '/session',
        search: {
          session: sessions[0].id,
          dir,
        },
        replace: true,
      });
    }

    // No sessions cached — generate a fresh UUID for a new session
    throw redirect({
      to: '/session',
      search: {
        session: crypto.randomUUID(),
        dir,
      },
      replace: true,
    });
  },
});
```

**Key design decisions:**

- Uses `context.queryClient.getQueryData()` (synchronous cache read) — no async fetching in the loader. If the cache is empty (e.g., first load before sessions query completes), a new UUID is generated. The session list will load in the background and the sidebar will show sessions when ready.
- `replace: true` prevents the intermediate URL (without `?session=`) from entering browser history.
- The `Session` type import is needed from `@dorkos/shared/types`.

### 2. `handleNewSession` Generates UUID

Update `SessionSidebar.tsx` to generate a UUID directly instead of setting null.

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

**Before:**

```typescript
const handleNewSession = useCallback(() => {
  intentionallyNullRef.current = true;
  setActiveSession(null);
  // ... mobile sidebar close
}, [setActiveSession, isMobile, setSidebarOpen, sidebarCtx]);
```

**After:**

```typescript
const handleNewSession = useCallback(() => {
  setActiveSession(crypto.randomUUID());
  if (isMobile) {
    setTimeout(() => {
      setSidebarOpen(false);
      sidebarCtx?.setOpenMobile(false);
    }, TIMING.SIDEBAR_AUTO_CLOSE_MS);
  }
}, [setActiveSession, isMobile, setSidebarOpen, sidebarCtx]);
```

### 3. Remove `intentionallyNullRef` and Auto-Select Effect

Remove the following from `SessionSidebar.tsx`:

- The `intentionallyNullRef` declaration (line 31)
- The entire auto-select `useEffect` (lines 43-58)
- The `intentionallyNullRef.current = true` in `handleDashboard`

The auto-select logic is now handled by the router `loader` (runs before mount, no effect needed).

**`handleDashboard` simplification:**

```typescript
const handleDashboard = useCallback(() => {
  navigate({ to: '/' });
  if (isMobile) {
    setSidebarOpen(false);
    sidebarCtx?.setOpenMobile(false);
  }
}, [navigate, isMobile, setSidebarOpen, sidebarCtx]);
```

### 4. Remove Null Branch from `executeSubmission`

In `use-chat-session.ts`, the `executeSubmission` function currently handles `sessionId === null` by generating a UUID and firing `onSessionIdChange`. With speculative UUIDs, `sessionId` is always non-null on the `/session` route.

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**Before (lines 356-369):**

```typescript
let targetSessionId = sessionId;
if (!targetSessionId) {
  targetSessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  insertOptimisticSession(queryClient, selectedCwdRef.current, {
    id: targetSessionId,
    title: `Session ${targetSessionId.slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    permissionMode: 'default',
  });
  onSessionIdChangeRef.current?.(targetSessionId);
}
```

**After:**

```typescript
const targetSessionId = sessionId!;
```

**Additionally:** The optimistic session insert moves to fire unconditionally when the session doesn't yet exist in cache. Before sending the first message to a speculative UUID, we insert it optimistically so it appears in the sidebar:

```typescript
const targetSessionId = sessionId!;

// Insert optimistic session if this UUID doesn't exist in cache yet
const existingSessions = queryClient.getQueryData<Session[]>(['sessions', selectedCwdRef.current]);
const sessionExists = existingSessions?.some((s) => s.id === targetSessionId);
if (!sessionExists) {
  const now = new Date().toISOString();
  insertOptimisticSession(queryClient, selectedCwdRef.current, {
    id: targetSessionId,
    title: `Session ${targetSessionId.slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    permissionMode: 'default',
  });
}
```

This preserves the optimistic sidebar entry behavior without requiring `sessionId` to be null.

### 5. Update `useChatSession` Signature

The `sessionId` parameter can be narrowed since it's always non-null on the `/session` route. However, for backward compatibility with tests and potential embedded mode usage, keep the type as `string | null` but add runtime assertion behavior:

- The `enabled` guard on `historyQuery` already handles `sessionId !== null`
- The SSE effect already guards `if (!sessionId) return`
- The `streamEventHandler` uses `sessionId ?? ''` which works fine

No signature change needed — the null case simply becomes unreachable on the `/session` route.

### 6. `SessionPage` Simplification

`SessionPage` currently passes `activeSessionId` (which may be null) to `ChatPanel`. With the loader guaranteeing a session param, this is always non-null on the `/session` route. No code change needed — the existing code handles this correctly since the loader ensures `?session=` is always present.

### 7. Preserved Mechanisms

The following are explicitly **not changed**:

- **`isRemappingRef`** in `stream-event-handler.ts` — Still needed for client-UUID→server-ID remap. The `done` event handler sets `isRemappingRef.current = true` before calling `onSessionIdChange(serverSessionId)`, which triggers a URL update. The session change effect in `useChatSession` detects the flag and preserves messages instead of clearing them.

- **`handleSessionIdChange`** in `ChatPanel.tsx` — Still wired to `onSessionIdChange` option. When the server assigns a permanent ID (different from the speculative UUID), this callback updates the URL.

- **Obsidian embedded mode** — The Zustand `sessionId` path in `useSessionId` is unchanged. The `isEmbedded` branch returns `[storeId, setStoreId]`. Embedded mode doesn't use the router.

- **History query** for speculative UUIDs — The server returns an empty message list for unknown session IDs (not 404). The empty state renders correctly with "Start a conversation."

## Data Flow

### New Session (After Refactor)

```
User clicks "New session"
  → handleNewSession() generates UUID via crypto.randomUUID()
  → setActiveSession(uuid) navigates to /session?session=<uuid>
  → SessionPage reads sessionId from URL (always non-null)
  → ChatPanel receives sessionId prop (non-null)
  → useChatSession: history query fires for <uuid>, returns empty
  → Empty state renders: "Start a conversation"
  → User types message, hits send
  → executeSubmission: inserts optimistic session in cache
  → transport.sendMessage(uuid, content, ...)
  → Server creates JSONL file for the session
  → done event: server returns permanent sessionId
  → isRemappingRef = true, onSessionIdChange(permanentId)
  → URL updates to /session?session=<permanentId>
  → Session appears in sidebar (already optimistically inserted)
```

### Page Load Without Session Param

```
User navigates to /session (no ?session= param)
  → Router loader fires before component mount
  → Reads session cache: queryClient.getQueryData(['sessions', dir])
  → If sessions exist: throw redirect to /session?session=<first-session-id>
  → If no sessions: throw redirect to /session?session=<new-uuid>
  → replace: true keeps history clean
  → Component mounts with session already in URL
```

## User Experience

- **"New session" click**: Instant URL change with UUID. Empty chat state appears immediately. No flash, no revert, no race condition.
- **Page load**: If sessions exist, the most recent one loads with no intermediate empty state. If none exist, a fresh session UUID is in the URL ready for the first message.
- **Browser back/forward**: Works correctly since each session has a stable URL from the moment of creation.
- **Bookmarking**: A speculative UUID URL can be bookmarked. Returning to it shows the session if messages were sent, or an empty state if not.

## Testing Strategy

### Unit Tests

#### `router.test.ts` (New)

Test the `/session` route loader:

1. **Redirects to first session when cache has sessions and no `?session=` param** — Mock `queryClient.getQueryData` returning sessions array, verify `redirect` is thrown with `sessions[0].id` and `replace: true`
2. **Redirects to new UUID when cache is empty and no `?session=` param** — Mock empty cache, verify redirect contains a UUID-format string
3. **Does not redirect when `?session=` param is present** — Verify loader returns without throwing
4. **Preserves `?dir=` param in redirect** — Verify the `dir` search param is forwarded

#### `SessionSidebar.test.tsx` (Updated)

1. **Update "New session" test** — Expect `mockSetSessionId` to be called with a UUID string (not null). Use regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`
2. **Remove auto-select test** — The "auto-selects first session when no active session" test is no longer relevant (auto-select moved to router loader)
3. **Add test**: "New session generates unique UUIDs on each click" — Click twice, verify two different UUIDs

#### `use-chat-session-core.test.tsx` (Updated)

1. **Remove null→UUID creation tests** — Any tests that verify `sessionId === null` triggers UUID generation and `onSessionIdChange` become obsolete
2. **Add test**: "inserts optimistic session on first message for speculative UUID" — Provide a UUID sessionId, verify `insertOptimisticSession` is called when session isn't in cache
3. **Add test**: "skips optimistic insert when session already exists in cache" — Pre-populate cache, verify no insert

### Mocking Strategies

- **`crypto.randomUUID()`**: Already available in jsdom. If tests need deterministic UUIDs, mock with `vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' })`
- **Router loader**: Test by calling the loader function directly with mock context/location
- **QueryClient cache**: Use real `QueryClient` with `setQueryData` to populate cache in tests

## Performance Considerations

- **No additional network requests** — The loader reads from the existing TanStack Query cache (synchronous). No new API calls.
- **Slightly faster initial render** — The loader redirect happens before React mount, eliminating the useEffect cycle that previously caused a brief null→session transition.
- **Cache miss on first load** — If the sessions query hasn't completed when the loader runs, a new UUID is generated. The session list loads asynchronously and the sidebar populates normally. This is the same behavior as before (new users see an empty session).

## Security Considerations

- **`crypto.randomUUID()`** uses a cryptographically secure random number generator — no predictability concerns
- **Speculative UUIDs are not security-sensitive** — they're client-generated identifiers for JSONL files. The server creates the file on first message; until then, the UUID doesn't exist anywhere.
- **No new attack surface** — no new endpoints, no new data flows, no changes to authentication or session locking

## Implementation Phases

### Phase 1: Core Refactor

1. **`router.tsx`** — Add `loader` to session route with auto-select redirect logic
2. **`SessionSidebar.tsx`** — Update `handleNewSession` to generate UUID, remove `intentionallyNullRef` and auto-select effect, simplify `handleDashboard`
3. **`use-chat-session.ts`** — Remove null→UUID branch from `executeSubmission`, add optimistic insert for speculative UUIDs on first message

### Phase 2: Tests

4. **`SessionSidebar.test.tsx`** — Update "New session" assertion from null to UUID, remove auto-select test
5. **`use-chat-session-core.test.tsx`** — Remove null-branch tests, add speculative UUID tests
6. **New `router.test.ts`** — Test loader redirect logic (sessions in cache, empty cache, existing param)

### Phase 3: Cleanup

7. **Remove dead imports** — `intentionallyNullRef` removal may leave unused `useRef` import in SessionSidebar
8. **Verify all session-related tests pass** — Run full test suite
9. **Verify embedded mode** — Confirm Obsidian plugin still works (Zustand path unchanged, not affected by router changes)

## Potential Blast Radius

| Layer   | Component                 | Change                                                   | Risk   |
| ------- | ------------------------- | -------------------------------------------------------- | ------ |
| Router  | `router.tsx`              | Add `loader` with auto-select redirect                   | MEDIUM |
| Sidebar | `SessionSidebar.tsx`      | Remove `intentionallyNullRef`, update `handleNewSession` | HIGH   |
| Chat    | `use-chat-session.ts`     | Remove null→UUID branch, adjust optimistic insert        | MEDIUM |
| Chat    | `ChatPanel.tsx`           | No changes needed                                        | NONE   |
| Entity  | `use-session-id.ts`       | No changes (already stabilized)                          | NONE   |
| Entity  | `use-sessions.ts`         | No changes                                               | NONE   |
| Stream  | `stream-event-handler.ts` | No changes (remap preserved)                             | NONE   |
| Tests   | 3+ test files             | Update mocks/assertions for UUID-based flow              | MEDIUM |

## Open Questions

None — all decisions were resolved during ideation.

## Related ADRs

- None existing. This refactor may warrant an ADR documenting the speculative UUID pattern as a project convention.

## References

- `specs/improved-new-session-creation/01-ideation.md` — Full ideation with research and codebase map
- `research/20260323_new_session_creation_ux_patterns.md` — Industry analysis (ChatGPT, Claude.ai, Linear)
- `research/20260323_new_session_creation_refactor.md` — Technical research (TanStack Router loaders, crypto.randomUUID)
- TanStack Router docs on loaders and `redirect()`
