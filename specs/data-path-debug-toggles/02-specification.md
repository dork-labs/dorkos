---
slug: data-path-debug-toggles
number: 146
created: 2026-03-17
status: specified
---

# Data Path Debug Toggles

## Overview

Add two Settings toggles to independently disable the Persistent SSE connection (cross-client sync) and Message Polling (periodic history refetch) in the chat client. These toggles enable isolating data path issues when debugging "strange behavior" in the chat UI.

The DorkOS chat client receives data via three paths:

1. **Live SSE** — Streaming response on POST `/api/sessions/:id/messages` (core interaction loop, NOT toggleable)
2. **Persistent SSE** — EventSource on GET `/api/sessions/:id/stream` providing cross-client sync and presence updates
3. **Message Polling** — TanStack Query `refetchInterval` that periodically re-fetches message history (3s active tab, 10s background)

This spec covers toggles for paths 2 and 3 only.

## Technical Design

### Store Layer (`app-store.ts`)

Add two new persisted boolean settings using the existing `BOOL_KEYS`/`BOOL_DEFAULTS` pattern:

**AppState interface additions (after line 127):**

```typescript
enableCrossClientSync: boolean;
setEnableCrossClientSync: (v: boolean) => void;
enableMessagePolling: boolean;
setEnableMessagePolling: (v: boolean) => void;
```

**BOOL_KEYS additions (after line 172, `showStatusBarTunnel`):**

```typescript
enableCrossClientSync: 'dorkos-enable-cross-client-sync',
enableMessagePolling: 'dorkos-enable-message-polling',
```

**BOOL_DEFAULTS additions (after line 193, `showStatusBarTunnel`):**

```typescript
enableCrossClientSync: true,
enableMessagePolling: true,
```

**Store implementation (after line 371, `setShowStatusBarTunnel`):**

```typescript
enableCrossClientSync: readBool(BOOL_KEYS.enableCrossClientSync, BOOL_DEFAULTS.enableCrossClientSync),
setEnableCrossClientSync: (v) => {
  writeBool(BOOL_KEYS.enableCrossClientSync, v);
  set({ enableCrossClientSync: v });
},
enableMessagePolling: readBool(BOOL_KEYS.enableMessagePolling, BOOL_DEFAULTS.enableMessagePolling),
setEnableMessagePolling: (v) => {
  writeBool(BOOL_KEYS.enableMessagePolling, v);
  set({ enableMessagePolling: v });
},
```

`resetPreferences()` already uses `...BOOL_DEFAULTS` spread (line 439), so the new keys are automatically included.

### Chat Hook (`use-chat-session.ts`)

**Read toggles from store (after line 115, `selectedCwd`):**

```typescript
const enableCrossClientSync = useAppStore((s) => s.enableCrossClientSync);
const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
```

**Guard Persistent SSE effect (line 308-310, add one condition):**

```typescript
// Before:
if (!sessionId) return;
if (isStreaming) return;

// After:
if (!sessionId) return;
if (isStreaming) return;
if (!enableCrossClientSync) return;
```

Add `enableCrossClientSync` to the effect's dependency array (line 343):

```typescript
}, [sessionId, isStreaming, queryClient, transport.clientId, enableCrossClientSync]);
```

When `enableCrossClientSync` changes from `true` to `false`, React runs the cleanup (closes EventSource), then re-runs the effect (hits early return). When toggled back to `true`, the connection is re-established. No stale closure risk.

**Guard Message Polling (line 256-261, add one condition):**

```typescript
// Before:
refetchInterval: () => {
  if (isStreaming) return false;
  return isTabVisible
    ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
    : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},

// After:
refetchInterval: () => {
  if (isStreaming) return false;
  if (!enableMessagePolling) return false;
  return isTabVisible
    ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
    : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},
```

The `refetchInterval` function captures `enableMessagePolling` from the render closure and is re-evaluated by TanStack Query on each interval tick, so toggling takes effect immediately.

### Settings UI (`AdvancedTab.tsx`)

Add a "Diagnostics" section above the Danger Zone with two toggle rows:

```tsx
import { useAppStore } from '@/layers/shared/model';
import { Switch, Label, Separator } from '@/layers/shared/ui';

// Inside the component, before the danger zone div:
const enableCrossClientSync = useAppStore((s) => s.enableCrossClientSync);
const setEnableCrossClientSync = useAppStore((s) => s.setEnableCrossClientSync);
const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
const setEnableMessagePolling = useAppStore((s) => s.setEnableMessagePolling);

// JSX — new section before the border-destructive div:
<div className="space-y-4 rounded-lg border p-4">
  <h3 className="text-sm font-semibold">Diagnostics</h3>
  <p className="text-muted-foreground text-xs">
    Toggle data synchronization paths for debugging. Disabling these reduces background network
    activity but may cause stale data.
  </p>

  <div className="flex items-center justify-between gap-4">
    <div className="min-w-0">
      <Label className="text-sm font-medium">Cross-client sync</Label>
      <p className="text-muted-foreground text-xs">
        Real-time updates from other clients and presence indicators
      </p>
    </div>
    <Switch checked={enableCrossClientSync} onCheckedChange={setEnableCrossClientSync} />
  </div>

  <Separator />

  <div className="flex items-center justify-between gap-4">
    <div className="min-w-0">
      <Label className="text-sm font-medium">Message polling</Label>
      <p className="text-muted-foreground text-xs">
        Periodic refresh of message history (3s active, 10s background)
      </p>
    </div>
    <Switch checked={enableMessagePolling} onCheckedChange={setEnableMessagePolling} />
  </div>
</div>;
```

No changes needed to `SettingsDialog.tsx` since `AdvancedTab` reads directly from `useAppStore`.

### Side Effects When Disabled

| Toggle Off        | What Stops                                                                       | What Still Works                                               |
| ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Cross-client sync | Presence UI (ClientsItem), cross-client query invalidation, `sync_update` events | Live SSE, polling (if enabled), initial history load           |
| Message polling   | Periodic 3s/10s refetches                                                        | Live SSE, cross-client sync (if enabled), initial history load |
| Both              | All background data paths                                                        | Live SSE only — cleanest state for isolating streaming bugs    |

**Interaction between toggles:** When cross-client sync is on but polling is off, `sync_update` events still trigger `queryClient.invalidateQueries()`, which causes a one-time refetch. With both off, messages arrive exclusively from the POST streaming response.

**ChatStatusSection:** No changes needed. The `ClientsItem` is already guarded by `!!presenceInfo && presenceInfo.clientCount > 1`. When cross-client sync is disabled, `presenceInfo` stays null, so the presence badge naturally disappears.

## Implementation Phases

### Phase 1: Store & Hook (core logic)

1. Add `enableCrossClientSync` and `enableMessagePolling` to `BOOL_KEYS`, `BOOL_DEFAULTS`, `AppState` interface, and store implementation in `app-store.ts`
2. Add early return guard in the Persistent SSE `useEffect` in `use-chat-session.ts`
3. Add early return in the `refetchInterval` callback in `use-chat-session.ts`

### Phase 2: Settings UI

4. Add Diagnostics section with two Switch toggles to `AdvancedTab.tsx`

### Phase 3: Tests

5. Add store persistence tests to `app-store.test.ts`
6. Add conditional SSE/polling tests to `use-chat-session.test.tsx`

## Testing Requirements

### Store Tests (`app-store.test.ts`)

```typescript
it('defaults enableCrossClientSync to true', async () => {
  const { useAppStore } = await import('../app-store');
  expect(useAppStore.getState().enableCrossClientSync).toBe(true);
});

it('persists enableCrossClientSync to localStorage', async () => {
  const { useAppStore } = await import('../app-store');
  useAppStore.getState().setEnableCrossClientSync(false);
  expect(localStorage.getItem('dorkos-enable-cross-client-sync')).toBe('false');
});

it('resets enableCrossClientSync to true on resetPreferences', async () => {
  const { useAppStore } = await import('../app-store');
  useAppStore.getState().setEnableCrossClientSync(false);
  useAppStore.getState().resetPreferences();
  expect(useAppStore.getState().enableCrossClientSync).toBe(true);
});

// Same pattern for enableMessagePolling
```

### Hook Tests (`use-chat-session.test.tsx`)

```typescript
it('does not create EventSource when enableCrossClientSync is false', async () => {
  // Set store value before rendering hook
  useAppStore.getState().setEnableCrossClientSync(false);
  const { result } = renderHook(() => useChatSession('session-1'), { wrapper: Wrapper });
  await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
  // Verify no EventSource was constructed
  expect(MockEventSource.instances).toHaveLength(0);
});

it('creates EventSource when enableCrossClientSync is true (default)', async () => {
  const { result } = renderHook(() => useChatSession('session-1'), { wrapper: Wrapper });
  await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
  expect(MockEventSource.instances.length).toBeGreaterThan(0);
});
```

## Acceptance Criteria

- [ ] Two new boolean settings (`enableCrossClientSync`, `enableMessagePolling`) in the Zustand store, persisted to localStorage, defaulting to `true`
- [ ] Settings > Advanced tab shows a "Diagnostics" section with two labeled Switch toggles
- [ ] When cross-client sync is disabled: no EventSource connection is created, presence badge disappears, no `sync_update` invalidation
- [ ] When message polling is disabled: `refetchInterval` returns `false`, history loads once on mount but does not periodically refetch
- [ ] Toggles take effect immediately without page reload
- [ ] `resetPreferences()` restores both toggles to `true`
- [ ] All existing tests continue to pass
- [ ] New store and hook tests cover the toggle behavior

## Files Modified

| File                                                                       | Change                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/client/src/layers/shared/model/app-store.ts`                         | Add 2 boolean toggles to interface, BOOL_KEYS, BOOL_DEFAULTS, store impl |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`           | Guard SSE effect and polling interval with store values                  |
| `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`              | Add Diagnostics section with 2 Switch toggles                            |
| `apps/client/src/layers/shared/model/__tests__/app-store.test.ts`          | Add persistence and reset tests                                          |
| `apps/client/src/layers/features/chat/__tests__/use-chat-session.test.tsx` | Add conditional SSE/polling tests                                        |
