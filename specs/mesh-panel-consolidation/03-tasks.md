# Mesh Panel Consolidation — Task Breakdown

**Spec:** `specs/mesh-panel-consolidation/02-specification.md`
**Generated:** 2026-04-11
**Mode:** Full

---

## Phase 1: Add New Views

### Task 1.1 — Extend route search schema and AppShell header slot

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

**Goal:** Add `denied`, `access`, and `agent` params to the agents route search schema and update the AppShell header slot to recognize all 4 view modes.

**File 1:** `apps/client/src/router.tsx`

At line 64, the current `agentsSearchSchema` only supports 2 views:

```typescript
const agentsSearchSchema = mergeDialogSearch(
  z
    .object({
      view: z.enum(['list', 'topology']).optional().default('list'),
      sort: z.string().optional().default('lastSeen:desc'),
    })
    .merge(agentFilterSchema.searchValidator)
);
```

Replace the `view` enum and add an `agent` param:

```typescript
const agentsSearchSchema = mergeDialogSearch(
  z
    .object({
      view: z.enum(['list', 'topology', 'denied', 'access']).optional().default('list'),
      sort: z.string().optional().default('lastSeen:desc'),
      agent: z.string().optional(), // selected agent ID for topology detail panel
    })
    .merge(agentFilterSchema.searchValidator)
);
```

**File 2:** `apps/client/src/AppShell.tsx`

At line 97-105, the `useHeaderSlot` function's `/agents` case currently resolves viewMode to only `list` or `topology`:

```typescript
case '/agents': {
  const viewParam = new URLSearchParams(searchStr).get('view');
  const viewMode = viewParam === 'topology' ? 'topology' : 'list';
  return {
    key: 'agents',
    content: <AgentsHeader viewMode={viewMode} />,
    borderStyle: undefined,
  };
}
```

Replace the viewMode resolution to support all 4 values:

```typescript
case '/agents': {
  const viewParam = new URLSearchParams(searchStr).get('view');
  const validViews = ['list', 'topology', 'denied', 'access'] as const;
  const viewMode = validViews.includes(viewParam as any)
    ? (viewParam as ViewMode)
    : 'list';
  return {
    key: 'agents',
    content: <AgentsHeader viewMode={viewMode} />,
    borderStyle: undefined,
  };
}
```

**Acceptance Criteria:**

- `?view=denied` and `?view=access` are valid search params on the `/agents` route
- `?agent=some-id` is a valid optional search param on the `/agents` route
- The AppShell header slot correctly passes `denied` and `access` view modes to `AgentsHeader`
- Invalid view values fall back to `'list'`

---

### Task 1.2 — Update mesh barrel exports

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

**Goal:** Export `TopologyPanel`, `AgentHealthDetail`, and `MeshEmptyState` from the mesh feature barrel.

**File:** `apps/client/src/layers/features/mesh/index.ts`

Current barrel:

```typescript
export { MeshPanel } from './ui/MeshPanel';
export { DiscoveryView } from './ui/DiscoveryView';
export { ScanRootInput } from '@/layers/entities/discovery';
```

Add the three new exports:

```typescript
/**
 * Mesh feature — agent discovery, registry, and observability UI.
 *
 * Exports topology and health components for composition on the Agents page,
 * plus discovery components. Internal components (TopologyGraph, AgentNode,
 * CandidateCard, AgentCard, RegisterAgentDialog, BindingDialog, AdapterNode,
 * BindingEdge, etc.) remain encapsulated.
 *
 * @module features/mesh
 */
export { MeshPanel } from './ui/MeshPanel';
export { DiscoveryView } from './ui/DiscoveryView';
export { TopologyPanel } from './ui/TopologyPanel';
export { AgentHealthDetail } from './ui/AgentHealthDetail';
export { MeshEmptyState } from './ui/MeshEmptyState';
export { ScanRootInput } from '@/layers/entities/discovery';
```

**Acceptance Criteria:**

- `TopologyPanel` is importable from `@/layers/features/mesh`
- `AgentHealthDetail` is importable from `@/layers/features/mesh`
- `MeshEmptyState` is importable from `@/layers/features/mesh`
- Existing imports continue to work

---

### Task 1.3 — Create DeniedView component and tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 1.4

**Goal:** Extract the inline `DeniedTab` from `MeshPanel.tsx` into a standalone `DeniedView` component that owns its own data fetching.

**File 1 (Create):** `apps/client/src/layers/features/agents-list/ui/DeniedView.tsx`

```typescript
import { Loader2, ShieldCheck } from 'lucide-react';
import { useDeniedAgents } from '@/layers/entities/mesh';
import { MeshEmptyState } from '@/layers/features/mesh';
import { Badge } from '@/layers/shared/ui';

/** Denied agents view — shows blocked paths with denial metadata. */
export function DeniedView() {
  const { data: deniedResult, isLoading } = useDeniedAgents();
  const denied = deniedResult?.denied ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (denied.length === 0) {
    return (
      <MeshEmptyState
        icon={ShieldCheck}
        headline="No blocked paths"
        description="When you deny agent paths during discovery, they appear here. This is a healthy state."
      />
    );
  }

  return (
    <div className="space-y-2 p-4">
      {denied.map((d) => (
        <div key={d.path} className="flex items-center justify-between rounded-xl border px-4 py-3">
          <div>
            <p className="font-mono text-sm">{d.path}</p>
            {d.reason && <p className="text-muted-foreground text-xs">{d.reason}</p>}
          </div>
          <Badge variant="outline" className="text-xs">
            {d.deniedBy}
          </Badge>
        </div>
      ))}
    </div>
  );
}
```

**File 2 (Create):** `apps/client/src/layers/features/agents-list/__tests__/DeniedView.test.tsx`

Tests cover: loading state (spinner), empty state ("No blocked paths"), list rendering with metadata, null reason handling.

**Acceptance Criteria:**

- Loading spinner renders when `useDeniedAgents` is loading
- `MeshEmptyState` with "No blocked paths" renders when denied array is empty
- Each denied entry shows path, optional reason, and deniedBy badge
- All tests pass

---

### Task 1.4 — Create AccessView component and tests

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 1.3

**Goal:** Create a thin wrapper that re-exports `TopologyPanel` from `features/mesh`.

**File 1 (Create):** `apps/client/src/layers/features/agents-list/ui/AccessView.tsx`

```typescript
import { TopologyPanel } from '@/layers/features/mesh';

/** Access rules view — namespace ACL management. */
export function AccessView() {
  return <TopologyPanel />;
}
```

**File 2 (Create):** `apps/client/src/layers/features/agents-list/__tests__/AccessView.test.tsx`

Smoke test confirming the wrapper mounts and renders TopologyPanel.

**Acceptance Criteria:**

- `AccessView` renders `TopologyPanel` from `@/layers/features/mesh`
- Smoke test passes

---

### Task 1.5 — Update agents-list barrel exports

**Size:** Small | **Priority:** High | **Dependencies:** 1.3, 1.4 | **Parallel with:** None

**Goal:** Export `DeniedView` and `AccessView` from the agents-list feature barrel.

**File:** `apps/client/src/layers/features/agents-list/index.ts`

Add two new exports:

```typescript
export { DeniedView } from './ui/DeniedView';
export { AccessView } from './ui/AccessView';
```

**Acceptance Criteria:**

- `DeniedView` is importable from `@/layers/features/agents-list`
- `AccessView` is importable from `@/layers/features/agents-list`
- Existing exports continue to work

---

### Task 1.6 — Update AgentsHeader with 4-tab view switcher

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** None

**Goal:** Extend from 2-tab (List, Topology) to 4-tab switcher with 2+2 visual grouping and mobile Select dropdown.

**File:** `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`

Changes:

1. Extend `ViewMode` type: `'list' | 'topology' | 'denied' | 'access'`
2. Replace `VIEW_TABS` with `PRIMARY_TABS` (Agents, Topology) and `MANAGEMENT_TABS` (Denied, Access)
3. Add border-l separator between groups in desktop tab bar
4. Add mobile `<Select>` dropdown with all 4 options (shown below `sm:` breakpoint)
5. Import icons: `List`, `Globe`, `ShieldBan`, `Lock` from lucide-react
6. Import `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` from `@/layers/shared/ui`

**Acceptance Criteria:**

- Desktop: 4 tabs visible with separator between Topology and Denied
- Active tab has `bg-background` styling
- Mobile: Select dropdown with all 4 view options
- Tab click calls `navigate({ to: '/agents', search: { view: mode } })`
- Existing buttons unchanged

---

### Task 1.7 — Update AgentsPage to render 4 views with AgentHealthDetail split-pane

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.5 | **Parallel with:** None

**Goal:** Extend AgentsPage from 2-view to 4-view rendering with AgentHealthDetail split-pane in topology view.

**File:** `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx`

Key changes:

1. Add imports for `DeniedView`, `AccessView`, `AgentHealthDetail`, `Drawer`/`DrawerContent`, `useIsMobile`, `useNavigate`, `useOpenAgentDialog`, `useDirectoryState`
2. Read `agent` from search params alongside `view`
3. Update `isModeA` condition: only triggers for list/topology when no agents
4. Extend Mode B `AnimatePresence` to render all 4 views
5. Topology view: add split-pane with `AgentHealthDetail` (desktop: side panel, mobile: Drawer)
6. URL-driven state: `?agent=<id>` controls detail panel, close removes param

**Acceptance Criteria:**

- All 4 view modes render correct components
- `?view=topology&agent=some-id` shows AgentHealthDetail (desktop: split-pane, mobile: Drawer)
- Mode A only activates for list/topology; denied/access always render Mode B
- Closing detail panel removes `?agent=` from URL

---

### Task 1.8 — Update AgentsPage tests for new views

**Size:** Medium | **Priority:** High | **Dependencies:** 1.7 | **Parallel with:** 1.9

**Goal:** Extend AgentsPage tests to cover 4 views and Mode A/B boundary for denied/access.

**File:** `apps/client/src/layers/widgets/agents/__tests__/AgentsPage.test.tsx`

Add mocks for `DeniedView`, `AccessView`, `AgentHealthDetail`, `useIsMobile`, `useNavigate`, `useOpenAgentDialog`, `useDirectoryState`. Extend mockViewMode type. Add test cases for denied view, access view, and Mode B rendering with 0 agents for management views.

**Acceptance Criteria:**

- All 4 view modes tested
- Mode A/B boundary tested (denied/access render in Mode B even with 0 agents)
- Existing tests continue to pass
- At least 10 total tests

---

### Task 1.9 — Update AgentsHeader tests for 4-tab switcher

**Size:** Medium | **Priority:** High | **Dependencies:** 1.6 | **Parallel with:** 1.8

**Goal:** Update AgentsHeader tests for the 4-tab view switcher and mobile Select.

**File:** `apps/client/src/layers/features/top-nav/__tests__/AgentsHeader.test.tsx`

Add tests for: Denied and Access tabs on desktop, separator presence, active styling for new tabs, navigation with new view params, mobile Select rendering.

**Acceptance Criteria:**

- All 4 tabs tested on desktop
- Tab click navigation tested for all views
- Active styling verified for new tabs
- Mobile view hides tab buttons
- Existing tests continue to pass

---

## Phase 2: Redirect Entry Points

### Task 2.1 — Update command palette actions to use navigate

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.7 | **Parallel with:** 2.2, 2.3, 2.4

**Goal:** Replace `openMesh()` calls with `navigate()` to `/agents`, update label from "Mesh Network" to "Agents".

**File 1:** `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`

- Remove `useMeshDeepLink` import
- Replace `openMesh()` with `navigate({ to: '/agents' })` in both `handleFeatureAction` and `handleQuickAction`
- Update dependency arrays

**File 2:** `apps/client/src/layers/features/command-palette/model/palette-contributions.ts`

- Change mesh item label from `'Mesh Network'` to `'Agents'`

**Acceptance Criteria:**

- Command palette "Agents" navigates to `/agents`
- "Import Projects" quick action navigates to `/agents`
- No `useMeshDeepLink` imports remain

---

### Task 2.2 — Update dashboard status card to use navigate

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.7 | **Parallel with:** 2.1, 2.3, 2.4

**Goal:** Replace `meshDeepLink.open()` with `navigate()` in SystemStatusRow.

**File:** `apps/client/src/layers/features/dashboard-status/ui/SystemStatusRow.tsx`

- Remove `useMeshDeepLink` import, add `useNavigate` from `@tanstack/react-router`
- Replace `meshDeepLink.open()` with `navigate({ to: '/agents', search: { view: 'topology' } })`

**Acceptance Criteria:**

- Mesh status card navigates to `/agents?view=topology`
- No `useMeshDeepLink` imports remain
- Tasks/Relay deep-link behavior unchanged

---

### Task 2.3 — Update feature promo to use navigate

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.7 | **Parallel with:** 2.1, 2.2, 2.4

**Goal:** Replace `openMesh()` with `navigate()` in AgentChatDialog.

**File:** `apps/client/src/layers/features/feature-promos/ui/dialogs/AgentChatDialog.tsx`

- Replace `useMeshDeepLink` import with `useNavigate` from `@tanstack/react-router`
- Replace `openMesh()` with `navigate({ to: '/agents' })`

**Acceptance Criteria:**

- "Explore Mesh" button navigates to `/agents`
- Dialog closes before navigating
- No `useMeshDeepLink` imports remain

---

### Task 2.4 — Remove mesh from dialog search schema

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.7 | **Parallel with:** 2.1, 2.2, 2.3

**Goal:** Remove `mesh` param from dialog search schema so `?mesh=open` has no effect.

**File:** `apps/client/src/layers/shared/model/dialog-search-schema.ts`

- Remove `mesh: z.string().optional()` from `dialogSearchSchema`

**Acceptance Criteria:**

- `?mesh=open` is no longer recognized on any route
- `?tasks=open`, `?relay=open`, `?agent=open&agentPath=` continue to work

---

### Task 2.5 — Update entry point tests

**Size:** Large | **Priority:** Medium | **Dependencies:** 2.1, 2.2, 2.3, 2.4 | **Parallel with:** None

**Goal:** Update tests for DialogHost, deep-link, command palette, and status card to reflect mesh dialog removal.

**Files:**

- `apps/client/src/layers/widgets/app-layout/__tests__/DialogHost.test.tsx` — Remove all mesh-related mocks, assertions, and test cases
- `apps/client/src/layers/shared/model/__tests__/use-dialog-deep-link.test.tsx` — Remove `useMeshDeepLink` from parameterized test cases
- Command palette tests (if exist) — Update `openMesh`/`discoverAgents` assertions
- Status card tests (if exist) — Update mesh card click assertions

**Acceptance Criteria:**

- DialogHost tests pass without mesh-related assertions
- Deep-link tests pass without `useMeshDeepLink` test cases
- No references to `useMeshDeepLink`, `mesh-panel`, or `meshOpen` remain in test files

---

## Phase 3: Remove Dialog Infrastructure

### Task 3.1 — Remove dialog registration and delete MeshDialogWrapper, MeshPanel, MeshStatsHeader

**Size:** Medium | **Priority:** Low | **Dependencies:** 2.5 | **Parallel with:** 3.2

**Goal:** Remove mesh dialog entry from contributions and delete the wrapper, panel, and stats header files.

**Files:**

- `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts` — Remove mesh entry and `MeshDialogWrapper` import
- **Delete:** `apps/client/src/layers/widgets/app-layout/model/wrappers/MeshDialogWrapper.tsx`
- **Delete:** `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`
- **Delete:** `apps/client/src/layers/features/mesh/ui/MeshStatsHeader.tsx`

**Acceptance Criteria:**

- `dialog-contributions.ts` has 6 entries (no mesh)
- All 3 files deleted
- No TypeScript errors from dangling imports

---

### Task 3.2 — Remove meshOpen state from Zustand, useMeshDeepLink, and DispatcherStore

**Size:** Medium | **Priority:** Low | **Dependencies:** 2.5 | **Parallel with:** 3.1

**Goal:** Remove all mesh-related state infrastructure.

**Files:**

- `apps/client/src/layers/shared/model/app-store/app-store-panels.ts` — Remove `meshOpen`/`setMeshOpen` from interface and slice creator
- `apps/client/src/layers/shared/model/use-dialog-deep-link.ts` — Remove `useMeshDeepLink` export, update helper type
- `apps/client/src/layers/shared/model/index.ts` — Remove `useMeshDeepLink` from barrel
- `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts` — Remove `meshOpen`/`setMeshOpen` from interface and panel maps

**Acceptance Criteria:**

- `meshOpen`/`setMeshOpen` removed from PanelsSlice
- `useMeshDeepLink` removed from deep-link module and barrel
- `mesh` removed from DispatcherStore and panel maps
- No TypeScript errors

---

### Task 3.3 — Update mesh barrel and delete MeshPanel test

**Size:** Small | **Priority:** Low | **Dependencies:** 3.1 | **Parallel with:** 3.4

**Goal:** Remove `MeshPanel` export from mesh barrel and delete MeshPanel.test.tsx.

**Files:**

- `apps/client/src/layers/features/mesh/index.ts` — Remove `MeshPanel` export line
- **Delete:** `apps/client/src/layers/features/mesh/__tests__/MeshPanel.test.tsx`

**Acceptance Criteria:**

- `MeshPanel` no longer exported from `@/layers/features/mesh`
- `MeshPanel.test.tsx` deleted
- Remaining exports work
- No other file imports `MeshPanel`

---

### Task 3.4 — Update AGENTS.md documentation

**Size:** Small | **Priority:** Low | **Dependencies:** 3.1 | **Parallel with:** 3.3

**Goal:** Update AGENTS.md architecture section to reflect `/agents` as the single surface with 4 views.

**File:** `AGENTS.md`

Update the `/agents` route description (line 144) from:

```
- `/agents` → `AgentsPage` (widgets/agents) — fleet management surface. Mode A (no agents): full-bleed `DiscoveryView`. Mode B (agents present): tabbed `AgentsList` + lazy `TopologyGraph`. With `DashboardSidebar` (shared nav, Agents item active) and `AgentsHeader` (Scan for Agents button)
```

To:

```
- `/agents` → `AgentsPage` (widgets/agents) — fleet management surface with 4 views: List (sortable DataTable), Topology (React Flow graph with AgentHealthDetail split-pane), Denied (blocked paths), Access (namespace ACL rules). Mode A (no agents, list/topology only): `AgentGhostRows` with discovery CTA. Mode B: full view rendering. With `DashboardSidebar` (shared nav, Agents item active) and `AgentsHeader` (4-tab switcher + Scan for Agents button)
```

**Acceptance Criteria:**

- `/agents` route description updated to mention 4 views
- No references to MeshPanel dialog remain in AGENTS.md

---

## Summary

| Phase                            | Tasks        | Parallel Opportunities    |
| -------------------------------- | ------------ | ------------------------- |
| 1 — Add New Views                | 9 tasks      | 1.1+1.2, 1.3+1.4, 1.8+1.9 |
| 2 — Redirect Entry Points        | 5 tasks      | 2.1+2.2+2.3+2.4           |
| 3 — Remove Dialog Infrastructure | 4 tasks      | 3.1+3.2, 3.3+3.4          |
| **Total**                        | **18 tasks** |                           |

**Size distribution:** 8 small, 7 medium, 3 large

**Critical path:** 1.2 → 1.3/1.4 → 1.5 → 1.7 → 2.1-2.4 → 2.5 → 3.1/3.2 → 3.3/3.4
