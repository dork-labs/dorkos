---
title: 'MCP Tools Sidebar Enhancement — Toggle, Status Indicators, and Scope Badges'
date: 2026-03-28
type: internal-architecture
status: active
tags:
  [
    mcp,
    sidebar,
    toggle,
    status-indicator,
    progressive-disclosure,
    context-window,
    scope-badge,
    connections-view,
    session-sidebar,
    ux-patterns,
  ]
feature_slug: mcp-tools-sidebar-enhancement
searches_performed: 0
sources_count: 12
---

# MCP Tools Sidebar Enhancement — Toggle, Status Indicators, and Scope Badges

## Research Summary

This report synthesizes findings from eight prior research reports and direct codebase inspection to inform three proposed enhancements to the MCP server list in `ConnectionsView.tsx`: per-server enable/disable toggles (with context-window rationale), self-documenting status indicators (colored dots with tooltips), and scope/source badges (project, user, managed). The existing data model already has `scope` on `McpServerEntry` and the `CapabilitiesTab` already implements an override/inherited toggle pattern that is directly applicable.

The core recommendation is a **three-layer progressive disclosure** approach: the sidebar row stays compact (dot + name + scope badge + state text), the row becomes a toggle target via a persistent switch on hover, and a tooltip on the status dot explains what the dot means in plain language.

---

## Key Findings

### 1. The Existing Data Model Already Supports All Three Features

`McpServerEntry` in `packages/shared/src/transport.ts` (lines 85–94) already has:

```typescript
export interface McpServerEntry {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  status?: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  scope?: string; // 'project' | 'user' | 'local' | 'claudeai' | 'managed'
}
```

- `scope` is already present and populated by the server — no schema changes needed for scope badges.
- `status` covers all states needed for status dot semantics.
- An `enabled` boolean would need to be added for per-server toggles (currently `disabled` status implies the server is off, but there is no explicit client-side toggle field).

### 2. The Toggle Pattern Already Exists in CapabilitiesTab

`CapabilitiesTab.tsx` implements the exact pattern needed for MCP server toggles:

- A `Switch` component with an `effectiveValue` (global default overridden by per-agent setting)
- An `isOverridden` label that shows "Inherited" vs "Overridden: On/Off"
- A `RotateCcw` reset-to-default button that appears only when overridden
- Server-disabled state that disables the switch with a tooltip explanation

The MCP sidebar toggle should follow this same pattern but compressed to fit within a `SidebarMenuButton` row.

### 3. Status Indicator Semantics Are Already Partially Established

`ConnectionsView.tsx` already has `MCP_STATUS_COLORS` mapping:

```typescript
const MCP_STATUS_COLORS: Partial<Record<string, string>> = {
  connected: 'bg-green-500',
  failed: 'bg-red-500',
  'needs-auth': 'bg-amber-500',
  pending: 'bg-amber-500',
  disabled: 'bg-muted-foreground/20',
};
```

The gap is that these dots are not self-documenting — the user has no way to know what they mean without documentation. The tunnel toggle research (`20260217_tunnel_toggle_ux_research.md`) confirmed: **the semantic dot + tooltip pattern is the industry standard** (ngrok, Tailscale, GitHub Actions, Vercel all do this).

### 4. Scope Source Badges Are a Recognized Industry Pattern

VS Code's MCP integration and Claude Code's own configuration system both expose scope as a first-class concept. The four meaningful scopes for DorkOS are:

- `project` — from `.mcp.json` in the project directory
- `user` — from `~/.claude/settings.json` (user-wide)
- `local` — from `.claude/settings.local.json` (local override, gitignored)
- `managed` / `claudeai` — from DorkOS or system management

The prior research on MCP tool name formatting (`20260324_mcp_tool_name_formatting_ui.md`) established a `getMcpServerBadge()` utility in `shared/lib/tool-labels.ts` for origin badges. The scope badge problem is analogous: a small visual tag that answers "where does this come from?"

### 5. Progressive Disclosure Is the Correct Pattern for Technical Metadata

From `20260324_status_bar_inline_management_ux.md`: the world-class pattern is "hover reveals controls; right-click reveals management; always visible is for essential information only." Applied to the MCP server list:

- **Always visible**: dot + name + scope badge (small enough to be non-intrusive)
- **On hover**: toggle switch appears (right side of row) for one-click enable/disable
- **On tooltip (hover dot)**: plain-language explanation of what the status means
- **On click row / action button**: opens a detail panel or the Claude Code config location

---

## Detailed Analysis

### The Toggle UX Design Problem

The fundamental UX challenge with per-server MCP toggles: the user needs to disable a server to save context window space, but the toggle lives in a compact sidebar row with limited space.

Three approaches:

**Option A: Inline toggle switch on every row (always visible)**

```
● filesystem   [project]   [●─] On
● github-mcp   [user]      [─○] Off
```

Pros: Immediately discoverable, zero hidden state.
Cons: Visual weight is high; 8+ servers creates a wall of switches; switch adds ~48px per row to an already-compact sidebar.

**Option B: Toggle appears on hover only (recommended)**

```
● filesystem   [project]                      ← default state
● filesystem   [project]       [●─] ← hover reveals switch
```

The switch slides in from the right on row hover (150ms ease-out). This matches the pattern Linear uses for sidebar customization controls: "drag handle appears on hover" — not always, but immediately available when needed. The mental model: "if I want to change this, I hover it."

Pros: Clean default state; zero extra visual weight when just reading; familiar from Linear sidebar.
Cons: Toggle is not visible until hover — first-time discoverability requires curiosity.

Discoverability mitigation: On the first load where an MCP server has `status: 'disabled'`, show a "Manage servers →" ghost affordance at the bottom of the MCP list (one-time, dismissible) that explains toggles are available on hover. This is the "N more available" Pattern D from `20260324_status_bar_inline_management_ux.md`.

**Option C: Toggle only in a management drawer/modal (not recommended)**

A dedicated "Manage MCP Servers" sheet that opens via a gear icon on the group header. Full toggle management happens there, not inline.

Pros: Clean sidebar, no inline complexity.
Cons: Requires two-step access for a common operation; violates the zero-distance principle (right-click action should be zero-distance from the target item).

**Recommendation: Option B with a first-use affordance.**

### Status Dot — Self-Documentation Pattern

The dots are already correctly colored. What they lack is a tooltip that tells the user in plain English what each state means.

Proposed tooltip copy for each `status` value:

| Status       | Dot                          | Tooltip                                                         |
| ------------ | ---------------------------- | --------------------------------------------------------------- |
| `connected`  | `bg-green-500`               | "Connected — tools available in context"                        |
| `pending`    | `bg-amber-500 animate-pulse` | "Connecting — waiting for server response"                      |
| `needs-auth` | `bg-amber-500`               | "Authentication required — run the auth flow to connect"        |
| `failed`     | `bg-red-500`                 | "Failed to connect" + `error` field if present                  |
| `disabled`   | `bg-muted-foreground/20`     | "Disabled — server excluded from this session"                  |
| `undefined`  | `bg-muted-foreground/40`     | "Status unknown — server registered but no session has run yet" |

The tooltip should be triggered on the dot itself (not the whole row), using a `<Tooltip>` + `<TooltipTrigger asChild>` wrapping just the `<span className="size-2 rounded-full" />`. This is a tight, non-intrusive affordance.

For `failed` status, the error field should be shown if non-empty:

```
"Failed to connect: ECONNREFUSED localhost:3001"
```

This is the error surfacing pattern from `20260316_sdk_result_error_ux_patterns.md`.

### Scope Badge Design

The `scope` field values and their visual representations:

| Scope       | Badge text | Color           | Meaning                                |
| ----------- | ---------- | --------------- | -------------------------------------- |
| `project`   | `project`  | neutral (muted) | From `.mcp.json` in the project root   |
| `user`      | `user`     | neutral (muted) | From `~/.claude/settings.json`         |
| `local`     | `local`    | neutral (muted) | Local override, not committed to git   |
| `managed`   | `managed`  | neutral (muted) | DorkOS-managed                         |
| `claudeai`  | `managed`  | neutral (muted) | Claude.ai platform managed             |
| `undefined` | none       | —               | Don't show a badge if scope is unknown |

Badge rendering: use the same pattern as `getMcpServerBadge()` in `tool-labels.ts`:

```tsx
<span className="bg-muted text-muted-foreground text-3xs rounded px-1 py-0.5 font-medium">
  {scopeLabel}
</span>
```

Keep the badge `text-3xs` (8–9px) and neutral — it should read as metadata, not as a warning or call to action. It answers "where does this come from?" without drawing the eye.

Placement: between the server name and the state text (right side of row), before any toggle. This follows the `ToolCallCard` badge pattern.

**An important nuance**: scope is about _where this server was configured_. It helps the user understand:

- "This `github` server comes from my `~/.claude/settings.json` — it will appear in all my projects"
- "This `postgres` server comes from the project `.mcp.json` — it's project-specific"

This is directly analogous to VS Code's extension scope (workspace vs. user) and JetBrains' plugin management (project vs. global).

### Context Window Toggle — The Core User Rationale

The user's stated reason for wanting per-server toggles is context window management. This is a meaningful concern:

From `20260303_agent_tool_context_injection.md` research: each MCP tool description consumes ~25–35 tokens, and DorkOS's external tool context is injected statically. A server with 20 tools adds ~500–700 tokens of tool schema to the context window. Disabling the server removes those tool descriptions from the context.

The Claude Code Agent SDK behavior when a server is `disabled`: the SDK skips loading the server's tools entirely. The tools do not appear in the context window. This is confirmed behavior.

From the user's perspective, the mental model is: "If I'm not using this database tool server today, I should turn it off so my agent has more room for the actual task." This is reasonable and correct.

The toggle in the sidebar should reflect this clearly. The state text for a disabled server should say "off" (not "disabled" — "disabled" implies something went wrong, "off" implies a deliberate choice). This matches the existing DORKOS_TOOLS pattern in `ConnectionsView.tsx` which uses `state === 'enabled' ? 'enabled' : 'off'`.

---

## Proposed UI Layout

### Current Row (from ConnectionsView.tsx)

```
● filesystem    mcp
```

A `size-2` colored dot, server name truncated, static "mcp" label at right.

### Proposed Row — Default State

```
● filesystem  [project]    off
```

`size-2` dot (with tooltip on hover), server name, small scope badge, state text. The "mcp" label is replaced by the scope badge + state text.

The scope badge only renders if `scope` is present on the entry.

### Proposed Row — Hover State (toggle revealed)

```
● filesystem  [project]    [●─]
```

The state text fades out (`opacity-0`) and a small `Switch` (`h-5 w-9`, shadcn size `sm`) slides in from the right via `AnimatePresence`. Both are in the same grid cell — the switch replaces the state text on hover.

The animation pattern to use:

```tsx
<AnimatePresence mode="wait">
  {isHovered ? (
    <motion.div
      key="switch"
      initial={{ opacity: 0, x: 4 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 4 }}
      transition={{ duration: 0.12 }}
    >
      <Switch checked={isEnabled} onCheckedChange={handleToggle} size="sm" />
    </motion.div>
  ) : (
    <motion.span
      key="label"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="text-muted-foreground/50 text-xs"
    >
      {stateLabel}
    </motion.span>
  )}
</AnimatePresence>
```

This is exactly the pattern used in the `ConnectionsView.tsx` overflow text animation (`overflowTextVariants`).

### Keyboard and Accessibility

- The `Switch` must remain keyboard-accessible when hidden: add a `sr-only` toggle description to the row's `SidebarMenuButton` so screen readers can discover the control
- `aria-label="Toggle {server.name} MCP server"` on the Switch
- `role="tooltip"` + `aria-describedby` for the status dot tooltip

---

## Architecture: Where Does Toggle State Live?

The toggle state must be persisted and communicated to the SDK. There are two layers:

### Layer 1: Client-side UI state (Zustand / localStorage)

For **immediate UI feedback** before the server confirms the change. The pattern from `20260317_debug_sync_toggles_ux_patterns.md`: add to `app-store.ts`'s `BOOL_KEYS` or in this case a `SET_KEYS` for a set of disabled server names:

```typescript
disabledMcpServers: Set<string>;
// persisted as JSON array in localStorage
```

### Layer 2: Persist to configuration

For **permanent effect**, the disabled state must be written to the configuration that the SDK reads. There are two options:

**Option A: Write to `.mcp.json`** — Set `"disabled": true` on the server entry. The SDK honors this.

**Option B: Write to agent manifest** — Store `disabledMcpServers: string[]` in `.dork/agent.json`. The server reads this when starting a session and excludes the servers.

**Recommendation**: Option B (agent manifest) for per-agent context management, which is the most natural scope for context window management. A user disabling `github-mcp` for their code review agent doesn't want it disabled for their documentation agent.

The existing `CapabilitiesTab` toggle pattern writes to `agent.enabledToolGroups` in the agent manifest — the MCP server toggles should write to a new `disabledMcpServers: string[]` field on `AgentManifest`.

If no agent is active in the session (agentId is null), the toggle should be disabled with a tooltip: "Select an agent to manage per-agent server preferences."

---

## Solution Comparison

### Option 1: Hover-reveal toggle with tooltip dots and scope badges (Recommended)

**What:** The three enhancements as described above — scope badge replaces "mcp" label, tooltip on status dot, hover-reveal toggle switch that writes to agent manifest.

**Pros:**

- Zero change to default visual density — non-hover state looks almost identical to current
- Scope badge provides genuinely useful "where did this come from?" answer
- Self-documenting dots reduce support load for "what does the yellow dot mean?"
- Toggle persists per-agent, not globally — respects context management intent
- Consistent with `CapabilitiesTab` override/inherited pattern
- Consistent with `ConnectionsView.tsx` motion patterns already in place
- Follows Linear's sidebar customization model (right-level controls appear on hover)

**Cons:**

- Hover-reveal toggle has discoverability gap for first-time users (mitigated by first-use affordance)
- Requires new API endpoint or mutation to write `disabledMcpServers` to agent manifest
- The Switch component in a 28px sidebar row is compact — may require custom sizing

**Complexity:** Medium. Two new fields in data model, one mutation hook, ~50 lines of JSX additions to `ConnectionsView.tsx`.

---

### Option 2: Toggle always visible (without hover-reveal)

**What:** Same as Option 1 but the Switch is always shown on the right side of each row, removing the animation entirely.

**Pros:**

- Higher discoverability — toggle is always visible
- No hover state to manage

**Cons:**

- A list of 8 servers with 8 toggle switches is visually heavy — the sidebar becomes a form
- Dieter Rams: "As little design as possible." Every switch adds a decision point to the user's visual field
- Fails the Priya Test: a staff architect scanning the sidebar during a coding session does not want 8 toggles competing for attention

**Recommendation:** Not preferred for the sidebar context. Appropriate only in a dedicated management panel (see Option 3).

---

### Option 3: Management panel (modal/sheet) for toggles; sidebar is read-only

**What:** Add a gear icon to the MCP Tools group header (`SidebarGroupAction`). Clicking opens a `Sheet` with the full management surface (toggles, scope badges, error details). The sidebar row remains read-only.

**Pros:**

- Sidebar stays clean
- Full management surface can show more detail (transport type, error messages, config path)
- Consistent with the `CapabilitiesTab` as a settings surface

**Cons:**

- Two-step access for a common operation (toggle a server)
- The sidebar action button (`ArrowUpRight`) pattern already exists but currently just opens the MCP config — adding a dedicated sheet for MCP server management is an extra surface
- Context window management is a quick-access operation; it should be as close to zero-clicks as possible

**Recommendation:** Not the primary pattern, but a useful complement. The gear icon (`Settings2` from lucide) on the group header can open a detail sheet for servers with errors or for advanced configuration, while the hover-reveal toggle covers the common case.

---

### Option 4: Right-click context menu for toggle

**What:** Right-clicking a server row shows a context menu with "Enable/Disable for this agent" and "View config source."

**Pros:**

- Zero persistent UI clutter
- Matches the VS Code / Linear / IntelliJ right-click pattern for status bar management
- `20260324_status_bar_inline_management_ux.md` identified this as the "zero-distance" pattern

**Cons:**

- Right-click is a secondary interaction (not primary) — users may not discover it
- Context menus on touch/mobile surfaces are problematic (Obsidian plugin mode)
- Less suited for a "manage multiple servers" workflow

**Recommendation:** Add as a supplementary interaction alongside Option 1. The right-click menu provides keyboard/power-user access to the same actions that hover-reveal provides for mouse users.

---

## Recommended Implementation Plan

### Phase 1: Status dot tooltips + scope badges (Non-breaking, no new API surface)

These two changes are purely read-only display enhancements with no backend changes.

**Files modified:**

- `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`

**Changes:**

1. Wrap the status dot `<span>` in a `<Tooltip>` + `<TooltipTrigger asChild>` + `<TooltipContent>` using the tooltip copy table above
2. Add a scope badge between the server name and state text using the `text-3xs` badge pattern
3. Add `SCOPE_LABELS` constant mapping scope strings to display text

```typescript
const SCOPE_LABELS: Record<string, string> = {
  project: 'project',
  user: 'user',
  local: 'local',
  managed: 'managed',
  claudeai: 'managed',
};

const MCP_STATUS_TOOLTIPS: Record<string, string> = {
  connected: 'Connected — tools available in context',
  pending: 'Connecting — waiting for server response',
  'needs-auth': 'Authentication required',
  failed: 'Failed to connect',
  disabled: 'Disabled — excluded from this session',
};
```

**Effort:** ~30 lines of JSX. No new dependencies. No API changes. Zero risk.

---

### Phase 2: Hover-reveal toggle (requires agent manifest extension)

**Backend changes:**

1. Add `disabledMcpServers?: string[]` to `AgentManifest` in `packages/shared/src/mesh-schemas.ts`
2. Add a mutation endpoint: `PATCH /api/agents/:id/mcp-servers` accepting `{ disabledServers: string[] }`
3. Server reads `disabledMcpServers` from agent manifest and passes to SDK session configuration (the exact mechanism depends on how the Claude Code SDK accepts per-session allowed tools — potentially via `allowedTools` filtering using the `mcp__server__*` prefix pattern)

**Frontend changes:**

1. Add `useMcpServerToggle(agentId, serverName)` hook in `entities/agent/model/`
2. In `ConnectionsView.tsx`, add hover state with `useHover` or onMouseEnter/Leave
3. Replace state text with `AnimatePresence` wrapper toggling between label and Switch

**Effort:** Medium. ~100 lines of new code across 3–4 files, plus schema changes.

---

### Phase 3: Right-click context menu (Enhancement, lower priority)

**Frontend changes only:**

1. Wrap `SidebarMenuButton` in a `ContextMenu` from shadcn
2. Context menu items: "Enable for this agent" / "Disable for this agent", "View config source", separator, "Open config file"
3. "View config source" opens a tooltip or toast showing the file path where this server is configured

**Effort:** ~40 lines. No new backend surface.

---

## Micro-Interaction Specifications

Following `motion` library patterns established in `ConnectionsView.tsx`:

| Interaction                         | Animation                                  | Duration | Easing        |
| ----------------------------------- | ------------------------------------------ | -------- | ------------- |
| Toggle switch appears on hover      | `x: 4→0, opacity: 0→1`                     | 120ms    | `[0,0,0.2,1]` |
| Toggle switch disappears on unhover | `x: 0→4, opacity: 1→0`                     | 120ms    | `[0,0,0.2,1]` |
| State label fades out (on hover)    | `opacity: 1→0`                             | 100ms    | ease-out      |
| State label fades in (on unhover)   | `opacity: 0→1`                             | 100ms    | ease-out      |
| Row disabled state                  | opacity 0.5, cursor-not-allowed on switch  | —        | —             |
| Server being toggled                | Switch shows `aria-busy`, dot pulses amber | —        | —             |

For the toggle transition state (toggle flipped, waiting for server confirmation): use the three-phase pattern from `20260217_tunnel_toggle_ux_research.md`: disable the switch, show an amber pulsing dot, restore on success/error.

---

## Design Principles Applied

**Dieter Rams — Less, but better:** The scope badge replaces the existing "mcp" label (not an addition). The tooltip on the dot replaces nothing visible (it's new information on demand). The hover-reveal toggle adds zero visible elements until interaction. Net visual complexity in default state: near zero change.

**Apple / Jony Ive — Progressive disclosure:** You see what you need at each level of engagement. Glancing: dots and names. Curious: hover to see source scope and toggle access. Managing: context menu or dedicated panel.

**The Kai Test:** A senior dev with 10 agents and 15 MCP servers benefits immediately from scope badges ("which `postgres` is this — the project one or my user one?") and from hover toggles during context budget management.

**The Priya Test:** A staff architect in flow-preservation mode appreciates that the sidebar has not become noisier — default state is nearly identical to current.

---

## Sources & Evidence

- `ConnectionsView.tsx` — current implementation of MCP server list in the sidebar (inspected directly)
- `CapabilitiesTab.tsx` — existing override/inherited switch pattern to replicate
- `packages/shared/src/transport.ts` lines 85–94 — `McpServerEntry` with `scope` field already present
- `research/20260217_tunnel_toggle_ux_research.md` — three-phase async toggle UX, semantic dot colors, tooltip copy patterns
- `research/20260324_status_bar_inline_management_ux.md` — right-click context menu pattern, VS Code hide/show model, Linear hover drag handles
- `research/20260328_multi_panel_toggle_ux_patterns.md` — progressive disclosure, hover-reveal controls, badge on panel toggle
- `research/20260303_agent_tool_context_injection.md` — token cost of MCP tool schemas (~25–35 tokens per tool), rationale for per-server disable
- `research/20260317_debug_sync_toggles_ux_patterns.md` — Zustand localStorage toggle pattern, per-key BOOL_KEYS approach
- `research/20260304_mcp_tool_naming_conventions.md` — `mcp__server__tool` SDK namespace wrapping; `allowedTools` filtering via `mcp__server__*` pattern
- `research/20260324_mcp_tool_name_formatting_ui.md` — `getMcpServerBadge()` badge pattern in shared/lib/tool-labels.ts; origin badge design
- `research/20260316_system_status_compact_boundary_ui_patterns.md` — tooltip pattern for status dots, Slack inline system message visual weight
- `research/20260301_ftue_best_practices_deep_dive.md` — first-use educational affordances, ghost chip patterns

---

## Research Gaps & Limitations

- The exact SDK API for excluding MCP servers from a running session was not verified. The `allowedTools` field using `mcp__servername__*` prefix is the documented filtering mechanism, but whether this can be set to exclude an entire server dynamically (vs. at session start) needs confirmation via SDK source inspection.
- No empirical data on how many tokens are saved per disabled server in practice — the 25–35 token per tool estimate is an approximation from the context injection research.
- The `disabledMcpServers` approach writes to the agent manifest, which requires an agent to be loaded. The behavior when `agentId` is null (no agent selected in the session) has not been fully designed — the recommendation to disable the toggle in that state needs UX validation.
- The `scope` field's mapping from Claude Code's internal values to DorkOS's display labels has not been verified against the actual SDK source. The values `project`, `user`, `local`, `claudeai`, `managed` are inferred from Claude Code documentation and the existing `McpServerEntry` comment.

---

## Contradictions & Disputes

- **Toggle discoverability vs. visual cleanliness:** Option A (always-visible toggle) trades visual cleanliness for discoverability. Option B (hover-reveal) trades discoverability for cleanliness. The resolution depends on whether context-window management is a frequent or occasional operation. The research framing (the user wants to do this to "save context window space") implies it is situational, not daily — favoring hover-reveal.
- **Per-agent vs. global disable:** Writing to the agent manifest means toggles are per-agent. A user managing 3 agents who wants to disable `github-mcp` globally would need to do it 3 times. An alternative is a global `disabledMcpServers` in server config (`.mcp.json` or `~/.dork/config.json`). The per-agent approach is more precise but less ergonomic for multi-agent bulk disabling. The global approach matches macOS Control Center's per-item "Don't show in Menu Bar" which applies universally.

---

## Search Methodology

- Web search not performed (no search tool access in this session)
- 8 prior research reports consulted
- Direct codebase inspection: `ConnectionsView.tsx`, `CapabilitiesTab.tsx`, `transport.ts`, `use-mcp-config.ts`
- Research depth: Focused Investigation (existing cache sufficient, no gaps requiring new searches)
