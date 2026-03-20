---
title: 'Debug/Observability Toggles for Chat Sync Paths — UX Patterns, React Implementation, and Recommendations'
date: 2026-03-17
type: implementation
status: active
tags:
  [
    settings,
    ux,
    debug,
    sse,
    polling,
    tanstack-query,
    eventsource,
    observability,
    chat,
    use-chat-session,
  ]
feature_slug: debug-sync-toggles
searches_performed: 7
sources_count: 12
---

# Debug/Observability Toggles for Chat Sync Paths

## Research Summary

DorkOS's `useChatSession` hook has two data paths beyond live SSE streaming: (1) a persistent EventSource connection (`/api/sessions/:id/stream`) that fires `sync_update` and `presence_update` events, and (2) TanStack Query polling on the `['messages', sessionId, selectedCwd]` query (3s active / 10s background). Both are candidates for Settings toggles to aid debugging. This report covers naming conventions, UX placement, React implementation patterns, side effects, and whether the toggles should apply immediately or require a reload.

---

## Key Findings

### 1. Both Toggles Can Take Effect Immediately Without a Reload

Neither data path requires a page reload to respond to a boolean toggle:

- **EventSource (persistent SSE)**: The existing `useEffect` at lines 306-343 of `use-chat-session.ts` already tears down and recreates the `EventSource` whenever `sessionId`, `isStreaming`, or `queryClient` changes. Adding the toggle boolean to the dependency array is the entire change — when the toggle flips to `false`, the effect's cleanup fires (`eventSource.close()`), and the early-return guard prevents a new one from opening.

- **Polling**: TanStack Query's `refetchInterval` accepts a function. The function is re-evaluated before each potential refetch. Returning `false` from within it is sufficient to stop future polls. No recreation of the query is needed — the query stays mounted and still holds its cached data.

Immediate effect is strictly better UX here. The user is toggling to observe behavior, and a reload would reset the in-progress state they are trying to debug.

### 2. Where the Toggles Should Live: Advanced Tab, Not Debug

DorkOS already has an **Advanced** tab in `SettingsDialog.tsx` (renders `<AdvancedTab>`). This is the correct home. The toggles are not user-facing features (no end-user benefit from disabling them) — they are power-user diagnostics. The Advanced tab is where `AdvancedTab` currently houses Danger Zone actions (reset/restart), so it already carries the "power user" semantic.

Do not create a new "Debug" tab. DorkOS has six tabs already. Adding a seventh for two toggles violates Dieter Rams: every element should justify its existence. Grouping with existing advanced controls is correct.

The toggles should be framed under a **"Diagnostics"** section heading within the Advanced tab, visually separated from the Danger Zone section. A `border rounded-md p-3 space-y-3` container with `bg-muted/30` would differentiate it from the destructive Danger Zone without alarming the user.

### 3. Naming Conventions: Descriptive, Not Technical

#### Option A: Technical names

- "Persistent SSE" / "Message polling"
- **Verdict: Too jargon-heavy.** Kai (primary persona) would understand these, but the names don't communicate _why_ you'd turn them off.

#### Option B: Feature-framed names

- "Enable cross-client sync" / "Enable background refresh"
- **Verdict: Better.** These describe what the feature does, not how it works.

#### Option C: Diagnostic framing (recommended)

- "Cross-client sync" (with description "Receives real-time updates from other clients. Disable to isolate this session's data.")
- "Background message refresh" (with description "Periodically re-fetches message history. Disable to load history once and stop.")

**Recommended names:**

- Toggle 1: **"Cross-client sync"** — `syncEnabled` in the store
- Toggle 2: **"Background message refresh"** — `pollingEnabled` in the store

These names communicate the observed behavior change, not the implementation. They pass the Apple Test: what happens for the user when they turn this off?

### 4. React Implementation: Zero New Complexity

#### Toggle 1 — Persistent SSE (EventSource)

The existing `useEffect` in `use-chat-session.ts` (lines 306-343):

```typescript
// Current dependency array:
}, [sessionId, isStreaming, queryClient, transport.clientId]);

// With toggle:
const syncEnabled = useAppStore((s) => s.syncEnabled);

useEffect(() => {
  if (!sessionId) return;
  if (isStreaming) return;
  if (!syncEnabled) return;  // <-- single guard line added

  const clientIdParam = transport.clientId ? `?clientId=${encodeURIComponent(transport.clientId)}` : '';
  const url = `/api/sessions/${sessionId}/stream${clientIdParam}`;
  const eventSource = new EventSource(url);
  // ... rest unchanged ...
  return () => {
    eventSource.close();
  };
}, [sessionId, isStreaming, queryClient, transport.clientId, syncEnabled]);
//                                                              ^^^^^^^^^^ added
```

When `syncEnabled` flips to `false`: React runs the cleanup (`eventSource.close()`) and re-runs the effect, which hits the `if (!syncEnabled) return` guard and does nothing. Clean, no new state, no stale closures possible.

When `syncEnabled` flips back to `true`: React re-runs the effect, which falls through all guards and creates a new `EventSource`. The connection is immediately live.

#### Toggle 2 — TanStack Query Polling

The existing `refetchInterval` in `use-chat-session.ts` (lines 256-261):

```typescript
// Current:
refetchInterval: () => {
  if (isStreaming) return false;
  return isTabVisible
    ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
    : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},

// With toggle:
const pollingEnabled = useAppStore((s) => s.pollingEnabled);

refetchInterval: () => {
  if (isStreaming) return false;
  if (!pollingEnabled) return false;  // <-- single line added
  return isTabVisible
    ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
    : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},
```

The `refetchInterval` function is a closure. `pollingEnabled` must be in scope — since `useQuery` is called inside `useChatSession`, and `pollingEnabled` is read from `useAppStore` at hook scope, the `refetchInterval` function will close over the latest value automatically on each render. No stale closure risk because `pollingEnabled` changes cause a re-render of the component using `useChatSession`, which re-renders `useChatSession`, which re-evaluates the `useQuery` options, which gives TanStack Query the updated function. TanStack Query evaluates the function before each potential refetch, so any in-flight 3s timer will be evaluated with the latest function the next time it fires.

**Important note on the `isTabVisible` reference**: The same stale-closure risk already applies to `isTabVisible` in the current code and it works because TanStack Query always calls the latest function reference provided to `refetchInterval`. The function is re-evaluated, not cached. This is confirmed behavior in TQ v5.

#### Store Changes

Add to `BOOL_KEYS` in `app-store.ts`:

```typescript
syncEnabled: 'dorkos-sync-enabled',
pollingEnabled: 'dorkos-polling-enabled',
```

Add to `BOOL_DEFAULTS`:

```typescript
syncEnabled: true,
pollingEnabled: true,
```

Add to `AppState` interface and implement getters/setters following the existing `readBool`/`writeBool` pattern exactly.

### 5. Side Effects When Each Path Is Disabled

#### When Cross-Client Sync (persistent SSE) is off:

- **No presence badge updates.** The `presence_update` event listener is in the same `useEffect`. `presenceInfo` and `presencePulse` will not update while the toggle is off. The last-known presence data remains stale in state until session changes (which calls `setPresenceInfo(null)`).
- **No cache invalidations from other clients.** `sync_update` events trigger `queryClient.invalidateQueries()` for `['messages']` and `['tasks']`. With sync off, changes made from a second client will not appear until polling fires (if polling is still on) or until the next navigation to that session.
- **No cross-tab tool approval notifications.** If the user has two browser tabs open and the agent needs a tool approval in tab B, tab A won't receive the `sync_update` to re-fetch the tool approval state.
- **Single-client sessions are unaffected.** If only one client is connected, there is no meaningful sync data to receive anyway — the only loss is an occasional heartbeat. This is why disabling it is a valid debug move.

#### When Background Message Refresh (polling) is off:

- **History loads exactly once, at mount.** The `enabled: sessionId !== null` guard still allows the initial fetch. `refetchInterval: false` stops _subsequent_ automatic fetches. The initial load still runs.
- **New messages from other sources appear only via SSE.** If sync SSE is still on, `sync_update` events call `queryClient.invalidateQueries(['messages', ...])` which triggers a fresh fetch even when `refetchInterval` is false. So the two toggles interact: disabling polling alone still gets updates via the persistent SSE invalidation path.
- **Post-stream history reconciliation still works.** After streaming ends, the code calls `queryClient.invalidateQueries({ queryKey: ['messages'] })` explicitly (line 435). This is an imperative invalidation, not the auto-refetch mechanism. It will still fire and fetch updated history even when polling is off.
- **Edge case: a message that arrives only via polling.** In normal operation, streaming delivers messages inline during `sendMessage()`. After streaming, the explicit invalidation catches any SDK-assigned ID remapping. Polling's role is as a background consistency check for cases where: (a) the server had a crash-resume mid-session, (b) another tool triggered a new turn without going through the DorkOS API, or (c) the SSE stream dropped and reconnected. Disabling polling makes these edge cases unrecoverable until the user manually navigates away and back.

#### Combined state (both off):

With both toggles disabled, the app behaves like a single-load transcript viewer: history fetches once when the session is selected, streaming still works normally for new messages the user sends, but no background consistency mechanism is active. This is the most useful state for debugging "why is a specific message appearing/disappearing" because it eliminates all in-flight network activity except the user's own actions.

### 6. Should Toggles Apply Immediately or Require Reload?

**Immediate effect is the correct choice** for both toggles. Rationale:

1. **Debugging intent.** The user is toggling these to observe what stops. If they must reload, the behavior they are investigating may be gone. Immediate effect lets them reproduce the symptom and then toggle to isolate the path causing it.
2. **Technical feasibility.** As shown above, both toggles can take immediate effect with minimal code changes (one `if (!flag) return` and one `return false` line).
3. **Consistency with the rest of DorkOS settings.** All existing boolean settings in `SettingsDialog` (show timestamps, expand tool calls, etc.) take immediate effect. A reload requirement would be inconsistent and jarring.
4. **The only scenario requiring a reload would be if the toggles lived in server-side config.** But these are client-side observability controls — localStorage persistence via the `app-store.ts` pattern is appropriate.

---

## Detailed Analysis

### Implementation Sequence

The minimal change set to ship both toggles:

**Step 1: app-store.ts** — Add two boolean entries to `BOOL_KEYS`, `BOOL_DEFAULTS`, `AppState`, and the store body. This is a ~20-line addition following the exact existing pattern for `enableNotificationSound` (lines 348-355 in `app-store.ts`).

**Step 2: use-chat-session.ts** — Two targeted edits:

- Import `syncEnabled` and `pollingEnabled` from `useAppStore` at the top of `useChatSession`
- Add `if (!syncEnabled) return;` in the persistent SSE `useEffect` and add `syncEnabled` to its dependency array
- Add `if (!pollingEnabled) return false;` in the `refetchInterval` function

**Step 3: AdvancedTab.tsx** — Add a "Diagnostics" section with two `SettingRow` + `Switch` components, identical in structure to the existing switches in `SettingsDialog.tsx`.

No new files required. No Transport interface changes. No server changes.

### UX Layout for the Advanced Tab Diagnostics Section

```
┌─ Advanced ───────────────────────────────────────────────────────┐
│  [existing AdvancedTab content — Danger Zone, etc.]              │
│                                                                   │
│  ┌─ Diagnostics ─────────────────────────────────────────────┐   │
│  │  Cross-client sync           [●──] On                     │   │
│  │  Receives real-time updates from other open clients.       │   │
│  │  Disable to isolate this session's data.                   │   │
│  │                                                            │   │
│  │  Background message refresh  [●──] On                     │   │
│  │  Periodically re-fetches message history (every 3s).      │   │
│  │  Disable to load history once and stop.                    │   │
│  └────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

The section should:

- Use `bg-muted/30 border rounded-md p-3 space-y-3` container
- Include a section header: "Diagnostics" with `text-xs font-medium text-muted-foreground uppercase tracking-wider`
- Use the existing `SettingRow` component from `SettingsDialog.tsx` (or extract it to a shared component if used in multiple tabs — it is currently defined inline in `SettingsDialog.tsx`)
- Default both to `true` (on) so normal operation is unaffected

**Should the section be visually prominent or subtle?**

Subtle. These are not features users encounter normally. A muted container (not a destructive red border) communicates "advanced but not dangerous." The Danger Zone already uses the `border-destructive` treatment for genuinely irreversible actions. Disabling sync or polling is trivially reversible.

### Stale Closure Risk Analysis

**For the EventSource toggle:** No stale closure risk. The `useEffect` dependency array includes `syncEnabled`. When `syncEnabled` changes, the effect re-runs from scratch with the current value. The `EventSource` object created inside the effect is local to that effect run and is closed by the cleanup function. No callbacks inside the effect read `syncEnabled` after creation.

**For the polling toggle:** No stale closure risk. The `refetchInterval` function is re-passed to `useQuery` on every render (it's an inline arrow function). TanStack Query calls the function reference it currently has, which is always the latest one from the most recent render. `pollingEnabled` from `useAppStore` is a Zustand selector — when it changes, the component re-renders, the `useQuery` call re-runs with the updated function. There is no scenario where the function captures an old `pollingEnabled` value.

The only stale closure concern in `use-chat-session.ts` is the `executeSubmission` callback (noted with `eslint-disable` comment at line 466). The sync toggles do not interact with `executeSubmission` at all.

### Interaction Between the Two Toggles

| Sync On  | Polling On  | Behavior                                                                                                                |
| -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Both on  | Both on     | Normal operation — real-time sync + background consistency                                                              |
| Sync off | Polling on  | No cross-client updates until polling fires (3s). Good for isolating "is this from SSE or polling?"                     |
| Sync on  | Polling off | Rely entirely on SSE for consistency. History loads once at mount + on explicit invalidations (post-stream, on demand). |
| Both off | Both off    | Single-load viewer mode. Best for isolating streaming bugs from consistency bugs.                                       |

This interaction should be documented in the setting description, or at minimum the descriptions should hint at the dependency ("Note: when sync is enabled, it can also trigger a message refresh").

### Naming Decision: `devtoolsOpen` Precedent

The existing `devtoolsOpen` toggle in `app-store.ts` (line 93) is notable: it is already a debug-mode gate, gated behind the Preferences tab. It is **not** persisted to `localStorage` (it has no entry in `BOOL_KEYS`). This is intentional — devtools reset to off on page load.

The sync/polling toggles should behave differently: they **should** persist to `localStorage`. The user may be running an extended debugging session across multiple page loads and does not want the toggles resetting. This is the correct behavior since `readBool` with `true` as default means normal users are unaffected.

If a future decision is made to _not_ persist them (treat them as session-local debug state), the implementation would just omit the `BOOL_KEYS`/`BOOL_DEFAULTS` entries and use `useState(true)` locally in `useChatSession`. But persistence is better for debugging.

---

## Approach Comparison

### Naming Options

| Option                                                | Pros                                        | Cons                                                              | Verdict         |
| ----------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- | --------------- |
| "Persistent SSE" / "Message polling"                  | Technically precise, Kai would grok it      | Too implementation-specific; doesn't communicate user impact      | No              |
| "Enable cross-client sync" / "Enable message polling" | Clear what enabling does                    | "Polling" still jargon; "enable" prefix is redundant for a toggle | Partial         |
| "Cross-client sync" / "Background message refresh"    | Communicates user-visible effect; no jargon | Slightly abstract for "what exactly is SSE?"                      | **Recommended** |
| "Live sync" / "Auto-refresh"                          | Shortest, most approachable                 | Too vague for power users who need to know what they're disabling | No              |

### Placement Options

| Option                                  | Pros                                                               | Cons                                                                                 | Verdict         |
| --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------- |
| New "Debug" tab                         | Clear purpose segregation                                          | Sixth tab for two switches; wasteful; may encourage "debug mode" as a permanent mode | No              |
| Preferences tab (existing)              | Already has many toggles                                           | Mixes debug with display preferences; clutters regular users' settings               | No              |
| Advanced tab, new "Diagnostics" section | Correct semantic home; no new tabs; power-user context already set | `AdvancedTab.tsx` gets slightly longer                                               | **Recommended** |
| Dev-mode only (hidden in production)    | Avoids cluttering UI for users                                     | DorkOS has no production/dev UI branching; adds conditional complexity               | No              |
| Behind `devtoolsOpen` gate              | Only visible when devtools is on                                   | Devtools is not persisted; creates awkward two-toggle dance                          | No              |

### Immediacy Options

| Option                                  | Pros                                                                           | Cons                                                                 | Verdict         |
| --------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------- |
| Immediate effect                        | Matches debugging intent; matches existing settings behavior; technically easy | None                                                                 | **Recommended** |
| Requires page reload                    | Simpler mental model ("settings apply on restart")                             | Destroys in-progress debug state; inconsistent with rest of settings | No              |
| Takes effect on next session navigation | Avoids disrupting active session                                               | Still loses current debug state; more complex to implement           | No              |

---

## Final Recommendations

### Implementation Plan

1. **Store**: Add `syncEnabled` (key: `'dorkos-sync-enabled'`, default: `true`) and `pollingEnabled` (key: `'dorkos-polling-enabled'`, default: `true`) to `app-store.ts`, following the exact pattern of existing boolean settings (see `enableNotificationSound` at lines 348-355 as the canonical template).

2. **Hook**: In `use-chat-session.ts`:
   - Read both values at hook scope with `useAppStore((s) => s.syncEnabled)` and `useAppStore((s) => s.pollingEnabled)`
   - Add `if (!syncEnabled) return;` as the third guard in the persistent SSE `useEffect` (after the `!sessionId` and `isStreaming` guards)
   - Add `syncEnabled` to the `useEffect` dependency array
   - Add `if (!pollingEnabled) return false;` as the second return in the `refetchInterval` function (after the `isStreaming` check)

3. **UI**: In `AdvancedTab.tsx`, add a "Diagnostics" section with two `SettingRow` + `Switch` pairs above or below the existing Danger Zone section. Use a visually distinct but non-alarming container (`bg-muted/30 border rounded-md`).

4. **Description copy** (final):
   - Toggle 1 label: `"Cross-client sync"`, description: `"Receives real-time updates when other clients modify this session. Disable to isolate data paths."`
   - Toggle 2 label: `"Background message refresh"`, description: `"Re-fetches message history every 3s. Disable to load history once and stop automatic updates."`

5. Both toggles persist to localStorage, take immediate effect, and default to `true`. No reload, no server changes, no new files.

### What to Communicate to the User

The descriptions should make the side effects explicit enough to be useful without requiring deep knowledge of the architecture. "Disable to isolate data paths" is the right level of abstraction — it tells Kai exactly what he needs to know without explaining SSE internals.

---

## Research Gaps & Limitations

- The interaction between `queryClient.invalidateQueries()` (called inside the `sync_update` listener) and the `refetchInterval: false` state was confirmed correct (imperative invalidation overrides `refetchInterval`) based on TanStack Query documentation behavior, but was not verified against the exact TanStack Query version in use. Should be verified with `pnpm ls @tanstack/react-query` to confirm v5 behavior applies.
- The `AdvancedTab.tsx` content was not read during this research. The Diagnostics section placement (above vs. below Danger Zone) should be determined by reading `AdvancedTab.tsx` before implementation.
- No research was done on whether the two new localStorage keys need to be added to the `resetPreferences()` function in `app-store.ts`. They probably should be, for consistency.

---

## Sources & Evidence

- TanStack Query v5 `refetchInterval` accepts `number | false | ((query: Query) => number | false | undefined)` — [useQuery | TanStack Query React Docs](https://tanstack.com/query/v5/docs/framework/react/reference/useQuery)
- Disabling/pausing queries — [Disabling/Pausing Queries | TanStack Query React Docs](https://tanstack.com/query/v5/docs/framework/react/guides/disabling-queries)
- EventSource cleanup in React `useEffect` — standard pattern, confirmed in [React Hooks Dependencies and Stale Closures | Bharathi Kannan](https://www.bharathikannan.com/blog/react-hooks-dependencies-and-stale-closures)
- React 19 `useEffectEvent` for stale closure avoidance — [React useEffectEvent: Goodbye to stale closure headaches — LogRocket](https://blog.logrocket.com/react-useeffectevent/) (not needed here as dependency array covers the case)
- TanStack Query conditionally disabled refetchInterval — [Discussion #713 · TanStack/query](https://github.com/TanStack/query/discussions/713)
- DorkOS source: `apps/client/src/layers/features/chat/model/use-chat-session.ts` — persistent SSE (lines 306-343) and polling (lines 250-262)
- DorkOS source: `apps/client/src/layers/shared/model/app-store.ts` — existing boolean persistence pattern
- DorkOS source: `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — existing tabs, `SettingRow` component
- DorkOS source: `apps/client/src/layers/shared/lib/constants.ts` — `QUERY_TIMING` values (3s active, 10s background)

## Search Methodology

- Searches performed: 7
- Most productive search terms: "TanStack Query refetchInterval false disable site:tanstack.com", "React EventSource useEffect cleanup dependency array toggle", "TanStack Query conditionally disable refetchInterval toggle React"
- Primary information sources: TanStack Query docs, DorkOS source code (primary), React hooks stale closure references
