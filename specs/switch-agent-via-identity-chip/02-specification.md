---
slug: switch-agent-via-identity-chip
number: 115
created: 2026-03-10
status: specification
authors: Claude Code
ideation: specs/switch-agent-via-identity-chip/01-ideation.md
---

# Switch Agent via Identity Chip Click

## Status

Specification

## Overview

Wire the AgentIdentityChip in the top navigation to open the command palette pre-filtered to agents (via `@` prefix), remove the now-redundant AgentHeader from the sidebar, add an Edit Agent icon to the sidebar footer, and display the CWD in the AgentDialog.

This consolidates agent-related UI actions: the header chip becomes the primary agent-switching surface, the sidebar footer provides agent configuration access, and the AgentDialog shows directory context that was previously only visible in the sidebar.

## Background / Problem Statement

After implementing ADR-0105 (Header as Agent Identity Surface), the sidebar's `AgentHeader` component became partially redundant. It still shows a CWD path breadcrumb and a "K Switch" button, but:

1. The CWD context is also available in the status bar
2. The "K Switch" button duplicates the CommandPaletteTrigger icon in the header
3. Clicking the AgentIdentityChip currently opens the AgentDialog, but a more natural action would be to open the command palette filtered to agents — matching the mental model of "I see an agent name, I click to switch agents"

The AgentDialog also lacks CWD context, which becomes important once the sidebar no longer displays it.

## Goals

- Clicking the AgentIdentityChip opens the command palette in agent-only mode (`@` prefix)
- The command palette accepts programmatic initial search text via Zustand store
- The sidebar is simplified by removing AgentHeader entirely
- Agent configuration is accessible via an Edit Agent icon in the sidebar footer
- The AgentDialog displays the working directory path

## Non-Goals

- Changes to command palette search/filter logic (already supports `@`)
- Changes to agent switching mechanics
- Changes to the command palette's visual design
- Adding new tabs or fields to AgentDialog beyond CWD display
- Changing how Cmd+K or CommandPaletteTrigger opens the palette

## Technical Dependencies

- **Zustand** — State management for `globalPaletteInitialSearch`
- **cmdk** — Command palette already supports prefix-based filtering
- **lucide-react** — `Pencil` icon for the Edit Agent footer button
- **PathBreadcrumb** — Already exported from `@/layers/shared/ui`
- **FolderOpen** — Already available from lucide-react

No new dependencies required.

## Detailed Design

### 1. App Store: Add Initial Search State

**File:** `apps/client/src/layers/shared/model/app-store.ts`

Add to `AppState` interface:

```typescript
globalPaletteInitialSearch: string | null;
openGlobalPaletteWithSearch: (text: string) => void;
clearGlobalPaletteInitialSearch: () => void;
```

Add to store implementation:

```typescript
globalPaletteInitialSearch: null,
openGlobalPaletteWithSearch: (text) =>
  set({ globalPaletteOpen: true, globalPaletteInitialSearch: text }),
clearGlobalPaletteInitialSearch: () =>
  set({ globalPaletteInitialSearch: null }),
```

This follows the existing pattern where `setGlobalPaletteOpen` manages the palette's open state. The new action combines opening the palette with seeding its search input.

### 2. AgentIdentityChip: Rewire Click Handler

**File:** `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx`

**Changes:**
- Replace `useAppStore((s) => s.setAgentDialogOpen)` with `useAppStore((s) => s.openGlobalPaletteWithSearch)`
- Change click handler from `setAgentDialogOpen(true)` to `openGlobalPaletteWithSearch('@')`
- Update tooltip text from "Agent settings" to "Switch agent"
- Update `aria-label` from `"${agent.name} — agent settings"` to `"${agent.name} — switch agent"` (and `"Configure agent"` to `"Switch agent"`)

### 3. CommandPaletteDialog: Consume Initial Search

**File:** `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx`

**Changes to `handleOpenChange`:**

When the dialog opens (`open === true`), after bumping `staggerKey`:
- Read `globalPaletteInitialSearch` from the store
- If non-null, call `setSearch(initialSearch)` to pre-populate the input
- Call `clearGlobalPaletteInitialSearch()` to consume the value (one-shot)

```typescript
const handleOpenChange = useCallback(
  (open: boolean) => {
    setGlobalPaletteOpen(open);
    if (open) {
      setStaggerKey((k) => k + 1);
      // Consume initial search if set (e.g., from AgentIdentityChip "@" click)
      const initialSearch = useAppStore.getState().globalPaletteInitialSearch;
      if (initialSearch !== null) {
        setSearch(initialSearch);
        clearGlobalPaletteInitialSearch();
      }
    } else {
      setSearch('');
      setSelectedValue('');
      setPages([]);
      setSubMenuAgent(null);
    }
  },
  [setGlobalPaletteOpen, clearGlobalPaletteInitialSearch],
);
```

**Changes to `closePalette`:**

Add `clearGlobalPaletteInitialSearch()` call defensively:

```typescript
const closePalette = useCallback(() => {
  setGlobalPaletteOpen(false);
  clearGlobalPaletteInitialSearch();
  setSearch('');
  setSelectedValue('');
  setPages([]);
  setSubMenuAgent(null);
}, [setGlobalPaletteOpen, clearGlobalPaletteInitialSearch]);
```

**Note:** Use `useAppStore.getState()` for the one-time read inside `handleOpenChange` to avoid adding `globalPaletteInitialSearch` as a reactive dependency (which would cause unnecessary re-renders on every search text change).

### 4. Remove AgentHeader from Sidebar

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

- Remove the `import { AgentHeader } from './AgentHeader'` line
- Remove the `AgentHeader` render block from `SidebarHeader` (the `{selectedCwd && (<AgentHeader .../>)}` block)
- Remove the `setPickerOpen` and `setAgentDialogOpen` destructured from `useAppStore` if no longer used in this component (check — `setAgentDialogOpen` is no longer needed here since Edit Agent is in SidebarFooterBar)

**File:** `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx`

- Delete this file entirely. All its functionality is redundant:
  - CWD display → now in AgentDialog
  - Switch button → clicking AgentIdentityChip opens palette
  - +Agent CTA → Edit Agent button in footer opens AgentDialog in create mode

**File:** `apps/client/src/layers/features/session-list/index.ts`

- No changes needed — AgentHeader was never exported from this barrel

### 5. Add Edit Agent Icon to SidebarFooterBar

**File:** `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`

- Import `Pencil` from lucide-react (or `Bot` — `Pencil` is more semantically clear for "edit")
- Add `setAgentDialogOpen` to the destructured `useAppStore()` call
- Add a new icon button before the Settings button:

```tsx
<button
  onClick={() => setAgentDialogOpen(true)}
  className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors duration-150"
  aria-label="Agent settings"
>
  <Pencil className="size-(--size-icon-sm)" />
</button>
```

This button is always visible, regardless of whether an agent is registered. When no agent exists, clicking opens the AgentDialog which shows "No agent registered" with the project path.

### 6. Add CWD Display to AgentDialog

**File:** `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`

- Import `PathBreadcrumb` from `@/layers/shared/ui` and `FolderOpen` from `lucide-react`
- Add a CWD line below the dialog description in both the agent-exists and no-agent states:

**Agent exists (below "Agent configuration" description):**

```tsx
<div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
  <FolderOpen className="size-3 shrink-0" />
  <PathBreadcrumb path={projectPath} maxSegments={3} size="sm" />
</div>
```

**No agent registered (below "No agent registered" text):**

```tsx
<div className="text-muted-foreground flex items-center gap-1 text-xs">
  <FolderOpen className="size-3 shrink-0" />
  <PathBreadcrumb path={projectPath} maxSegments={3} size="sm" />
</div>
```

## User Experience

### Before

| Surface | Action | Result |
|---------|--------|--------|
| AgentIdentityChip | Click | Opens AgentDialog |
| Sidebar | Shows CWD + "K Switch" | Redundant with header |
| Sidebar footer | Settings, Theme, Debug | No agent access |
| AgentDialog | Shows agent config | No CWD context |

### After

| Surface | Action | Result |
|---------|--------|--------|
| AgentIdentityChip | Click | Opens command palette filtered to agents |
| Sidebar | No AgentHeader | Cleaner, starts with New Session button |
| Sidebar footer | Pencil icon | Opens AgentDialog (create or edit) |
| AgentDialog | Shows agent config + CWD | Full context for agent configuration |

### Interaction Flow

1. **Switch agent:** Click AgentIdentityChip → palette opens with `@` → select agent → switch
2. **Edit agent:** Click Pencil icon in sidebar footer → AgentDialog opens → edit configuration
3. **Create agent:** Click Pencil icon in sidebar footer (no agent registered) → AgentDialog shows "No agent registered" with CWD path

## Testing Strategy

### Unit Tests to Update

**`AgentIdentityChip.test.tsx`** — Update existing tests:
- Change assertion: click now calls `openGlobalPaletteWithSearch('@')` instead of `setAgentDialogOpen(true)`
- Update tooltip text assertion from "Agent settings" to "Switch agent"
- Update aria-label assertions
- Add test: verify `openGlobalPaletteWithSearch` is called with `'@'` argument

**`CommandPaletteDialog.test.tsx`** — Add new tests:
- Test: palette opens with initial search when `globalPaletteInitialSearch` is set
- Test: palette clears `globalPaletteInitialSearch` after consuming it
- Test: palette opens with empty search when `globalPaletteInitialSearch` is null (regression)
- Test: closing palette clears `globalPaletteInitialSearch`

**`SidebarFooterBar.test.tsx`** — Add new tests:
- Test: renders Edit Agent (Pencil) icon button
- Test: clicking Edit Agent button calls `setAgentDialogOpen(true)`
- Test: Edit Agent button has correct aria-label

**`SessionSidebar.test.tsx`** — Update existing tests:
- Remove any assertions about AgentHeader rendering
- Remove any mocks for AgentHeader dependencies

**`AgentHeader.test.tsx`** — Delete this file (component is deleted)

**`AgentDialog.test.tsx`** — Add new tests:
- Test: CWD path is displayed when agent exists
- Test: CWD path is displayed when no agent registered
- Test: PathBreadcrumb renders the projectPath

### Mocking Strategy

- Mock `useAppStore` with `openGlobalPaletteWithSearch`, `clearGlobalPaletteInitialSearch`, and `setAgentDialogOpen` as vi.fn()
- For CommandPaletteDialog tests, use `useAppStore.getState()` mock to return `globalPaletteInitialSearch` value

## Performance Considerations

- **No performance impact.** Changes are limited to click handlers and Zustand state updates (synchronous, negligible cost).
- `useAppStore.getState()` in `handleOpenChange` avoids adding a reactive subscription, preventing unnecessary re-renders.

## Security Considerations

None. All changes are client-side UI wiring with no data exposure or external communication changes.

## Documentation

No external documentation updates needed. This is an internal UI improvement.

## Implementation Phases

### Phase 1: Store + Wiring (Core)

1. Add `globalPaletteInitialSearch`, `openGlobalPaletteWithSearch`, `clearGlobalPaletteInitialSearch` to `app-store.ts`
2. Update `AgentIdentityChip.tsx` click handler to call `openGlobalPaletteWithSearch('@')`
3. Update `CommandPaletteDialog.tsx` to consume `globalPaletteInitialSearch` in `handleOpenChange` and `closePalette`

### Phase 2: Sidebar Cleanup

4. Remove `AgentHeader` from `SessionSidebar.tsx`
5. Delete `AgentHeader.tsx`
6. Delete `AgentHeader.test.tsx`
7. Add Edit Agent (Pencil) icon to `SidebarFooterBar.tsx`

### Phase 3: AgentDialog CWD

8. Add CWD display (PathBreadcrumb + FolderOpen) to `AgentDialog.tsx` in both agent-exists and no-agent states

### Phase 4: Test Updates

9. Update `AgentIdentityChip.test.tsx`
10. Add tests to `CommandPaletteDialog.test.tsx`
11. Add tests to `SidebarFooterBar.test.tsx`
12. Update `SessionSidebar.test.tsx`
13. Add tests to `AgentDialog.test.tsx`

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

- **ADR-0105**: Header as Agent Identity Surface — established AgentIdentityChip as the primary identity display, simplifying the sidebar's AgentHeader
- **ADR-0063**: Use Shadcn CommandDialog for Global Agent Command Palette — established the command palette architecture and Cmd+K binding
- **ADR-0064**: Shadcn Sidebar for Standalone Layout
- **ADR-0067**: Slack Bucket Frecency for Agent Ranking — agent ordering in the palette

## References

- Ideation: `specs/switch-agent-via-identity-chip/01-ideation.md`
- Research: `research/20260310_switch_agent_via_identity_chip.md`
- Prior specs: `specs/update-top-nav/02-specification.md`, `specs/command-palette-10x/02-specification.md`
