# Update Top Nav — Task Breakdown

**Spec:** `specs/update-top-nav/02-specification.md`
**Generated:** 2026-03-10
**Mode:** Full decomposition

---

## Phase 1: Foundation

### Task 1.1 — Create features/top-nav module with AgentIdentityChip component

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Create the new FSD feature module `features/top-nav/` and implement the `AgentIdentityChip` component. This is the clickable chip in the header that shows the active agent's color dot and name, with a muted "No agent" fallback. Clicking opens the agent settings dialog. The color dot pulses during streaming, and the agent name slides when switching agents.

**Files created:**

- `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx`
- `apps/client/src/layers/features/top-nav/index.ts` (barrel)

**Key behaviors:**

- Agent configured: `[dot] Agent Name [chevron]` — color dot solid, text `font-medium`
- Agent streaming: color dot pulses (opacity 1 -> 0.4 -> 1, 1.5s, infinite)
- No agent: `[dashed-dot] No agent [chevron]` — muted text, dashed border dot
- Agent switching: name slides out/in via AnimatePresence (120ms)
- Click: `setAgentDialogOpen(true)`
- Press: `scale: 0.97` via `whileTap`

---

### Task 1.2 — Create CommandPaletteTrigger component

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Implement the `CommandPaletteTrigger` component — a search icon button at the right edge of the header that opens the global command palette. Tooltip reveals keyboard shortcut (Cmd+K on Mac, Ctrl+K elsewhere).

**Files created:**

- `apps/client/src/layers/features/top-nav/ui/CommandPaletteTrigger.tsx`

**Files modified:**

- `apps/client/src/layers/features/top-nav/index.ts` (add export)

**Key behaviors:**

- Search icon, `text-muted-foreground` default, `text-foreground` on hover
- Click: `setGlobalPaletteOpen(true)`
- Hover: `scale: 1.1` via spring (stiffness 600, damping 35)
- Press: `scale: 0.93` via `whileTap`
- Tooltip: "Search" + Kbd shortcut

---

## Phase 2: Header Integration

### Task 2.1 — Update App.tsx header with new components and micro-interactions

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2

Wire `AgentIdentityChip` and `CommandPaletteTrigger` into the App.tsx standalone header. Add the streaming scan line and color-tinted border micro-interactions.

**Files modified:**

- `apps/client/src/App.tsx`

**Header layout:** `[SidebarTrigger] | [AgentIdentityChip] ...spacer... [CommandPaletteTrigger]`

**Micro-interactions added:**

1. Streaming scan line — `motion.div` at header bottom, `scaleX 0->1` + `opacity 0.8->0`, 2s infinite, agent color
2. Color-tinted border — `color-mix(in srgb, color 25%, var(--border))` on `borderBottomColor`, 300ms transition

**No new data fetching** — all data (`currentAgent`, `agentVisual`, `isStreaming`) already available in App.tsx.

---

## Phase 3: Sidebar Simplification

### Task 3.1 — Simplify AgentHeader to directory context display

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.1

Simplify `AgentHeader.tsx` to remove agent identity elements now displayed in the top nav. Retain directory context (path breadcrumb), "+Agent" CTA, and "K Switch" button.

**Files modified:**

- `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx`

**Removed:**

- Colored dot, emoji, bold agent name, description display
- Gear icon (Settings) button
- `useAgentVisual`, `useIsMobile`, `Settings`, `shortenHomePath` imports
- Mobile-specific identity button behavior

**Kept:**

- `useCurrentAgent(cwd)` for layout determination
- Path breadcrumb with `FolderOpen` icon + directory picker
- "+Agent" CTA for unregistered directories
- "K Switch" palette button
- `onOpenAgentDialog` prop (used by `handleQuickCreate`)

---

## Phase 4: Testing

### Task 4.1 — Add unit tests for AgentIdentityChip

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 4.2, 4.3

**Files created:**

- `apps/client/src/layers/features/top-nav/__tests__/AgentIdentityChip.test.tsx`

**9 test cases:** renders agent name, renders "No agent", opens dialog on click (with/without agent), color dot rendering, dashed dot for no-agent, aria-labels, chevron icon.

---

### Task 4.2 — Add unit tests for CommandPaletteTrigger

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.2 | **Parallel with:** 4.1, 4.3

**Files created:**

- `apps/client/src/layers/features/top-nav/__tests__/CommandPaletteTrigger.test.tsx`

**3 test cases:** renders search icon button, opens palette on click, correct aria-label.

---

### Task 4.3 — Update AgentHeader tests for simplified component

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.1 | **Parallel with:** 4.1, 4.2

**Files modified:**

- `apps/client/src/layers/features/session-list/__tests__/AgentHeader.test.tsx`

**Removed tests:** identity click (desktop), identity click (mobile), gear icon click.
**Added tests:** path breadcrumb + Switch in agent-exists path, no identity elements rendered, directory picker in agent-exists path.
**Removed mock:** `useIsMobile` mock no longer needed.

---

## Dependency Graph

```
1.1 (AgentIdentityChip) ─┐
                          ├─→ 2.1 (Header Integration) ─→ 3.1 (Sidebar Simplification) ─→ 4.3 (AgentHeader Tests)
1.2 (CommandPaletteTrigger) ┘

1.1 ─→ 4.1 (Chip Tests)
1.2 ─→ 4.2 (Trigger Tests)
```

**Parallelizable:** 1.1 + 1.2 | 4.1 + 4.2 + 4.3
