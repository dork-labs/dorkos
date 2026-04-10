---
slug: title-status-emoji-prefixes
---

# Specification: Title Status Emoji Prefixes

**Status:** Draft
**Authors:** Claude Code, 2026-02-13
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## Overview

Add two emoji prefixes to the browser tab title that communicate session state at a glance:

| Prefix | Meaning                                                        | Shows when                                                                        |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 🔔     | AI is waiting for user action (tool approval, question prompt) | `isWaitingForUser === true`, regardless of tab focus                              |
| 🏁     | AI response completed while user was away                      | Streaming→idle transition occurred while `document.hidden`, cleared on tab return |

Priority: 🔔 > 🏁 (when both conditions are true, show 🔔 only since it requires user action).

**Title format examples:**

```
Normal:          🐸 myproject — Running tests — DorkOS
Waiting:         🔔 🐸 myproject — Running tests — DorkOS
Unseen complete: 🏁 🐸 myproject — DorkOS
Both (priority): 🔔 🐸 myproject — DorkOS
Embedded/null:   DorkOS  (no change)
```

## Background / Problem Statement

When users tab away during an AI response, they have no way to know whether the AI has finished, or whether it's waiting for their input. The favicon pulse indicates streaming-in-progress, but there's no signal for "done" or "needs attention" — the user has to manually check back. Title prefixes solve this because browser tabs are always visible, even when the page itself is hidden.

## Goals

- Let users know at a glance (from browser tab) when a response has finished and they haven't seen it yet
- Let users know immediately when the AI is waiting for their input (tool approval, question prompt)
- Integrate cleanly into the existing `useDocumentTitle` hook with minimal new state
- No new dependencies

## Non-Goals

- Favicon changes for these states (favicon pulse already handles streaming)
- Desktop/OS-level notifications (separate concern)
- Sound notifications (handled by separate `enableNotificationSound` system)
- Mobile-specific behavior
- Obsidian embedded mode (title management is not applicable)

## Technical Dependencies

- **Zustand** (already installed) — state management for `isWaitingForUser`
- **Page Visibility API** (`document.hidden`, `visibilitychange` event) — browser built-in, no polyfill needed
- No new libraries required

## Detailed Design

### Architecture

The feature touches 4 files with a clean data flow:

```
useChatSession                    ChatPanel                    Zustand Store            App.tsx
┌──────────────┐    destructure   ┌─────────────┐   sync      ┌──────────────┐  read   ┌──────────────────┐
│isWaitingForUser├───────────────►│ ChatPanel    ├────────────►│ app-store    ├────────►│ useDocumentTitle │
│waitingType    │                 │              │             │isWaitingForUser│        │ (prefix logic)   │
│status         │                 │setIsStreaming │             │isStreaming    │        │ (visibility API)  │
└──────────────┘                 └─────────────┘             └──────────────┘        └──────────────────┘
```

### 1. Zustand Store — `apps/client/src/stores/app-store.ts`

Add `isWaitingForUser` and `setIsWaitingForUser` to the store interface and implementation, following the exact pattern used by `isStreaming`:

**Interface addition** (in `AppState`):

```typescript
isWaitingForUser: boolean;
setIsWaitingForUser: (v: boolean) => void;
```

**Implementation addition** (in `create` body, next to `isStreaming`):

```typescript
isWaitingForUser: false,
setIsWaitingForUser: (v) => set({ isWaitingForUser: v }),
```

### 2. ChatPanel Sync — `apps/client/src/components/chat/ChatPanel.tsx`

Sync `isWaitingForUser` from `useChatSession` to the Zustand store, mirroring the existing `isStreaming` sync pattern:

```typescript
const setIsWaitingForUser = useAppStore((s) => s.setIsWaitingForUser);

useEffect(() => {
  setIsWaitingForUser(isWaitingForUser);
  return () => setIsWaitingForUser(false);
}, [isWaitingForUser, setIsWaitingForUser]);
```

This goes right after the existing `setIsStreaming` sync block (~line 224-227).

### 3. Hook API — `apps/client/src/hooks/use-document-title.ts`

Extend the options interface:

```typescript
interface UseDocumentTitleOptions {
  cwd: string | null;
  activeForm: string | null;
  isStreaming: boolean; // NEW
  isWaitingForUser: boolean; // NEW
}
```

**Internal state (refs, not React state — to avoid unnecessary re-renders):**

- `isTabHiddenRef` — tracks `document.hidden` via `visibilitychange` listener
- `hasUnseenResponseRef` — set to `true` when `isStreaming` transitions `true→false` while tab is hidden; cleared when tab becomes visible

**Implementation logic:**

```typescript
export function useDocumentTitle({
  cwd,
  activeForm,
  isStreaming,
  isWaitingForUser,
}: UseDocumentTitleOptions) {
  const isTabHiddenRef = useRef(document.hidden);
  const hasUnseenResponseRef = useRef(false);
  const wasStreamingRef = useRef(isStreaming);

  // Track tab visibility
  useEffect(() => {
    const handler = () => {
      isTabHiddenRef.current = document.hidden;
      if (!document.hidden) {
        // User returned — clear unseen flag and rebuild title
        hasUnseenResponseRef.current = false;
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Detect streaming→idle transition while tab is hidden
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && isTabHiddenRef.current) {
      hasUnseenResponseRef.current = true;
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Build title (runs on all relevant state changes)
  useEffect(() => {
    if (!cwd) {
      document.title = 'DorkOS';
      return;
    }

    const emoji = hashToEmoji(cwd);
    const dirName = cwd.split('/').filter(Boolean).pop() ?? cwd;

    // Compute prefix (priority: 🔔 > 🏁 > none)
    let prefix = '';
    if (isWaitingForUser) {
      prefix = '🔔 ';
    } else if (hasUnseenResponseRef.current) {
      prefix = '🏁 ';
    }

    let title = `${prefix}${emoji} ${dirName}`;

    if (activeForm) {
      const truncated = activeForm.length > 40 ? activeForm.slice(0, 40) + '\u2026' : activeForm;
      title += ` \u2014 ${truncated}`;
    }

    title += ' \u2014 DorkOS';
    document.title = title;
  }, [cwd, activeForm, isStreaming, isWaitingForUser]);

  // Also update title when visibility changes (to add/remove 🏁)
  useEffect(() => {
    const handler = () => {
      if (!document.hidden && hasUnseenResponseRef.current) {
        hasUnseenResponseRef.current = false;
        // Trigger a title rebuild — we need to re-run the title effect
        // Since refs don't trigger re-renders, we use a simple direct update
        // to remove the 🏁 prefix immediately
        if (cwd) {
          const emoji = hashToEmoji(cwd);
          const dirName = cwd.split('/').filter(Boolean).pop() ?? cwd;
          let title = `${emoji} ${dirName}`;
          if (activeForm) {
            const truncated =
              activeForm.length > 40 ? activeForm.slice(0, 40) + '\u2026' : activeForm;
            title += ` \u2014 ${truncated}`;
          }
          title += ' \u2014 DorkOS';
          document.title = title;
        }
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [cwd, activeForm]);
}
```

**Key design decision — why refs instead of state for visibility tracking:**

The `hasUnseenResponseRef` and `isTabHiddenRef` values don't need to cause re-renders when they change. The title is rebuilt reactively from the `useEffect` dependencies (`isStreaming`, `isWaitingForUser`), and the visibility handler directly sets `document.title` for the instant-clear case. Using refs avoids unnecessary render cycles.

### 4. App.tsx Integration — `apps/client/src/App.tsx`

Update the hook call at line 33:

```typescript
const isStreaming = useAppStore((s) => s.isStreaming);
const activeForm = useAppStore((s) => s.activeForm);
const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
useFavicon({ cwd: embedded ? null : selectedCwd, isStreaming });
useDocumentTitle({ cwd: embedded ? null : selectedCwd, activeForm, isStreaming, isWaitingForUser });
```

## User Experience

1. **User sends a message, tabs away** → Favicon pulses (existing behavior). Title shows activeForm if tasks are running.
2. **AI finishes while user is away** → Title gains 🏁 prefix. User sees `🏁 🐸 myproject — DorkOS` in their browser tab bar.
3. **User returns to tab** → 🏁 clears immediately. Title returns to normal.
4. **AI hits a tool approval** → Title gains 🔔 prefix regardless of tab focus. User sees `🔔 🐸 myproject — Reviewing changes — DorkOS`.
5. **User approves the tool** → 🔔 clears as `isWaitingForUser` becomes false.
6. **AI finishes while user is away AND a tool needs approval** → Only 🔔 shows (priority rule).

## Testing Strategy

### Unit Tests — `apps/client/src/hooks/__tests__/use-document-title.test.ts`

All tests run in jsdom environment. Mock `hashToEmoji` for deterministic output.

```typescript
// Existing tests remain unchanged (backward compatible)

describe('status prefixes', () => {
  it('shows 🔔 prefix when isWaitingForUser is true', () => {
    // Purpose: Verify bell emoji appears in title when AI needs user action
    renderHook(() =>
      useDocumentTitle({
        cwd: '/test',
        activeForm: null,
        isStreaming: false,
        isWaitingForUser: true,
      })
    );
    expect(document.title).toMatch(/^🔔 /);
  });

  it('does not show 🔔 when isWaitingForUser is false', () => {
    // Purpose: Verify no prefix in normal idle state
    renderHook(() =>
      useDocumentTitle({
        cwd: '/test',
        activeForm: null,
        isStreaming: false,
        isWaitingForUser: false,
      })
    );
    expect(document.title).not.toMatch(/^🔔/);
  });

  it('shows 🏁 when streaming ends while tab is hidden', () => {
    // Purpose: Verify checkered flag appears after unseen completion
    // Simulate: tab hidden → streaming ends → check title
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming }) =>
        useDocumentTitle({
          cwd: '/test',
          activeForm: null,
          isStreaming,
          isWaitingForUser: false,
        }),
      { initialProps: { isStreaming: true } }
    );
    rerender({ isStreaming: false });
    expect(document.title).toMatch(/^🏁 /);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('clears 🏁 when tab becomes visible', () => {
    // Purpose: Verify unseen flag clears on user return
    // Simulate: set unseen state, then fire visibilitychange with hidden=false
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming }) =>
        useDocumentTitle({
          cwd: '/test',
          activeForm: null,
          isStreaming,
          isWaitingForUser: false,
        }),
      { initialProps: { isStreaming: true } }
    );
    rerender({ isStreaming: false });
    expect(document.title).toMatch(/^🏁 /);

    // User returns
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.title).not.toMatch(/^🏁/);
  });

  it('🔔 takes priority over 🏁', () => {
    // Purpose: Verify priority rule — waiting is more actionable than done
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming, isWaitingForUser }) =>
        useDocumentTitle({
          cwd: '/test',
          activeForm: null,
          isStreaming,
          isWaitingForUser,
        }),
      { initialProps: { isStreaming: true, isWaitingForUser: false } }
    );
    // Streaming ends while hidden (sets unseen flag)
    rerender({ isStreaming: false, isWaitingForUser: false });
    expect(document.title).toMatch(/^🏁 /);

    // Now also waiting for user
    rerender({ isStreaming: false, isWaitingForUser: true });
    expect(document.title).toMatch(/^🔔 /);
    expect(document.title).not.toContain('🏁');
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('no prefix when cwd is null (embedded mode)', () => {
    // Purpose: Verify embedded mode is excluded
    renderHook(() =>
      useDocumentTitle({
        cwd: null,
        activeForm: null,
        isStreaming: false,
        isWaitingForUser: true,
      })
    );
    expect(document.title).toBe('DorkOS');
  });

  it('preserves activeForm with prefix', () => {
    // Purpose: Verify prefix doesn't break existing title format
    renderHook(() =>
      useDocumentTitle({
        cwd: '/test',
        activeForm: 'Running tests',
        isStreaming: false,
        isWaitingForUser: true,
      })
    );
    expect(document.title).toMatch(/^🔔 /);
    expect(document.title).toContain('Running tests');
    expect(document.title).toContain('— DorkOS');
  });
});
```

### Backward Compatibility

Existing tests pass unchanged because the new props have additive behavior only. The existing title format (emoji + dirname + activeForm + DorkOS) is preserved — prefixes are simply prepended.

**Existing tests to verify still pass:**

- `sets title with emoji and directory name` — still works, `isStreaming: false, isWaitingForUser: false` produces no prefix
- `includes activeForm in title when present` — unchanged
- `truncates long activeForm at 40 chars` — unchanged
- `falls back to default title when cwd is null` — unchanged
- `uses last path segment as directory name` — unchanged
- `updates when activeForm changes` — unchanged

Note: The existing tests will need the new required props added to their `useDocumentTitle` calls (`isStreaming: false, isWaitingForUser: false`). This is a trivial mechanical update.

## Performance Considerations

- **`document.title` changes are lightweight** — they don't trigger layout, paint, or reflow. Only the browser tab text updates.
- **`visibilitychange` listener** — fires only on tab switches, not continuously. Negligible overhead.
- **No new re-renders** — visibility and unseen state are tracked via refs, not React state. The only new React state driving renders is `isWaitingForUser` from the Zustand store, which already existed in `useChatSession`.
- **No timers or intervals** — unlike the favicon pulse, this is purely event-driven.

## Security Considerations

No security implications. The feature only reads `document.hidden` and writes `document.title` — both are same-origin browser APIs with no data exposure.

## Documentation

- Update `AGENTS.md` architecture section to mention title prefix behavior under the Client subsection
- No external documentation needed

## Implementation Phases

### Phase 1: Core Implementation (Single Phase)

1. Add `isWaitingForUser` / `setIsWaitingForUser` to Zustand store
2. Add ChatPanel sync effect for `isWaitingForUser`
3. Extend `useDocumentTitle` with new props, visibility tracking, and prefix logic
4. Update `App.tsx` to pass new props
5. Update existing tests with new required props + add new prefix tests
6. Manual testing: verify all 6 UX scenarios described above

This is a single-phase feature — no follow-up phases needed.

## Open Questions

None — all decisions have been made during ideation.

## References

- [MDN — Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [MDN — visibilitychange event](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event)
- [Ideation document](./01-ideation.md)
- Existing patterns: `useFavicon` hook (pulse animation), `useIdleDetector` hook (visibility tracking)
