---
slug: command-palette-10x
number: 87
created: 2026-03-03
status: ideation
---

# 10x Command Palette UX

**Slug:** command-palette-10x
**Author:** Claude Code
**Date:** 2026-03-03
**Branch:** preflight/command-palette-10x

---

## 1) Intent & Assumptions

- **Task brief:** Elevate the existing Cmd+K command palette from a functional launcher into a world-class, intelligent interface. Add an agent preview panel for informed switching, contextual zero-query suggestions, fuzzy search with typeahead highlighting and category prefixes (`@` agents, `>` commands, `#` sessions), agent sub-menus with "open here / new tab / recent sessions" drill-down, and premium micro-interactions (sliding selection indicator, stagger animations, contextual empty states, dynamic keyboard hint footer).
- **Assumptions:**
  - The existing command palette (ADR-0063, spec #85) is implemented and stable — this is a UX enhancement, not a rewrite
  - All data sources needed (mesh agents, sessions, Pulse/Relay status) are already accessible via existing entity hooks
  - The design system's "Calm Tech" philosophy applies — intelligence and polish, not decoration
  - The Shadcn sidebar redesign (spec #86) will proceed in parallel but is not a dependency
  - cmdk's `shouldFilter={false}` mode and `pages` pattern are compatible with the proposed architecture
  - motion.dev (already in the project) handles all animation needs
  - Agent count is typically < 50, command count < 100 — no virtualization needed
- **Out of scope:**
  - Inline slash command palette (chat input `/`) — separate system, untouched
  - Agent-registered custom palette actions (future extensibility)
  - Server-side search endpoints (all search is client-side from existing data)
  - Mobile-specific preview panel (desktop-first; mobile keeps current Drawer layout)

## 2) Pre-reading Log

- `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx` (243 lines): Main global palette UI. Uses Shadcn Command + ResponsiveDialog. Custom filter for `@` prefix. Static group ordering (Recent Agents, All Agents, Features, Commands, Quick Actions). No preview panel, no sub-menus, no animations beyond ResponsiveDialog defaults.
- `apps/client/src/layers/features/command-palette/ui/AgentCommandItem.tsx` (56 lines): Agent row with color dot, emoji, name, path, active checkmark. Clean but flat — no hover micro-interactions, no selection indicator animation.
- `apps/client/src/layers/features/command-palette/model/use-palette-items.ts` (108 lines): Data assembly hook combining mesh agents + commands + static features/actions. Frecency-sorted recent agents (max 5) with active agent pinned first. No session data, no contextual suggestions.
- `apps/client/src/layers/features/command-palette/model/use-agent-frecency.ts` (116 lines): localStorage-backed frecency with `score = useCount / (1 + hoursSinceUse * 0.1)`. Simple but doesn't decay as naturally as bucket-based systems. Max 50 entries, 30-day prune.
- `apps/client/src/layers/features/command-palette/model/use-global-palette.ts` (42 lines): Cmd+K keyboard shortcut handler. Closes other dialogs before opening palette. Zustand-backed open state.
- `apps/client/src/layers/shared/ui/command.tsx`: Shadcn Command primitives wrapping cmdk. Provides CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty, CommandSeparator.
- `apps/client/src/layers/shared/model/app-store.ts` (416 lines): Zustand store managing `globalPaletteOpen`, dialog states, theme, fonts. Will need new fields for palette sub-state (selected item, pages stack, previous agent).
- `apps/client/src/layers/shared/lib/fuzzy-match.ts`: Existing subsequence matcher with scoring. Used by inline command palette. Does not return match indices for highlighting.
- `contributing/animations.md`: Motion library patterns, timing specs (100-300ms), stagger via `staggerChildren`, AnimatePresence for exit animations.
- `contributing/design-system.md`: Calm Tech principles. Command palette animation spec: "Fade in + scale from 0.98, 150ms ease-out."
- `decisions/0063-shadcn-command-dialog-for-global-palette.md`: ADR for Cmd+K palette. Status: proposed. Uses cmdk + ResponsiveDialog, frecency tracking, `@` prefix mode.
- `specs/agent-centric-ux/`: Parent spec (#85) that established the agent-centric UX vision, command palette, and initial sidebar redesign direction.
- `apps/client/src/layers/entities/session/`: Exports `useSessions`, `useSessionId`, `useDirectoryState`. Session data needed for agent sub-menu (recent sessions per agent) and `#` prefix search.
- `apps/client/src/layers/entities/mesh/`: Exports `useMeshAgentPaths`, `useRegisteredAgents`, `useMeshAgentHealth`. Agent data + health for preview panel.
- `apps/client/src/layers/entities/pulse/`: Exports `usePulseEnabled`, `useActiveRunCount`, `useCompletedRunBadge`. Pulse status for contextual suggestions + preview panel.
- `apps/client/src/layers/entities/relay/`: Exports `useRelayEnabled`. Relay status for contextual suggestions + preview panel.
- `apps/client/src/layers/entities/agent/`: Exports `useCurrentAgent`, `useAgentVisual`. Agent identity for preview panel.

## 3) Codebase Map

**Primary components/modules:**

| File                                                   | Role               | Change needed                                                                   |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------- |
| `features/command-palette/ui/CommandPaletteDialog.tsx` | Main palette UI    | Major — add preview panel, pages stack, contextual groups, animations           |
| `features/command-palette/ui/AgentCommandItem.tsx`     | Agent row renderer | Moderate — add highlight support, selection indicator, hover micro-interactions |
| `features/command-palette/model/use-palette-items.ts`  | Data assembly      | Major — add session data, contextual suggestions, category prefix logic         |
| `features/command-palette/model/use-agent-frecency.ts` | Frecency tracking  | Moderate — upgrade to Slack bucket system                                       |
| `features/command-palette/model/use-global-palette.ts` | Keyboard shortcut  | Minor — add previous agent tracking                                             |
| `shared/model/app-store.ts`                            | Zustand state      | Minor — add `previousCwd` field                                                 |

**New files to create:**

| File                                                   | Role                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `features/command-palette/ui/AgentPreviewPanel.tsx`    | Rich agent context panel (right side)                          |
| `features/command-palette/ui/AgentSubMenu.tsx`         | Drill-down actions + recent sessions for selected agent        |
| `features/command-palette/ui/HighlightedText.tsx`      | Renders fuzzy match highlights as React nodes from range pairs |
| `features/command-palette/ui/PaletteFooter.tsx`        | Dynamic keyboard hint bar                                      |
| `features/command-palette/model/use-palette-search.ts` | uFuzzy integration with category prefix detection              |
| `features/command-palette/model/use-preview-data.ts`   | Debounced preview data fetching for selected agent             |

**Shared dependencies:**

- `@/layers/shared/ui` — Command primitives, ResponsiveDialog
- `@/layers/shared/model` — app-store (Zustand), useIsMobile, useTheme
- `@/layers/shared/lib` — cn, shortenHomePath, hashToHslColor, hashToEmoji
- `@/layers/entities/session` — useSessions (for sub-menu + `#` search)
- `@/layers/entities/mesh` — useMeshAgentPaths, useMeshAgentHealth (for preview)
- `@/layers/entities/pulse` — usePulseEnabled, useActiveRunCount (for suggestions + preview)
- `@/layers/entities/relay` — useRelayEnabled (for suggestions + preview)
- `@/layers/entities/agent` — useCurrentAgent, useAgentVisual (for preview)
- `motion/react` — AnimatePresence, motion.div, layoutId (for micro-interactions)
- `@leeoniya/ufuzzy` — NEW dependency, 4kb fuzzy search with match ranges

**Data flow:**

```
User presses Cmd+K
  -> useGlobalPalette() sets globalPaletteOpen: true
  -> CommandPaletteDialog opens (spring scale+fade animation)
  -> usePaletteItems() assembles groups:
      -> Contextual suggestions (from Pulse/Relay/session state)
      -> Recent agents (frecency-sorted, Slack bucket algorithm)
      -> Features (static)
      -> Quick actions (static)
  -> User types search:
      -> usePaletteSearch() detects prefix (@, >, #, or none)
      -> uFuzzy filters + scores items, returns match ranges
      -> Results render with HighlightedText (bold matched chars)
      -> Items stagger-animate into position
  -> User arrows to agent:
      -> Preview panel slides in (right side, 200ms spring)
      -> usePreviewData() fetches: health, sessions, Pulse/Relay status (100ms debounce)
  -> User presses Enter on agent:
      -> Pages stack pushes 'agent-actions'
      -> AgentSubMenu renders: Open Here, Open in New Tab, New Session, Recent Sessions
      -> Directional slide animation (left to right)
  -> User selects action:
      -> Execute action (switch cwd, window.open, etc.)
      -> Record frecency
      -> Close palette
      -> Show confirmation toast with agent color
```

**Potential blast radius:**

- Direct: ~8 files (palette UI, hooks, app-store, index.css for selection glow)
- Indirect: ~3 files (entity hooks consumed read-only — no changes needed)
- Tests: ~4 test files (CommandPaletteDialog.test.tsx updated + 3 new test files for search, preview, sub-menu)
- New dependency: `@leeoniya/ufuzzy` (4kb, zero sub-dependencies)

## 5) Research

Research report: `research/20260303_command_palette_10x.md`

### Potential Solutions

**1. Preview Panel — Side-by-side Raycast-style (Recommended)**

- Layout: flex-row dialog, list on left (40%), preview on right (60%)
- Shows only for item types with rich data (agents, sessions)
- Dialog expands from ~480px to ~720px with motion.div width spring animation
- Preview data debounced 100ms on `selectedItemId` to prevent fetch thrashing during keyboard nav
- Pros: Premium feel, informed switching, matches the gold standard (Raycast)
- Cons: Wider dialog, content modeling per item type
- Complexity: Medium-High
- Maintenance: Low (preview is additive, doesn't change core palette behavior)

**2. Fuzzy Search — uFuzzy with character highlighting (Recommended)**

- 4kb library, range-based match highlighting, word boundary + consecutive char bonuses
- Integrate via `shouldFilter={false}` on cmdk (disable built-in, manage externally)
- React-safe `HighlightedText` component builds nodes from range pairs (no unsafe HTML injection)
- Pros: Best highlighting API, tiny bundle, precise matching for developer tools
- Cons: No typo-tolerance (acceptable — agent names are precise terms)
- Complexity: Low-Medium
- Maintenance: Low

**3. Frecency — Slack bucket system (Recommended)**

- 6 time buckets (4h/24h/72h/1w/1mo/3mo) with score = totalCount \* bucketSum / min(visits, 10)
- More natural decay curve than current linear formula
- Pure client-side, localStorage, same `useSyncExternalStore` pattern
- Pros: Battle-tested (Slack + Firefox), decays naturally without explicit pruning
- Cons: Slightly more complex than current formula
- Complexity: Low
- Maintenance: Low

**4. Sub-menu drill-down — cmdk pages stack (Recommended)**

- `const [pages, setPages] = useState<string[]>([])` — array stack, last element is current page
- Backspace-when-empty goes back; Escape goes back (with `e.stopPropagation()`) or closes
- CSS height transition via `--cmdk-list-height` variable + `AnimatePresence mode="wait"` with directional slide
- Pros: cmdk-native pattern, clean keyboard UX, minimal code
- Cons: None significant — well-established pattern
- Complexity: Low-Medium
- Maintenance: Low

**5. Micro-interactions — Full motion.dev suite (Recommended)**

- Sliding selection indicator: `layoutId="cmd-selection"` on a `motion.div` behind the selected item — creates the "sliding pill" effect (Raycast/Vercel pattern)
- Stagger entrance: `staggerChildren: 0.04` (40ms) on initial open and page transitions only (not every keystroke)
- Dialog entrance: spring scale (0.96 to 1) + fade, 150ms
- Page transitions: directional x-axis slide (sub-menu slides from right, back slides from left)
- Item hover: subtle 2px rightward nudge (Linear pattern)
- Preview panel: width spring animation with `AnimatePresence`
- Respects `prefers-reduced-motion` via existing `MotionConfig` in App.tsx
- Limit stagger to first 8 visible items for performance
- Pros: Dramatic quality uplift, consistent with project's motion patterns
- Cons: Needs care with cmdk integration (wrap content inside CommandItem, not the item itself)
- Complexity: Medium
- Maintenance: Low

### Key Research Findings

| Tool       | Signature Pattern              | Takeaway for DorkOS                                |
| ---------- | ------------------------------ | -------------------------------------------------- |
| Raycast    | Split-view list+detail         | Preview panel model for agents                     |
| Linear     | Speed-first, zero-latency      | Pre-load all data, < 50ms open                     |
| VS Code    | Prefix scoping (`>`, `@`, `:`) | Category prefixes for agent/command/session search |
| Superhuman | Shortcut education via palette | Display keyboard shortcuts next to actions         |
| Slack      | Bucket frecency                | Natural decay algorithm for ranking                |
| Vercel     | Sliding selection indicator    | `layoutId` pill for premium keyboard nav feel      |

### Critical Implementation Details

**cmdk + motion.dev compatibility:** `AnimatePresence` wrapping `CommandItem` components can interfere with cmdk's keyboard navigation. Workaround: wrap the _content_ inside `CommandItem`, not the `CommandItem` element itself. The sliding selection indicator uses a `motion.div` with `layoutId` and `position: absolute` within each item's relatively-positioned container.

**Escape key handling in sub-menus:** The critical detail is `e.stopPropagation()` when pages exist — otherwise Escape closes the entire dialog instead of going back one level. Only let Escape propagate (to close the dialog) when `pages.length === 0`.

**uFuzzy React-safe highlighting:** Build React nodes directly from `info.ranges` pairs — each pair is [startIndex, endIndex]. Wrap matched chars in a `<mark>` with `bg-transparent text-foreground font-semibold`. No unsafe HTML APIs needed.

## 6) Decisions

| #   | Decision                  | Choice                                                 | Rationale                                                                                                   |
| --- | ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | Fuzzy search library      | uFuzzy (4kb)                                           | Range-based match highlighting without unsafe HTML; precise matching ideal for developer tools; tiny bundle |
| 2   | Frecency algorithm        | Slack bucket system                                    | More natural decay than current linear formula; battle-tested at scale (Slack, Firefox)                     |
| 3   | Preview panel layout      | Side-by-side Raycast-style                             | Rich context for informed agent switching; dialog width animation provides premium feel                     |
| 4   | Sub-menu pattern          | cmdk pages stack                                       | Native cmdk pattern; clean keyboard UX with Backspace/Escape navigation                                     |
| 5   | Selection indicator       | motion.dev layoutId sliding pill                       | Single highest-impact micro-interaction; makes keyboard nav feel native, not "webby"                        |
| 6   | Category prefixes         | `@` agents, `>` commands, `#` sessions                 | VS Code-proven mental model; `@` already exists, extending to `>` and `#`                                   |
| 7   | Agent switch UX           | Enter opens sub-menu, Cmd+Enter opens new tab directly | Sub-menu enables Open Here / New Tab / Recent Sessions; Cmd+Enter as fast path skips sub-menu               |
| 8   | Contextual suggestions    | Client-side rules engine (max 3 items)                 | No new server endpoints; computed from existing hooks (Pulse runs, agent errors, session state)             |
| 9   | Animation timing          | Stagger on open + page transitions only                | Not on every keystroke — avoids visual noise; 40ms stagger, 150ms dialog open, 200ms preview slide          |
| 10  | Natural language fallback | "Ask Claude: '{query}'" on empty results               | Palette never dead-ends; closes and sends query as chat message                                             |
