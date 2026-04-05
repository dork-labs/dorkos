# Design Decisions

Visual companion session: `.dork/visual-companion/70420-1775346246/`

## 1. Surface Map — Where does config live?

**Screen:** `01-current-vs-proposed.html`, `02-revised-surface-map.html`
**Options:** Various arrangements of 3-6 surfaces
**Chosen:** 6 surfaces, each with a distinct purpose:

| #   | Surface                              | Purpose                                          | View orientation |
| --- | ------------------------------------ | ------------------------------------------------ | ---------------- |
| 1   | Agent Dialog → Channels tab          | Manage bindings for ONE agent                    | Agent-first      |
| 2   | Settings → Channels tab (new)        | Add/remove/configure system channels             | Channel-first    |
| 3   | Settings → Agents tab (expanded)     | Configure agent runtime adapters                 | Adapter-first    |
| 4   | Agents Page (/agents)                | Fleet overview: which agents have which channels | Fleet-wide       |
| 5   | Session Sidebar → Connections tab    | Read-only contextual view for current session    | Session-scoped   |
| 6   | Channels Panel (renamed Relay Panel) | Operations dashboard: health, activity, events   | Ops/monitoring   |

**Key revision from initial proposal:** Settings → Agents is for agent adapter _runtime_ config (Claude Code, future OpenAI, local models) — NOT for fleet connectivity overview. Fleet connectivity moved to the Agents Page (`/agents` route).

## 2. Agent Dialog — Channels Tab

**Screen:** `03-agent-dialog-channels-tab.html`, `04-agent-channels-polished.html`
**Chosen design:**

- Replaces current "Connections" tab (resolves naming collision)
- Sidebar icon: Radio/broadcast icon, label "Channels"
- **Connected channels section** (hero): Binding cards showing status dot, channel name, session strategy badge, chat filter badge, permission icons, hover actions (Edit / Remove)
- **"+ Connect to Channel" button**: Opens a dropdown picker listing configured channels with status. Selecting one creates a binding with defaults (per-chat, all permissions). User clicks "Edit" to customize.
- **"Set up a new channel..." link** at bottom of picker: Navigates to Settings → Channels when no suitable channel exists
- **Subsystems footer** (demoted): Just Mesh health. Tasks will likely get its own dedicated Agent Dialog tab.

**States designed:**

- Populated (2+ channels)
- Empty: no bindings for this agent (shows "Connect to Channel" CTA)
- Empty: no channels configured system-wide (shows "Set Up a Channel" solid button → Settings)
- Channel with error (red border, error detail with "Configure channel" link)
- Channel picker open

**Binding row anatomy:** Status dot → Channel name → Strategy badge → Chat filter → Permission icons → Actions (hover)

## 3. Settings → Channels Tab

**Screen:** `05-settings-channels-tab.html`
**Chosen design:**

- New sidebar item positioned between "Tools" and "Agents", purple accent
- Sidebar icon: Radio/broadcast (same family as Agent Dialog Channels)
- **Active Channels section**: Compact rows in a FieldCard. Each row: status dot, channel name, metadata line (bot username, agent count, message volume), Configure button, enable/disable toggle
- **Available Channels section**: Catalog grid below active channels. Cards with name, category badge, description, "Add" / "Add another" action
- Multi-instance channels (Telegram, Webhook) show "Add another" even when already configured

**States designed:**

- Populated (3 active channels + catalog)
- Empty: no channels configured (empty state + catalog grid)
- Relay disabled (message + env var command)

**Distinction from Channels Panel:** Settings = configuration (clean rows, system admin feel). Panel = operations (rich cards, health monitoring, activity feed, event logs).

## 4. Settings → Agents Tab

**Screen:** `06-settings-agents-tab.html`
**Chosen design:**

- Existing content preserved: default agent selector at top, DorkBot personality reset at bottom
- **New "Agent Adapters" section** between them with header + description text
- Each runtime is an **expandable adapter card**: icon, name, status badge, description, enable/disable toggle in header. Expanded body shows config rows (model selector, max turns, permission mode, etc.)
- **Claude Code** adapter shown as active with inline config
- **Future adapters** (OpenAI, Local Model) shown as dashed/dimmed placeholders with "coming soon" badges and off toggles

**The adapter vs channel distinction is explicit:**

- Agent Adapters = "What powers agents" (AI runtime backends) → Settings → Agents
- Channels = "How users reach agents" (messaging platforms) → Settings → Channels

## 5. Vocabulary

**Decided throughout all screens:**

| Old (user-facing)                | New (user-facing)  |
| -------------------------------- | ------------------ |
| Relay Adapters                   | Channels           |
| Relay Panel                      | Channels (Panel)   |
| Relay Bindings                   | Channel Bindings   |
| Add binding                      | Connect to Channel |
| Sidebar "Adapters" section       | Channels           |
| Configure Relay Adapters (Cmd+K) | Configure Channels |
| Agent Dialog "Connections" tab   | Channels tab       |

Internal code (`RelayAdapter`, `AdapterConfig`, `BindingStore`, etc.) remains unchanged.

## Final Design Summary

The redesign creates a clear separation of concerns across 6 surfaces, each answering a distinct question:

1. **"How do I make THIS agent reachable?"** → Agent Dialog → Channels tab (inline binding management with picker)
2. **"How do I set up Telegram/Slack?"** → Settings → Channels (system-level channel add/remove/configure)
3. **"Which AI runtime powers my agents?"** → Settings → Agents (agent adapter runtime config with expandable cards)
4. **"Which agents are connected to what?"** → Agents Page /agents (fleet overview with channel badges)
5. **"What's connected for this session?"** → Session Sidebar Connections (read-only, vocabulary rename only)
6. **"Is everything healthy?"** → Channels Panel (operations dashboard, renamed from Relay Panel)

The vocabulary shift from "Relay Adapters" to "Channels" aligns with industry conventions. The clear separation of "Channels" (messaging platforms) from "Agent Adapters" (AI runtime backends) prevents conceptual confusion as both systems grow.
