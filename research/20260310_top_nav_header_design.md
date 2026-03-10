---
title: "Top Navigation Header Design — Agent Identity, Command Palette Trigger, and 10x Elevation"
date: 2026-03-10
type: external-best-practices
status: active
tags: [header, top-nav, agent-identity, command-palette, micro-interactions, progressive-disclosure, developer-tool-ux, linear, vscode, motion]
feature_slug: update-top-nav
searches_performed: 7
sources_count: 22
---

# Top Navigation Header Design — Agent Identity, Command Palette Trigger, and 10x Elevation

## Prerequisite: Existing Research

Several highly relevant prior reports exist and this research builds on them without repeating their findings:

- `research/20260303_command_palette_agent_centric_ux.md` — Full Cmd+K binding, cmdk API, agent frecency, sidebar agent identity patterns
- `research/20260303_command_palette_10x_elevation.md` — Preview panels, fuzzy highlighting, stagger animations, sliding selection indicator
- `research/20260303_shadcn_sidebar_redesign.md` — SidebarProvider API, Zustand bridge, dialog lifting

---

## Research Summary

The DorkOS top nav header (`apps/client/src/App.tsx`, line 208) is currently a single-line `<header className="flex h-9 shrink-0 items-center gap-2 border-b px-2">` containing only a `<SidebarTrigger>`. The required additions are: (1) an agent identity chip that shows the active agent name and opens agent settings on click, and (2) a command palette trigger icon with a tooltip showing Cmd+K. The "10x" factor is making the header feel like a **control surface** — the place where the operator knows at a glance what agent is running and can instantly reach any part of the system.

The strongest industry precedents are Linear (workspace identity chip in sidebar header), VS Code (status bar as ambient context layer), and Arc Browser (space identity without consuming header real estate). The clearest finding: developer tool headers that feel premium are *not* cluttered — they are extremely minimal but every element is doing real work.

---

## Key Findings

### 1. Current Header State

The header is 36px (`h-9`) and contains a single `SidebarTrigger` button at `-ml-0.5`. The `App.tsx` already has:

- `useCurrentAgent(selectedCwd)` — the active agent data
- `useAgentVisual(currentAgent, selectedCwd)` — the agent's color and emoji
- `agentVisual.color` already feeds the favicon and document title

This means the data pipeline for the agent identity chip is **already complete** in `App.tsx`. No new API calls are needed. The header just needs to render these values.

### 2. Industry Header Pattern Analysis

**VS Code**:
- The title bar shows breadcrumbs (`file > class > method`) at ~20px height
- The status bar (bottom, 22px) is the ambient context layer — language, line number, git branch, errors
- The top header is intentionally *non-content* space — it's for window controls
- Key insight: VS Code separates navigation hierarchy (breadcrumbs) from ambient context (status bar). DorkOS's header can serve both roles at 36px because there's only one level of context: the agent.

**Linear**:
- Each workspace has a unique icon + color identity
- The workspace name appears in the sidebar header (top-left), not the top nav bar
- The top nav bar is empty or minimal — just tabs for views (Issues, Cycles, Projects)
- Key insight: Linear puts identity in the *sidebar header*, not the top bar. DorkOS uses a floating sidebar variant — the top bar is the right place for identity since the sidebar header may be obscured.
- Linear's 2024 personalized sidebar redesign added team icons with color applied to the background — this is the chip pattern.

**Arc Browser**:
- "Spaces" have color identity (subtle tinted chrome)
- The top bar shows the space name only when needed (URL bar area)
- Progressive disclosure: the identity is always visible but never dominant
- Key insight: Color tinting of the header chrome itself signals identity without adding text clutter.

**Raycast**:
- The search bar *is* the header — the entire interface is the command palette
- Every feature is accessible via Cmd+K or a typed shortcut
- No persistent header elements beyond the search input
- Key insight: For a keyboard-first developer tool, the command palette trigger should feel like the second most important element in the header (after the agent identity).

**Warp Terminal**:
- The header shows session name + shell path as ambient context
- Click on session name opens session configuration
- Key insight: This is almost exactly the pattern DorkOS needs — a clickable identity element that opens configuration.

**GitHub Desktop**:
- Header: `[Current Repository ▾] [Current Branch ▾] [Fetch origin]`
- Each clickable dropdown is a context-switching affordance
- The header reads left-to-right as: "where are you > what state > what actions"
- Key insight: Left-to-right information hierarchy matches reading direction. Agent name (identity) belongs on the left after the sidebar trigger.

### 3. Agent Identity Chip Design

The chip should follow this anatomy:

```
[●] Agent Name  ▾
```

- Colored dot: uses `agentVisual.color` — the same color as the favicon and document title indicator
- Agent name: truncated at ~24 chars with `text-ellipsis`, full name in tooltip
- Chevron-down icon: subtle affordance that the chip is clickable/configurable
- Entire chip is a button that opens `AgentDialog` (already wired in `DialogHost`)

**Size constraints**: At `h-9` (36px) header height, the chip must be approximately 28-30px tall. Use `h-7` with `rounded-md` and `px-2 gap-1.5`.

**When no agent is configured**: Show a muted "No agent" state with a dashed border — a clear call-to-action to configure one. This is Warp's pattern for unnamed sessions.

**Interaction states**:
- Default: chip with color dot + name + chevron
- Hover: subtle `bg-accent` background fill, chevron brightens
- Active/pressed: slight scale-down (0.97)
- Click: opens `AgentDialog` (via `setAgentDialogOpen(true)` in app-store)

**Color dot implementation**: A 6px circle (`size-1.5 rounded-full`) with `backgroundColor: agentVisual.color`. This is the same pattern as Linear's team icons — the agent color is the semantic signal.

### 4. Command Palette Trigger

**Should it be an icon, a search bar, or a button with text?**

The research is definitive for developer tools:
- **Search bar**: Used by tools that need discoverability (consumer apps, GitHub's search). Too much horizontal space. Wrong for DorkOS.
- **Text button** (`Search... ⌘K`): Used by Notion, Vercel. Appropriate when users need to learn the shortcut. Adds ~120px of width to the header.
- **Icon button with tooltip**: Used by VS Code (magnifying glass in some views), GitHub (search icon in the header). Minimal footprint. The tooltip teaches the shortcut on hover.

For DorkOS at `h-9`, the **icon button with tooltip** is correct. Reasons:
1. Kai knows keyboard shortcuts. He will learn Cmd+K after one tooltip hover.
2. A search bar in the header adds visual weight that competes with the agent identity chip.
3. The DorkOS brand is minimal and technical — text buttons feel consumer-grade.

**Icon choice**: A magnifying glass icon (search) is universally understood. Some tools use a slash `/` icon or a sparkle ✦ for AI-specific command palettes. For DorkOS, `Search` from lucide-react is correct — it's neutral, recognized, and pairs naturally with `⌘K` in the tooltip. Avoid the `Command` icon (looks like a key, not a search).

**Tooltip pattern**:
```
Search ⌘K
```
The tooltip text should be exactly this — the action verb followed by the keyboard shortcut in a `<Kbd>` component. This matches how VS Code's tooltips read ("Open Palettes Cmd+Shift+P") and how DorkOS already uses `<Kbd>` in the sidebar trigger tooltip.

**Placement**: Right-aligned in the header (`ml-auto`). Left-to-right reading order is: sidebar trigger → [agent chip] → [spacer] → [search icon]. The search icon on the right mirrors VS Code's global search placement.

### 5. Header Layout Composition

The complete header layout for the standalone path:

```
[≡] [● Agent Name ▾]                    [🔍]
```

Breakdown:
- `SidebarTrigger` — existing, stays at left
- `AgentIdentityChip` — new, immediately after trigger with `gap-2`
- Spacer (`flex-1`) — pushes search to the right
- `CommandPaletteTrigger` — new, icon button on the right

**Full JSX structure**:

```tsx
<header className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
  <SidebarTrigger className="-ml-0.5" />
  <AgentIdentityChip agent={currentAgent} visual={agentVisual} />
  <div className="flex-1" />
  <CommandPaletteTrigger />
</header>
```

This is extremely simple. The complexity lives in the two new components, not in the layout.

### 6. Progressive Disclosure in the Header

**What to show immediately**: Agent name + color dot + chevron. Nothing else.

**What to show on hover**:
- Agent chip: background fill (shows it's interactive)
- Tooltip on chip: full agent name if truncated, "Click to configure"
- Tooltip on search icon: "Search ⌘K"

**What to show on click**:
- Agent chip click: opens full `AgentDialog` (configure name, color, persona, tools)
- Search icon click: opens `CommandPaletteDialog`

**What to show on long press / right-click**: Nothing special — this is a developer tool, not a consumer app. Context menus on header elements add complexity with minimal value.

**What NOT to show in the header**: Status indicators (active session count, streaming state, git status) — these belong in the sidebar or status line. The header should be signal-free, just identity + navigation affordances.

### 7. Micro-interactions for a Premium Feel

These are the specific motion details that separate a "functional" header from a "crafted" one:

**Agent chip hover**:
```tsx
<motion.button
  whileHover={{ backgroundColor: 'var(--accent)' }}
  whileTap={{ scale: 0.97 }}
  transition={{ type: 'spring', stiffness: 600, damping: 40 }}
>
```
The spring transition makes the hover feel physical rather than linear. Duration should be under 100ms for hover states in a header — anything longer interrupts the scanning flow.

**Color dot pulse (when agent is actively streaming)**:
```tsx
<motion.span
  animate={isStreaming ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
  className="size-1.5 rounded-full"
  style={{ backgroundColor: agentVisual.color }}
/>
```
This subtle breathing animation is borrowed from Linear's status indicators — active/running states pulse gently. It does not flash aggressively. It is barely perceptible but unmistakably alive. Critically, it only pulses when `isStreaming` is true.

**Search icon hover**:
```tsx
<motion.div
  whileHover={{ scale: 1.1 }}
  transition={{ type: 'spring', stiffness: 600, damping: 35 }}
>
  <Search className="size-4" />
</motion.div>
```
A 10% scale up on hover is the standard affordance signal for icon buttons. Subtle enough not to distract, visible enough to confirm interactivity.

**Agent switching animation (when selectedCwd changes)**:
```tsx
<AnimatePresence mode="wait">
  <motion.span
    key={currentAgent?.id ?? 'no-agent'}
    initial={{ opacity: 0, y: -4 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 4 }}
    transition={{ duration: 0.12, ease: 'easeOut' }}
  >
    {currentAgent?.name ?? 'No agent'}
  </motion.span>
</AnimatePresence>
```
When the user switches agents (via the command palette or directory picker), the name in the header swaps with a micro-slide. This confirms the switch visually without a toast or banner.

**Color dot transition**:
```tsx
<motion.span
  animate={{ backgroundColor: agentVisual.color }}
  transition={{ duration: 0.3, ease: 'easeOut' }}
/>
```
When switching agents, the color dot smoothly transitions to the new agent's color. This is Jony Ive's "material transition" principle — color should flow, not snap.

### 8. The 10x Factor — What Would Steve Jobs and Jony Ive Do?

This is the central design question. The baseline requirement (agent name + search icon) is the floor. The 10x is the ceiling.

**What most tools miss**: The header is treated as chrome — a container for navigation elements. In the best tools, the header is part of the *content*. It tells you something real about the state of the world at a glance.

**The 10x insight for DorkOS**: The header is the **agent's identity plate**. Every time you look at the top of the screen, you should know exactly which agent you're talking to, whether it's thinking, and where you can go. The header should feel like the display panel on a piece of precision equipment — minimal, informative, and beautiful in its restraint.

**Specific 10x ideas**:

**Idea A: Ambient agent color in the header chrome itself**
Instead of just the dot being colored, apply an extremely subtle color tint to the header's border-bottom or a very low-opacity background wash derived from `agentVisual.color`:

```tsx
<header
  className="flex h-9 shrink-0 items-center gap-2 border-b px-2"
  style={{
    borderBottomColor: `color-mix(in srgb, ${agentVisual.color} 30%, var(--border))`,
  }}
>
```

This is the Arc Browser Spaces pattern — the entire chrome tints to the space/context color. At 30% mix with the border color, it's barely perceptible but unmistakably purposeful. When the agent changes, the border color transitions smoothly. This makes the header feel *alive* — it's not just showing data, it's *embodying* the agent.

Evaluation: **High impact, minimal implementation cost.** This is the single highest-signal change possible. Jobs would love this — it's the kind of detail nobody would consciously notice but everyone would feel.

**Idea B: Session count micro-indicator**
A tiny number badge (sessions count) adjacent to the agent name, visible only on hover of the chip:

```
[●] my-api-agent  3  ▾
```

The `3` fades in on chip hover, showing active session count. It disappears at rest. This is progressive disclosure done right — the information exists, it's just not competing for attention.

Evaluation: **Medium impact, low cost.** Adds information density without permanent clutter.

**Idea C: Streaming state as header motion**
When `isStreaming` is true, add a very subtle shimmer or scan line to the header border:

```tsx
<motion.div
  className="absolute bottom-0 left-0 h-px"
  animate={isStreaming ? {
    width: ['0%', '100%'],
    opacity: [0.6, 0],
  } : { width: '0%', opacity: 0 }}
  transition={{
    duration: 2,
    repeat: Infinity,
    ease: 'linear',
  }}
  style={{ backgroundColor: agentVisual.color }}
/>
```

A thin colored scan line sweeps across the bottom border of the header only when the agent is actively streaming. It's a radar/sonar metaphor — the agent is scanning. This is purely aesthetic but communicates live state in a way that feels native to the product's "control surface" metaphor.

Evaluation: **Highest impact for DorkOS brand**, medium implementation cost. This is the "back of the fence" detail that Jobs talks about — nobody asked for it, but it makes the product feel purpose-built.

**Idea D: Keyboard-first header affordances**
Show `⌘B` beside the sidebar trigger tooltip (already done), `⌘K` beside the search icon. Consider also a subtle `⌘,` affordance when hovering the agent chip (Cmd+comma is the conventional settings shortcut in developer tools). This teaches muscle memory without documentation.

Evaluation: **High DX value**, minimal implementation cost.

**The 10x recommendation**: Implement A + C. The tinted border makes the header feel like the agent's chrome, and the scan line animation makes streaming state visible without status text. Together, these two additions transform the header from "navigation" into a "control surface" — the difference between a dashboard and a cockpit.

### 9. FSD Placement

New components required:

```
apps/client/src/layers/features/top-nav/
├── ui/
│   ├── AgentIdentityChip.tsx      # The clickable agent chip
│   └── CommandPaletteTrigger.tsx  # The search icon button
├── model/
│   └── use-streaming-state.ts     # (optional — reads isStreaming from app-store)
└── index.ts
```

**Why `features/`?**: These components have business logic (reading `useCurrentAgent`, `useAgentVisual`, `useAppStore`) and trigger application actions (`setAgentDialogOpen`). They are not pure UI primitives (`shared/ui/`) and are not complex enough for `widgets/`. `features/top-nav/` is the correct layer.

**Alternatively**, if the components are small enough (under 50 lines each), they can live directly in `App.tsx` as local components within the file, co-located with the header JSX. This avoids creating a new module for very simple components. The FSD rule is about import direction, not mandatory module creation. Evaluate after implementation — if each component is under 80 lines with its TSDoc, keeping them in App.tsx is simpler.

---

## Detailed Analysis

### The Current Header: What Works and What Doesn't

**What works**:
- `h-9` (36px) is the correct height — it matches VS Code's tab bar and Linear's top bar. It's compact enough to not feel heavy.
- Border-bottom creates the correct visual separation from content without using a shadow (which would feel too heavy for a developer tool).
- `SidebarTrigger` placement at `-ml-0.5` is correctly aligned.

**What doesn't work**:
- The header contains zero information. Looking at it tells you nothing about where you are or what is running.
- There is no affordance to reach the command palette via mouse.
- First-time users have no way to discover Cmd+K.
- The agent identity exists in the sidebar (when open) but disappears when the sidebar is closed — the header should always show it.

### Agent Chip vs. Breadcrumb

An alternative to the chip pattern is a breadcrumb: `Agent / Session Title`. This is the VS Code breadcrumb pattern.

**Why the chip wins for DorkOS**:
- DorkOS has one level of context (agent), not a hierarchy. Breadcrumbs are for hierarchy.
- A chip is more obviously clickable than a breadcrumb label.
- The chip has a visual anchor (the color dot) that the breadcrumb lacks.
- Chips support the visual identity system (color = agent). Breadcrumbs are text-only.

Verdict: Chip. Breadcrumbs are appropriate in multi-level navigation contexts like file trees or nested routes.

### Tooltip Content: "Click to configure" vs Silent

Some tools (Linear) make workspace chips clickable without any tooltip — the chevron icon is sufficient affordance. Others (VS Code) include tooltip text on every interactive element.

For DorkOS, include the tooltip for first-time discoverability: `"Configure agent"` or just `"Agent settings"`. After a user has used it twice, the tooltip is noise — but it only appears on hover anyway, so it does not add permanent clutter.

### Command Palette Trigger: Always Visible vs. Conditional

Should the search icon always appear in the header, or only when the sidebar is closed?

**Always visible** (recommended). The command palette is a top-level navigation affordance. It should be accessible at all times. Linear, GitHub, Vercel, and Slack all keep their search/command triggers permanently visible in the header regardless of sidebar state.

The only exception would be if header width is severely constrained (mobile). On mobile, the SidebarProvider renders as a Sheet (drawer), so the header layout may need to collapse. On mobile, the icon can be hidden and Cmd+K replaced by a visible search input or full-width button. But for the current desktop-first use case, always visible is correct.

### The ⌘K Discovery Problem

The Automattic/wp-calypso GitHub issue (#89581) "Make the command palette shortcut easier to learn about" reveals a real UX challenge: even when Cmd+K exists and works, users don't discover it.

Best solutions from that discussion and industry practice:
1. **Icon button in the header with tooltip** — the pattern recommended here. On hover, the tooltip shows `Search ⌘K`. This passively teaches the shortcut.
2. **Shortcut hint in an empty state** — when no session is active, a subtle `⌘K to open command palette` hint in the center of the chat area.
3. **Onboarding step** — DorkOS already has an `OnboardingFlow`. Adding a step that demonstrates Cmd+K is the most reliable way to teach it.

The icon button approach (option 1) is the ongoing passive educator. The onboarding step (option 3) is the one-time active educator. Both should exist.

### Color Accessibility

The agent color is user-chosen (stored in `agent.json`). When rendering the color dot or the tinted border, the color may have insufficient contrast on either light or dark background.

Mitigation:
- The color dot is small (6px) and decorative — it is not the primary text label. Screen readers use the text name. The dot is `aria-hidden`.
- The tinted border is extremely subtle (30% mix) and purely decorative. It does not convey information that is not also conveyed by the agent name text.
- Use `aria-hidden` on the color dot and the decorative border element.
- Add `aria-label` to the chip button: `aria-label={`${currentAgent.name} — agent settings`}`.

---

## Implementation Blueprint

### AgentIdentityChip Component

```tsx
// features/top-nav/ui/AgentIdentityChip.tsx
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore } from '@/layers/shared/model';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import type { Agent } from '@dorkos/shared/types';
import type { AgentVisual } from '@/layers/entities/agent';

interface AgentIdentityChipProps {
  agent: Agent | null | undefined;
  visual: AgentVisual;
  isStreaming: boolean;
}

export function AgentIdentityChip({ agent, visual, isStreaming }: AgentIdentityChipProps) {
  const { setAgentDialogOpen } = useAppStore();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          onClick={() => setAgentDialogOpen(true)}
          whileHover={{ backgroundColor: 'var(--accent)' }}
          whileTap={{ scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 600, damping: 40 }}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors"
          aria-label={agent ? `${agent.name} — agent settings` : 'Configure agent'}
        >
          {/* Color identity dot — pulses when streaming */}
          <motion.span
            aria-hidden
            animate={isStreaming ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
            transition={isStreaming ? { duration: 1.5, repeat: Infinity, ease: 'easeInOut' } : undefined}
            className="size-1.5 rounded-full shrink-0"
            style={{ backgroundColor: visual.color }}
          />

          {/* Agent name — animates when agent changes */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={agent?.id ?? 'no-agent'}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 3 }}
              transition={{ duration: 0.1, ease: 'easeOut' }}
              className="max-w-[160px] truncate font-medium leading-none"
            >
              {agent?.name ?? 'No agent'}
            </motion.span>
          </AnimatePresence>

          <ChevronDown
            aria-hidden
            className="text-muted-foreground size-3 shrink-0"
          />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {agent ? 'Agent settings' : 'Configure agent'}
      </TooltipContent>
    </Tooltip>
  );
}
```

### CommandPaletteTrigger Component

```tsx
// features/top-nav/ui/CommandPaletteTrigger.tsx
import { Search } from 'lucide-react';
import { motion } from 'motion/react';
import { useCommandPalette } from '@/layers/features/command-palette';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';

export function CommandPaletteTrigger() {
  const { setOpen } = useCommandPalette();
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          onClick={() => setOpen(true)}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.93 }}
          transition={{ type: 'spring', stiffness: 600, damping: 35 }}
          className="text-muted-foreground hover:text-foreground flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          aria-label="Open command palette"
        >
          <Search className="size-4" />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Search <Kbd>{isMac ? '⌘K' : 'Ctrl+K'}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
```

### Updated Header in App.tsx

```tsx
// In App.tsx, standalone path:
<header className="relative flex h-9 shrink-0 items-center gap-2 border-b px-2">
  <SidebarTrigger className="-ml-0.5" />
  <AgentIdentityChip
    agent={currentAgent}
    visual={agentVisual}
    isStreaming={isStreaming}
  />
  <div className="flex-1" />
  <CommandPaletteTrigger />

  {/* 10x: streaming scan line — sweeps across header bottom when agent is active */}
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

Note: The `relative` class is added to the header to enable the absolutely-positioned scan line child. The scan line is `aria-hidden` and `pointer-events-none` — purely decorative.

### 10x Color Tint (Optional but Recommended)

```tsx
<header
  className="relative flex h-9 shrink-0 items-center gap-2 border-b px-2 transition-colors duration-300"
  style={currentAgent ? {
    borderBottomColor: `color-mix(in srgb, ${agentVisual.color} 25%, var(--border))`,
  } : undefined}
>
```

The `transition-colors duration-300` handles smooth color transitions when the agent changes. Only apply when an agent is configured — fall back to standard `--border` when no agent.

---

## Pros and Cons Summary

### Agent Identity: Chip vs. Breadcrumb vs. Plain Text

| Approach | Pros | Cons |
|---|---|---|
| **Chip (recommended)** | Visual identity (color dot), obvious click affordance, works with agent's color system | Takes ~180px horizontal space |
| Breadcrumb | Familiar pattern, hierarchical | No color identity, less obviously clickable, wrong concept (no hierarchy) |
| Plain text label | Minimal | No interactivity signal, boring |
| Nothing | Zero clutter | Users don't know what agent is active when sidebar is closed |

### Command Palette Trigger: Icon vs. Search Bar vs. Text Button

| Approach | Pros | Cons |
|---|---|---|
| **Icon button (recommended)** | Minimal, keyboard-first users learn from one tooltip hover | Less discoverable for new users |
| Search bar | Maximum discoverability | Wide, heavy, consumer-grade feel |
| Text button ("Search... ⌘K") | Teaches shortcut passively, Notion/Vercel use this | ~120px wide, takes real estate, feels less minimal |
| Nothing (keyboard-only) | Zero chrome | Completely undiscoverable by mouse users |

### 10x Features: Prioritized

| Feature | Impact | Cost | Ship? |
|---|---|---|---|
| Color dot pulse when streaming | High | Low | Yes |
| Name slide animation on agent switch | High | Low | Yes |
| Streaming scan line at header bottom | High (brand) | Low-Medium | Yes |
| Tinted border via `color-mix` | Medium-High | Very Low | Yes |
| Session count badge on hover | Medium | Low | Optional |
| Cmd+comma shortcut hint on chip hover | Medium DX | Low | Yes |

---

## Recommendation

Implement in this order:

1. **Baseline**: `AgentIdentityChip` + `CommandPaletteTrigger` in the header with tooltips. These directly satisfy the stated requirements.

2. **10x layer 1**: Add the streaming color dot pulse animation and the name slide `AnimatePresence` transition. These cost essentially nothing and immediately make the header feel alive.

3. **10x layer 2**: Add the sweeping scan line (`motion.div` with `scaleX` animation) during streaming. This is the "control surface" moment — the header becomes an indicator panel, not just chrome.

4. **10x layer 3** (optional): Add the `color-mix` tinted border. This is the Arc Spaces pattern — the chrome embodies the agent. Test in both light and dark mode. Some team members may find it distracting; it's the most subjective of the enhancements.

---

## Sources & Evidence

- [How we redesigned the Linear UI (part II) - Linear](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Linear preview: New sidebar & team icons - Linear Changelog](https://linear.app/changelog/2022-01-20-linear-preview-new-sidebar-and-team-icons)
- [Personalized sidebar - Linear Changelog December 2024](https://linear.app/changelog/2024-12-18-personalized-sidebar)
- [Linear design: The SaaS design trend that's boring and bettering UI - LogRocket](https://blog.logrocket.com/ux-design/linear-design/)
- [Command Palette UX Patterns #1 - Medium/Bootcamp](https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1)
- [Command palettes for the web - Rob Dodson](https://robdodson.me/posts/command-palettes/)
- [Make the command palette shortcut easier to learn about - GitHub/wp-calypso issue](https://github.com/Automattic/wp-calypso/issues/89581)
- [The UX of Keyboard Shortcuts - Medium/Bootcamp](https://medium.com/design-bootcamp/the-art-of-keyboard-shortcuts-designing-for-speed-and-efficiency-9afd717fc7ed)
- [UI Copy: UX Guidelines for Command Names and Keyboard Shortcuts - NN/G](https://www.nngroup.com/articles/ui-copy/)
- [Command Palette UI Design - Mobbin](https://mobbin.com/glossary/command-palette)
- [VS Code Command Palette UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/command-palette)
- [What is Progressive Disclosure - IxDF](https://ixdf.org/literature/topics/progressive-disclosure)
- [Progressive Disclosure design pattern - UI Patterns](https://ui-patterns.com/patterns/ProgressiveDisclosure)
- [Apple Developer - Disclosure controls HIG](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)
- [The craft of SwiftUI API design: Progressive disclosure - WWDC22](https://developer.apple.com/videos/play/wwdc2022/10059/)
- [React hover animation guide - Motion](https://motion.dev/docs/react-hover-animation)
- [Motion.dev — AnimatePresence](https://motion.dev/docs/react-animate-presence)
- [Micro-animations in React with Framer Motion - Jacob Cofman](https://jcofman.de/blog/micro-animations)
- [Warp: an agentic terminal](https://www.warp.dev/terminal)
- [Mission Control for AI Coding - Medium](https://medium.com/@roman_fedyskyi/mission-control-for-ai-coding-c77d680feb46)
- Prior research: `research/20260303_command_palette_agent_centric_ux.md`
- Prior research: `research/20260303_command_palette_10x_elevation.md`

---

## Research Gaps & Limitations

- Arc Browser's specific color tinting implementation was not publicly documented — the recommendation is based on visual inspection of the product and community articles. Implementation details derived from first principles using `color-mix()` CSS.
- No DorkOS-specific user research exists on whether Kai uses the mouse or keyboard exclusively. The recommendation assumes keyboard-first behavior based on persona definition, but the visible search icon still serves mouse-only moments.
- The `color-mix()` CSS function may not be supported in all target browsers. Check DorkOS's browser support matrix. It has ~96% global support as of 2026 but may need a `@supports` fallback for older environments.
- Linear's exact header height was not measured — the 36px (`h-9`) for DorkOS is an assumption based on visual inspection. Linear appears to use 40px (`h-10`) for their top bar.

---

## Contradictions & Disputes

- **Header height**: 36px (`h-9`) is more compact than most tools. VS Code uses 35px; Linear appears to use ~40px; GitHub uses 64px. DorkOS's 36px is aggressive but defensible for a developer tool where screen real estate is precious. Do not increase height for this feature.
- **Color tint**: Some designers argue that any tinting of neutral chrome (header, sidebar) introduces visual noise. Dieter Rams would say a neutral header is "good design as little design as possible." The counterargument (Jobs/Ive) is that the tint is functional — it communicates state — and therefore not decoration but information. Resolution: implement behind a condition (`currentAgent ? tint : no-tint`); when no agent is configured the header reverts to clean neutral.
- **Motion in headers**: Streaming animations (pulse, scan line) may feel distracting to Priya, who values focus. Resolution: `MotionConfig reducedMotion="user"` is already in `App.tsx`. Users with `prefers-reduced-motion` will see no animations. The scan line and pulse both respect this system preference automatically.

---

## Search Methodology

- Searches performed: 7
- Most productive search terms: "Linear header redesign sidebar workspace team icon color identity", "command palette trigger button icon tooltip keyboard shortcut affordance", "header micro-interactions hover animation developer tool premium React"
- Primary information sources: Linear changelog, Linear blog (now.linear.app), NN/G, Motion.dev docs, Mobbin, GitHub issues
- Heavy reliance on existing DorkOS research (20260303 command-palette reports) which covered adjacent ground at depth
