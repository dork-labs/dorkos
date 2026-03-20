---
slug: shortcut-chips
number: 21
created: 2026-02-13
status: implemented
---

# Shortcut Chips

**Slug:** shortcut-chips
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Add small clickable "shortcut chips" below the chat input that hint at available triggers (`/` for commands, `@` for files). Include a setting toggle in the Preferences tab to show/hide them, defaulting to ON.

**Assumptions:**

- Chips are visual hints AND click targets — clicking inserts the trigger character into the input
- Two chips initially: `/ Commands` and `@ Files`
- Chips respect the existing design system (neutral palette, 8pt grid, motion specs)
- Mobile-friendly: meet 44px min tap target, don't crowd the input area
- Setting persists in localStorage via the existing Zustand store pattern

**Out of scope:**

- Rotating/cycling placeholder text (separate enhancement)
- Contextual placeholder ("Ask about server/index.ts...")
- Additional chip types beyond `/` and `@`
- The AskUser tool tab-bar improvements mentioned in .temp notes (unrelated feature)

---

## 2) Pre-reading Log

- `apps/client/src/components/chat/ChatInput.tsx`: 186-line controlled component. Flex container with `items-end gap-1.5 rounded-xl border p-1.5 pl-3`. Textarea + animated send button. Chips would sit below this container or inside it as a new row.
- `apps/client/src/components/chat/ChatPanel.tsx`: 395 lines. Input container is `chat-input-container relative border-t p-4`. ChatInput is rendered directly inside with CommandPalette and FilePalette positioned `absolute bottom-full` above it. StatusLine sits below.
- `apps/client/src/stores/app-store.ts`: Zustand + devtools + localStorage persistence. Consistent pattern: boolean state + setter + localStorage read in initializer + cleanup in `resetPreferences`.
- `apps/client/src/components/settings/SettingsDialog.tsx`: 326 lines. Three tabs: Preferences, Status Bar, Server. Preferences tab uses `SettingRow` component (label + description + Switch child) in a `space-y-6` stack.
- `apps/client/src/components/ui/badge.tsx`: Existing badge component with `default`, `secondary`, `destructive`, `outline` variants. Small: `px-2 py-0.5 text-xs`. No click affordance — purely decorative.
- `guides/design-system.md`: 8pt grid, motion timing (Fast=150ms, Normal=200ms), neutral gray palette, accent blue only for interactive elements.
- `apps/client/src/components/commands/CommandPalette.tsx`: motion.div with `initial/animate/exit` pattern, `rounded-lg`, hover `bg-muted`, selected `bg-ring/10`.

---

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/components/chat/ChatInput.tsx` — textarea + send button, will gain chips row
- `apps/client/src/components/chat/ChatPanel.tsx` — orchestrator, wires input to palettes, will pass chip click handler
- `apps/client/src/stores/app-store.ts` — Zustand preferences store, will gain `showShortcutChips` toggle
- `apps/client/src/components/settings/SettingsDialog.tsx` — Preferences tab, will gain new SettingRow

**Shared dependencies:**

- `motion/react` — AnimatePresence + motion.div for chip enter/exit animations
- `apps/client/src/components/ui/badge.tsx` — potential base styling (or create standalone)
- `apps/client/src/components/ui/switch.tsx` — used in settings toggle
- Lucide icons: `Terminal`, `FileText` (or similar) for chip icons

**Data flow:**

- User sees chips -> clicks chip -> ChatPanel handler inserts trigger char into input -> existing `@`/`/` detection opens palette
- Settings toggle -> Zustand store -> `showShortcutChips` boolean -> ChatPanel conditionally renders chips

**Potential blast radius:**

- `ChatPanel.tsx` — layout change (add chips row between input and status)
- `ChatInput.tsx` — possibly no changes if chips live outside ChatInput
- `app-store.ts` — new boolean + setter + localStorage
- `SettingsDialog.tsx` — new SettingRow
- Test files for ChatPanel, SettingsDialog, app-store

---

## 4) Research

### Patterns from world-class apps

**Slack's compose area:**

- Formatting toolbar below input with icon buttons
- Lightning bolt icon for shortcuts on mobile
- Dual strategy: inside for formatting, below for actions

**ChatGPT:**

- Suggestion chips appear after responses, not persistently below input
- Rounded pills with subtle backgrounds
- Chips are contextual (not always visible)

**Material Design Action Chips:**

- Height: 32px, padding: 12px horizontal
- Border-radius: 16px (pill) or 6px (rounded)
- Neutral-100/200 backgrounds, 200ms hover transitions
- 8px gap between chips

**Claude.ai:**

- Uses Cmd+K command palette rather than persistent chips
- Clean, minimal input area

**Mobile best practices:**

- 44x44px minimum tap targets (WCAG 2.1 AAA)
- 6 or fewer chips: multi-line wrapping OK
- More than 6: horizontal scroll
- `-webkit-overflow-scrolling: touch` for smooth scrolling

### Potential solutions

**1. Chips below input container (outside the border)**

- Small pills rendered between ChatInput and StatusLine
- Pros: Zero impact on ChatInput component, simple layout, clear visual separation
- Cons: Slightly disconnected from the input visually
- Complexity: Low
- Maintenance: Low

**2. Chips inside input container (below textarea, inside the border)**

- Restructure ChatInput's flex container to flex-col, add chips row at bottom
- Pros: Feels integrated with the input, compact
- Cons: Increases ChatInput complexity, harder to animate independently
- Complexity: Medium
- Maintenance: Medium

**3. Chips as floating overlay (like palette positioning)**

- Absolutely positioned chips that appear on input focus
- Pros: Only visible when needed, zero layout impact
- Cons: Can feel jarring, occludes content, harder to discover
- Complexity: Medium
- Maintenance: Medium

### Recommendation

**Approach 1: Chips below input container** — simplest, cleanest, and matches ChatGPT/Slack patterns. Renders in ChatPanel between ChatInput and StatusLine. Zero changes to ChatInput component. Easy to animate with existing motion patterns. Easy to conditionally hide via the setting.

**Visual spec:**

- `flex gap-2` row, `mt-1.5` below input
- Each chip: `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs`
- Colors: `bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted`
- Icons: 12px Lucide icons (`Terminal` for commands, `File` for files)
- Animation: fade in with `motion.div`, `duration: 0.2`
- Click: insert trigger character at cursor position, focus input
- Keyboard hint: show `/ ` and `@ ` as subtle kbd-style text

---

## 5) Clarification

1. **Chip visual style:** Should chips use a subtle `outline` border or a filled `bg-secondary` background? (Recommendation: filled `bg-secondary` — more discoverable, consistent with badge secondary variant)

2. **Behavior after click:** After clicking a chip and the palette opens, should the chip visually highlight or hide? (Recommendation: keep visible, no special state — the palette appearing is feedback enough)

3. **Placement:** Below the input container but above StatusLine — confirmed? Or should chips sit inside the input container border?

4. **Mobile:** On mobile, should chips be full-width pills stacked vertically, or stay as small inline pills? (Recommendation: stay inline, they're small enough at 2 chips)
