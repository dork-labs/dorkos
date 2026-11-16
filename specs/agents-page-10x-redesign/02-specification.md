---
slug: agents-page-10x-redesign
number: 167
created: 2026-03-22
status: specified
---

# Agents Page 10x Redesign

## Overview

Transform the `/agents` page from a functional data table into a world-class fleet management surface. The core problem: the current `AgentRow` crams 8-9 visual elements (health dot, name, runtime badge, path, session count, capability badges, last active timestamp, session action, chevron) into a single horizontal line, creating information overload. The redesign introduces a two-line card layout, fleet health summary bar, color-coded filters with counts, ghost rows empty state, smooth height animations, and responsive behavior down to 640px.

No backend or API changes are required. All data is already available via `useTopology()` and `useMeshStatus()`.

## Technical Design

### Component Architecture

```
AgentsPage                          # widgets/agents
├── [Mode A: Ghost Rows]
│   └── AgentGhostRows              # features/agents-list (NEW)
│       └── DiscoveryView dialog     # features/mesh (existing)
├── [Mode B: Fleet View]
│   ├── [viewMode === 'list']
│   │   └── AgentsList              # features/agents-list (MODIFIED)
│   │       ├── FleetHealthBar      # features/agents-list (NEW)
│   │       ├── AgentFilterBar      # features/agents-list (MODIFIED)
│   │       ├── AgentEmptyFilterState  # features/agents-list (NEW)
│   │       └── AgentRow × N        # features/agents-list (MODIFIED)
│   │           ├── SessionLaunchPopover  # features/agents-list (existing)
│   │           ├── AgentDialog     # features/agent-settings (existing)
│   │           └── UnregisterAgentDialog  # features/agents-list (NEW)
│   └── [viewMode === 'topology']
│       └── LazyTopologyGraph       # features/mesh (existing, no changes)
└── AgentsHeader                    # features/top-nav (MODIFIED)
    ├── View switcher (Agents | Topology)
    ├── Scan for Agents button
    └── CommandPaletteTrigger
```

Key structural changes:

- **AgentsPage** removes the `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` wrapper entirely. View switching moves to `AgentsHeader` via a `viewMode` URL search param. Mode A renders `AgentGhostRows` instead of `<DiscoveryView fullBleed />`.
- **AgentsHeader** gains `viewMode` and `onViewModeChange` props to render a text-based tab switcher.
- **AgentsList** gains `FleetHealthBar` above the filter bar and `AgentEmptyFilterState` for zero-result filter states.
- **AgentFilterBar** gains color-coded chips with counts, `unreachable` status, and responsive mobile dropdown.
- **AgentRow** restructures to a two-line card layout, replaces inline unregister confirmation with `UnregisterAgentDialog`, and uses `relativeTime()` for timestamps.

### Data Flow

```
useMeshStatus()    ──→ FleetHealthBar ──click──→ onStatusFilter(status)
                                                        │
useTopology()      ──→ agents ──→ AgentsList            ▼
                                   ├── AgentFilterBar ← filterState (local useState)
                                   │     ↑ also set by FleetHealthBar clicks
                                   ├── AgentEmptyFilterState (when filteredAgents.length === 0)
                                   └── AgentRow × N
                                        ├── relativeTime(lastSeenAt)
                                        ├── SessionLaunchPopover ← useSessions()
                                        └── UnregisterAgentDialog ← useUnregisterAgent()

viewMode URL param ──→ AgentsPage ──→ AgentsHeader (display + change handler)
                            │
                            ├── viewMode === 'list'  → AgentsList
                            └── viewMode === 'topology' → LazyTopologyGraph
```

### State Management

| State                     | Location                                     | Mechanism                                                         |
| ------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| `viewMode`                | URL search param `?view=list\|topology`      | TanStack Router `validateSearch` with Zod schema                  |
| `filterState`             | `AgentsList` local `useState`                | Existing pattern; now also settable from `FleetHealthBar` clicks  |
| Agent expand/collapse     | `AgentRow` local `useState` (`open`)         | Existing pattern; unchanged                                       |
| Unregister dialog         | `AgentRow` local `useState` (`dialogOpen`)   | Replaces `confirmUnregister` boolean with dialog open/close state |
| Discovery dialog (header) | `AgentsHeader` local `useState`              | Existing pattern; unchanged                                       |
| Discovery dialog (ghost)  | `AgentGhostRows` local `useState`            | Same ResponsiveDialog pattern as header                           |
| Agent settings dialog     | `AgentRow` local `useState` (`settingsOpen`) | Existing pattern; unchanged                                       |
| Stagger key               | `AgentsList` local `useState`                | New; prevents re-stagger on filter changes per animations.md      |

### Router Changes

Add search params to the `/agents` route in `router.tsx`:

```typescript
// ── Search param schemas ────────────────────────────────────
const agentsSearchSchema = z.object({
  view: z.enum(['list', 'topology']).optional().default('list'),
});

/** Search params available on the `/agents` route. */
export type AgentsSearch = z.infer<typeof agentsSearchSchema>;

// ── Agents fleet management at /agents ──────────────────────
const agentsRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/agents',
  validateSearch: zodValidator(agentsSearchSchema),
  component: AgentsPage,
});
```

This follows the exact pattern established by `sessionSearchSchema` and `dashboardSearchSchema` in the existing router. `AgentsPage` reads the param via `useSearch({ from: '/_shell/agents' })` and writes via `useNavigate()`.

### Responsive Strategy

Three breakpoints:

| Breakpoint | Class prefix  | Behavior                                                                                                     |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| >= 1024px  | `lg:`         | Full experience: all filter chips visible, namespace dropdown, topology tab, two-line card                   |
| 640-1023px | `sm:` / `md:` | Chips visible but smaller, search input takes more width, cards unchanged                                    |
| < 640px    | default       | Compact health bar (dots + counts only), filter dropdown replaces chips, stacked AgentRow, hide Topology tab |

Mobile detection uses the existing `useIsMobile()` hook from `shared/model/use-is-mobile.ts` (breakpoint: 768px). For the 640px breakpoint on filter chips, use Tailwind responsive classes (`hidden sm:flex` / `flex sm:hidden`) rather than JS.

## Implementation Phases

### Phase 1: Core Layout

**Files modified:**

- `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`
- `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx`
- `apps/client/src/layers/features/agents-list/index.ts`

**Files created:**

- `apps/client/src/layers/features/agents-list/ui/FleetHealthBar.tsx`
- `apps/client/src/layers/features/agents-list/ui/UnregisterAgentDialog.tsx`

**Changes:**

1. Restructure `AgentRow` to two-line card layout (Line 1: health dot + name + runtime badge + relative time; Line 2: truncated path + session count + SessionLaunchPopover). Remove capability badges from collapsed state entirely.
2. Import and use `relativeTime()` from `features/mesh/lib/relative-time` for the `lastActive` timestamp display.
3. Replace the inline `confirmUnregister` state + inline confirm/cancel buttons with `UnregisterAgentDialog` using the `AlertDialog` pattern from `shared/ui/alert-dialog`.
4. Add height animation for expand/collapse using `AnimatePresence` + `motion.div` with the `collapseVariants` pattern from `animations.md`.
5. Create `FleetHealthBar` component that reads from `useMeshStatus()` and renders colored dots with clickable counts.
6. Add `FleetHealthBar` above `AgentFilterBar` in `AgentsList`.

### Phase 2: Filter Bar + View Switcher

**Files modified:**

- `apps/client/src/layers/features/agents-list/ui/AgentFilterBar.tsx`
- `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`
- `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx`
- `apps/client/src/router.tsx`

**Changes:**

1. Add `?view=` search param to `/agents` route with Zod schema validation and export `AgentsSearch` type.
2. Update `AgentFilterBar`: color-coded status chips with counts, add `unreachable` to `StatusFilter` type, flexible search input width (`flex-1 min-w-[8rem]` instead of fixed `w-48`), accept `statusCounts` prop for chip count display.
3. Update `AgentsHeader`: add `viewMode` / `onViewModeChange` props, render small text tab switcher ("Agents" | "Topology"), hide on mobile via `useIsMobile()`.
4. Update `AgentsPage`: read `viewMode` from URL search param, remove `Tabs` wrapper, conditionally render `AgentsList` or `LazyTopologyGraph` with `AnimatePresence mode="wait"` crossfade. Mode A renders `AgentGhostRows` instead of `<DiscoveryView fullBleed />`.

### Phase 3: Empty States + Animations

**Files modified:**

- `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx`
- `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`
- `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx`
- `apps/client/src/layers/features/agents-list/index.ts`

**Files created:**

- `apps/client/src/layers/features/agents-list/ui/AgentGhostRows.tsx`
- `apps/client/src/layers/features/agents-list/ui/AgentEmptyFilterState.tsx`

**Changes:**

1. Create `AgentGhostRows` with 3 ghost rows using `border-dashed opacity-20`, skeleton bars matching two-line card layout, centered overlay with "Discover Your Agent Fleet" heading and "Scan for Agents" button that opens `ResponsiveDialog` with `DiscoveryView`.
2. Create `AgentEmptyFilterState` with centered layout, icon, "No agents match your filters" text, and "Clear filters" button.
3. Add health dot pulse CSS `@keyframes` animation for active agents.
4. Fix stagger animation to not re-trigger on filter changes by introducing a `staggerKey` state in `AgentsList` that only changes on mount, not on filter updates (per `animations.md` "Stagger on Open" pattern).

### Phase 4: Responsive + Polish

**Files modified:**

- `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`
- `apps/client/src/layers/features/agents-list/ui/AgentFilterBar.tsx`
- `apps/client/src/layers/features/agents-list/ui/FleetHealthBar.tsx`
- `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`

**Changes:**

1. Mobile stacking for `AgentRow` below 640px: path moves to its own line, session action wraps.
2. Mobile filter dropdown: `useIsMobile()` switches filter chips to a single "Filter" `Select` dropdown with status options.
3. Compact health bar on mobile: dots + counts only, no status labels.
4. Hide Topology tab on mobile in `AgentsHeader` (list-only view).
5. Ensure all interactive elements have minimum 44px touch targets via `min-h-[44px]` or padding.

## Component Specifications

### AgentRow (Modified)

**Props interface** (unchanged):

```typescript
interface AgentRowProps {
  agent: AgentManifest;
  projectPath: string;
  sessionCount: number;
  healthStatus: AgentHealthStatus;
  lastActive: string | null;
}
```

**Collapsed layout (two-line card):**

```
┌─────────────────────────────────────────────────────────────┐
│  ● Agent Name           claude-code              3m ago   ▼ │  ← Line 1
│    ~/projects/my-app    2 active           [Start Session]  │  ← Line 2
└─────────────────────────────────────────────────────────────┘
```

**Line 1 structure:**

```tsx
<div className="flex items-center gap-3">
  {/* Health dot */}
  <span
    className={cn(
      'size-2 shrink-0 rounded-full',
      healthDotClass[healthStatus],
      healthStatus === 'active' && 'animate-health-pulse'
    )}
    aria-label={`Status: ${healthStatus}`}
  />
  {/* Name */}
  <span className="text-sm font-medium">{agent.name}</span>
  {/* Runtime badge */}
  <Badge variant="secondary">{agent.runtime}</Badge>
  {/* Relative time — right-aligned */}
  <span className="text-muted-foreground ml-auto text-xs">{relativeTime(lastActive)}</span>
  {/* Chevron */}
  <ChevronDown
    className={cn(
      'text-muted-foreground size-4 shrink-0 transition-transform duration-200',
      open && 'rotate-180'
    )}
  />
</div>
```

**Line 2 structure:**

```tsx
<div className="flex items-center gap-3 pl-5">
  {/* Truncated path */}
  <span className="text-muted-foreground max-w-[200px] truncate font-mono text-xs">
    {truncatePath(projectPath)}
  </span>
  {/* Active session count */}
  {sessionCount > 0 && <Badge variant="outline">{sessionCount} active</Badge>}
  {/* Spacer */}
  <div className="flex-1" />
  {/* Session action */}
  <div onClick={(e) => e.stopPropagation()}>
    <SessionLaunchPopover projectPath={projectPath} />
  </div>
</div>
```

**Key changes from current:**

- Capabilities removed from collapsed state entirely (shown only in expanded state).
- `lastActive` rendered as `relativeTime(lastActive)` instead of raw ISO string.
- Two lines with clear visual hierarchy instead of one crowded line.
- `pl-5` on Line 2 aligns content under the name (past the health dot).

**Expanded state:**

Uses `AnimatePresence` + `motion.div` with height collapse pattern instead of `Collapsible`:

```typescript
// Module-scope variants (not inline)
const expandVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

const expandTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;
```

```tsx
<AnimatePresence initial={false}>
  {open && (
    <motion.div
      variants={expandVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={expandTransition}
      className="overflow-hidden"
    >
      <div className="space-y-3 pt-3 pb-2">
        {/* Description */}
        {agent.description && <p className="text-muted-foreground text-sm">{agent.description}</p>}
        {/* Capabilities as badges */}
        {agent.capabilities.length > 0 && (
          <div>
            <span className="text-muted-foreground text-xs font-medium">Capabilities</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {agent.capabilities.map((cap) => (
                <Badge key={cap} variant="outline" className="text-xs">
                  {cap}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {/* Two-column config: response mode, budget, namespace */}
        {/* Registration info (smallest text) */}
        <div className="text-muted-foreground text-xs">
          Registered {new Date(agent.registeredAt).toLocaleDateString()} by {agent.registeredBy}
        </div>
        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            onClick={() => setDialogOpen(true)}
          >
            Unregister
          </Button>
        </div>
      </div>
    </motion.div>
  )}
</AnimatePresence>
```

**Unregister action:** The "Unregister" button sets `dialogOpen` to `true`, rendering `<UnregisterAgentDialog>` instead of the current inline confirm/cancel pattern. This removes the `confirmUnregister` state variable entirely.

**Health dot pulse animation:** Add to `index.css`:

```css
@keyframes health-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgb(16 185 129 / 0.4);
  }
  50% {
    box-shadow: 0 0 0 4px rgb(16 185 129 / 0);
  }
}
.animate-health-pulse {
  animation: health-pulse 2s ease-in-out infinite;
}
```

**Responsive (< 640px):** Line 2 wraps — path takes full width, session count and action wrap to a third line:

```tsx
<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-5">
  <span className="text-muted-foreground w-full truncate font-mono text-xs sm:w-auto sm:max-w-[200px]">
    {truncatePath(projectPath)}
  </span>
  {sessionCount > 0 && <Badge variant="outline">{sessionCount} active</Badge>}
  <div className="flex-1" />
  <div onClick={(e) => e.stopPropagation()}>
    <SessionLaunchPopover projectPath={projectPath} />
  </div>
</div>
```

### FleetHealthBar (New)

**File:** `apps/client/src/layers/features/agents-list/ui/FleetHealthBar.tsx`

**Props interface:**

```typescript
import type { MeshStatus } from '@dorkos/shared/mesh-schemas';
import type { StatusFilter } from './AgentFilterBar';

interface FleetHealthBarProps {
  /** Mesh status data with agent counts by health state. */
  status: MeshStatus;
  /** Currently active status filter (to highlight the active segment). */
  activeFilter: StatusFilter;
  /** Callback when a status count is clicked to activate that filter. */
  onStatusFilter: (status: StatusFilter) => void;
}
```

**Layout:**

```tsx
<div className="flex items-center gap-4 px-4 py-2">
  {/* Status segments — only render when count > 0 */}
  {status.activeCount > 0 && (
    <button
      className={cn(
        'flex items-center gap-1.5 text-xs transition-colors',
        activeFilter === 'active' ? 'text-foreground font-medium' : 'text-muted-foreground'
      )}
      onClick={() => onStatusFilter(activeFilter === 'active' ? 'all' : 'active')}
    >
      <span className="size-2 rounded-full bg-emerald-500" />
      <span className="tabular-nums">{status.activeCount}</span>
      <span className="hidden sm:inline">Active</span>
    </button>
  )}
  {status.inactiveCount > 0 && (
    <button
      className={cn(
        'flex items-center gap-1.5 text-xs transition-colors',
        activeFilter === 'inactive' ? 'text-foreground font-medium' : 'text-muted-foreground'
      )}
      onClick={() => onStatusFilter(activeFilter === 'inactive' ? 'all' : 'inactive')}
    >
      <span className="size-2 rounded-full bg-amber-500" />
      <span className="tabular-nums">{status.inactiveCount}</span>
      <span className="hidden sm:inline">Inactive</span>
    </button>
  )}
  {status.staleCount > 0 && (
    <button
      className={cn(
        'flex items-center gap-1.5 text-xs transition-colors',
        activeFilter === 'stale' ? 'text-foreground font-medium' : 'text-muted-foreground'
      )}
      onClick={() => onStatusFilter(activeFilter === 'stale' ? 'all' : 'stale')}
    >
      <span className="bg-muted-foreground/30 size-2 rounded-full" />
      <span className="tabular-nums">{status.staleCount}</span>
      <span className="hidden sm:inline">Stale</span>
    </button>
  )}
  {status.unreachableCount > 0 && (
    <button
      className={cn(
        'flex items-center gap-1.5 text-xs transition-colors',
        activeFilter === 'unreachable' ? 'text-foreground font-medium' : 'text-muted-foreground'
      )}
      onClick={() => onStatusFilter(activeFilter === 'unreachable' ? 'all' : 'unreachable')}
    >
      <span className="size-2 rounded-full bg-red-500" />
      <span className="tabular-nums">{status.unreachableCount}</span>
      <span className="hidden sm:inline">Unreachable</span>
    </button>
  )}
  {/* Spacer */}
  <div className="flex-1" />
  {/* Total count */}
  <span className="text-muted-foreground text-xs tabular-nums">
    {status.totalAgents} agent{status.totalAgents !== 1 ? 's' : ''}
  </span>
</div>
```

**Behavior:**

- Clicking a count toggles that status filter. If the filter is already active, clicking again resets to `'all'`.
- The active filter segment gets `text-foreground font-medium`; inactive segments get `text-muted-foreground`.
- On mobile (< 640px), status labels are hidden via `hidden sm:inline`; only dots + counts show.
- `tabular-nums` on all count values prevents layout shifts when counts change during polling.

### AgentFilterBar (Modified)

**Updated props interface:**

```typescript
export type StatusFilter = 'all' | 'active' | 'inactive' | 'stale' | 'unreachable';

export interface FilterState {
  searchQuery: string;
  statusFilter: StatusFilter;
  namespaceFilter: string;
}

interface AgentFilterBarProps {
  agents: AgentManifest[];
  filterState: FilterState;
  onFilterStateChange: (state: FilterState) => void;
  filteredCount: number;
  /** Counts per status for chip badges. From useMeshStatus(). */
  statusCounts?: {
    active: number;
    inactive: number;
    stale: number;
    unreachable: number;
  };
}
```

**Status chip color mapping:**

```typescript
const statusChipColors: Record<Exclude<StatusFilter, 'all'>, string> = {
  active: 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
  inactive: 'border-amber-500/30 text-amber-600 dark:text-amber-400',
  stale: 'border-muted-foreground/20 text-muted-foreground',
  unreachable: 'border-red-500/30 text-red-600 dark:text-red-400',
};
```

**Chip rendering (desktop):**

```tsx
<div className="hidden gap-1.5 sm:flex">
  {(['all', 'active', 'inactive', 'stale', 'unreachable'] as const).map((status) => {
    const count = status === 'all' ? undefined : statusCounts?.[status];
    // Hide unreachable chip when count is 0
    if (status === 'unreachable' && (count ?? 0) === 0) return null;
    return (
      <Button
        key={status}
        variant={statusFilter === status ? 'default' : 'outline'}
        size="sm"
        className={cn(
          'h-7 px-2.5 text-xs capitalize',
          statusFilter !== status && status !== 'all' && statusChipColors[status]
        )}
        onClick={() => onFilterStateChange({ ...filterState, statusFilter: status })}
      >
        {status}
        {count != null && count > 0 && <span className="ml-1 tabular-nums">({count})</span>}
      </Button>
    );
  })}
</div>
```

**Search input:** Change from `w-48` to `flex-1 min-w-[8rem]`:

```tsx
<Input
  className="h-8 min-w-[8rem] flex-1 pl-7 text-sm sm:max-w-[16rem]"
  placeholder="Filter agents..."
  value={searchQuery}
  onChange={(e) => onFilterStateChange({ ...filterState, searchQuery: e.target.value })}
/>
```

**Mobile (< 640px):** Filter chips replaced by a single `Select` dropdown:

```tsx
<div className="flex sm:hidden">
  <Select
    value={statusFilter}
    onValueChange={(v) => onFilterStateChange({ ...filterState, statusFilter: v as StatusFilter })}
  >
    <SelectTrigger className="h-8 w-28 text-xs">
      <SelectValue placeholder="Status" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="all">All statuses</SelectItem>
      <SelectItem value="active">Active</SelectItem>
      <SelectItem value="inactive">Inactive</SelectItem>
      <SelectItem value="stale">Stale</SelectItem>
      <SelectItem value="unreachable">Unreachable</SelectItem>
    </SelectContent>
  </Select>
</div>
```

### AgentsHeader (Modified)

**Updated props interface:**

```typescript
interface AgentsHeaderProps {
  /** Current view mode. */
  viewMode: 'list' | 'topology';
  /** Callback when the view mode tab is clicked. */
  onViewModeChange: (mode: 'list' | 'topology') => void;
}
```

**Layout:**

```tsx
export function AgentsHeader({ viewMode, onViewModeChange }: AgentsHeaderProps) {
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const isMobile = useIsMobile();

  return (
    <>
      <span className="text-sm font-medium">Agents</span>

      {/* View switcher — hidden on mobile */}
      {!isMobile && (
        <div className="bg-muted ml-4 flex rounded-md p-0.5">
          <button
            className={cn(
              'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
              viewMode === 'list'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onViewModeChange('list')}
          >
            Agents
          </button>
          <button
            className={cn(
              'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
              viewMode === 'topology'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onViewModeChange('topology')}
          >
            Topology
          </button>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setDiscoveryOpen(true)}
        >
          <ScanSearch className="size-3.5" />
          Scan for Agents
        </Button>
        <CommandPaletteTrigger />
      </div>

      {/* Discovery dialog (unchanged) */}
      <ResponsiveDialog open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        ...
      </ResponsiveDialog>
    </>
  );
}
```

The view switcher uses a custom `bg-muted` pill container with `bg-background shadow-sm` on the active tab. This matches the design system's card/button radius conventions and avoids importing the `Tabs` component (which carries semantic tab panel behavior unnecessary for a simple URL toggle).

### AgentsPage (Modified)

**Key changes:**

```tsx
import { useSearch, useNavigate } from '@tanstack/react-router';

export function AgentsPage() {
  const { view: viewMode } = useSearch({ from: '/_shell/agents' });
  const navigate = useNavigate();
  const { data: topology, isLoading, isError, refetch } = useTopology();

  const agents = useMemo(() => topology?.namespaces.flatMap((ns) => ns.agents) ?? [], [topology]);

  const hasAgents = agents.length > 0;
  const isModeA = !hasAgents && !isLoading && !isError;

  const handleViewModeChange = (mode: 'list' | 'topology') => {
    void navigate({ search: { view: mode } });
  };

  // Error state (unchanged)...

  return (
    <AnimatePresence mode="wait" initial={false}>
      {isModeA ? (
        <motion.div
          key="mode-a"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex h-full flex-col"
        >
          <AgentGhostRows />
        </motion.div>
      ) : (
        <motion.div
          key="mode-b"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex h-full flex-col"
        >
          <AnimatePresence mode="wait" initial={false}>
            {viewMode === 'list' ? (
              <motion.div
                key="list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex h-full flex-col"
              >
                <AgentsList agents={agents} isLoading={isLoading} />
              </motion.div>
            ) : (
              <motion.div
                key="topology"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="relative flex-1 overflow-hidden"
              >
                <div className="absolute inset-0">
                  <Suspense fallback={/* loading spinner */}>
                    <LazyTopologyGraph />
                  </Suspense>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

`AgentsHeader` is rendered by the app shell layout (not by `AgentsPage` directly). The `viewMode` and `onViewModeChange` props need to be threaded through the shell. Since the current `AgentsHeader` is rendered in the `AppShell`'s header slot based on the active route, the header component reads the search params directly:

```tsx
// AgentsHeader reads viewMode directly from URL
const { view: viewMode } = useSearch({ from: '/_shell/agents' });
const navigate = useNavigate();
const handleViewModeChange = (mode: 'list' | 'topology') => {
  void navigate({ search: { view: mode } });
};
```

This avoids prop threading through the shell entirely — the header and page both independently read from and write to the URL.

### UnregisterAgentDialog (New)

**File:** `apps/client/src/layers/features/agents-list/ui/UnregisterAgentDialog.tsx`

**Props interface:**

```typescript
interface UnregisterAgentDialogProps {
  /** Display name of the agent being unregistered. */
  agentName: string;
  /** Agent ID for the unregister mutation. */
  agentId: string;
  /** Controlled open state. */
  open: boolean;
  /** Callback when the dialog opens or closes. */
  onOpenChange: (open: boolean) => void;
}
```

**Implementation:**

```tsx
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/layers/shared/ui/alert-dialog';
import { useUnregisterAgent } from '@/layers/entities/mesh';

export function UnregisterAgentDialog({
  agentName,
  agentId,
  open,
  onOpenChange,
}: UnregisterAgentDialogProps) {
  const { mutate: unregister } = useUnregisterAgent();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unregister {agentName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the agent from the mesh registry. The agent can be re-discovered by
            scanning its project directory.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => unregister(agentId)}
          >
            Unregister
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

Note: `useUnregisterAgent()` is called in this component rather than receiving a callback prop. This keeps the mutation lifecycle (loading, error) co-located with the dialog. The `AgentRow` component no longer imports `useUnregisterAgent` directly.

### AgentGhostRows (New)

**File:** `apps/client/src/layers/features/agents-list/ui/AgentGhostRows.tsx`

**Props:** None (self-contained).

**Layout:**

```tsx
import { useState } from 'react';
import { ScanSearch } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui/responsive-dialog';
import { DiscoveryView } from '@/layers/features/mesh';

/** Module-scope stagger variants. */
const ghostContainerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
} as const;

const ghostRowVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 0.2 },
} as const;

export function AgentGhostRows() {
  const [discoveryOpen, setDiscoveryOpen] = useState(false);

  return (
    <div className="relative flex h-full flex-col items-center justify-center p-8">
      {/* Ghost rows */}
      <motion.div
        variants={ghostContainerVariants}
        initial="hidden"
        animate="visible"
        className="w-full max-w-2xl space-y-2"
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <motion.div
            key={i}
            variants={ghostRowVariants}
            transition={{ duration: 0.3 }}
            className="rounded-xl border border-dashed px-4 py-3"
          >
            {/* Line 1: dot + name skeleton + badge skeleton + time skeleton */}
            <div className="flex items-center gap-3">
              <span className="bg-muted size-2 rounded-full" />
              <span className="bg-muted h-3 w-28 rounded" />
              <span className="bg-muted h-5 w-16 rounded-md" />
              <span className="bg-muted ml-auto h-3 w-12 rounded" />
            </div>
            {/* Line 2: path skeleton + session skeleton */}
            <div className="mt-2 flex items-center gap-3 pl-5">
              <span className="bg-muted h-3 w-36 rounded" />
              <span className="bg-muted h-5 w-14 rounded-md" />
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Centered overlay CTA */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <h2 className="text-lg font-medium">Discover Your Agent Fleet</h2>
        <p className="text-muted-foreground mt-1 mb-4 text-sm">
          Scan your project directories to register agents with the mesh.
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => setDiscoveryOpen(true)}>
          <ScanSearch className="size-4" />
          Scan for Agents
        </Button>
      </div>

      <ResponsiveDialog open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <ResponsiveDialogContent className="max-w-2xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Discover Agents</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <DiscoveryView />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}
```

The ghost rows use `border-dashed` and animate to `opacity: 0.2` (not full opacity) to clearly differentiate from real content and avoid confusion with loading skeletons. The skeleton bars use `bg-muted` to match the design system's skeleton pattern.

### AgentEmptyFilterState (New)

**File:** `apps/client/src/layers/features/agents-list/ui/AgentEmptyFilterState.tsx`

**Props interface:**

```typescript
interface AgentEmptyFilterStateProps {
  /** Callback to reset all filters. */
  onClearFilters: () => void;
}
```

**Layout:**

```tsx
import { SearchX } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui/button';

export function AgentEmptyFilterState({ onClearFilters }: AgentEmptyFilterStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center py-16 text-center"
    >
      <div className="bg-muted rounded-xl p-3">
        <SearchX className="text-muted-foreground size-6" />
      </div>
      <p className="mt-3 text-sm font-medium">No agents match your filters</p>
      <p className="text-muted-foreground mt-1 text-xs">
        Try adjusting your search or status filter.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onClearFilters}>
        Clear filters
      </Button>
    </motion.div>
  );
}
```

Uses the fade + y:20 to 0 entrance pattern from `animations.md`. The `SearchX` icon communicates "no results found" clearly.

### AgentsList (Modified)

**Key changes to AgentsList:**

1. Add `FleetHealthBar` above `AgentFilterBar`.
2. Wire `FleetHealthBar` clicks to `setFilterState`.
3. Add `AgentEmptyFilterState` when `filteredAgents.length === 0` and agents exist.
4. Fix stagger animation with `staggerKey` pattern.
5. Pass `statusCounts` to `AgentFilterBar`.

```tsx
export function AgentsList({ agents, isLoading }: AgentsListProps) {
  const [filterState, setFilterState] = useState<FilterState>(defaultFilterState);
  const [staggerKey] = useState(0); // Only changes on mount, not on filter
  const { sessions } = useSessions();
  const { data: meshStatus } = useMeshStatus();

  const filteredAgents = useMemo(() => applyFilters(agents, filterState), [agents, filterState]);

  // ... existing namespace grouping and session count logic ...

  const handleStatusFilter = (status: StatusFilter) => {
    setFilterState((prev) => ({ ...prev, statusFilter: status }));
  };

  const handleClearFilters = () => {
    setFilterState(defaultFilterState);
  };

  const statusCounts = meshStatus
    ? {
        active: meshStatus.activeCount,
        inactive: meshStatus.inactiveCount,
        stale: meshStatus.staleCount,
        unreachable: meshStatus.unreachableCount,
      }
    : undefined;

  if (isLoading) {
    /* existing skeleton */
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {meshStatus && (
        <FleetHealthBar
          status={meshStatus}
          activeFilter={filterState.statusFilter}
          onStatusFilter={handleStatusFilter}
        />
      )}
      <AgentFilterBar
        agents={agents}
        filterState={filterState}
        onFilterStateChange={setFilterState}
        filteredCount={filteredAgents.length}
        statusCounts={statusCounts}
      />
      <ScrollArea className="min-h-0 flex-1">
        {filteredAgents.length === 0 ? (
          <AgentEmptyFilterState onClearFilters={handleClearFilters} />
        ) : (
          <div className="space-y-2 p-4 pt-0">
            {Object.entries(grouped).map(([namespace, groupAgents]) => (
              <div key={namespace}>
                {shouldGroup && namespace && (
                  <h3 className="text-muted-foreground mt-4 mb-2 text-[10px] font-medium tracking-widest uppercase first:mt-0">
                    {namespace}
                  </h3>
                )}
                <motion.div
                  key={staggerKey}
                  initial="hidden"
                  animate="visible"
                  variants={{
                    visible: { transition: { staggerChildren: 0.04 } },
                    hidden: {},
                  }}
                  className="space-y-2"
                >
                  {groupAgents.map((agent, index) => (
                    <motion.div
                      key={agent.id}
                      variants={
                        index < 8
                          ? {
                              hidden: { opacity: 0, y: 8 },
                              visible: { opacity: 1, y: 0 },
                            }
                          : undefined
                      }
                      transition={{ duration: 0.15 }}
                    >
                      <AgentRow
                        agent={agent}
                        projectPath={agent.projectPath ?? ''}
                        sessionCount={sessionCounts[agent.id] ?? 0}
                        healthStatus={agent.healthStatus}
                        lastActive={agent.lastSeenAt}
                      />
                    </motion.div>
                  ))}
                </motion.div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
```

**Stagger fix:** The `staggerKey` state is initialized once on mount and never updated. This means the stagger animation plays once when `AgentsList` mounts, but filter changes do not trigger a remount of the `motion.div` container. The `AnimatePresence` wrapper around the stagger container is removed (it was causing re-animation on filter changes because the key of filtered items changed). The index < 8 limit ensures long lists do not have excessive stagger delay.

## Animation Specifications

| Element             | Trigger                    | Variants (module-scope)                                                         | Transition                             | Overflow          |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- | ----------------- |
| Mode A to Mode B    | `hasAgents` changes        | `opacity: 0 to 1`, `exit: opacity 0`                                            | `duration: 0.2`                        | n/a               |
| List to Topology    | `viewMode` changes         | `opacity: 0 to 1`, `exit: opacity 0`                                            | `duration: 0.15`                       | n/a               |
| AgentRow entrance   | Mount (stagger from list)  | `hidden: { opacity: 0, y: 8 }`, `visible: { opacity: 1, y: 0 }`                 | `duration: 0.15`, stagger `0.04`       | n/a               |
| AgentRow expand     | `open` state toggle        | `initial: { height: 0, opacity: 0 }`, `animate: { height: 'auto', opacity: 1 }` | `duration: 0.2, ease: [0, 0, 0.2, 1]`  | `overflow-hidden` |
| AgentRow hover      | Mouse enter                | n/a (CSS only)                                                                  | `transition-colors` (Tailwind default) | n/a               |
| Health dot pulse    | Active agents (constant)   | CSS `@keyframes health-pulse`                                                   | `2s ease-in-out infinite`              | n/a               |
| Ghost rows entrance | Mount                      | Container: `staggerChildren: 0.1`. Items: `opacity: 0 to 0.2`                   | `duration: 0.3`                        | n/a               |
| Empty filter state  | Filter yields zero results | `initial: { opacity: 0, y: 20 }`, `animate: { opacity: 1, y: 0 }`               | `duration: 0.3, ease: 'easeOut'`       | n/a               |

All variants are defined at module scope per `animations.md` convention. The global `<MotionConfig reducedMotion="user">` in `App.tsx` handles accessibility automatically.

## Barrel Export Updates

**`apps/client/src/layers/features/agents-list/index.ts`** — add new exports:

```typescript
export { FleetHealthBar } from './ui/FleetHealthBar';
export { UnregisterAgentDialog } from './ui/UnregisterAgentDialog';
export { AgentGhostRows } from './ui/AgentGhostRows';
export { AgentEmptyFilterState } from './ui/AgentEmptyFilterState';
```

**`apps/client/src/layers/features/top-nav/index.ts`** — no changes needed (AgentsHeader is already exported).

**`apps/client/src/layers/widgets/agents/index.ts`** — no changes needed (AgentsPage is already exported).

**`router.tsx`** — export the new type:

```typescript
export type AgentsSearch = z.infer<typeof agentsSearchSchema>;
```

## Testing Strategy

### Updated Tests

**`apps/client/src/layers/widgets/agents/__tests__/AgentsPage.test.tsx`:**

- Remove assertions about `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`.
- Add test: renders `AgentGhostRows` in Mode A (no agents).
- Add test: renders `AgentsList` when `viewMode === 'list'` (default).
- Add test: renders `LazyTopologyGraph` when `viewMode === 'topology'`.
- Mock `useSearch` to provide `view` param; mock `useNavigate` to verify view mode changes.

**`apps/client/src/layers/features/agents-list/__tests__/AgentRow.test.tsx`:**

- Update assertions for two-line card layout (name and runtime on Line 1, path on Line 2).
- Remove assertions for collapsed capabilities (no longer shown in collapsed state).
- Add test: displays `relativeTime()` output instead of raw ISO string.
- Add test: "Unregister" button opens `UnregisterAgentDialog` (check for AlertDialog title).
- Remove tests for inline confirm/cancel pattern.

**`apps/client/src/layers/features/agents-list/__tests__/AgentFilterBar.test.tsx`:**

- Add test: renders color-coded status chips.
- Add test: renders counts in parentheses when `statusCounts` provided.
- Add test: `unreachable` chip shown when count > 0, hidden when 0.
- Add test: mobile renders dropdown instead of chips (mock `useIsMobile` to return true).
- Update `StatusFilter` type assertions to include `'unreachable'`.

**`apps/client/src/layers/features/agents-list/__tests__/AgentsList.test.tsx`:**

- Add test: renders `FleetHealthBar` above filter bar when `meshStatus` available.
- Add test: clicking health bar count updates filter state.
- Add test: renders `AgentEmptyFilterState` when filters match zero agents.
- Add test: "Clear filters" button resets filter state.

### New Tests

**`apps/client/src/layers/features/agents-list/__tests__/FleetHealthBar.test.tsx`:**

- Renders colored dots and counts for each non-zero status.
- Does not render segments with zero count.
- Clicking a count calls `onStatusFilter` with the correct status.
- Clicking the active filter calls `onStatusFilter('all')` to toggle off.
- Renders total agent count.
- On mobile, hides status labels (assert `hidden sm:inline` class).

**`apps/client/src/layers/features/agents-list/__tests__/UnregisterAgentDialog.test.tsx`:**

- Renders agent name in dialog title.
- Cancel button closes dialog (calls `onOpenChange(false)`).
- Confirm button calls `unregister(agentId)`.
- Dialog has destructive styling on confirm button.

**`apps/client/src/layers/features/agents-list/__tests__/AgentGhostRows.test.tsx`:**

- Renders 3 ghost rows with `border-dashed`.
- Renders "Discover Your Agent Fleet" heading.
- Renders "Scan for Agents" button.
- Clicking button opens discovery dialog.

## Acceptance Criteria

- [ ] AgentRow renders as a two-line card: Line 1 = health dot + name + runtime badge + relative time. Line 2 = truncated path + session count + SessionLaunchPopover.
- [ ] Capabilities are not shown in collapsed AgentRow state.
- [ ] `lastActive` displays as relative time ("3m ago") via `relativeTime()`, not raw ISO string.
- [ ] AgentRow expanded section uses height animation (`motion.div`, `height: 0 to 'auto'`, 200ms).
- [ ] Unregister action opens `AlertDialog` (not inline confirm/cancel).
- [ ] `AlertDialog` confirm button uses destructive styling (`bg-destructive`).
- [ ] Active agent health dots have a pulsing CSS animation.
- [ ] `FleetHealthBar` shows colored dots + counts for each non-zero status.
- [ ] Clicking a `FleetHealthBar` count activates that status filter in `AgentFilterBar`.
- [ ] Clicking an already-active `FleetHealthBar` count resets filter to `'all'`.
- [ ] `FleetHealthBar` counts use `tabular-nums` for layout stability.
- [ ] `FleetHealthBar` shows total agent count right-aligned.
- [ ] `AgentFilterBar` status chips are color-coded (emerald, amber, muted, red).
- [ ] `AgentFilterBar` chips show count in parentheses when `statusCounts` provided.
- [ ] `AgentFilterBar` includes `unreachable` status (shown only when count > 0).
- [ ] `AgentFilterBar` search input is flexible width (`flex-1 min-w-[8rem]`).
- [ ] `/agents` route has `?view=list|topology` search param with Zod validation.
- [ ] View switcher renders in `AgentsHeader` as text tabs ("Agents" | "Topology").
- [ ] View switcher is hidden on mobile.
- [ ] Switching view mode updates URL and renders correct content.
- [ ] `Tabs` component is removed from `AgentsPage`.
- [ ] Mode A renders `AgentGhostRows` (3 dashed-border ghost rows with scan CTA overlay).
- [ ] Ghost rows are clearly distinct from loading skeletons (dashed border, `opacity-20`).
- [ ] `AgentEmptyFilterState` renders when filters match zero agents.
- [ ] "Clear filters" button resets all filters to defaults.
- [ ] Stagger animation plays once on mount, does not re-trigger on filter changes.
- [ ] Stagger is limited to first 8 items to avoid excessive delay.
- [ ] Mobile (< 640px): `FleetHealthBar` shows dots + counts only (no labels).
- [ ] Mobile (< 640px): `AgentFilterBar` renders status dropdown instead of chips.
- [ ] Mobile (< 640px): `AgentRow` wraps path to its own line.
- [ ] Mobile (< 640px): Topology tab is hidden.
- [ ] All interactive elements have minimum 44px touch targets on mobile.
- [ ] All animations respect `prefers-reduced-motion` via global `MotionConfig`.
- [ ] All motion variants are defined at module scope (not inline).
- [ ] All new components have TSDoc on exports.
- [ ] All barrel `index.ts` files are updated with new exports.
- [ ] All existing tests pass after modifications.
- [ ] New test files created for `FleetHealthBar`, `UnregisterAgentDialog`, `AgentGhostRows`.

## Open Questions

None. All design decisions were made during ideation (see `01-ideation.md` section 6).
