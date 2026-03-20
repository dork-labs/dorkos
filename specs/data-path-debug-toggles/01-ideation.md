---
slug: data-path-debug-toggles
number: 146
created: 2026-03-17
status: ideation
---

# Data Path Debug Toggles

**Slug:** data-path-debug-toggles
**Author:** Claude Code
**Date:** 2026-03-17
**Branch:** preflight/data-path-debug-toggles

---

## 1) Intent & Assumptions

- **Task brief:** Add Settings toggles to independently disable the two secondary data paths (Persistent SSE and Message Polling) in the chat client, for debugging "strange behavior" in the chat UI.
- **Assumptions:**
  - Live SSE (the POST response stream for sending/receiving messages) is NOT toggleable — it's the core interaction loop
  - Both toggles default to enabled, preserving existing behavior
  - Toggles take effect immediately (no page reload) via React dependency arrays
  - When cross-client sync is disabled, presence UI (ClientsItem) naturally disappears since `presenceInfo` becomes null
  - When polling is disabled, history still loads once on mount — only periodic refetching stops
- **Out of scope:**
  - Server-side changes or new API endpoints
  - Dev-only panels or overlays
  - Toggling other polling queries (sessions, git status, relay, mesh, etc.)
  - Live SSE toggle (would break core functionality)

## 2) Pre-reading Log

- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store with `BOOL_KEYS`/`BOOL_DEFAULTS` pattern for persisted boolean toggles. `readBool()`/`writeBool()` helpers safely handle localStorage. `resetPreferences()` uses `...BOOL_DEFAULTS` spread, so new keys are automatically included.
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: 6-tab Settings dialog. Advanced tab already exists. Destructures store values at lines 45-83.
- `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`: Currently only contains Danger Zone (Reset/Restart). 73 lines. Room to add debug toggles above.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: 562-line hook. Persistent SSE at lines 306-343 (EventSource with `sync_update` + `presence_update`). Message polling at lines 249-262 (`refetchInterval` callback returning `false` when streaming, or adaptive interval based on tab visibility). History seeding at lines 281-304.
- `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx`: ClientsItem already guarded by `!!presenceInfo && presenceInfo.clientCount > 1` — no changes needed.
- `apps/client/src/layers/shared/lib/constants.ts`: `QUERY_TIMING.ACTIVE_TAB_REFETCH_MS = 3000`, `BACKGROUND_TAB_REFETCH_MS = 10_000`, `MESSAGE_STALE_TIME_MS = 0`.
- `apps/client/src/layers/shared/model/__tests__/app-store.test.ts`: Tests use `vi.resetModules()` + dynamic import, then `useAppStore.getState()` for direct state access. Tests persistence via `localStorage.getItem()`.
- `apps/client/src/layers/features/chat/__tests__/use-chat-session.test.tsx`: MockEventSource class at lines 24-55. EventSource subscription tests at lines 712-791 verify creation/closure/streaming-pause behavior.

## 3) Codebase Map

**Primary components/modules:**

| File                                                             | Role                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/client/src/layers/shared/model/app-store.ts`               | Zustand store — add 2 boolean toggles                               |
| `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`    | Advanced settings tab — add 2 SettingRow toggles                    |
| `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` | Settings shell — destructure 2 new store props, pass to AdvancedTab |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts` | Core chat hook — guard SSE effect and polling interval              |

**Shared dependencies:**

- `useAppStore` (Zustand) — consumed by SettingsDialog and use-chat-session
- `Switch` (shadcn/ui) — toggle control in AdvancedTab
- `SettingRow` — layout wrapper in SettingsDialog (may need to extract or import in AdvancedTab)
- `QUERY_TIMING` — already imported in use-chat-session, no change needed

**Data flow:**

```
Settings toggle → Zustand store + localStorage
    → use-chat-session reads store value
    → SSE useEffect dependency array triggers cleanup/recreation
    → refetchInterval callback checks store value, returns false when disabled
```

**Feature flags/config:** None — these are client-side UI settings persisted in localStorage.

**Potential blast radius:**

- Direct: 4 files (app-store, AdvancedTab, SettingsDialog, use-chat-session)
- Tests: 2 files (app-store.test.ts, use-chat-session.test.tsx)
- Indirect: 0 files — ChatStatusSection already guards on `presenceInfo` existence

## 4) Root Cause Analysis

N/A — this is a feature addition, not a bug fix. The feature exists to help debug separate chat UI issues.

## 5) Research

**Persistent SSE toggle (EventSource conditional):**

The standard React pattern for conditionally creating an EventSource is an early return in useEffect with the toggle in the dependency array:

```typescript
useEffect(() => {
  if (!sessionId || isStreaming || disableCrossClientSync) return;
  const eventSource = new EventSource(url);
  // ... listeners ...
  return () => eventSource.close();
}, [sessionId, isStreaming, disableCrossClientSync, ...]);
```

When `disableCrossClientSync` changes from false to true, React runs the cleanup (closing the EventSource), then runs the effect again (hitting the early return). When toggled back, the connection is re-established. No stale closure risk since the toggle is in the dependency array.

**Message polling toggle (TanStack Query refetchInterval):**

TanStack Query v5 accepts `refetchInterval: number | false | ((query) => number | false)`. The existing code already uses a function callback. Adding the toggle is a one-line check:

```typescript
refetchInterval: () => {
  if (isStreaming || disableMessagePolling) return false;
  return isTabVisible ? ACTIVE_TAB_REFETCH_MS : BACKGROUND_TAB_REFETCH_MS;
},
```

Returning `false` disables periodic refetching. The initial query still fires (controlled by `enabled`, not `refetchInterval`), so history loads once on mount.

**Side effects of disabling each path:**

| Disabled Path     | What Stops                                                       | What Still Works                                               |
| ----------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| Cross-client sync | Presence UI, cross-client query invalidation, sync_update events | Live SSE, polling (if enabled), initial history load           |
| Message polling   | Periodic 3s/10s refetches of message history                     | Live SSE, cross-client sync (if enabled), initial history load |
| Both              | All background data paths                                        | Live SSE only — messages arrive exclusively from POST stream   |

**Edge case:** After streaming completes, `historySeededRef` is reset (line 477), which triggers a full history replace on the next poll. With polling disabled, this replace won't happen until the user navigates away and back (triggering a fresh mount). This is acceptable for debugging — the streaming data is already displayed.

## 6) Decisions

| #   | Decision         | Choice                                  | Rationale                                                                                                                                       |
| --- | ---------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Toggle placement | Advanced tab, above Danger Zone         | Tab already exists for power-user settings. No new navigation weight. Debug toggles aren't destructive, so they sit above the danger zone.      |
| 2   | Toggle naming    | "Cross-client sync" / "Message polling" | User-facing names that describe what the feature does, not the implementation detail. Descriptions can mention SSE/polling for technical users. |
