---
title: 'New Session Creation Refactor — TanStack Router + Query Patterns'
date: 2026-03-23
type: implementation
status: active
tags:
  [
    session-creation,
    tanstack-router,
    tanstack-query,
    speculative-uuid,
    auto-select,
    url-driven-state,
    react-19,
    use-navigate,
    beforeload,
    loader,
    refactor,
  ]
feature_slug: improved-new-session-creation
searches_performed: 11
sources_count: 18
---

## Research Summary

This report answers the five research questions for the new session creation refactor. The core proposal — assign a client-generated UUID in the URL immediately on "New session" click — is the correct approach and aligns with Claude.ai's production pattern. The report details the TanStack Router idioms for doing this cleanly, how TanStack Query should handle the intermediate "UUID in URL but not yet on server" state, and two viable alternatives with explicit pros/cons. The recommended architecture is: **client UUID in URL + `enabled: false` history query + `retry: false` for the sessions fetch until the session materializes**, all managed via TanStack Router's `loader` + `throw redirect()` for auto-selection.

Prior research that remains relevant:

- `research/20260323_new_session_creation_ux_patterns.md` — industry patterns (ChatGPT, Claude.ai, Linear). Claude.ai's "speculative eager URL + lazy body" is confirmed as the right model to copy.
- `research/20260320_tanstack_router_code_patterns.md` — complete code patterns for search params, `useNavigate`, `beforeLoad` vs `loader`.

---

## Key Findings

1. **Client-generated UUID in URL is the right architecture**: It eliminates the `null` vs "intentionally null" ambiguity by making `?session=` always present on `/session`. The `intentionallyNullRef` pattern was a symptom of a missing state representation — the new approach resolves the root cause, not the symptom.

2. **TanStack Router's `loader` (not `beforeLoad`) is the right place for auto-selection redirects**: `loader` has access to `queryClient` through router context, can `throw redirect()`, and runs after the route matches but before the component renders. `beforeLoad` runs first but cannot easily await async data (like a session list) without creating coupling issues. The `loader` pattern is idiomatic for data-dependent redirects.

3. **`useNavigate` is stable across renders**: TanStack Router's `useNavigate` internally uses `useCallback` with an empty dependency array. The returned `navigate` function is reference-stable and safe to use as a `useEffect` dependency without stale closure risk. The existing `useCallback([navigate])` wrapper in `use-session-id.ts` is already correct but technically redundant.

4. **TanStack Query's `enabled` flag is the clean guard for "UUID not yet on server"**: When a speculative UUID is in the URL, `historyQuery` should be `enabled: false` until the session actually exists (i.e., until the first message is sent and the server creates the JSONL file). This avoids 404 errors entirely during the pre-creation window. The `enabled` option is the correct mechanism — not `retry: false` alone.

5. **The `/session/new` route segment pattern is a viable alternative** but adds route complexity with limited benefit. It works well in frameworks where the new-entity view is genuinely different from the entity view (different components, different layout). For DorkOS where the chat panel is the same component in both states, it adds indirection without payoff.

6. **`crypto.randomUUID()` is baseline-safe for DorkOS**: Chrome 92+, Firefox 95+, Safari 15.4+ — all above the implicit baseline for a developer tool. No polyfill needed. Only caveat: requires HTTPS or localhost (which is always true for DorkOS's dev and prod environments).

---

## Detailed Analysis

### 1. TanStack Router Search Params for Session Management

**Should `?session=` be always-present vs optional?**

The current schema declares `session: z.string().optional()`, which is correct for the route level. The proposed refactor does not change this schema — it changes what the caller puts in the URL. After the refactor, any navigation to `/session` that originates from "New session" will always carry a UUID. The only case where `session` is absent from the URL is navigating to `/session` without a specific session in mind (e.g., from the dashboard root), at which point the `loader` redirects to the most recent session.

The schema stays optional. The behavioral change is:

- Before: `/session` (no param) → component handles `null` with the `intentionallyNullRef` sentinel
- After: `/session` (no param) → loader redirects to first session or to `/session?session=<newUUID>`

**How to navigate while preserving other params:**

TanStack Router's functional `search` updater is the correct pattern:

```typescript
// Navigating to a specific session — preserves ?dir= and any other params
navigate({
  to: '/session',
  search: (prev) => ({ ...prev, session: sessionId }),
});

// Creating a new session — generate UUID on click, navigate immediately
const newId = crypto.randomUUID();
navigate({
  to: '/session',
  search: (prev) => ({ ...prev, session: newId }),
});
```

The `from` option on `useNavigate` narrows TypeScript's understanding to only the session route's params. Without `from`, TypeScript sees the union of all routes' search params (very wide). The existing code in `use-session-id.ts` already correctly omits `from` since it navigates to `/session` from any route.

---

### 2. Speculative UUID + Lazy Entity Pattern

**The complete state machine:**

```
State 1: No session selected
  URL: /session (no ?session=)
  → loader: redirect to most recent session, or redirect to /session?session=<newUUID>

State 2: Speculative UUID in URL, session not yet on server
  URL: /session?session=<clientUUID>
  historyQuery: enabled=false (session doesn't exist yet)
  SessionPage shows: empty chat input, no history

State 3: First message sent
  URL: /session?session=<clientUUID> (unchanged during send)
  historyQuery: still enabled=false
  useChatSession: creates session server-side (JSONL file created)
  insertOptimisticSession: adds to cache

State 4: Session exists on server
  Server may remap clientUUID → sdkUUID (existing pattern via isRemappingRef)
  URL: /session?session=<sdkUUID> (updated by onSessionIdChange)
  historyQuery: now enabled=true
  Normal chat continues
```

**How to determine "does this UUID exist on server?"**

The session list query (`['sessions', selectedCwd]`) is already fetched via `useSessions`. After "New session" is clicked and a UUID is assigned, the UUID will not appear in this list until the server creates the JSONL file and the list is refetched (60s interval or on next message complete). The cleanest flag is: **"is this UUID present in the sessions list?"**

```typescript
// In useChatSession or a derived hook:
const sessions = useQuery({ queryKey: ['sessions', selectedCwd], ... });
const sessionExistsOnServer = sessions.data?.some(s => s.id === sessionId) ?? false;
// OR: check if sessionId matches the pattern of a server-assigned ID (contains no client-UUID prefix)
```

For the history query specifically, the simplest guard is:

```typescript
const historyQuery = useQuery({
  queryKey: ['messages', sessionId, selectedCwd],
  queryFn: () => transport.getMessages(sessionId!, selectedCwd ?? undefined),
  enabled: sessionId !== null && sessionExistsOnServer,
  // ...
});
```

This avoids any 404 during the speculative window entirely — the query never fires until the session is confirmed to exist.

**If you want to fire the query and handle 404 gracefully:**

If for some reason you want to fire the query speculatively (e.g., to detect an existing session quickly), configure `retry` to not retry on 404:

```typescript
useQuery({
  queryKey: ['messages', sessionId],
  queryFn: ...,
  enabled: sessionId !== null,
  retry: (failureCount, error) => {
    // Don't retry on 404 — session legitimately doesn't exist yet
    const status = (error as { status?: number })?.status;
    if (status === 404) return false;
    return failureCount < 3;
  },
  // Map 404 to empty history rather than error state:
  select: (data) => data,
});
```

The TanStack Query maintainers explicitly confirmed this is the intended pattern for eventually-consistent systems: "if you create resource and then query it immediately, it might return 404 and then after one second 200." The `retry` function is the correct hook for this.

**`crypto.randomUUID()` usage:**

```typescript
// In the "New session" button handler:
import { useNavigate } from '@tanstack/react-router';

function NewSessionButton() {
  const navigate = useNavigate();

  const handleNewSession = useCallback(() => {
    const newSessionId = crypto.randomUUID();
    navigate({
      to: '/session',
      search: (prev) => ({
        ...prev,
        session: newSessionId,
        // Preserve ?dir= if already set, or use selectedCwd
      }),
    });
  }, [navigate]);

  return <button onClick={handleNewSession}>New session</button>;
}
```

`crypto.randomUUID()` is synchronous, fast, and requires no imports. It is available in all modern browsers under HTTPS/localhost. The UUID it produces is a standard v4 UUID, indistinguishable from a server-generated one — which is the point.

---

### 3. Session Auto-Selection Patterns

**The correct place: `loader` with `throw redirect()`**

TanStack Router provides a `loader` function on each route that runs before the component mounts. It has access to router context (including `queryClient`). You can `throw redirect()` from a loader to perform a navigation before the component ever renders.

```typescript
const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),

  loader: async ({ context: { queryClient }, search }) => {
    // If ?session= is already present, nothing to do
    if (search.session) return;

    // No session in URL — fetch the session list and redirect
    const sessions = await queryClient.ensureQueryData({
      queryKey: ['sessions' /* selectedCwd would need to come from router context or store */],
      queryFn: () => transport.listSessions(),
      staleTime: 30_000, // 30s — don't re-fetch if we have recent data
    });

    if (sessions.length > 0) {
      // Redirect to most recent session
      throw redirect({
        to: '/session',
        search: { session: sessions[0].id },
        replace: true, // don't add this to history — the /session bare URL was transient
      });
    } else {
      // No sessions exist at all — create a new one speculatively
      throw redirect({
        to: '/session',
        search: { session: crypto.randomUUID() },
        replace: true,
      });
    }
  },

  component: SessionPage,
});
```

**Why `loader` and not `beforeLoad`:**

|                                | `beforeLoad`                    | `loader`                                 |
| ------------------------------ | ------------------------------- | ---------------------------------------- |
| Runs before child `beforeLoad` | Yes                             | No (runs in parallel with child loaders) |
| Can access router context      | Yes (but async data is tricky)  | Yes, full `context`                      |
| Can `throw redirect()`         | Yes                             | Yes                                      |
| Intended for                   | Auth checks, context enrichment | Data fetching, data-dependent redirects  |
| If throws, child routes load?  | No (stops the chain)            | N/A (component won't render anyway)      |

For a data-dependent redirect ("redirect to first session if session list is non-empty"), `loader` is semantically correct. `beforeLoad` is for condition checks that don't require awaiting async data. Accessing `queryClient` in `beforeLoad` has a known issue (GitHub #2593) where it fails on client-side navigation vs direct URL entry — `loader` does not have this issue.

**Why not a `useEffect` redirect in the component?**

```typescript
// ANTI-PATTERN — don't do this
function SessionPage() {
  const { session } = useSearch({ from: '/session' });
  const { sessions } = useSessions();
  const navigate = useNavigate();

  useEffect(() => {
    if (!session && sessions.length > 0) {
      navigate({ to: '/session', search: { session: sessions[0].id } });
    }
  }, [session, sessions, navigate]);

  // ...
}
```

Problems with this approach:

1. The component renders once with `session = undefined` before the effect fires, causing a flash of empty state
2. On every render cycle where `sessions` changes (60s refetch), the effect re-evaluates — fragile
3. If `sessions` is loading, the redirect is deferred until after load completes, causing visible latency
4. The `loader` approach prevents the component from mounting at all until the redirect is resolved

**The `replace: true` detail is important**: When auto-redirecting from `/session` to `/session?session=abc123`, you want `replace: true` so the browser history doesn't gain a `/session` entry (bare URL). The user pressing Back should not return to the redirecting URL.

---

### 4. Stable Hook References

**`useNavigate` stability guarantee:**

From TanStack Router's source code (confirmed via GitHub issue #639): the `useNavigate` hook's return value is created with `useCallback(fn, [])` — an empty dependency array. This means the `navigate` function reference is stable across all re-renders, identical to a React ref in terms of identity. It will never cause dependency array churn.

The existing code in `use-session-id.ts`:

```typescript
const setSessionId = useCallback(
  (id: string | null) => {
    navigate({ ... });
  },
  [navigate]  // navigate is stable, so this useCallback is technically a no-op
);
```

This is correct and fine. The `useCallback` wrapper around `navigate` is not harmful — it's a redundant memoization that costs nothing. Keep it for clarity (it signals intent that `setSessionId` should be stable).

**For hooks that return setter functions generally:**

The `useCallback` + empty deps pattern is only correct when the callback captures no reactive values. If it captures reactive values (like `selectedCwd` from the store), those must be in the dependency array. The pattern of using refs to avoid stale closures (already present in `useChatSession` via `onSessionIdChangeRef` etc.) is the correct escape hatch when you need stability + fresh value access.

**The `navigate` function from within the session route:**

If calling `navigate` from a component that is already on `/session`, use the `from` option:

```typescript
const navigate = useNavigate({ from: '/session' });
// TypeScript now knows the search params are { session?: string, dir?: string }
navigate({ search: (prev) => ({ ...prev, session: newId }) });
```

Without `from`, the search type is `Record<string, unknown>` — no type safety. The `from` option narrows TypeScript's inference.

---

### 5. Alternative Approaches

#### Alternative A: `/session/new` Route Segment

**How it works:**

Add a distinct route at `/session/new` (or `/session/create`). This route renders the same chat panel in "new session" mode. When the user sends their first message, the URL is updated to `/session?session=<id>` via `replace`.

```typescript
const newSessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session/new',
  component: NewSessionPage, // or re-uses ChatPanel with mode='new'
});
```

**Pros:**

- The URL clearly communicates state — no ambiguity about what a client UUID means
- No speculative UUID in the URL that may confuse server-side logging or analytics
- Simple to implement: the component knows it's in "new" mode without reading the session list

**Cons:**

- Requires either a duplicate component or a `mode` prop on `ChatPanel` — more indirection
- Breaks the existing `useSessionId` hook abstraction which assumes `?session=` is the state carrier
- The `/session/new` URL cannot be bookmarked or shared (by definition, it's ephemeral)
- After first message, the URL changes from `/session/new` to `/session?session=<id>` — this feels like a jump, whereas keeping the same URL (with UUID that gets validated) feels seamless
- Session ID is not available in the URL for the duration of "new" mode — prevents any deep-linking or sharing of the new session before first message

**Verdict:** Works cleanly if new-session and existing-session are genuinely different UI states. For DorkOS they share the same component with the same UI, making this approach add complexity without benefit.

#### Alternative B: `loader` for Auto-Selection Only, Eliminate `null` Differently

**How it works:**

Instead of putting a speculative UUID in the URL, keep `?session=` optional but move the auto-selection logic into the `loader`. The component never sees `session = undefined` because the loader always resolves it before rendering.

```typescript
loader: async ({ search, context: { queryClient } }) => {
  if (search.session) return; // already have a session
  const sessions = await queryClient.ensureQueryData(...);
  if (sessions.length > 0) {
    throw redirect({ to: '/session', search: { session: sessions[0].id }, replace: true });
  }
  // No sessions: let component render in "new session" canvas mode (session = undefined)
  // The component is now guaranteed to only see session=undefined when there are zero sessions
}
```

This eliminates the `intentionallyNullRef` without requiring a speculative UUID — the component knows that `session = undefined` now exclusively means "no sessions exist in the system, user should create the first one."

**Pros:**

- No speculative UUID in the URL (cleaner URLs)
- The component's `null` state has a single, clear meaning: "truly no sessions"
- No handling of the "UUID exists in URL but not on server" intermediate state
- Simpler change — touches only the `loader` and removes the `intentionallyNullRef`

**Cons:**

- After first message on a fresh install, the URL is still `/session` (no UUID) during the streaming phase — slightly inconsistent
- The "new session" action from the sidebar still needs to navigate somewhere; if it navigates to `/session` (bare), the loader will immediately redirect to the most recent session, not create a new one. The sidebar would need to navigate to `/session?session=<newUUID>` anyway.
- Doesn't fix the URL being unstable during composition — still can't bookmark/share a new session before first message

**Verdict:** Partially solves the problem. Still needs the speculative UUID for the sidebar "New session" action. Best used as a complement to Approach A (proposed UUID approach), not a replacement.

---

## Recommended Architecture

The recommended approach is **the proposed speculative UUID pattern** with the following implementation details:

### 1. New Session Button — Generate UUID on Click

```typescript
// In SessionSidebar or wherever "New session" is triggered:
function handleNewSession() {
  const sessionId = crypto.randomUUID();
  navigate({
    to: '/session',
    search: (prev) => ({
      ...prev,
      session: sessionId,
      // Preserve dir if already set
    }),
    replace: false, // This IS a new history entry — user navigated to it intentionally
  });
}
```

### 2. Session Route Loader — Auto-Selection for Bare URL

```typescript
const sessionRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/session',
  validateSearch: zodValidator(sessionSearchSchema),

  loader: async ({ context: { queryClient }, search }) => {
    // If ?session= is present, the component handles it
    if (search.session) return;

    // No session: auto-select most recent or start fresh
    const sessions = await queryClient.ensureQueryData(sessionsQueryOptions(selectedCwd));

    if (sessions.length > 0) {
      throw redirect({
        to: '/session',
        search: (prev) => ({ ...prev, session: sessions[0].id }),
        replace: true,
      });
    } else {
      throw redirect({
        to: '/session',
        search: (prev) => ({ ...prev, session: crypto.randomUUID() }),
        replace: true,
      });
    }
  },

  component: SessionPage,
});
```

### 3. History Query — `enabled` Guard for Speculative UUID

In `useChatSession`, add a guard that disables the history query until the session appears in the session list:

```typescript
// Determine if this sessionId is known to the server
const { sessions } = useSessions();
const sessionExistsOnServer = sessions.some(s => s.id === sessionId);

const historyQuery = useQuery({
  queryKey: ['messages', sessionId, selectedCwd],
  queryFn: () => transport.getMessages(sessionId!, selectedCwd ?? undefined),
  staleTime: QUERY_TIMING.MESSAGE_STALE_TIME_MS,
  refetchOnWindowFocus: false,
  // Only fetch history when the session is confirmed to exist on the server.
  // When sessionId is a speculative UUID (new session, not yet created), this
  // stays disabled until the first message creates the server-side JSONL file.
  enabled: sessionId !== null && sessionExistsOnServer,
  refetchInterval: ...,
});
```

### 4. Remove `intentionallyNullRef`

With the loader always redirecting from bare `/session` to `/session?session=<id>`, the component never receives `session = undefined` after the initial render. The `intentionallyNullRef` and all code paths that reference it can be deleted.

### 5. `useSessionId` — Type Change

The return type of `useSessionId` can change from `[string | null, ...]` to `[string, ...]` for the standalone (web) path, since the loader guarantees `?session=` is always present by the time `SessionPage` renders. This is a welcome type tightening that propagates safety through the call stack.

---

## Trade-off Summary

| Approach                         | Complexity | URL stability                  | No server garbage                  | Type safety                   | Recommended                 |
| -------------------------------- | ---------- | ------------------------------ | ---------------------------------- | ----------------------------- | --------------------------- |
| Speculative UUID (proposed)      | Low        | UUID immediately on click      | Yes (session only created on send) | High (can narrow to `string`) | **Yes**                     |
| `/session/new` segment           | Medium     | Different URL, then URL change | Yes                                | Medium                        | No                          |
| Loader-only, keep null for empty | Low        | None until first send          | Yes                                | Medium (null still possible)  | Complement, not replacement |
| Eager server creation on click   | High       | UUID immediately on click      | No (orphan records)                | High                          | No                          |

---

## Sources & Evidence

- "if you create resource and then query it immediately, it might return 404 and then after one second 200" — [should it retry for 404 responses? · TanStack/query · Discussion #372](https://github.com/TanStack/query/discussions/372) — confirms the eventually-consistent pattern requires `retry` configuration
- TanStack Query retry function: `retry: (failureCount, error) => error.status !== 404 && failureCount < 3` — [React Query Retry Strategies](https://www.dhiwise.com/blog/design-converter/react-query-retry-strategies-for-better-error-handling)
- "The `useNavigate` hook's return value is created with `useCallback` with an empty dependency array" — [useNavigate hook | TanStack Router Docs](https://tanstack.com/router/v1/docs/framework/react/api/router/useNavigateHook) + GitHub source confirmation from Issue #639
- "If an error or a redirect are thrown in a `beforeLoad`, loading will not take place for the route nor its child routes" — [TanStack Router's beforeLoad vs. loader](https://spin.atomicobject.com/tanstack-router-beforeload/)
- "The major difference between the two comes down to their intended purposes. `beforeLoad` is for checking if a route should be loaded and building context, and `loader` is for fetching data to be used in components" — [TanStack Router beforeLoad vs loader](https://spin.atomicobject.com/tanstack-router-beforeload/)
- "queryClient not available in `beforeLoad` on client side loading" — [GitHub Issue #2593](https://github.com/TanStack/query/issues/2593) — confirms `loader` is safer for `queryClient`-dependent redirects
- "The redirect function returns a new Redirect object that can be either returned or thrown from places like a Route's `beforeLoad` or `loader`" — [redirect function | TanStack Router Docs](https://tanstack.com/router/v1/docs/framework/react/api/router/redirectFunction)
- `crypto.randomUUID()` support: Chrome 92+, Firefox 95+, Safari 15.4+ — [MDN: Crypto.randomUUID()](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)
- Claude.ai pattern: URL changes on "New chat" click to `claude.ai/chat/{id}`, but conversation not persisted until first message — `research/20260323_new_session_creation_ux_patterns.md`
- TanStack Router `useNavigate` with `from` option for type-safe search param updates — `research/20260320_tanstack_router_code_patterns.md`

---

## Research Gaps & Limitations

- The exact DorkOS implementation of `selectedCwd` access from within a TanStack Router `loader` is not resolved here. Route loaders receive `context` (which currently only has `queryClient`) — if `selectedCwd` is Zustand state, it cannot be passed through router context without wiring. This needs evaluation: either pass `selectedCwd` as a search param, or call `store.getState().selectedCwd` directly (a known anti-pattern but acceptable for loaders since they are not React components).
- The behavior of `queryClient.ensureQueryData` when the session list is stale vs fresh in the loader was not performance-profiled. The `staleTime` setting is critical to avoid blocking navigation on every `/session` visit.
- The `replace: true` behavior in TanStack Router's `throw redirect()` was confirmed semantically but not tested against the browser history stack directly. Verify that redirected entries don't appear in history before shipping.

---

## Search Methodology

- Searches performed: 11
- Most productive terms: "TanStack Router beforeLoad loader redirect queryClient 2025", "TanStack Query retry 404 not found eventually consistent", "TanStack Router useNavigate stable reference useCallback"
- Primary sources: tanstack.com docs (via redirects), github.com/TanStack/router issues and discussions, github.com/TanStack/query discussions, spin.atomicobject.com TanStack Router deep-dive
