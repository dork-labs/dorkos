---
slug: session-rename-fork
number: 242
created: 2026-04-13
status: ideation
---

# Session Rename & Fork Actions

**Slug:** session-rename-fork
**Author:** Claude Code
**Date:** 2026-04-13
**Branch:** preflight/session-rename-fork

---

## 1) Intent & Assumptions

- **Task brief:** Wire the existing session rename and fork backend operations through to every location where `SessionRow` appears in the client UI. Add a responsive context menu that works on desktop (right-click) and mobile (long-press → bottom drawer). Convert rename to use optimistic updates via `useMutation`.
- **Assumptions:**
  - Backend is fully implemented — no server/API/runtime/SDK changes needed
  - The `SessionRow` component already has `onRename`/`onFork` callback props and inline rename UI in both variants
  - `SessionContextMenu` exists but is desktop-only (Radix ContextMenu)
  - The `ResponsiveDropdownMenu` in `shared/ui/` is the established pattern for desktop-vs-mobile primitives
  - `OverviewTabPanel` will be deprecated soon — skip wiring it
- **Out of scope:**
  - Mid-conversation fork (selecting a specific `upToMessageId`) — always fork full conversation
  - Double-click-to-rename trigger (context menu trigger is sufficient for now)
  - Batch rename / multi-select operations
  - Server-side changes of any kind

---

## 2) Pre-reading Log

- `packages/shared/src/schemas.ts`: `UpdateSessionRequestSchema` (title field), `ForkSessionRequestSchema` (upToMessageId, title) — both exist
- `packages/shared/src/types.ts`: Exports `Session`, `UpdateSessionRequest`, `ForkSessionRequest`
- `packages/shared/src/agent-runtime.ts`: `renameSession()` (line 172), `forkSession()` (lines 146-150) — interface defined
- `apps/server/src/routes/sessions.ts`: `PATCH /api/sessions/:id` (lines 118-163), `POST /api/sessions/:id/fork` (lines 166-187) — both implemented
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`: `renameSession()` calls SDK + transcript cache
- `apps/server/src/services/runtimes/claude-code/session-store.ts`: `forkSession()` delegates to SDK
- `apps/client/src/layers/shared/lib/transport/session-methods.ts`: `updateSession()` (PATCH), `forkSession()` (POST) — both exist
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: `handleForkSession` and `handleRenameSession` already implemented with transport calls
- `apps/client/src/layers/entities/session/ui/SessionContextMenu.tsx`: Desktop-only Radix ContextMenu with Rename + Fork items
- `apps/client/src/layers/entities/session/ui/SessionRowFull.tsx`: Full inline rename UI (isRenaming state, input, committedRef guard)
- `apps/client/src/layers/entities/session/ui/SessionRowCompact.tsx`: Same inline rename pattern in compact variant
- `apps/client/src/layers/shared/ui/responsive-dropdown-menu.tsx`: Established pattern — `useIsMobile()` → DropdownMenu on desktop, Drawer on mobile
- `apps/client/src/layers/shared/ui/responsive-dialog.tsx`: Same pattern for Dialog vs Drawer
- `apps/client/src/layers/shared/model/use-is-mobile.ts`: 768px breakpoint, `matchMedia`-based
- `apps/client/src/layers/features/agent-hub/ui/tabs/SessionsTab.tsx`: Renders `SessionsView` WITHOUT rename/fork handlers
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx`: Renders `SessionRow variant="compact"` — needs handler wiring
- `apps/client/src/layers/features/session-list/ui/OverviewTabPanel.tsx`: No handlers, but being deprecated — skip

---

## 3) Codebase Map

### Primary Components/Modules

| File                                              | Role                                                           |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `entities/session/ui/SessionRow.tsx`              | Public component delegating to Full/Compact variant            |
| `entities/session/ui/SessionRowFull.tsx`          | Full row with border indicator, expand/collapse, inline rename |
| `entities/session/ui/SessionRowCompact.tsx`       | Compact single-line row with dot indicator, inline rename      |
| `entities/session/ui/SessionContextMenu.tsx`      | Right-click context menu (desktop-only, needs mobile)          |
| `features/session-list/ui/SessionSidebar.tsx`     | Owns `handleForkSession` + `handleRenameSession` callbacks     |
| `features/session-list/ui/SessionsView.tsx`       | Presentational list; passes callbacks to SessionRow            |
| `features/agent-hub/ui/tabs/SessionsTab.tsx`      | Agent Hub sessions — missing handler wiring                    |
| `features/dashboard-sidebar/ui/AgentListItem.tsx` | Dashboard sidebar — missing handler wiring for compact rows    |
| `shared/ui/responsive-dropdown-menu.tsx`          | Template pattern for responsive primitive                      |
| `shared/model/use-is-mobile.ts`                   | Mobile detection hook                                          |

### Shared Dependencies

- `@tanstack/react-query` — caching, mutations, optimistic updates
- `sonner` — toast notifications
- `@radix-ui/react-context-menu` — desktop right-click menu
- `vaul` — mobile bottom drawer
- `motion/react` — animations
- `lucide-react` — icons (Pencil, GitFork)

### Data Flow

**Rename:**

```
SessionRow → startRename() → inline input → commitRename()
  → onRename(sessionId, title)
  → SessionSidebar.handleRenameSession()
  → transport.updateSession({ title })
  → PATCH /api/sessions/:id
  → runtime.renameSession()
  → SDK renameSession() + transcriptReader.setCustomTitle()
```

**Fork:**

```
SessionRow → onFork(sessionId)
  → SessionSidebar.handleForkSession()
  → transport.forkSession()
  → POST /api/sessions/:id/fork
  → runtime.forkSession()
  → SDK forkSession()
  → Returns new Session → navigate to it
```

### Potential Blast Radius

- **Direct changes:** 5-6 files (new responsive context menu, update SessionContextMenu, wire AgentListItem, wire SessionsTab, convert to useMutation)
- **New files:** 2 (ResponsiveContextMenu, useLongPress hook)
- **Test updates:** SessionRow tests (context menu mobile tests), AgentListItem tests, possibly SessionSidebar tests
- **No impact:** Server, transport, schemas, types — all untouched

---

## 4) Root Cause Analysis

N/A — not a bug fix.

---

## 5) Research

### Responsive Context Menu

Three approaches were evaluated:

| Approach                                   | Description                                                                                                             | Verdict                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **A: Single component + device detection** | `ResponsiveContextMenu` reads `useIsMobile()`, renders ContextMenu (desktop) or Drawer (mobile) with long-press trigger | **Recommended** — matches existing codebase pattern |
| B: Composition with shared items array     | Caller passes `items: MenuItem[]`; component decides rendering                                                          | Breaks JSX-children API pattern                     |
| C: CSS media query hide/show               | Mount both, CSS hides one                                                                                               | Both mounted in DOM; double-trigger issues          |

**Long-press detection:** Simple `useRef + setTimeout` hook using pointer events API. No new library needed — `onPointerDown` starts a timer, `onPointerUp/Leave/Cancel` clears it. ~20 lines of code.

**Key technical note:** Radix ContextMenu handles long-press natively on touch, but opens a floating menu at pointer position which clips on small screens. The Drawer approach gives a full-width bottom sheet — much better mobile UX.

### Session Fork Semantics

The Claude Agent SDK's `forkSession` creates a **deep copy** — a new session ID with its own JSONL transcript copied up to the fork point. Not a parent-reference model. `handleForkSession` in `SessionSidebar` already calls the transport, invalidates the query, and navigates to the forked session.

### Optimistic Rename Updates

Current pattern: `transport.updateSession()` → `queryClient.invalidateQueries()` → visible latency.

Better pattern with `useMutation`:

```ts
onMutate: optimistically update queryClient.setQueryData(['sessions'])
onError: rollback to previous data
onSettled: always invalidateQueries to reconcile
```

This gives instant title change in the UI with automatic rollback on failure.

### Mobile Accessibility

- Touch targets: minimum 44×44 CSS pixels (WCAG 2.5.5)
- Vaul Drawer handles `aria-modal`, focus trapping, close-on-overlay
- Long-press trigger needs `aria-label="Open actions"`
- Must not rely solely on long-press — the existing context menu items (visible on right-click) provide an alternative trigger path

---

## 6) Decisions

| #   | Decision                                 | Choice                                                               | Rationale                                                                                 |
| --- | ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Responsive context menu approach         | **Approach A** — single component with device detection              | Matches existing `ResponsiveDropdownMenu` and `ResponsiveDialog` patterns in the codebase |
| 2   | Which consumers get rename/fork          | **SessionsTab (Agent Hub)** and **AgentListItem** only               | OverviewTabPanel is being deprecated soon — skip it                                       |
| 3   | Optimistic updates for rename            | **Yes** — convert `handleRenameSession` to `useMutation`             | Eliminates visible latency; rollback on error provides safety net                         |
| 4   | Additional rename trigger (double-click) | **Skip for now**                                                     | Context menu "Rename" is sufficient; can add double-click later if users request it       |
| 5   | Fork scope                               | **Full conversation only** (no `upToMessageId`)                      | Keeps initial implementation simple; mid-conversation branching is a future enhancement   |
| 6   | Inline rename UI                         | **Already implemented** in both SessionRowFull and SessionRowCompact | No new UI work needed — just ensure the `onRename` callbacks are wired through            |
