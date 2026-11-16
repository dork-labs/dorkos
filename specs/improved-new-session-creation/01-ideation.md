---
slug: improved-new-session-creation
number: 171
created: 2026-03-23
status: ideation
---

# Improved New Session Creation

**Slug:** improved-new-session-creation
**Author:** Claude Code
**Date:** 2026-03-23
**Branch:** preflight/improved-new-session-creation

---

## 1) Intent & Assumptions

- **Task brief:** Refactor the "new session" creation flow to eliminate the overloaded `sessionId === null` state that causes fragile auto-select race conditions. Assign a client UUID in the URL immediately on "New session" click (speculative URL pattern, matching Claude.ai's approach). Move auto-selection from a component-level `useEffect` to a TanStack Router `loader` for flash-free initial rendering.
- **Assumptions:**
  - Server-side session creation remains lazy (on first message) — no new API endpoints needed
  - The Transport interface (`sendMessage`) already handles arbitrary session IDs (client-generated UUIDs that don't yet exist on the server)
  - The server returns an empty message list for unknown session IDs (not 404)
  - The `done` event remap from client UUID to server-assigned ID continues to work via `isRemappingRef`
  - `crypto.randomUUID()` is available in all target environments (Chrome 92+, Firefox 95+, Safari 15.4+, Node 19+, Obsidian's Electron)
- **Out of scope:**
  - Server-side changes (new endpoints, session store)
  - Draft/auto-save for unsent messages
  - Obsidian embedded mode changes (Zustand path unchanged)
  - Changes to the remap mechanism in `stream-event-handler.ts`

## 2) Pre-reading Log

- `apps/client/src/layers/entities/session/model/use-session-id.ts`: Dual-mode hook — standalone reads `?session=` URL param, embedded reads Zustand. Setter is now `useCallback`-wrapped (stabilized in the bug fix). Returns `[string | null, setter]`.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Contains `handleNewSession` (sets `intentionallyNullRef = true`, calls `setActiveSession(null)`), the auto-select `useEffect` (lines 43-58), and `handleDashboard`. The `intentionallyNullRef` is the fragile mechanism we're removing.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: `executeSubmission` (line 354-452) has the create-on-first-message branch: if `!sessionId`, generates UUID, inserts optimistic session, fires `onSessionIdChange`. This null branch becomes dead code with the refactor.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Wires `handleSessionIdChange` callback that calls `setSessionId(newId)` — still needed for server remap.
- `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`: 12 lines — reads `useSessionId()`, passes to `ChatPanel`. No changes needed.
- `apps/client/src/router.tsx`: `/session` route with `validateSearch: zodValidator(sessionSearchSchema)`. `session` is `z.string().optional()`. Has `beforeLoad` on `/` for backward-compat redirect. No `loader` exists yet.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: `done` event handler (line 255-283) sets `isRemappingRef = true` before calling `onSessionIdChange(serverSessionId)`. This mechanism is preserved.
- `apps/client/src/layers/entities/session/model/use-sessions.ts`: Fetches session list with `refetchInterval: 60_000`. Returns `sessions: sessionsQuery.data ?? []`.
- `apps/client/src/layers/entities/session/model/use-session-search.ts`: Safe `useSearch({ strict: false })` reader. Creates a new object on each render but values are stable strings.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store with `sessionId: string | null` and `setSessionId` for embedded mode.
- `research/20260323_new_session_creation_ux_patterns.md`: Industry analysis — ChatGPT uses pure lazy creation, Claude.ai uses speculative URL + lazy body (our target pattern), Linear uses modal + optimistic post-submit.
- `research/20260323_new_session_creation_refactor.md`: Technical research — confirms `useNavigate` is reference-stable, `loader` is canonical for data-dependent redirects, `crypto.randomUUID()` has broad support.

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/router.tsx` — Route definitions, search param schemas. Adding a `loader` here for auto-selection.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — `handleNewSession()`, `intentionallyNullRef`, auto-select effect. Major refactor target.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — `executeSubmission` with null→UUID branch. Dead code removal.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — `handleSessionIdChange` callback. Minor: may simplify.
- `apps/client/src/layers/entities/session/model/use-session-id.ts` — Dual-mode session ID hook. Already stabilized.

**Shared dependencies:**

- `@/layers/shared/lib/constants.ts` — `QUERY_TIMING.SESSIONS_REFETCH_MS`
- `@/layers/shared/model/app-store.ts` — Zustand store for embedded mode
- `@tanstack/react-router` — `useNavigate`, `createRoute`, `redirect`
- `@tanstack/react-query` — `QueryClient`, query cache access in loader

**Data flow:**

```
User clicks "New session"
  → handleNewSession() generates UUID, calls setActiveSession(uuid)
  → useSessionId setter navigates to /session?session=<uuid>
  → SessionPage reads sessionId from URL (non-null)
  → ChatPanel receives sessionId prop
  → useChatSession: history query fires for <uuid>, returns empty → empty state renders
  → User sends message → executeSubmission uses existing sessionId
  → Server creates JSONL, done event may remap → URL updates
  → Session appears in sidebar via optimistic insert
```

**Feature flags/config:** None affected.

**Potential blast radius:**

| Layer   | Component                 | Change                                                   | Risk   |
| ------- | ------------------------- | -------------------------------------------------------- | ------ |
| Router  | `router.tsx`              | Add `loader` with auto-select redirect                   | MEDIUM |
| Sidebar | `SessionSidebar.tsx`      | Remove `intentionallyNullRef`, update `handleNewSession` | HIGH   |
| Chat    | `useChatSession.ts`       | Remove null→UUID branch, adjust optimistic insert        | MEDIUM |
| Chat    | `ChatPanel.tsx`           | Minor simplification                                     | LOW    |
| Entity  | `use-session-id.ts`       | No changes (already stabilized)                          | NONE   |
| Entity  | `use-sessions.ts`         | No changes                                               | NONE   |
| Stream  | `stream-event-handler.ts` | No changes (remap preserved)                             | NONE   |
| Tests   | 4+ test files             | Update mocks for UUID-based flow                         | MEDIUM |

## 4) Root Cause Analysis

Not a bug fix — this is a refactor motivated by the fragile `intentionallyNullRef` pattern that caused the auto-select race condition (already patched with a band-aid fix in this session). The root cause was `sessionId === null` being overloaded to mean both "user wants a new session" and "no session selected, auto-pick one."

## 5) Research

### Potential Solutions

**1. Speculative UUID in URL (Recommended)**

- Description: "New session" generates `crypto.randomUUID()`, navigates to `/session?session=<uuid>`. Session never null on the `/session` route.
- Pros:
  - Eliminates null state ambiguity entirely
  - Matches Claude.ai's production pattern (validated by industry research)
  - Removes `intentionallyNullRef` hack
  - Simplifies `executeSubmission` (removes null branch)
  - URL is stable and shareable from the moment of intent
- Cons:
  - History query fires for non-existent session (returns empty — acceptable)
  - Server sees UUID it doesn't know about until first message (already handled)
- Complexity: Medium
- Maintenance: Low (simpler code, fewer edge cases)

**2. `/session/new` Route Segment**

- Description: Use a separate route `/session/new` for the empty state, redirect to `/session?session=<id>` on first message.
- Pros: Clear semantic separation of "new" vs "existing"
- Cons: Adds route indirection, jarring URL jump on first message, component is identical in both states
- Complexity: Medium
- Maintenance: Medium (two routes for one component)

**3. Keep Null + Stronger Guards**

- Description: Keep `sessionId === null` for new sessions but add more robust suppression (e.g., a Zustand flag instead of a ref).
- Pros: Smallest change
- Cons: Still overloaded null state, just better-guarded — same class of bug can recur
- Complexity: Low
- Maintenance: High (fragile pattern remains)

**Recommendation:** Solution 1 (Speculative UUID). It's the only approach that eliminates the root cause rather than patching symptoms.

### Auto-Selection Mechanism

**Loader-based redirect** (chosen): The `loader` on the `/session` route accesses the sessions query cache via `routerContext.queryClient`. If `?session=` is absent, it reads the cached session list and `throw redirect({ to: '/session', search: { ...search, session: sessions[0].id }, replace: true })`. If no sessions exist, it generates a new UUID and redirects there.

- Runs before component mount — no flash of empty state
- `replace: true` keeps browser history clean
- Router context provides `queryClient` safely in the `loader` (avoids the `beforeLoad` bug with `queryClient` on client-side navigation — TanStack Router issue #2593)

## 6) Decisions

| #   | Decision                                  | Choice                                  | Rationale                                                                                                                                                  |
| --- | ----------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Auto-selection mechanism                  | Router `loader` with `throw redirect()` | More architecturally correct — runs before mount, prevents flash. Research confirms `loader` is canonical for data-dependent redirects in TanStack Router. |
| 2   | History query guard for speculative UUIDs | No guard — let it return empty          | Server already returns `[]` for unknown sessions. Empty state renders correctly. No extra complexity or dependency on sessions list freshness.             |
| 3   | Session creation pattern                  | Speculative UUID in URL                 | Eliminates null state ambiguity. Matches Claude.ai's production pattern. Removes `intentionallyNullRef` entirely.                                          |
| 4   | `isRemappingRef` mechanism                | Preserve as-is                          | Still needed for client-UUID→server-ID remap during streaming. Orthogonal to this refactor.                                                                |
