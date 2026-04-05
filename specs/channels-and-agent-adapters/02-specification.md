---
slug: channels-and-agent-adapters
status: specified
created: 2026-04-04
design-session: .dork/visual-companion/70420-1775346246
---

# Channels & Agent Adapters — Connectivity UX Redesign

**Status:** Specified
**Authors:** Dorian + Claude Code
**Date:** 2026-04-04

## Overview

Redesign the connectivity UX across 6 surfaces to adopt industry-standard "Channels" vocabulary, add agent-first binding management, and integrate channel/adapter configuration into the Settings dialog. This eliminates the adapter-centric mental model that forces users to context-switch between global panels and agent configuration.

## Background / Problem Statement

The relay adapter system works mechanically but has three structural UX problems:

1. **Wrong vocabulary.** "Relay Adapters" means nothing outside this codebase. The industry uses "Channels" for Slack, Telegram, webhook endpoints.
2. **Infrastructure-centric config.** The only management surface is the global Relay Panel. Agent Dialog shows binding counts but offers no inline management — users must close the agent dialog, navigate to the Relay Panel, find the right adapter, create a binding, then return.
3. **No settings integration.** Channel management and agent adapter configuration don't appear in the Settings dialog where users expect system-level configuration.

**User impact:** Kai sets up 10 agents and needs 30+ context switches. Priya can't see fleet-wide connectivity at a glance.

## Goals

- Rename all user-facing "Relay Adapter" references to "Channels"
- Add inline binding management to the Agent Dialog (create, edit, remove bindings without leaving)
- Add a Channels tab to Settings for system-level channel management
- Expand the Agents tab in Settings with agent adapter runtime configuration
- Show channel badges on the Agents Page for fleet visibility
- Update Session Sidebar vocabulary
- Rename and update the Channels Panel (formerly Relay Panel)
- Establish bidirectional navigation between all 6 surfaces

## Non-Goals

- Internal code refactoring (adapter class names, schema field names, file names stay as-is)
- New adapter type implementations
- New agent adapter runtime implementations (just the config surface)
- Topology graph changes
- Mobile-specific layouts
- Relay message routing or binding resolution logic changes
- Agent-to-agent relay configuration
- Batch binding operations

## Technical Dependencies

- React 19 + Vite 6
- Tailwind CSS 4 + shadcn/ui (new-york style)
- TanStack Query for server state
- Zustand for UI state (app-store panel open/close)
- Lucide React icons (Radio icon for Channels)
- Existing binding entity hooks (`useBindings`, `useCreateBinding`, `useUpdateBinding`, `useDeleteBinding`)
- Existing relay entity hooks (`useAdapterCatalog`, `useRelayAdapters`, `useToggleAdapter`, `useRemoveAdapter`)
- Existing components: `BindingDialog`, `QuickBindingPopover`, `AdapterSetupWizard`, `CatalogCard`

## Detailed Design

### Vocabulary Mapping

All user-facing strings change. Internal code is untouched.

| Location                      | Current                                      | New                                                                         |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| Agent Dialog tab label        | "Connections"                                | "Channels"                                                                  |
| Agent Dialog tab icon         | `Plug2`                                      | `Radio`                                                                     |
| Agent Dialog subsystem row    | "Relay Bindings"                             | _(removed — replaced by inline channel list)_                               |
| Settings sidebar              | _(none)_                                     | "Channels" (new tab, `Radio` icon)                                          |
| Session Sidebar group label   | "Adapters"                                   | "Channels"                                                                  |
| Session Sidebar disabled text | "Relay disabled for this agent"              | "Channels disabled for this agent"                                          |
| Session Sidebar empty text    | "No adapters configured"                     | "No channels configured"                                                    |
| Relay Panel header            | "Relay"                                      | "Channels"                                                                  |
| Relay Panel feature disabled  | "Relay provides inter-agent messaging..."    | "Channels require Relay..."                                                 |
| Relay Panel connections tab   | "Connections"                                | "Connections" _(keep — no collision now that Agent Dialog uses "Channels")_ |
| Relay Panel section headers   | "Configured Adapters" / "Available Adapters" | "Active Channels" / "Available Channels"                                    |
| Command palette entry         | "Relay Messaging"                            | "Channels"                                                                  |
| Empty state CTAs              | "Set up an adapter"                          | "Set up a channel"                                                          |

### Surface 1: Agent Dialog — Channels Tab

**Replaces:** `features/agent-settings/ui/ConnectionsTab.tsx` (currently 3 `SubsystemRow` entries)

**Files modified:**

- `features/agent-settings/ui/AgentDialog.tsx` — Change tab value `"connections"` → `"channels"`, icon `Plug2` → `Radio`, import new component
- `features/agent-settings/ui/ConnectionsTab.tsx` — Rename to `ChannelsTab.tsx`, complete rewrite

**New component: `ChannelsTab.tsx`**

```
ChannelsTab({ agent: AgentManifest })
├── Channel Binding List
│   ├── ChannelBindingCard (per binding)
│   │   ├── Status dot (from adapter status via catalog lookup)
│   │   ├── Channel name (adapter displayName)
│   │   ├── Strategy badge (per-chat / per-user / stateless)
│   │   ├── Chat filter badge (optional chatId)
│   │   ├── Permission icons (canInitiate ⚡, !canReply, !canReceive)
│   │   └── Hover actions: Edit → opens BindingDialog, Remove → confirm dialog
│   └── Empty state (no bindings or no channels system-wide)
├── Connect to Channel button → ChannelPicker popover
└── Subsystems footer (Mesh health only)
```

**Data flow:**

1. `useBindings()` → filter by `b.agentId === agent.id` → agent's bindings
2. `useAdapterCatalog()` → resolve adapter name/status per binding's `adapterId`
3. `useCreateBinding()` → create binding when user selects from picker
4. `useDeleteBinding()` → remove binding on confirm
5. Edit → opens existing `BindingDialog` from `features/mesh/ui/`

**New component: `ChannelPicker.tsx`**

Popover triggered by "Connect to Channel" button. Lists configured channels with:

- Status dot + channel name + label (e.g., "@my_bot")
- Status text ("connected", "disabled")
- Disabled channels shown but not selectable
- Footer: "+ Set up a new channel..." → navigates to Settings → Channels (closes agent dialog via `setAgentDialogOpen(false)`, then `setSettingsOpen(true)` with active tab "channels")

**States:**

1. **Populated** — Binding cards + Connect button + Mesh footer
2. **No bindings** — Empty state with "Connect to Channel" CTA
3. **No channels system-wide** — Empty state with solid "Set Up a Channel" button → Settings
4. **Channel with error** — Red border on binding card, error detail text with "Configure channel" link

**FSD placement:** `features/agent-settings/ui/ChannelsTab.tsx`, `features/agent-settings/ui/ChannelPicker.tsx`, `features/agent-settings/ui/ChannelBindingCard.tsx`

### Surface 2: Settings → Channels Tab

**New tab in the Settings dialog, positioned between Tools and Agents.**

**Files modified:**

- `features/settings/ui/SettingsDialog.tsx` — Add `NavigationLayoutItem value="channels"` with `Radio` icon, add `NavigationLayoutPanel value="channels"`, import new component
- New file: `features/settings/ui/ChannelsTab.tsx`

**Sidebar insertion point (between Tools and Agents):**

```tsx
<NavigationLayoutItem value="tools" icon={Wrench}>Tools</NavigationLayoutItem>
<NavigationLayoutItem value="channels" icon={Radio}>Channels</NavigationLayoutItem>  {/* NEW */}
<NavigationLayoutItem value="agents" icon={Bot}>Agents</NavigationLayoutItem>
```

**Component structure:**

```
ChannelsTab()
├── Active Channels section (section-label + FieldCard)
│   └── ChannelSettingRow (per configured adapter)
│       ├── Status dot
│       ├── Channel name + metadata line (label, agent count, message volume)
│       ├── Configure button → opens AdapterSetupWizard in edit mode
│       └── Enable/disable toggle (useToggleAdapter)
├── Available Channels section (section-label + catalog grid)
│   └── CatalogCard (per unconfigured or multi-instance adapter type)
│       ├── Name + category badge
│       ├── Description
│       └── "+ Add" action → opens AdapterSetupWizard
└── Empty/disabled states
```

**Data flow:**

- `useAdapterCatalog(relayEnabled)` → catalog entries with instances and manifests
- `useToggleAdapter()` → enable/disable
- `useRemoveAdapter()` → remove (via confirm dialog)
- `useBindings()` → count bound agents per adapter
- Relay disabled → `FeatureDisabledState` component (same as current RelayPanel)

**Reuse:** `CatalogCard` from `features/relay/ui/` can be imported directly (it's already a self-contained component). `AdapterSetupWizard` is opened via state management, same pattern as ConnectionsTab in the relay feature.

**FSD placement:** `features/settings/ui/ChannelsTab.tsx`, `features/settings/ui/ChannelSettingRow.tsx`

### Surface 3: Settings → Agents Tab (Expanded)

**Expands the existing `AgentsTab` with agent adapter runtime configuration.**

**Files modified:**

- `features/settings/ui/AgentsTab.tsx` — Add Agent Adapters section below default agent selector

**New section structure:**

```
AgentsTab()
├── Default agent selector (existing FieldCard — unchanged)
├── Agent Adapters section (NEW)
│   ├── Section header: "Agent Adapters" + description text
│   └── AdapterRuntimeCard (per runtime)
│       ├── Header: icon + name + status badge + description + toggle
│       └── Expanded body: config rows (model, max turns, permission mode)
│           Each row: label + Select/Input control
├── DorkBot personality reset (existing FieldCard — unchanged)
```

**Data requirements:**

- Runtime adapter list is currently implicit (only Claude Code exists). For now, hardcode a `RUNTIME_ADAPTERS` constant with Claude Code as the active entry and OpenAI/Local Model as "coming soon" placeholders.
- Config values for Claude Code: sourced from server config via `useQuery(['config'])` (already fetched in AgentsTab).
- Future: when multiple runtimes ship, this will need a `useRuntimeAdapters()` hook backed by a server endpoint.

**Expandable card pattern:** Use a collapsible section (Radix Collapsible or simple `useState` toggle). Header row is always visible with toggle. Body expands/collapses with height animation (200ms ease-out, consistent with `contributing/animations.md`).

**FSD placement:** `features/settings/ui/AgentsTab.tsx` (expanded), `features/settings/ui/AdapterRuntimeCard.tsx`

### Surface 4: Agents Page — Channel Badges

**Add channel badges to agent rows in the Agents Page.**

**Files modified:**

- `features/agents-list/ui/AgentRow.tsx` — Add channel badges in the collapsed header row

**Badge placement:** After the runtime badge (line ~95 in current AgentRow), before the relative time. Each badge shows the adapter type name (e.g., "Telegram", "Slack") with a colored variant matching the adapter status.

**Data flow:**

- `useBindings()` at the AgentsList level → group by `agentId` → pass binding count/types to each AgentRow
- AgentRow renders badges from the binding data
- Agents with 0 bindings show a muted "no channels" text

**Badge component:** Reuse existing `Badge variant="outline"` with adapter-type-specific colors. For "no channels" indicator, use muted text (not a badge — avoids visual noise for agents that intentionally have no external channels).

**FSD placement:** Modification to existing `features/agents-list/ui/AgentRow.tsx`

### Surface 5: Session Sidebar — Vocabulary Update

**Minimal change: rename "Adapters" section label to "Channels".**

**Files modified:**

- `features/session-list/ui/ConnectionsView.tsx`:
  - Line ~184: `<SidebarGroupLabel>` text from "Adapters" → "Channels"
  - Line ~206: "Relay disabled for this agent" → "Channels disabled for this agent"
  - Line ~219: "No adapters configured" → "No channels configured"

**No structural changes.** Keep the read-only behavior, deep-link arrows, Agents and Tools sections.

### Surface 6: Channels Panel (Renamed Relay Panel)

**Vocabulary update throughout. Keeps as dialog (Zustand-driven `relayOpen` state).**

**Files modified:**

- `features/relay/ui/RelayPanel.tsx`:
  - Feature disabled message: "Relay provides inter-agent messaging..." → "Channels require Relay. Start DorkOS with relay enabled."
  - Component name and file name stay as `RelayPanel.tsx` (internal code unchanged)
- `features/relay/ui/ConnectionsTab.tsx` (relay feature's ConnectionsTab):
  - Section header "Configured Adapters" → "Active Channels"
  - Section header "Available Adapters" → "Available Channels"
  - Empty state text updates
- `features/relay/ui/RelayEmptyState.tsx`:
  - "Set up an adapter" → "Set up a channel"
- Command palette: `palette-contributions.ts`:
  - Label "Relay Messaging" → "Channels"
- `features/relay/ui/ActivityFeed.tsx`:
  - "Set up an adapter" → "Set up a channel"

### Bidirectional Navigation

| From                               | Action                                                        | To                               |
| ---------------------------------- | ------------------------------------------------------------- | -------------------------------- |
| Agent Dialog → Channels tab        | "Connect to Channel" picker footer: "Set up a new channel..." | Settings Dialog → Channels tab   |
| Agent Dialog → Channels tab        | _(future: "View all channels" link)_                          | Channels Panel                   |
| Settings → Channels tab            | "Configure" on a channel row                                  | AdapterSetupWizard (edit mode)   |
| Settings → Channels tab            | "Add" on catalog card                                         | AdapterSetupWizard (create mode) |
| Agents Page                        | Click agent row                                               | Agent Dialog → Channels tab      |
| Session Sidebar → Channels section | Arrow deep-link                                               | Channels Panel                   |
| Channels Panel                     | Click agent name in binding row                               | Agent Dialog → Channels tab      |

**Navigation helpers needed in app-store:**

- `openSettingsToTab(tab: string)` — opens Settings dialog and sets active tab (currently only `setSettingsOpen(true)` exists with no tab targeting)
- `openAgentDialogToTab(tab: string)` — opens Agent Dialog and sets active tab to "channels" (currently only `setAgentDialogOpen(true)` exists)

## User Experience

### Primary flow: "Make this agent reachable on Telegram"

1. Open Agent Dialog (click agent in sidebar or Agents Page)
2. Navigate to **Channels** tab
3. See current bindings (or empty state)
4. Click **"+ Connect to Channel"**
5. Picker shows Telegram with green "connected" status
6. Click Telegram → binding created with per-chat defaults → appears in list
7. Optionally click **Edit** to customize session strategy or permissions

### Secondary flow: "Set up Telegram for the first time"

1. Open Settings → **Channels** tab
2. See Telegram in Available Channels catalog
3. Click **"+ Add"** → setup wizard opens (configure bot token → test → confirm)
4. Telegram now appears in Active Channels
5. Return to Agent Dialog → Channels tab → "Connect to Channel" now shows Telegram

### Fleet overview flow: "Which agents have channels?"

1. Navigate to `/agents`
2. Agent list shows channel badges per agent (e.g., "Telegram", "Slack")
3. Agents without channels show muted "no channels" text
4. Click any agent → opens Agent Dialog at Channels tab

## Testing Strategy

### Unit Tests

**ChannelsTab (agent-settings):**

- Renders binding cards for agent's bindings
- Filters bindings by `agentId`
- Shows empty state when no bindings exist
- Shows "Set Up a Channel" state when no adapters configured
- Edit button opens BindingDialog with correct initial values
- Remove button triggers delete mutation after confirmation
- Mock: `useBindings`, `useAdapterCatalog`, `useCreateBinding`, `useDeleteBinding`

**ChannelPicker:**

- Lists configured channels with status
- Disabled channels are not selectable
- Selecting a channel calls `createBinding` with correct defaults
- Footer "Set up a new channel" calls navigation helper

**ChannelsTab (settings):**

- Renders active channels from catalog
- Toggle calls `useToggleAdapter` with correct ID
- Configure opens wizard in edit mode
- Catalog grid shows available types
- Shows Relay disabled state when `!relayEnabled`

**AgentsTab expansion:**

- Renders existing default agent selector
- Shows Agent Adapters section with Claude Code card
- Expandable card toggles body visibility
- Preserves DorkBot personality reset

**AgentRow channel badges:**

- Renders channel badges from binding data
- Shows "no channels" for agents with 0 bindings
- Handles agents with multiple channels

### Integration Tests

**Vocabulary audit:** Grep all user-facing strings in `features/relay/`, `features/agent-settings/`, `features/settings/`, `features/session-list/` for remaining instances of "Adapter" (case-insensitive) that should be "Channel". Automated test or CI check.

### E2E Tests

- Open Agent Dialog → Channels tab → verify binding list renders
- Connect to Channel → verify binding created → appears in list
- Settings → Channels → verify catalog renders → Add opens wizard
- Agents Page → verify channel badges appear per agent
- Session Sidebar → verify "Channels" label (not "Adapters")

## Performance Considerations

- **No new API calls.** All data comes from existing hooks (`useBindings`, `useAdapterCatalog`, `useRelayAdapters`) which already poll/cache via TanStack Query.
- **ChannelPicker popover** is lazily rendered (only mounts when open).
- **Agent adapter config** in Settings is read from the existing config query (no additional endpoint needed for Claude Code).
- **Agents Page channel badges** require `useBindings()` at the list level — already a lightweight JSON fetch with 10s stale time.

## Security Considerations

- No new API endpoints. All mutations use existing authenticated relay and binding routes.
- Binding creation from the ChannelPicker uses `useCreateBinding` which calls `POST /relay/bindings` — same authorization as current QuickBindingPopover.
- Agent adapter config in Settings currently uses `useQuery(['config'])` — read-only. Future runtime config mutations will need appropriate authorization (out of scope for this spec).

## Documentation

- `contributing/relay-adapters.md` — Update terminology references (Relay Adapters → Channels in user-facing context)
- `contributing/adapter-catalog.md` — Update terminology in UI references
- Command palette help text — Update "Relay Messaging" → "Channels"

## Implementation Phases

### Phase 1: Vocabulary Rename

Low risk, high visibility. Can be shipped independently.

- Rename all user-facing strings across all 6 surfaces
- Update command palette entry
- Update Session Sidebar labels
- Update Relay Panel / Channels Panel strings
- Update empty state CTAs

**Files:** `ConnectionsView.tsx`, `RelayPanel.tsx`, `ConnectionsTab.tsx` (relay), `RelayEmptyState.tsx`, `ActivityFeed.tsx`, `palette-contributions.ts`, `ConnectionsTab.tsx` (agent-settings — label only)

### Phase 2: Agent Dialog Channels Tab

Core new functionality. Depends on Phase 1 for naming.

- Replace `ConnectionsTab` in agent-settings with new `ChannelsTab`
- Build `ChannelPicker` popover component
- Build `ChannelBindingCard` component
- Update `AgentDialog.tsx` tab definition (value, icon, component)
- Add `openSettingsToTab` helper to app-store

**Files:** `AgentDialog.tsx`, new `ChannelsTab.tsx`, new `ChannelPicker.tsx`, new `ChannelBindingCard.tsx`, `app-store.ts`

### Phase 3: Settings Tabs

Depends on Phase 1 for naming, independent of Phase 2.

- Add Channels tab to Settings (new `ChannelsTab.tsx` in settings feature)
- Expand Agents tab with agent adapter cards (modify `AgentsTab.tsx`)
- Build `ChannelSettingRow` and `AdapterRuntimeCard` components

**Files:** `SettingsDialog.tsx`, new `ChannelsTab.tsx` (settings), new `ChannelSettingRow.tsx`, `AgentsTab.tsx`, new `AdapterRuntimeCard.tsx`

### Phase 4: Agents Page + Navigation

Depends on Phase 2 (for Agent Dialog Channels tab as navigation target).

- Add channel badges to `AgentRow.tsx`
- Implement bidirectional navigation helpers
- Add `openAgentDialogToTab` to app-store
- Wire up all cross-surface navigation links

**Files:** `AgentRow.tsx`, `app-store.ts`, various components with navigation callbacks

## Related ADRs

- **ADR-0044:** ConfigField descriptor over Zod serialization — adapter setup wizard form rendering
- **ADR-0046:** Central binding router for adapter-agent routing — binding architecture
- **ADR-0047:** Most-specific-first binding resolution — routing scoring rules
- **ADR-0177:** Standalone channel plugin as MCP server process (rejected) — confirms relay as sole delivery path
- **ADR-0192:** `relay_notify_user` MCP tool (proposed) — convenience tool abstracting binding resolution

## References

- Ideation: `specs/channels-and-agent-adapters/01-ideation.md`
- Design decisions: `specs/channels-and-agent-adapters/04-design-decisions.md`
- Visual mockups: `.dork/visual-companion/70420-1775346246/`
- Related spec #120: `specs/adapter-binding-ux-overhaul/`
- Related spec #85: `specs/agent-centric-ux/`
- Relay adapter guide: `contributing/relay-adapters.md`
- Adapter catalog guide: `contributing/adapter-catalog.md`
- FSD architecture: `contributing/project-structure.md`
