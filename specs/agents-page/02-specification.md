# Agents Page — Dedicated Fleet Management at `/agents`

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-03-20
**Spec Number:** 157
**Ideation:** `specs/agents-page/01-ideation.md`

---

## Overview

Elevate agent management from a tab in the Mesh dialog to a dedicated page at `/agents`. This page becomes the primary fleet management surface — listing registered agents with details, search/filter, discovery scanning (in a dialog), topology toggle (as a tab), and the ability to start or resume agent sessions. The MeshPanel dialog's Agents tab is removed; Mesh becomes focused on Topology, Discovery, Access, and Denied.

## Background / Problem Statement

Currently, agent management lives inside the Mesh dialog as one of five tabs (Topology, Discovery, Agents, Denied, Access). This creates several problems:

1. **Buried access**: Agents — the core entities in DorkOS — are hidden behind a dialog trigger in the sidebar footer. Kai runs 10-20 agents across 5 projects and needs them front-and-center.
2. **Modal context loss**: The Mesh dialog overlays the current page, preventing users from referencing agent details while working in a session.
3. **Cramped layout**: The dialog constrains the agent list, filter bar, and topology graph to a fixed-size overlay. Agents deserve full viewport treatment.
4. **Navigation dead-end**: There's no URL for agents — users can't bookmark, deep-link, or navigate directly to fleet management.

The `dynamic-sidebar-content` spec established the route-aware sidebar/header slot pattern (`useSidebarSlot`, `useHeaderSlot` in AppShell). The Agents page builds on this infrastructure.

## Goals

- Provide a dedicated `/agents` route as the primary agent fleet management surface
- Dense list with progressive disclosure (expandable rows) for 5-50 agents
- Client-side instant filtering by name, description, status, and namespace
- One-click session launch or resume from any agent row
- Topology graph as a tab within the page (full viewport)
- Discovery scanning via a dialog triggered from the page header
- Clean separation: Mesh dialog handles Topology + Discovery + Denied + Access; Agents page handles agent management

## Non-Goals

- Agent creation/editing forms (existing `AgentDialog` from `features/agent-settings` handles this)
- Relay binding configuration from the agents page
- New API endpoints — reuse existing mesh/agent/discovery routes
- Bulk agent operations (multi-select, batch unregister)
- Agent performance metrics or token usage tracking
- Mobile-first layout (responsive but not mobile-optimized)

## Technical Dependencies

All dependencies are already in the project — no new packages required.

| Dependency               | Version | Usage                                                        |
| ------------------------ | ------- | ------------------------------------------------------------ |
| `@tanstack/react-router` | ^1.x    | Code-based route definition                                  |
| `@tanstack/react-query`  | ^5.x    | Server state via entity hooks                                |
| `motion/react`           | ^12.x   | AnimatePresence, stagger animations                          |
| `lucide-react`           | ^0.x    | Icons (Users, Search, ChevronDown, etc.)                     |
| `zod`                    | ^3.x    | Search param validation                                      |
| Shadcn UI (shared/ui)    | n/a     | Tabs, Badge, Button, Input, Popover, Collapsible, ScrollArea |

## Detailed Design

### Architecture

The Agents page follows FSD layer conventions:

```
layers/
├── widgets/agents/                    # Page-level composition
│   ├── ui/AgentsPage.tsx              # Main page component (tabs, Mode A/B)
│   └── index.ts                       # Barrel export
├── features/agents-list/              # Agent list feature module
│   ├── ui/AgentRow.tsx                # Dense list row with expand
│   ├── ui/AgentFilterBar.tsx          # Search + status chips + namespace
│   ├── ui/AgentsList.tsx              # List container with grouping
│   ├── ui/SessionLaunchPopover.tsx    # Session picker popover
│   └── index.ts                       # Barrel export
└── features/top-nav/
    └── ui/AgentsHeader.tsx            # Page header (added to existing module)
```

### Data Flow

```
DashboardSidebar "Agents" click
  → navigate({ to: '/agents' })
  → AppShell useSidebarSlot() returns DashboardSidebar (key: 'agents')
  → AppShell useHeaderSlot() returns AgentsHeader (key: 'agents')
  → AgentsPage renders via <Outlet />

AgentsPage mount
  → useRegisteredAgents() fires TanStack Query
  → 0 agents → Mode A: full-bleed DiscoveryView (same as MeshPanel)
  → N agents → Mode B: AgentsList with AgentFilterBar

Filter bar interaction
  → Client-side filter on agent array (useMemo)
  → Status chips toggle: All | Active | Inactive | Stale
  → Namespace dropdown: visible only when >1 namespace
  → No API calls — all client-side at 5-50 scale

"Scan for Agents" button (in AgentsHeader)
  → Opens ResponsiveDialog containing DiscoveryView
  → Register candidates → invalidate agents query → refetch

"Start Session" / "Open Session" button (in AgentRow)
  → No active sessions: navigate({ to: '/session', search: { dir: agent.projectPath } })
  → Has active sessions: Popover lists sessions with Resume + New Session

Topology tab
  → Lazy-loads TopologyGraph via Suspense
  → Same component as MeshPanel topology
```

### File Changes

**New files:**

| File                                               | Layer   | Purpose                                                        |
| -------------------------------------------------- | ------- | -------------------------------------------------------------- |
| `widgets/agents/ui/AgentsPage.tsx`                 | widget  | Page component — Tabs (Agents / Topology), Mode A/B            |
| `widgets/agents/index.ts`                          | widget  | Barrel export                                                  |
| `features/agents-list/ui/AgentRow.tsx`             | feature | Dense expandable agent row                                     |
| `features/agents-list/ui/AgentFilterBar.tsx`       | feature | Search input + status chips + namespace dropdown               |
| `features/agents-list/ui/AgentsList.tsx`           | feature | List container with namespace grouping                         |
| `features/agents-list/ui/SessionLaunchPopover.tsx` | feature | Session picker popover                                         |
| `features/agents-list/index.ts`                    | feature | Barrel export                                                  |
| `features/top-nav/ui/AgentsHeader.tsx`             | feature | Page header: title + "Scan for Agents" + CommandPaletteTrigger |

**Modified files:**

| File                                                 | Change                                                   |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `router.tsx`                                         | Add `/agents` route under `appShellRoute`                |
| `AppShell.tsx`                                       | Add `/agents` case to `useSidebarSlot` + `useHeaderSlot` |
| `features/dashboard-sidebar/ui/DashboardSidebar.tsx` | Add "Agents" as third nav item                           |
| `features/mesh/ui/MeshPanel.tsx`                     | Remove "Agents" tab + `AgentsTab` inline component       |
| `features/top-nav/index.ts`                          | Export `AgentsHeader`                                    |

### Component Specifications

#### AgentsPage (`widgets/agents/ui/AgentsPage.tsx`)

Top-level page rendered by the `/agents` route. Two modes:

**Mode A (zero agents, not loading, no error):**

- Full-bleed `DiscoveryView` with `fullBleed` prop — same pattern as MeshPanel
- AnimatePresence cross-fade between Mode A and Mode B

**Mode B (has agents):**

- `Tabs` component with two tabs: "Agents" (default) and "Topology"
- "Agents" tab renders `AgentsList`
- "Topology" tab renders lazy-loaded `TopologyGraph` via `Suspense`

**Error state:**

- Same error UI as MeshPanel — error icon, message, retry button

```tsx
// Simplified structure
function AgentsPage() {
  const { data, isLoading, isError, refetch } = useRegisteredAgents();
  const agents = data?.agents ?? [];
  const hasAgents = agents.length > 0;
  const isModeA = !hasAgents && !isLoading && !isError;

  if (isError) return <AgentsErrorState onRetry={refetch} />;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {isModeA ? (
        <motion.div key="mode-a" ...><DiscoveryView fullBleed /></motion.div>
      ) : (
        <motion.div key="mode-b" ...>
          <Tabs defaultValue="agents">
            <TabsList><TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="topology">Topology</TabsTrigger></TabsList>
            <TabsContent value="agents"><AgentsList agents={agents} isLoading={isLoading} /></TabsContent>
            <TabsContent value="topology"><Suspense ...><LazyTopologyGraph /></Suspense></TabsContent>
          </Tabs>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

#### AgentRow (`features/agents-list/ui/AgentRow.tsx`)

Dense list item with expandable details. Uses `Collapsible` from shared/ui.

**Collapsed state (~56px):**

- Health/status dot: `size-2 rounded-full` — green (`bg-emerald-500`) for active, amber (`bg-amber-500`) for inactive, gray (`bg-muted-foreground/30`) for stale
- Agent name: `text-sm font-medium`
- Runtime badge: `<Badge variant="secondary">{agent.runtime}</Badge>`
- Project path: `text-muted-foreground text-xs font-mono truncate max-w-[200px]` — shows last 2 segments
- Active session count: `<Badge variant="outline">{count} active</Badge>` (only when count > 0)
- Capability badges: max 3 shown, `"+N more"` overflow badge
- Last active: relative timestamp (`"2m ago"`, `"1h ago"`, `"Mar 15"`)
- Action button: `SessionLaunchPopover` trigger
- Chevron: rotates 180deg on expand

**Expanded state (~120px additional):**

- Full description
- All capabilities (full badge list)
- Behavior config: response mode, escalation threshold
- Budget limits: max hops, max calls per hour
- Registration date + registeredBy
- Namespace (if set)
- Edit button (opens `AgentDialog`) + Unregister button (with confirmation)

**Health status derivation:**

- Active: agent has been seen within the last 5 minutes (from `useMeshAgentHealth`)
- Inactive: agent exists but hasn't been seen recently
- Stale: agent registered but never seen, or not seen in >1 hour

```tsx
interface AgentRowProps {
  agent: AgentManifest;
  sessionCount: number;
  healthStatus: 'active' | 'inactive' | 'stale';
  lastActive: string | null;
}
```

#### AgentFilterBar (`features/agents-list/ui/AgentFilterBar.tsx`)

Filter controls above the agent list. All filtering is client-side.

- **Search input**: `<Input />` with search icon, placeholder "Filter agents...", instant filtering on `name`, `description`, and `capabilities` fields
- **Status chips**: Toggle group — All (default) | Active | Inactive | Stale. Mutually exclusive. Use `Button` with `variant="outline"` and active state styling
- **Namespace dropdown**: `<Select />` — only rendered when agents span >1 namespace. Options: "All namespaces" (default) + each unique namespace
- **Result count**: `<span className="text-muted-foreground text-xs">{count} agents</span>` — updates instantly
- **Group-by toggle**: Flat list (default for single namespace) or grouped by namespace (default when >1 namespace). Simple toggle button

```tsx
interface AgentFilterBarProps {
  agents: AgentManifest[];
  onFilterChange: (filtered: AgentManifest[]) => void;
}
```

The filter bar manages its own state internally and calls `onFilterChange` with the filtered result whenever any filter changes. The parent `AgentsList` passes the full array and receives the filtered subset.

#### AgentsList (`features/agents-list/ui/AgentsList.tsx`)

List container that renders `AgentRow` components with optional namespace grouping.

- Receives `agents` array and `isLoading` flag
- Uses `AgentFilterBar` to filter the array
- When grouped by namespace: renders namespace headers (`text-2xs tracking-widest uppercase text-muted-foreground`) with agent rows underneath
- Loading state: skeleton rows (3 placeholder rows with pulse animation)
- Stagger animation: `motion.div` with staggerChildren for list items on initial render

```tsx
interface AgentsListProps {
  agents: AgentManifest[];
  isLoading: boolean;
}
```

#### SessionLaunchPopover (`features/agents-list/ui/SessionLaunchPopover.tsx`)

Handles session launch from an agent row.

**No active sessions:**

- Button label: "Start Session"
- Click navigates directly: `navigate({ to: '/session', search: { dir: agent.projectPath } })`
- No popover shown

**Has active sessions:**

- Button label: "Open Session" with badge showing count
- Click opens `Popover` listing active sessions:
  - Each row: session ID (truncated) + last message preview + relative elapsed time
  - Click "Resume" navigates: `navigate({ to: '/session', search: { session: id } })`
  - "New Session" button at bottom navigates: `navigate({ to: '/session', search: { dir: agent.projectPath } })`

Session data comes from `useSessions()` hook (entities/session), filtered by matching `dir`/`projectPath`.

```tsx
interface SessionLaunchPopoverProps {
  agent: AgentManifest;
}
```

#### AgentsHeader (`features/top-nav/ui/AgentsHeader.tsx`)

Page header rendered in the AppShell header slot for the `/agents` route.

- Page title: "Agents" (`text-sm font-medium`)
- "Scan for Agents" button: `<Button variant="outline" size="sm">` with `ScanSearch` icon — opens `ResponsiveDialog` containing `DiscoveryView`
- `CommandPaletteTrigger` on the right side (same as other headers)

```tsx
export function AgentsHeader() {
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  return (
    <>
      <span className="text-sm font-medium">Agents</span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setDiscoveryOpen(true)}>
          <ScanSearch className="mr-1.5 size-3.5" /> Scan for Agents
        </Button>
        <CommandPaletteTrigger />
      </div>
      <ResponsiveDialog open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <DiscoveryView />
      </ResponsiveDialog>
    </>
  );
}
```

### Route + Sidebar + AppShell Integration

**router.tsx** — Add `/agents` route:

```tsx
const agentsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/agents',
  component: lazy(() => import('@/layers/widgets/agents').then((m) => ({ default: m.AgentsPage }))),
});

// Update route tree
const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([indexRoute, sessionRoute, agentsRoute]),
]);
```

Note: The `AgentsPage` import can use either static or lazy import. Lazy is preferred since most users won't visit `/agents` on every session — reduces initial bundle.

**AppShell.tsx** — Update slot hooks:

```tsx
function useSidebarSlot(): SidebarSlot {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  switch (pathname) {
    case '/':
      return { key: 'dashboard', body: <DashboardSidebar /> };
    case '/agents':
      return { key: 'agents', body: <DashboardSidebar /> };
    default:
      return { key: 'session', body: <SessionSidebar /> };
  }
}

function useHeaderSlot(...): HeaderSlot {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  switch (pathname) {
    case '/':
      return { key: 'dashboard', content: <DashboardHeader />, borderStyle: undefined };
    case '/agents':
      return { key: 'agents', content: <AgentsHeader />, borderStyle: undefined };
    default:
      return { key: 'session', content: <SessionHeader ... />, borderStyle: ... };
  }
}
```

**DashboardSidebar.tsx** — Add "Agents" nav item:

```tsx
<SidebarMenuItem>
  <SidebarMenuButton
    isActive={pathname === '/agents'}
    onClick={() => navigate({ to: '/agents' })}
    className="..."
  >
    <Users className="size-(--size-icon-sm)" />
    Agents
  </SidebarMenuButton>
</SidebarMenuItem>
```

The sidebar needs access to `pathname` to highlight the active item. Use `useRouterState` to read the current pathname.

### MeshPanel Agents Tab Removal

Remove from `MeshPanel.tsx`:

1. The `AgentsTab` component (lines 22-55 currently)
2. The inline `AgentCard` component (lines 57-88)
3. The `<TabsTrigger value="agents">Agents</TabsTrigger>` trigger
4. The `<TabsContent value="agents">` content

MeshPanel tabs become: Topology | Discovery | Denied | Access.

The `AgentCard` component in `features/mesh/ui/AgentCard.tsx` (separate file) is **not removed** — it stays as-is since the new `AgentRow` in `features/agents-list/` is a different component designed for the dense list pattern.

### Existing Hooks Reused

| Hook                     | Source                   | Purpose                         |
| ------------------------ | ------------------------ | ------------------------------- |
| `useRegisteredAgents()`  | `entities/mesh`          | Fetch all registered agents     |
| `useUnregisterAgent()`   | `entities/mesh`          | Unregister mutation             |
| `useMeshStatus()`        | `entities/mesh`          | Fleet summary stats             |
| `useMeshAgentHealth(id)` | `entities/mesh`          | Per-agent health data           |
| `useTopology()`          | `entities/mesh`          | Topology graph data             |
| `useDiscoveryScan()`     | `entities/discovery`     | Discovery scanning              |
| `useDiscoveryStore()`    | `entities/discovery`     | Discovery Zustand store         |
| `useSessions()`          | `entities/session`       | Session list for launch popover |
| `useNavigate()`          | `@tanstack/react-router` | Navigation                      |

## User Experience

### Entry Points

1. **DashboardSidebar**: "Agents" link — primary navigation
2. **Dashboard Mesh card**: Status card linking to `/agents` (added by dashboard-content spec)
3. **URL**: Direct navigation to `/agents` (bookmarkable)
4. **Command palette**: "Go to Agents" action (existing palette infrastructure)

### User Journeys

**Kai — Fleet check (daily ritual):**

1. Opens DorkOS → lands on Dashboard
2. Clicks "Agents" in sidebar → sees dense list with health dots
3. Scans for stale agents (gray dots) — one agent hasn't been active
4. Clicks "Open Session" on his frontend agent → sees 2 active sessions → resumes the latest
5. Total time: ~10 seconds from Dashboard to productive session

**Kai — Onboarding new project:**

1. Navigates to `/agents` → sees existing agents
2. Clicks "Scan for Agents" in header → discovery dialog opens
3. Adds scan root for new project → discovers 2 agents
4. Registers both → dialog closes → list updates with new agents
5. Clicks "Start Session" on new agent → navigates to `/session`

**Priya — Architecture review:**

1. Navigates to `/agents` → switches to "Topology" tab
2. Views agent relationship graph across namespaces
3. Clicks an agent node → sees health detail panel
4. Switches back to "Agents" tab → expands an agent row for full config
5. Clicks "Edit" → AgentDialog opens for settings adjustment

### Zero-State (Mode A)

When no agents are registered, the page shows a full-bleed DiscoveryView — the same pattern used by MeshPanel's Mode A. This provides immediate onboarding guidance rather than an empty list.

### Error State

When the mesh API is unreachable, display an error panel with retry button — identical pattern to MeshPanel's current error handling.

## Testing Strategy

### Unit Tests

Each new component gets a co-located test file:

**`features/agents-list/__tests__/AgentRow.test.tsx`**

- Renders collapsed row with all visible fields (name, runtime badge, path, capabilities)
- Expands on chevron click, revealing full details
- Shows "Start Session" when no active sessions
- Shows "Open Session" with badge when sessions exist
- Calls unregister mutation on unregister button click
- Truncates capabilities at 3 with "+N more" badge

**`features/agents-list/__tests__/AgentFilterBar.test.tsx`**

- Filters agents by text input (matches name, description, capabilities)
- Filters by status chip selection (Active/Inactive/Stale)
- Shows namespace dropdown only when >1 namespace exists
- Updates result count on filter change
- Resets filters when "All" chip is selected

**`features/agents-list/__tests__/AgentsList.test.tsx`**

- Renders loading skeleton when isLoading
- Renders agent rows for each agent
- Groups by namespace when >1 namespace and grouping enabled
- Shows flat list for single namespace

**`features/agents-list/__tests__/SessionLaunchPopover.test.tsx`**

- Navigates directly when no active sessions
- Shows popover with session list when sessions exist
- Resume click navigates to /session?session={id}
- New Session click navigates to /session?dir={path}

**`widgets/agents/__tests__/AgentsPage.test.tsx`**

- Mode A: renders DiscoveryView when zero agents
- Mode B: renders tab UI when agents exist
- Error state: renders retry button
- Tab switching between Agents and Topology
- Topology tab lazy-loads with Suspense fallback

**`features/top-nav/__tests__/AgentsHeader.test.tsx`**

- Renders page title "Agents"
- Opens discovery dialog on button click
- Renders CommandPaletteTrigger

**Modified test files:**

- `features/mesh/__tests__/MeshPanel.test.tsx` — Remove tests for Agents tab; verify 4-tab layout
- `features/dashboard-sidebar/__tests__/DashboardSidebar.test.tsx` — Add test for Agents nav item + active state

### Integration Tests

- Navigation: clicking "Agents" in sidebar navigates to `/agents` route
- Discovery flow: scan → register → agent appears in list
- Session launch: clicking "Start Session" navigates to `/session` with correct params

### Mocking Strategy

- Mock `Transport` via `TransportProvider` with `createMockTransport()` from `@dorkos/test-utils`
- Mock TanStack Router navigation with `vi.mock('@tanstack/react-router')`
- Use `QueryClientProvider` wrapper for TanStack Query hooks
- Mock `useSessions` response for `SessionLaunchPopover` tests

## Performance Considerations

- **Lazy-loaded topology**: `TopologyGraph` is already lazy-loaded via `React.lazy` + `Suspense` — only fetched when the Topology tab is activated
- **Client-side filtering**: No API calls for filter operations. `useMemo` on the filtered array prevents re-computation on unrelated re-renders
- **Stale time**: `useRegisteredAgents` has `staleTime: 30_000` — avoids refetching on every tab switch
- **Route-level code splitting**: The `AgentsPage` widget can be lazy-imported in `router.tsx` to keep it out of the initial bundle
- **Agent scale**: Designed for 5-50 agents. At this scale, client-side filtering and rendering are negligible. No virtualization needed.

## Security Considerations

- No new API endpoints — reuses existing mesh/agent/discovery routes with their existing auth
- Agent unregister requires confirmation UI (not a single-click destructive action)
- Session navigation respects existing session locking via `X-Client-Id`
- No new permissions or access control changes

## Documentation Updates

After implementation:

- `contributing/project-structure.md` — Add `widgets/agents/` and `features/agents-list/` modules
- `contributing/architecture.md` — Update route table with `/agents`
- `AGENTS.md` — Update Routing section to include `/agents` → AgentsPage
- `contributing/browser-testing.md` — Add `AgentsPage` POM if E2E tests are added later

## Implementation Phases

### Phase 1: Core Components (no routing dependency)

Create the agent list feature module with all pure components:

1. **AgentRow** — Dense expandable row with health dot, agent details, capability badges
2. **AgentFilterBar** — Search input, status chips, namespace dropdown, result count
3. **AgentsList** — List container with namespace grouping and loading state
4. **SessionLaunchPopover** — Session picker with resume/new options
5. **agents-list/index.ts** — Barrel export

Tests: Unit tests for each component.

### Phase 2: AgentsPage Widget + AgentsHeader

Compose the page from Phase 1 components:

1. **AgentsPage** — Tabs (Agents/Topology), Mode A/B, error state
2. **AgentsHeader** — Page title, "Scan for Agents" button, discovery dialog, CommandPaletteTrigger
3. **widgets/agents/index.ts** — Barrel export
4. **top-nav/index.ts** — Export AgentsHeader

Tests: Unit tests for AgentsPage and AgentsHeader.

### Phase 3: MeshPanel Cleanup

Remove the Agents tab from MeshPanel:

1. Remove `AgentsTab` inline component and `AgentCard` inline component
2. Remove "Agents" tab trigger and content
3. MeshPanel becomes: Topology | Discovery | Denied | Access
4. Update MeshPanel tests

### Phase 4: Route + Sidebar + AppShell Integration (LAST)

**Order these tasks last to avoid conflicts with dashboard-content sidebar work currently in progress.**

1. Add `/agents` route to `router.tsx`
2. Update `AppShell.tsx` `useSidebarSlot()` — add `/agents` case returning DashboardSidebar
3. Update `AppShell.tsx` `useHeaderSlot()` — add `/agents` case returning AgentsHeader
4. Update `DashboardSidebar.tsx` — add "Agents" as third nav item with active state
5. Update DashboardSidebar tests

## Open Questions

1. **Agent health thresholds** — What defines "active" vs "inactive" vs "stale"? The current `useMeshAgentHealth` hook returns health data, but the threshold boundaries (5 min for active, 1 hour for stale) need confirmation from the health heartbeat implementation.
   - Recommendation: Read the heartbeat implementation to derive thresholds rather than hardcoding arbitrary values.

2. **Session matching for launch popover** — The `useSessions()` hook returns all sessions. Matching sessions to an agent requires filtering by `projectPath` / working directory. Confirm the session data includes a `cwd` or `dir` field that maps to `agent.projectPath`.
   - Recommendation: Inspect the session schema to confirm the matching field exists.

## Related ADRs

- **ADR-0154**: Adopt TanStack Router for client routing — code-based routes under pathless `_shell` layout
- **ADR-0155**: Replace nuqs with TanStack Router search params
- **ADR-0156**: Code-based routing over file-based
- **ADR-0157**: Pathless layout route for AppShell

## References

- `specs/agents-page/01-ideation.md` — Ideation document with research findings and decisions
- `research/20260320_agents_page_ux_patterns.md` — UX pattern research (dense list, filter bar, session launch)
- `research/20260226_agents_first_class_entity.md` — Agent elevation research
- `research/20260225_mesh_panel_ux_overhaul.md` — Mesh panel UX research
- `specs/dynamic-sidebar-content/02-specification.md` — Prerequisite: route-aware sidebar/header slots
- `specs/dashboard-content/02-specification.md` — Companion: dashboard overview with Mesh status card linking to `/agents`
- `contributing/architecture.md` — Hexagonal Transport architecture
- `contributing/project-structure.md` — FSD layer organization
