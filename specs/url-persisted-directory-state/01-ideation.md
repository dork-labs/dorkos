# URL-Persisted Directory State

**Slug:** url-persisted-directory-state
**Author:** Claude Code
**Date:** 2026-02-11
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Persist the selected/active directory in the URL using nuqs, mirroring the existing pattern where session ID is stored in the URL via `useQueryState('session')`.
- **Assumptions:**
  - nuqs is already installed (`nuqs@^2.8.8` in client deps) and `<NuqsAdapter>` already wraps the app in `main.tsx`
  - The existing `useSessionId` hook is the template to follow (dual-mode: URL in standalone, Zustand in Obsidian embedded)
  - Directory paths containing `/` will be URL-encoded by nuqs automatically
  - `history: 'replace'` is preferred to avoid cluttering browser history with folder navigation
- **Out of scope:**
  - Changing how session ID is persisted
  - Adding new directory browsing features
  - Server-side changes
  - Obsidian plugin URL support (embedded mode stays Zustand-only)

## 2) Pre-reading Log

- `apps/client/src/main.tsx`: NuqsAdapter already wraps the entire app tree
- `apps/client/src/hooks/use-session-id.ts`: Exact pattern to replicate — dual-mode hook using `useQueryState('session')` for standalone, Zustand for embedded
- `apps/client/src/stores/app-store.ts`: Directory stored as `selectedCwd` in Zustand with recent cwds in localStorage
- `apps/client/src/components/sessions/DirectoryPicker.tsx`: UI for selecting directory, calls `setSelectedCwd()` from store
- `apps/client/src/components/sessions/SessionSidebar.tsx`: Displays selected directory, reads `selectedCwd` from store
- `apps/client/src/hooks/use-default-cwd.ts`: Fetches server default when `selectedCwd === null`, sets in store
- `apps/client/src/hooks/use-chat-session.ts`: Passes `selectedCwd` to `transport.getMessages()`
- `apps/client/src/hooks/use-task-state.ts`: Passes `selectedCwd` to `transport.getTasks()`
- `apps/client/src/hooks/use-sessions.ts`: Passes `selectedCwd` to session listing queries
- `apps/client/src/lib/platform.ts`: Platform detection (`isEmbedded` flag for Obsidian)
- `apps/client/package.json`: `nuqs@^2.8.8` already a dependency

## 3) Codebase Map

**Primary Components/Modules:**
- `apps/client/src/hooks/use-session-id.ts` — Template hook: `useQueryState('session')` for standalone, Zustand for embedded
- `apps/client/src/stores/app-store.ts` — Zustand store with `selectedCwd`, `setSelectedCwd`, `recentCwds`
- `apps/client/src/components/sessions/DirectoryPicker.tsx` — Directory selection dialog, calls `setSelectedCwd()`
- `apps/client/src/components/sessions/SessionSidebar.tsx` — Displays selected directory breadcrumb

**Shared Dependencies:**
- `apps/client/src/lib/platform.ts` — `getPlatform()` returns `{ isEmbedded }` flag
- `apps/client/src/contexts/TransportContext.tsx` — Transport injection
- `nuqs` — Already installed, adapter already wrapping app

**Data Flow:**
User selects directory in DirectoryPicker → `setSelectedCwd(path)` → Zustand store updates → dependent hooks (`use-chat-session`, `use-sessions`, `use-task-state`) re-query with new cwd

**Potential Blast Radius:**
- **New file:** `apps/client/src/hooks/use-directory-state.ts` (new hook)
- **Modified:** `DirectoryPicker.tsx`, `SessionSidebar.tsx`, `use-default-cwd.ts`
- **Consumers to verify:** `use-chat-session.ts`, `use-task-state.ts`, `use-sessions.ts`
- **Tests to update:** `SessionSidebar.test.tsx`, `use-chat-session.test.tsx`, `use-sessions.test.tsx`

## 4) Root Cause Analysis

N/A — Not a bug fix.

## 5) Research

**nuqs in this project:**
- Already installed and configured (`<NuqsAdapter>` in `main.tsx`)
- For Vite/React SPA: import from `nuqs/adapters/react`
- `useQueryState('key', parseAsString)` manages a single URL query param
- Setting to `null` removes param from URL

**Potential Solutions:**

**1. Parallel State with Platform Hook (Recommended)**
- Create `useDirectoryState()` mirroring `useSessionId()` pattern
- URL state via nuqs in standalone mode, Zustand in embedded mode
- Sync URL changes back to Zustand via `useEffect` for browser back/forward
- Pros: Matches existing pattern, minimal refactoring, works in both modes
- Cons: Slight sync complexity (URL <-> Zustand)
- Complexity: Low

**2. URL-Only (Remove Zustand)**
- Remove `selectedCwd` from Zustand, use `useQueryState('dir')` everywhere
- Pros: Simpler single source of truth
- Cons: Breaks Obsidian embedded mode (no URL bar), larger refactor
- Complexity: Medium

**3. useQueryStates for Session + Directory Together**
- Manage both params atomically
- Pros: Atomic updates prevent inconsistency
- Cons: Over-engineered since session and directory have different lifecycles
- Complexity: Medium

**Recommendation:** Approach 1 — Parallel State with Platform Hook. Follows the established `useSessionId` pattern exactly, minimal changes, works in both standalone and embedded modes.

**Key Design Decisions:**
- **Encoding:** Default `parseAsString` handles path encoding automatically (paths get `%2F` encoded)
- **History:** Use `history: 'replace'` (default) to avoid cluttering browser history
- **Default:** When no `?dir=` param exists, fall back to server default (keeps URLs clean)
- **URL format:** `?session=abc123&dir=%2FUsers%2Fdorian%2Fproject` — session and directory coexist as independent params

## 6) Clarifications

1. **Should changing the directory clear the selected session?** Currently selecting a new directory likely shows different sessions. Should switching directories also clear `?session=` from the URL, or keep the session param even if it's no longer visible in the new directory's session list?

2. **Should the default directory appear in the URL?** When the user hasn't explicitly chosen a directory (server default is used), should the URL remain clean (`?session=abc`) or include the default (`?session=abc&dir=%2Fdefault%2Fpath`)? Recommendation: keep URL clean (no `?dir=` when using default).

3. **Recent directories interaction:** The `recentCwds` list in localStorage should still be updated when directory changes (via URL or picker). The new hook should continue to trigger the Zustand `setSelectedCwd` which handles localStorage updates. Should this behavior change?
