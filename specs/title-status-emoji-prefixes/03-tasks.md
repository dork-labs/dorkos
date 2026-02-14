---
slug: title-status-emoji-prefixes
date: 2026-02-13
---

# Tasks: Title Status Emoji Prefixes

## Task 1 — [P1] Add isWaitingForUser to Zustand store

**File:** `apps/client/src/stores/app-store.ts`

Add `isWaitingForUser` boolean and its setter to the Zustand store, following the exact pattern used by `isStreaming`.

**Interface addition** (in `AppState`, after `setIsStreaming`):

```typescript
isWaitingForUser: boolean;
setIsWaitingForUser: (v: boolean) => void;
```

**Implementation addition** (in `create` body, after `setIsStreaming`):

```typescript
isWaitingForUser: false,
setIsWaitingForUser: (v) => set({ isWaitingForUser: v }),
```

**Blocked by:** nothing

---

## Task 2 — [P1] Add ChatPanel sync for isWaitingForUser

**File:** `apps/client/src/components/chat/ChatPanel.tsx`

Sync `isWaitingForUser` from `useChatSession` to the Zustand store, mirroring the existing `isStreaming` sync pattern. Add this right after the existing `setIsStreaming` sync block (~line 224-227):

```typescript
const setIsWaitingForUser = useAppStore((s) => s.setIsWaitingForUser);

useEffect(() => {
  setIsWaitingForUser(isWaitingForUser);
  return () => setIsWaitingForUser(false);
}, [isWaitingForUser, setIsWaitingForUser]);
```

**Blocked by:** Task 1

---

## Task 3 — [P2] Extend useDocumentTitle with prefix logic

**File:** `apps/client/src/hooks/use-document-title.ts`

Replace the entire hook implementation with the extended version that adds visibility tracking, streaming transition detection, and emoji prefix computation.

**New interface:**

```typescript
interface UseDocumentTitleOptions {
  cwd: string | null;
  activeForm: string | null;
  isStreaming: boolean;
  isWaitingForUser: boolean;
}
```

**Full new implementation:**

```typescript
import { useEffect, useRef } from 'react';
import { hashToEmoji } from '@/lib/favicon-utils';

interface UseDocumentTitleOptions {
  cwd: string | null;
  activeForm: string | null;
  isStreaming: boolean;
  isWaitingForUser: boolean;
}

export function useDocumentTitle({ cwd, activeForm, isStreaming, isWaitingForUser }: UseDocumentTitleOptions) {
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
      const truncated =
        activeForm.length > 40
          ? activeForm.slice(0, 40) + '\u2026'
          : activeForm;
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
              activeForm.length > 40
                ? activeForm.slice(0, 40) + '\u2026'
                : activeForm;
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

**Also update existing tests** in `apps/client/src/hooks/__tests__/use-document-title.test.ts` to add the new required props (`isStreaming: false, isWaitingForUser: false`) to all existing `useDocumentTitle` calls so they continue to pass.

**Blocked by:** nothing (can be done in parallel with Tasks 1 and 2)

---

## Task 4 — [P2] Update App.tsx to pass new props

**File:** `apps/client/src/App.tsx`

Update the `useDocumentTitle` call to pass `isStreaming` and `isWaitingForUser` from the Zustand store.

**Change from:**

```typescript
const isStreaming = useAppStore((s) => s.isStreaming);
const activeForm = useAppStore((s) => s.activeForm);
useFavicon({ cwd: embedded ? null : selectedCwd, isStreaming });
useDocumentTitle({ cwd: embedded ? null : selectedCwd, activeForm });
```

**To:**

```typescript
const isStreaming = useAppStore((s) => s.isStreaming);
const activeForm = useAppStore((s) => s.activeForm);
const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
useFavicon({ cwd: embedded ? null : selectedCwd, isStreaming });
useDocumentTitle({ cwd: embedded ? null : selectedCwd, activeForm, isStreaming, isWaitingForUser });
```

**Blocked by:** Tasks 1, 2, and 3

---

## Task 5 — [P3] Add tests for title status prefixes

**File:** `apps/client/src/hooks/__tests__/use-document-title.test.ts`

Add all 7 test cases from the spec's Testing Strategy section to the existing test file. These go in a new `describe('status prefixes', ...)` block:

```typescript
describe('status prefixes', () => {
  it('shows 🔔 prefix when isWaitingForUser is true', () => {
    renderHook(() => useDocumentTitle({
      cwd: '/test', activeForm: null, isStreaming: false, isWaitingForUser: true
    }));
    expect(document.title).toMatch(/^🔔 /);
  });

  it('does not show 🔔 when isWaitingForUser is false', () => {
    renderHook(() => useDocumentTitle({
      cwd: '/test', activeForm: null, isStreaming: false, isWaitingForUser: false
    }));
    expect(document.title).not.toMatch(/^🔔/);
  });

  it('shows 🏁 when streaming ends while tab is hidden', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming }) => useDocumentTitle({
        cwd: '/test', activeForm: null, isStreaming, isWaitingForUser: false
      }),
      { initialProps: { isStreaming: true } },
    );
    rerender({ isStreaming: false });
    expect(document.title).toMatch(/^🏁 /);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('clears 🏁 when tab becomes visible', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming }) => useDocumentTitle({
        cwd: '/test', activeForm: null, isStreaming, isWaitingForUser: false
      }),
      { initialProps: { isStreaming: true } },
    );
    rerender({ isStreaming: false });
    expect(document.title).toMatch(/^🏁 /);

    // User returns
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.title).not.toMatch(/^🏁/);
  });

  it('🔔 takes priority over 🏁', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming, isWaitingForUser }) => useDocumentTitle({
        cwd: '/test', activeForm: null, isStreaming, isWaitingForUser
      }),
      { initialProps: { isStreaming: true, isWaitingForUser: false } },
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
    renderHook(() => useDocumentTitle({
      cwd: null, activeForm: null, isStreaming: false, isWaitingForUser: true
    }));
    expect(document.title).toBe('DorkOS');
  });

  it('preserves activeForm with prefix', () => {
    renderHook(() => useDocumentTitle({
      cwd: '/test', activeForm: 'Running tests', isStreaming: false, isWaitingForUser: true
    }));
    expect(document.title).toMatch(/^🔔 /);
    expect(document.title).toContain('Running tests');
    expect(document.title).toContain('— DorkOS');
  });
});
```

**Blocked by:** Tasks 3 and 4

---

## Dependency Graph

```
Task 1 (Zustand store) ──────┐
                              ├──► Task 4 (App.tsx wiring) ──► Task 5 (Tests)
Task 2 (ChatPanel sync) ─────┤                                    ▲
                              │                                    │
Task 3 (useDocumentTitle) ────┴────────────────────────────────────┘
```

- Tasks 1, 2, and 3 can be done in parallel
- Task 2 depends on Task 1 (needs the store field to exist)
- Task 4 depends on Tasks 1, 2, and 3
- Task 5 depends on Tasks 3 and 4
