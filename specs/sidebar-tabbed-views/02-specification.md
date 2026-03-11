---
slug: sidebar-tabbed-views
number: 117
created: 2026-03-10
status: specified
authors: Claude Code
ideation: specs/sidebar-tabbed-views/01-ideation.md
---

# Sidebar Tabbed Views — Sessions, Schedules, Connections

## Status

Specified

## Overview

Evolve the sidebar from a single-purpose session list (`SessionSidebar`) into a three-tab navigation system (`AgentSidebar`). Icon-only horizontal tabs switch between Sessions, Schedules, and Connections views. All three views are mounted simultaneously and use CSS `hidden` toggling to preserve state (scroll position, expanded items, React component state) across tab switches.

The existing `AgentContextChips` component is removed; its status information migrates to tab badges and in-view content within the Schedules and Connections tabs.

## Background / Problem Statement

The sidebar currently serves a single purpose: listing sessions for the active agent/cwd. Agent-scoped information like schedules (Pulse) and connections (Relay adapters, Mesh agents) lives behind dialog panels that must be explicitly opened via `AgentContextChips` in the sidebar footer. This creates two problems:

1. **Discoverability**: Users must know to click the small footer chips to access Pulse/Relay/Mesh status. Kai's core frustration — "You can't observe what 20 agents are doing" — is only partially addressed by tiny status dots.

2. **Glanceability**: The sidebar has unused vertical real estate below the session list. Schedule status and connection health could be surfaced at-a-glance without opening full management dialogs.

The tabbed sidebar surfaces agent context directly, transforming the sidebar from a session list into an agent control surface.

## Goals

- Three icon-only tabs (Sessions, Schedules, Connections) with smooth animated indicator
- Zero-cost tab switching — views persist DOM state via CSS `hidden` toggle
- Tab badges provide glanceable status (active run count, connection health)
- Keyboard shortcuts (Cmd+1/2/3) for flow-preserving tab switching
- Rename `SessionSidebar` → `AgentSidebar` across the codebase
- Remove `AgentContextChips` — its information is now inline
- Read-only summary views with bridge buttons to full management dialogs

## Non-Goals

- Full inline CRUD for schedules or adapter management within the sidebar
- Changes to PulsePanel, RelayPanel, or MeshPanel dialog content
- New API endpoints (all data available via existing entity hooks)
- Mobile-specific tab behavior beyond responsive sizing
- Changes to the top navigation bar
- Renaming the `session-list` FSD feature module directory (deferred)
- Updating 100+ spec/research/doc references to SessionSidebar (follow-up pass)

## Technical Dependencies

- **lucide-react** — `MessageSquare`, `Clock`, `Plug2` icons (already installed)
- **motion** — `layoutId` for sliding tab indicator, stagger animations (already installed)
- **zustand** — App store for `sidebarActiveTab` state (already installed)
- **@radix-ui/react-tabs** — NOT used (Radix Tabs unmounts inactive content; we need CSS hidden toggle)

## Detailed Design

### 1. Component Rename: SessionSidebar → AgentSidebar

Straightforward rename with no behavioral changes:

| Current Path | New Path |
|---|---|
| `features/session-list/ui/SessionSidebar.tsx` | `features/session-list/ui/AgentSidebar.tsx` |
| `features/session-list/__tests__/SessionSidebar.test.tsx` | `features/session-list/__tests__/AgentSidebar.test.tsx` |
| `features/session-list/index.ts` export | Update `SessionSidebar` → `AgentSidebar` |
| `App.tsx` import | Update import name |
| `apps/e2e/pages/SessionSidebarPage.ts` | Rename to `AgentSidebarPage.ts` |
| `apps/e2e/fixtures/index.ts` | Update fixture name |

### 2. Zustand State Addition

Add to `app-store.ts` interface and implementation:

```typescript
// Interface addition
sidebarActiveTab: 'sessions' | 'schedules' | 'connections';
setSidebarActiveTab: (tab: 'sessions' | 'schedules' | 'connections') => void;

// Implementation
sidebarActiveTab: (() => {
  try {
    const stored = localStorage.getItem('dorkos-sidebar-active-tab');
    if (stored === 'sessions' || stored === 'schedules' || stored === 'connections') return stored;
  } catch {}
  return 'sessions';
})() as 'sessions' | 'schedules' | 'connections',
setSidebarActiveTab: (tab) => {
  try { localStorage.setItem('dorkos-sidebar-active-tab', tab); } catch {}
  set({ sidebarActiveTab: tab });
},
```

Include `'dorkos-sidebar-active-tab'` in `resetPreferences()` cleanup.

### 3. SidebarTabRow Component

New file: `features/session-list/ui/SidebarTabRow.tsx`

A horizontal row of three icon buttons with ARIA `role="tablist"` semantics. Renders between `SidebarHeader` and the content area.

**Props:**
```typescript
interface SidebarTabRowProps {
  activeTab: 'sessions' | 'schedules' | 'connections';
  onTabChange: (tab: 'sessions' | 'schedules' | 'connections') => void;
  schedulesBadge: number;       // Active run count (0 = no badge)
  connectionsStatus: 'ok' | 'partial' | 'error' | 'none';
  visibleTabs: ('sessions' | 'schedules' | 'connections')[];
}
```

**Tab definitions:**

| Tab | Icon | ARIA Label | Badge | Tooltip |
|---|---|---|---|---|
| `sessions` | `MessageSquare` | "Sessions" | None | "Sessions ⌘1" |
| `schedules` | `Clock` | "Schedules" | Numeric (active runs) | "Schedules ⌘2" |
| `connections` | `Plug2` | "Connections" | Status dot | "Connections ⌘3" |

**ARIA structure:**
- Container: `role="tablist"`, `aria-label="Sidebar views"`
- Each tab button: `role="tab"`, `aria-selected`, `aria-controls="sidebar-tabpanel-{name}"`
- Arrow key navigation between tabs (left/right)

**Sliding indicator:**
```tsx
{/* Underline indicator — slides between tabs */}
<motion.div
  layoutId="sidebar-tab-indicator"
  className="bg-foreground absolute bottom-0 h-0.5 rounded-full"
  transition={{ type: 'spring', stiffness: 280, damping: 32 }}
/>
```

**Badge rendering:**
- Schedules badge: `<span className="...text-2xs...">{count}</span>` with `animate-pulse` ring when `count > 0`
- Connections status dot: 6px circle — `bg-green-500` (ok), `bg-amber-500` (partial), `bg-red-500` (error), hidden (none)

**Styling:**
```
border-b border-border px-2 py-1.5 flex items-center gap-1 relative
```
Each tab button: `relative rounded-md p-2 transition-colors duration-150` with active/inactive color states matching existing `AgentContextChips` pattern.

### 4. AgentSidebar Component Structure

The refactored `AgentSidebar.tsx` component:

```tsx
export function AgentSidebar() {
  const { sidebarActiveTab, setSidebarActiveTab } = useAppStore();
  // ... existing session hooks ...

  // Determine visible tabs based on feature flags
  const toolStatus = useAgentToolStatus(selectedCwd);
  const pulseEnabled = toolStatus.pulse !== 'disabled-by-server';
  const { data: activeRunCount = 0 } = useActiveRunCount(pulseEnabled);
  const connectionsStatus = useConnectionsStatus(selectedCwd); // new derived hook

  const visibleTabs = useMemo(() => {
    const tabs: ('sessions' | 'schedules' | 'connections')[] = ['sessions'];
    if (pulseEnabled) tabs.push('schedules');
    // Connections always visible (Mesh has no server feature flag)
    tabs.push('connections');
    return tabs;
  }, [pulseEnabled]);

  // Fall back to 'sessions' if active tab becomes hidden
  useEffect(() => {
    if (!visibleTabs.includes(sidebarActiveTab)) {
      setSidebarActiveTab('sessions');
    }
  }, [visibleTabs, sidebarActiveTab, setSidebarActiveTab]);

  return (
    <>
      <SidebarHeader className="border-b p-3">
        {/* "New session" button — always visible, app-level action */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleNewSession} className="...">
              <Plus className="size-(--size-icon-sm)" />
              New session
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarTabRow
        activeTab={sidebarActiveTab}
        onTabChange={setSidebarActiveTab}
        schedulesBadge={activeRunCount}
        connectionsStatus={connectionsStatus}
        visibleTabs={visibleTabs}
      />

      <SidebarContent className="!overflow-hidden">
        {/* All three views mounted; inactive ones hidden via CSS */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-sessions"
          aria-labelledby="sidebar-tab-sessions"
          className={cn(sidebarActiveTab !== 'sessions' && 'hidden')}
        >
          <SessionsView
            sessions={sessions}
            activeSessionId={activeSessionId}
            groupedSessions={groupedSessions}
            justCreatedId={justCreatedId}
            onSessionClick={handleSessionClick}
          />
        </div>
        <div
          role="tabpanel"
          id="sidebar-tabpanel-schedules"
          aria-labelledby="sidebar-tab-schedules"
          className={cn(sidebarActiveTab !== 'schedules' && 'hidden')}
        >
          <SchedulesView toolStatus={toolStatus.pulse} />
        </div>
        <div
          role="tabpanel"
          id="sidebar-tabpanel-connections"
          aria-labelledby="sidebar-tab-connections"
          className={cn(sidebarActiveTab !== 'connections' && 'hidden')}
        >
          <ConnectionsView toolStatus={toolStatus} projectPath={selectedCwd} />
        </div>
      </SidebarContent>

      <SidebarFooter className="border-t p-3">
        {shouldShowOnboarding && (
          <div className="mb-2">
            <ProgressCard onStepClick={setOnboardingStep} onDismiss={dismissOnboarding} />
          </div>
        )}
        {/* AgentContextChips REMOVED — replaced by tab badges + in-view content */}
        <SidebarFooterBar />
      </SidebarFooter>

      <SidebarRail />
    </>
  );
}
```

### 5. SessionsView Component

Extract the existing session list rendering into a dedicated component. This is a pure extraction — no behavioral changes.

**File:** `features/session-list/ui/SessionsView.tsx`

**Props:**
```typescript
interface SessionsViewProps {
  sessions: Session[];
  activeSessionId: string | null;
  groupedSessions: SessionGroup[];
  justCreatedId: string | null;
  onSessionClick: (sessionId: string) => void;
}
```

Contains the existing `ScrollArea` → `motion.div` → grouped `SidebarGroup` / `SidebarMenu` / `SessionItem` tree, plus the "No conversations yet" empty state.

### 6. SchedulesView Component

**File:** `features/session-list/ui/SchedulesView.tsx`

Read-only summary of Pulse schedules for the current agent.

**Props:**
```typescript
interface SchedulesViewProps {
  /** Per-agent Pulse chip state from useAgentToolStatus */
  toolStatus: ChipState;
}
```

**Data hooks used internally:**
- `useSchedules(toolStatus !== 'disabled-by-server')` — schedule list
- `useActiveRunCount(toolStatus !== 'disabled-by-server')` — active run count

**Layout:**
```
ScrollArea
├── SidebarGroup "Active" (if any running)
│   ├── SidebarGroupLabel "Active"
│   └── SidebarMenu
│       └── ScheduleRow (name, elapsed time, pulsing dot)
├── SidebarGroup "Upcoming"
│   ├── SidebarGroupLabel "Upcoming"
│   └── SidebarMenu
│       └── ScheduleRow (name, next run relative time, status dot)
├── Empty state: "No schedules configured" (muted text, centered)
├── Disabled state: "Pulse disabled for this agent" (when toolStatus === 'disabled-by-agent')
└── Bridge button: "Open Pulse →" (setPulseOpen(true))
```

**ScheduleRow** — compact row showing schedule name, relative time, and status indicator. Uses `SidebarMenuButton` for consistent hover/active states.

### 7. ConnectionsView Component

**File:** `features/session-list/ui/ConnectionsView.tsx`

Read-only summary of Relay adapters and Mesh agents.

**Props:**
```typescript
interface ConnectionsViewProps {
  toolStatus: AgentToolStatus;
  projectPath: string | null;
}
```

**Data hooks used internally:**
- `useRelayAdapters(toolStatus.relay !== 'disabled-by-server')` — adapter list
- `useRegisteredAgents(undefined, toolStatus.mesh !== 'disabled-by-server')` — agent list
- `useRelayEnabled()`, `useMeshEnabled()` — feature flags

**Layout:**
```
ScrollArea
├── SidebarGroup "Adapters" (if Relay not disabled-by-server)
│   ├── SidebarGroupLabel "Adapters"
│   └── SidebarMenu
│       └── AdapterRow (name, status dot + label)
│   └── Disabled state: "Relay disabled for this agent" (when disabled-by-agent)
│   └── Bridge button: "Open Relay →" (setRelayOpen(true))
├── SidebarGroup "Agents" (if Mesh not disabled-by-server)
│   ├── SidebarGroupLabel "Agents"
│   └── SidebarMenu
│       └── AgentRow (name, online dot + status)
│   └── Disabled state: "Mesh disabled for this agent" (when disabled-by-agent)
│   └── Bridge button: "Open Mesh →" (setMeshOpen(true))
└── Empty state: "No connections configured" (when both sections empty)
```

**Status dot colors:**
- Adapters: green = connected, amber = idle, red = error
- Agents: green = online, muted = offline

### 8. Connections Status Derivation

A new derived hook `useConnectionsStatus` computes the aggregate status for the Connections tab badge:

**File:** `features/session-list/model/use-connections-status.ts`

```typescript
export function useConnectionsStatus(
  projectPath: string | null
): 'ok' | 'partial' | 'error' | 'none' {
  const toolStatus = useAgentToolStatus(projectPath);
  const relayEnabled = toolStatus.relay !== 'disabled-by-server';
  const meshEnabled = toolStatus.mesh !== 'disabled-by-server';
  const { data: adapters } = useRelayAdapters(relayEnabled);
  const { data: agents } = useRegisteredAgents(undefined, meshEnabled);

  return useMemo(() => {
    const items = [...(adapters ?? []), ...(agents ?? [])];
    if (items.length === 0) return 'none';
    const hasError = adapters?.some(a => a.status === 'error');
    if (hasError) return 'error';
    const allConnected = adapters?.every(a => a.status === 'connected') ?? true;
    const allOnline = agents?.every(a => a.status === 'online') ?? true;
    if (allConnected && allOnline) return 'ok';
    return 'partial';
  }, [adapters, agents]);
}
```

### 9. Keyboard Shortcuts

Implemented as a `useEffect` in `AgentSidebar`:

```typescript
useEffect(() => {
  if (!sidebarOpen) return;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const tabMap: Record<string, 'sessions' | 'schedules' | 'connections'> = {
      '1': 'sessions',
      '2': 'schedules',
      '3': 'connections',
    };
    const tab = tabMap[e.key];
    if (tab && visibleTabs.includes(tab)) {
      e.preventDefault();
      setSidebarActiveTab(tab);
    }
  };

  document.addEventListener('keydown', handleKeyDown);
  return () => document.removeEventListener('keydown', handleKeyDown);
}, [sidebarOpen, visibleTabs, setSidebarActiveTab]);
```

Shortcut numbers are dynamic — they map to visible tab positions. If Schedules is hidden (Pulse disabled), Cmd+2 maps to Connections.

### 10. AgentContextChips Removal

**Delete files:**
- `features/session-list/ui/AgentContextChips.tsx`
- `features/session-list/__tests__/AgentContextChips.test.tsx`

**Update files:**
- `features/session-list/index.ts` — remove `AgentContextChips` export
- `AgentSidebar.tsx` — remove `<AgentContextChips />` from `SidebarFooter`

The Pulse badge count flow to Zustand (`setPulseBadgeCount`) for `useDocumentTitle` remains in `AgentSidebar` — it's not tied to `AgentContextChips`.

### 11. Motion & Micro-interactions

| Element | Animation | Config |
|---|---|---|
| Sliding tab indicator | `layoutId` spring | `stiffness: 280, damping: 32` |
| Schedules badge pulse | CSS `animate-pulse` on ring | When `activeRunCount > 0` |
| First-open stagger | `motion.div` stagger children | 40ms delay, first 5 items, only on first render |
| Tab content appear | Fade in | `opacity: 0→1`, 150ms, `ease-out` |

### 12. File Organization

```
features/session-list/
├── ui/
│   ├── AgentSidebar.tsx          # Renamed from SessionSidebar.tsx
│   ├── SidebarTabRow.tsx         # NEW — tab navigation bar
│   ├── SessionsView.tsx          # NEW — extracted session list content
│   ├── SchedulesView.tsx         # NEW — read-only schedule summary
│   ├── ConnectionsView.tsx       # NEW — read-only adapter/agent summary
│   ├── SessionItem.tsx           # Unchanged
│   └── SidebarFooterBar.tsx      # Unchanged
├── model/
│   └── use-connections-status.ts # NEW — derived connection status
├── __tests__/
│   ├── AgentSidebar.test.tsx     # Renamed + extended
│   ├── SidebarTabRow.test.tsx    # NEW
│   ├── SchedulesView.test.tsx    # NEW
│   ├── ConnectionsView.test.tsx  # NEW
│   └── SidebarFooterBar.test.tsx # Unchanged
│   └── SessionItem.test.tsx      # Unchanged
└── index.ts                      # Updated exports
```

## User Experience

### Tab Switching Flow

1. User sees three icon tabs below the "New session" button
2. Sessions tab is active by default — shows the familiar session list
3. Clicking Schedules icon (or pressing Cmd+2) switches to schedule summary
4. The previous Sessions view retains its scroll position — switching back is instant
5. Hovering the Connections tab shows a tooltip: "Connections ⌘3 · Relay: 2 connected · Mesh: 4 agents"
6. Clicking the Connections tab shows adapter health and agent roster
7. "Open Relay →" button in the Connections view opens the full RelayPanel dialog

### Glanceable Status

Without clicking:
- A pulsing dot on the Schedules tab means a run is actively executing
- A numeric badge on the Schedules tab shows how many runs are active
- A green dot on the Connections tab means all adapters connected and agents online
- An amber dot means partial connectivity
- A red dot means connection errors

### Feature Flag Behavior

- If Pulse is disabled at the server level: Schedules tab hidden, shortcuts renumber
- If Pulse is disabled per-agent: Schedules tab visible but shows "Pulse disabled for this agent"
- Same pattern for Relay/Mesh sections within the Connections tab

## Testing Strategy

### Unit Tests

**SidebarTabRow.test.tsx:**
- Renders three tabs with correct icons and ARIA attributes
- Active tab has `aria-selected="true"`; others `"false"`
- Click handler fires with correct tab value
- Badge renders when `schedulesBadge > 0`; hidden when 0
- Status dot renders with correct color class for each `connectionsStatus` value
- Hidden tabs are not rendered when `visibleTabs` omits them
- Arrow key navigation moves focus between tabs

**SchedulesView.test.tsx:**
- Renders "Active" section when active runs exist
- Renders "Upcoming" section with schedule names and relative times
- Shows empty state when no schedules
- Shows "Pulse disabled for this agent" when `toolStatus === 'disabled-by-agent'`
- "Open Pulse" button calls `setPulseOpen(true)`
- Does NOT render when Pulse is `disabled-by-server` (parent hides tab)

**ConnectionsView.test.tsx:**
- Renders "Adapters" section with adapter names and status indicators
- Renders "Agents" section with agent names and online status
- Hides "Adapters" section when Relay is `disabled-by-server`
- Shows "Relay disabled for this agent" when `disabled-by-agent`
- Bridge buttons open correct dialogs
- Empty states render when sections have no items

**AgentSidebar.test.tsx (extended):**
- Tab switching changes visible view (`hidden` class toggling)
- Active tab persists in Zustand state
- Keyboard shortcuts (Cmd+1/2/3) switch tabs when sidebar is open
- Shortcuts are no-op when sidebar is closed
- `AgentContextChips` is NOT rendered (removed)
- Feature flag changes hide/show tabs correctly
- Tab defaults to `'sessions'` when active tab becomes hidden

### Integration Tests

**use-connections-status.test.ts:**
- Returns `'none'` when no adapters or agents exist
- Returns `'ok'` when all adapters connected and agents online
- Returns `'partial'` when some adapters idle
- Returns `'error'` when any adapter has error status

### E2E Tests

Update `apps/e2e/pages/SessionSidebarPage.ts` → `AgentSidebarPage.ts`:
- Add locators for tab buttons (`[role="tab"]`)
- Add locators for tab panels (`[role="tabpanel"]`)
- Add method: `switchTab(name: 'sessions' | 'schedules' | 'connections')`
- Add method: `getActiveTab(): string`

## Performance Considerations

- **Mount cost**: All three views mount on initial render. SchedulesView and ConnectionsView use TanStack Query hooks that only fetch when their feature flag is enabled — disabled views make zero API calls.
- **Re-render isolation**: CSS `hidden` means hidden views don't participate in layout reflows. React still re-renders them on state changes, but this is negligible for read-only summary components.
- **Badge polling**: `useActiveRunCount` polls every 10s (existing). `useRelayAdapters` polls every 10s (existing). `useRegisteredAgents` has 30s stale time (existing). No new polling introduced.
- **Future optimization**: When React 19.2's `<Activity>` component is available, migrate from CSS `hidden` to `<Activity mode="hidden">` to also suspend Effects in hidden views.

## Security Considerations

No new security concerns. All data sources are existing authenticated API endpoints. No new user input. Tab state stored in localStorage (non-sensitive UI preference).

## Documentation

- Update `contributing/design-system.md` — add sidebar tabs section documenting spacing, icon sizes, badge patterns
- Update `contributing/project-structure.md` — reflect `AgentSidebar` rename if mentioned
- No new external docs needed (internal UI feature)

## Implementation Phases

### Phase 1: Rename + State Foundation

- Rename `SessionSidebar` → `AgentSidebar` across all code files
- Add `sidebarActiveTab` to Zustand store with localStorage persistence
- Create `SidebarTabRow` component with icon tabs and sliding indicator
- Wire tab switching in `AgentSidebar` — for now, only Sessions view has content
- Update existing tests for rename

### Phase 2: View Extraction + New Views

- Extract `SessionsView` from existing `AgentSidebar` session list code
- Create `SchedulesView` with schedule list, empty states, bridge button
- Create `ConnectionsView` with adapter/agent list, empty states, bridge buttons
- Create `useConnectionsStatus` derived hook
- Implement CSS `hidden` toggle for view persistence
- Remove `AgentContextChips` component and all references

### Phase 3: Polish + Shortcuts + Testing

- Add keyboard shortcuts (Cmd+1/2/3)
- Add tab badges (numeric for Schedules, status dot for Connections)
- Implement motion: sliding indicator, badge pulse, first-open stagger
- Add rich tooltips with system state summary
- Write all new tests (SidebarTabRow, SchedulesView, ConnectionsView, AgentSidebar extensions)
- Update E2E page objects
- Update documentation

## Open Questions

*No open questions — all decisions resolved during ideation.*

## Related ADRs

| ADR | Relevance |
|---|---|
| [ADR-0064: Shadcn Sidebar for Standalone Layout](../decisions/0064-shadcn-sidebar-for-standalone-layout.md) | Foundation — the sidebar already uses Shadcn primitives (SidebarProvider, SidebarContent, etc.) |
| [ADR-0065: Lift Dialogs to Root DialogHost](../decisions/0065-lift-dialogs-to-root-dialog-host.md) | DialogHost renders PulsePanel/RelayPanel/MeshPanel — unchanged by this spec. Bridge buttons trigger dialog open via Zustand. |
| [ADR-0069: Agent Context Config Independent from Feature Flags](../decisions/0069-agent-context-config-independent-from-feature-flags.md) | Dual gating (feature flag + agent config) applies to tab visibility and section rendering |
| [ADR-0105: Header as Agent Identity Surface](../decisions/0105-header-as-agent-identity-surface.md) | Agent identity moved to header — sidebar focuses on operational views (sessions, schedules, connections) |

## References

- Ideation: `specs/sidebar-tabbed-views/01-ideation.md`
- Parent spec: `specs/agent-centric-ux/02-specification.md`
- Shadcn Sidebar spec: `specs/shadcn-sidebar-redesign/02-specification.md`
- Pulse UI spec: `specs/pulse-ui-overhaul/02-specification.md`
- Adapter catalog spec: `specs/adapter-catalog-management/02-specification.md`
- Mesh panel spec: `specs/mesh-panel-ux-overhaul/02-specification.md`
- Research: `research/20260310_sidebar_tabbed_views_ux.md`
- Design system: `contributing/design-system.md`
- Animations guide: `contributing/animations.md`
- State management guide: `contributing/state-management.md`
