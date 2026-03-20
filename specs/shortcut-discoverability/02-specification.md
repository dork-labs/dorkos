---
slug: shortcut-discoverability
number: 118
created: 2026-03-11
status: specification
authors: [Claude Code]
ideation: specs/shortcut-discoverability/01-ideation.md
research: research/20260311_keyboard_shortcut_discoverability_ux.md
---

# Keyboard Shortcut Discoverability

## Status

Specification

## Overview

DorkOS currently has ~15 keyboard shortcuts scattered across 8 files with no centralization. Shortcuts are only discoverable via tooltips on 3 buttons. Platform detection (`isMac`) is duplicated 5 times. There is no shortcuts reference panel.

This spec adds four interlocking discoverability mechanisms:

1. **Centralized `SHORTCUTS` registry** — single source of truth for all shortcut definitions
2. **Inline button hints** — `Kbd` fades in on hover inside buttons (no tooltip, no layout shift)
3. **Command palette hints** — shortcut strings displayed right-aligned on feature items
4. **`?` shortcuts reference panel** — categorized modal listing all shortcuts, auto-generated from registry

Plus a foundational cleanup: extracting the duplicated `isMac` detection into `shared/lib/platform.ts`.

## Background / Problem Statement

Users have no way to discover keyboard shortcuts beyond hovering specific buttons. The `?` key convention (used by Linear, GitHub, Gmail, Figma, Jira) is absent. The command palette lists features but doesn't show their shortcuts. Shortcut key definitions are scattered across individual components, making maintenance error-prone.

## Goals

- Every shortcut in the app is discoverable without reading documentation
- A single registry drives all shortcut display surfaces (buttons, palette, reference panel)
- The `?` key opens a categorized shortcuts reference panel (industry standard)
- Hovering the "New session" button shows its shortcut inline (no tooltip)
- Command palette feature items show shortcut hints
- Duplicated `isMac` detection is eliminated

## Non-Goals

- Custom keybinding / remapping (user-configurable shortcuts)
- Searchable shortcuts panel (current ~15 shortcuts are easily scannable)
- Onboarding tours or first-use prompts for shortcuts
- Gamification (Figma-style "tried/untried" tracking)
- Adding new shortcuts (only documenting existing ones)
- Migrating existing `useEffect` handlers to a library like `react-hotkeys-hook`

## Technical Dependencies

- No new external dependencies
- Existing: React 19, Zustand, Tailwind CSS 4, shadcn/ui (Radix), motion/react, cmdk

## Detailed Design

### 1. Shared `isMac` Utility

**File:** `apps/client/src/layers/shared/lib/platform.ts` (existing file)

Add a module-level constant alongside the existing `PlatformAdapter`:

```typescript
/** Whether the current platform is macOS/iOS (used for shortcut display). */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
```

**Barrel export:** Add to `apps/client/src/layers/shared/lib/index.ts`:

```typescript
export { isMac } from './platform';
```

**Replacements** — remove inline `const isMac = ...` from:

| File                        | Current line                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `AgentSidebar.tsx`          | `const isMac = typeof navigator !== 'undefined' && /Mac\|iPhone\|iPad/.test(navigator.platform);` |
| `CommandPaletteTrigger.tsx` | `const isMac = typeof navigator !== 'undefined' && /Mac\|iPhone\|iPad/.test(navigator.platform);` |
| `App.tsx`                   | `const isMac = typeof navigator !== 'undefined' && /Mac\|iPhone\|iPad/.test(navigator.platform);` |
| `SidebarTabRow.tsx`         | `const isMac = typeof navigator !== 'undefined' && /Mac\|iPhone\|iPad/.test(navigator.platform);` |
| `PaletteFooter.tsx`         | `const isMac = typeof navigator !== 'undefined' && navigator.platform?.includes('Mac');`          |

Each file replaces with: `import { isMac } from '@/layers/shared/lib';`

Note: `PaletteFooter.tsx` uses a slightly different check (`.includes('Mac')` vs regex). Standardize on the regex pattern.

### 2. Centralized SHORTCUTS Registry

**New file:** `apps/client/src/layers/shared/lib/shortcuts.ts`

```typescript
import { isMac } from './platform';

/** Definition of a single keyboard shortcut. */
export interface ShortcutDef {
  /** Unique identifier. */
  id: string;
  /** Key combo in a normalized format (e.g., 'mod+shift+n', '?', 'mod+k'). */
  key: string;
  /** Human-readable label (e.g., 'New session'). */
  label: string;
  /** Category for the reference panel. */
  group: ShortcutGroup;
  /** Where the shortcut is active. Defaults to 'global'. */
  scope?: 'global' | 'sidebar';
}

/** Categories for grouping shortcuts in the reference panel. */
export type ShortcutGroup = 'sessions' | 'navigation' | 'chat' | 'global';

/** Group display order and labels. */
export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  navigation: 'Navigation',
  sessions: 'Sessions',
  chat: 'Chat',
  global: 'Global',
};

/** Display order for groups in the reference panel. */
export const SHORTCUT_GROUP_ORDER: ShortcutGroup[] = ['navigation', 'sessions', 'chat', 'global'];
```

**The `SHORTCUTS` constant** — all existing shortcuts:

```typescript
export const SHORTCUTS = {
  // Navigation
  COMMAND_PALETTE: {
    id: 'command-palette',
    key: 'mod+k',
    label: 'Command palette',
    group: 'navigation',
  },
  TOGGLE_SIDEBAR: {
    id: 'toggle-sidebar',
    key: 'mod+b',
    label: 'Toggle sidebar',
    group: 'navigation',
  },
  SHORTCUTS_PANEL: {
    id: 'shortcuts-panel',
    key: '?',
    label: 'Keyboard shortcuts',
    group: 'navigation',
  },

  // Sessions
  NEW_SESSION: { id: 'new-session', key: 'mod+shift+n', label: 'New session', group: 'sessions' },
  TAB_SESSIONS: {
    id: 'tab-sessions',
    key: 'mod+1',
    label: 'Sessions tab',
    group: 'sessions',
    scope: 'sidebar',
  },
  TAB_SCHEDULES: {
    id: 'tab-schedules',
    key: 'mod+2',
    label: 'Schedules tab',
    group: 'sessions',
    scope: 'sidebar',
  },
  TAB_CONNECTIONS: {
    id: 'tab-connections',
    key: 'mod+3',
    label: 'Connections tab',
    group: 'sessions',
    scope: 'sidebar',
  },

  // Chat (interactive tool shortcuts)
  APPROVE_TOOL: { id: 'approve-tool', key: 'enter', label: 'Approve tool', group: 'chat' },
  DENY_TOOL: { id: 'deny-tool', key: 'esc', label: 'Deny tool', group: 'chat' },
  TOGGLE_OPTION: { id: 'toggle-option', key: '1-9', label: 'Toggle option', group: 'chat' },
  SUBMIT_ANSWER: { id: 'submit-answer', key: 'enter', label: 'Submit answer', group: 'chat' },

  // Global
  CLOSE_OVERLAY: { id: 'close-overlay', key: 'esc', label: 'Close overlay', group: 'global' },
} as const satisfies Record<string, ShortcutDef>;
```

**Helper: `formatShortcutKey`** — converts normalized key to platform display string:

```typescript
/**
 * Convert a normalized key string to a platform-appropriate display string.
 *
 * @param def - Shortcut definition (or just a key string)
 * @returns Display string like '⇧⌘N' (Mac) or 'Ctrl+Shift+N' (Windows)
 */
export function formatShortcutKey(def: ShortcutDef | string): string {
  const key = typeof def === 'string' ? def : def.key;

  if (isMac) {
    return key
      .replace('mod+', '⌘')
      .replace('shift+', '⇧')
      .replace('alt+', '⌥')
      .replace('ctrl+', '⌃')
      .toUpperCase();
  }

  return key
    .replace('mod+', 'Ctrl+')
    .replace('shift+', 'Shift+')
    .replace('alt+', 'Alt+')
    .toUpperCase();
}
```

**Helper: `getShortcutsGrouped`** — groups shortcuts by category for the reference panel:

```typescript
/** Group all shortcuts by their category, in display order. */
export function getShortcutsGrouped(): {
  group: ShortcutGroup;
  label: string;
  shortcuts: ShortcutDef[];
}[] {
  const map = new Map<ShortcutGroup, ShortcutDef[]>();

  for (const shortcut of Object.values(SHORTCUTS)) {
    const list = map.get(shortcut.group) ?? [];
    list.push(shortcut);
    map.set(shortcut.group, list);
  }

  return SHORTCUT_GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
    group: g,
    label: SHORTCUT_GROUP_LABELS[g],
    shortcuts: map.get(g)!,
  }));
}
```

**Barrel export:** Add to `shared/lib/index.ts`:

```typescript
export {
  SHORTCUTS,
  SHORTCUT_GROUP_LABELS,
  SHORTCUT_GROUP_ORDER,
  formatShortcutKey,
  getShortcutsGrouped,
  type ShortcutDef,
  type ShortcutGroup,
} from './shortcuts';
```

### 3. Inline Button Hint (New Session Button)

**File:** `apps/client/src/layers/features/session-list/ui/AgentSidebar.tsx`

Replace the current Tooltip-wrapped button:

```tsx
{
  /* BEFORE — tooltip pattern */
}
<Tooltip>
  <TooltipTrigger asChild>
    <SidebarMenuButton onClick={handleNewSession} className="...">
      <Plus /> New session
    </SidebarMenuButton>
  </TooltipTrigger>
  <TooltipContent side="right">
    New session <Kbd>{isMac ? '⇧⌘N' : 'Ctrl+Shift+N'}</Kbd>
  </TooltipContent>
</Tooltip>;
```

With an inline hint:

```tsx
{
  /* AFTER — inline hint pattern */
}
<SidebarMenuButton
  onClick={handleNewSession}
  className="group border-border text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center justify-between gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98] disabled:opacity-50"
>
  <span className="flex items-center gap-1.5">
    <Plus className="size-(--size-icon-sm)" />
    New session
  </span>
  <Kbd className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
    {formatShortcutKey(SHORTCUTS.NEW_SESSION)}
  </Kbd>
</SidebarMenuButton>;
```

Key changes:

- Remove `Tooltip`/`TooltipTrigger`/`TooltipContent` wrapper
- Remove `Tooltip`, `TooltipTrigger`, `TooltipContent` imports (if no longer used elsewhere in file)
- Add `group` to button className (enables `group-hover` on children)
- Change `justify-center` → `justify-between` (label left, kbd right)
- Wrap icon+label in a `<span>` flex container
- Add `Kbd` with `opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0`
- Import `formatShortcutKey`, `SHORTCUTS` from `@/layers/shared/lib`
- Replace local `isMac` with shared import

### 4. Command Palette Shortcut Hints

**File:** `apps/client/src/layers/features/command-palette/model/use-palette-items.ts`

Populate the `shortcut` field on feature items:

```typescript
import { formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';

const FEATURES: FeatureItem[] = [
  { id: 'pulse', label: 'Pulse Scheduler', icon: 'Clock', action: 'openPulse' },
  { id: 'relay', label: 'Relay Messaging', icon: 'Radio', action: 'openRelay' },
  { id: 'mesh', label: 'Mesh Network', icon: 'Globe', action: 'openMesh' },
  { id: 'settings', label: 'Settings', icon: 'Settings', action: 'openSettings' },
];
```

Note: These features don't currently have dedicated shortcuts (no `Cmd+P` for Pulse, etc.). Only add `shortcut` to features that actually have keybindings. Since none of the current feature items have global shortcuts, this becomes a data-readiness improvement — when shortcuts are added for these features in the future, populating the `shortcut` field will automatically show hints in the palette.

For now, the infrastructure is ready but no `shortcut` values are added to FEATURES. The `CommandPaletteDialog.tsx` already renders `f.shortcut` when present (lines 477-481).

### 5. `?` Shortcuts Reference Panel

#### 5a. Zustand State

**File:** `apps/client/src/layers/shared/model/app-store.ts`

Add to `AppState` interface (alongside existing dialog state):

```typescript
shortcutsPanelOpen: boolean;
setShortcutsPanelOpen: (open: boolean) => void;
toggleShortcutsPanel: () => void;
```

Add to store implementation:

```typescript
shortcutsPanelOpen: false,
setShortcutsPanelOpen: (open) => set({ shortcutsPanelOpen: open }),
toggleShortcutsPanel: () => set((s) => ({ shortcutsPanelOpen: !s.shortcutsPanelOpen })),
```

#### 5b. `?` Key Handler Hook

**New file:** `apps/client/src/layers/features/shortcuts/model/use-shortcuts-panel.ts`

```typescript
import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/**
 * Register the `?` key handler that toggles the shortcuts reference panel.
 *
 * Guards against firing in text inputs (INPUT, TEXTAREA, contentEditable).
 * The `?` key is `Shift+/` — `e.key === '?'` captures it without checking shiftKey.
 */
export function useShortcutsPanel(): void {
  const toggleShortcutsPanel = useAppStore((s) => s.toggleShortcutsPanel);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.key === '?' && !inInput) {
        e.preventDefault();
        toggleShortcutsPanel();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleShortcutsPanel]);
}
```

Pattern follows `use-global-palette.ts` exactly: `useEffect` + `document.addEventListener('keydown')` + cleanup.

#### 5c. ShortcutsPanel Component

**New file:** `apps/client/src/layers/features/shortcuts/ui/ShortcutsPanel.tsx`

```tsx
import { useAppStore } from '@/layers/shared/model';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogBody,
  Kbd,
} from '@/layers/shared/ui';
import { getShortcutsGrouped, formatShortcutKey } from '@/layers/shared/lib';

/** Modal listing all keyboard shortcuts grouped by category. */
export function ShortcutsPanel() {
  const open = useAppStore((s) => s.shortcutsPanelOpen);
  const setOpen = useAppStore((s) => s.setShortcutsPanelOpen);
  const groups = getShortcutsGrouped();

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Keyboard Shortcuts</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-6">
          {groups.map(({ group, label, shortcuts }) => (
            <div key={group}>
              <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
                {label}
              </h3>
              <div className="space-y-1">
                {shortcuts.map((s) => (
                  <div key={s.id} className="flex items-center justify-between py-1.5 text-sm">
                    <span>{s.label}</span>
                    <Kbd>{formatShortcutKey(s)}</Kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

Design:

- `sm:max-w-md` (448px) — compact, scannable
- Group headers: uppercase, muted, small, with tracking
- Each row: label left, `Kbd` right
- Uses `ResponsiveDialog` — Dialog on desktop, Drawer on mobile
- Dismiss: Escape (built into Dialog), click outside (built into Dialog), `?` again (toggle via hook)

#### 5d. Feature Module Barrel

**New file:** `apps/client/src/layers/features/shortcuts/index.ts`

```typescript
/**
 * Shortcuts feature — `?` reference panel and keyboard shortcut discoverability.
 *
 * @module features/shortcuts
 */
export { ShortcutsPanel } from './ui/ShortcutsPanel';
export { useShortcutsPanel } from './model/use-shortcuts-panel';
```

#### 5e. Mount in App.tsx

**File:** `apps/client/src/layers/app/App.tsx`

```typescript
import { ShortcutsPanel, useShortcutsPanel } from '@/layers/features/shortcuts';

// Inside App component:
useShortcutsPanel(); // Register ? key handler

// In JSX (alongside CommandPaletteDialog):
<ShortcutsPanel />
```

### 6. Documentation Update

**File:** `contributing/keyboard-shortcuts.md`

Add to the Navigation shortcuts table:

```markdown
| `?` | Open keyboard shortcuts panel |
```

Add a new section documenting the registry:

```markdown
### Shortcut Registry

All shortcuts are defined in `apps/client/src/layers/shared/lib/shortcuts.ts` as a centralized `SHORTCUTS` constant. Adding a new shortcut to the registry automatically makes it appear in:

- The `?` shortcuts reference panel
- The command palette (if a feature item references it)
- Inline button hints (if the button uses `formatShortcutKey`)

The registry is the single source of truth. Do not define shortcut display strings inline.
```

## User Experience

### Discovery Flow

1. **Passive discovery (hover):** User hovers the "New session" button → sees `⇧⌘N` fade in on the right side of the button
2. **Active discovery (palette):** User opens `Cmd+K` → sees shortcut hints next to feature items (when populated)
3. **Reference lookup (`?`):** User presses `?` → modal appears with all shortcuts categorized by function
4. **Dismiss:** `?` again, `Escape`, or click outside closes the panel

### Inline Hint Behavior

- Hint appears as `opacity-0 → opacity-100` transition (150ms) on group-hover
- No layout shift — the `Kbd` element is always in the DOM, just invisible
- Hidden on mobile (`Kbd` component has `hidden md:inline-flex`)
- `pointer-events-none` on `Kbd` prevents interference with button click

### `?` Panel Behavior

- Opens as centered dialog on desktop, bottom drawer on mobile
- Categories: Navigation, Sessions, Chat, Global
- Each row: human-readable label on left, platform-appropriate key on right
- Toggle semantics: pressing `?` again closes it

## Testing Strategy

### Unit Tests

**`shared/lib/__tests__/shortcuts.test.ts`:**

- `formatShortcutKey` returns correct Mac symbols (`⇧⌘N`) when `isMac` is true
- `formatShortcutKey` returns correct Windows strings (`Ctrl+Shift+N`) when `isMac` is false
- `getShortcutsGrouped` returns all groups in the correct order
- `getShortcutsGrouped` includes all shortcuts from the registry
- Every shortcut in `SHORTCUTS` has a non-empty `id`, `key`, `label`, and `group`

**`features/shortcuts/__tests__/use-shortcuts-panel.test.ts`:**

- Pressing `?` toggles `shortcutsPanelOpen` in the store
- Pressing `?` while an input is focused does NOT toggle the panel
- Pressing `?` while a textarea is focused does NOT toggle the panel
- Pressing `?` while a contentEditable element is focused does NOT toggle the panel

**`features/shortcuts/__tests__/ShortcutsPanel.test.tsx`:**

- Renders all shortcut groups when open
- Each shortcut row displays label and formatted key
- Does not render when `shortcutsPanelOpen` is false

### Mocking Strategy

- Mock `isMac` by mocking `@/layers/shared/lib/platform` module
- Mock Zustand store using `useAppStore.setState()` (existing pattern in codebase)
- Use `@testing-library/react` + `@testing-library/user-event` for keyboard event tests

## Performance Considerations

- `SHORTCUTS` constant and `SHORTCUT_GROUP_ORDER` are module-level — zero runtime cost
- `getShortcutsGrouped()` iterates ~15 entries — negligible
- `formatShortcutKey()` does string replacements — negligible
- `ShortcutsPanel` is lazy: only renders content when `open` is true (Dialog handles this)
- The `?` key handler is a single `keydown` listener on `document` — same cost as existing `Cmd+K` handler

## Security Considerations

None. This feature is entirely client-side UI with no data persistence, network requests, or user input processing.

## Implementation Phases

### Phase 1: Foundation

1. Add `isMac` to `shared/lib/platform.ts` and barrel
2. Create `shared/lib/shortcuts.ts` with `SHORTCUTS`, `formatShortcutKey`, `getShortcutsGrouped`
3. Replace 5 duplicated `isMac` definitions with shared import
4. Add `shortcutsPanelOpen` state to Zustand app-store

### Phase 2: Inline Hints

5. Modify "New session" button in `AgentSidebar.tsx` — remove tooltip, add inline `Kbd` with group-hover fade
6. Verify no layout shift on hover

### Phase 3: Shortcuts Panel

7. Create `features/shortcuts/model/use-shortcuts-panel.ts` — `?` key handler
8. Create `features/shortcuts/ui/ShortcutsPanel.tsx` — categorized modal
9. Create `features/shortcuts/index.ts` barrel
10. Mount `useShortcutsPanel()` + `<ShortcutsPanel />` in `App.tsx`

### Phase 4: Polish & Docs

11. Update `contributing/keyboard-shortcuts.md` with `?` shortcut and registry docs
12. Write unit tests for `formatShortcutKey`, `getShortcutsGrouped`, `useShortcutsPanel`, `ShortcutsPanel`
13. Run `pnpm typecheck` and `pnpm lint`

## Open Questions

None — all decisions were resolved during ideation.

## Related ADRs

- ADR-0107: CSS Hidden Toggle for Sidebar View Persistence (sidebar tab switching context)

## References

- Ideation: `specs/shortcut-discoverability/01-ideation.md`
- Research: `research/20260311_keyboard_shortcut_discoverability_ux.md`
- Prior research: `research/20260311_keyboard_shortcuts_new_item_web_apps.md`
- Contributing guide: `contributing/keyboard-shortcuts.md`
- Industry precedent: Linear `?` panel, GitHub context-sensitive `?` panel, Gmail `?` shortcuts

## Files Summary

### New Files (3)

| File                                                     | Purpose                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `layers/shared/lib/shortcuts.ts`                         | SHORTCUTS registry, formatShortcutKey, getShortcutsGrouped |
| `layers/features/shortcuts/ui/ShortcutsPanel.tsx`        | `?` reference panel modal                                  |
| `layers/features/shortcuts/model/use-shortcuts-panel.ts` | `?` key handler hook                                       |
| `layers/features/shortcuts/index.ts`                     | Feature barrel                                             |

### Modified Files (9)

| File                                                   | Change                                            |
| ------------------------------------------------------ | ------------------------------------------------- |
| `layers/shared/lib/platform.ts`                        | Add `isMac` export                                |
| `layers/shared/lib/index.ts`                           | Re-export `isMac`, shortcuts utilities            |
| `layers/shared/model/app-store.ts`                     | Add `shortcutsPanelOpen` state                    |
| `layers/features/session-list/ui/AgentSidebar.tsx`     | Inline Kbd hint, remove tooltip, use shared isMac |
| `layers/features/top-nav/ui/CommandPaletteTrigger.tsx` | Use shared isMac                                  |
| `layers/features/session-list/ui/SidebarTabRow.tsx`    | Use shared isMac                                  |
| `layers/features/command-palette/ui/PaletteFooter.tsx` | Use shared isMac                                  |
| `layers/app/App.tsx`                                   | Mount ShortcutsPanel, use shared isMac            |
| `contributing/keyboard-shortcuts.md`                   | Add `?` shortcut, document registry               |
