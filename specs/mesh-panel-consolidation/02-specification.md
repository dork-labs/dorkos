---
slug: mesh-panel-consolidation
number: 233
created: 2026-04-11
status: specified
authors:
  - Claude Code
ideation: specs/mesh-panel-consolidation/01-ideation.md
---

# Consolidate Mesh Panel into Agents Page

## Status

Specified

## Overview

Eliminate the MeshPanel dialog by migrating its unique functionality — Denied view, Access view, and AgentHealthDetail split-pane — to the dedicated `/agents` page. Redirect all dialog entry points (command palette, status card, feature promo, URL deep-link) to page navigation. Remove the dialog and its infrastructure.

After this change, `/agents` becomes the single surface for all agent and mesh management. The MeshPanel dialog, its wrapper, and all associated state (Zustand `meshOpen`, `useMeshDeepLink`, `DispatcherStore.meshOpen`) are deleted.

## Background / Problem Statement

The app has two overlapping surfaces for agent/mesh management:

1. **MeshPanel dialog** — opened from command palette, dashboard status card, feature promo, and `?mesh=open` URL deep-links. Contains 4 tabs: Topology, Discovery, Denied, Access. Includes AgentHealthDetail side panel on topology node click.
2. **`/agents` page** — dedicated route with 2 views: List (sortable DataTable) and Topology (React Flow graph). Header has "Search for Projects" button opening DiscoveryView dialog.

They share the same `TopologyGraph` component and `useTopology()` hook but differ in what else they offer. The dialog has Denied and Access tabs the page lacks; the page has a DataTable with filters the dialog lacks.

This split-brain UX forces users to guess which surface has what. A dialog with 4 tabs, a topology graph, and a detail panel has outgrown the modal pattern (per NN/Group guidance and industry precedent from Linear, GitHub, Vercel).

**Related ADRs:**

- ADR 0166 (proposed): "Remove MeshPanel Agents Tab for Clean Separation" — already proposed removing agent list from MeshPanel. This spec completes that trajectory by removing the entire dialog.
- ADR 0038 (proposed): "Progressive Disclosure Mode A/B for Feature Panels" — the Mode A/B pattern is preserved on the Agents page.
- ADR 0065 (archived): "Lift Dialogs to Root-Level DialogHost" — the DialogHost registry pattern that will have the mesh entry removed.
- ADR 0165 (proposed): "Dense List Over Cards for Agent Fleet Display" — existing list pattern stays unchanged.

## Goals

- Single surface for all agent/mesh management at `/agents`
- Migrate Denied and Access views to the Agents page as new view modes
- Wire AgentHealthDetail split-pane into the topology view on the Agents page
- Redirect all MeshPanel entry points to page navigation
- Remove MeshPanel dialog and all its infrastructure
- Preserve Mode A/B progressive disclosure pattern
- No regressions in existing List and Topology views

## Non-Goals

- Redesigning the Agents page layout or existing views
- Changing underlying mesh entity hooks or transport layer
- Modifying the onboarding flow (AgentDiscoveryStep is separate)
- Unifying the discovery system (separate spec: `unify-discovery-system`)
- Adding MeshStatsHeader to the Agents page (filter bar + status column provide equivalent info)

## Technical Dependencies

- **TanStack Router** — Zod-validated search params for view state (`@tanstack/react-router`)
- **motion/react** — AnimatePresence crossfade between views, layout animation for split-pane
- **React Flow** — Topology graph (existing, `@xyflow/react`)
- **Shadcn UI** — Tabs, Select, Drawer, Badge, Button (existing in `shared/ui`)
- **Zustand** — App store panel state (removing `meshOpen`)

All dependencies are already in use. No new packages required.

## Detailed Design

### 1. Extend Route Search Schema

**File:** `apps/client/src/router.tsx`

Extend `agentsSearchSchema` to support 4 view modes plus an optional `agent` param for the topology detail panel:

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

Add `beforeLoad` to the root route or agents route to redirect legacy `?mesh=open` deep-links:

```typescript
// In agentsRoute or rootRoute beforeLoad:
beforeLoad: ({ search }) => {
  // Legacy mesh deep-link redirect handled by mergeDialogSearch cleanup
  // The mesh param is stripped and user lands on /agents
};
```

Alternatively, handle in `mergeDialogSearch` itself — if `?mesh=open` is present on the `/agents` route, strip it silently. If on a non-agents route, redirect to `/agents`.

### 2. Update AgentsHeader View Switcher

**File:** `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`

Extend `ViewMode` type and add 4-tab view switcher with 2+2 visual grouping:

```typescript
type ViewMode = 'list' | 'topology' | 'denied' | 'access';

interface AgentsHeaderProps {
  viewMode: ViewMode;
}
```

**Tab bar structure:** Primary group (List, Topology) visually separated from management group (Denied, Access) by a subtle `border-l` separator. Management tabs render with `text-muted-foreground opacity-60` when prerequisites are not met:

- Denied tab: muted when 0 registered agents (no agents = nothing to deny)
- Access tab: muted when fewer than 2 namespaces (single-namespace = no cross-project rules)

The prerequisite data comes from `useTopology()` which AgentsPage already fetches — pass a `prerequisites` prop or co-locate the query.

**Mobile responsive:** Below 640px (`sm:` breakpoint), collapse the tab bar to a `<Select>` dropdown with all 4 view options. Reuse the existing `Select` from `@/layers/shared/ui`.

```tsx
{
  /* Desktop: tab bar */
}
<div className="hidden items-center gap-1 sm:flex">
  {/* Primary group */}
  <TabButton view="list" icon={List} label="List" />
  <TabButton view="topology" icon={Globe} label="Topology" />
  {/* Separator */}
  <div className="mx-1 h-4 border-l" />
  {/* Management group */}
  <TabButton view="denied" icon={ShieldBan} label="Denied" muted={!hasAgents} />
  <TabButton view="access" icon={Lock} label="Access" muted={namespacesCount < 2} />
</div>;

{
  /* Mobile: select dropdown */
}
<div className="sm:hidden">
  <Select
    value={viewMode}
    onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, view: v }) })}
  >
    ...
  </Select>
</div>;
```

### 3. Update AppShell Header Slot

**File:** `apps/client/src/AppShell.tsx` (lines 97-105)

Extend the `/agents` case in `useHeaderSlot()` to pass all 4 view modes:

```typescript
case '/agents': {
  const viewParam = new URLSearchParams(searchStr).get('view');
  const viewMode = (['list', 'topology', 'denied', 'access'] as const).includes(viewParam as any)
    ? (viewParam as ViewMode)
    : 'list';
  return {
    key: 'agents',
    content: <AgentsHeader viewMode={viewMode} />,
    borderStyle: undefined,
  };
}
```

### 4. Create DeniedView Component

**New file:** `apps/client/src/layers/features/agents-list/ui/DeniedView.tsx`

Port the inline `DeniedTab` from `MeshPanel.tsx` (lines 20-61) into a standalone component. The component is small (~60 lines) — a direct extraction:

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

**Key difference from MeshPanel's DeniedTab:** This component owns its own data fetching via `useDeniedAgents()` instead of receiving `denied` and `isLoading` as props. This makes it self-contained.

**FSD note:** `DeniedView` imports `MeshEmptyState` from `features/mesh` — this is a same-layer UI composition import, which is allowed per FSD rules. If `MeshEmptyState` is not currently exported from the mesh barrel, add it to `features/mesh/index.ts`.

### 5. Create AccessView Component

**New file:** `apps/client/src/layers/features/agents-list/ui/AccessView.tsx`

Thin wrapper that re-exports the existing `TopologyPanel` from `features/mesh/ui/TopologyPanel.tsx`:

```typescript
import { TopologyPanel } from '@/layers/features/mesh';

/** Access rules view — namespace ACL management. */
export function AccessView() {
  return <TopologyPanel />;
}
```

**Why a wrapper instead of importing TopologyPanel directly in AgentsPage?** The wrapper:

1. Gives us a stable import from `features/agents-list` barrel (co-located with other agent views)
2. Provides a seam to add agents-page-specific behavior later (e.g., different `onGoToDiscovery` handler)
3. Keeps the widget layer importing from a single feature barrel

**TopologyPanel barrel export:** Add `TopologyPanel` to `features/mesh/index.ts` if not already exported.

### 6. Wire AgentHealthDetail Split-Pane into Topology View

**File:** `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx`

When `view=topology`, render `TopologyGraph` alongside an `AgentHealthDetail` split-pane that slides in when a node is selected:

```tsx
// Read agent from URL search params
const { view: viewMode, agent: selectedAgentId } = useSearch({ from: '/_shell/agents' });

// Topology view with optional detail panel
{
  viewMode === 'topology' && (
    <div className="flex h-full">
      <motion.div layout className="min-w-0 flex-1" transition={springTransition}>
        <Suspense fallback={<TopologyFallback />}>
          <LazyTopologyGraph
            onSelectAgent={(agentId, projectPath) =>
              navigate({ search: (prev) => ({ ...prev, agent: agentId }) })
            }
            onOpenSettings={(agentId, projectPath) => openAgentDialog(projectPath)}
            onGoToDiscovery={() => {
              /* open discovery dialog */
            }}
            onOpenChat={(projectPath) => setDir(projectPath)}
          />
        </Suspense>
      </motion.div>
      <AnimatePresence>
        {selectedAgentId && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 256, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={springTransition}
            className="bg-background overflow-y-auto border-l"
          >
            <AgentHealthDetail
              agentId={selectedAgentId}
              onClose={() => navigate({ search: (prev) => ({ ...prev, agent: undefined }) })}
              onOpenSettings={() => openAgentDialog(/* resolve project path */)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

**URL encoding:** The selected agent is stored in `?view=topology&agent=<id>`. Closing the panel navigates to remove the `agent` param. This makes the detail panel state bookmarkable and shareable.

**Mobile:** Below `md` breakpoint, render `AgentHealthDetail` inside a `Drawer` (from `@/layers/shared/ui`) anchored to the bottom instead of a side split-pane. The drawer slides up to ~70% viewport height.

```tsx
const isMobile = useIsMobile();

// In topology view:
{
  isMobile ? (
    <Drawer open={!!selectedAgentId} onOpenChange={(open) => !open && clearAgent()}>
      <DrawerContent>
        <AgentHealthDetail agentId={selectedAgentId!} onClose={clearAgent} />
      </DrawerContent>
    </Drawer>
  ) : (
    <AnimatePresence>{/* Desktop split-pane as above */}</AnimatePresence>
  );
}
```

**Import note:** `AgentHealthDetail` stays in `features/mesh/ui/` — add it to the `features/mesh/index.ts` barrel.

### 7. Update AgentsPage View Rendering

**File:** `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx`

Extend Mode B conditional rendering to handle all 4 views:

```tsx
// Mode B: populated
<AnimatePresence mode="wait">
  {viewMode === 'list' && (
    <motion.div key="list" {...fadeTransition}>
      <AgentsList agents={agents} isLoading={isLoading} />
    </motion.div>
  )}
  {viewMode === 'topology' && (
    <motion.div key="topology" {...fadeTransition} className="h-full">
      {/* Split-pane layout from section 6 */}
    </motion.div>
  )}
  {viewMode === 'denied' && (
    <motion.div key="denied" {...fadeTransition}>
      <DeniedView />
    </motion.div>
  )}
  {viewMode === 'access' && (
    <motion.div key="access" {...fadeTransition}>
      <AccessView />
    </motion.div>
  )}
</AnimatePresence>
```

**Mode A** (no agents) remains unchanged: shows `AgentGhostRows` with discovery CTA. Mode A only triggers when the view is `list` or `topology` — if the URL says `?view=denied` or `?view=access`, always show Mode B (those views have their own empty states).

### 8. Redirect Entry Points

#### 8a. Command Palette Actions

**File:** `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`

Replace `openMesh()` calls with `navigate()`:

```typescript
// Before:
const { open: openMesh } = useMeshDeepLink();
// ...
case 'openMesh': openMesh(); break;
case 'discoverAgents': openMesh(); break;

// After:
const navigate = useNavigate();
// ...
case 'openMesh':
  closePalette();
  navigate({ to: '/agents' });
  break;
case 'discoverAgents':
  closePalette();
  navigate({ to: '/agents' });
  break;
```

Remove the `useMeshDeepLink` import. The `closePalette()` call is already in scope.

**File:** `apps/client/src/layers/features/command-palette/model/palette-contributions.ts`

Update the mesh feature item label for clarity:

```typescript
{ id: 'mesh', label: 'Agents', icon: 'Globe', action: 'openMesh', category: 'feature', priority: 3 }
```

(The action ID `openMesh` stays the same to avoid touching more handler code — only the label changes.)

#### 8b. Dashboard Status Card

**File:** `apps/client/src/layers/features/dashboard-status/ui/SystemStatusRow.tsx`

Replace `meshDeepLink.open()` with `navigate()`:

```typescript
// Before:
const meshDeepLink = useMeshDeepLink();
// ...
onClick={() => meshDeepLink.open()}

// After:
const navigate = useNavigate();
// ...
onClick={() => navigate({ to: '/agents', search: { view: 'topology' } })}
```

Remove `useMeshDeepLink` import.

#### 8c. Feature Promo

**File:** `apps/client/src/layers/features/feature-promos/ui/dialogs/AgentChatDialog.tsx`

```typescript
// Before:
const { open: openMesh } = useMeshDeepLink();
const handleExplore = () => {
  onClose();
  openMesh();
};

// After:
const navigate = useNavigate();
const handleExplore = () => {
  onClose();
  navigate({ to: '/agents' });
};
```

Remove `useMeshDeepLink` import.

#### 8d. Legacy URL Deep-Link Redirect

Handle `?mesh=open` arriving on any route. Two approaches:

**Option A (preferred):** In `mergeDialogSearch`, stop including `mesh` as a dialog param for the agents route. The `?mesh=open` param becomes unknown and is silently dropped by Zod validation.

**Option B:** Add a `beforeLoad` on the root route that checks for `?mesh` and redirects:

```typescript
beforeLoad: ({ location }) => {
  const params = new URLSearchParams(location.searchStr);
  if (params.has('mesh')) {
    throw redirect({ to: '/agents', search: { view: 'topology' } });
  }
};
```

Option A is cleaner — `?mesh=open` simply has no effect after the dialog is removed, and any user clicking an old bookmark lands on whatever page they're on (likely dashboard) where they can navigate to `/agents`.

### 9. Remove Dialog Infrastructure

Execute in this order to minimize broken intermediate states:

**Step 1 — Remove dialog registration:**

- `widgets/app-layout/model/dialog-contributions.ts`: Remove the mesh entry from the contributions array. Remove `MeshDialogWrapper` import.

**Step 2 — Delete dialog wrapper:**

- Delete `widgets/app-layout/model/wrappers/MeshDialogWrapper.tsx`

**Step 3 — Delete MeshPanel:**

- Delete `features/mesh/ui/MeshPanel.tsx`
- Delete `features/mesh/ui/MeshStatsHeader.tsx`

**Step 4 — Remove state infrastructure:**

- `shared/model/app-store/app-store-panels.ts`: Remove `meshOpen: boolean` and `setMeshOpen` from the Zustand slice.
- `shared/model/use-dialog-deep-link.ts`: Remove `useMeshDeepLink()` function.
- `shared/lib/ui-action-dispatcher.ts`: Remove `meshOpen` from `DispatcherStore` interface and the `mesh` entry in the dispatch map.
- `widgets/app-layout/ui/DialogHost.tsx`: Remove mesh-related signal handling if any explicit mesh references exist (the registry-driven approach may already handle this via the removed contribution).

**Step 5 — Update barrel exports:**

- `features/mesh/index.ts`: Remove `MeshPanel` export. Add exports for components now consumed by the Agents page: `TopologyPanel`, `AgentHealthDetail`, `MeshEmptyState` (if not already exported).

**Step 6 — Clean up `mergeDialogSearch`:**

- `shared/model/dialog-search-schema.ts`: Remove `mesh` from the merged dialog params schema.

### 10. Update Barrel Exports

**File:** `apps/client/src/layers/features/agents-list/index.ts`

Add new view exports:

```typescript
export { DeniedView } from './ui/DeniedView';
export { AccessView } from './ui/AccessView';
```

**File:** `apps/client/src/layers/features/mesh/index.ts`

Update exports:

```typescript
// Remove:
export { MeshPanel } from './ui/MeshPanel';

// Add (if not already exported):
export { TopologyPanel } from './ui/TopologyPanel';
export { AgentHealthDetail } from './ui/AgentHealthDetail';
export { MeshEmptyState } from './ui/MeshEmptyState';
```

## User Experience

### Navigation Flow

| User intent           | Before (dialog)                                  | After (page)                                               |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| "Show me my agents"   | Command palette → "Mesh Network" → dialog opens  | Command palette → "Agents" → navigates to `/agents`        |
| "Check mesh topology" | Status card click → dialog opens on Topology tab | Status card click ��� navigates to `/agents?view=topology` |
| "See denied paths"    | Open dialog → click Denied tab                   | Navigate to `/agents?view=denied`                          |
| "Manage access rules" | Open dialog → click Access tab                   | Navigate to `/agents?view=access`                          |
| "Scan for new agents" | "Search for Projects" button → discovery dialog  | Same (unchanged)                                           |
| "View agent health"   | Dialog Topology tab → click node → side panel    | `/agents?view=topology` → click node → split-pane          |

### Tab Bar Behavior

- **Default view:** `list` — the most actionable everyday view
- **4 tabs:** List | Topology | (separator) | Denied | Access
- **Management tabs (Denied, Access)** are visually muted when prerequisites not met
- **Mobile:** Tab bar collapses to a `<Select>` dropdown below 640px
- **URL-driven:** Each tab click updates `?view=` param, enabling bookmarks and browser back/forward

### Agent Health Detail Panel

- **Desktop:** 256px split-pane slides in from right when clicking a topology node. Graph reflows via ResizeObserver. Panel persists across node re-selections. Close via X button or pressing Escape.
- **Mobile:** Bottom-anchored Drawer slides up to ~70% viewport height.
- **URL state:** `?view=topology&agent=<id>` — bookmarkable, shareable.

## Testing Strategy

### New Test Files

**`features/agents-list/__tests__/DeniedView.test.tsx`:**

- Renders loading state (spinner)
- Renders empty state ("No blocked paths" message)
- Renders list of denied paths with denial metadata
- Each denied entry shows path, reason, and deniedBy badge

**`features/agents-list/__tests__/AccessView.test.tsx`:**

- Renders TopologyPanel content (delegates to existing TopologyPanel tests for depth)
- Smoke test that the wrapper mounts without error

### Updated Test Files

**`widgets/agents/__tests__/AgentsPage.test.tsx`:**

- Test all 4 view modes render correct components
- Test Mode A still shows AgentGhostRows for list/topology views
- Test denied/access views render in Mode B even with 0 agents (they have their own empty states)
- Test `?agent=<id>` param opens AgentHealthDetail in topology view

**`features/top-nav/__tests__/AgentsHeader.test.tsx`:**

- Test 4-tab view switcher renders all tabs
- Test management tabs are muted when prerequisites not met
- Test mobile Select dropdown renders on small screens
- Test tab click navigates with correct `?view=` param

**`features/command-palette/__tests__/use-palette-actions.test.tsx`:**

- Update `openMesh` and `discoverAgents` assertions: verify `navigate()` called instead of `openMesh()`
- Remove `useMeshDeepLink` mock

**`features/dashboard-status/__tests__/SystemStatusRow.test.tsx`:**

- Update mesh card click assertion: verify `navigate()` called with `/agents?view=topology`

**`widgets/app-layout/__tests__/DialogHost.test.tsx`:**

- Remove mesh dialog assertion from registry tests

**`shared/model/__tests__/use-dialog-deep-link.test.tsx`:**

- Remove `useMeshDeepLink` tests

### Deleted Test Files

**`features/mesh/__tests__/MeshPanel.test.tsx`** (283 lines): No longer needed. DeniedView and AccessView tests replace the relevant coverage. TopologyGraph tests remain (TopologyGraph is not deleted).

## Performance Considerations

- **No new bundle impact:** DeniedView is ~60 lines, AccessView is a thin wrapper. Both use existing hooks.
- **Code splitting preserved:** TopologyGraph continues to be lazy-loaded via `React.lazy()` + Suspense.
- **Split-pane animation:** The `motion.div` layout animation on the topology container triggers React Flow's built-in ResizeObserver to reflow — no manual resize logic needed. The `spring` transition prevents layout thrashing.
- **Removed overhead:** Deleting the MeshPanel dialog removes ~500 lines of dialog infrastructure + one Zustand slice entry + one URL param watcher from DialogHost.

## Security Considerations

No security implications. All data hooks (`useDeniedAgents`, `useTopology`, `useUpdateAccessRule`) already exist and have the same authorization model whether rendered in a dialog or on a page. No new API endpoints or data exposure.

## Documentation

- Update `AGENTS.md` — the MeshPanel dialog reference in the architecture section should point to `/agents` views instead.
- No new developer guides needed — the pattern follows existing view-switching conventions.

## Implementation Phases

### Phase 1: Add New Views

1. Extend `agentsSearchSchema` with `denied`, `access`, and `agent` params
2. Create `DeniedView` component (extract from MeshPanel.tsx)
3. Create `AccessView` wrapper (imports TopologyPanel)
4. Update `features/mesh/index.ts` barrel to export `TopologyPanel`, `AgentHealthDetail`, `MeshEmptyState`
5. Update `features/agents-list/index.ts` barrel to export `DeniedView`, `AccessView`
6. Update AgentsPage to render 4 views in Mode B
7. Wire AgentHealthDetail split-pane into topology view (desktop + mobile Drawer)
8. Update AgentsHeader with 4-tab switcher (2+2 grouping, mobile Select)
9. Update AppShell header slot to pass new view modes
10. Add tests for DeniedView, AccessView, updated AgentsPage, updated AgentsHeader

### Phase 2: Redirect Entry Points

11. Update command palette actions: `navigate()` instead of `openMesh()`
12. Update palette-contributions label: "Mesh Network" → "Agents"
13. Update dashboard status card: `navigate()` instead of `meshDeepLink.open()`
14. Update feature promo: `navigate()` instead of `meshDeepLink.open()`
15. Handle legacy `?mesh=open` deep-link (remove from mergeDialogSearch)
16. Update entry point tests

### Phase 3: Remove Dialog Infrastructure

17. Remove mesh entry from `dialog-contributions.ts`
18. Delete `MeshDialogWrapper.tsx`
19. Delete `MeshPanel.tsx`
20. Delete `MeshStatsHeader.tsx`
21. Remove `meshOpen`/`setMeshOpen` from app-store-panels
22. Remove `useMeshDeepLink()` from use-dialog-deep-link
23. Remove `meshOpen` from ui-action-dispatcher DispatcherStore
24. Remove `mesh` from dialog search schema
25. Update `features/mesh/index.ts` barrel (remove MeshPanel export)
26. Delete `MeshPanel.test.tsx`, update DialogHost and deep-link tests
27. Update AGENTS.md documentation

## File Manifest

| File                                                      | Action                                                                                        | Phase |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----- |
| `apps/client/src/router.tsx`                              | Modify (extend search schema)                                                                 | 1     |
| `apps/client/src/AppShell.tsx`                            | Modify (header slot)                                                                          | 1     |
| `features/agents-list/ui/DeniedView.tsx`                  | **Create**                                                                                    | 1     |
| `features/agents-list/ui/AccessView.tsx`                  | **Create**                                                                                    | 1     |
| `features/agents-list/index.ts`                           | Modify (add exports)                                                                          | 1     |
| `features/mesh/index.ts`                                  | Modify (add TopologyPanel, AgentHealthDetail, MeshEmptyState exports; later remove MeshPanel) | 1, 3  |
| `widgets/agents/ui/AgentsPage.tsx`                        | Modify (4 views + split-pane)                                                                 | 1     |
| `features/top-nav/ui/AgentsHeader.tsx`                    | Modify (4-tab switcher)                                                                       | 1     |
| `features/agents-list/__tests__/DeniedView.test.tsx`      | **Create**                                                                                    | 1     |
| `features/agents-list/__tests__/AccessView.test.tsx`      | **Create**                                                                                    | 1     |
| `widgets/agents/__tests__/AgentsPage.test.tsx`            | Modify (new view tests)                                                                       | 1     |
| `features/top-nav/__tests__/AgentsHeader.test.tsx`        | Modify (4-tab tests)                                                                          | 1     |
| `features/command-palette/model/use-palette-actions.ts`   | Modify (navigate)                                                                             | 2     |
| `features/command-palette/model/palette-contributions.ts` | Modify (label)                                                                                | 2     |
| `features/dashboard-status/ui/SystemStatusRow.tsx`        | Modify (navigate)                                                                             | 2     |
| `features/feature-promos/ui/dialogs/AgentChatDialog.tsx`  | Modify (navigate)                                                                             | 2     |
| `shared/model/dialog-search-schema.ts`                    | Modify (remove mesh)                                                                          | 2     |
| `features/command-palette/__tests__/*`                    | Modify (navigate assertions)                                                                  | 2     |
| `widgets/app-layout/model/dialog-contributions.ts`        | Modify (remove mesh entry)                                                                    | 3     |
| `widgets/app-layout/model/wrappers/MeshDialogWrapper.tsx` | **Delete**                                                                                    | 3     |
| `features/mesh/ui/MeshPanel.tsx`                          | **Delete**                                                                                    | 3     |
| `features/mesh/ui/MeshStatsHeader.tsx`                    | **Delete**                                                                                    | 3     |
| `shared/model/app-store/app-store-panels.ts`              | Modify (remove meshOpen)                                                                      | 3     |
| `shared/model/use-dialog-deep-link.ts`                    | Modify (remove useMeshDeepLink)                                                               | 3     |
| `shared/lib/ui-action-dispatcher.ts`                      | Modify (remove meshOpen)                                                                      | 3     |
| `widgets/app-layout/ui/DialogHost.tsx`                    | Modify (if explicit mesh refs)                                                                | 3     |
| `features/mesh/__tests__/MeshPanel.test.tsx`              | **Delete**                                                                                    | 3     |
| `shared/model/__tests__/use-dialog-deep-link.test.tsx`    | Modify (remove mesh tests)                                                                    | 3     |
| `widgets/app-layout/__tests__/DialogHost.test.tsx`        | Modify (remove mesh assertions)                                                               | 3     |
| `AGENTS.md`                                               | Modify (update architecture section)                                                          | 3     |

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

- **ADR 0038** — Progressive Disclosure Mode A/B for Feature Panels (preserved)
- **ADR 0065** — Lift Dialogs to Root-Level DialogHost (mesh entry removed)
- **ADR 0165** — Dense List Over Cards for Agent Fleet Display (unchanged)
- **ADR 0166** — Remove MeshPanel Agents Tab for Clean Separation (this spec completes that trajectory)

## References

- Ideation: `specs/mesh-panel-consolidation/01-ideation.md`
- Prior research: `research/20260225_mesh_panel_ux_overhaul.md`
- Prior research: `research/20260226_mesh_topology_elevation.md`
- Prior research: `research/20260303_command_palette_agent_centric_ux.md`
- NN/Group: "Tabs, Used Right" — 5-6 tab upper limit guidance
- TanStack Router: Search Params documentation
