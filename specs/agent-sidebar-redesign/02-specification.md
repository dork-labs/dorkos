---
slug: agent-sidebar-redesign
---

# Specification: Agent Sidebar Redesign

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-04-11
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## 1. Overview

The agent sidebar redesign replaces the LRU-ordered, capped (MAX_AGENTS=8) agent list in the DashboardSidebar with a stable, scrollable, full-roster view. The list is sorted alphabetically with an optional "Pinned" section at the top for user-chosen favorites. Every agent row gains a right-click / long-press context menu (with a persistent `...` action button on mobile) surfacing pin, manage, edit settings, and new session actions. Dot-style activity badges derived from the existing `useAgentHottestStatus` hook replace the current left-border-only approach for collapsed agents, making activity glanceable without opening an agent. A `+` button in the "AGENTS" group header opens a popover for agent creation, project import, and Dork Hub browsing.

The redesign directly targets five problems identified in the ideation phase: spatial instability from LRU reordering on every navigation, discoverability failure (only 8 of 22+ agents visible), no pinning or favorites mechanism, the Session Sidebar being unreachable for agents with three or fewer sessions, and no glanceable activity indicator on collapsed agents. All eleven decisions from the ideation document are resolved and carried forward here without modification.

This spec covers state management additions to the Zustand app store, four new UI components, significant rewrites of `DashboardSidebar.tsx` and `AgentListItem.tsx`, one new constant, and corresponding test updates. No new npm dependencies are required; all primitives (ContextMenu, SidebarMenuAction, SidebarMenuBadge, SidebarGroupAction) are already installed and exported from `@/layers/shared/ui`.

---

## 2. Background / Problem Statement

### Spatial Instability

`setSelectedCwd` in `apps/client/src/layers/shared/model/app-store/app-store.ts` prepends the selected path to `recentCwds` and persists it to localStorage. `DashboardSidebar.tsx` then builds the displayed list as `[defaultAgentPath, ...recent].slice(0, MAX_AGENTS)`. The result: every agent selection reshuffles the visible list. Users cannot build positional memory because positions are not stable — violating the fundamental UX principle that adaptive interfaces that restructure layouts break spatial memory (NN/Group research cited in ideation).

### Discoverability Cap

`MAX_AGENTS = 8` limits the list to eight agents regardless of fleet size. The pre-reading log documents 22+ agents in common deployments. Fourteen or more agents are permanently invisible in the sidebar unless navigated to via CMD+K.

### No Pinning Mechanism

There is no way to promote a specific agent above others. The "default agent" concept (`config.agents.defaultAgent`) exists but it is a single slot and is config-driven, not user-adjustable from the sidebar.

### Session Sidebar Inaccessible

The "Sessions" drill-down button in `AgentListItem.tsx` only renders when `totalSessionCount > MAX_PREVIEW_SESSIONS` (i.e., > 3 sessions). Agents with zero to three sessions have no path to the full Session Sidebar from the dashboard. The `setSidebarLevel('session')` action exists on the store but has no reachable trigger for these agents.

### No Glanceable Activity on Collapsed Agents

`useAgentHottestStatus` is already called in `AgentListItem` and drives the left-border color and pulse animation. However, when the agent row is collapsed (the majority of the time), the narrow 2px left border is the only signal. At sidebar scale this is low-contrast and easy to miss. A dot badge positioned visibly within the row would provide a much stronger glanceable signal.

---

## 3. Goals

- Eliminate LRU reordering: the displayed agent list order never changes as a result of navigation
- Show all discovered agents (from `useMeshAgentPaths`) with no count cap
- Provide a "Pinned" section that persists user-chosen agents at the top, in pin order
- Auto-pin the default agent on first install so the list is non-empty for new users
- Add a right-click / long-press context menu on each agent row with four actions: Pin/Unpin, Manage agent, Edit settings, New session
- Add an always-visible `...` action button on mobile (hover-revealed on desktop) that opens the same context menu
- Add dot-style activity badges (green/amber/red/no-dot) derived from `useAgentHottestStatus`, positioned within the row and visible when collapsed
- Add a `+` button to the "AGENTS" group header opening a popover with Create agent, Import project, and Browse Dork Hub actions
- Implement progressive empty state: onboarding card for 1-2 agents, text link for 3-4 agents, nothing for 5+
- Maintain all existing behaviors: expand/collapse, session preview, session click, new session from expanded view, border pulse animation

---

## 4. Non-Goals

- Custom named sections (Slack-style user-created groups)
- Drag-to-reorder agents
- Muting or hiding individual agents
- Server-side persistence of pin state
- Inline search or filter in the sidebar
- Frecency-based sidebar ordering (frecency remains CMD+K only)
- Count badges (v2 consideration per Decision 6)
- Any changes to the Session Sidebar (`features/session-list/`) beyond the navigation entry point
- Changes to the `AgentSessionPreview` component

---

## 5. Technical Dependencies

| Dependency              | Version              | Purpose                                                                 |
| ----------------------- | -------------------- | ----------------------------------------------------------------------- |
| `radix-ui`              | ^1.4.3 (installed)   | `ContextMenu` primitives via `context-menu.tsx` in `shared/ui`          |
| `zustand`               | ^5.0.12 (installed)  | `pinnedAgentPaths` state in app store core slice                        |
| `motion`                | ^12.38.0 (installed) | Existing border pulse animations — no new usage                         |
| `lucide-react`          | 0.576.0 (installed)  | `MoreHorizontal`, `Pin`, `PinOff`, `Plus`, `Settings`, `ListTree` icons |
| `@tanstack/react-query` | ^5.96.1 (installed)  | `useMeshAgentPaths` query already uses this                             |

No new npm dependencies are required. `ContextMenu`, `SidebarMenuAction`, `SidebarMenuBadge`, and `SidebarGroupAction` are all already exported from `apps/client/src/layers/shared/ui/index.ts`.

---

## 6. Detailed Design

### 6.1 State: `pinnedAgentPaths` in the App Store Core Slice

**Files to modify:**

- `apps/client/src/layers/shared/lib/constants.ts` — add storage key
- `apps/client/src/layers/shared/model/app-store/app-store.ts` — implement initializer and actions

#### New constant

```typescript
// apps/client/src/layers/shared/lib/constants.ts
export const STORAGE_KEYS = {
  // ... existing keys ...
  PINNED_AGENTS: 'dorkos-pinned-agents',
} as const;
```

#### CoreSlice extension

```typescript
// New fields on the CoreSlice
interface CoreSlice {
  // ... existing fields ...
  /** Ordered list of agent paths pinned by the user. Persisted to localStorage. */
  pinnedAgentPaths: string[];
  /** Pin an agent. Appends to end of pinned list if not already pinned. */
  pinAgent: (path: string) => void;
  /** Remove an agent from the pinned list. No-op if not pinned. */
  unpinAgent: (path: string) => void;
}
```

#### Store implementation

```typescript
pinnedAgentPaths: (() => {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.PINNED_AGENTS) || '[]'
    );
    return Array.isArray(raw) ? (raw as string[]).filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
})(),

pinAgent: (path) =>
  set((s) => {
    if (s.pinnedAgentPaths.includes(path)) return s;
    const next = [...s.pinnedAgentPaths, path];
    try { localStorage.setItem(STORAGE_KEYS.PINNED_AGENTS, JSON.stringify(next)); } catch {}
    return { pinnedAgentPaths: next };
  }),

unpinAgent: (path) =>
  set((s) => {
    const next = s.pinnedAgentPaths.filter((p) => p !== path);
    try { localStorage.setItem(STORAGE_KEYS.PINNED_AGENTS, JSON.stringify(next)); } catch {}
    return { pinnedAgentPaths: next };
  }),
```

The `resetPreferences` action must also clear `STORAGE_KEYS.PINNED_AGENTS` from localStorage and reset `pinnedAgentPaths` to `[]`.

### 6.2 Component Architecture

```
DashboardSidebar
├── SidebarHeader (unchanged — nav buttons)
└── SidebarContent
    └── SidebarGroup  [Agents section]
        ├── SidebarGroupLabel "AGENTS"
        │   └── SidebarGroupAction → AddAgentMenu popover
        │
        ├── SidebarMenu  [Pinned — conditional on pinnedPaths.length > 0]
        │   ├── SidebarGroupLabel "PINNED" (subordinate, smaller)
        │   └── AgentListItem × pinnedPaths.length
        │       ├── AgentContextMenu (wraps row)
        │       │   └── motion.div [row content]
        │       │       ├── AgentIdentity
        │       │       ├── AgentActivityBadge
        │       │       ├── SidebarMenuAction [... button]
        │       │       └── ChevronRight
        │       └── AnimatePresence [expanded session preview]
        │
        ├── SidebarMenu  [All agents — alphabetical]
        │   └── AgentListItem × allPaths.length
        │       └── (same structure)
        │
        └── AgentOnboardingCard (1-2 agents)
            OR "+ Add agent" text link (3-4 agents)
```

### 6.3 New Component: `AgentActivityBadge`

**File:** `apps/client/src/layers/features/dashboard-sidebar/ui/AgentActivityBadge.tsx`

Renders a small dot indicator conveying aggregate agent activity status. Positioned between agent name and chevron. Hidden when idle.

```typescript
interface AgentActivityBadgeProps {
  status: SessionBorderKind;
  label: string;
}
```

| `SessionBorderKind` | Dot color      | Tailwind class   |
| ------------------- | -------------- | ---------------- |
| `streaming`         | Green          | `bg-green-500`   |
| `active`            | Green          | `bg-green-500`   |
| `pendingApproval`   | Amber          | `bg-amber-500`   |
| `error`             | Red            | `bg-destructive` |
| `unseen`            | Blue           | `bg-blue-500`    |
| `idle`              | (not rendered) | —                |

Dot size: `size-1.5` (6px) — compact but visible, consistent with Calm Tech.

### 6.4 New Component: `AgentContextMenu`

**File:** `apps/client/src/layers/features/dashboard-sidebar/ui/AgentContextMenu.tsx`

Wraps an agent row in a Radix ContextMenu. Desktop: right-click. Mobile: long-press (native Radix behavior).

```typescript
interface AgentContextMenuProps {
  children: ReactNode;
  agentPath: string;
  isPinned: boolean;
  onTogglePin: () => void;
  onManage: () => void;
  onEditSettings: () => void;
  onNewSession: () => void;
}
```

Menu items:

1. Pin agent / Unpin agent (toggles based on `isPinned`)
2. ---separator---
3. Manage agent (ListTree icon)
4. Edit settings (Settings icon)
5. ---separator---
6. New session (Plus icon)

### 6.5 New Component: `AddAgentMenu`

**File:** `apps/client/src/layers/features/dashboard-sidebar/ui/AddAgentMenu.tsx`

Popover triggered by `SidebarGroupAction` (`+` button) in the AGENTS header. Three actions:

- Create agent → `setAgentDialogOpen(true)`
- Import project → `setPickerOpen(true)`
- Browse Dork Hub → `navigate({ to: '/marketplace' })`

Uses existing store actions — no new actions needed.

### 6.6 New Component: `AgentOnboardingCard`

**File:** `apps/client/src/layers/features/dashboard-sidebar/ui/AgentOnboardingCard.tsx`

Inline prompt shown below agent list when fewer than 3 agents exist. Dashed border card with explanation text and CTA. For 3-4 agents, a simpler `+ Add agent` text link is rendered inline in DashboardSidebar (no separate component).

### 6.7 Modified Component: `AgentListItem`

**Updated props interface:**

```typescript
interface AgentListItemProps {
  path: string;
  agent: AgentManifest | null;
  displayName?: string;
  isActive: boolean;
  isExpanded: boolean;
  isPinned: boolean; // NEW
  onSelect: () => void;
  onToggleExpand: () => void;
  onTogglePin: () => void; // NEW
  onManage: () => void; // NEW
  onEditSettings: () => void; // NEW
  sessions: Session[];
  totalSessionCount: number;
  activeSessionId: string | null;
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  onDrillIntoSessions: () => void;
}
```

Changes:

1. Wrap row in `AgentContextMenu`
2. Add `AgentActivityBadge` between identity and chevron
3. Add `SidebarMenuAction` (`...` button) — `showOnHover={!isMobile}` (always visible on mobile)
4. Remove `showDrillDown` gate — "Sessions" button always renders in expanded view
5. Row layout: `[AgentIdentity] [AgentActivityBadge] [SidebarMenuAction] [ChevronRight]`

### 6.8 Modified Component: `DashboardSidebar`

Major changes:

1. Remove `MAX_AGENTS` constant
2. Use `useMeshAgentPaths()` for all agent paths instead of `recentCwds`
3. Build `allPaths` (alphabetical by path segment) and `pinnedPaths` (pin order, filtered to existing mesh paths)
4. Render two-section list: Pinned (conditional) + All (alphabetical)
5. Add `AddAgentMenu` via `SidebarGroupAction`
6. Add progressive empty state
7. Auto-pin default agent on first install (one-time effect)
8. Pass new props to each `AgentListItem`

**Agent path resolution:**

```typescript
const { data: meshPaths } = useMeshAgentPaths();

const allPaths = useMemo(() => {
  const paths = meshPaths ?? [];
  return [...paths].sort((a, b) => {
    const nameA = a.split('/').pop()?.toLowerCase() ?? '';
    const nameB = b.split('/').pop()?.toLowerCase() ?? '';
    return nameA.localeCompare(nameB);
  });
}, [meshPaths]);

const pinnedPaths = useMemo(() => {
  const pathSet = new Set(allPaths);
  return pinnedAgentPaths.filter((p) => pathSet.has(p));
}, [pinnedAgentPaths, allPaths]);
```

**Handlers:**

```typescript
const handleManage = useCallback(
  (path: string) => {
    navigate({ to: '/session', search: { dir: path } });
    setSidebarLevel('session');
  },
  [navigate, setSidebarLevel]
);
```

### 6.9 Data Flow

```
Mesh → useMeshAgentPaths() → allPaths (alphabetical)
                                  │
pinnedAgentPaths (localStorage) ──┤
  filtered to existing paths      │
  → pinnedPaths (pin order)       │
                                  │
Both → useResolvedAgents([...all]) → agents: Record<path, AgentManifest>
                                  │
                      displayNames: Map<path, string> (disambiguation)
                                  │
DashboardSidebar renders:
  [PINNED section — if pinnedPaths.length > 0]
    AgentListItem × pinnedPaths.length
      └─ useAgentHottestStatus → AgentActivityBadge + border
      └─ AgentContextMenu → pin/manage/edit/new

  [ALL section — full alphabetical]
    AgentListItem × allPaths.length
      └─ (same)

  [Progressive empty state — if agentCount <= 4]
```

---

## 7. User Experience

### 7.1 Interaction Patterns

**Agent row click (unchanged):** Inactive → selects + opens recent session. Active → toggles expand/collapse.

**Context menu — desktop:** Right-click opens Radix ContextMenu at cursor.

**Context menu — mobile:** Long-press opens context menu. `...` button always visible, opens same menu.

**Pinning:** "Pin agent" appends to `pinnedAgentPaths`. Agent appears in both Pinned section and alphabetical All section. "Unpin" removes from Pinned section.

**Manage agent:** Navigates to agent + sets `sidebarLevel: 'session'` → Session Sidebar opens. Works for all agents regardless of session count.

**Edit settings:** Opens AgentDialog directly (same as pencil icon in SidebarTabRow).

**Add agent (+):** Opens popover with Create agent, Import project, Browse Dork Hub.

### 7.2 Progressive Empty States

| Agent count | Rendered                             |
| ----------- | ------------------------------------ |
| 0           | Section with onboarding card         |
| 1-2         | Agent rows + onboarding card         |
| 3-4         | Agent rows + "+ Add agent" text link |
| 5+          | Agent rows only (+ button in header) |

### 7.3 Mobile Behavior

- Sidebar renders as `Sheet` on mobile (existing behavior)
- `...` button always visible on mobile via `showOnHover={!isMobile}`
- Long-press context menu fires via Radix pointer event handling
- 44px minimum touch targets via `SidebarMenuAction`'s `after:absolute after:-inset-2` rule
- No layout changes needed — sidebar width and scroll are handled by existing SidebarProvider

### 7.4 Keyboard Navigation

- Enter/Space on agent row: existing activate behavior (preserved)
- Shift+F10 or platform context menu key on focused row: opens ContextMenu (Radix built-in)
- Tab navigation through `...` buttons and menu items (Radix focus management)

---

## 8. Testing Strategy

### 8.1 New Component Tests

**`AgentActivityBadge.test.tsx`:**

- Renders null for idle status
- Renders correct color for each status (streaming, active, pendingApproval, error, unseen)
- Passes aria-label correctly

**`AgentContextMenu.test.tsx`:**

- Shows "Pin agent" / "Unpin agent" based on isPinned
- Calls correct handler for each menu item
- Renders children without opening menu by default

**`AgentOnboardingCard.test.tsx`:**

- Renders CTA button
- Calls onAddAgent on click

**`AddAgentMenu.test.tsx`:**

- Renders + button with aria-label
- Opens popover on click
- Each item triggers correct action

### 8.2 Modified Component Tests

**`AgentListItem.test.tsx` (new tests):**

- Renders activity badge when status is not idle
- Hides badge when idle
- Renders `...` action button
- "Sessions" drill-down always visible in expanded view (not gated by count)

**`DashboardSidebar.test.tsx` (updates):**

- Remove MAX_AGENTS cap test
- Add: renders PINNED section when pins exist
- Add: hides PINNED section when no pins
- Add: renders all agents from mesh (no cap)
- Add: sorts agents alphabetically
- Add: renders onboarding card for 1-2 agents
- Add: renders text link for 3-4 agents
- Add: no prompt for 5+ agents
- Update mocks: add `useMeshAgentPaths` mock, add pin state to store mock

### 8.3 Store Tests

**`app-store-pin.test.ts`:**

- pinAgent adds path and persists to localStorage
- pinAgent is idempotent (no duplicates)
- unpinAgent removes path and persists
- unpinAgent is no-op for unknown paths
- resetPreferences clears pin state
- Hydration from corrupt localStorage falls back to []

---

## 9. Performance Considerations

### Agent List at Scale

`useResolvedAgents` batch query runs once per 60s (staleTime). For 22-50 agents, this is one query — acceptable.

`displayNames` disambiguation iterates all paths twice — O(N \* segment_depth). Negligible for 50 agents.

`useAgentHottestStatus` creates one Zustand subscription per agent row. At 50 rows, 50 subscriptions each scanning a small session subset. Acceptable at current scale. If approaching 100+, consider a single aggregated selector returning `Map<path, SessionBorderState>`.

### Sort Stability

`allPaths` sort runs on stable path segment strings. `meshPaths` data changes only on agent add/remove (refetch every 30s). No debouncing needed.

### localStorage Writes

Pin/unpin writes synchronously. For up to 50 pinned agents, serialized string is under 5KB. No performance concern.

---

## 10. Security Considerations

### localStorage Safety

`pinnedAgentPaths` is read with try/catch + Array.isArray + typeof filter. Corrupt values fall back to `[]`. Same pattern as existing `recentCwds`.

### Path Injection

Paths are rendered as text content via `AgentIdentity`, not innerHTML. Navigation uses TanStack Router's typed `search` params. Server validates paths through agent resolution. No XSS vector.

---

## 11. Documentation

Updates needed after implementation:

- `contributing/design-system.md` — Add `AgentActivityBadge` dot sizing convention (6px = `size-1.5`)
- `specs/agent-sidebar-redesign/03-tasks.md` — Implementation task breakdown (generated by `/spec:decompose`)

No public API changes — this is a client-only UI redesign.

---

## 12. Implementation Phases

### Phase 1: Foundation — State and Constants

- Add `STORAGE_KEYS.PINNED_AGENTS` to constants
- Add `pinnedAgentPaths`, `pinAgent`, `unpinAgent` to CoreSlice
- Implement initializer + actions in app-store
- Update `resetPreferences` to clear pin state
- Write store unit tests

### Phase 2: Stable Ordering and Full Roster

- Import `useMeshAgentPaths` in DashboardSidebar
- Remove `MAX_AGENTS` constant
- Replace `agentPaths` memo with `allPaths` (alphabetical) + `pinnedPaths` (pin order)
- Render two-section list (Pinned + All) with conditional PINNED label
- Implement default-agent auto-pin effect
- Update DashboardSidebar tests

### Phase 3: Context Menu, Activity Badge, and Action Button

- Create `AgentActivityBadge` component + tests
- Create `AgentContextMenu` component + tests
- Update `AgentListItem` props and render (context menu, badge, `...` button)
- Remove `showDrillDown` gate
- Add handlers in DashboardSidebar (togglePin, manage, editSettings)
- Update AgentListItem tests

### Phase 4: Add Agent Button and Progressive Empty State

- Create `AddAgentMenu` component + tests
- Create `AgentOnboardingCard` component + tests
- Add `AddAgentMenu` to SidebarGroup in DashboardSidebar
- Add progressive empty state logic
- Add empty state tests
- Manual QA: long-press on mobile, popover clipping

---

## 13. Open Questions

No blocking open questions. All eleven decisions from ideation are resolved. Minor implementation details to confirm during development:

1. **Popover anchor clipping**: Verify `AddAgentMenu` popover with `side="right"` doesn't clip on narrow sidebar. Fallback: `side="bottom" align="end"`.

2. **Context menu + `...` button shared state**: The `...` button should open the same Radix ContextMenu. Verify ContextMenu supports programmatic `open` prop. If not, use a parallel `DropdownMenu` for the `...` button with the same items.

3. **Sort by display name vs path segment**: v1 sorts by path segment (pre-resolution). Display-name sorting can be added in v2 once names are resolved.

---

## 14. Related ADRs

- **ADR-0002** — FSD layer boundaries: new components in `features/dashboard-sidebar/ui/`, pin state in `shared/model/`
- **ADR-0005** — Zustand for UI state, TanStack Query for server state: pin state → Zustand, agent list → TanStack Query
- **ADR-0067** — Frecency for agent ranking: confirmed CMD+K only, not sidebar
- **ADR-0107** — CSS hidden toggle for sidebar view persistence: `sidebarLevel` toggle preserved, new entry point added via context menu
- **ADR-0116** — Entity-layer Zustand store: pin state in shared app store for cross-feature access

---

## 15. References

- [01-ideation.md](./01-ideation.md) — Full ideation with 11 decisions
- `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx` — Current implementation
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx` — Current agent row
- `apps/client/src/layers/shared/model/app-store/app-store.ts` — Store composition
- `apps/client/src/layers/shared/lib/constants.ts` — Storage keys
- `apps/client/src/layers/entities/session/model/use-agent-hottest-status.ts` — Activity hook
- `apps/client/src/layers/entities/mesh/model/use-mesh-agent-paths.ts` — Agent discovery
- `apps/client/src/layers/shared/ui/sidebar.tsx` — SidebarMenuAction, SidebarGroupAction
- `apps/client/src/layers/shared/ui/context-menu.tsx` — ContextMenu primitives
- `research/20260303_shadcn_sidebar_redesign.md` — Sidebar component patterns
- `contributing/design-system.md` — Calm Tech conventions
