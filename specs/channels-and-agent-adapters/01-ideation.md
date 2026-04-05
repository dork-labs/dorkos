---
slug: channels-and-agent-adapters
number: 214
created: 2026-04-04
status: ideation
design-session: .dork/visual-companion/70420-1775346246
---

# Channels & Agent Adapters — Connectivity UX Redesign

**Slug:** channels-and-agent-adapters
**Author:** Dorian + Claude Code
**Date:** 2026-04-04

---

## 1) Problem Statement

The relay adapter and binding system works well mechanically, but the user experience has three structural problems:

1. **Wrong vocabulary.** The industry uses "Channels" (Slack, Telegram, webhook endpoints). DorkOS calls them "Relay Adapters" — a term nobody outside this codebase understands. Users searching for "how to connect my agent to Telegram" won't find it.

2. **Infrastructure-centric, not agent-centric.** The entire config flow is organized around adapters: "Here's your Telegram adapter, and here are the agents it serves." But the user's mental model is the inverse: "How do I make _this agent_ reachable on Telegram?" The Agent Dialog's Connections tab is a read-only dead end — you see a binding count and a "View in Relay" link that drops you into an unrelated global panel.

3. **No settings integration.** Adapter/channel management and agent adapter configuration are only accessible through the Relay Panel dialog. They don't appear in the main Settings dialog where users expect to configure system-level features.

### Impact

- **Kai** (primary persona) sets up 10 agents. For each one, he has to close the agent dialog, open the Relay panel, find the right adapter, create a binding, then go back. That's 30+ context switches for what should be an inline action.
- **Priya** (secondary persona) wants to understand her agent fleet's connectivity at a glance. No surface shows which agents are connected to what, or which agents have no external channels.

## 2) Intent & Goals

### Rename: "Relay Adapters" → "Channels" in user-facing UI

Adopt the industry-standard term "Channel" for all user-facing surfaces. Internal code (relay adapter classes, transport methods, schemas) keeps its current naming — this is a UI/UX vocabulary change, not a refactor.

**Mapping:**
| Old term (UI) | New term (UI) | Internal code (unchanged) |
|---|---|---|
| Relay Adapters | Channels | `RelayAdapter`, `AdapterConfig`, `AdapterManifest` |
| Adapter | Channel | `adapter-manager.ts`, adapter types |
| Relay Panel | Channels Panel (or just "Channels") | `RelayPanel.tsx`, `useRelayEnabled()` |
| Relay Bindings | Channel Bindings (or just "Bindings") | `AdapterBinding`, `BindingStore` |
| Configure Relay Adapters (Cmd+K) | Configure Channels | command palette entry |

### Agent-centric binding management

Add the ability to manage an agent's channel bindings directly from the Agent Dialog, without leaving the agent's context. The Agent Dialog's Connections tab becomes a real management surface, not a signpost.

### Settings integration

Add channels and agent adapter configuration to the main Settings dialog:

- A new **Channels** tab for system-level adapter management (add/remove/configure adapters)
- Expand the existing **Agents** tab with per-agent adapter/binding configuration

### Preserve the Channels Panel

The renamed Relay Panel (→ Channels Panel) remains the fleet-wide "networking dashboard" for power users who want the adapter-centric view, activity feed, event logs, and health monitoring. It's the infrastructure view. Settings and Agent Dialog provide the configuration view.

## 3) Current State Analysis

### Where adapter/binding config lives today

**Relay Panel** (global dialog — Cmd+K → "Configure Relay Adapters", or dashboard status bar):

- Connections tab: Configured adapter cards (each with inline bindings) + Available Adapters catalog grid
- Activity tab: Dead-letter queue, message flow monitoring
- Setup wizard: Configure → Test → Bind one agent → Confirm
- Binding management: create via QuickBindingPopover, edit via BindingDialog
- Health bar: connection status, message counts, error summary

**Agent Dialog → Connections tab:**

- Three `SubsystemRow` entries: Tasks Schedules, Relay Bindings, Mesh Health
- Relay row: shows count ("2 bindings") + "View in Relay" button → opens global Relay Panel
- No inline binding create/edit/delete

**Agent Dialog → Capabilities tab:**

- Tool group toggles: Tasks, Relay, Mesh, Adapter
- Controls whether the agent can programmatically manage bindings, not what it's bound to

**Settings Dialog:**

- Agents tab: default agent selector, DorkBot personality reset
- Tools tab: relay documentation and MCP tool references
- No adapter/channel management surface

**Topology Graph:**

- `AdapterNode` and `BindingEdge` components in the mesh visualization
- Read-only visual representation

### Key files

| Surface          | Primary files                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Relay Panel      | `features/relay/ui/RelayPanel.tsx`, `ConnectionsTab.tsx`, `AdapterCard.tsx`, `AdapterSetupWizard.tsx` |
| Agent Dialog     | `features/agent-settings/ui/AgentDialog.tsx`, `ConnectionsTab.tsx`, `CapabilitiesTab.tsx`             |
| Settings Dialog  | `features/settings/ui/SettingsDialog.tsx`, `AgentsTab.tsx`, `ToolsTab.tsx`                            |
| Binding entities | `entities/binding/` (useBindings, useCreateBinding, useUpdateBinding, useDeleteBinding)               |
| Relay entities   | `entities/relay/` (useAdapterCatalog, useToggleAdapter, useRemoveAdapter)                             |
| Server routes    | `routes/relay-adapters.ts`                                                                            |
| Server services  | `services/relay/adapter-manager.ts`, `binding-store.ts`, `adapter-config.ts`                          |
| Schemas          | `packages/shared/src/relay-adapter-schemas.ts`                                                        |

## 4) Identified Gaps

### Gap 1: Agent-centric binding management is missing

The Agent Dialog Connections tab is a read-only signpost. You see "2 bindings" and a "View in Relay" link. You can't:

- See which channels this agent is bound to (by name/type)
- Create a new binding to an existing channel
- Edit a binding's session strategy or permissions
- Remove a binding
- See which channels are available but unbound

You must close the agent dialog, open the Relay panel, find the right adapter card, and manage bindings there.

### Gap 2: No path from agent setup to channel setup

If you're configuring an agent and realize you need a Telegram channel, there's no way to:

- See available channel types from the agent context
- Initiate a new channel setup from within the agent
- Complete the full flow (add channel + bind to this agent) without context-switching

### Gap 3: "Connections" naming collision

The Agent Dialog has a "Connections" tab (subsystem status overview). The Relay Panel has a "Connections" tab (adapter management). Same word, completely different scope and functionality.

### Gap 4: No "unbound agents" visibility

With 10 agents and 3 channels, there's no surface showing which agents lack external connectivity. You'd have to open each agent individually or mentally cross-reference adapter binding lists.

### Gap 5: Binding permissions are invisible at a glance

`sessionStrategy`, `canInitiate`, `canReply`, `canReceive`, `channelType` are important config choices hidden in edit dialogs. `AdapterBindingRow` only shows agent name + session strategy badge.

### Gap 6: No settings-level channel management

Adapters/channels are system resources but aren't configurable from Settings. The Settings dialog has Server, Tools, and Agents tabs — but no networking/channels tab. Users who go to Settings to "set up Telegram" won't find it.

### Gap 7: Wizard creates one binding, then you're on your own

The setup wizard walks through adapter config → test → bind one agent. Binding 5 agents to the same Telegram bot requires the wizard once, then 4 trips through the quick-bind popover.

## 5) Design Direction — 6 Surfaces

### A. Vocabulary: Two distinct concepts

**Channels** (user-facing term for relay adapters): Telegram, Slack, Webhook — the external messaging platforms that connect users to agents. The industry-standard term. Replaces "Relay Adapter(s)" in all user-facing UI. Internal code (`RelayAdapter`, `AdapterConfig`, `BindingStore`) unchanged.

**Agent Adapters** (runtime backends): Claude Code, and eventually OpenAI, local models, etc. — the AI runtime that powers each agent. Distinct from channels. Configured at the system level.

| Old term (UI)                    | New term (UI)      | Internal code (unchanged)                          |
| -------------------------------- | ------------------ | -------------------------------------------------- |
| Relay Adapters                   | Channels           | `RelayAdapter`, `AdapterConfig`, `AdapterManifest` |
| Relay Panel                      | Channels (Panel)   | `RelayPanel.tsx`, `useRelayEnabled()`              |
| Relay Bindings                   | Channel Bindings   | `AdapterBinding`, `BindingStore`                   |
| Add binding                      | Connect to Channel | binding creation flows                             |
| Sidebar "Adapters" section       | Channels           | `ConnectionsView.tsx`                              |
| Configure Relay Adapters (Cmd+K) | Configure Channels | command palette entry                              |

### B. Surface 1 — Agent Dialog: "Channels" tab (replaces "Connections")

The current agent-settings `ConnectionsTab` (3 subsystem rows) gets restructured:

**New layout:**

- **Channels section** (primary): Lists this agent's channel bindings with full inline management
  - Each binding shows: channel icon + name, session strategy badge, permission indicators
  - Inline actions: edit, remove
  - "Connect to Channel" button opens a picker showing available configured channels
  - "Set up new channel" link for when no suitable channel exists yet
- **Subsystems footer** (secondary): Mesh health status. Tasks will likely move to its own dedicated Agent Dialog tab, so the subsystems section reduces to just Mesh.

This makes the agent's channel connectivity the hero of the tab.

### C. Surface 2 — Settings Dialog: New "Channels" tab

A new sidebar item in Settings, positioned after "Tools" and before "Agents":

**Content:**

- Active Channels section: List of configured channels with status indicators, enable/disable toggles, and "Configure" links to the setup wizard
- Available Channels section: Catalog grid of available channel types with "Add" buttons
- This is the channel-first (adapter-first) view — appropriate for Settings, which is about system configuration

This tab mirrors the Connections tab from the current Relay Panel, but in the Settings context where users expect to find system configuration.

### D. Surface 3 — Settings Dialog: Agents tab expansion

The existing Agents tab (currently: default agent dropdown + DorkBot reset) gets expanded with **Agent Adapter configuration**:

**Agent Adapters section:**

- Lists available agent runtime adapters (Claude Code, future runtimes)
- Enable/disable toggles per adapter
- Configure button → adapter-specific settings (API keys, model selection, etc.)
- This is where multi-runtime agent configuration will live as DorkOS adds support for more AI backends

The existing content (default agent picker, DorkBot personality reset) remains.

### E. Surface 4 — Agents Page (`/agents`): Fleet connectivity overview

The agents list on the `/agents` route gets channel visibility:

- Each agent card/row shows channel badges (Telegram, Slack, etc.)
- Agents with no channel bindings show a "no channels" indicator
- Provides the fleet-wide "which agents are connected to what" view
- Click an agent → opens Agent Dialog at Channels tab

### F. Surface 5 — Session Sidebar: Connections tab vocabulary update

The existing `ConnectionsView` in the session sidebar gets vocabulary updates:

- "Adapters" section label → "Channels"
- Keep the existing contextual, read-only behavior (scoped to current session's agent)
- Keep deep-link arrows to the Channels Panel
- Keep the Agents and Tools sections as-is

### G. Surface 6 — Channels Panel (renamed Relay Panel): Operations dashboard

The existing Relay Panel, renamed:

- Remains the power-user, fleet-wide operational view
- Keeps: health bar, activity feed, event logs, connection status monitoring
- Keeps adapter-first card layout (appropriate for monitoring across all agents)
- Gets vocabulary updates throughout
- Serves as the deep-dive surface for debugging, monitoring, and bulk operations

### H. Bidirectional navigation

All surfaces link to each other:

- Agent Dialog Channels tab → "View all channels" link → opens Channels Panel
- Agent Dialog Channels tab → "Set up new channel" → opens channel setup wizard or navigates to Settings → Channels
- Settings Channels tab → clicking a channel's binding list → opens Channels Panel filtered
- Agents Page → click agent → opens Agent Dialog at Channels tab
- Channels Panel → click agent name in binding row → opens Agent Dialog at Channels tab
- Session Sidebar Channels section → arrow link → opens Channels Panel

## 6) Scope & Boundaries

### In scope

- UI vocabulary rename: "Relay Adapter(s)" → "Channel(s)" across all user-facing surfaces
- Agent Dialog Connections tab → Channels tab with inline binding management
- Settings Dialog: new Channels tab (channel add/remove/configure)
- Settings Dialog: Agents tab expansion with agent adapter configuration
- Agents Page: channel badges on agent cards/rows
- Session Sidebar: vocabulary rename (Adapters → Channels)
- Channels Panel rename and vocabulary update
- Navigation links between all six surfaces
- Command palette entry updates

### Out of scope

- Internal code refactoring (adapter class names, schema field names, file names)
- New adapter types or adapter DX improvements
- New agent adapter implementations (just the config surface)
- Topology graph changes
- Mobile-specific layouts
- Relay message routing changes
- Binding scoring or resolution logic changes
- Agent-to-agent relay configuration
- Batch binding operations (bind all agents to a channel)

## 7) Prior Art & Related Specs

| Spec                                 | Relationship                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `adapter-binding-ux-overhaul` (#120) | Predecessor — focused on multi-instance, naming, chatId pickers. Much implemented. This spec builds on that work. |
| `adapter-agent-routing`              | Binding routing architecture. This spec doesn't touch routing logic.                                              |
| `adapter-catalog-management`         | Catalog and wizard. Vocabulary rename affects labels, not structure.                                              |
| `adapter-setup-experience`           | Setup wizard flow. May need vocabulary updates.                                                                   |
| `agent-centric-ux` (#85)             | Broader agent-centric redesign. This spec delivers the connectivity piece of that vision.                         |
| `mesh-panel-ux-overhaul`             | Mesh topology views that include adapter nodes.                                                                   |
| `agent-runtime-abstraction`          | AgentRuntime interface. Settings → Agents adapter config builds on this.                                          |

## 8) Open Questions

1. **Should the Channels Panel remain a separate dialog, or become a route?** Currently it's a Zustand-driven dialog. As we add Settings and Agent Dialog surfaces, the separate dialog might feel redundant for basic config. Keep it for the monitoring/operations use case?

2. **How deep should the Agent Dialog's channel management go?** Full binding editor (session strategy, permissions, chatId, channelType) inline? Or just create/remove with a link to the full editor?

3. **Should "Set up new channel" from inside the Agent Dialog open the wizard in a nested dialog, or navigate to Settings → Channels?** Nested dialog keeps context. Navigation to Settings is more discoverable but loses the agent context.

4. **What icon for the Channels tab in Settings?** Current candidates: `Radio` (signal/broadcast), `Route` (connections — currently used by Relay), `Cable` (physical connection), `MessageSquare` (messaging).

5. **Agent adapter config depth for Settings → Agents:** How much config should be inline vs. in a separate dialog? Claude Code today has limited config, but future runtimes may have API keys, model selection, rate limits, etc.
