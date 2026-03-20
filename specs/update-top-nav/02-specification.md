---
slug: update-top-nav
number: 112
created: 2026-03-10
status: specified
---

# Update Top Nav — Agent Identity, Command Palette Trigger, 10x Elevation

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-03-10
**Ideation:** `specs/update-top-nav/01-ideation.md`
**Research:** `research/20260310_top_nav_header_design.md`

---

## Overview

Transform the standalone header from an empty chrome bar into a control surface that tells the operator which agent is active and provides instant access to the command palette. Create a new `features/top-nav/` FSD module with two components (`AgentIdentityChip`, `CommandPaletteTrigger`), wire four micro-interaction enhancements (color dot pulse, name slide, streaming scan line, color-tinted border), and simplify the sidebar's `AgentHeader` to a directory context display now that identity moves to the header.

## Background / Problem Statement

The current header (`App.tsx` line 208) is a 36px bar containing only a `SidebarTrigger`. When the sidebar is closed, the user has zero visibility into which agent is active. The command palette (`Cmd+K`) exists but has no mouse-accessible trigger in the header — first-time users can't discover it.

Kai (primary persona) runs 10-20 agent sessions across 5 projects. Glanceable agent identity at the top of the screen is essential for context switching. Priya (secondary persona) values flow preservation — the header must provide information without adding clutter or distraction.

The `AgentHeader` component currently lives in the sidebar and duplicates identity display. Once identity moves to the always-visible header, the sidebar's agent section should simplify to directory context only.

## Goals

- Show the active agent name and color in the header at all times (sidebar open or closed)
- Provide a mouse-accessible trigger for the command palette with keyboard shortcut discoverability
- Elevate the header to "control surface" quality with purposeful micro-interactions
- Simplify `AgentHeader` to eliminate redundancy after identity moves to the header
- Follow FSD conventions with a dedicated `features/top-nav/` module

## Non-Goals

- Embedded/Obsidian mode changes (has its own overlay layout)
- Command palette internals (covered by spec #87)
- Sidebar layout redesign beyond simplifying AgentHeader
- Mobile-specific header layout (existing responsive behavior is sufficient)
- Adding new keyboard shortcuts (e.g., `Cmd+,` for settings)
- Status indicators in the header (streaming state, session counts — these belong in the status line)

## Technical Dependencies

- `motion/react` — `motion`, `AnimatePresence` (already in App.tsx)
- `lucide-react` — `Search`, `ChevronDown` icons
- `@dorkos/shared/mesh-schemas` — `AgentManifest` type
- `entities/agent` — `useCurrentAgent`, `useAgentVisual`, `AgentVisual` type
- `shared/ui` — `Tooltip`, `TooltipTrigger`, `TooltipContent`, `Kbd`, `Separator`
- `shared/model` — `useAppStore` (for `setAgentDialogOpen`, `setGlobalPaletteOpen`)
- CSS `color-mix()` — ~96% browser support, used for border tinting

## Detailed Design

### File Structure

```
apps/client/src/layers/features/top-nav/
├── ui/
│   ├── AgentIdentityChip.tsx      # Clickable agent identity chip
│   └── CommandPaletteTrigger.tsx   # Search icon → command palette
└── index.ts                        # Barrel exports
```

### Header Layout

```
[≡] | [● Agent Name ▾]                    [🔍]
```

Left-to-right: `SidebarTrigger` → `Separator` → `AgentIdentityChip` → flex spacer → `CommandPaletteTrigger`.

The separator is a vertical `Separator` component (`orientation="vertical"`) between the sidebar trigger and the agent chip, providing visual grouping.

### Component: AgentIdentityChip

**File:** `features/top-nav/ui/AgentIdentityChip.tsx`

**Props:**

```typescript
interface AgentIdentityChipProps {
  /** Current agent manifest, null when no agent registered */
  agent: AgentManifest | null | undefined;
  /** Derived visual identity (color + emoji) */
  visual: AgentVisual;
  /** Whether the agent is currently streaming a response */
  isStreaming: boolean;
}
```

**Behavior:**

| State                       | Visual                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------- |
| Agent configured, idle      | `[●] Agent Name ▾` — color dot solid, text `font-medium`                                |
| Agent configured, streaming | `[●] Agent Name ▾` — color dot pulses (opacity 1→0.4→1, 1.5s, infinite)                 |
| No agent                    | `[◌] No agent ▾` — muted dot (`border` instead of `bg`), muted text                     |
| Agent switching             | Name slides out (y: 0→3, opacity→0) then new name slides in (y: -3→0, opacity→1), 120ms |
| Hover                       | `bg-accent` background via spring transition                                            |
| Active/pressed              | `scale: 0.97` via `whileTap`                                                            |

**Implementation details:**

- Chip height: `h-7` (28px) to fit within `h-9` header with vertical centering
- Color dot: `size-2 rounded-full` with `backgroundColor: visual.color`
- Streaming pulse: `motion.span` with `animate={{ opacity: [1, 0.4, 1] }}` and `transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}`
- Name truncation: `max-w-[160px] truncate` with full name in tooltip when truncated
- Agent name transition: `AnimatePresence mode="wait"` keyed on `agent?.id ?? 'no-agent'`, `initial={{ opacity: 0, y: -3 }}`, `animate={{ opacity: 1, y: 0 }}`, `exit={{ opacity: 0, y: 3 }}`, duration 0.12s
- Color dot transition: `motion.span` with `animate={{ backgroundColor: visual.color }}` and `transition={{ duration: 0.3, ease: 'easeOut' }}`
- Chevron: `ChevronDown` from lucide, `size-3`, `text-muted-foreground`, `aria-hidden`
- Click: `setAgentDialogOpen(true)` from `useAppStore`
- Tooltip: `"Agent settings"` (side="bottom")
- No-agent dot: `border border-muted-foreground/40` with no background fill, dashed style
- Accessibility: `aria-label={agent ? \`${agent.name} — agent settings\` : 'Configure agent'}`, `aria-hidden` on dot and chevron

**Imports:**

```typescript
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore } from '@/layers/shared/model';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentVisual } from '@/layers/entities/agent';
```

### Component: CommandPaletteTrigger

**File:** `features/top-nav/ui/CommandPaletteTrigger.tsx`

**Props:** None (self-contained — reads from `useAppStore`).

**Behavior:**

| State          | Visual                                                            |
| -------------- | ----------------------------------------------------------------- |
| Default        | Search icon, `text-muted-foreground`                              |
| Hover          | `text-foreground`, `scale: 1.1` via spring                        |
| Active/pressed | `scale: 0.93` via `whileTap`                                      |
| Tooltip        | `"Search"` + `<Kbd>⌘K</Kbd>` (Mac) or `<Kbd>Ctrl+K</Kbd>` (other) |

**Implementation details:**

- Button size: `h-7 w-7` (28px square)
- Icon: `Search` from lucide, `size-4`
- Click: `setGlobalPaletteOpen(true)` from `useAppStore`
- Spring: `stiffness: 600, damping: 35` (matches design system)
- Platform detection: `typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)`
- Accessibility: `aria-label="Open command palette"`

**Imports:**

```typescript
import { Search } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppStore } from '@/layers/shared/model';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';
```

### Updated Header in App.tsx

**Current** (line 208):

```tsx
<header className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
  <SidebarTrigger className="-ml-0.5" />
</header>
```

**New:**

```tsx
<header
  className="relative flex h-9 shrink-0 items-center gap-2 border-b px-2 transition-[border-color] duration-300"
  style={
    currentAgent
      ? {
          borderBottomColor: `color-mix(in srgb, ${agentVisual.color} 25%, var(--border))`,
        }
      : undefined
  }
>
  <SidebarTrigger className="-ml-0.5" />
  <Separator orientation="vertical" className="mr-1 h-4" />
  <AgentIdentityChip agent={currentAgent} visual={agentVisual} isStreaming={isStreaming} />
  <div className="flex-1" />
  <CommandPaletteTrigger />

  {/* Streaming scan line — sweeps across header bottom when agent is active */}
  <AnimatePresence>
    {isStreaming && (
      <motion.div
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-0 left-0 h-px origin-left"
        initial={{ scaleX: 0, opacity: 0.8 }}
        animate={{ scaleX: [0, 1], opacity: [0.8, 0] }}
        exit={{ opacity: 0 }}
        transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
        style={{ backgroundColor: agentVisual.color }}
      />
    )}
  </AnimatePresence>
</header>
```

**New imports in App.tsx:**

```typescript
import { AgentIdentityChip, CommandPaletteTrigger } from '@/layers/features/top-nav';
import { Separator } from '@/layers/shared/ui';
```

`Separator` needs to be added to the existing shared/ui import block (it's already exported from the barrel).

### 10x Enhancements Summary

| Enhancement         | Where                  | Trigger                                   | Detail                                                          |
| ------------------- | ---------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| Color dot pulse     | AgentIdentityChip      | `isStreaming === true`                    | Opacity breathes 1→0.4→1 over 1.5s                              |
| Name slide          | AgentIdentityChip      | Agent changes (key change on `agent?.id`) | y: -3→0→3, opacity 0→1→0, 120ms                                 |
| Streaming scan line | App.tsx header         | `isStreaming === true`                    | scaleX 0→1 + opacity 0.8→0, 2s, infinite loop                   |
| Color-tinted border | App.tsx header `style` | `currentAgent` is truthy                  | `color-mix(in srgb, color 25%, var(--border))` on border-bottom |

All animations respect the existing `MotionConfig reducedMotion="user"` wrapper in App.tsx, which honors `prefers-reduced-motion`.

### Simplified AgentHeader

**File:** `features/session-list/ui/AgentHeader.tsx`

**What to remove:**

- The agent identity button (colored dot, emoji, bold name, description, path)
- The gear icon button
- The `onOpenAgentDialog` prop usage within the component (prop can remain for compatibility but the gear is gone)

**What to keep:**

- Path breadcrumb display with `PathBreadcrumb` for the current working directory
- The `FolderOpen` icon + directory picker button (`onOpenPicker`)
- The "+Agent" CTA for unregistered directories (`handleQuickCreate`)
- The "K Switch" button that opens the command palette (`setGlobalPaletteOpen`)

**New structure (conceptual):**

```tsx
// When agent exists: just show path + K Switch
<div className="flex flex-col gap-1 px-2 py-2">
  <div className="flex min-w-0 items-center gap-1">
    <button onClick={onOpenPicker} className="...">
      <FolderOpen className="..." />
      <PathBreadcrumb path={cwd} maxSegments={3} size="sm" />
    </button>
  </div>
  <div className="px-1">
    <button onClick={handleOpenPalette} className="...">
      <Kbd>K</Kbd>
      <span>Switch</span>
    </button>
  </div>
</div>

// When no agent: path + "+Agent" CTA + K Switch (same as before)
```

The component interface simplifies but props remain the same for backward compatibility. Removing `onOpenAgentDialog` is optional — it simply won't be wired to any UI element within AgentHeader anymore. The `useCurrentAgent` hook is still called to determine which layout to render (agent vs. no-agent), but the visual output is much simpler.

### Barrel Export

**File:** `features/top-nav/index.ts`

```typescript
/**
 * Top navigation bar components — agent identity chip and command palette trigger.
 *
 * @module features/top-nav
 */
export { AgentIdentityChip } from './ui/AgentIdentityChip';
export { CommandPaletteTrigger } from './ui/CommandPaletteTrigger';
```

## User Experience

### Agent Identity

Users always see which agent they're working with in the header, even when the sidebar is closed. The colored dot provides instant visual recognition across different agents and projects. Clicking the chip opens the full agent configuration dialog (Identity, Persona, Capabilities, Connections tabs).

When no agent is registered for the current directory, a muted "No agent" chip with dashed border signals the opportunity to configure one. Clicking still opens the dialog.

### Command Palette Access

The search icon on the right provides a persistent mouse target for the command palette. Hovering reveals a tooltip with the keyboard shortcut (`⌘K` on Mac, `Ctrl+K` elsewhere), serving as a passive shortcut educator. Power users learn the shortcut after one hover and never need the icon again — but it remains for occasional mouse use.

### Streaming Feedback

When the agent is streaming a response:

1. The color dot breathes subtly (imperceptible but alive)
2. A thin colored scan line sweeps across the header bottom border (radar/sonar metaphor)

These signals are purely ambient — they don't demand attention but confirm the agent is working. Both are decorative and automatically disabled for users with `prefers-reduced-motion`.

### Agent Color Identity

The header border subtly tints to the agent's color via `color-mix()`. When switching agents, the tint transitions smoothly (300ms). This is the Arc Browser Spaces pattern — the chrome embodies the context. At 25% mix with the standard border color, it's barely perceptible but unmistakably purposeful.

## Testing Strategy

### Unit Tests: AgentIdentityChip

**File:** `features/top-nav/__tests__/AgentIdentityChip.test.tsx`

- **Renders agent name when agent is configured** — verify the agent name text appears in the DOM. Purpose: confirms the core identity display works.
- **Renders "No agent" when agent is null** — verify the fallback text. Purpose: ensures the empty state is handled gracefully.
- **Opens agent dialog on click** — verify `setAgentDialogOpen(true)` is called. Purpose: validates the primary interaction path.
- **Shows tooltip on hover** — verify tooltip content "Agent settings". Purpose: confirms discoverability.
- **Applies streaming pulse class when isStreaming** — verify the motion animate prop changes. Purpose: validates ambient streaming feedback.
- **Renders color dot with agent color** — verify `backgroundColor` style matches `visual.color`. Purpose: confirms color identity system works.

### Unit Tests: CommandPaletteTrigger

**File:** `features/top-nav/__tests__/CommandPaletteTrigger.test.tsx`

- **Renders search icon** — verify the Search icon is in the DOM. Purpose: confirms the trigger is visible.
- **Opens command palette on click** — verify `setGlobalPaletteOpen(true)` is called. Purpose: validates the primary interaction.
- **Shows tooltip with keyboard shortcut** — verify tooltip content includes "Search" and keyboard shortcut text. Purpose: confirms shortcut discoverability.

### Integration: AgentHeader Simplification

**File:** Update existing `features/session-list/__tests__/AgentHeader.test.tsx`

- **No longer renders agent name in sidebar** — verify agent identity elements are removed. Purpose: confirms identity moved to header.
- **Still renders path breadcrumb** — verify `PathBreadcrumb` is present. Purpose: ensures directory context remains.
- **Still renders "+Agent" CTA for unregistered dirs** — verify quick-create button works. Purpose: preserves agent registration flow.
- **Still renders "K Switch" palette button** — verify palette open is called on click. Purpose: preserves palette access from sidebar.

### Mocking Strategy

```typescript
// Mock app store
vi.mock('@/layers/shared/model', () => ({
  useAppStore: vi.fn((selector) => {
    const store = {
      setAgentDialogOpen: vi.fn(),
      setGlobalPaletteOpen: vi.fn(),
    };
    return selector ? selector(store) : store;
  }),
}));

// Mock agent data for AgentIdentityChip tests
const mockAgent: AgentManifest = {
  id: '01HTEST',
  name: 'test-agent',
  description: 'A test agent',
  runtime: 'claude-code',
  // ... other required fields from AgentManifestSchema
};

const mockVisual: AgentVisual = {
  color: '#6366f1',
  emoji: '🤖',
};
```

## Performance Considerations

- **No new API calls** — all data (`currentAgent`, `agentVisual`, `isStreaming`) is already fetched in App.tsx
- **Streaming animations** — scan line and dot pulse use CSS transforms/opacity (GPU-composited), no layout thrashing
- **`color-mix()`** — computed by the browser's CSS engine, no JS overhead
- **`AnimatePresence`** — only mounts/unmounts on agent switch (rare event), not on every render
- **Component size** — each new component is ~50-60 lines, minimal bundle impact

## Security Considerations

- No new user input is processed
- Agent names are rendered as text content via React's default text escaping, safe from injection
- `color-mix()` uses the agent's stored color — this is user-configured via the agent dialog, not external input

## Documentation

No external documentation changes needed. The header update is a UI enhancement that doesn't change any API surface or user-facing configuration. The design system guide (`contributing/design-system.md`) may optionally be updated to document the `color-mix()` border tinting pattern for reuse.

## Implementation Phases

### Phase 1: Core Components

1. Create `features/top-nav/` directory with barrel `index.ts`
2. Implement `AgentIdentityChip` with full interaction states (agent/no-agent, tooltip, click handler)
3. Implement `CommandPaletteTrigger` with tooltip and click handler
4. Update App.tsx header to use new components with `Separator`
5. Add unit tests for both components

### Phase 2: 10x Micro-interactions

1. Add color dot pulse animation (streaming state)
2. Add agent name slide animation (`AnimatePresence` on agent switch)
3. Add streaming scan line to header
4. Add `color-mix()` border tinting
5. Verify all animations respect `prefers-reduced-motion`

### Phase 3: AgentHeader Simplification

1. Simplify `AgentHeader.tsx` to directory context display
2. Remove agent identity elements (dot, name, description, gear icon)
3. Keep path breadcrumb, "+Agent" CTA, "K Switch" button
4. Update `AgentHeader.test.tsx` to match new behavior
5. Verify `SessionSidebar.tsx` still works correctly

## Open Questions

_None — all decisions resolved during ideation._

## Related ADRs

- `decisions/0038-progressive-disclosure-mode-ab-for-feature-panels.md` — Progressive disclosure patterns; relevant to the decision to show agent identity at rest and streaming state only during streaming.

## References

- `specs/update-top-nav/01-ideation.md` — Ideation document with intent, codebase map, and research summary
- `research/20260310_top_nav_header_design.md` — Full research report (Linear, VS Code, Arc, Warp patterns)
- `research/20260303_command_palette_agent_centric_ux.md` — Command palette UX patterns
- `research/20260303_command_palette_10x_elevation.md` — Command palette elevation patterns
- `specs/command-palette-10x/02-specification.md` — Command palette spec (spec #87)
- `specs/agent-centric-ux/02-specification.md` — Agent-centric UX spec (spec #85)
- `contributing/design-system.md` — Design system tokens, spacing, typography
- `contributing/animations.md` — Motion patterns and spring physics
