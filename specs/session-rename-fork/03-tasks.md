# Session Rename & Fork — Task Breakdown

**Spec**: `specs/session-rename-fork/02-specification.md`
**Generated**: 2026-04-13
**Mode**: Full

---

## Phase 1: Shared Primitives

### Task 1.1 — Update useLongPress hook to support pointer events

**Size**: Small | **Priority**: High | **Dependencies**: None

Update the existing `useLongPress` hook at `shared/model/use-long-press.ts` to use pointer events (`onPointerDown`, `onPointerUp`, `onPointerLeave`, `onPointerCancel`) instead of touch events. Add `e.button !== 0` guard for primary-pointer filtering. The barrel already exports this hook.

**Files**: `apps/client/src/layers/shared/model/use-long-press.ts`

---

### Task 1.2 — Create ResponsiveContextMenu shared primitive

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1

Create `shared/ui/responsive-context-menu.tsx` following the exact pattern of `responsive-dropdown-menu.tsx`. Desktop path delegates to Radix ContextMenu (right-click). Mobile path delegates to Vaul Drawer (long-press via `useLongPress`). Exports: `ResponsiveContextMenu`, `ResponsiveContextMenuTrigger`, `ResponsiveContextMenuContent`, `ResponsiveContextMenuItem`, `ResponsiveContextMenuSeparator`.

**Files**: `apps/client/src/layers/shared/ui/responsive-context-menu.tsx` (new)

---

### Task 1.3 — Export ResponsiveContextMenu from shared/ui barrel

**Size**: Small | **Priority**: High | **Dependencies**: 1.2

Add the five ResponsiveContextMenu exports to `shared/ui/index.ts` after the existing ResponsiveDropdownMenu block.

**Files**: `apps/client/src/layers/shared/ui/index.ts`

---

### Task 1.4 — Update SessionContextMenu to use ResponsiveContextMenu

**Size**: Small | **Priority**: High | **Dependencies**: 1.3

Pure component-name swap in `SessionContextMenu.tsx` — replace `ContextMenu*` imports with `ResponsiveContextMenu*` imports. JSX structure and conditional logic stay identical.

**Files**: `apps/client/src/layers/entities/session/ui/SessionContextMenu.tsx`

---

## Phase 2: Optimistic Rename Hook

### Task 2.1 — Create useRenameSession optimistic mutation hook

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1

Create `entities/session/model/use-rename-session.ts` wrapping `useMutation` with optimistic cache update for session title. On mutate: cancel queries, snapshot cache, apply optimistic title. On error: rollback + toast. On settled: invalidate. Export from `entities/session/index.ts`.

**Files**: `apps/client/src/layers/entities/session/model/use-rename-session.ts` (new), `apps/client/src/layers/entities/session/index.ts`

---

### Task 2.2 — Refactor SessionSidebar to use useRenameSession hook

**Size**: Small | **Priority**: High | **Dependencies**: 2.1

Replace the manual try/catch `handleRenameSession` in `SessionSidebar` with `useRenameSession(selectedCwd).mutate()`. Import `useRenameSession` from `entities/session`. Keep `handleForkSession` unchanged.

**Files**: `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

---

## Phase 3: Dashboard Sidebar Wiring

### Task 3.1 — Wire rename and fork handlers through DashboardSidebar to AgentListItem

**Size**: Medium | **Priority**: Medium | **Dependencies**: 1.4, 2.1

Add `onForkSession` and `onRenameSession` optional props to `AgentListItemProps`. Add fork handler (inline useCallback with transport + toast) and rename handler (via useRenameSession) in DashboardSidebar. Pass both to all AgentListItem instances (pinned + unpinned). In AgentListItem, forward to SessionRow as `onFork`/`onRename`.

**Files**: `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx`, `apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx`

---

### Task 3.2 — Update AgentListItem tests for rename and fork prop propagation

**Size**: Small | **Priority**: Medium | **Dependencies**: 3.1

Update SessionRow mock to capture `onFork`/`onRename` via data attributes. Add `onForkSession`/`onRenameSession` to `buildProps`. Add 5 new tests verifying prop propagation and callback invocation.

**Files**: `apps/client/src/layers/features/dashboard-sidebar/__tests__/AgentListItem.test.tsx`

---

## Phase 4: Agent Hub Wiring

### Task 4.1 — Wire rename and fork handlers in SessionsTab for Agent Hub

**Size**: Medium | **Priority**: Medium | **Dependencies**: 1.4, 2.1 | **Parallel with**: 3.1

Add fork handler (transport.forkSession + setActiveSession + toast) and rename handler (useRenameSession) to SessionsTab. Pass both to SessionsView. Add imports for useTransport, useQueryClient, toast, useRenameSession.

**Files**: `apps/client/src/layers/features/agent-hub/ui/tabs/SessionsTab.tsx`

---

## Dependency Graph

```
1.1 (useLongPress) ──> 1.2 (ResponsiveContextMenu) ──> 1.3 (barrel) ──> 1.4 (SessionContextMenu)
                                                                              │
2.1 (useRenameSession) ──> 2.2 (SessionSidebar refactor)                     │
        │                                                                     │
        ├──────────────────────────────────────> 3.1 (AgentListItem) ──> 3.2 (tests)
        │                                                    ▲
        └──────────────────────────────────────> 4.1 (SessionsTab)
                                                 (parallel with 3.1)
```

## Parallel Opportunities

- **1.1** and **2.1** can run in parallel (no shared dependencies)
- **3.1** and **4.1** can run in parallel (both depend on 1.4 + 2.1, but modify different features)

## Critical Path

1.1 -> 1.2 -> 1.3 -> 1.4 -> 3.1 -> 3.2 (longest chain)
