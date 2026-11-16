---
slug: shortcut-discoverability
number: 118
created: 2026-03-11
status: ideation
---

# Keyboard Shortcut Discoverability

**Slug:** shortcut-discoverability
**Author:** Claude Code
**Date:** 2026-03-11
**Branch:** preflight/shortcut-discoverability

---

## 1) Intent & Assumptions

- **Task brief:** Replace the tooltip on the "New session" button with an inline shortcut hint that fades in on hover (right-aligned within the button). Build comprehensive keyboard shortcut discoverability: a centralized shortcut registry, inline hints on all shortcutable buttons, a `?`-triggered shortcuts reference panel, shortcut hints in the command palette, and extract the duplicated `isMac` detection into a shared utility.
- **Assumptions:**
  - Desktop-only for keyboard shortcut hints (the existing `Kbd` component already hides on mobile via `hidden md:inline-flex`)
  - The `?` key is safe to use as a trigger — the chat textarea captures keystrokes when focused, preventing `?` from firing during typing
  - No new dependencies — keep using manual `useEffect` + `addEventListener('keydown')` patterns already established in the codebase
  - The shortcuts panel is a simple categorized list (not searchable) — DorkOS has ~15 shortcuts, easily scannable
- **Out of scope:**
  - Custom keybinding / remapping (user-configurable shortcuts)
  - Onboarding tours or first-use prompts for shortcuts
  - Gamification (Figma-style "tried/untried" tracking)
  - Migrating existing shortcut handlers to a library

## 2) Pre-reading Log

- `apps/client/src/layers/features/session-list/ui/AgentSidebar.tsx`: Contains `Cmd+Shift+N` (new session) and `Cmd+1/2/3` (tab switching) handlers; the "New session" button currently uses a Tooltip+Kbd pattern
- `apps/client/src/layers/features/top-nav/ui/CommandPaletteTrigger.tsx`: Icon button with Tooltip showing `⌘K` shortcut hint — good candidate for inline hint
- `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx`: 587-line command palette; features have optional `shortcut` field but no features currently populate it
- `apps/client/src/layers/features/command-palette/ui/PaletteFooter.tsx`: Context-aware keyboard hint bar with custom `KBD_CLASS` styling and `isMac` detection (duplicated)
- `apps/client/src/layers/features/command-palette/model/use-palette-items.ts`: `FeatureItem` interface has `shortcut?: string` — ready for registry integration
- `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx`: Sidebar tabs with Tooltip showing `⌘1`/`⌘2`/`⌘3` hints and duplicated `isMac` detection
- `apps/client/src/layers/shared/ui/kbd.tsx`: Existing `Kbd` component with `hidden md:inline-flex`, `pointer-events-none`, `font-mono text-[10px]`
- `apps/client/src/layers/shared/ui/sidebar.tsx`: `SidebarMenuButton` component and `SidebarProvider` with `TooltipProvider delayDuration={0}`
- `apps/client/src/layers/shared/ui/responsive-dialog.tsx`: Dialog on desktop, Drawer on mobile — ideal for the `?` panel
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store with toggle patterns for all panels (pulseOpen, relayOpen, meshOpen, etc.)
- `apps/client/src/App.tsx`: `Cmd+B` sidebar toggle, `Escape` overlay close, and duplicated `isMac` detection
- `apps/client/src/layers/shared/model/use-interactive-shortcuts.ts`: Existing interactive tool shortcut system with input guard pattern
- `apps/client/src/layers/features/command-palette/model/use-global-palette.ts`: `Cmd+K` handler for command palette toggle
- `apps/client/src/layers/shared/lib/platform.ts`: Platform adapter for Obsidian detection (does NOT contain `isMac`)
- `contributing/keyboard-shortcuts.md`: Comprehensive keyboard shortcuts documentation
- `research/20260311_keyboard_shortcut_discoverability_ux.md`: Full research on industry patterns

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                          | Role                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| `layers/shared/ui/kbd.tsx`                                    | `Kbd` presentational component                                  |
| `layers/shared/model/app-store.ts`                            | Zustand store — will add `shortcutsPanelOpen` state             |
| `layers/shared/lib/platform.ts`                               | Platform utilities — will add `isMac`                           |
| `layers/features/session-list/ui/AgentSidebar.tsx`            | New session button (inline hint target) + `Cmd+Shift+N` handler |
| `layers/features/top-nav/ui/CommandPaletteTrigger.tsx`        | `⌘K` button (inline hint target)                                |
| `layers/features/session-list/ui/SidebarTabRow.tsx`           | Tab tooltips with shortcut hints                                |
| `layers/features/command-palette/ui/CommandPaletteDialog.tsx` | Palette feature items (shortcut hint target)                    |
| `layers/features/command-palette/model/use-palette-items.ts`  | Feature items with optional `shortcut` field                    |
| `layers/features/command-palette/ui/PaletteFooter.tsx`        | Context-aware keyboard hints                                    |
| `App.tsx`                                                     | Global shortcut handlers, will mount `ShortcutsPanel`           |

**Shared Dependencies:**

- `@/layers/shared/ui` — Kbd, Dialog, ResponsiveDialog, Tooltip components
- `@/layers/shared/model` — Zustand app-store, useIsMobile
- `@/layers/shared/lib` — cn utility, platform utilities
- `motion/react` — animation library (already used for hover effects)

**Data Flow:**
`SHORTCUTS` registry (shared/lib) → consumed by: ShortcutsPanel UI, command palette items, inline button hints, `?` key handler

**Feature Flags/Config:** None

**Potential Blast Radius:**

- Direct: ~10 files (registry, panel, button hints, isMac extraction, palette items)
- Indirect: 5 files (existing `isMac` duplication sites get simplified)
- Tests: Panel component test + registry unit test

## 5) Research

Research documented in full at `research/20260311_keyboard_shortcut_discoverability_ux.md`. Key findings:

### Industry Patterns

1. **`?` key is the universal standard** for shortcuts reference panels — used by GitHub, Linear, Gmail, Figma, Jira, Slack, Twitter/X
2. **Inline button hints** use pre-allocated invisible slots (`opacity-0` → `opacity-100` on `group-hover`) — button width never changes (Linear, Superhuman pattern)
3. **Command palette shortcut hints** use `<CommandShortcut>` with `ml-auto` for right-alignment — educates users about direct shortcuts while they browse the palette (Superhuman effect)
4. **Centralized registry** is the architectural prerequisite — drives the `?` panel auto-generation, command palette hints, and button hints from one source of truth
5. **Input guard** checks `INPUT`, `TEXTAREA`, `SELECT`, and `contentEditable` before firing any non-modifier shortcut

### Recommendation

A four-layer approach:

1. **Registry** (`SHORTCUTS` constant) — single source of truth for all shortcuts
2. **Inline hints** — fade-in `Kbd` on button hover for primary actions
3. **Command palette hints** — `CommandShortcut` on feature/command items
4. **Reference panel** — `?`-triggered modal, categorized, auto-generated from registry

## 6) Decisions

| #   | Decision                      | Choice                                       | Rationale                                                                                                                                                                                                                                                     |
| --- | ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shortcut library              | Keep manual `useEffect` + `addEventListener` | DorkOS already has ~8 handlers using this pattern. Adding `react-hotkeys-hook` creates two patterns. The existing approach is zero-dependency and works. A centralized `SHORTCUTS` registry gives the same single-source-of-truth benefits without a library. |
| 2   | Shortcuts panel searchability | Simple categorized list (no search)          | DorkOS has ~15 shortcuts — easily scannable without search. Avoids overengineering. Can add search later when count grows. GitHub uses this approach.                                                                                                         |
| 3   | FSD layer for registry        | `shared/lib/shortcuts.ts`                    | Pure data constant, no React dependency. Importable from any FSD layer (shared → entities → features). The `?` panel feature and command palette feature can both import it without violating cross-feature import rules.                                     |
| 4   | "New session" button hint UX  | Fade-in Kbd right-aligned, keep icon+label   | Button stays full-width with `justify-between`. Kbd fades in at `opacity-0 → opacity-100` on `group-hover`. Icon + "New session" stays on the left. No layout shift. Matches Linear's sidebar pattern.                                                        |
