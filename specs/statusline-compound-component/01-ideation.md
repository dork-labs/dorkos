---
slug: statusline-compound-component
number: 116
created: 2026-03-10
status: ideation
---

# StatusLine Compound Component

**Slug:** statusline-compound-component
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/statusline-compound-component

---

## 1) Intent & Assumptions

- **Task brief:** Refactor the StatusLine component from an imperative `entries[]` array assembly pattern into a compound component with a generic `StatusLine.Item` wrapper. This enables declarative composition, plugin extensibility for external status items, and flexible layout for different embedding contexts (standalone web, Obsidian sidebar, kiosk mode).

- **Assumptions:**
  - Existing individual status item components (CwdItem, GitStatusItem, ModelItem, etc.) remain unchanged — only the orchestration/assembly layer changes
  - Backwards compatibility is maintained: the current consumer (ChatStatusSection) continues working with minimal migration
  - The 9 visibility booleans in `useAppStore` remain the source of truth for built-in item visibility
  - Animation behavior (AnimatePresence enter/exit, popLayout, layout reflow) is preserved exactly

- **Out of scope:**
  - New status items or changes to existing item components
  - Plugin registration API or plugin system design (compound pattern just enables future injection)
  - ChatPanel or ChatInputContainer compound refactors
  - Settings UI changes for status bar configuration
  - Named sub-components (StatusLine.Cwd, StatusLine.Git, etc.) — using generic `StatusLine.Item` only

---

## 2) Pre-reading Log

- `apps/client/src/layers/features/status/ui/StatusLine.tsx`: 184 LOC. Imperative `entries[]` array built from 9 conditional pushes. Uses `AnimatePresence` (outer for container, inner `mode="popLayout"` for items). Separator via `{i > 0 && <Separator />}` with `·` middot character. Props: `sessionId`, `sessionStatus`, `isStreaming`.
- `apps/client/src/layers/features/status/ui/CwdItem.tsx`: Simple — icon + folder name. Props: `cwd: string`.
- `apps/client/src/layers/features/status/ui/GitStatusItem.tsx`: Branch name + ahead/behind + change count. Props: `data: GitStatusResponse | GitStatusError | undefined`.
- `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx`: Dropdown selector. Props: `mode`, `onChangeMode`. Interactive.
- `apps/client/src/layers/features/status/ui/ModelItem.tsx`: Dropdown selector. Props: `model`, `onChangeModel`. Interactive.
- `apps/client/src/layers/features/status/ui/CostItem.tsx`: USD cost display. Props: `costUsd: number`.
- `apps/client/src/layers/features/status/ui/ContextItem.tsx`: Context usage %. Props: `percent: number`. Color-coded.
- `apps/client/src/layers/features/status/ui/NotificationSoundItem.tsx`: Toggle button. Props: `enabled`, `onToggle`. Interactive.
- `apps/client/src/layers/features/status/ui/TunnelItem.tsx`: Remote status + dialog. Props: `tunnel`. Has internal dialog state.
- `apps/client/src/layers/features/status/ui/VersionItem.tsx`: Update badge + popover. 180 LOC. Props: `version`, `latestVersion`, `isDevMode?`, `isDismissed?`, `onDismiss?`.
- `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx`: 128 LOC. Sole consumer of StatusLine. Wraps it with mobile gesture handling + ShortcutChips. Passes `sessionId`, `sessionStatus`, `isStreaming`.
- `apps/client/src/layers/app/stores/app-store.ts`: 9 `showStatusBar*` booleans persisted to localStorage.
- `apps/client/src/layers/shared/ui/sidebar.tsx`: Shadcn compound component — `SidebarContext` + `useSidebar()` hook + named sub-components. Reference implementation.
- `apps/client/src/layers/shared/ui/tabs.tsx`: Simpler compound — Radix primitives wrapped with `cn()` styling.
- `contributing/animations.md`: Motion library patterns — `motion/react` import, duration/easing conventions.
- `.claude/rules/fsd-layers.md`: FSD import hierarchy — `shared` ← `entities` ← `features` ← `widgets` ← `app`.
- `.claude/rules/components.md`: Component conventions, Shadcn patterns, accessibility requirements.
- `apps/client/src/layers/features/status/index.ts`: Barrel exports — currently exports StatusLine, VersionItem, TunnelItem, useGitStatus, version helpers.

---

## 3) Codebase Map

**Primary Components/Modules:**

| File                                           | Role                                                | LOC  |
| ---------------------------------------------- | --------------------------------------------------- | ---- |
| `features/status/ui/StatusLine.tsx`            | Container — imperative entries assembly + animation | 184  |
| `features/status/ui/CwdItem.tsx`               | Folder name display                                 | ~30  |
| `features/status/ui/GitStatusItem.tsx`         | Git branch/changes                                  | ~60  |
| `features/status/ui/PermissionModeItem.tsx`    | Permission mode dropdown                            | ~80  |
| `features/status/ui/ModelItem.tsx`             | Model selector dropdown                             | ~80  |
| `features/status/ui/CostItem.tsx`              | Cost display                                        | ~25  |
| `features/status/ui/ContextItem.tsx`           | Context % display                                   | ~40  |
| `features/status/ui/NotificationSoundItem.tsx` | Sound toggle                                        | ~40  |
| `features/status/ui/TunnelItem.tsx`            | Tunnel status + dialog                              | ~100 |
| `features/status/ui/VersionItem.tsx`           | Version badge + popover                             | 180  |
| `features/chat/ui/ChatStatusSection.tsx`       | Sole consumer — mobile gestures + wraps StatusLine  | 128  |

**Shared Dependencies:**

- `useAppStore()` — 9 visibility booleans (`showStatusBarCwd`, `showStatusBarPermission`, etc.)
- `useSessionStatus(sessionId, sessionStatus, isStreaming)` — provides model, permissionMode, costUsd, contextPercent, cwd
- `useGitStatus(cwd)` — TanStack Query hook for git status
- `motion/react` — AnimatePresence, motion.div
- `@/layers/shared/ui` — ResponsiveDropdownMenu, Popover, Separator

**Data Flow:**

```
ChatStatusSection
  └─ StatusLine(sessionId, sessionStatus, isStreaming)
       ├─ useSessionStatus() → { model, permissionMode, costUsd, contextPercent, cwd }
       ├─ useGitStatus(cwd) → gitStatus
       ├─ useAppStore() → 9 visibility booleans
       ├─ builds entries[] array (conditional pushes)
       └─ AnimatePresence → motion.div per entry → [Separator] + ItemComponent
```

**Potential Blast Radius:**

- **Direct:** StatusLine.tsx (rewrite), ChatStatusSection.tsx (update to new API)
- **Unchanged:** All 9 individual item components (presentational, no interface changes)
- **Barrel:** `features/status/index.ts` (update exports)
- **Tests:** 5 existing item tests unaffected. Need new tests for compound context + `StatusLine.Item` visibility/animation logic.

---

## 4) Root Cause Analysis

N/A — this is a refactor, not a bug fix.

---

## 5) Research

### Potential Solutions

**1. Declarative Composition + Inline Separator (Recommended)**

- Each `StatusLine.Item` accepts a `visible` prop; when `false`, returns `null` so `AnimatePresence` fires exit animation
- Separator rendered inline in each Item's `motion.div` when it's not the first visible item
- Root holds lightweight registration context — items register on mount, deregister on unmount — so root knows `hasVisibleChildren` and `firstVisibleKey`
- Context contains: `itemTransition` config, `firstVisibleKey`, registration callbacks
- Pros: Minimal context, separator exits with its item (no orphans), plugin-friendly via JSX composition
- Cons: Registration `useEffect` causes one extra render on mount/unmount (~9 items, negligible)
- Complexity: Low | Maintenance: Low

**2. Full Registration Context + Order-Aware Items**

- Items register key + order + visibility with root context
- Root derives ordered visible list; each Item reads `isFirstVisible` from context
- Pros: Full control over ordering, could support priority-based plugin insertion
- Cons: More complex context shape, extra render cycles from registration effects, over-engineered for current needs
- Complexity: Medium | Maintenance: Medium

**3. React.Children Facade (entries array under the hood)**

- `StatusLine.Item` is a marker component; root walks `React.Children.toArray(children)` to rebuild the imperative `entries[]`
- Pros: Minimal code change from current implementation
- Cons: `React.Children.toArray` cannot detect children that return `null` (only JSX-level null); breaks with Fragment wrappers; fights React's composition model; React docs explicitly discourage this pattern
- Complexity: Low | Maintenance: High (fragile)

### Separator Strategy

**Chosen: Inline in motion.div.** Each `StatusLine.Item` renders the `·` separator before its content when it's not the first visible item. The root context tracks `firstVisibleKey` via a lightweight registration pattern. When an item exits via `AnimatePresence`, its separator exits with it — no orphaned separators during animation.

### AnimatePresence Integration

**Preserve the current two-boundary architecture:**

1. **Outer `AnimatePresence`** — animates the entire status bar container in/out when `hasVisibleChildren` changes
2. **Inner `AnimatePresence mode="popLayout"`** — animates individual items in/out

When `StatusLine.Item` receives `visible={false}`, it returns `null`. The `AnimatePresence` detects the unmount and fires the exit animation. The `layout` prop on each item's `motion.div` handles reflow when siblings appear/disappear.

### Plugin Extensibility

**Pure composition — no registration API.** Plugin items are just `<StatusLine.Item>` elements declared as children. The order they appear in JSX is their display order. No separate plugin API needed at this stage.

---

## 6) Decisions

| #   | Decision           | Choice                         | Rationale                                                                                                                                                                                                                        |
| --- | ------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Separator strategy | Inline in motion.div           | Separator exits with its item during AnimatePresence — no orphaned separators. Root tracks `firstVisibleKey` via lightweight registration. Matches research recommendation.                                                      |
| 2   | API shape          | Generic `StatusLine.Item` only | Existing item components (CwdItem, etc.) stay unchanged and are passed as children. Simpler API surface, naturally supports plugin items, fewer exports. Named sub-components would create tight coupling without clear benefit. |

---

## 7) Proposed API

### Consumer Usage (ChatStatusSection)

```tsx
<StatusLine sessionId={id} sessionStatus={status} isStreaming={streaming}>
  <StatusLine.Item itemKey="cwd" visible={showCwd && !!cwd}>
    <CwdItem cwd={cwd} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="git" visible={showGit}>
    <GitStatusItem data={gitStatus} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="permission" visible={showPermission}>
    <PermissionModeItem mode={permissionMode} onChangeMode={updatePermission} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="model" visible={showModel}>
    <ModelItem model={model} onChangeModel={updateModel} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="cost" visible={showCost && costUsd !== null}>
    <CostItem costUsd={costUsd} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="context" visible={showContext && contextPercent !== null}>
    <ContextItem percent={contextPercent} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="sound" visible={showSound}>
    <NotificationSoundItem enabled={soundEnabled} onToggle={toggleSound} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="tunnel" visible={showTunnel}>
    <TunnelItem tunnel={tunnel} />
  </StatusLine.Item>
  <StatusLine.Item itemKey="version" visible={showVersion}>
    <VersionItem version={version} latestVersion={latest} />
  </StatusLine.Item>
</StatusLine>
```

### Plugin Injection (Future)

```tsx
<StatusLine sessionId={id} sessionStatus={status} isStreaming={streaming}>
  {/* Built-in items */}
  <StatusLine.Item itemKey="cwd" visible={showCwd && !!cwd}>
    <CwdItem cwd={cwd} />
  </StatusLine.Item>
  {/* ... other built-in items ... */}

  {/* Plugin-injected item */}
  <StatusLine.Item itemKey="my-plugin-metric" visible>
    <MyPluginMetric value={42} />
  </StatusLine.Item>
</StatusLine>
```

### Context Shape

```tsx
interface StatusLineContextValue {
  /** Transition config for item animations */
  itemTransition: { duration: number; ease: number[] };
  /** Key of the first visible item (for separator logic) */
  firstVisibleKey: string | null;
  /** Registration callbacks for items */
  registerItem: (key: string) => void;
  unregisterItem: (key: string) => void;
}
```

### StatusLine.Item Props

```tsx
interface StatusLineItemProps {
  /** Unique key for this item (used for AnimatePresence and registration) */
  itemKey: string;
  /** Whether this item is visible */
  visible: boolean;
  /** The item content */
  children: React.ReactNode;
}
```

### File Organization

All compound component code stays in `features/status/ui/StatusLine.tsx` (co-located, since the context is small). Individual item components remain in their own files unchanged.
