---
title: "Switch Agent via Identity Chip — Command Palette Pre-filtering API & Sidebar Cleanup"
date: 2026-03-10
type: implementation
status: active
tags: [command-palette, cmdk, zustand, agent-switcher, top-nav, sidebar, identity-chip, pre-filter]
feature_slug: switch-agent-via-identity-chip
searches_performed: 0
sources_count: 6
---

# Switch Agent via Identity Chip — Command Palette Pre-filtering API & Sidebar Cleanup

## Research Summary

The codebase already has a fully-featured command palette (`features/command-palette`), a Zustand `app-store`, and an `AgentIdentityChip` in the top nav header. No new API endpoints, libraries, or Zustand state slices are needed beyond one targeted addition: a `globalPaletteInitialSearch` string field in `app-store`, with a paired `openGlobalPaletteWithSearch(text: string)` action. The `CommandPaletteDialog` already reads from `useAppStore` and manages its own `search` state internally — the only change needed is for it to consume the initial search value on open and then clear it. All three competing approaches (Zustand store action, custom event, ref/imperative handle) were evaluated against this existing architecture; the Zustand store action is the clear winner given DorkOS's patterns.

---

## Key Findings

### 1. Existing Architecture — What Is Already In Place

**`app-store.ts`** (`layers/shared/model/app-store.ts`) already has:
- `globalPaletteOpen: boolean` + `setGlobalPaletteOpen(open: boolean)` + `toggleGlobalPalette()`
- A consistent pattern: all dialogs (`pulseOpen`, `relayOpen`, `meshOpen`, `settingsOpen`, `agentDialogOpen`) are controlled via Zustand booleans with setter actions.

**`CommandPaletteDialog.tsx`** already:
- Reads `globalPaletteOpen` from the store via `useGlobalPalette()`
- Manages `search` state locally with `useState('')`
- Resets `search` to `''` in `closePalette()` and on `handleOpenChange(false)`
- Stagger key is bumped on `handleOpenChange(true)` — the right place to also consume the initial search

**`AgentIdentityChip.tsx`** currently calls `setAgentDialogOpen(true)` on click. The task requires redirecting this to open the command palette pre-filtered to `@`.

**`AgentHeader.tsx`** (sidebar) already has:
- A CWD path button (using `setPickerOpen`)
- A `K Switch` button that calls `setGlobalPaletteOpen(true)` with no pre-filtering

**The `@` prefix** is already fully implemented in `CommandPaletteDialog`. When `search` starts with `@`, `isAtMode` becomes true and only the All Agents group is shown. Inserting `"@"` as the initial search value is all that's needed to land in agent-only mode immediately.

### 2. Approach Comparison

**Approach 1: Zustand store action — `openGlobalPaletteWithSearch(text: string)`**

Add two fields to `app-store.ts`:
```typescript
globalPaletteInitialSearch: string;
openGlobalPaletteWithSearch: (text: string) => void;
```

Implementation:
```typescript
globalPaletteInitialSearch: '',
openGlobalPaletteWithSearch: (text) =>
  set({ globalPaletteOpen: true, globalPaletteInitialSearch: text }),
```

In `CommandPaletteDialog.tsx`, inside `handleOpenChange`:
```typescript
const globalPaletteInitialSearch = useAppStore((s) => s.globalPaletteInitialSearch);
const clearPaletteInitialSearch = useAppStore((s) => s.clearPaletteInitialSearch);

const handleOpenChange = useCallback(
  (open: boolean) => {
    setGlobalPaletteOpen(open);
    if (open) {
      if (globalPaletteInitialSearch) {
        setSearch(globalPaletteInitialSearch);
        clearPaletteInitialSearch();
      }
      setStaggerKey((k) => k + 1);
    } else {
      setSearch('');
      setSelectedValue('');
      setPages([]);
      setSubMenuAgent(null);
    }
  },
  [setGlobalPaletteOpen, globalPaletteInitialSearch, clearPaletteInitialSearch],
);
```

Pros:
- Matches every existing DorkOS pattern. All dialog open/close state lives in `app-store`. `AgentIdentityChip` already consumes `useAppStore`. Zero new dependencies.
- Synchronous, co-located with the other `globalPaletteOpen` actions.
- Straightforward to test: mock `openGlobalPaletteWithSearch` and assert `globalPaletteOpen === true` and `globalPaletteInitialSearch === '@'`.
- Any component anywhere in the tree can trigger a pre-filtered open without needing a ref or event channel.

Cons:
- Adds two more fields to an already large `app-store` (~135 lines). Acceptable since the store already has this exact pattern for every dialog.

**Approach 2: Custom event — `document.dispatchEvent(new CustomEvent('open-palette', { detail: { search: '@' } }))`**

The palette listens with `document.addEventListener('open-palette', ...)`.

Pros:
- No store changes needed.
- Works across iframes (Obsidian plugin) without prop drilling.

Cons:
- Breaks the DorkOS convention that all cross-component communication uses Zustand (see `app-store.ts` — every dialog is store-driven, none uses custom events).
- Custom events are harder to test — they require a real `document` in jsdom, and asserting dispatch+listen behavior is more brittle than store assertions.
- No TypeScript enforcement on the event payload shape. `CustomEvent<{ search: string }>` works but is less ergonomic than a typed Zustand action.
- The existing `use-global-palette.ts` keyboard handler already calls `toggleGlobalPalette()` from the store — mixing two paradigms (store + events) for the same piece of state would be confusing.

**Approach 3: Ref / imperative handle — `useImperativeHandle` on `CommandPaletteDialog`**

Expose `{ open: (initialSearch?: string) => void }` via a `ref` forwarded to `CommandPaletteDialog`.

Pros:
- Explicitly imperative — the caller has direct control.
- No store changes.

Cons:
- `CommandPaletteDialog` is mounted at the `app` layer in `App.tsx` and is not imported as a component that callers typically hold a ref to.
- `AgentIdentityChip` (in `features/top-nav`) cannot hold a ref to `CommandPaletteDialog` (in `features/command-palette`) without violating the FSD rule that features cannot import from other features' model/hooks. Even if a ref were passed down via props, this creates a tight coupling.
- React refs work poorly with components that use `AnimatePresence` and conditional rendering — the ref would be null when the dialog is closed.
- Does not fit DorkOS's architecture at all. The entire codebase uses Zustand for cross-feature communication.

**Verdict: Approach 1 is correct.**

### 3. Exact Changes Required

#### `app-store.ts` — Two additions to the interface and implementation

```typescript
// In interface AppState:
globalPaletteInitialSearch: string;
openGlobalPaletteWithSearch: (text: string) => void;
clearPaletteInitialSearch: () => void;

// In useAppStore create():
globalPaletteInitialSearch: '',
openGlobalPaletteWithSearch: (text) =>
  set({ globalPaletteOpen: true, globalPaletteInitialSearch: text }),
clearPaletteInitialSearch: () => set({ globalPaletteInitialSearch: '' }),
```

#### `CommandPaletteDialog.tsx` — Consume initial search on open

The `handleOpenChange` callback already runs when the dialog opens. Add consumption of `globalPaletteInitialSearch` there:

```typescript
const globalPaletteInitialSearch = useAppStore((s) => s.globalPaletteInitialSearch);
const clearPaletteInitialSearch = useAppStore((s) => s.clearPaletteInitialSearch);

const handleOpenChange = useCallback(
  (open: boolean) => {
    setGlobalPaletteOpen(open);
    if (open) {
      // Consume any initial search text (e.g. "@" from AgentIdentityChip click)
      if (globalPaletteInitialSearch) {
        setSearch(globalPaletteInitialSearch);
        clearPaletteInitialSearch();
      }
      setStaggerKey((k) => k + 1);
    } else {
      setSearch('');
      setSelectedValue('');
      setPages([]);
      setSubMenuAgent(null);
    }
  },
  [setGlobalPaletteOpen, globalPaletteInitialSearch, clearPaletteInitialSearch],
);
```

Also update `closePalette` to clear initial search on explicit close (defensive):
```typescript
const closePalette = useCallback(() => {
  setGlobalPaletteOpen(false);
  setSearch('');
  setSelectedValue('');
  setPages([]);
  setSubMenuAgent(null);
  clearPaletteInitialSearch();
}, [setGlobalPaletteOpen, clearPaletteInitialSearch]);
```

#### `AgentIdentityChip.tsx` — Change click action

Replace `setAgentDialogOpen(true)` with `openGlobalPaletteWithSearch('@')`:

```typescript
// Before:
const setAgentDialogOpen = useAppStore((s) => s.setAgentDialogOpen);
// onClick: () => setAgentDialogOpen(true)

// After:
const openGlobalPaletteWithSearch = useAppStore((s) => s.openGlobalPaletteWithSearch);
// onClick: () => openGlobalPaletteWithSearch('@')
```

Update tooltip: `"Agent settings"` → `"Switch agent"` (since the action now opens the command palette, not the agent dialog). Update `aria-label` accordingly.

### 4. Sidebar Cleanup — Specific Changes

The task calls for:
- **Remove CWD display** from the sidebar `AgentHeader`
- **Remove "Switch" button** from `AgentHeader`
- **Add "Edit Agent" button** to `AgentHeader`

Looking at `AgentHeader.tsx`:

**Current structure (agent registered state):**
```
[FolderOpen] ~/projects/my-api    ← CWD button (calls onOpenPicker)
[K] Switch                         ← calls setGlobalPaletteOpen(true)
```

**Target structure:**
```
[Pencil] Edit Agent                ← calls onOpenAgentDialog
```

The CWD path is already visible in the top-nav header via `AgentIdentityChip` and the breadcrumb in the command palette. Removing it from the sidebar reduces redundancy.

The "K Switch" label is confusing — Cmd+K (not just K) opens the palette. The identity chip in the header is now the primary agent-switch affordance.

The "Edit Agent" button should be a compact `SidebarMenuButton`-style row with a `Pencil` or `Settings2` icon (consistent with DorkOS icon usage of lucide-react).

**Revised `AgentHeader.tsx` agent-registered branch:**
```tsx
if (agent) {
  return (
    <div className="px-2 py-2">
      <button
        onClick={onOpenAgentDialog}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors duration-150"
        aria-label="Edit agent settings"
      >
        <Pencil className="size-(--size-icon-sm) shrink-0" />
        <span>Edit agent</span>
      </button>
    </div>
  );
}
```

For the **unregistered directory** branch, remove CWD and the Switch button but keep the "+Agent" CTA:
```tsx
return (
  <div className="px-2 py-2">
    <button
      onClick={handleQuickCreate}
      disabled={createAgent.isPending}
      className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors duration-150 disabled:opacity-50"
      aria-label="Create agent for this directory"
    >
      <Plus className="size-(--size-icon-sm) shrink-0" />
      <span>Create agent</span>
    </button>
  </div>
);
```

Note: `AgentHeader` receives `onOpenAgentDialog` already as a prop from `SessionSidebar` — no prop signature changes needed.

### 5. `useGlobalPalette` Hook — No Changes Needed

The keyboard handler in `use-global-palette.ts` calls `toggleGlobalPalette()` which does not set `globalPaletteInitialSearch`. This is correct: Cmd+K should open the palette in the default zero-query state, not pre-filtered. Only `openGlobalPaletteWithSearch('@')` from the chip click sets the initial search.

### 6. `AgentHeader` Still Uses `setGlobalPaletteOpen` — Remove It

After removing the "Switch" button, `AgentHeader` no longer needs `setGlobalPaletteOpen`. Remove that import from `useAppStore`. The `handleOpenPalette` function and its `setGlobalPaletteOpen` selector can be deleted.

---

## Detailed Analysis

### Why `"@"` Is the Right Initial Search Value

The `@` prefix mode is already fully implemented in `CommandPaletteDialog`:

```typescript
const isAtMode = prefix === '@'; // from usePaletteSearch
```

When `isAtMode` is true:
- Features group is hidden
- Commands group is hidden
- Quick Actions group is hidden
- "All Agents" group is shown with all registered agents
- `CommandInput` placeholder remains "Search agents, features, commands..." — this is fine since the input already has `@` typed in it

Inserting `"@"` as the initial search string gives the user the full agent list immediately, with the ability to continue typing to filter. This matches the VS Code/GitHub pattern of prefix-scoped modes.

### Stagger Animation Interaction

`staggerKey` is incremented in `handleOpenChange(true)` to re-trigger the stagger entrance. When `globalPaletteInitialSearch` is `"@"`, `setSearch('@')` is called in the same `handleOpenChange` callback. Since both happen synchronously in the same state batch, the stagger will fire with the `@`-filtered agent list already visible — this is the correct behavior. No special animation handling is needed.

### `closePalette` and `handleOpenChange` — Clearing Initial Search

The `clearPaletteInitialSearch()` call in `handleOpenChange(open)` runs when `open === true`, immediately after consuming the value. This ensures the initial search is a one-shot: if the user opens the palette again via Cmd+K (which calls `toggleGlobalPalette()`, not `openGlobalPaletteWithSearch()`), `globalPaletteInitialSearch` will be `''` and no pre-filling occurs.

The defensive `clearPaletteInitialSearch()` in `closePalette` handles the edge case where the dialog is closed before `handleOpenChange(true)` fires (unlikely but safe).

### FSD Compliance

All changes are FSD-compliant:
- `app-store.ts` is in `layers/shared/model` — accessible to all layers.
- `AgentIdentityChip` is in `features/top-nav` — already imports from `layers/shared/model`, no new cross-feature imports.
- `CommandPaletteDialog` is in `features/command-palette` — already imports from `layers/shared/model`.
- `AgentHeader` is in `features/session-list` — already imports from `layers/shared/model`.

No FSD violations introduced.

### `app-store.ts` File Size

The store is currently ~426 lines, already above the 300-line "consider splitting" threshold but below 500. Adding 3 lines to the interface and 3 lines to the implementation will not push it to a level requiring a split, and the additions follow the exact existing pattern.

---

## Potential Solutions

### Solution A: Zustand `openGlobalPaletteWithSearch` action (RECOMMENDED)

**Files changed:** `app-store.ts`, `CommandPaletteDialog.tsx`, `AgentIdentityChip.tsx`, `AgentHeader.tsx`

**Store additions:**
```typescript
// interface AppState
globalPaletteInitialSearch: string;
openGlobalPaletteWithSearch: (text: string) => void;
clearPaletteInitialSearch: () => void;
```

**`AgentIdentityChip` change:** `setAgentDialogOpen(true)` → `openGlobalPaletteWithSearch('@')`

**`CommandPaletteDialog` change:** In `handleOpenChange(true)`, read and apply `globalPaletteInitialSearch`, then call `clearPaletteInitialSearch()`.

**`AgentHeader` change:** Remove CWD button, remove Switch button, add Edit Agent button calling `onOpenAgentDialog`.

### Solution B: Custom DOM event

Dispatches `'open-palette'` from chip; listener in `use-global-palette.ts`. Not recommended — breaks store-first convention.

### Solution C: Ref / imperative handle

Not viable — FSD cross-feature ref passing, breaks with `AnimatePresence`, doesn't fit DorkOS architecture.

---

## Security / Performance Considerations

- **No performance implications.** `globalPaletteInitialSearch` is a string that is read once on palette open and cleared. No renders are triggered outside the palette dialog itself.
- **No security implications.** The initial search value is always a hardcoded string (`"@"`) set by a click handler in the same app — it never comes from user input or external data.
- **Selector granularity.** Adding `openGlobalPaletteWithSearch` as a selector in `AgentIdentityChip` with `useAppStore((s) => s.openGlobalPaletteWithSearch)` follows the existing pattern (each selector is a separate `useAppStore` call for minimal re-renders). This is consistent with how `CommandPaletteTrigger` already selects `setGlobalPaletteOpen`.

---

## Recommendation

**Use Solution A: Zustand `openGlobalPaletteWithSearch` action.**

Rationale:
1. It's the only approach consistent with DorkOS's existing pattern for all dialog open/close state.
2. It requires no new libraries, no new React patterns, and no FSD violations.
3. The `"@"` prefix mode is already fully implemented in `CommandPaletteDialog` — the only gap is setting the initial `search` value on open.
4. The implementation is small: ~6 lines in `app-store`, ~5 lines in `CommandPaletteDialog`, ~2 line change in `AgentIdentityChip`.
5. Easy to test: assert `openGlobalPaletteWithSearch('@')` is called on chip click, and assert `setSearch` is called with `'@'` in `handleOpenChange`.

**Sidebar cleanup recommendation:**
- Remove CWD path from `AgentHeader` — it's redundant with the status bar and the command palette preview panel.
- Remove "K Switch" button — it was the only reason to have `setGlobalPaletteOpen` in `AgentHeader`. The top-nav chip is now the primary switching affordance.
- Add "Edit Agent" button calling `onOpenAgentDialog`. Use `Pencil` icon from `lucide-react` (already used elsewhere in the codebase).
- The unregistered branch should show "Create agent" with a `Plus` icon instead of the "+ Agent" text link pattern.

**Tooltip and aria-label update for `AgentIdentityChip`:**
- Tooltip: `"Agent settings"` → `"Switch agent"`
- `aria-label`: `"{agent.name} — agent settings"` → `"{agent.name} — switch agent"` (or simply `"Switch agent"` when no agent)
- The `ChevronDown` icon already signals "this opens something" — no icon change needed.

---

## Research Gaps & Limitations

- No user research on whether the chevron-down in `AgentIdentityChip` is already understood as "opens agent picker." The recommended behavior (opening the command palette pre-filtered to `@`) is consistent with the VS Code/JetBrains workspace-switcher pattern where clicking the workspace indicator opens a picker.
- The sidebar `AgentHeader` is also rendered in the embedded (Obsidian) mode where there is no top nav. After removing the CWD from `AgentHeader`, embedded users lose the CWD display in the sidebar. Consider whether the CWD is still shown via the status bar in embedded mode before finalizing the removal.

---

## Sources & Evidence

All findings are derived from direct codebase inspection. No web searches were performed — existing research covered the conceptual patterns, and the codebase provided the implementation details.

Referenced files:
- `apps/client/src/layers/shared/model/app-store.ts` — Zustand store, all dialog open/close patterns
- `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx` — existing `handleOpenChange`, `closePalette`, `search` state, `@` prefix mode
- `apps/client/src/layers/features/command-palette/model/use-global-palette.ts` — keyboard handler, store selectors
- `apps/client/src/layers/features/top-nav/ui/AgentIdentityChip.tsx` — current `setAgentDialogOpen(true)` on click
- `apps/client/src/layers/features/top-nav/ui/CommandPaletteTrigger.tsx` — existing `setGlobalPaletteOpen(true)` pattern
- `apps/client/src/layers/features/session-list/ui/AgentHeader.tsx` — sidebar CWD + Switch button to be removed
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — `AgentHeader` usage and existing props
- `apps/client/src/App.tsx` — `AgentIdentityChip` usage context in the header

Prior research (patterns):
- `research/20260303_command_palette_agent_centric_ux.md` — `@` prefix mode, agent-centric sidebar, Option A agent identity header
- `research/20260303_command_palette_10x_elevation.md` — stagger animations, cmdk shouldFilter, frecency

---

## Search Methodology

- Searches performed: 0 (all findings from codebase inspection and existing research)
- Existing research files consulted: `20260303_command_palette_agent_centric_ux.md`, `20260303_command_palette_10x_elevation.md`
- Files read: 12 source files across `app-store`, `CommandPaletteDialog`, `use-global-palette`, `AgentIdentityChip`, `CommandPaletteTrigger`, `AgentHeader`, `SessionSidebar`, `App.tsx`, command-palette `index.ts`
