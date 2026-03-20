---
title: 'Keyboard Shortcut Discoverability UX Patterns for Developer Tools'
date: 2026-03-11
type: external-best-practices
status: active
tags:
  [
    keyboard-shortcuts,
    discoverability,
    ux,
    buttons,
    shortcut-registry,
    help-panel,
    question-mark-key,
    cmdk,
    react-hotkeys-hook,
    tailwind,
    input-guard,
  ]
searches_performed: 18
sources_count: 32
---

# Keyboard Shortcut Discoverability UX Patterns for Developer Tools

## Research Summary

There are five interlocking mechanisms that world-class developer tools (Linear, Figma, GitHub, VS Code, Slack, Superhuman) use to make keyboard shortcuts discoverable: (1) inline shortcut hints on buttons revealed on hover, (2) a `?`-triggered reference panel for the full shortcut catalog, (3) shortcut hints displayed right-aligned inside command palette items via `<CommandShortcut>`, (4) a centralized shortcut registry that drives both the shortcuts themselves and their documentation, and (5) an input-guard that prevents any of these from firing while the user is typing. The canonical React library for this pattern is `react-hotkeys-hook` (3.1M weekly downloads), supplemented by a thin registry abstraction. The `?` key as a trigger is the overwhelming industry standard, used by GitHub, Linear, Gmail, Slack, Figma, and dozens of others. Discoverability and the registry are closely coupled — the shortcuts reference panel should be auto-generated from the same data that registers the shortcuts.

---

## Key Findings

### 1. Inline Shortcut Hints on Buttons

The pattern of revealing a keyboard shortcut hint _inside_ a button on hover — not in a separate tooltip — is used by Linear, Superhuman, Figma's menu items, and VS Code's command items. The core UX principle is that the shortcut hint should appear adjacent to the label at the moment of intent (hovering), reinforcing the mental model: "I can do this with my mouse, OR I can do this with this key."

**The three implementation approaches:**

**Approach A: Fade-in right-aligned hint (recommended)**
The button has a fixed layout with `justify-between`. The shortcut text `<kbd>` starts at `opacity-0` and transitions to `opacity-100` on parent group-hover. The button width does NOT change — the hint occupies the rightmost slot and is invisible by default.

```tsx
// Tailwind group-hover fade reveal — width stays fixed
<button className="group hover:bg-accent flex w-full items-center justify-between gap-4 rounded-md px-3 py-1.5">
  <span>New Session</span>
  <kbd className="text-muted-foreground bg-muted rounded border px-1.5 py-0.5 text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-100">
    C
  </kbd>
</button>
```

**Approach B: Slide-in from right (more dynamic)**
The hint starts translated off-screen to the right and slides in on hover. Requires `overflow-hidden` on the button to clip the hint before it appears.

```tsx
<button className="group flex items-center justify-between gap-2 overflow-hidden rounded-md px-3 py-1.5">
  <span>New Session</span>
  <kbd className="text-muted-foreground bg-muted translate-x-4 rounded border px-1.5 py-0.5 text-xs opacity-0 transition-all duration-150 ease-out group-hover:translate-x-0 group-hover:opacity-100">
    C
  </kbd>
</button>
```

**Approach C: Width-expanding button (avoid)**
The button starts narrow (label only) and expands to accommodate the shortcut hint. This causes layout shift, which is jarring in sidebars. All major apps avoid this. The button width should be fixed or full-width, with the hint slot always allocated but invisible.

**Width strategy decision:** Use fixed width (or `w-full`) buttons where the right slot is pre-allocated but invisible. Never let the reveal change the button's outer dimensions. This is how Linear and VS Code's sidebar buttons behave — the shortcut slot is always reserved.

**When to show inline hints vs. tooltip hints:**

- Inline hints (inside the button): Best for sidebar navigation items and action buttons that already have a fixed width layout. Works well because there's horizontal space.
- Tooltip hints (external): Best for icon-only buttons where there's no room for text. The tooltip contains both the label and the shortcut.
- Both approaches are not mutually exclusive — Linear uses tooltip hints for the icon-only toolbar and inline hints for the sidebar text items.

**The `<kbd>` element:** Always use the semantic `<kbd>` HTML element for shortcut display. Screen readers understand `<kbd>` as a keyboard key. Style it with a small border, slightly darker background, and monospace or system-ui font. `text-[10px]` or `text-xs` with `font-mono` is the standard.

```tsx
// Canonical kbd styling (Tailwind)
<kbd className="border-border bg-muted text-muted-foreground inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 font-mono text-[10px]">
  ⌘K
</kbd>
```

---

### 2. Keyboard Shortcuts Reference Panel (`?` Key)

**The `?` key is the universal standard.** Gmail established this pattern circa 2010. GitHub, Linear, Slack, Figma, Notion, Jira, Superhuman, HackerNews, and dozens of other developer-focused web apps all use `?` to open a shortcuts reference panel. There is no viable alternative — it is the expected convention.

**Modal vs. Drawer vs. Panel:**

| Format                     | Apps                         | Assessment                                                           |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| Modal (centered, overlaid) | GitHub, Linear, Figma        | Best for reference — user is pausing to consult, not continuing work |
| Drawer (side panel)        | Slack, Notion (help sidebar) | Better for persistent reference while working, but takes real estate |
| Inline overlay             | Some Electron apps           | Unusual for web                                                      |

**Recommendation: Centered modal.** The user opening `?` is doing a lookup — they've paused their workflow. A modal at 600-700px wide is the right form factor. It should not be a drawer that competes with the main UI.

**What Linear's `?` panel does (confirmed from changelog):**

- Triggered by `?` key from anywhere in the app
- Also accessible from Help & Feedback > Keyboard shortcuts in sidebar
- **Searchable** — the panel has its own search field so users can find a shortcut by typing what they want to do
- Visually reorganized vs. the older static list — shortcuts are grouped by functional context
- Updated in 2021 to add searchability; prior to that it was a static list

**What GitHub's `?` panel does:**

- Context-sensitive: pressing `?` on the issues list page shows issue-related shortcuts; pressing `?` on a PR shows PR shortcuts; global shortcuts always appear
- Organized in groups by context/page type
- Single-key sequences (like `g i`, `g p`) are shown as sequential key presses
- No search (GitHub's panel is more reference than explorer)

**What Figma does:**

- `Ctrl+Shift+?` opens the shortcuts panel (slightly non-standard — an affordance to Figma's rich shortcut set)
- The panel is gamified: shortcuts are color-coded by which ones the user has tried. This is the most sophisticated discoverability pattern observed across all major apps.
- Organized by tool categories (Select, Shape, Text, View, etc.)

**Recommended structure for DorkOS `?` panel:**

```
+-----------------------------------------------+
| Keyboard Shortcuts                     [✕]    |
|                                               |
| [Search shortcuts...                    ]     |
|                                               |
| SESSIONS                                      |
| New session                             C     |
| Close session                         ⌘W     |
| Focus chat input                      ⌘L     |
|                                               |
| NAVIGATION                                    |
| Open command palette                  ⌘K     |
| Go to pulse scheduler                 ⌘P     |
| Go to relay                           ⌘R     |
|                                               |
| AGENTS                                        |
| Discover agents                       ⌘D     |
| Switch agent                          ⌘J     |
|                                               |
| GLOBAL                                        |
| Keyboard shortcuts (this panel)         ?     |
| Toggle theme                       ⌘⇧T     |
+-----------------------------------------------+
```

**Categorization strategy:**
Group by _user intent / workflow stage_, not by modifier key. The user thinks "I want to do something with sessions" not "I want to use Cmd". Categories: Sessions, Navigation, Agents, Global.

**Searchability:**
Linear added search to their shortcuts panel in 2021 and it is now considered essential for any app with more than ~12 shortcuts. The search should filter shortcuts by name/description in real-time. The search input should auto-focus when the panel opens.

**Dismiss behavior:**

- `?` again: toggle (same key opens and closes — this is the standard)
- `Escape`: also dismisses
- Clicking outside: also dismisses
  Do NOT require the user to find a close button. Both `?` and `Escape` must close it.

**Implementation pattern:**

```typescript
// At document level, registered once (e.g., in App.tsx useEffect)
const handler = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement;
  const inInput =
    target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

  // '?' requires Shift+/ — e.key is '?' when Shift+/ is pressed
  if (e.key === '?' && !inInput) {
    e.preventDefault();
    setShortcutsOpen((prev) => !prev); // toggle
  }
};
document.addEventListener('keydown', handler);
return () => document.removeEventListener('keydown', handler);
```

Note: `?` is `Shift+/` on US keyboards. `e.key === '?'` correctly captures this without needing to check for Shift. This is the right way to detect it.

---

### 3. Command Palette Shortcut Hints (`<CommandShortcut>`)

The shadcn/ui `CommandShortcut` component (already in the DorkOS codebase) handles the right-aligned shortcut display inside command palette items. It uses `ml-auto` to push the hint to the right side of the flex row.

**How it looks:**

```
⌙ New Session                             C
  Pulse Scheduler                        ⌘P
  Relay Messages                         ⌘R
  Settings                               ⌘,
```

**Usage:**

```tsx
import { CommandItem, CommandShortcut } from '@/layers/shared/ui/command';

<CommandItem onSelect={handleNewSession}>
  <PlusIcon className="mr-2 h-4 w-4" />
  New Session
  <CommandShortcut>C</CommandShortcut>
</CommandItem>;
```

The `CommandShortcut` component in shadcn is simply:

```tsx
const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span
    className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
    {...props}
  />
);
```

**Multi-key shortcuts:**
For multi-key sequences like `⌘K` or `⌘⇧T`:

```tsx
<CommandShortcut>⌘K</CommandShortcut>   // Cmd+K
<CommandShortcut>⌘⇧T</CommandShortcut>  // Cmd+Shift+T
```

Use Unicode symbols: `⌘` (U+2318), `⇧` (U+21E7), `⌃` (U+2303), `⌥` (U+2325). Do NOT write "Cmd+K" — use the symbols.

**Shortcut display in the command palette educates users about shortcuts they can use without opening the palette.** This is the Superhuman pattern: by seeing `C` next to "New Session" every time they use the palette, users eventually internalize the shortcut and stop opening the palette for that action.

---

### 4. Centralized Shortcut Registry Pattern

A centralized registry is the architectural foundation that makes the `?` panel auto-generatable, prevents duplicate key registrations, and keeps documentation in sync with behavior.

**The registry shape:**

```typescript
// In a shared shortcut constants file, e.g., features/shortcuts/model/shortcut-registry.ts

export interface ShortcutDef {
  id: string; // unique identifier
  key: string; // the key combo e.g. "c", "mod+k", "?"
  label: string; // human readable e.g. "New Session"
  description?: string;
  group: ShortcutGroup; // category for the reference panel
  scope?: 'global' | 'session' | 'agent'; // where it's active
}

export type ShortcutGroup = 'sessions' | 'navigation' | 'agents' | 'global';

export const SHORTCUTS = {
  NEW_SESSION: {
    id: 'new-session',
    key: 'c',
    label: 'New Session',
    group: 'sessions',
    scope: 'global',
  },
  COMMAND_PALETTE: {
    id: 'command-palette',
    key: 'mod+k',
    label: 'Open Command Palette',
    group: 'navigation',
    scope: 'global',
  },
  SHORTCUTS_HELP: {
    id: 'shortcuts-help',
    key: '?',
    label: 'Keyboard Shortcuts',
    group: 'global',
    scope: 'global',
  },
  PULSE: {
    id: 'pulse',
    key: 'mod+p',
    label: 'Pulse Scheduler',
    group: 'navigation',
    scope: 'global',
  },
  // ...
} satisfies Record<string, ShortcutDef>;
```

**Auto-generating the reference panel from the registry:**

```typescript
// features/shortcuts/model/use-shortcuts-grouped.ts

import { SHORTCUTS, ShortcutGroup } from './shortcut-registry';

export function getShortcutsGrouped(): Record<ShortcutGroup, ShortcutDef[]> {
  const grouped: Partial<Record<ShortcutGroup, ShortcutDef[]>> = {};

  for (const shortcut of Object.values(SHORTCUTS)) {
    if (!grouped[shortcut.group]) {
      grouped[shortcut.group] = [];
    }
    grouped[shortcut.group]!.push(shortcut);
  }

  return grouped as Record<ShortcutGroup, ShortcutDef[]>;
}
```

The shortcuts panel renders directly from `getShortcutsGrouped()`. Any new shortcut added to `SHORTCUTS` automatically appears in the panel. No manual documentation update required.

**Registry benefits demonstrated by apps that use this pattern:**

- Linear uses a centralized shortcut system; when they added searchability to the `?` panel, the search ran over the same data that registered the shortcuts.
- GitHub's `hotkey` library uses `data-hotkey` attributes as a form of declarative registry — every element with `data-hotkey` is automatically queryable by the DOM.
- `react-keyhub` (a React library for this pattern) provides `<ShortcutSheet>` that auto-renders from the registry — the same data drives both the `useShortcut` hooks and the UI documentation.

**Recommended library: `react-hotkeys-hook`**

The most battle-tested React keyboard shortcut library (3.1M weekly downloads). Key features for DorkOS:

```typescript
import { useHotkeys } from 'react-hotkeys-hook';

// Basic usage — scope ensures shortcuts don't conflict across views
useHotkeys('c', () => createNewSession(), {
  enabled: !isAnyDialogOpen,
  scopes: ['session-view'],
  // enableOnFormTags: false (default) — does NOT fire in inputs
});

useHotkeys('mod+k', () => openCommandPalette(), {
  preventDefault: true,
  scopes: ['global'],
});

useHotkeys('?', () => toggleShortcutsPanel(), {
  scopes: ['global'],
});
```

The `enableOnFormTags: false` default means all shortcuts registered with `react-hotkeys-hook` are automatically suppressed in `INPUT`, `TEXTAREA`, and `SELECT` elements. This is the correct default.

For a full centralized registry pattern with `react-hotkeys-hook`, define the key combos once in `SHORTCUTS` and reference them:

```typescript
useHotkeys(SHORTCUTS.NEW_SESSION.key, handleNewSession, { scopes: ['global'] });
useHotkeys(SHORTCUTS.COMMAND_PALETTE.key, handleCommandPalette, { preventDefault: true });
```

This ties the behavior to the registry, so changing a key combo in `SHORTCUTS` propagates everywhere — the hook, the button hint, the command palette item, and the reference panel.

---

### 5. The `?` Key — Technical Details and Edge Cases

**How `?` is different from letter keys:**
`?` is `Shift+/` on US keyboards. Unlike letters, `?` has no modifier ambiguity — `e.key === '?'` directly catches it on both Mac and Windows regardless of whether you check for Shift. You do NOT need to check `e.shiftKey`.

**The input guard — the canonical implementation:**

All major apps use essentially the same guard. Here is the pattern derived from GitHub's `hotkey` library, `react-hotkeys-hook`, and `hotkeys-js`:

```typescript
function isInputFocused(): boolean {
  const target = document.activeElement as HTMLElement | null;
  if (!target) return false;

  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

// In the keyboard handler:
if (e.key === '?' && !isInputFocused()) {
  e.preventDefault();
  toggleShortcutsPanel();
}
```

**Why `?` specifically should NOT fire in inputs:**
When a user types `?` in a search box or chat input, they intend to type a question mark. The `?` shortcut must be suppressed whenever any text field is focused. This is the universal rule across all apps.

**`react-hotkeys-hook` handles this automatically** for shortcuts registered through it. For the `?` shortcut specifically, if you use `useHotkeys('?', ..., { enableOnFormTags: false })`, the library suppresses it when a form element is focused. The `enableOnFormTags: false` is the default.

**Content-editable elements:**
The chat input in DorkOS uses a content-editable area (the `textarea`-like message composer). Make sure `target.isContentEditable` is included in the guard. `react-hotkeys-hook` handles `contenteditable` by default.

**Is `?` the right key?**

Yes, unambiguously. Industry evidence:

- **Gmail** — `?` = show keyboard shortcuts (established 2010, widely copied)
- **GitHub** — `?` = context-sensitive shortcuts panel
- **Linear** — `?` = keyboard shortcuts panel
- **Slack** — `Cmd+/` on Mac (slightly different, but `?` is also supported in older builds)
- **Figma** — `Ctrl+Shift+?` (non-standard due to Figma's complexity)
- **Jira** — `?` = shortcuts
- **Twitter/X** — `?` = keyboard shortcuts
- **HackerNews** — no shortcuts, but `?` is the de-facto standard in HN communities

The only apps that deviate are native desktop apps (VS Code uses `F1` or `Cmd+Shift+P` for command palette; no dedicated `?` shortcut reference panel) and Electron apps that have their own help menus. For a **web app**, `?` is correct.

**What about `Ctrl+/`?** Some apps (Slack, Jira) use `Ctrl+/` as the shortcut reference. This is a valid alternative but is less discoverable since it requires a modifier key. `?` is more discoverable because it requires no modifier and is semantically intuitive (question mark = "what can I do?").

**Recommendation for DorkOS:** Use `?` as the primary trigger. Optionally also respond to `Ctrl+/` as a secondary alias for the same panel.

---

## Detailed Analysis

### Inline Button Shortcut Hints: The Width Problem

The most common implementation mistake is allowing the button to expand when the shortcut hint appears. This causes layout shift (elements below the button jump). The correct approach:

**Option A: Pre-allocated invisible slot (best)**
Reserve the right slot always. The shortcut `<kbd>` is in the DOM at all times but `opacity-0`. No layout shift.

```tsx
<button className="group flex min-w-[160px] items-center justify-between gap-2 px-3 py-1.5">
  <span>New Session</span>
  <kbd className="text-muted-foreground shrink-0 rounded border px-1 py-0.5 text-[10px] opacity-0 transition-opacity duration-150 group-hover:opacity-100">
    C
  </kbd>
</button>
```

`min-w-[160px]` ensures the button is always wide enough for the hint. `shrink-0` prevents the `kbd` from being squeezed when visible.

**Option B: Absolute positioning (no layout impact)**
The shortcut hint is positioned absolutely at the right edge of the button. The button's natural width is unaffected.

```tsx
<button className="group relative flex items-center px-3 py-1.5 pr-10">
  <span>New Session</span>
  <kbd className="text-muted-foreground absolute right-2 rounded border px-1 py-0.5 text-[10px] opacity-0 transition-opacity duration-150 group-hover:opacity-100">
    C
  </kbd>
</button>
```

`pr-10` provides padding on the right to prevent the button label from overlapping where the `kbd` will appear.

**When NOT to show inline hints:**

- Icon-only buttons: use a tooltip instead
- Mobile: don't show keyboard hints at all (no keyboard)
- Buttons in dense lists where every button has a hint: hints become visual noise. Limit inline hints to primary navigation items and the most important actions, not every button.

### The `<CommandShortcut>` in the Palette: Visual Hierarchy

Inside the command palette, shortcut hints serve a secondary educational purpose — the user is already using the keyboard (they opened the palette with `Cmd+K`). Seeing `C` next to "New Session" teaches them they can bypass the palette next time.

The `ml-auto` styling on `CommandShortcut` ensures it's always right-aligned regardless of the label length. Combined with `tracking-widest` and `text-muted-foreground`, it's visually subordinate but legible.

**Rule:** Only show shortcuts for items that have a _direct_ keyboard equivalent that works without the palette. Don't show a shortcut for "Delete Agent" if there's no standalone shortcut for deletion — this creates false expectations.

### Shortcut Registry: What the Registry Enables

A centralized registry is the architecture prerequisite for all other patterns:

| Feature                                              | Registry requirement                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| Reference panel auto-generated from registry         | `label`, `group` fields                           |
| Shortcut search in `?` panel                         | `label`, `description` fields (search over these) |
| Command palette hint display                         | `key` field                                       |
| Button hover hint display                            | `key` field                                       |
| Conflict detection at dev time                       | All registrations in one place                    |
| Scope isolation (shortcut active only in some views) | `scope` field                                     |
| Easy re-mapping                                      | Change `key` in one place, propagates everywhere  |

### What Apps Do NOT Have a Registry (and the consequences)

GitHub's `hotkey` library uses a declarative `data-hotkey` HTML attribute rather than a JS registry. This means the "registry" is implicit in the DOM — to enumerate all shortcuts, you query `document.querySelectorAll('[data-hotkey]')`. This works for GitHub's server-rendered pages (each page only has the shortcuts relevant to that context), but for a React SPA it's less ergonomic than an explicit registry.

VS Code uses a JSON-based keybinding registry (`keybindings.json`) that drives both the command palette display and the user-editable shortcuts. This is the gold standard for keybinding architecture, but it's also a full keybinding system with user overrides — overkill for DorkOS at this stage.

**For DorkOS:** A simple TypeScript object (`SHORTCUTS`) is the right starting point. It's queryable, type-safe, and can grow into a full user-configurable system later if needed.

---

## Implementation Recommendations for DorkOS

### Placement within FSD

```
layers/
├── shared/
│   └── model/
│       └── shortcut-registry.ts     # SHORTCUTS constant — the single source of truth

features/
├── shortcuts/
│   ├── ui/
│   │   ├── ShortcutsPanel.tsx       # The ? panel modal
│   │   ├── ShortcutRow.tsx          # A single shortcut row in the panel
│   │   └── ShortcutKbd.tsx          # Reusable <kbd> styling component
│   ├── model/
│   │   ├── use-shortcuts-panel.ts   # open/close state + ? key handler
│   │   └── use-shortcuts-grouped.ts # groups SHORTCUTS by category
│   └── index.ts
```

Mount `<ShortcutsPanel>` in `App.tsx` alongside the `<CommandPaletteDialog>`.

### The `ShortcutKbd` Reusable Component

This is used everywhere: inline button hints, command palette items, and the reference panel.

```tsx
// features/shortcuts/ui/ShortcutKbd.tsx
interface ShortcutKbdProps {
  keys: string; // e.g. "C", "⌘K", "⌘⇧T"
  className?: string;
}

export function ShortcutKbd({ keys, className }: ShortcutKbdProps) {
  return (
    <kbd
      className={cn(
        'border-border bg-muted inline-flex items-center rounded border',
        'text-muted-foreground px-1.5 py-0.5 font-mono text-[10px]',
        className
      )}
    >
      {keys}
    </kbd>
  );
}
```

### Priority Implementation Order

1. **`SHORTCUTS` registry constant** — define all key combos, labels, groups in one place. Zero runtime cost.
2. **Input guard utility** — `isInputFocused()` function in `shared/lib/`. Used by all shortcut handlers.
3. **`ShortcutKbd` component** — reusable `<kbd>` styling. Used in buttons, command palette, reference panel.
4. **Inline button hints** — add `<ShortcutKbd>` to sidebar navigation items and primary action buttons. Use Approach A (pre-allocated slot, opacity-0 → opacity-100).
5. **`<CommandShortcut>` in command palette items** — add shortcut hints to the most frequently used command palette items.
6. **`ShortcutsPanel`** — the `?` modal, auto-generated from `SHORTCUTS`, with search. Wire up `?` key handler.

---

## Sources & Evidence

- "Keyboard shortcuts are frequently used and loved by our power users" + `?` key trigger — [Keyboard shortcuts help – Linear Changelog](https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help) (2021)
- Linear's searchable shortcut panel: "redesigned its keyboard shortcuts help screen and made it searchable to get more users using keyboard shortcuts" — [Linear Changelog](https://linear.app/changelog/page/14)
- GitHub context-sensitive `?` panel: "Typing ? on GitHub brings up a dialog box that lists the keyboard shortcuts available for that page" — [GitHub Keyboard Shortcuts – GitHub Docs](https://docs.github.com/en/get-started/using-github/keyboard-shortcuts)
- GitHub `hotkey` library architecture — [Adding interactivity with GitHub's Hotkey library – LogRocket](https://blog.logrocket.com/adding-interactivity-githubs-hotkey-library/)
- Figma shortcut panel gamification (color-coded tried/untried shortcuts) — [How to design great keyboard shortcuts – Knock](https://knock.app/blog/how-to-design-great-keyboard-shortcuts)
- "every time a user hovers over a given affordance in your app, they're reminded of how they could perform that action without their hands leaving the keyboard" — [How to design great keyboard shortcuts – Knock](https://knock.app/blog/how-to-design-great-keyboard-shortcuts)
- Input guard pattern: `target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable` — [react-hotkeys-hook – DEV Community](https://dev.to/lalitkhu/implement-keyboard-shortcuts-in-your-react-app-475c)
- `react-hotkeys-hook` `enableOnFormTags` and `scopes` options — [useHotkeys API Docs](https://react-hotkeys-hook.vercel.app/docs/api/use-hotkeys)
- hotkeys-js input guard: "By default hotkeys are not enabled for INPUT SELECT TEXTAREA elements" — [hotkeys-js GitHub](https://github.com/jaywcjlove/hotkeys-js)
- React-Keyhub centralized registry + auto-generated ShortcutSheet — [React-Keyhub – DEV Community](https://dev.to/xenral/react-keyboard-shortcuts-boost-app-performance-using-react-keyhub-25co)
- `CommandShortcut` component — right-aligned keyboard hints in command palette — [shadcn/ui Command](https://ui.shadcn.com/docs/components/radix/command)
- "users can see hotkey maps by hitting a '?' key" best practice — [React Keyboard Shortcuts – Fullstack.com](https://www.fullstack.com/labs/resources/blog/keyboard-shortcuts-with-react-hooks)
- Tailwind `group-hover` pattern for revealing child elements — [Revealing hidden elements when hovering a parent – DEV Community](https://dev.to/mtownsend5512/revealing-hidden-elements-when-hovering-a-parent-with-tailwind-css-159a)
- `?` is the standard trigger: "You can start using keyboard shortcuts immediately by going to your favorite web app and typing a '?' to bring up the cheat sheet" — [Web Apps Have Keyboard Shortcuts – HowToGeek](https://www.howtogeek.com/211680/web-apps-have-keyboard-shortcuts-too-and-many-work-almost-everywhere/)
- Shortcut discoverability via tooltips and command bar — [How to design great keyboard shortcuts – Knock](https://knock.app/blog/how-to-design-great-keyboard-shortcuts)

---

## Research Gaps & Limitations

- The exact CSS/animation specifics of Linear's inline button shortcut hints were not publicly documented in any blog post or design system docs. The implementation in this report is derived from inspecting the interaction pattern described and from Tailwind group-hover conventions.
- Figma's shortcut panel gamification (color-coded tried/untried) is confirmed but not deeply documented. It is referenced as a best-in-class example but not reproducible from the research alone.
- No comparative data on whether users who see inline button hints actually convert to using keyboard shortcuts more. The Knock article asserts it but does not provide metrics.
- DorkOS-specific user testing on shortcut discoverability has not been done. These recommendations are based on industry patterns, not DorkOS usage data.

---

## Contradictions & Disputes

- **`?` vs `Ctrl+/`**: Both are used in production apps. `?` is more discoverable (no modifier, semantically obvious). `Ctrl+/` is safer for apps with many symbol-key conflicts. For DorkOS, `?` is correct — it does not conflict with any existing shortcuts.
- **Inline hints vs. tooltips**: Some UX researchers argue that inline hints clutter the interface for users who already know shortcuts. The counter-argument (Superhuman, Linear) is that the hints are only visible on hover, minimizing noise for power users while educating new users. The hover-only reveal is the resolution: the hints are invisible at rest.
- **Registry vs. scattered definitions**: Some teams argue a centralized registry adds ceremony for a simple app. This is true for apps with fewer than 10 shortcuts. For a developer tool like DorkOS with 15+ shortcuts, the registry is necessary to keep the `?` panel, command palette hints, and button hints synchronized.

---

## Search Methodology

- Searches performed: 18
- Most productive terms: "keyboard shortcuts reference panel ? key trigger", "centralized keyboard shortcut registry React", "react-keyhub ShortcutSheet", "GitHub hotkey library input guard", "Tailwind group-hover reveal hidden element", "Linear changelog keyboard shortcuts help"
- Primary information sources: Linear changelog, GitHub Docs, Knock engineering blog, react-hotkeys-hook docs, DEV Community, LogRocket, shadcn/ui docs, HowToGeek
