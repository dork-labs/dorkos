---
slug: update-top-nav
number: 112
created: 2026-03-10
status: ideation
---

# Update Top Nav

**Slug:** update-top-nav
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/update-top-nav

---

## 1) Intent & Assumptions

- **Task brief:** Update the App.tsx standalone header to show the agent name (clickable to open agent config modal), add a right-aligned search icon that opens the command palette (with tooltip showing CMD+K), and elevate the header to 10x quality with micro-interactions and progressive disclosure. Refactor the sidebar's AgentHeader after its identity elements move to the top nav.
- **Assumptions:**
  - Standalone mode only — embedded/Obsidian mode has its own overlay layout and is out of scope
  - Agent config modal (`AgentDialog`) and command palette (`CommandPaletteDialog`) already exist and work correctly
  - All agent data hooks (`useCurrentAgent`, `useAgentVisual`) are already wired in App.tsx
  - `isStreaming` state is available via `useAppStore` for streaming animations
  - The header height stays at `h-9` (36px) — no increase
- **Out of scope:**
  - Embedded mode header changes
  - Command palette internals
  - Sidebar redesign beyond simplifying AgentHeader
  - Mobile-specific header layout (existing responsive behavior is sufficient)

## 2) Pre-reading Log

- `apps/client/src/App.tsx`: Current header at line 208 — single `SidebarTrigger` in a 36px flex row with border-bottom. All agent hooks already wired in the component scope.
- `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx`: 132-line component showing agent identity (color dot, emoji, name, description, path) with click-to-open-palette (mobile) or click-to-open-dialog (desktop), plus "K Switch" shortcut row and gear icon.
- `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx`: 600+ line dialog. Opened via `setGlobalPaletteOpen(true)` in app-store. Global `Cmd+K` listener already wired.
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx`: Orchestrates all dialogs. `agentDialogOpen` / `setAgentDialogOpen` controls the agent settings modal.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store with `agentDialogOpen`, `globalPaletteOpen`, `isStreaming`, and other transient states.
- `apps/client/src/layers/shared/ui/kbd.tsx`: `Kbd` component — mono gray badge, hidden on mobile (`md:inline-flex`).
- `apps/client/src/layers/shared/ui/tooltip.tsx`: Radix-based tooltip with configurable side placement.
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Parent of AgentHeader — passes `cwd`, `onOpenPicker`, `onOpenAgentDialog` props.
- `contributing/design-system.md`: 8pt grid, `text-sm` (14px), `text-muted-foreground` for labels, spring animations with stiffness 500/damping 35.
- `contributing/animations.md`: Motion patterns — spring physics, `AnimatePresence` for exits, stagger 40ms, 150ms transitions.
- `specs/command-palette-10x/02-specification.md`: Comprehensive command palette spec (spec #87). Covers Cmd+K binding, zero-query state, agent frecency.
- `specs/agent-centric-ux/02-specification.md`: Agent-centric UX overhaul (spec #85). Covers sidebar redesign and command palette integration.
- `meta/personas/the-autonomous-builder.md`: Kai — runs 10-20 agent sessions/week across 5 projects. Needs glanceable agent identity. Keyboard-first.
- `meta/personas/the-knowledge-architect.md`: Priya — flow preservation is core emotional need. Every unnecessary element is a distraction. Reads source code.
- `research/20260310_top_nav_header_design.md`: Full research report covering industry patterns (Linear, VS Code, Arc, Raycast, Warp, GitHub Desktop), agent identity chip anatomy, command palette trigger UX, micro-interactions, progressive disclosure, and 10x enhancement ideas.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/App.tsx` — header JSX (line 208-210), standalone mode layout
  - `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx` — current agent identity in sidebar (to be simplified)
  - `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — parent of AgentHeader
  - `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` — dialog orchestration
- **Shared dependencies:**
  - `shared/model/app-store.ts` — `agentDialogOpen`, `globalPaletteOpen`, `isStreaming`
  - `shared/ui/tooltip.tsx` — Tooltip components
  - `shared/ui/kbd.tsx` — Kbd keyboard shortcut badge
  - `entities/agent/` — `useCurrentAgent`, `useAgentVisual`, `useCreateAgent`
  - `entities/session/` — `useDirectoryState`
  - `motion/react` — `motion`, `AnimatePresence`
  - `lucide-react` — `Search`, `ChevronDown` icons
- **Data flow:**
  - `selectedCwd` → `useCurrentAgent(cwd)` → `currentAgent` → `useAgentVisual(agent, cwd)` → `agentVisual.color`, `agentVisual.emoji` (already computed in App.tsx)
  - Click agent chip → `setAgentDialogOpen(true)` → DialogHost renders AgentDialog
  - Click search icon → `setGlobalPaletteOpen(true)` → CommandPaletteDialog opens
- **Feature flags/config:** None
- **Potential blast radius:**
  - Direct: App.tsx (header update), AgentHeader.tsx (simplification), new `features/top-nav/` module
  - Indirect: SessionSidebar.tsx (may simplify AgentHeader props)
  - Tests: AgentHeader tests may need updates after simplification

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

Full report at `research/20260310_top_nav_header_design.md`.

### Potential Solutions

**1. Agent Identity Chip (Color dot + name + chevron)**
- Description: A compact clickable chip showing `[●] Agent Name ▾` with the agent's color dot, truncated name, and a chevron-down affordance. Opens AgentDialog on click.
- Pros: Visual identity via color system, obvious click affordance, compact (~180px), follows Linear/Warp patterns
- Cons: Takes horizontal header space, new component to maintain
- Complexity: Low
- Industry precedent: Linear (workspace identity chip), Warp (clickable session name), GitHub Desktop (repository dropdown)

**2. Command Palette Trigger (Search icon + tooltip)**
- Description: A right-aligned magnifying glass icon button. Tooltip shows "Search ⌘K" with `Kbd` component. Opens command palette on click.
- Pros: Minimal footprint, keyboard-first users learn from one tooltip hover, universally recognized icon
- Cons: Less discoverable than a search bar for new users (mitigated by tooltip + onboarding)
- Complexity: Low
- Industry precedent: VS Code (magnifying glass), GitHub (search icon in header), Linear (Cmd+K everywhere)

**3. Header Layout: `[≡] [● Agent Name ▾] ——— [🔍]`**
- Description: Left-to-right: sidebar trigger, agent chip, flex spacer, search icon. Clean, minimal, information hierarchy follows reading direction.
- Pros: Matches GitHub Desktop pattern (where > state > actions), extremely simple layout
- Cons: None identified — this is the consensus pattern

**4. 10x Enhancements**
- **Color dot pulse during streaming**: Subtle opacity breathing (1 → 0.4 → 1, 1.5s) on the agent color dot when `isStreaming`. Borrowed from Linear's status indicators.
- **Agent name slide animation**: `AnimatePresence mode="wait"` with `y: -3 → 0 → 3` transition (120ms) when agent changes. Confirms switch visually.
- **Streaming scan line**: A thin colored line (`h-px`) sweeps across the header bottom border during streaming via `scaleX: 0 → 1` with opacity fade. Radar/sonar metaphor — the agent is scanning. Purely decorative, `aria-hidden`.
- **Color-tinted border**: `color-mix(in srgb, ${agentVisual.color} 25%, var(--border))` on border-bottom. Arc Browser Spaces pattern — chrome embodies the agent. Transitions smoothly on agent switch.

### Recommendation

Implement all four enhancements. They are low-cost, respect `prefers-reduced-motion` via the existing `MotionConfig reducedMotion="user"` wrapper, and collectively transform the header from navigation chrome into a control surface.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Component structure | New `features/top-nav/` FSD module | Cleaner separation, follows FSD conventions, easier to test and extend. App.tsx is already 230 lines. |
| 2 | AgentHeader fate | Simplify to directory/path display only | Agent identity moves to header. Keep path breadcrumb, "+Agent" CTA, and "K Switch" palette shortcut in sidebar. |
| 3 | 10x enhancements | All four (dot pulse, name slide, scan line, color-tinted border) | Maximum craft, all low-cost, all respect prefers-reduced-motion. |
| 4 | Agent chip tooltip | "Agent settings" (no keyboard shortcut) | No shortcut for agent settings exists yet — don't suggest one we haven't built. Clean and clear. |
