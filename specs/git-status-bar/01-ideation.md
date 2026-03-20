---
slug: git-status-bar
number: 18
created: 2026-02-13
status: implemented
---

# Git Status in Status Bar

**Slug:** git-status-bar
**Author:** Claude Code
**Date:** 2026-02-13
**Branch:** main
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Add a git status indicator to the existing status bar. It should display the current branch name, file change counts, and other relevant git info. The feature should be toggleable on/off from the Settings dialog, following the same pattern as existing status bar items (CwdItem, ModelItem, etc.).
- **Assumptions:**
  - The gateway server has access to the `git` CLI (it already runs in a git repo context)
  - We follow the existing status bar item pattern (component + Zustand toggle + Settings switch)
  - No external library needed — raw `child_process.execFile` with `git status --porcelain=v1 --branch` is sufficient (avoids adding `simple-git` dependency)
  - Git status is fetched on-demand via a new server endpoint, polled by the client with TanStack Query's `refetchInterval`
  - The feature is read-only (no git actions like push/pull from the UI)
- **Out of scope:**
  - Git actions (commit, push, pull, branch switching)
  - File-level change details or diff views
  - File watcher / chokidar for real-time updates (polling is sufficient for v1)
  - Multi-repo / submodule support

## 2) Pre-reading Log

- `apps/client/src/components/status/StatusLine.tsx`: Orchestrates status bar layout with `motion.dev` animations. Conditionally renders items based on `useAppStore()` toggles. Uses `Separator` between items.
- `apps/client/src/components/status/CwdItem.tsx`: Simplest status item — icon + text display. Good template for `GitStatusItem`.
- `apps/client/src/components/status/ContextItem.tsx`: Shows context usage % with color coding (amber >80%, red >95%). Pattern for conditional color styling.
- `apps/client/src/stores/app-store.ts`: Zustand store with `showStatusBar*` booleans persisted to localStorage. Each has a setter and is included in `resetPreferences()`.
- `apps/client/src/components/settings/SettingsDialog.tsx`: Settings dialog with "Status Bar" tab containing switch toggles for each item.
- `apps/client/src/hooks/use-session-status.ts`: Derives `SessionStatusData` from streaming data, query cache, and defaults. Returns `{ model, costUsd, contextPercent, cwd, permissionMode }`.
- `packages/shared/src/transport.ts`: Transport interface — client-server contract. Would need a new `getGitStatus()` method.
- `packages/shared/src/schemas.ts`: Zod schemas for all API types. Would need a `GitStatusSchema`.
- `apps/client/src/lib/http-transport.ts`: HTTP transport implementation. Would need `getGitStatus()` method.
- `apps/client/src/lib/direct-transport.ts`: Direct (in-process) transport for Obsidian plugin. Would also need `getGitStatus()`.
- `apps/server/src/app.ts`: Express app setup — mounts routers. Would mount new git router.
- `apps/server/src/routes/sessions.ts`: Existing REST routes. Pattern for new route file.
- `guides/design-system.md`: Icon sizes (`--size-icon-xs/sm/md`), spacing conventions, animation specs. Status bar uses `text-3xs` and `icon-xs` sizes.
- `apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx`: Tests status bar toggles — pattern for adding git toggle test.

## 3) Codebase Map

### Primary Components/Modules

- `apps/client/src/components/status/StatusLine.tsx` — Status bar layout + animation orchestrator
- `apps/client/src/components/status/CwdItem.tsx` — Template for simple status items (icon + text)
- `apps/client/src/components/status/ContextItem.tsx` — Template for color-coded status items
- `apps/client/src/stores/app-store.ts` — UI state management (toggle persistence)
- `apps/client/src/components/settings/SettingsDialog.tsx` — Settings UI with status bar toggles
- `apps/client/src/hooks/use-session-status.ts` — Derives session status data for status bar

### Shared Dependencies

- `packages/shared/src/schemas.ts` — Zod schemas (need new `GitStatusSchema`)
- `packages/shared/src/types.ts` — Type re-exports
- `packages/shared/src/transport.ts` — Transport interface contract
- `apps/client/src/lib/http-transport.ts` — HTTP transport adapter
- `apps/client/src/lib/direct-transport.ts` — Direct transport adapter (Obsidian)

### Server-Side

- `apps/server/src/app.ts` — Express app, router mounting
- `apps/server/src/routes/` — Route handlers (new `git.ts` needed)

### Data Flow

```
Client: TanStack Query polls GET /api/git/status?dir=...
    ↓
Server: New git route → execFile('git', ['status', '--porcelain=v1', '--branch'])
    ↓
Parse porcelain output → GitStatusResponse { branch, ahead, behind, modified, staged, untracked, conflicted, clean }
    ↓
Client: useGitStatus() hook → returns parsed data
    ↓
StatusLine reads useAppStore().showStatusBarGit
    ↓
Conditionally renders GitStatusItem
```

### Potential Blast Radius

- **Direct (9 files):** schemas.ts, types.ts, transport.ts, http-transport.ts, direct-transport.ts, app-store.ts, StatusLine.tsx, SettingsDialog.tsx, new GitStatusItem.tsx
- **New files (2):** `apps/server/src/routes/git.ts`, `apps/client/src/components/status/GitStatusItem.tsx`
- **Tests:** SettingsDialog.test.tsx (add git toggle), new GitStatusItem test, new server route test

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

### Display Format Options

**Option A: VS Code-style minimal** — `[GitBranch icon] main ↑2 ↓1`

- Pros: Compact, industry-standard, low noise
- Cons: No local change visibility

**Option B: Counts-based** — `[icon] main · 3M 1A 2?`

- Pros: Shows local change counts with type distinction
- Cons: Cryptic abbreviations, cluttered

**Option C: Badge/dot indicator** — `[icon] main [●]` (color-coded)

- Pros: Minimal width, instant recognition
- Cons: No detail, color-blind issues

**Option D: Compact summary** — `[icon] main +5`

- Pros: Single number, very simple
- Cons: No type distinction, no sync status

### Recommendation: Hybrid of A + D

**Format:** `[GitBranch icon] main · 3 changes`

Display the branch name, and when there are local changes, show total count. Skip sync indicators (ahead/behind) for v1 since this is a coding assistant, not a git client. The user cares most about "what branch am I on" and "do I have uncommitted work."

When clean: `[GitBranch icon] main`
When dirty: `[GitBranch icon] main · 3 changes`

The word "changes" provides clarity without cryptic abbreviations. For 1 change: `1 change` (singular). Truncate branch name at ~25 chars with CSS `truncate`.

### Technical Implementation

**Recommendation: Raw `child_process.execFile`** (no new dependency)

Use `git status --porcelain=v1 --branch` which gives:

```
## main...origin/main [ahead 2]
 M file1.txt
A  file2.txt
?? file3.txt
```

Parse the `##` line for branch/ahead/behind, count remaining lines for total changes. This avoids adding `simple-git` as a dependency and keeps the implementation minimal.

**Polling:** TanStack Query `refetchInterval: 10_000` (10s) with `refetchIntervalInBackground: false`.

## 6) Clarifications

1. **Display format**: Should we show individual change types (modified/staged/untracked) or just total count?
   - Recommendation: Total count only for v1 (simpler, less noise). Details on hover via tooltip.

2. **Ahead/behind indicators**: Should we show sync status with remote (↑2 ↓1)?
   - Recommendation: Skip for v1. Users of this tool care more about local state. Can add later.

3. **Polling interval**: 10 seconds when tab is active, stop when hidden?
   - Recommendation: Yes, this balances freshness with performance.

4. **Click behavior**: Should clicking the git status item do anything?
   - Recommendation: No-op for v1. Could later open a git panel or copy branch name.

5. **Error state**: What to show when not in a git repo or git is unavailable?
   - Recommendation: Hide the item entirely (don't show an error badge).

6. **Tooltip content**: What should hover show?
   - Recommendation: Full branch name + breakdown (e.g., "3 modified, 1 staged, 2 untracked").
