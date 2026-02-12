# Specification: URL-Persisted Directory State

**Status:** Draft
**Authors:** Claude Code, 2026-02-11
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## 1. Overview

Persist the selected working directory in the URL as a `?dir=` query parameter using nuqs, mirroring the existing `useSessionId` pattern. This enables shareable/bookmarkable URLs that restore both session and directory state.

## 2. Background / Problem Statement

Currently, the selected directory (`selectedCwd`) lives only in Zustand in-memory state. When the user refreshes the page or shares a URL, the directory resets to the server default. Session ID is already persisted in the URL via `useQueryState('session')` in `use-session-id.ts`, but directory state is lost.

**User impact:** Users working across multiple project directories must re-select their directory after every page refresh. URLs like `?session=abc123` don't capture the full context needed to restore the user's state.

## 3. Goals

- Persist selected directory in the URL as `?dir=` query parameter (standalone web mode)
- Restore directory from URL on page load
- Follow the established dual-mode pattern (URL for standalone, Zustand for Obsidian embedded)
- Clear session when directory changes, auto-select most recent session in new directory
- Keep URLs clean — no `?dir=` when using server default

## 4. Non-Goals

- Server-side changes
- Changing how session ID is persisted
- Adding new directory browsing features
- Obsidian plugin URL bar support (embedded mode remains Zustand-only)
- Changing the recent directories localStorage tracking mechanism

## 5. Technical Dependencies

| Dependency | Version | Status |
|-----------|---------|--------|
| `nuqs` | `^2.8.8` | Already installed in `apps/client/package.json` |
| `<NuqsAdapter>` | — | Already wraps app in `apps/client/src/main.tsx` |
| `getPlatform()` | — | `apps/client/src/lib/platform.ts` |

No new dependencies required.

## 6. Detailed Design

### 6.1 New Hook: `useDirectoryState`

**File:** `apps/client/src/hooks/use-directory-state.ts`

Creates a hook mirroring `use-session-id.ts` (19 lines). The hook:

1. In **standalone mode**: reads/writes `?dir=` via `useQueryState('dir')`, syncs to Zustand for backward compatibility
2. In **embedded mode**: reads/writes Zustand directly (unchanged behavior)

```typescript
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

**Key design decisions:**

- **`urlDir ?? storeDir` fallback**: When no `?dir=` in URL, `urlDir` is null but `storeDir` may have been set by `useDefaultCwd`. This ensures the hook returns the default directory without adding it to the URL.
- **Zustand sync**: The setter always calls `setStoreDir()` so that (a) recent-directories localStorage updates and (b) existing consumers reading from the store continue working.
- **Session clearing**: Calls `setSessionId(null)` when directory changes. Auto-selection of most recent session is handled by the consumer (see 6.4).
- **`history: 'replace'`**: nuqs default — directory changes don't create browser history entries.

### 6.2 Update: `useDefaultCwd`

**File:** `apps/client/src/hooks/use-default-cwd.ts`

Replace direct Zustand access with the new hook. When `useDefaultCwd` sets the default, it calls `setStoreDir` (via the hook), which updates Zustand but does NOT set `?dir=` in the URL — because `useDefaultCwd` calls `setSelectedCwd` on the store directly, and the URL is only set when `useDirectoryState`'s setter is called explicitly.

**Change:** Actually, `useDefaultCwd` should continue using `useAppStore` directly to set the default directory. This is intentional: setting the default should NOT add `?dir=` to the URL (keeping URLs clean). The `useDirectoryState` hook reads `storeDir` as fallback, so consumers get the default value without it appearing in the URL.

No changes needed to `useDefaultCwd`.

### 6.3 Update: `DirectoryPicker`

**File:** `apps/client/src/components/sessions/DirectoryPicker.tsx`

Replace `useAppStore` directory access with `useDirectoryState`:

```diff
- const { selectedCwd, setSelectedCwd, recentCwds } = useAppStore();
+ const [selectedCwd, setSelectedCwd] = useDirectoryState();
+ const { recentCwds } = useAppStore();
```

Both `handleSelect` (line 59) and `handleRecentSelect` (line 78) call `setSelectedCwd()`, which now:
1. Updates `?dir=` in URL (standalone)
2. Syncs to Zustand (localStorage tracking)
3. Clears `?session=` from URL

### 6.4 Update: `SessionSidebar`

**File:** `apps/client/src/components/sessions/SessionSidebar.tsx`

Replace direct store read with the new hook:

```diff
- const selectedCwd = useAppStore((s) => s.selectedCwd);
+ const [selectedCwd] = useDirectoryState();
```

**Auto-select most recent session on directory change:**

When directory changes and session is cleared, the sidebar already loads sessions for the new directory via the TanStack Query `['sessions', selectedCwd]`. Add a `useEffect` that auto-selects the first session when the list loads and no session is active:

```typescript
const [activeSessionId, setActiveSession] = useSessionId();
const [selectedCwd] = useDirectoryState();

// Auto-select most recent session when directory changes and no session is active
useEffect(() => {
  if (!activeSessionId && sessions.length > 0) {
    setActiveSession(sessions[0].id);
  }
}, [activeSessionId, sessions, setActiveSession]);
```

This handles the flow: directory changes → session cleared → sessions reload → first session auto-selected.

### 6.5 Consumers That Don't Need Changes

These hooks read `selectedCwd` from Zustand, which stays in sync via the `setStoreDir` call in the new hook's setter:

- `apps/client/src/hooks/use-chat-session.ts` — reads `useAppStore((s) => s.selectedCwd)`
- `apps/client/src/hooks/use-task-state.ts` — reads `useAppStore((s) => s.selectedCwd)`
- `apps/client/src/hooks/use-sessions.ts` — reads `useAppStore()` destructured `selectedCwd`

No changes needed. The Zustand store remains the shared "bus" for these consumers.

### 6.6 URL Format

```
# Session only (common case with default directory)
http://localhost:3000/?session=f47ac10b-58cc-4372-a567-0e02b2c3d479

# Session + directory
http://localhost:3000/?session=f47ac10b&dir=%2FUsers%2Fdorian%2FKeep%2F144%2Fwebui

# Directory only (no session selected)
http://localhost:3000/?dir=%2FUsers%2Fdorian%2FKeep%2F144%2Fwebui

# Clean (no params = default directory, no session)
http://localhost:3000/
```

### 6.7 Initialization Flow

```
Page load with ?dir=/path&session=abc
  │
  ├── useDirectoryState() reads ?dir= → returns "/path"
  │   └── syncs to Zustand store
  │
  ├── useSessionId() reads ?session= → returns "abc"
  │
  └── useDefaultCwd() sees selectedCwd is NOT null → skips fetch

Page load with no params
  │
  ├── useDirectoryState() reads ?dir= → null, falls back to storeDir → null
  │
  ├── useDefaultCwd() sees selectedCwd IS null → fetches default → sets in Zustand
  │   └── useDirectoryState() now returns storeDir (default), ?dir= stays empty
  │
  └── SessionSidebar loads sessions for default cwd
```

### 6.8 Standalone URL Initialization Sync

When the page loads with `?dir=` in the URL, the Zustand store starts with `selectedCwd: null`. The `useDirectoryState` hook returns `urlDir` in standalone mode, but the Zustand store needs to be synced for consumers that read directly from the store.

Add a one-time sync `useEffect` inside `useDirectoryState`:

```typescript
// Sync URL → Zustand on initial load (standalone only)
useEffect(() => {
  if (!platform.isEmbedded && urlDir && urlDir !== storeDir) {
    setStoreDir(urlDir);
  }
}, [urlDir]); // Only re-run when URL changes (browser back/forward)
```

This ensures that when the page loads with `?dir=/path`, the Zustand store is immediately populated so `use-sessions.ts`, `use-chat-session.ts` etc. get the correct directory.

## 7. User Experience

**Normal usage:** User selects a directory in DirectoryPicker → URL updates to include `?dir=` → previous session cleared → most recent session in new directory auto-selected.

**Sharing:** User copies URL → recipient opens it → both directory and session are restored.

**Refresh:** User refreshes page → directory and session restored from URL params.

**Default directory:** First-time load with no params → server default directory used → URL stays clean.

## 8. Testing Strategy

### 8.1 Unit Tests: `useDirectoryState`

**File:** `apps/client/src/hooks/__tests__/use-directory-state.test.tsx`

```typescript
// Test: returns URL state in standalone mode
// Purpose: Verify nuqs integration works for reading ?dir= param

// Test: returns Zustand state in embedded mode
// Purpose: Verify Obsidian compatibility — URL not touched

// Test: setter updates both URL and Zustand in standalone
// Purpose: Verify sync mechanism keeps store in sync for consumers

// Test: setter clears session ID on directory change
// Purpose: Verify session is cleared when directory changes

// Test: setting null removes ?dir= from URL
// Purpose: Verify clean URL behavior

// Test: falls back to Zustand when URL has no ?dir= param
// Purpose: Verify default directory behavior — useDefaultCwd sets store, hook reads it
```

**Mocking strategy:**
- Mock `getPlatform()` to toggle standalone/embedded
- Use nuqs `NuqsTestingAdapter` for URL state testing
- Mock `useAppStore` for Zustand assertions

### 8.2 Component Tests

**Update `SessionSidebar.test.tsx`:**
- Mock `useDirectoryState` instead of direct store access
- Test auto-select behavior: when sessions load and no active session, first session is selected

**Update `DirectoryPicker` tests (if they exist):**
- Verify `setSelectedCwd` from hook is called on directory selection

### 8.3 Integration Tests (Manual)

- Load `?dir=/some/path` → verify directory is pre-selected
- Change directory → verify `?session=` clears and most recent session auto-selects
- Refresh page → verify directory and session persist
- Load with no params → verify default directory loads without `?dir=` in URL

## 9. Performance Considerations

- **nuqs throttling:** URL updates are throttled to 50ms by nuqs (browser-safe rate). No additional debouncing needed.
- **Zustand sync:** One extra `useEffect` render for URL → Zustand sync on load. Negligible (~1ms).
- **No new network requests:** Directory state is purely client-side URL management.

## 10. Security Considerations

- **Path traversal:** URL could contain `?dir=../../etc/passwd`. Server already validates `cwd` in `agent-manager.ts` before creating sessions. No client-side validation needed.
- **XSS:** React escapes directory paths by default. No `dangerouslySetInnerHTML` used.
- **URL encoding:** nuqs handles `encodeURIComponent`/`decodeURIComponent` automatically.

## 11. Documentation

- Update `CLAUDE.md` to note `?dir=` URL parameter
- No guide updates needed (this is a small UI enhancement)

## 12. Implementation Phases

### Phase 1: Core Hook + Integration

1. Create `apps/client/src/hooks/use-directory-state.ts`
2. Update `DirectoryPicker.tsx` to use new hook
3. Update `SessionSidebar.tsx` to use new hook + add auto-select logic
4. Write tests for `use-directory-state.test.tsx`
5. Verify existing tests pass

### Phase 2: Verification

1. Manual testing: URL persistence, page refresh, sharing, default directory
2. Verify Obsidian embedded mode unaffected (if testable)
3. Update `CLAUDE.md`

## 13. File Change Summary

| File | Change | Lines |
|------|--------|-------|
| `apps/client/src/hooks/use-directory-state.ts` | **New** | ~40 |
| `apps/client/src/hooks/__tests__/use-directory-state.test.tsx` | **New** | ~80 |
| `apps/client/src/components/sessions/DirectoryPicker.tsx` | Modify | ~3 |
| `apps/client/src/components/sessions/SessionSidebar.tsx` | Modify | ~10 |
| `CLAUDE.md` | Modify | ~2 |

**Files that don't change** (verified): `use-default-cwd.ts`, `use-chat-session.ts`, `use-task-state.ts`, `use-sessions.ts`, `app-store.ts`, `main.tsx`, `platform.ts`

## 14. Open Questions

None — all clarifications resolved during ideation.

## 15. References

- Ideation: `specs/url-persisted-directory-state/01-ideation.md`
- Existing pattern: `apps/client/src/hooks/use-session-id.ts`
- nuqs docs: https://nuqs.dev/docs/basic-usage
- nuqs React SPA adapter: `nuqs/adapters/react`
