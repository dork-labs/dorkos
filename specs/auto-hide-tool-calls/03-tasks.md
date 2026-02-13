---
slug: auto-hide-tool-calls
---

# Tasks: Auto-Hide Tool Calls

**Spec**: [02-specification.md](./02-specification.md)
**Generated**: 2026-02-12

---

## Task 1.1: Add `autoHideToolCalls` to Zustand Store

**Phase**: 1 — Store & Settings
**File**: `apps/client/src/stores/app-store.ts`
**Dependencies**: None
**Status**: Pending

### Description

Add the `autoHideToolCalls` boolean preference to the Zustand app store with localStorage persistence and a default value of `true` (unique among preferences — all others default to `false`).

### Implementation Details

#### 1. Add to `AppState` interface (after `setExpandToolCalls` line ~34)

```typescript
autoHideToolCalls: boolean;
setAutoHideToolCalls: (v: boolean) => void;
```

#### 2. Add state initializer and setter (after the `setExpandToolCalls` block, around line 94)

```typescript
autoHideToolCalls: (() => {
  try {
    const stored = localStorage.getItem('gateway-auto-hide-tool-calls');
    // Absence of key → true (default ON, unlike other prefs)
    return stored === null ? true : stored === 'true';
  }
  catch { return true; }
})(),
setAutoHideToolCalls: (v) => {
  try { localStorage.setItem('gateway-auto-hide-tool-calls', String(v)); } catch {}
  set({ autoHideToolCalls: v });
},
```

#### 3. Update `resetPreferences()` (around line 123-138)

Add to the try block:
```typescript
localStorage.removeItem('gateway-auto-hide-tool-calls');
```

Add to the `set()` call:
```typescript
autoHideToolCalls: true,
```

### Acceptance Criteria

- `useAppStore.getState().autoHideToolCalls` returns `true` by default (no localStorage key)
- `setAutoHideToolCalls(false)` persists `'false'` to `localStorage` key `gateway-auto-hide-tool-calls`
- `setAutoHideToolCalls(true)` persists `'true'` to `localStorage` key `gateway-auto-hide-tool-calls`
- `resetPreferences()` removes the localStorage key and resets state to `true`
- Follows the exact same pattern as `expandToolCalls` / `showTimestamps` but with `true` default

---

## Task 1.2: Add "Auto-hide tool calls" Toggle to SettingsDialog

**Phase**: 1 — Store & Settings
**File**: `apps/client/src/components/settings/SettingsDialog.tsx`
**Dependencies**: Task 1.1
**Status**: Pending

### Description

Add a new toggle row for the "Auto-hide tool calls" setting in the Settings dialog, positioned after the existing "Expand tool calls" row.

### Implementation Details

#### 1. Destructure new state from `useAppStore()` (line ~33)

Update the destructuring to include:
```typescript
const {
  showTimestamps, setShowTimestamps,
  expandToolCalls, setExpandToolCalls,
  autoHideToolCalls, setAutoHideToolCalls,  // ADD THIS LINE
  devtoolsOpen, toggleDevtools,
  verboseLogging, setVerboseLogging,
  fontSize, setFontSize,
  resetPreferences,
} = useAppStore();
```

#### 2. Add toggle row after "Expand tool calls" (after line ~101)

Insert this JSX block immediately after the "Expand tool calls" `<SettingRow>`:

```tsx
<SettingRow label="Auto-hide tool calls" description="Fade out completed tool calls after a few seconds">
  <Switch checked={autoHideToolCalls} onCheckedChange={setAutoHideToolCalls} />
</SettingRow>
```

### Acceptance Criteria

- "Auto-hide tool calls" toggle appears in Settings dialog under Preferences
- It is positioned after "Expand tool calls" and before "Show dev tools"
- Toggle reflects the current `autoHideToolCalls` state from the store
- Toggling it calls `setAutoHideToolCalls` with the new value
- Description reads "Fade out completed tool calls after a few seconds"

---

## Task 2.1: Implement `useToolCallVisibility` Hook and `AutoHideToolCall` Wrapper

**Phase**: 2 — Core Feature
**File**: `apps/client/src/components/chat/MessageItem.tsx`
**Dependencies**: Task 1.1
**Status**: Pending

### Description

Implement the core auto-hide feature: a `useToolCallVisibility` hook that manages per-tool-call visibility with a 5-second delay after completion, and an `AutoHideToolCall` wrapper component that uses `AnimatePresence` for smooth exit animations. Modify `MessageItem` to use the wrapper for non-interactive tool calls.

### Implementation Details

#### 1. Add imports at the top of MessageItem.tsx

Add `AnimatePresence` to the existing motion import, and add `useState`, `useEffect`, `useRef` from React:

```typescript
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
```

(The `motion` import already exists on line 1, just add `AnimatePresence` to it. Add the React hooks import.)

#### 2. Add `useToolCallVisibility` hook (before the `MessageItem` component)

```typescript
function useToolCallVisibility(
  status: string,
  autoHide: boolean,
): boolean {
  // Track initial status on mount — if already 'complete', it's from history
  const initialStatusRef = useRef(status);
  const [visible, setVisible] = useState(
    // Hide immediately if: auto-hide ON + already complete on mount (history)
    !(autoHide && initialStatusRef.current === 'complete')
  );

  useEffect(() => {
    // Only trigger timer when status transitions TO 'complete' during session
    // (not when it was already complete on mount)
    if (
      autoHide &&
      status === 'complete' &&
      initialStatusRef.current !== 'complete'
    ) {
      const timer = setTimeout(() => setVisible(false), 5_000);
      return () => clearTimeout(timer);
    }
  }, [status, autoHide]);

  // If auto-hide is OFF, always visible
  if (!autoHide) return true;

  return visible;
}
```

#### 3. Add `AutoHideToolCall` wrapper component (after the hook, before `MessageItem`)

```typescript
function AutoHideToolCall({
  part,
  autoHide,
  expandToolCalls,
}: {
  part: { toolCallId: string; toolName: string; input?: string; result?: string; status: string };
  autoHide: boolean;
  expandToolCalls: boolean;
}) {
  const visible = useToolCallVisibility(part.status, autoHide);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={part.toolCallId}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          <ToolCallCard
            toolCall={{
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input || '',
              result: part.result,
              status: part.status,
            }}
            defaultExpanded={expandToolCalls}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

#### 4. Update `MessageItem` to use the wrapper

In the `MessageItem` component:

a) Update the destructuring from `useAppStore()` (line 29) to include `autoHideToolCalls`:

```typescript
const { showTimestamps, expandToolCalls, autoHideToolCalls } = useAppStore();
```

b) Replace the non-interactive tool call rendering block (lines 120-132). The current code:

```tsx
return (
  <ToolCallCard
    key={part.toolCallId}
    toolCall={{
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input || '',
      result: part.result,
      status: part.status,
    }}
    defaultExpanded={expandToolCalls}
  />
);
```

Replace with:

```tsx
return (
  <AutoHideToolCall
    key={part.toolCallId}
    part={part}
    autoHide={autoHideToolCalls}
    expandToolCalls={expandToolCalls}
  />
);
```

### Key Behaviors

- **History tool calls** (status is `'complete'` on mount): `visible` starts as `false`, never rendered, no animation
- **Live tool calls** (status transitions to `'complete'`): `visible` starts as `true`, timer fires after 5s, exit animation plays (300ms)
- **Error status**: never triggers the timer (only `'complete'` does), always visible
- **Setting OFF**: `useToolCallVisibility` short-circuits to `true`, all tool calls shown
- **Interactive tools** (`ToolApproval`, `QuestionPrompt`): unaffected, they use separate render branches above this code
- **Reduced motion**: existing `<MotionConfig reducedMotion="user">` in `App.tsx` handles instant removal

### Acceptance Criteria

- Non-interactive tool calls that are already complete on mount are not rendered when autoHide is ON
- Non-interactive tool calls that complete during streaming fade out after 5 seconds
- Error-status tool calls never auto-hide
- Interactive tools (ToolApproval, QuestionPrompt) are never affected by auto-hide
- When autoHide is OFF, all tool calls are visible including history ones
- Exit animation uses `height: 0, opacity: 0` with 300ms duration and ease `[0.4, 0, 0.2, 1]`
- `overflow-hidden` prevents content bleeding during collapse animation

---

## Task 3.1: Add Tests for Store Setting and MessageItem Auto-Hide Behavior

**Phase**: 3 — Tests
**File**: `apps/client/src/stores/__tests__/app-store.test.ts` and `apps/client/src/components/chat/__tests__/MessageItem.test.tsx`
**Dependencies**: Task 1.1, Task 2.1
**Status**: Pending

### Description

Add unit tests for:
1. The `autoHideToolCalls` store property (default, persistence, reset)
2. The auto-hide behavior in MessageItem (history hiding, live fade-out, error preservation, setting toggle, interactive tools)

### Implementation Details

#### 1. Store tests — `apps/client/src/stores/__tests__/app-store.test.ts`

Add these three tests at the end of the existing `describe('AppStore', ...)` block:

```typescript
it('defaults autoHideToolCalls to true', async () => {
  const { useAppStore } = await import('../../stores/app-store');
  expect(useAppStore.getState().autoHideToolCalls).toBe(true);
});

it('persists autoHideToolCalls to localStorage', async () => {
  const { useAppStore } = await import('../../stores/app-store');
  useAppStore.getState().setAutoHideToolCalls(false);
  expect(localStorage.getItem('gateway-auto-hide-tool-calls')).toBe('false');
});

it('resets autoHideToolCalls to true on resetPreferences', async () => {
  const { useAppStore } = await import('../../stores/app-store');
  useAppStore.getState().setAutoHideToolCalls(false);
  expect(useAppStore.getState().autoHideToolCalls).toBe(false);
  useAppStore.getState().resetPreferences();
  expect(useAppStore.getState().autoHideToolCalls).toBe(true);
});
```

#### 2. MessageItem tests — `apps/client/src/components/chat/__tests__/MessageItem.test.tsx`

Add `vi.useFakeTimers()` and `vi.useRealTimers()` setup, and mock the app-store for controlling `autoHideToolCalls`. Add a new `describe('auto-hide tool calls', ...)` block at the end of the file.

First, add `beforeEach`/`afterEach` for fake timers and update imports to include `act`:

```typescript
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
```

Then add the auto-hide test block:

```typescript
describe('auto-hide tool calls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  const makeToolCallMsg = (status: string) => ({
    id: '1',
    role: 'assistant' as const,
    content: 'Working on it.',
    parts: [
      { type: 'text' as const, text: 'Working on it.' },
      {
        type: 'tool_call' as const,
        toolCallId: 'tc-1',
        toolName: 'Read',
        input: '{}',
        status,
      },
    ],
    timestamp: new Date().toISOString(),
  });

  it('hides tool calls that are already complete on mount when autoHide is ON', () => {
    // Mock the store to return autoHideToolCalls: true
    vi.spyOn(require('../../stores/app-store'), 'useAppStore').mockImplementation((selector?: (s: any) => any) => {
      const state = { showTimestamps: false, expandToolCalls: false, autoHideToolCalls: true };
      return selector ? selector(state) : state;
    });

    const msg = makeToolCallMsg('complete');
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.queryByText('Read ...')).toBeNull();
  });

  it('shows tool calls during streaming, hides 5s after completion', () => {
    vi.spyOn(require('../../stores/app-store'), 'useAppStore').mockImplementation((selector?: (s: any) => any) => {
      const state = { showTimestamps: false, expandToolCalls: false, autoHideToolCalls: true };
      return selector ? selector(state) : state;
    });

    const msg = makeToolCallMsg('running');
    const { rerender } = render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.getByText('Read ...')).toBeDefined();

    // Transition to complete
    const completedMsg = makeToolCallMsg('complete');
    rerender(<MessageItem message={completedMsg} sessionId="test-session" grouping={onlyGrouping} />);

    // Still visible (timer running)
    expect(screen.getByText('Read ...')).toBeDefined();

    // Advance past 5s timer
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Now hidden
    expect(screen.queryByText('Read ...')).toBeNull();
  });

  it('never hides tool calls with error status', () => {
    vi.spyOn(require('../../stores/app-store'), 'useAppStore').mockImplementation((selector?: (s: any) => any) => {
      const state = { showTimestamps: false, expandToolCalls: false, autoHideToolCalls: true };
      return selector ? selector(state) : state;
    });

    const msg = makeToolCallMsg('error');
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(screen.getByText('Read ...')).toBeDefined();
  });

  it('shows all tool calls when autoHide is OFF', () => {
    vi.spyOn(require('../../stores/app-store'), 'useAppStore').mockImplementation((selector?: (s: any) => any) => {
      const state = { showTimestamps: false, expandToolCalls: false, autoHideToolCalls: false };
      return selector ? selector(state) : state;
    });

    const msg = makeToolCallMsg('complete');
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.getByText('Read ...')).toBeDefined();
  });

  it('never hides ToolApproval regardless of autoHide setting', () => {
    vi.spyOn(require('../../stores/app-store'), 'useAppStore').mockImplementation((selector?: (s: any) => any) => {
      const state = { showTimestamps: false, expandToolCalls: false, autoHideToolCalls: true };
      return selector ? selector(state) : state;
    });

    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: '',
      parts: [
        {
          type: 'tool_call' as const,
          toolCallId: 'tc-1',
          toolName: 'Write',
          input: '{}',
          status: 'complete',
          interactiveType: 'approval' as const,
        },
      ],
      timestamp: new Date().toISOString(),
    };
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.getByTestId('tool-approval')).toBeDefined();
  });
});
```

**Note on mocking approach:** The tests above show the conceptual approach. The actual mock implementation may need adjustment based on how `useAppStore` is consumed in the component (it uses property access `useAppStore()` returning an object). The existing tests do not mock the store (they rely on defaults), so the implementer should verify the mock pattern works with the actual Zustand store usage and adjust if needed. An alternative approach is to directly set store state via `useAppStore.setState({ autoHideToolCalls: true })` before each test.

### Acceptance Criteria

- Store tests pass: default is `true`, persistence works, reset restores to `true`
- MessageItem tests pass: history tool calls hidden, live tool calls fade after 5s, errors never hide, setting OFF shows all, interactive tools unaffected
- All existing tests continue to pass (no regressions)
- Tests use `vi.useFakeTimers()` for timer control and `vi.useRealTimers()` in cleanup

---

## Dependency Graph

```
Task 1.1 (Store)
  ├── Task 1.2 (Settings UI) — blocked by 1.1
  ├── Task 2.1 (Core Feature) — blocked by 1.1
  └── Task 3.1 (Tests) — blocked by 1.1, 2.1
```

## Parallel Execution Opportunities

- Tasks 1.2 and 2.1 can run in parallel (both only depend on 1.1)
