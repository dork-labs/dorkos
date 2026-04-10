# Agent-Centric UX — Command Palette, Sidebar Redesign, Mesh Always-On

**Status:** Draft
**Authors:** Claude Code, 2026-03-03
**Spec:** #85
**Ideation:** `specs/agent-centric-ux/01-ideation.md`

---

## Overview

Redesign DorkOS UX to put agents at the center of everything. Three connected changes: (1) a global Command Palette (`Cmd+K`) using the existing Shadcn Command component for agent switching and feature access, (2) a full agent-centric sidebar redesign where agents are the primary organizational unit, and (3) making Mesh always-on by removing the `DORKOS_MESH_ENABLED` feature flag.

## Background / Problem Statement

DorkOS currently treats working directories as the primary organizational unit. Users switch context via a `DirectoryPicker` dialog, and the sidebar shows sessions grouped by time with a small agent header. Agents — the core abstraction of DorkOS — are secondary to the directory they live in.

Meanwhile, the Mesh agent registry is gated behind a feature flag (`DORKOS_MESH_ENABLED`), despite defaulting to `true` in the config schema. This creates unnecessary friction: the command palette needs Mesh data to list agents, and the disabled state adds code complexity without providing user value.

The result is a UX that doesn't match DorkOS's vision as an OS-layer for AI agents. Users should think in terms of agents, not directories.

## Goals

- Provide a fast, keyboard-driven way to switch between agents via `Cmd+K` / `Ctrl+K`
- Make agents the primary organizational unit in the sidebar
- Remove the Mesh feature flag so the agent registry is always available
- Maintain backward compatibility for directories without agent manifests
- Follow existing FSD architecture, design system, and component patterns

## Non-Goals

- Relay/Pulse UI redesign
- Agent persona editing flows
- Onboarding flow changes (minor updates only for always-on Mesh)
- Mobile-native app considerations (mobile web only)
- Multi-agent sidebar showing all agents simultaneously (future iteration)
- Replacing the existing inline slash command palette (`features/commands/`)

## Technical Dependencies

- **cmdk** (via Shadcn Command) — already installed at `layers/shared/ui/command.tsx`, currently unused
- **Radix Dialog** — already installed, used by CommandDialog wrapper
- **ResponsiveDialog** — existing component at `layers/shared/ui/responsive-dialog.tsx` (Dialog on desktop, Drawer on mobile)
- **Zustand** — existing state management for dialog open/close state
- **TanStack Query** — existing data fetching for mesh agent paths
- **ADR-0043** — file-first write-through for agent storage (filesystem is canonical)
- **ADR-0050** — agent identity independent of mesh (always-mounted `/api/agents` routes)

## Detailed Design

### Change 1: Global Command Palette (Cmd+K)

#### Architecture

New FSD module at `apps/client/src/layers/features/command-palette/` with these files:

```
features/command-palette/
├── ui/
│   ├── CommandPaletteDialog.tsx    # Root dialog wrapping Shadcn CommandDialog
│   └── AgentCommandItem.tsx        # Agent result row with color, emoji, path
├── model/
│   ├── use-global-palette.ts       # Open/close state + Cmd+K keyboard binding
│   ├── use-agent-frecency.ts       # localStorage frecency tracking
│   └── use-palette-items.ts        # Assembles all command items from sources
└── index.ts                        # Barrel exports
```

**Mounting:** `CommandPaletteDialog` is rendered in `App.tsx` at the root level, alongside `Toaster`. This ensures it's accessible even with the sidebar closed.

**State:** A single `globalPaletteOpen` boolean in the Zustand app-store, with `setGlobalPaletteOpen` and `toggleGlobalPalette` actions. This follows the existing pattern for `settingsOpen`, `pulseOpen`, etc.

#### CommandPaletteDialog

Wraps the Shadcn `Command` component inside a `ResponsiveDialog`:

- **Desktop:** Renders as a centered Dialog (via Radix Dialog, same as Shadcn's `CommandDialog` pattern)
- **Mobile:** Renders as a bottom Drawer (via Vaul, same as all other `ResponsiveDialog` usages)

```tsx
// Simplified structure
<ResponsiveDialog open={globalPaletteOpen} onOpenChange={setGlobalPaletteOpen}>
  <ResponsiveDialogContent>
    <Command loop shouldFilter>
      <CommandInput placeholder="Search agents, features, commands..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {/* Content groups rendered by usePaletteItems() */}
      </CommandList>
    </Command>
  </ResponsiveDialogContent>
</ResponsiveDialog>
```

Key props:

- `loop` — wraps arrow key navigation at list edges
- `shouldFilter` — cmdk's built-in fuzzy filtering (no custom filter needed)

#### Open in New Tab

Agent items support opening in a new browser tab. Default behavior (Enter or click) switches the current tab. Holding `Cmd` (Mac) / `Ctrl` (Windows/Linux) while selecting opens the agent in a new browser tab.

Implementation: Since DorkOS uses URL params (`?dir=` for working directory), opening in a new tab is `window.open(window.location.pathname + '?dir=' + encodeURIComponent(agent.projectPath))`. The `onSelect` handler on `CommandItem` checks `e.metaKey || e.ctrlKey` to decide between `setDir()` (current tab) and `window.open()` (new tab).

A subtle hint is shown on agent items: "Hold `Cmd` to open in new tab" appears as a tooltip or as secondary text when hovering/focusing an agent item.

#### Content Groups

Rendered in this order. cmdk's built-in filtering handles show/hide based on search input.

**1. Recent Agents** (zero-query state)

- Source: `useAgentFrecency()` cross-referenced with `useMeshAgentPaths()`
- Shows top 5 frecency-sorted agents
- Active agent pinned first with checkmark via `forceMount` on its `CommandItem`
- Hidden when `@` prefix is active (All Agents group takes over)

**2. All Agents** (search / `@` mode)

- Source: `useMeshAgentPaths()`
- Shows all registered agents, filtered by search term
- When input starts with `@`, this group replaces Recent Agents and shows all agents
- The `@` character is stripped from the search term before filtering

**3. Features**

- Static list: Pulse Scheduler, Relay Messaging, Mesh Network, Settings
- Selecting a feature calls the corresponding setter from app-store (`setPulseOpen(true)`, `setRelayOpen(true)`, `setMeshOpen(true)`, `setSettingsOpen(true)`), which opens the existing `ResponsiveDialog` for that feature
- Each shows an icon + name + optional keyboard shortcut hint

**4. Commands**

- Source: `useCommands()` (existing entity hook)
- Shows `/namespace:command` + description
- Selecting a command inserts it into the chat input (same as the inline palette)

**5. Quick Actions**

- Static list: New Session, Discover Agents, Browse Filesystem, Toggle Theme
- New Session: calls `createMutation.mutate()` (same as sidebar button)
- Discover Agents: opens Mesh panel to discovery tab (`setMeshOpen(true)`)
- Browse Filesystem: opens DirectoryPicker (`setPickerOpen(true)`)
- Toggle Theme: cycles theme (same as sidebar footer button)

#### AgentCommandItem

Custom `CommandItem` rendering for agent rows:

```
[●] auth-service              ~/projects/auth-svc    ✓
     "Builds and deploys the auth API"
```

- Colored dot: `agent.color` or `hashToHslColor(agent.id)` — reuses `useAgentVisual` logic
- Agent name: bold, truncated
- Abbreviated cwd path: muted, right-aligned — uses `shortenHomePath()` from `shared/lib`
- Checkmark: shown on active agent (where `agent.projectPath === selectedCwd`)
- Optional description line: from agent manifest, muted text
- `keywords` prop: includes cwd path, description, persona name for fuzzy search discoverability

#### `@` Prefix Mode

When the `CommandInput` value starts with `@`:

1. Strip `@` from the search term passed to cmdk's filter
2. Hide the Recent Agents, Features, Commands, and Quick Actions groups
3. Show only the All Agents group
4. Useful for large registries (10+ agents) where the user knows they want an agent

Implementation: a controlled `value` state on `Command` that detects the `@` prefix and conditionally renders groups.

#### Frecency (`useAgentFrecency`)

Tracks agent usage in localStorage under key `dorkos-agent-frecency`.

```typescript
interface FrecencyEntry {
  agentId: string;
  lastUsed: string; // ISO timestamp
  useCount: number;
}

// Scoring formula
score = useCount / (1 + hoursSinceUse * 0.1);
```

- `recordUsage(agentId)` — called when an agent is selected from the palette
- `getSortedAgents(agentPaths)` — returns agent paths sorted by frecency score, falling back to alphabetical for untracked agents
- Entries older than 30 days with 0 recent usage are pruned on read
- Maximum 50 entries stored

#### Keyboard Binding (`useGlobalPalette`)

Registers a global `keydown` listener for `Cmd+K` (Mac) / `Ctrl+K` (Windows/Linux):

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      toggleGlobalPalette();
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}, [toggleGlobalPalette]);
```

This follows the exact pattern used for `Cmd+B` (sidebar toggle) in `App.tsx`.

#### Mobile Trigger

On mobile, the command palette is also opened by tapping the agent header in the sidebar. The `AgentHeader` component's name/identity area becomes a tap target that calls `setGlobalPaletteOpen(true)` instead of (or in addition to) opening the agent dialog.

### Change 2: Agent-Centric Sidebar Redesign

#### AgentHeader Redesign

The current `AgentHeader` (105 lines) is redesigned to be a prominent, card-like element:

**When agent is registered:**

```
┌─────────────────────────┐
│ [●] auth-service         │  ← Colored dot + emoji + agent name (bold, large)
│     ~/projects/auth-svc  │  ← Abbreviated path (muted, small)
│     [⌘K Switch]    [⚙]  │  ← Switch opens palette; gear opens AgentDialog
└─────────────────────────┘
```

- Agent name is the primary visual element — large, bold text
- Colored dot uses `useAgentVisual(agent, cwd)` (same as today)
- Path is secondary — shown as muted text below the name, uses `shortenHomePath()`
- "Switch" button: shows `⌘K` (or `Ctrl+K` on non-Mac) hint text, calls `setGlobalPaletteOpen(true)`
- Gear icon: calls `onOpenAgentDialog()` (same as today)
- On mobile: tapping the agent name/identity area opens the command palette (no `⌘K` text shown)

**When no agent (unregistered directory):**

Falls back to the current directory-based UX:

- Shows `FolderOpen` icon + `PathBreadcrumb` (same as today's no-agent branch)
- Sessions still work normally — no agent framing
- "Switch" area shows `⌘K` to open the command palette
- Optional "+ Agent" quick-create button (same as today)

This is graceful degradation, not an error state. The user can still use DorkOS fully without an agent manifest.

#### SessionSidebar Changes

The `SessionSidebar` (407 lines) structure changes:

**Before:**

```
AgentHeader (small) → [+ New Chat] → session list → onboarding → footer
```

**After:**

```
AgentHeader (prominent, card-like) → [+ New Session] → session list → onboarding → footer
```

Specific changes:

1. **AgentHeader receives more vertical space.** The header area gets padding and visual weight proportional to its importance.
2. **"New Chat" → "New Session"** label change to frame sessions as agent conversations.
3. **Session list is contextually labeled.** When an agent is active, sessions are implicitly "this agent's conversations." No explicit label change needed — the prominent agent header provides context.
4. **Footer is unchanged.** DorkOS branding + feature icon buttons remain the same.
5. **Feature ResponsiveDialogs stay in SessionSidebar.** The dialogs for Pulse, Relay, Mesh, and Settings remain portaled from `SessionSidebar` — the command palette just provides an additional way to open them.

#### State Flow for Agent Switching

When the user selects an agent from the command palette:

```
User selects agent → recordUsage(agentId) → setDir(agent.projectPath) → palette closes
  → useDirectoryState updates selectedCwd + clears sessionId
  → sidebar re-renders with new agent's sessions
  → AgentHeader shows new agent identity
```

This reuses the existing `useDirectoryState` hook (`entities/session`), which handles both standalone (URL `?dir=` param) and embedded (Zustand) modes. The `setDir()` function already clears the active session, which is the correct behavior when switching agents.

### Change 3: Mesh Always-On

#### Server-Side Changes

**`apps/server/src/env.ts`:**
Remove `DORKOS_MESH_ENABLED` from the Zod schema entirely. The env var will no longer be parsed or recognized.

**`apps/server/src/index.ts`:**
Remove the `if (meshEnabled)` conditional block (lines ~136-224). The MeshCore initialization, route mounting, and reconciler startup become unconditional:

```typescript
// Before: const meshEnabled = env.DORKOS_MESH_ENABLED || meshConfig?.enabled;
// After: Always initialize (no condition)

const meshSignalEmitter = relayCore ? new SignalEmitter() : undefined;

try {
  meshCore = new MeshCore({ db, relayCore, signalEmitter: meshSignalEmitter, logger });
  logger.info('[Mesh] MeshCore initialized');

  try {
    const result = await meshCore.reconcileOnStartup();
    logger.info('[Mesh] Startup reconciliation complete', result);
  } catch (err) {
    logger.error('[Mesh] Startup reconciliation failed', logError(err));
  }

  meshCore.startPeriodicReconciliation(300_000);
} catch (err) {
  const errInfo = logError(err);
  logger.error('[Mesh] Failed to initialize MeshCore', errInfo);
  setMeshInitError(errInfo.error);
  // Mesh failure is non-fatal — server continues without Mesh
}

// Always mount routes
if (meshCore) {
  app.use('/api/mesh', createMeshRouter(meshCore));
  setMeshEnabled(true);
  logger.info('[Mesh] Routes mounted');
}
```

The try/catch and error handling remain — MeshCore can still fail (e.g., SQLite write errors). The only change is removing the "disabled by config" path.

**`apps/server/src/services/mesh/mesh-state.ts`:**
Two options:

- **Option A (minimal diff):** Keep file, hard-code `isEnabled = () => true`. Remove `setEnabled`.
- **Option B (clean removal):** Delete file. Update all consumers to not check the flag.

Recommendation: **Option A** for this spec. `setMeshInitError` and `getMeshInitError` are still useful for the config route to report init failures. A follow-up can fully remove the module.

**`apps/server/src/routes/config.ts`:**
Always return `mesh.enabled: true` in the config response. Keep `initError` reporting:

```typescript
mesh: {
  enabled: true,  // Always on
  scanRoots: configManager.get('mesh')?.scanRoots ?? [],
  ...(getMeshInitError() && { initError: getMeshInitError() }),
},
```

**`packages/shared/src/config-schema.ts`:**
Remove the `enabled` field from the `mesh` object. Keep `scanRoots`:

```typescript
mesh: z
  .object({
    scanRoots: z.array(z.string()).default(() => []),
  })
  .default(() => ({ scanRoots: [] })),
```

**`.env.example`:**
Remove the `DORKOS_MESH_ENABLED` line.

**`turbo.json`:**
Remove `DORKOS_MESH_ENABLED` from `globalPassThroughEnv`.

#### Client-Side Changes

**`entities/mesh/model/use-mesh-config.ts`:**
`useMeshEnabled()` returns `true` unconditionally:

```typescript
export function useMeshEnabled(): boolean {
  return true;
}
```

Keep the function signature so existing imports don't break. Consumers can be updated to remove the check in follow-up work.

**`shared/model/use-feature-enabled.ts`:**
Remove `'mesh'` from the `Subsystem` union type:

```typescript
type Subsystem = 'pulse' | 'relay'; // 'mesh' removed
```

**`features/session-list/ui/SessionSidebar.tsx`:**

- Remove `const meshEnabled = useMeshEnabled()` line
- Remove conditional dimming/tooltip on the Mesh footer icon
- The Mesh icon button always opens the Mesh panel normally

**`features/mesh/ui/MeshPanel.tsx`:**

- Remove `useMeshEnabled()` call
- Remove `FeatureDisabledState` gate and its "Enable with `DORKOS_MESH_ENABLED=true`" message
- Always render the panel body

**`features/mesh/ui/MeshStatsHeader.tsx`:**

- Remove `useMeshEnabled()` call
- Remove early `return null` when disabled

**`features/agent-settings/ui/ConnectionsTab.tsx`:**

- Remove `useMeshEnabled()` call
- Always show health data and mesh connections
- Remove "Enable Mesh" prompt

#### Error Handling

MeshCore initialization can still fail at runtime (SQLite errors, filesystem issues). The existing graceful degradation pattern remains:

1. Server logs the error via `setMeshInitError()`
2. Config route reports `{ mesh: { enabled: true, initError: "..." } }`
3. Client can show a subtle error indicator if `initError` is present (existing pattern)
4. The app remains fully functional — Mesh routes simply won't be mounted if `meshCore` is null

#### Test Updates

| Test File                                                                    | Change                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/server/src/__tests__/env.test.ts`                                      | Remove `DORKOS_MESH_ENABLED` test case                                                  |
| `apps/server/src/services/core/__tests__/mcp-mesh-tools.test.ts`             | Remove `meshEnabled` parameter from `createMockDeps()`                                  |
| `apps/client/src/layers/features/mesh/__tests__/MeshPanel.test.tsx`          | Remove `mockUseMeshEnabled` mock; remove disabled state test cases; keep Mode A/B tests |
| `apps/client/src/layers/features/mesh/ui/__tests__/MeshStatsHeader.test.tsx` | Remove `useMeshEnabled` mock; remove disabled test case                                 |
| `apps/client/src/layers/entities/mesh/__tests__/mesh-hooks.test.tsx`         | Remove `useMeshEnabled` test; keep all other hook tests                                 |
| `apps/e2e/pages/MeshPage.ts`                                                 | Remove `DORKOS_MESH_ENABLED=true` text assertion                                        |

## User Experience

### Agent Switching Flow

1. User presses `Cmd+K` (or taps agent header on mobile)
2. Command palette opens with frecency-sorted recent agents
3. User types to filter or selects an agent
4. Active directory switches to the agent's project path
5. Sidebar updates with the new agent's identity and sessions
6. Palette closes automatically

### Zero-Query State

When the palette opens with no search input:

- Top section shows "Recent Agents" (up to 5, frecency-sorted)
- Active agent is pinned at the top with a checkmark
- Below: "Features" (Pulse, Relay, Mesh, Settings)
- Below: "Quick Actions" (New Session, Discover, Browse, Theme)
- Commands are only shown when the user types a search query

### Mobile Experience

- Agent header tap → palette opens as bottom Drawer (via `ResponsiveDialog`)
- Same content groups and search behavior as desktop
- Touch-friendly item heights (minimum 44px tap targets per cmdk defaults)
- Search input auto-focuses with on-screen keyboard
- No `⌘K` keyboard hint shown on mobile (detected via `useIsMobile`)

### No-Agent Fallback

When navigating to a directory without `.dork/agent.json`:

- AgentHeader shows directory path with folder icon (current behavior)
- Sessions work normally — no error state
- Command palette still works — user can switch to a registered agent
- Optional "+ Agent" quick-create button available

## Testing Strategy

### Unit Tests

**Command Palette:**

- `CommandPaletteDialog` renders with all content groups
- `@` prefix mode filters to agents only
- Selecting an agent calls `setDir()` with the correct path
- Cmd+click on agent calls `window.open()` to open in new tab
- Selecting a feature calls the correct dialog setter
- Keyboard shortcut (`Cmd+K`) toggles the palette
- `Cmd+K` closes any open ResponsiveDialog before opening palette
- Empty state shows "No results found"

**Frecency:**

- `recordUsage()` increments count and updates timestamp
- `getSortedAgents()` returns agents in frecency order
- Entries older than 30 days are pruned
- localStorage persistence works correctly
- Graceful degradation when localStorage is unavailable

**AgentHeader:**

- Registered agent: shows name, color, path, switch button, gear icon
- Unregistered directory: shows path with folder icon
- Switch button calls `setGlobalPaletteOpen(true)`
- Gear button calls `onOpenAgentDialog()`
- Mobile: tapping identity area opens palette

**Mesh Always-On:**

- `useMeshEnabled()` returns `true` unconditionally
- `MeshPanel` renders without disabled state gate
- `MeshStatsHeader` renders without enabled check
- Server env schema no longer includes `DORKOS_MESH_ENABLED`

### Integration Tests

- Full agent switching flow: open palette → select agent → verify sidebar updates
- Command palette opens existing ResponsiveDialogs for features
- Mesh routes are always mounted (no conditional initialization)

### Mock Patterns

```typescript
// Command palette tests — mock transport and mesh data
const mockTransport = createMockTransport({
  listMeshAgentPaths: vi.fn().mockResolvedValue([
    { id: 'agent-1', name: 'Auth Service', projectPath: '/projects/auth' },
    { id: 'agent-2', name: 'API Gateway', projectPath: '/projects/gateway' },
  ]),
});

// Wrap in TransportProvider + QueryClientProvider
```

## Performance Considerations

- **Command palette is lazy-mounted.** The `Command` component only renders when `globalPaletteOpen` is true (controlled by `ResponsiveDialog`). No performance cost when closed.
- **`useMeshAgentPaths()` has a 30-second stale time.** Agent data is cached and reused across palette opens without refetching.
- **Frecency uses localStorage.** No network requests. Read/write is synchronous and fast (< 1ms for 50 entries).
- **cmdk handles filtering.** Built-in fuzzy filtering is optimized for lists of hundreds of items. No custom filter implementation needed.
- **Mesh always-on has no performance impact.** MeshCore already initializes in ~50ms. The feature flag check was negligible.

## Security Considerations

- **No new attack surface.** The command palette uses existing data sources (`useMeshAgentPaths`, `useCommands`) and existing actions (`setDir`, dialog setters). No new API endpoints or data flows.
- **localStorage frecency data is non-sensitive.** Contains only agent IDs and timestamps — no credentials or personal data.
- **Mesh always-on doesn't change the security model.** The same routes, same auth (none for local), same directory boundary enforcement apply.

## Documentation Updates

- **`contributing/keyboard-shortcuts.md`:** Add `Cmd+K` / `Ctrl+K` → "Open command palette" to the Navigation section
- **`contributing/design-system.md`:** No changes needed (existing color/typography specs apply)
- **`.env.example`:** Remove `DORKOS_MESH_ENABLED` line
- **`AGENTS.md`:** Update the client FSD layers table to include `features/command-palette/`; update Mesh description to note it's always-on; remove `DORKOS_MESH_ENABLED` references from server env description

## Implementation Phases

### Phase 1: Mesh Always-On

Remove the feature flag infrastructure. This is a prerequisite for the command palette (which depends on `useMeshAgentPaths()` being always available).

**Files modified:** `env.ts`, `index.ts`, `mesh-state.ts`, `config.ts`, `config-schema.ts`, `.env.example`, `turbo.json`, `use-mesh-config.ts`, `use-feature-enabled.ts`, `SessionSidebar.tsx`, `MeshPanel.tsx`, `MeshStatsHeader.tsx`, `ConnectionsTab.tsx`, ~6 test files

### Phase 2: Global Command Palette

Build the new `features/command-palette/` FSD module and mount it in `App.tsx`.

**Files created:** `CommandPaletteDialog.tsx`, `AgentCommandItem.tsx`, `use-global-palette.ts`, `use-agent-frecency.ts`, `use-palette-items.ts`, `index.ts`
**Files modified:** `App.tsx`, `app-store.ts`

### Phase 3: Agent-Centric Sidebar Redesign

Redesign `AgentHeader` and update `SessionSidebar` to put agents at the center.

**Files modified:** `AgentHeader.tsx`, `SessionSidebar.tsx`

### Phase 4: Polish and Documentation

Update keyboard shortcuts docs, AGENTS.md, and any remaining test updates.

**Files modified:** `contributing/keyboard-shortcuts.md`, `AGENTS.md`

## Open Questions

1. ~~**Should the command palette show agent descriptions in the zero-query state?**~~ (RESOLVED)
   **Answer:** Only in search/`@` mode. Keep the zero-query Recent Agents group clean and compact.

2. ~~**Should `Cmd+K` work when a ResponsiveDialog is already open?**~~ (RESOLVED)
   **Answer:** Yes — close the current dialog first, then open the palette. Matches Linear/Slack behavior.

3. ~~**Should the command palette support "action chaining" (e.g., select agent, then immediately show its sessions)?**~~ (RESOLVED)
   **Answer:** No — select and close. Keep it simple. Chaining is a future iteration.

## Related ADRs

- **ADR-0043** (Accepted) — File-first write-through for agent storage. Confirms filesystem is canonical, SQLite is derived index. Relevant because Mesh always-on relies on the reconciler to keep the index current.
- **ADR-0050** (Proposed) — Agent identity independent of Mesh. The `/api/agents` route is always mounted regardless of Mesh flag. This spec completes that vision by removing the Mesh flag entirely.
- **ADR-0054** (Proposed) — Invert feature flags to enabled-by-default. This spec implements the Mesh portion of that proposal.
- **ADR-0038** (Proposed) — Progressive disclosure Mode A/B for feature panels. MeshPanel's Mode A (zero agents) / Mode B (agents exist) pattern is preserved — only the FeatureDisabledState gate is removed.
- **ADR-0024** (Proposed) — DorkOS-native agent manifest format (`.dork/agent.json`). The command palette reads agent data from the Mesh registry, which is populated from these manifest files.

## References

- [cmdk documentation](https://cmdk.paco.me/) — Command menu component used by Shadcn
- [Shadcn Command component](https://ui.shadcn.com/docs/components/command) — Wrapper used in this project
- Research: `research/20260303_command_palette_agent_centric_ux.md` — 28 sources on command palette UX patterns
- Ideation: `specs/agent-centric-ux/01-ideation.md` — Full ideation document with codebase map and decisions
