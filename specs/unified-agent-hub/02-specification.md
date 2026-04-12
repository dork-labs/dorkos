---
slug: unified-agent-hub
number: 238
created: 2026-04-12
status: draft
---

# Unified Agent Hub -- Agent Profile Panel

## 1. Title

Unified Agent Hub -- Agent Profile Panel

## 2. Status

Draft

## 3. Authors

Claude Code, 2026-04-12

## 4. Overview

This specification defines the Agent Hub, a unified panel that consolidates all agent-specific configuration and activity surfaces into a single right-panel component. The hub replaces the existing AgentDialog (modal) and absorbs the agent-scoped content from the SessionSidebar, giving users one canonical place for everything about an agent. It is registered as a `rightpanel` contribution via the extension registry and contains six tabs in a left-nav sidebar layout: Overview, Personality, Sessions, Channels, Tasks, and Tools.

Four entry points lead to the same destination: the AgentIdentity chip (primary), context menu ("Agent profile"), a keyboard shortcut, and the command palette. The global settings gear icon receives an "App Settings" tooltip to disambiguate it from per-agent configuration.

## 5. Background / Problem Statement

DorkOS currently presents agent configuration and activity across three overlapping surfaces:

1. **AgentDialog** (`AgentDialog.tsx`) -- a modal dialog with 4 tabs (Identity, Channels, Personality, Tools), opened via `useAppStore.setAgentDialogOpen(true)` or context menu "Edit settings".
2. **SessionSidebar** (`SessionSidebar.tsx`) -- a left-sidebar view with 4 tabs (Overview, Sessions, Schedules, Connections), navigated to via context menu "Manage agent" which calls `navigate({ to: '/session' })` and `setSidebarLevel('session')`.
3. **Context menus** (`AgentContextMenu.tsx`, `AgentListItem.tsx` dropdown) -- offer both "Manage agent" and "Edit settings" as separate items, which open different surfaces for the same entity.

This fragmentation creates genuine user confusion:

- **Two items, one intent.** "Manage agent" and "Edit settings" are cognitively indistinguishable for most users. Both lead to "stuff about this agent" but open different surfaces.
- **Proximity-implies-scope confusion.** The sidebar gear icon sits near agent-scoped content on the session page, but opens global App Settings. Users expect it to open agent settings.
- **No direct entry from the agent's own identity.** The `AgentIdentity` chip (avatar + name) appears across the entire UI but is purely presentational -- clicking does nothing. Users intuitively expect clicking an agent's face to show information about that agent.
- **Split mental model.** Channels configuration lives in the AgentDialog, but connection status for those same channels lives in the SessionSidebar's Connections tab. Users must mentally stitch these together.

Industry convergence (GitHub Agent HQ, Microsoft Dynamics Agent Hub, Dataiku Agent Hub) confirms that users think of an agent as a single entity and expect one canonical place for everything about it.

## 6. Goals

- Replace AgentDialog and agent-scoped SessionSidebar content with a single Agent Hub panel in the right panel.
- Provide four intuitive entry points that all lead to the same destination.
- Simplify context menus from two ambiguous items to one clear "Agent profile" item.
- Disambiguate global settings with the "App Settings" qualifier on the gear icon and dialog title.
- Preserve all existing configuration capabilities -- zero functionality regression.
- Support side-by-side editing: users can configure an agent while viewing the chat conversation.
- Migrate the deep-link system from `?agent=identity&agentPath=...` to right-panel URL params.
- Register the hub as a `rightpanel` contribution, dogfooding the same extension API that third-party extensions will use.

## 7. Non-Goals

- **Right panel infrastructure** -- the shell-level `PanelGroup`, `rightpanel` contribution slot, panel toggle button, and panel collapse/resize behavior are all Spec 237. This spec assumes they exist and registers into them.
- **Canvas migration** -- moving the canvas from `SessionPage` to a right-panel tab is Spec 237's concern.
- **Global settings internal restructuring** -- restructuring the Settings dialog tabs or adding left-nav layout is out of scope.
- **Mobile-specific redesign** -- the hub follows whatever responsive pattern Spec 237 establishes for the right panel (likely Sheet fallback at `<768px`).
- **Third-party extension API for the right panel** -- that is Phase 3 of the extension platform.
- **Agent creation flow changes** -- the CreateAgentDialog is unchanged.

## 8. Technical Dependencies

| Dependency                                   | Type         | Description                                                                                                                                                                    |
| -------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spec 237 (Right Panel Infrastructure)        | Prerequisite | Provides the shell-level `PanelGroup` in `AppShell`, the `rightpanel` contribution slot in `extension-registry.ts`, the panel toggle button, and responsive collapse behavior. |
| Extension Registry (`extension-registry.ts`) | Existing     | The `SlotContributionMap` interface must include a `rightpanel` slot (added by Spec 237). The hub registers via `initializeExtensions()`.                                      |
| `react-resizable-panels`                     | Existing     | Used by the shell-level right panel for resize handles.                                                                                                                        |
| `@tanstack/react-query`                      | Existing     | Agent data fetching (`useCurrentAgent`, `useUpdateAgent`).                                                                                                                     |
| Zustand                                      | Existing     | App store state management for hub open/close state, active tab, active agent path.                                                                                            |
| `AgentManifest` schema                       | Existing     | `@dorkos/shared/mesh-schemas` -- the agent data model.                                                                                                                         |
| TabbedDialog / left-nav primitives           | Existing     | The existing `TabbedDialog` component and `FieldCard` system provide the tab navigation pattern.                                                                               |

## 9. Detailed Design

### 9.1 Component Architecture

```
AppShell
+-- Sidebar (left, unchanged)
+-- SidebarInset
    +-- Header (with right panel toggle -- Spec 237)
    +-- PanelGroup (horizontal -- Spec 237)
        +-- Panel (Outlet: page content)
        +-- RightPanel (Spec 237)
            +-- Tab bar (icons: agent hub, canvas, future extensions)
            +-- AgentHub                    <-- THIS SPEC
            |   +-- AgentHubHeader          (agent avatar, name, close button)
            |   +-- AgentHubNav             (left-nav tab list)
            |   +-- AgentHubContent         (active tab panel)
            |       +-- OverviewTab
            |       +-- PersonalityTab      (migrated from agent-settings)
            |       +-- SessionsTab         (migrated from session-list)
            |       +-- ChannelsTab         (merged: agent-settings + session-list)
            |       +-- TasksTab            (migrated from session-list)
            |       +-- ToolsTab            (migrated from agent-settings)
            +-- Canvas tab (Spec 237)
```

### 9.2 Hub Registration

The Agent Hub registers as a `rightpanel` contribution in `init-extensions.ts`:

```typescript
import { lazy } from 'react';
import { User } from 'lucide-react';

// In initializeExtensions():
register('rightpanel', {
  id: 'agent-hub',
  title: 'Agent Profile',
  icon: User,
  component: lazy(() =>
    import('@/layers/features/agent-hub').then((m) => ({ default: m.AgentHub }))
  ),
  // Always visible -- the hub works on all routes.
  // When no agent is selected, shows an empty state.
  priority: 1,
});
```

### 9.3 Hub Shell Component

```typescript
// apps/client/src/layers/features/agent-hub/ui/AgentHub.tsx

export interface AgentHubProps {
  /** Injected by the right panel host from URL params or store state. */
  agentPath: string | null;
}

export type AgentHubTab =
  | 'overview'
  | 'personality'
  | 'sessions'
  | 'channels'
  | 'tasks'
  | 'tools';

export function AgentHub({ agentPath }: AgentHubProps) {
  const effectivePath = agentPath ?? useAppStore((s) => s.selectedCwd);
  const { data: agent } = useCurrentAgent(effectivePath);
  const [activeTab, setActiveTab] = useAgentHubStore((s) => [s.activeTab, s.setActiveTab]);

  if (!effectivePath) return <NoAgentSelected />;
  if (!agent) return <AgentNotFound path={effectivePath} />;

  return (
    <AgentHubProvider value={{ agent, projectPath: effectivePath }}>
      <div className="flex h-full flex-col">
        <AgentHubHeader agent={agent} projectPath={effectivePath} />
        <div className="flex min-h-0 flex-1">
          <AgentHubNav activeTab={activeTab} onTabChange={setActiveTab} />
          <AgentHubContent activeTab={activeTab} />
        </div>
      </div>
    </AgentHubProvider>
  );
}
```

### 9.4 Hub Tabs -- Detailed Content

#### 9.4.1 Overview Tab

**Migrates from:** `IdentityTab.tsx` (agent-settings) + `OverviewTabPanel.tsx` (session-list)

**Content:**

- **Hero preview** -- `AgentIdentity` at `lg` size with avatar, name, registration date (from current IdentityTab hero section).
- **Name field** -- debounced input, system agents disabled (from IdentityTab).
- **Slug** -- read-only display (from IdentityTab).
- **Description** -- debounced textarea (from IdentityTab).
- **Runtime selector** -- dropdown: Claude Code, Cursor, Codex, Other (from IdentityTab).
- **Appearance section** -- color picker popover, emoji icon picker popover, "Reset to defaults" button (from IdentityTab).
- **Tags** -- capability tags with add/remove (from IdentityTab).
- **Advanced** -- collapsible project group / namespace (from IdentityTab).
- **Quick stats** -- session count, total messages, agent health status (new, computed from existing queries).
- **Recent sessions** -- top 3 recent sessions with click-to-navigate (migrated from OverviewTabPanel).

The existing `IdentityTab` component can be reused directly with minimal changes -- it already accepts `agent` and `onUpdate` props. The recent sessions section is appended below the identity fields.

#### 9.4.2 Personality Tab

**Migrates from:** `PersonalityTab.tsx` (agent-settings)

**Content (unchanged):**

- Personality summary (trait previews).
- Trait sliders (`TraitSliders` component).
- Custom Instructions (SOUL.md) -- `ConventionFileEditor`.
- Safety Boundaries (NOPE.md) -- `ConventionFileEditor`.
- DorkOS Knowledge Base toggle.
- Response Mode selector.
- Injection Preview.

The existing `PersonalityTab` component is reused as-is. The `PersonalityTabConsumer` pattern (reading agent + callbacks from context) is preserved but migrated to the `AgentHubProvider` context.

#### 9.4.3 Sessions Tab

**Migrates from:** `SessionsView.tsx` (session-list)

**Content:**

- Grouped session list (by time period: Today, Yesterday, Last 7 days, etc.).
- Session item click navigates to that session.
- Session context actions: fork, rename (via existing `SessionsView` callbacks).
- "New session" button at the top.

The existing `SessionsView` component is reused. It currently receives `activeSessionId`, `groupedSessions`, `onSessionClick`, `onForkSession`, and `onRenameSession` as props. The hub tab wrapper fetches these via hooks (`useSessions`, `useTransport`) rather than receiving them from SessionSidebar.

#### 9.4.4 Channels Tab

**Migrates from:** `ChannelsTab.tsx` (agent-settings) + `ConnectionsView.tsx` (session-list, partial)

**Content:**

- **Binding management** (from ChannelsTab) -- list of adapter bindings, add/edit/remove/test/pause bindings, ChannelPicker for adding new channels, BindingDialog for editing, AdapterSetupWizard for new adapter types.
- **Connection status summary** (from ConnectionsView, Channels section only) -- adapter connection status dots (connected/disconnected/error) displayed inline on each bound channel row. This merges what was previously a separate read-only view into the editable binding list.
- Empty states preserved: relay off, no adapters, no bindings.

The existing `ChannelsTab` already shows binding status via `BoundChannelRow`. The merge is additive: the adapter connection state dots from `ConnectionsView` are surfaced on each `BoundChannelRow` (which already has an `adapterState` prop). No new data fetching is needed.

#### 9.4.5 Tasks Tab

**Migrates from:** `TasksView.tsx` (session-list)

**Content:**

- Running tasks with live spinner.
- Upcoming scheduled executions.
- Recent run history (last 5).
- Task presets for empty state.
- "Open Tasks" deep-link to the full Tasks dialog.
- Disabled state when tasks tool is off for the agent.

The existing `TasksView` component is reused. It accepts `toolStatus` and `agentId` props, both derivable from the hub's agent context.

#### 9.4.6 Tools Tab

**Migrates from:** `ToolsTab.tsx` (agent-settings)

**Content (unchanged):**

- Per-agent tool group overrides (Scheduling, Messaging, Agent Discovery, External Channels).
- Global default inheritance with reset-to-default buttons.
- MCP server overview with status dots.
- Reload plugins action.
- Collapsible safety limits (budget: message forwarding depth, hourly rate limit).

The existing `ToolsTab` component is reused as-is. It accepts `agent`, `projectPath`, and `onUpdate` props, all available from the hub context.

### 9.5 State Management

#### 9.5.1 Agent Hub Store (New Zustand Slice)

```typescript
// apps/client/src/layers/features/agent-hub/model/agent-hub-store.ts

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { AgentHubTab } from '../ui/AgentHub';

interface AgentHubState {
  /** Which hub tab is currently active. */
  activeTab: AgentHubTab;
  setActiveTab: (tab: AgentHubTab) => void;

  /**
   * The agent path being viewed in the hub. When null, falls back to
   * selectedCwd from the app store (the currently active agent).
   */
  agentPath: string | null;
  setAgentPath: (path: string | null) => void;

  /** Open the hub for a specific agent, optionally on a specific tab. */
  openHub: (agentPath: string, tab?: AgentHubTab) => void;
}

export const useAgentHubStore = create<AgentHubState>()(
  devtools(
    (set) => ({
      activeTab: 'overview',
      setActiveTab: (tab) => set({ activeTab: tab }),

      agentPath: null,
      setAgentPath: (path) => set({ agentPath: path }),

      openHub: (agentPath, tab) =>
        set({
          agentPath,
          activeTab: tab ?? 'overview',
        }),
    }),
    { name: 'agent-hub' }
  )
);
```

This store is **feature-local** to `agent-hub`, not added to the global `AppState`. This follows the project's pattern of feature-scoped Zustand stores (see `useAgentDialog` in `agent-settings/model/use-agent-dialog.ts`).

#### 9.5.2 Agent Hub Context (React Context)

```typescript
// apps/client/src/layers/features/agent-hub/model/agent-hub-context.tsx

export interface AgentHubContextValue {
  agent: AgentManifest;
  projectPath: string;
  onUpdate: (updates: Partial<AgentManifest>) => void;
  onPersonalityUpdate: (
    updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }
  ) => void;
}
```

This mirrors the existing `AgentDialogContextValue` interface. Hub tab components consume this context identically to how the current `*TabConsumer` wrappers consume `AgentDialogContext`. This enables reuse of the existing tab components (`IdentityTab`, `PersonalityTab`, `ToolsTab`, `ChannelsTab`) without modification.

#### 9.5.3 Dirty State Tracking

Form inputs within the hub use the existing `useDebouncedInput` hook, which auto-saves on blur and after a debounce delay. There is no explicit "Save" button -- changes are persisted immediately via `useUpdateAgent.mutate()`. This matches the current AgentDialog behavior.

Edge cases:

- **Switching agents while editing** -- `useDebouncedInput` flushes pending changes on unmount (existing behavior). The hub re-mounts tab content when `agentPath` changes because the `AgentHubProvider` value changes, triggering a clean re-render.
- **Agent deleted while hub is open** -- `useCurrentAgent` returns `null`, triggering the `<AgentNotFound>` empty state.
- **No agent selected** -- `<NoAgentSelected>` empty state with a prompt to select an agent from the sidebar.

### 9.6 Entry Point Implementation

#### 9.6.1 AgentIdentity Chip (Primary Entry Point)

**File:** `apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx`

The `AgentIdentity` component gains an optional `onClick` prop and a tooltip. When `onClick` is provided, the component renders as an interactive button; otherwise it remains presentational.

```typescript
export interface AgentIdentityProps extends VariantProps<typeof identityVariants> {
  color: string;
  emoji: string;
  name: string;
  detail?: React.ReactNode;
  healthStatus?: AgentHealthStatus;
  className?: string;
  /** When provided, the identity chip becomes interactive (clickable). */
  onClick?: () => void;
}

export function AgentIdentity({
  color, emoji, name, detail, size, healthStatus, className, onClick,
}: AgentIdentityProps) {
  const resolvedSize: IdentitySize = size ?? 'sm';
  const isStacked = resolvedSize === 'md' || resolvedSize === 'lg';

  const content = (
    <span data-slot="agent-identity" className={cn(identityVariants({ size }), className)}>
      <AgentAvatar color={color} emoji={emoji} size={size} healthStatus={healthStatus} />
      {/* ... name and detail rendering unchanged ... */}
    </span>
  );

  if (!onClick) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="cursor-pointer rounded-md transition-opacity hover:opacity-80"
        >
          {content}
        </button>
      </TooltipTrigger>
      <TooltipContent>Agent profile</TooltipContent>
    </Tooltip>
  );
}
```

**Callsites to wire up `onClick`:**

Each component that renders `AgentIdentity` needs to pass an `onClick` that opens the hub. This is done at the feature layer, not the entity layer, to preserve FSD compliance.

| Component           | File                                      | Change                                                                                                                  |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AgentListItem`     | `dashboard-sidebar/ui/AgentListItem.tsx`  | Pass `onClick` to the inner `AgentIdentity` that calls `useAgentHubStore.getState().openHub(path)` + opens right panel. |
| `ChatStatusSection` | `chat/ui/status/ChatStatusSection.tsx`    | Pass `onClick` to the agent identity chip in the status bar.                                                            |
| `AgentCommandItem`  | `command-palette/ui/AgentCommandItem.tsx` | Already navigates to agent actions; no change needed.                                                                   |
| `ConversationRow`   | `relay/ui/ConversationRow.tsx`            | Pass `onClick` to open hub for the conversation's agent.                                                                |
| `AgentCard`         | `mesh/ui/AgentCard.tsx`                   | Pass `onClick` to open hub for the mesh agent.                                                                          |
| `ExistingAgentCard` | `discovery/ui/ExistingAgentCard.tsx`      | Pass `onClick` to open hub for the discovered agent.                                                                    |

#### 9.6.2 Context Menu Simplification

**Files:**

- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentContextMenu.tsx`
- `apps/client/src/layers/features/dashboard-sidebar/ui/AgentListItem.tsx`

**Before (current):**

```
Pin agent / Unpin agent
---
Manage agent        (ListTree icon)
Edit settings       (Settings icon)
---
New session         (Plus icon)
```

**After:**

```
Pin agent / Unpin agent
---
Agent profile       (User icon)
New session         (Plus icon)
```

Changes to `AgentContextMenu`:

```typescript
interface AgentContextMenuProps {
  children: ReactNode;
  agentPath: string;
  isPinned: boolean;
  onTogglePin: () => void;
  onOpenProfile: () => void;  // Replaces onManage + onEditSettings
  onNewSession: () => void;
}

export function AgentContextMenu({
  children, isPinned, onTogglePin, onOpenProfile, onNewSession,
}: AgentContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onTogglePin}>
          {isPinned ? (
            <><PinOff className="mr-2 size-4" /> Unpin agent</>
          ) : (
            <><Pin className="mr-2 size-4" /> Pin agent</>
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onOpenProfile}>
          <User className="mr-2 size-4" />
          Agent profile
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onNewSession}>
          <Plus className="mr-2 size-4" />
          New session
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
```

The same changes apply to the `DropdownMenu` inside `AgentListItem`. The `onManage` and `onEditSettings` props are replaced by a single `onOpenProfile` prop.

**Parent changes in `DashboardSidebar.tsx`:**

The `handleManage` and `handleEditSettings` callbacks are replaced by a single `handleOpenProfile`:

```typescript
const handleOpenProfile = useCallback(
  (path: string) => {
    useAgentHubStore.getState().openHub(path);
    // Spec 237 provides the mechanism to open the right panel
    openRightPanel();
  },
  [openRightPanel]
);
```

#### 9.6.3 Command Palette Integration

**File:** `apps/client/src/layers/features/command-palette/model/palette-contributions.ts`

Add a new feature item:

```typescript
{
  id: 'agent-profile',
  label: 'Agent Profile',
  icon: 'User',
  action: 'openAgentProfile',
  category: 'feature',
  priority: 5,
},
```

The palette action handler (`usePaletteActions` or equivalent) maps `'openAgentProfile'` to:

```typescript
case 'openAgentProfile':
  // Opens the hub for the currently selected agent
  const cwd = useAppStore.getState().selectedCwd;
  if (cwd) {
    useAgentHubStore.getState().openHub(cwd);
    openRightPanel();
  }
  break;
```

Additionally, the agent sub-menu in the command palette (accessed by selecting an agent) gains an "Agent profile" action that opens the hub for that specific agent:

```typescript
// In AgentSubMenu.tsx, add alongside existing actions:
<CommandItem onSelect={() => {
  useAgentHubStore.getState().openHub(agent.projectPath);
  openRightPanel();
  onClose();
}}>
  <User className="mr-2 size-4" />
  Agent profile
</CommandItem>
```

#### 9.6.4 Keyboard Shortcut

**File:** `apps/client/src/layers/shared/lib/shortcuts.ts`

Add a new shortcut definition:

```typescript
AGENT_PROFILE: {
  id: 'agent-profile',
  key: 'mod+shift+a',
  label: 'Agent profile',
  group: 'navigation',
},
```

The key combo `Cmd+Shift+A` (Mac) / `Ctrl+Shift+A` (Windows) is chosen because:

- `Cmd+Shift` is the established modifier pattern for feature shortcuts (`Cmd+Shift+N` for new session).
- `A` is mnemonic for "Agent".
- It does not conflict with any existing shortcut in the `SHORTCUTS` registry.

This shortcut toggles the Agent Hub in the right panel for the currently selected agent. If the hub is already open for the current agent, it closes the right panel. The handler:

```typescript
// In the global shortcut listener (keyboard-shortcuts.ts or equivalent):
case SHORTCUTS.AGENT_PROFILE.id:
  const cwd = useAppStore.getState().selectedCwd;
  if (cwd) {
    const hubStore = useAgentHubStore.getState();
    if (isRightPanelOpen() && hubStore.agentPath === cwd) {
      closeRightPanel();
    } else {
      hubStore.openHub(cwd);
      openRightPanel();
    }
  }
  break;
```

### 9.7 Global Settings Disambiguation

#### 9.7.1 Gear Icon Tooltip

**File:** `apps/client/src/layers/features/session-list/model/sidebar-contributions.ts`

Change the settings button label:

```typescript
{
  id: 'settings',
  icon: Settings,
  label: 'App Settings',  // was: 'Settings'
  onClick: () => { /* ... */ },
  priority: 2,
},
```

This label is used as the `aria-label` in `SidebarFooterBar`. A visible tooltip is also added:

**File:** `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`

Wrap the settings button in a `Tooltip` component:

```typescript
<Tooltip>
  <TooltipTrigger asChild>
    <button onClick={handleClick} aria-label={label}>
      <Icon className="size-(--size-icon-sm)" />
    </button>
  </TooltipTrigger>
  <TooltipContent>App Settings</TooltipContent>
</Tooltip>
```

#### 9.7.2 Settings Dialog Title

**File:** `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`

Change the dialog title from "Settings" to "App Settings".

### 9.8 Deep-Link Migration

The current agent dialog deep-link system uses URL search params:

- `?agent=identity` -- opens AgentDialog to the Identity tab
- `?agentPath=/path/to/agent` -- targets a specific agent

This migrates to the right panel's URL param system (established by Spec 237). The new format:

```
?panel=agent-hub&hubTab=personality&agentPath=/path/to/agent
```

Where:

- `panel=agent-hub` -- tells the right panel host to activate the Agent Hub tab
- `hubTab=personality` -- tells the hub which internal tab to show
- `agentPath=/path/to/agent` -- targets a specific agent (optional; defaults to `selectedCwd`)

The `useAgentDialogDeepLink` hook is replaced by a new `useAgentHubDeepLink` hook:

```typescript
export function useAgentHubDeepLink() {
  const search = useSearch({ strict: false });
  return {
    hubTab: (search.hubTab as AgentHubTab) ?? null,
    agentPath: (search.agentPath as string) ?? null,
  };
}
```

A migration redirect ensures old URLs still work:

```typescript
// In router configuration or a redirect guard:
if (search.agent) {
  // Map old agent dialog tab names to hub tab names
  const TAB_MIGRATION: Record<string, AgentHubTab> = {
    identity: 'overview',
    personality: 'personality',
    channels: 'channels',
    tools: 'tools',
  };
  const hubTab = TAB_MIGRATION[search.agent] ?? 'overview';
  navigate({
    search: { panel: 'agent-hub', hubTab, agentPath: search.agentPath },
    replace: true,
  });
}
```

### 9.9 Removal Plan

#### Files to Delete

| File                                                              | Reason                         |
| ----------------------------------------------------------------- | ------------------------------ |
| `features/agent-settings/ui/AgentDialog.tsx`                      | Replaced by `AgentHub`         |
| `features/agent-settings/ui/consumers/IdentityTabConsumer.tsx`    | Hub uses direct context        |
| `features/agent-settings/ui/consumers/PersonalityTabConsumer.tsx` | Hub uses direct context        |
| `features/agent-settings/ui/consumers/ToolsTabConsumer.tsx`       | Hub uses direct context        |
| `features/agent-settings/ui/consumers/ChannelsTabConsumer.tsx`    | Hub uses direct context        |
| `features/agent-settings/ui/NoAgentFallback.tsx`                  | Replaced by hub empty states   |
| `features/agent-settings/model/agent-dialog-context.tsx`          | Replaced by `AgentHubProvider` |
| `features/agent-settings/model/use-agent-dialog.ts`               | Replaced by `useAgentHubStore` |
| `features/agent-settings/__tests__/AgentDialog.test.tsx`          | Replaced by hub tests          |
| `widgets/app-layout/model/wrappers/AgentDialogWrapper.tsx`        | No longer needed               |

#### Files to Modify

| File                                                      | Change                                                                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `widgets/app-layout/model/dialog-contributions.ts`        | Remove the `agent` dialog contribution entry                                                                                                                      |
| `shared/model/app-store/app-store-panels.ts`              | Remove `agentDialogOpen`, `agentDialogInitialTab`, `setAgentDialogOpen`, `openAgentDialogToTab`, `AgentDialogTab` type                                            |
| `shared/model/app-store/app-store-types.ts`               | Updated `PanelsSlice` interface                                                                                                                                   |
| `dashboard-sidebar/ui/AgentContextMenu.tsx`               | Replace `onManage` + `onEditSettings` with `onOpenProfile`                                                                                                        |
| `dashboard-sidebar/ui/AgentListItem.tsx`                  | Replace `onManage` + `onEditSettings` with `onOpenProfile`; wire `AgentIdentity` onClick                                                                          |
| `dashboard-sidebar/ui/DashboardSidebar.tsx`               | Replace `handleManage` + `handleEditSettings` with `handleOpenProfile`                                                                                            |
| `entities/agent/ui/AgentIdentity.tsx`                     | Add optional `onClick` prop and tooltip                                                                                                                           |
| `session-list/model/sidebar-contributions.ts`             | Change settings label to "App Settings"                                                                                                                           |
| `session-list/ui/SidebarFooterBar.tsx`                    | Add tooltip to settings button                                                                                                                                    |
| `features/settings/ui/SettingsDialog.tsx`                 | Change title to "App Settings"                                                                                                                                    |
| `features/command-palette/model/palette-contributions.ts` | Add "Agent Profile" feature item                                                                                                                                  |
| `shared/lib/shortcuts.ts`                                 | Add `AGENT_PROFILE` shortcut definition                                                                                                                           |
| `app/init-extensions.ts`                                  | Register Agent Hub as `rightpanel` contribution                                                                                                                   |
| `session-list/ui/SessionSidebar.tsx`                      | Remove agent-scoped content (Overview agent-specific sections, Connections, Schedules absorbed into hub); retain session list as sidebar-level session navigation |

#### Content That Remains in SessionSidebar

The session sidebar does not disappear entirely. It retains:

- **Session list** -- the primary session navigation for the left sidebar.
- **Session header** -- agent name, dashboard/new-session buttons.
- **Session tab row** -- but with fewer tabs (Overview with non-agent-specific content, Sessions).

The Connections tab, Schedules tab, and agent-specific Overview content (agent identity, promo slots) move to the hub. The session sidebar becomes a streamlined session navigator.

#### SessionSidebar Post-Migration Scope

The current `SessionSidebar.tsx` renders four tab panels via `SidebarTabRow` (`overview | sessions | schedules | connections`) plus a header (`SidebarAgentHeader`), multiple hooks (`useConnectionsStatus`, `useActiveTaskRunCount`, `useAgentToolStatus`), and three view components (`OverviewTabPanel`, `TasksView`, `ConnectionsView`). After the hub migration, its scope narrows significantly.

**What gets removed from SessionSidebar:**

| Current sub-component / hook                                     | Destination in hub                                 |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `OverviewTabPanel` (agent-specific stats, recent sessions promo) | Hub Overview tab                                   |
| `ConnectionsView` (adapter connection status)                    | Hub Channels tab (merged)                          |
| `TasksView` (schedules, running tasks, recent runs)              | Hub Tasks tab                                      |
| `useConnectionsStatus` hook                                      | Consumed by hub Channels tab                       |
| `useActiveTaskRunCount` hook                                     | Consumed by hub Tasks tab                          |
| `useAgentToolStatus` hook                                        | Consumed by hub Tasks/Tools tabs                   |
| `useSidebarTabs` (manages 4-tab visibility logic)                | Replaced by simpler 1-tab setup                    |
| `useTaskNotifications` side-effect hook                          | Moves to hub or app-level                          |
| `SidebarTabRow` with `schedules` and `connections` tabs          | Removed; no tab row needed if only sessions remain |

**What remains in SessionSidebar:**

- `SidebarAgentHeader` -- agent name display, "Dashboard" button, "New session" button. Unchanged.
- `SessionsView` -- the grouped session list (`groupedSessions` by time period) with click-to-navigate, fork, and rename actions. This is the core value of the left sidebar on the `/session` route.
- `handleSessionClick`, `handleForkSession`, `handleRenameSession` callbacks and the `useSessions` hook.
- `useSidebarNavigation` for `handleNewSession`, `handleDashboard`.

The post-migration component becomes roughly:

```typescript
export function SessionSidebar() {
  const { sessions, activeSessionId } = useSessions();
  const { handleNewSession, handleSessionClick, handleDashboard } = useSidebarNavigation();
  // ... fork/rename callbacks remain ...

  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);

  return (
    <>
      <SidebarAgentHeader
        agentName={currentAgent ? getAgentDisplayName(currentAgent) : undefined}
        onDashboard={handleDashboard}
        onNewSession={handleNewSession}
      />
      <SidebarContent data-testid="session-list">
        <SessionsView
          activeSessionId={activeSessionId}
          groupedSessions={groupedSessions}
          onSessionClick={handleSessionClick}
          onForkSession={handleForkSession}
          onRenameSession={handleRenameSession}
        />
      </SidebarContent>
    </>
  );
}
```

**Rename consideration:** The component could be renamed to `SessionListSidebar` or `SessionNavigator` to reflect its narrowed scope. This is optional polish -- the existing name is not misleading since it still lives in the `session-list` feature module, and renaming can be done in a follow-up without breaking changes.

**Where it appears:** Only on the `/session` route, only when an agent is selected. The sidebar level switching (`setSidebarLevel('session')`) still works -- it just shows a simpler surface. The `SidebarTabRow` component can be removed entirely from `SessionSidebar` since there is only one view (sessions). If a future need arises for additional sidebar tabs, the tab row can be reintroduced.

### 9.10 File Organization

```
apps/client/src/layers/features/agent-hub/
+-- ui/
|   +-- AgentHub.tsx              (hub shell, provider, routing)
|   +-- AgentHubHeader.tsx        (agent avatar + name + close)
|   +-- AgentHubNav.tsx           (left-nav tab list)
|   +-- AgentHubContent.tsx       (tab panel switcher)
|   +-- tabs/
|   |   +-- OverviewTab.tsx       (identity + quick stats + recent sessions)
|   |   +-- PersonalityTab.tsx    (re-exports from agent-settings)
|   |   +-- SessionsTab.tsx       (wrapper around SessionsView)
|   |   +-- ChannelsTab.tsx       (re-exports from agent-settings)
|   |   +-- TasksTab.tsx          (wrapper around TasksView)
|   |   +-- ToolsTab.tsx          (re-exports from agent-settings)
|   +-- NoAgentSelected.tsx       (empty state)
|   +-- AgentNotFound.tsx         (error state)
+-- model/
|   +-- agent-hub-store.ts        (Zustand store)
|   +-- agent-hub-context.tsx     (React context)
|   +-- use-agent-hub-deep-link.ts
+-- __tests__/
|   +-- AgentHub.test.tsx
|   +-- AgentHubNav.test.tsx
|   +-- OverviewTab.test.tsx
|   +-- entry-points.test.tsx
+-- index.ts                      (barrel exports)
```

The tab components within `agent-hub/ui/tabs/` are thin wrappers that read from `AgentHubProvider` context and delegate to the existing tab implementations in `agent-settings/` and `session-list/`. This approach:

- Avoids duplicating the complex tab UIs.
- Preserves FSD compliance (the `agent-hub` feature imports from `agent-settings` and `session-list` -- features may compose sibling features' UI components per the cross-module rule).
- Enables incremental migration: tabs can be moved fully into `agent-hub` later if the `agent-settings` feature is retired.

Example wrapper:

```typescript
// agent-hub/ui/tabs/PersonalityTab.tsx
import { PersonalityTab as PersonalityTabInner } from '@/layers/features/agent-settings';
import { useAgentHubContext } from '../../model/agent-hub-context';

export function PersonalityTab() {
  const { agent, onPersonalityUpdate } = useAgentHubContext();
  const augmented = agent as AgentManifest & { soulContent?: string | null; nopeContent?: string | null };
  return (
    <PersonalityTabInner
      agent={agent}
      soulContent={augmented.soulContent ?? null}
      nopeContent={augmented.nopeContent ?? null}
      onUpdate={onPersonalityUpdate}
    />
  );
}
```

## 10. User Experience

### 10.1 Journey: Clicking an Agent's Identity Chip

1. User sees an agent's avatar + name in the dashboard sidebar, chat status bar, or mesh view.
2. User hovers over the chip. Tooltip reads "Agent profile".
3. User clicks the chip.
4. The right panel opens (or activates the Agent Hub tab if already open to canvas).
5. The Agent Hub shows the Overview tab for that agent.
6. User can navigate between tabs (Personality, Sessions, Channels, Tasks, Tools) via the left-nav.
7. Changes auto-save on blur/debounce. User sees the chat update in real-time on the left.

### 10.2 Journey: Context Menu

1. User right-clicks (or long-presses on mobile) an agent row in the sidebar.
2. Context menu appears with three groups: Pin/Unpin, Agent profile, New session.
3. User selects "Agent profile".
4. Right panel opens to the Agent Hub for that agent.

### 10.3 Journey: Command Palette

1. User presses `Cmd+K` to open the command palette.
2. User types "profile" or "agent".
3. "Agent Profile" appears in the Features group.
4. User selects it. Right panel opens to the hub for the current agent.

Alternatively, from the agent sub-menu:

1. User selects an agent in the palette.
2. Agent actions sub-menu shows: Switch to, New session, **Agent profile**.
3. User selects "Agent profile". Hub opens for that agent.

### 10.4 Journey: Keyboard Shortcut

1. User presses `Cmd+Shift+A`.
2. If the hub is closed: right panel opens to the hub for the current agent.
3. If the hub is already open for the current agent: right panel closes (toggle behavior).

### 10.5 What Changes vs. Current

| Current                                                         | New                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| "Manage agent" opens session sidebar                            | "Agent profile" opens hub in right panel                                 |
| "Edit settings" opens modal dialog                              | "Agent profile" opens hub in right panel                                 |
| AgentIdentity chip is passive                                   | AgentIdentity chip opens hub on click                                    |
| Gear icon has no tooltip                                        | Gear icon shows "App Settings" tooltip                                   |
| Settings dialog titled "Settings"                               | Settings dialog titled "App Settings"                                    |
| Channels config and connection status are in different surfaces | Merged into one Channels tab in the hub                                  |
| Agent sessions in left sidebar tabs                             | Agent sessions in hub Sessions tab (and still available in left sidebar) |

### 10.6 Migration Experience

**What existing users will notice:** Sessions, connection status, and scheduled tasks moved from the left sidebar tabs to the Agent Profile panel on the right. Agent identity, personality, and channel settings moved from a modal dialog to the same panel. Everything about your agent is now in one place -- click the agent's avatar or name to open it.

**Before/after for common tasks:**

| Task                    | Before                                                                     | After                                                     |
| ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Change agent name       | Right-click agent --> "Edit settings" --> Identity tab --> edit name field | Click agent avatar --> Overview tab --> edit name field   |
| Check agent sessions    | Right-click agent --> "Manage agent" --> Sessions tab in left sidebar      | Click agent avatar --> Sessions tab in right panel        |
| Configure channels      | Right-click agent --> "Edit settings" --> Channels tab in modal dialog     | Click agent avatar --> Channels tab in right panel        |
| View connection status  | Right-click agent --> "Manage agent" --> Connections tab in left sidebar   | Click agent avatar --> Channels tab (status shown inline) |
| Edit personality/traits | Right-click agent --> "Edit settings" --> Personality tab in modal dialog  | Click agent avatar --> Personality tab in right panel     |
| Check scheduled tasks   | Right-click agent --> "Manage agent" --> Schedules tab in left sidebar     | Click agent avatar --> Tasks tab in right panel           |

The key UX improvement: users no longer need to distinguish between "Manage agent" and "Edit settings" or remember which surface holds which information. A single "Agent profile" action (or a direct click on the agent's identity chip) opens everything in one panel.

**Suggested release note:**

> **Agent Profile panel** -- All agent settings and activity are now in one place. Click any agent's avatar to open the new Agent Profile panel on the right side of the screen. Identity, personality, channels, sessions, tasks, and tools are organized as tabs in a single panel -- no more switching between the sidebar and a settings dialog. The right-click menu has been simplified from two items ("Manage agent" / "Edit settings") to one clear action: "Agent profile." You can also press `Cmd+Shift+A` (`Ctrl+Shift+A` on Windows/Linux) to toggle the panel.

## 11. Testing Strategy

### 11.1 Unit Tests

| Test File                                   | Coverage                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-hub/__tests__/AgentHub.test.tsx`     | Hub shell rendering: with agent, without agent, agent not found. Tab switching. Agent path changes.                                    |
| `agent-hub/__tests__/AgentHubNav.test.tsx`  | Tab rendering, active tab highlighting, tab click callbacks.                                                                           |
| `agent-hub/__tests__/OverviewTab.test.tsx`  | Identity fields rendering, debounced input behavior, color/icon pickers, recent sessions list.                                         |
| `agent-hub/__tests__/entry-points.test.tsx` | Each entry point (identity chip click, context menu, command palette, shortcut) correctly calls `openHub()` and opens the right panel. |

### 11.2 Component Migration Tests

For each migrated tab, verify that rendering within the hub context produces the same output as within the old AgentDialog context:

- `PersonalityTab` -- trait sliders, convention editors, preview render identically.
- `ChannelsTab` -- all four states (relay off, no adapters, no bindings, bindings exist) render correctly.
- `ToolsTab` -- tool group rows, MCP servers, limits section.
- `SessionsTab` -- grouped session list, fork/rename actions.
- `TasksTab` -- running/upcoming/recent sections, empty state presets.

**Concrete migration test example** -- verifying that `PersonalityTab` renders identically within the new `AgentHubProvider` context:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentHubProvider } from '@/layers/features/agent-hub/model/agent-hub-context';
import { PersonalityTab } from '@/layers/features/agent-hub/ui/tabs/PersonalityTab';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const mockTransport = createMockTransport();

const mockAgent: AgentManifest = {
  id: 'test-agent-id',
  name: 'Test Agent',
  slug: 'test-agent',
  color: '#6366f1',
  emoji: '🤖',
  traits: { creativity: 0.7, verbosity: 0.5, formality: 0.6, humor: 0.4 },
  conventions: { soul: null, nope: null },
  responseMode: 'normal',
  knowledgeBaseEnabled: true,
  // ... other required fields with test defaults
} as AgentManifest;

function HubWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <AgentHubProvider
          value={{
            agent: mockAgent,
            projectPath: '/test/agent/path',
            onUpdate: vi.fn(),
            onPersonalityUpdate: vi.fn(),
          }}
        >
          {children}
        </AgentHubProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('PersonalityTab (hub migration parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders trait sliders matching the agent personality config', () => {
    render(<PersonalityTab />, { wrapper: HubWrapper });

    // Trait sliders should appear for each trait dimension
    expect(screen.getByText('Creativity')).toBeInTheDocument();
    expect(screen.getByText('Verbosity')).toBeInTheDocument();
    expect(screen.getByText('Formality')).toBeInTheDocument();
    expect(screen.getByText('Humor')).toBeInTheDocument();
  });

  it('renders convention file editors for SOUL.md and NOPE.md', () => {
    render(<PersonalityTab />, { wrapper: HubWrapper });

    expect(screen.getByText(/Custom Instructions/i)).toBeInTheDocument();
    expect(screen.getByText(/Safety Boundaries/i)).toBeInTheDocument();
  });

  it('renders response mode selector with current value', () => {
    render(<PersonalityTab />, { wrapper: HubWrapper });

    expect(screen.getByText(/Response Mode/i)).toBeInTheDocument();
  });
});
```

This test verifies that `PersonalityTab`, when rendered inside the new `AgentHubProvider` context instead of the old `AgentDialogContext`, still produces the same visible output -- trait sliders, convention editors, and response mode selector. The same pattern applies to each migrated tab: wrap in `HubWrapper`, assert the same key elements are present.

### 11.3 Integration Tests

| Test                        | Description                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Context menu simplification | Verify "Agent profile" appears; verify "Manage agent" and "Edit settings" do NOT appear.                               |
| Deep-link migration         | Navigate to `?agent=identity&agentPath=/foo` and verify redirect to `?panel=agent-hub&hubTab=overview&agentPath=/foo`. |
| Settings disambiguation     | Verify gear icon `aria-label` is "App Settings". Verify settings dialog title is "App Settings".                       |
| AgentIdentity interactivity | Verify tooltip "Agent profile" appears on hover. Verify click fires `onClick`.                                         |

### 11.4 Test Pattern

All hub tests follow the project's established testing conventions:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';

// ... standard wrapper with QueryClientProvider, TransportProvider, TooltipProvider
```

## 12. Performance Considerations

### 12.1 Lazy Tab Rendering

Hub tabs are rendered lazily -- only the active tab's content mounts. Inactive tabs are hidden via CSS (`display: none` or conditional rendering). This prevents unnecessary data fetching and rendering for tabs the user hasn't visited.

The hub component itself is lazy-loaded at the registration site:

```typescript
component: lazy(() => import('@/layers/features/agent-hub').then(m => ({ default: m.AgentHub }))),
```

This ensures the hub's code is only loaded when the right panel is first opened, keeping the initial bundle lean.

### 12.2 Agent Data Fetching

The hub relies on `useCurrentAgent(effectivePath)` which uses TanStack Query with `staleTime` caching. Switching between the chat and the hub does not re-fetch agent data. The query key includes the path, so switching agents invalidates naturally.

### 12.3 Form State Management

The `useDebouncedInput` hook (already used throughout the codebase) debounces mutations by 300ms. This prevents excessive network requests while maintaining a responsive feel. No additional optimization is needed.

### 12.4 Panel Resize Performance

The right panel uses `react-resizable-panels` (established by Spec 237). The hub content uses percentage-based layouts that reflow smoothly during resize. No fixed-width assumptions.

## 13. Security Considerations

### 13.1 Agent Path Validation

The `agentPath` URL parameter is validated before use:

- Must be an absolute filesystem path.
- Passed to `useCurrentAgent()` which calls `transport.getAgentByPath()` -- the server validates the path exists and is within an allowed directory.
- The server returns `null` for non-existent or unauthorized paths, which the hub handles with the `<AgentNotFound>` empty state.

### 13.2 Form Input Sanitization

All user inputs (name, description, tags, namespace) flow through the same `useUpdateAgent.mutate()` pathway that the current AgentDialog uses. Server-side validation via the `AgentManifest` Zod schema is unchanged. No new input vectors are introduced.

### 13.3 URL Parameter Safety

The `hubTab` URL parameter is validated against the `AgentHubTab` union type. Invalid values fall back to `'overview'`. The `agentPath` parameter is URL-decoded and passed to the server API, which applies its own path validation.

## 14. Documentation

### 14.1 User-Facing Changes

- **Tooltip on AgentIdentity chips** -- "Agent profile" tooltip appears on hover. This is self-documenting.
- **Context menu change** -- users who relied on "Manage agent" or "Edit settings" will find them replaced by "Agent profile". The destination consolidates both previous destinations.
- **Keyboard shortcut** -- `Cmd+Shift+A` / `Ctrl+Shift+A` appears in the keyboard shortcuts panel (accessed via `?`).
- **Settings disambiguation** -- the gear icon tooltip now reads "App Settings" and the dialog title is "App Settings".

### 14.2 Developer Documentation

Update `contributing/` guides:

- **FSD architecture guide** -- add `agent-hub` as a feature module with its cross-feature composition pattern.
- **Extension registry guide** -- document the `rightpanel` contribution slot with the Agent Hub as the first built-in example.
- **Keyboard shortcuts guide** -- add `AGENT_PROFILE` to the shortcuts reference.

## 15. Implementation Phases

### Phase 1: Hub Shell + Overview Tab

- Create the `agent-hub` feature module with FSD structure.
- Implement `AgentHub`, `AgentHubHeader`, `AgentHubNav`, `AgentHubContent` components.
- Implement `AgentHubStore` and `AgentHubProvider`.
- Build the Overview tab by composing existing `IdentityTab` content + recent sessions from `OverviewTabPanel`.
- Register the hub as a `rightpanel` contribution in `init-extensions.ts`.
- Implement the `<NoAgentSelected>` and `<AgentNotFound>` empty states.
- Write unit tests for the hub shell and Overview tab.

### Phase 2: Migrate Remaining Tabs

- Implement hub tab wrappers for Personality, Sessions, Channels, Tasks, and Tools.
- Each wrapper reads from `AgentHubProvider` and delegates to the existing tab component.
- Verify feature parity with existing AgentDialog and SessionSidebar tabs.
- Write migration tests confirming identical rendering.

### Phase 3: Entry Points, Disambiguation, and Cleanup

- Make `AgentIdentity` chip interactive (add `onClick` + tooltip).
- Wire up all callsites that render `AgentIdentity` to pass `onClick`.
- Simplify `AgentContextMenu` and `AgentListItem` dropdown (remove "Manage agent" + "Edit settings", add "Agent profile").
- Update `DashboardSidebar` to use `handleOpenProfile` instead of `handleManage` + `handleEditSettings`.
- Add "Agent Profile" to command palette contributions.
- Add `AGENT_PROFILE` keyboard shortcut.
- Add "App Settings" tooltip and dialog title change.
- Implement deep-link migration (old `?agent=` params redirect to new `?panel=agent-hub` params).
- Remove `AgentDialog`, `AgentDialogWrapper`, consumer wrappers, `useAgentDialog` store, and related `PanelsSlice` fields.
- Remove the `agent` entry from `DIALOG_CONTRIBUTIONS`.
- Streamline `SessionSidebar` by removing absorbed agent-specific content.
- Update all tests.

## 16. Open Questions

1. **Hub width default** -- What should the default width of the right panel be when the hub is the active tab? The ideation doc does not specify. Recommendation: match the current canvas default width, which Spec 237 will establish. The hub should be comfortably readable at 360-420px.

2. **Session sidebar simplification scope** -- After absorbing Overview, Connections, and Schedules tabs into the hub, how much of the session sidebar remains? The current spec proposes keeping it as a streamlined session navigator (session list + header). Should the session sidebar be further simplified or eventually removed in a follow-up spec?

3. **Tab persistence across agents** -- When the user switches from Agent A's Personality tab to Agent B, should the hub remember "Personality" as the active tab or reset to Overview? Recommendation: preserve the active tab across agent switches to minimize cognitive disruption.

4. **Right panel toggle button indicator** -- Spec 237 describes a dot indicator on the right panel toggle when the panel has active content while closed. Does the hub count as "active content" that should show this indicator? If so, should it only show when there are unsaved changes?

## 17. Related ADRs

| ADR                                                                                                                             | Relevance                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [ADR-0002: Adopt Feature-Sliced Design](../decisions/0002-adopt-feature-sliced-design.md)                                       | The hub is a new FSD feature module that composes UI from sibling features. |
| [ADR-0005: Zustand UI State, TanStack Query Server State](../decisions/0005-zustand-ui-state-tanstack-query-server-state.md)    | Hub store uses Zustand; agent data uses TanStack Query.                     |
| [ADR-0199: Generic register API with SlotContributionMap](../decisions/0199-generic-register-api-with-slot-contribution-map.md) | Hub registers via the `register('rightpanel', ...)` API.                    |
| [ADR-0200: App-Layer Synchronous Extension Initialization](../decisions/0200-app-layer-synchronous-extension-initialization.md) | Hub registration happens in `initializeExtensions()`.                       |
| [ADR-0108: Centralized Shortcut Registry](../decisions/0108-centralized-shortcut-registry.md)                                   | New `AGENT_PROFILE` shortcut follows the centralized registry pattern.      |
| [ADR-0105: Header as Agent Identity Surface](../decisions/0105-header-as-agent-identity-surface.md)                             | The identity chip as entry point extends this pattern.                      |
| [ADR-0107: CSS Hidden Toggle for Sidebar View Persistence](../decisions/0107-css-hidden-toggle-for-sidebar-view-persistence.md) | Tab persistence pattern for inactive hub tabs.                              |
| [ADR-0166: Remove Mesh Agents Tab -- Clean Break](../decisions/0166-remove-mesh-agents-tab-clean-break.md)                      | Precedent for removing a UI surface with a clean migration path.            |

## 18. References

- [Ideation: Settings UI/UX and Disambiguation](../specs/settings-ui-ux-disambiguation/01-ideation.md) -- parent ideation document with all research and decisions.
- [Research: Multi-Panel Toggle UX Patterns](../research/20260328_multi_panel_toggle_ux_patterns.md) -- right panel toggle design research.
- [Research: Tab Overflow Settings Navigation Patterns](../research/20260311_tab_overflow_settings_navigation_patterns.md) -- left-nav sidebar layout recommendation for 6+ tabs.
- [Research: Switch Agent via Identity Chip](../research/20260310_switch_agent_via_identity_chip.md) -- identity chip as interactive element pattern.
- Spec 237 (Right Panel Infrastructure) -- prerequisite spec for the shell-level right panel.
