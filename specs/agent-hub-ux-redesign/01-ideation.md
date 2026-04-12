---
slug: agent-hub-ux-redesign
number: 240
created: 2026-04-12
status: specification
design-session: .dork/visual-companion/7057-1776029581
---

# Agent Hub UX Redesign

**Slug:** agent-hub-ux-redesign
**Author:** Claude Code
**Date:** 2026-04-12
**Branch:** preflight/agent-hub-ux-redesign

---

## 1) Intent & Assumptions

- **Task brief:** The Agent Hub right-panel has poor UI/UX. It uses a left-nav sidebar with 6 tabs crammed into a ~350px right panel, creating a "panel within a panel." The Overview tab is a duplicate of Sessions. The agent identity is minimized. The personality controls are overwhelming. There is no visual delight. Redesign the Agent Hub to be easy to use, fun, and delightful — with personality presets, visual personality fingerprints, and an identity-first layout.

- **Assumptions:**
  - The right-panel shell (`RightPanelContainer`, `RightPanelTabBar`) stays as-is — we're redesigning the Agent Hub _within_ the panel, not the panel itself
  - The existing agent-settings components (PersonalityTab, ChannelsTab, ToolsTab) can be reused inside the new layout — they're the content, we're changing the shell
  - Agent runtimes (not LLM models) are the user-facing concept for the profile
  - Personality presets are a new feature (they don't exist today)
  - The response preview bubble is aspirational — it may require backend support to generate sample responses

- **Out of scope:**
  - Right-panel resizing behavior and shell chrome
  - Mobile/Sheet layout (will follow naturally from the desktop redesign)
  - Deep-link URL scheme changes
  - Backend changes for personality preset definitions
  - The Canvas panel (second right-panel tab)

---

## 2) Pre-reading Log

- `apps/client/src/layers/features/agent-hub/ui/AgentHub.tsx`: Main shell — orchestrates header, nav, content; handles agent loading and empty states
- `apps/client/src/layers/features/agent-hub/ui/AgentHubNav.tsx`: Left nav sidebar with 6 icon+label buttons — the component being _replaced_
- `apps/client/src/layers/features/agent-hub/ui/AgentHubContent.tsx`: Lazy tab switcher — wraps each tab in Suspense
- `apps/client/src/layers/features/agent-hub/ui/AgentHubHeader.tsx`: Minimal header — 24px avatar + name + close button
- `apps/client/src/layers/features/agent-hub/ui/tabs/OverviewTab.tsx`: Delegates to SessionsView — identical to SessionsTab (confirmed in browser)
- `apps/client/src/layers/features/agent-hub/ui/tabs/PersonalityTab.tsx`: Thin wrapper delegating to agent-settings PersonalityTab
- `apps/client/src/layers/features/agent-hub/ui/tabs/SessionsTab.tsx`: Delegates to SessionsView
- `apps/client/src/layers/features/agent-hub/ui/tabs/ChannelsTab.tsx`: Delegates to agent-settings ChannelsTab
- `apps/client/src/layers/features/agent-hub/ui/tabs/TasksTab.tsx`: Delegates to TasksView
- `apps/client/src/layers/features/agent-hub/ui/tabs/ToolsTab.tsx`: Delegates to agent-settings ToolsTab
- `apps/client/src/layers/features/agent-hub/model/agent-hub-store.ts`: Zustand store (activeTab, agentPath, openHub)
- `apps/client/src/layers/features/agent-hub/model/agent-hub-context.tsx`: React context provider (agent manifest, projectPath, callbacks)
- `apps/client/src/layers/features/right-panel/ui/RightPanelContainer.tsx`: Shell-level resizable panel — defaultSize=35%, minSize=20%
- `apps/client/src/layers/features/right-panel/ui/RightPanelTabBar.tsx`: Vertical icon strip for switching between Agent Hub and Canvas
- `apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx`: Avatar + name component (xs/sm/md/lg sizes)
- `apps/client/src/layers/features/agent-settings/ui/PersonalityTab.tsx`: Full personality editor — 5 trait sliders, SOUL.md textarea, NOPE.md textarea, response mode, conventions toggle
- `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`: Channel binding management
- `apps/client/src/layers/features/agent-settings/ui/ToolsTab.tsx`: Tool group toggles + MCP server status + safety limits
- `apps/client/src/layers/features/session-list/ui/SessionsView.tsx`: Grouped session list with motion animations
- `apps/client/src/layers/features/session-list/ui/TasksView.tsx`: Running/upcoming/recent task runs
- `apps/client/src/app/init-extensions.ts`: Agent Hub registered as right-panel contribution (priority 10, always visible)

---

## 3) Codebase Map

- **Primary components/modules:**
  - `layers/features/agent-hub/` — Hub shell, tabs, store, context (the feature being redesigned)
  - `layers/features/agent-settings/` — Personality, Channels, Tools content components (reused)
  - `layers/features/session-list/` — SessionsView, TasksView (reused)
  - `layers/features/right-panel/` — Panel shell, tab bar, container (untouched)
  - `layers/entities/agent/ui/AgentIdentity.tsx` — Avatar + name (enhanced)

- **Shared dependencies:**
  - Zustand stores: `agent-hub-store` (feature-local), `app-store` (rightPanelOpen, activeRightPanelTab)
  - React context: `AgentHubProvider` (agent manifest, projectPath, onUpdate)
  - UI primitives: Button, Tooltip, ScrollArea, Switch, Select, FieldCard, Badge
  - Icons: Lucide (User, Sparkles, MessageSquare, Radio, Clock, Wrench, X)
  - Animation: motion/react (AnimatePresence, motion.div)

- **Data flow:**
  - `RightPanelContainer` → checks visible contributions → renders `AgentHub`
  - `AgentHub` reads `agentPath` from hub store (falls back to `selectedCwd`)
  - `AgentHub` fetches agent manifest → wraps content in `AgentHubProvider`
  - Tab components read context → delegate to shared content components

- **Feature flags/config:** None — the hub is always available when registered

- **Potential blast radius:**
  - Direct: ~12 files in `agent-hub/` (UI shell, tabs, store)
  - Indirect: `AgentIdentity` component, `agent-hub-store` tab type
  - New: Personality presets data, radar chart component, response preview component
  - Tests: Existing hub tests need updating for new tab structure

---

## 4) Root Cause Analysis

N/A — this is a design/UX improvement, not a bug fix.

---

## 5) Research

### Key findings from industry research

**Pattern: Vertical tabs in narrow panels are the worst pattern**
NNGroup explicitly warns against vertical/left tabs in narrow panels — they cause users to overlook tabs. DorkOS's current left-nav within a 350px right panel violates this directly.

**Pattern: Max 3-5 tabs in constrained panels**
Both NNGroup and Eleken research converge on 3-5 horizontal tabs max. Beyond that, switch to accordion/collapsible sections. DorkOS has 6 left-nav tabs.

**Pattern: Accordion sections for configuration content**
Linear, Notion 2024, and GitHub Settings all use single scrollable pages with section headers for configuration (not sub-tabs). Tabs are for parallel content of equal importance; accordions for hierarchical content.

**Pattern: Identity hero header**
Zendesk, Salesforce, and SaaS profile design converge on: 64-72px avatar + inline-editable name + status indicator + key stats. The identity hero never scrolls away.

**Pattern: Personality presets over manual configuration**
Cursor, Claude Projects, and ChatGPT custom GPTs all converge on: one primary system-prompt textarea + a few categorical toggles. DorkOS's 5 sliders + 2 textareas + toggles is non-standard and overwhelming. Presets solve this.

**Pattern: Developer tool right panels**
VS Code Secondary Sidebar: generic container, contribution-driven tabs, auto-hidden tab bar when only one tab. Figma: context-sensitive content with grouped properties and section headers.

### Potential solutions

**1. Three-zone architecture with horizontal tabs (Recommended)**

- Zone 1: Identity hero header (never scrolls)
- Zone 2: 3 horizontal tabs (Profile, Sessions, Config)
- Zone 3: Scrollable tab content
- Pros: Industry-standard, full-width content, clear hierarchy
- Cons: Requires significant layout restructuring

**2. Single scrollable page (no tabs)**

- Linear/Notion approach — all content in one scroll
- Pros: Simplest, no tab navigation overhead
- Cons: Too long for 6 categories of content, poor discoverability

**3. Incremental fix (keep left nav, reduce tabs)**

- Keep the current structure but merge Overview+Sessions and reduce to 4 tabs
- Pros: Least code change
- Cons: Still violates the narrow-panel left-nav anti-pattern

### Recommendation

Solution 1 — Three-zone architecture. The industry evidence is overwhelming. The current layout pattern is explicitly warned against by UX research. The fix requires restructuring the shell but reuses all existing content components.

---

## 6) Decisions

| #   | Decision                       | Choice                                                                                                                                                                         | Rationale                                                                                                                                                                                                                     |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Overall layout structure       | Three-zone: Identity Hero + 3 Horizontal Tabs + Scrollable Content                                                                                                             | Industry standard (VS Code, Linear, Figma). Eliminates the panel-within-a-panel anti-pattern. Full-width content area.                                                                                                        |
| 2   | Number and names of tabs       | 3 tabs: Profile, Sessions, Config                                                                                                                                              | Consolidates 6 tabs into 3. Overview eliminated (duplicate). Personality/Tools/Channels merged into Config with accordion sections. Sessions absorbs Tasks.                                                                   |
| 3   | Config tab design              | Personality Theater — animated radar chart, named archetypes with preset pills, live response preview                                                                          | User explicitly wants "easy to use, fun, cool." Presets make personality configuration instant. Radar chart gives visual fingerprint. Response preview shows impact of settings. System prompts hidden in Advanced accordion. |
| 4   | Profile tab content            | Display name, description, agent runtime selector (not model), directory path, tags, stats                                                                                     | User specified: "users should select the agent runtime, not the model" and "show the folder/directory." Runtime is the user-facing concept; model is internal to the runtime.                                                 |
| 5   | Identity hero header           | 52px avatar with status ring, agent name, runtime label, 7-day sparkline                                                                                                       | Always visible, never scrolls. Answers "whose panel is this?" immediately. Sparkline shows activity heartbeat. Status ring shows online/offline.                                                                              |
| 6   | Personality presets            | 6 named presets: Balanced, The Hotshot, The Sage, The Sentinel, The Phantom, Mad Scientist                                                                                     | User wants "fun" preset names. Each preset sets all 5 personality traits at once. Users can fine-tune with sliders after selecting a preset. Custom option for manual configuration.                                          |
| 7   | System prompt placement        | Hidden in "Advanced" accordion section within Config tab                                                                                                                       | User explicitly: "manually editing system prompts should be considered secondary or even advanced." Personality presets are the primary interaction; SOUL.md/NOPE.md are for power users.                                     |
| 8   | Delight features (prioritized) | P1: Animated radar chart, preset pills, response preview. P2: Avatar mood ring, personality morphing, sparkline. P3: First-run intro, personality unlocks, drag-to-tune radar. | Ship P1 delight with the redesign. P2 as fast follows. P3 as future exploration.                                                                                                                                              |

---

## Design Mockups

Visual companion session: `.dork/visual-companion/7057-1776029581/`

Key screens:

- `current-vs-proposed.html` — Side-by-side current vs. proposed layout (chose B: proposed)
- `config-tab-design.html` — Accordion layout options for Config tab (chose B: visual personality)
- `config-tab-delightful.html` — Personality Theater with presets and response preview (chose B: full theater)
- `full-agent-hub-experience.html` — All three tabs mocked up with Personality Theater, preset names, sparkline
- `profile-tab-v2.html` — Profile tab refined: runtime selector, directory path, tilde-shortened CWD

### Final design summary

**Identity Hero Header** (non-scrolling, all tabs):

- 52px avatar with status ring (green = online) and personality aura glow
- Agent display name (15px, bold)
- Status + runtime label ("Online · claude-code")
- 7-day activity sparkline with session count

**Profile Tab:**

- Display Name (click-to-edit inline field)
- Description (textarea, click-to-edit)
- Agent Runtime (dropdown selector — claude-code, openai-assistant, etc.)
- Directory (monospace path with folder icon, tilde-shortened)
- Tags (pill chips with + add button)
- Stats row: 3 cards showing sessions, channels, tasks run

**Sessions Tab:**

- Scheduled tasks at top (cron schedule with time badges)
- Active sessions with green dot and LIVE badge
- Past sessions grouped by time (Today, Previous 7 days, Previous 30 days)
- Each session shows title, time, duration
- Tasks and sessions unified — no separate Tasks tab

**Config Tab (Personality Theater):**

- Animated breathing radar chart (5 vertices: Tone, Autonomy, Caution, Communication, Creativity)
- Archetype name in gradient text ("The Hotshot") with tagline ("Ship fast, explain later.")
- Horizontal preset pill selector: Balanced, Hotshot, Sage, Sentinel, Phantom, Mad Scientist, Custom
- "How this agent talks" — live response preview bubble showing a sample response
- Accordion sections (collapsed by default):
  - Tools & MCP (tool group toggles, MCP server status)
  - Channels (channel bindings)
  - Advanced (SOUL.md textarea, NOPE.md textarea, response mode, limits)
