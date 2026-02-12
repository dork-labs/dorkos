# Tasks: URL-Persisted Directory State

**Spec:** [02-specification.md](./02-specification.md)
**Feature Slug:** `url-persisted-directory-state`

---

## Task 1: [P1] Create `useDirectoryState` hook

**File:** `apps/client/src/hooks/use-directory-state.ts` (NEW)

**Status:** Not started

### Description

Create the `useDirectoryState` hook that mirrors the existing `useSessionId` pattern in `apps/client/src/hooks/use-session-id.ts`. The hook persists the selected working directory in the URL as a `?dir=` query parameter via nuqs in standalone mode, and uses Zustand directly in embedded (Obsidian) mode.

### Implementation

Create `apps/client/src/hooks/use-directory-state.ts` with the following content:

```typescript
import { useEffect } from 'react';
import { getPlatform } from '../lib/platform';
import { useQueryState } from 'nuqs';
import { useAppStore } from '../stores/app-store';
import { useSessionId } from './use-session-id';

export function useDirectoryState(): [string | null, (dir: string | null) => void] {
  const platform = getPlatform();

  // Zustand state (used in embedded mode + sync target)
  const storeDir = useAppStore((s) => s.selectedCwd);
  const setStoreDir = useAppStore((s) => s.setSelectedCwd);

  // URL state (standalone mode)
  const [urlDir, setUrlDir] = useQueryState('dir');

  // Session clearing on directory change
  const [, setSessionId] = useSessionId();

  // Sync URL -> Zustand on initial load (standalone only)
  useEffect(() => {
    if (!platform.isEmbedded && urlDir && urlDir !== storeDir) {
      setStoreDir(urlDir);
    }
  }, [urlDir]); // Only re-run when URL changes (browser back/forward)

  if (platform.isEmbedded) {
    return [storeDir, (dir) => {
      if (dir) {
        setStoreDir(dir);
        setSessionId(null); // Clear session on dir change
      }
    }];
  }

  // Standalone: URL is source of truth, sync to Zustand
  return [
    urlDir ?? storeDir, // Fall back to Zustand (for default cwd set by useDefaultCwd)
    (dir) => {
      if (dir) {
        setUrlDir(dir);
        setStoreDir(dir);  // Sync to Zustand for localStorage + consumers
        setSessionId(null); // Clear session on dir change
      } else {
        setUrlDir(null);    // Remove from URL
      }
    },
  ];
}
```

### Key design decisions

- **`urlDir ?? storeDir` fallback**: When no `?dir=` in URL, `urlDir` is null but `storeDir` may have been set by `useDefaultCwd`. This ensures the hook returns the default directory without adding it to the URL.
- **Zustand sync**: The setter always calls `setStoreDir()` so that (a) recent-directories localStorage updates and (b) existing consumers reading from the store continue working.
- **Session clearing**: Calls `setSessionId(null)` when directory changes. Auto-selection of most recent session is handled by the consumer (SessionSidebar, see Task 2).
- **`history: 'replace'`**: nuqs default -- directory changes don't create browser history entries.
- **URL->Zustand sync useEffect**: When the page loads with `?dir=` in the URL, the Zustand store starts with `selectedCwd: null`. The useEffect syncs `urlDir` into the Zustand store so consumers that read directly from the store (e.g., `use-sessions.ts`, `use-chat-session.ts`) get the correct directory.
- **No changes to `useDefaultCwd`**: `useDefaultCwd` continues using `useAppStore` directly to set the default directory. Setting the default should NOT add `?dir=` to the URL (keeping URLs clean). The `useDirectoryState` hook reads `storeDir` as fallback.

### Acceptance criteria

- Hook returns `[string | null, (dir: string | null) => void]` matching the tuple pattern used by `useSessionId`
- In standalone mode: reads `?dir=` from URL, falls back to Zustand store value
- In embedded mode: reads/writes Zustand directly
- Setter in standalone mode updates both URL and Zustand
- Setter clears `?session=` from URL when directory changes
- URL->Zustand sync useEffect populates store on page load with `?dir=`

---

## Task 2: [P2] Update DirectoryPicker and SessionSidebar to use `useDirectoryState`

**Files:**
- `apps/client/src/components/sessions/DirectoryPicker.tsx` (MODIFY)
- `apps/client/src/components/sessions/SessionSidebar.tsx` (MODIFY)

**Status:** Not started
**Blocked by:** Task 1

### Description

Replace direct `useAppStore` directory access with the new `useDirectoryState` hook in both `DirectoryPicker` and `SessionSidebar`. Add auto-select most recent session logic to `SessionSidebar`.

### DirectoryPicker changes

In `apps/client/src/components/sessions/DirectoryPicker.tsx`:

1. Add import for the new hook:
```typescript
import { useDirectoryState } from '../../hooks/use-directory-state';
```

2. Replace line 45:
```diff
- const { selectedCwd, setSelectedCwd, recentCwds } = useAppStore();
+ const [selectedCwd, setSelectedCwd] = useDirectoryState();
+ const { recentCwds } = useAppStore();
```

Both `handleSelect` (line 59) and `handleRecentSelect` (line 78) call `setSelectedCwd()`, which now:
1. Updates `?dir=` in URL (standalone)
2. Syncs to Zustand (localStorage tracking)
3. Clears `?session=` from URL

No other changes needed in DirectoryPicker -- the rest of the component works unchanged.

### SessionSidebar changes

In `apps/client/src/components/sessions/SessionSidebar.tsx`:

1. Add import for the new hook:
```typescript
import { useDirectoryState } from '../../hooks/use-directory-state';
```

2. Add `useEffect` to imports (line 1):
```diff
- import { useState, useMemo, useCallback } from 'react';
+ import { useState, useMemo, useCallback, useEffect } from 'react';
```

3. Replace line 25:
```diff
- const selectedCwd = useAppStore((s) => s.selectedCwd);
+ const [selectedCwd] = useDirectoryState();
```

4. Add auto-select most recent session `useEffect` after the `sessions` query (after line 39):
```typescript
// Auto-select most recent session when directory changes and no session is active
useEffect(() => {
  if (!activeSessionId && sessions.length > 0) {
    setActiveSession(sessions[0].id);
  }
}, [activeSessionId, sessions, setActiveSession]);
```

This handles the flow: directory changes -> session cleared -> sessions reload -> first session auto-selected.

### Acceptance criteria

- DirectoryPicker uses `useDirectoryState` for reading and setting the directory
- DirectoryPicker still reads `recentCwds` from `useAppStore`
- SessionSidebar uses `useDirectoryState` for reading the directory
- SessionSidebar auto-selects the first (most recent) session when no session is active and sessions are available
- All existing functionality (new chat creation, session clicking, sidebar close, etc.) continues working

---

## Task 3: [P3] Write tests for `useDirectoryState` and update existing tests

**Files:**
- `apps/client/src/hooks/__tests__/use-directory-state.test.tsx` (NEW)
- `apps/client/src/components/sessions/__tests__/SessionSidebar.test.tsx` (MODIFY)

**Status:** Not started
**Blocked by:** Task 2

### Description

Create comprehensive unit tests for the `useDirectoryState` hook and update `SessionSidebar.test.tsx` to mock the new hook. Verify all existing tests still pass.

### New test file: `use-directory-state.test.tsx`

Create `apps/client/src/hooks/__tests__/use-directory-state.test.tsx` with the following test cases:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import React from 'react';

// Test cases to implement:

// 1. "returns URL state in standalone mode"
//    - Mock getPlatform to return { isEmbedded: false }
//    - Render with NuqsTestingAdapter providing searchParams='?dir=/test/path'
//    - Assert hook returns ['/test/path', setter]

// 2. "returns Zustand state in embedded mode"
//    - Mock getPlatform to return { isEmbedded: true }
//    - Mock useAppStore to return selectedCwd: '/embedded/path'
//    - Assert hook returns ['/embedded/path', setter]

// 3. "setter updates both URL and Zustand in standalone"
//    - Mock getPlatform standalone
//    - Call setter with '/new/path'
//    - Assert both setUrlDir and setStoreDir were called

// 4. "setter clears session ID on directory change"
//    - Call setter with any path
//    - Assert setSessionId was called with null

// 5. "setting null removes ?dir= from URL"
//    - In standalone mode, call setter with null
//    - Assert setUrlDir was called with null

// 6. "falls back to Zustand when URL has no ?dir= param"
//    - Mock getPlatform standalone
//    - No ?dir= in URL, but Zustand has selectedCwd: '/default/path'
//    - Assert hook returns ['/default/path', setter]
```

**Mocking strategy** (follow patterns from existing tests like `use-sessions.test.tsx`):
- Mock `../lib/platform` to toggle `getPlatform()` return value
- Use `nuqs/adapters/testing` `NuqsTestingAdapter` for URL state testing
- Mock `../stores/app-store` for Zustand assertions
- Mock `./use-session-id` for session clearing assertions

### SessionSidebar.test.tsx updates

In `apps/client/src/components/sessions/__tests__/SessionSidebar.test.tsx`:

Add a mock for `useDirectoryState`:

```typescript
// Mock useDirectoryState
vi.mock('../../../hooks/use-directory-state', () => ({
  useDirectoryState: () => ['/test/cwd', vi.fn()] as const,
}));
```

The existing `useAppStore` mock should still provide `selectedCwd` for other consumers, but `SessionSidebar` now reads it via `useDirectoryState`.

Add a test for auto-select behavior:

```typescript
it('auto-selects first session when no active session', async () => {
  mockTransport = createMockTransport({
    listSessions: vi.fn().mockResolvedValue([
      makeSession({ id: 's1', title: 'First session' }),
      makeSession({ id: 's2', title: 'Second session' }),
    ]),
  });

  renderWithQuery(<SessionSidebar />);

  await waitFor(() => {
    expect(mockSetSessionId).toHaveBeenCalledWith('s1');
  });
});
```

### Verification

After all test changes, run:
```bash
npx vitest run apps/client/src/hooks/__tests__/use-directory-state.test.tsx
npx vitest run apps/client/src/components/sessions/__tests__/SessionSidebar.test.tsx
turbo test -- --run
```

Ensure all existing tests continue to pass.

### Acceptance criteria

- `use-directory-state.test.tsx` has all 6 test cases listed above, all passing
- `SessionSidebar.test.tsx` mocks `useDirectoryState` and all existing tests still pass
- `SessionSidebar.test.tsx` has a new test for auto-select behavior
- Full test suite passes (`turbo test -- --run`)

---

## Task 4: [P4] Update CLAUDE.md with `?dir=` URL parameter documentation

**File:** `CLAUDE.md` (MODIFY)

**Status:** Not started
**Blocked by:** Task 2

### Description

Add documentation about the `?dir=` URL parameter to `CLAUDE.md` so future developers and Claude Code understand the URL parameter behavior.

### Changes

In the **Client** section of `CLAUDE.md` (around the State/Chat bullet points area), add a note about URL parameters:

Add after the "State" bullet (around line 77):
```
- **URL Parameters**: `?session=` (session ID via nuqs) and `?dir=` (working directory via nuqs) persist client state in the URL for standalone mode. In Obsidian embedded mode, both use Zustand instead. The `?dir=` parameter is omitted when using the server default directory to keep URLs clean.
```

### Acceptance criteria

- CLAUDE.md mentions the `?dir=` URL parameter
- Documentation notes it is standalone-mode only (Obsidian uses Zustand)
- Documentation notes the clean URL behavior (omitted when using default directory)

---

## Dependency Graph

```
Task 1 (Core Hook)
  └── Task 2 (Component Integration)
        ├── Task 3 (Testing)
        └── Task 4 (Documentation)
```

## Summary

| Task | Phase | Title | Status | Blocked By |
|------|-------|-------|--------|------------|
| 1 | P1 | Create `useDirectoryState` hook | Not started | — |
| 2 | P2 | Update DirectoryPicker and SessionSidebar | Not started | Task 1 |
| 3 | P3 | Write tests for `useDirectoryState` + update existing tests | Not started | Task 2 |
| 4 | P4 | Update CLAUDE.md with `?dir=` documentation | Not started | Task 2 |
