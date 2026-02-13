---
slug: auto-hide-tool-calls
---

# Specification: Auto-Hide Tool Calls

**Status:** Approved
**Author:** Claude Code
**Date:** 2026-02-12
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## 1. Overview

Add an "Auto-hide tool calls" preference that fades out completed non-interactive tool calls from the chat after a 5-second delay. The exit animation uses motion's `AnimatePresence` with height collapse + opacity fade for a smooth, jump-free experience. Tool calls from session history that are already complete are simply not rendered. The setting defaults to ON — the first preference in the app to default to true.

## 2. Background / Problem Statement

During Claude Code sessions, tool calls (Read, Edit, Grep, Bash, etc.) accumulate rapidly in the chat. A typical session may invoke dozens of tools, and their cards dominate the message history, making it hard to scan for the actual conversation content. While the existing "Expand tool calls" toggle helps by collapsing tool details, the collapsed headers still create visual clutter.

Users want a cleaner chat experience where tool calls are visible while they execute (so users can track progress) but disappear once complete, leaving only the text content behind.

## 3. Goals

- Reduce visual clutter from completed tool calls in the chat
- Provide a smooth, polished exit animation (no layout jumps or flashing)
- Default to auto-hide ON for a clean out-of-box experience
- Allow users to disable the feature to see all tool calls
- Preserve error-state tool calls for debugging visibility
- Leave interactive tools (ToolApproval, QuestionPrompt) untouched

## 4. Non-Goals

- Configurable delay duration (fixed at 5s; can iterate later)
- Per-message "show hidden tool calls" button (future work)
- Server-side filtering of tool calls from transcripts
- Changes to JSONL transcript storage
- Changes to ToolApproval or QuestionPrompt components
- Reverse animation when toggling the setting mid-fade

## 5. Technical Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `motion` | ^12.33.0 | `AnimatePresence` for exit animations, `motion.div` for animated wrappers |
| `zustand` | (existing) | Store for `autoHideToolCalls` preference with localStorage persistence |
| `@tanstack/react-query` | (existing) | Not directly affected — tool call state is in `useChatSession` hook |

No new dependencies required. All animation capabilities are already available via the existing `motion` package.

## 6. Detailed Design

### 6.1 State: `autoHideToolCalls` in Zustand Store

**File:** `apps/client/src/stores/app-store.ts`

Add to `AppState` interface:

```typescript
autoHideToolCalls: boolean;
setAutoHideToolCalls: (v: boolean) => void;
```

Implementation follows the existing `expandToolCalls` pattern but with a **true default**:

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

Update `resetPreferences()` to include:
- `localStorage.removeItem('gateway-auto-hide-tool-calls')` in the try block
- `autoHideToolCalls: true` in the `set()` call (reset to default ON)

### 6.2 Settings UI Toggle

**File:** `apps/client/src/components/settings/SettingsDialog.tsx`

Add after the "Expand tool calls" row:

```tsx
<SettingRow label="Auto-hide tool calls" description="Fade out completed tool calls after a few seconds">
  <Switch checked={autoHideToolCalls} onCheckedChange={setAutoHideToolCalls} />
</SettingRow>
```

Destructure `autoHideToolCalls` and `setAutoHideToolCalls` from `useAppStore()`.

### 6.3 Auto-Hide Hook

**File:** `apps/client/src/components/chat/MessageItem.tsx` (defined inline, not a separate file)

A small hook encapsulates the visibility + timer logic for each tool call part:

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

**Key behaviors:**
- `initialStatusRef` captures status on mount. If it's `'complete'`, this tool call came from history.
- History tool calls: `visible` starts as `false` → never rendered, no animation.
- Live tool calls: `visible` starts as `true`, transitions to `false` after 5s post-completion.
- Error status: never triggers the timer (only `'complete'` does).
- Setting OFF: short-circuits to `true` — all tool calls shown.

### 6.4 AnimatePresence Wrapper in MessageItem

**File:** `apps/client/src/components/chat/MessageItem.tsx`

The tool call rendering section (currently lines 120-133) wraps each non-interactive ToolCallCard:

```tsx
// Import at top of file
import { AnimatePresence } from 'motion/react';

// Inside the parts.map() for non-interactive tool calls:
(() => {
  const visible = useToolCallVisibility(part.status, autoHideToolCalls);
  return (
    <AnimatePresence key={part.toolCallId}>
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
})()
```

**Important:** Hooks can't be called inside `map()` directly. The tool call rendering for non-interactive parts must be extracted to a small wrapper component:

```tsx
function AutoHideToolCall({
  part,
  autoHide,
  expandToolCalls,
}: {
  part: /* tool call part type */;
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

Then in `MessageItem`'s `parts.map()`, the non-interactive tool call branch becomes:

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

### 6.5 Animation Details

| Property | Value | Rationale |
|----------|-------|-----------|
| Exit height | `0` | Collapses the card's space smoothly |
| Exit opacity | `0` | Fades out simultaneously with collapse |
| Duration | `0.3s` | Matches existing ToolCallCard expand/collapse |
| Easing | `[0.4, 0, 0.2, 1]` | Matches existing ease curve in codebase |
| `overflow` | `hidden` | Prevents content from bleeding during collapse |
| `initial` | none (not set) | Tool calls appear instantly as today |
| `layout` | not used | Would conflict with TanStack Virtual positioning |

**Reduced motion:** The existing `<MotionConfig reducedMotion="user">` wrapper in `App.tsx` causes motion to skip animations when `prefers-reduced-motion` is active. Tool calls will simply disappear instantly (duration: 0).

### 6.6 Data Flow

```
User toggles setting
  → setAutoHideToolCalls(value)
  → localStorage persisted
  → Zustand store updates
  → MessageItem re-renders (reads autoHideToolCalls)
  → AutoHideToolCall components re-evaluate visibility

SSE stream delivers tool_call_end event
  → useChatSession updates part.status to 'complete'
  → MessageItem re-renders
  → useToolCallVisibility detects status transition
  → 5s setTimeout starts
  → Timer fires → setVisible(false)
  → AnimatePresence plays exit animation (300ms)
  → motion.div unmounts after animation
  → MessageItem height decreases smoothly
```

## 7. User Experience

### Discovery
- "Auto-hide tool calls" toggle in Settings dialog, under Preferences section
- Positioned after "Expand tool calls" (related settings grouped together)
- Default: ON

### During Streaming
1. Tool call appears (pending → running) — visible with spinner icon
2. Tool call completes (running → complete) — green checkmark appears
3. After 5 seconds — card smoothly fades out and collapses (300ms animation)
4. Space reclaimed — subsequent content shifts up smoothly

### Viewing History
- When opening a session with auto-hide ON: completed tool calls are not shown
- Only text content and any pending/running/error tool calls are visible
- Interactive tools (approval prompts, questions) always visible regardless of setting

### Toggling the Setting
- Turning OFF: All tool calls immediately become visible (no animation needed)
- Turning ON: Already-visible tool calls remain until the page re-renders or session reloads; currently-fading tool calls complete their exit

## 8. Testing Strategy

### Unit Tests: `useToolCallVisibility` Hook

**File:** `apps/client/src/components/chat/__tests__/MessageItem.test.tsx`

Tests use `vi.useFakeTimers()` to control setTimeout behavior.

```typescript
// Purpose: Verify that completed tool calls from history are not rendered
it('hides tool calls that are already complete on mount when autoHide is ON', () => {
  // Render MessageItem with a message containing a complete tool call
  // Assert: ToolCallCard is NOT in the document
});

// Purpose: Verify that live tool calls fade out after 5s
it('shows tool calls during streaming, hides 5s after completion', async () => {
  // Render with status='running', autoHide=true
  // Assert: ToolCallCard IS visible
  // Update status to 'complete'
  // Assert: ToolCallCard still visible (timer running)
  // Advance timers by 5000ms
  // Assert: ToolCallCard is NOT in the document
});

// Purpose: Verify that error tool calls never auto-hide
it('never hides tool calls with error status', async () => {
  // Render with status='error', autoHide=true
  // Advance timers by 10000ms
  // Assert: ToolCallCard IS still visible
});

// Purpose: Verify that disabling auto-hide shows all tool calls
it('shows all tool calls when autoHide is OFF', () => {
  // Render with status='complete', autoHide=false
  // Assert: ToolCallCard IS visible (even from history)
});

// Purpose: Verify interactive tools are never hidden
it('never hides ToolApproval or QuestionPrompt regardless of setting', () => {
  // Render message with interactive parts
  // Assert: ToolApproval/QuestionPrompt always visible
});
```

### Unit Tests: Store

**File:** `apps/client/src/stores/__tests__/app-store.test.ts`

```typescript
// Purpose: Verify default value is true (unique among preferences)
it('defaults autoHideToolCalls to true', () => {
  expect(useAppStore.getState().autoHideToolCalls).toBe(true);
});

// Purpose: Verify localStorage persistence
it('persists autoHideToolCalls to localStorage', () => {
  useAppStore.getState().setAutoHideToolCalls(false);
  expect(localStorage.getItem('gateway-auto-hide-tool-calls')).toBe('false');
});

// Purpose: Verify resetPreferences resets to true (not false like others)
it('resets autoHideToolCalls to true on resetPreferences', () => {
  useAppStore.getState().setAutoHideToolCalls(false);
  useAppStore.getState().resetPreferences();
  expect(useAppStore.getState().autoHideToolCalls).toBe(true);
});
```

### Mocking Strategy

Existing test mocks already handle motion:

```typescript
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }) => <>{children}</>,
}));
```

This means exit animations are invisible in tests — elements are immediately present or absent. Timer-based tests use `vi.useFakeTimers()` + `vi.advanceTimersByTime(5000)`.

## 9. Performance Considerations

| Concern | Assessment | Mitigation |
|---------|-----------|------------|
| setTimeout per tool call | Negligible — each tool call creates one timer | Timers are cleaned up on unmount via useEffect return |
| AnimatePresence overhead | Minimal — wraps individual tool calls, not the whole list | Only active when `visible` transitions; no-op when already hidden |
| Re-renders from `setVisible` | One re-render per tool call when timer fires | Isolated to the `AutoHideToolCall` component, doesn't propagate to MessageList |
| TanStack Virtual interaction | No conflict — animation happens inside message items | Virtual scroller measures items after animation completes; height change is smooth |
| Memory from hidden tool calls | Tool call data remains in state, only rendering is suppressed | Same as today — message data is not garbage collected until session changes |

## 10. Security Considerations

No security impact. This is a purely client-side rendering preference that controls visibility of tool call UI components. No data is deleted, transmitted, or filtered — tool call data remains in the message state and JSONL transcripts regardless of the setting.

## 11. Documentation

- No new developer guide needed
- Update `guides/interactive-tools.md` with a note about the auto-hide behavior for non-interactive tool calls
- The setting is self-documenting via its label and description in the Settings dialog

## 12. Implementation Phases

### Phase 1: Core Feature (Single Phase)

All changes ship together — the feature is small enough for one phase:

1. **Store:** Add `autoHideToolCalls` to `app-store.ts` with localStorage persistence
2. **Settings UI:** Add toggle to `SettingsDialog.tsx`
3. **Rendering:** Add `useToolCallVisibility` hook and `AutoHideToolCall` wrapper to `MessageItem.tsx`
4. **Tests:** Add unit tests for hook behavior, store persistence, and rendering

No Phase 2/3 needed. Future enhancements (configurable delay, per-message show button) would be separate features.

## 13. Open Questions

None — all clarifications from ideation have been resolved:

1. ~~Delay duration~~ → Fixed at 5 seconds
2. ~~Error state~~ → Errors never auto-hide
3. ~~Toggle interaction~~ → Settings compose naturally
4. ~~Re-showing hidden tool calls~~ → Toggle setting OFF (no per-message button in v1)
5. ~~Mid-stream toggle~~ → In-progress animations complete; change applies to future completions

## 14. References

- [Ideation document](./01-ideation.md) — Full research, codebase map, and decision log
- [Motion AnimatePresence docs](https://motion.dev/docs/react-animate-presence) — Exit animation API
- [TanStack Virtual + Motion guide](https://www.devas.life/how-to-animate-a-tanstack-virtual-list-with-motion-rev-2/) — Compatibility patterns
- [List animation best practices](https://theodorusclarence.com/blog/list-animation) — Outer/inner div pattern
- `developer-guides/07-animations.md` — Project animation conventions

## 15. Files Modified

| File | Action | Description |
|------|--------|-------------|
| `apps/client/src/stores/app-store.ts` | Modify | Add `autoHideToolCalls` state, setter, localStorage, resetPreferences |
| `apps/client/src/components/settings/SettingsDialog.tsx` | Modify | Add toggle row for auto-hide setting |
| `apps/client/src/components/chat/MessageItem.tsx` | Modify | Add `useToolCallVisibility` hook, `AutoHideToolCall` wrapper, AnimatePresence import |
| `apps/client/src/stores/__tests__/app-store.test.ts` | Modify | Test default=true, persistence, reset behavior |
| `apps/client/src/components/chat/__tests__/MessageItem.test.tsx` | Modify | Test history hiding, live fade-out, error persistence, setting toggle |
