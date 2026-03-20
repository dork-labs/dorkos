# Task Breakdown: StatusLine Compound Component

Generated: 2026-03-10
Source: specs/statusline-compound-component/02-specification.md
Last Decompose: 2026-03-10

## Overview

Refactor the `StatusLine` component from an imperative `entries[]` array assembly pattern into a declarative compound component using React Context. The result is a `StatusLine` root with a `StatusLine.Item` sub-component. Data fetching moves up to the consumer (`ChatStatusSection`), making `StatusLine` a thin layout/animation shell. The external rendering contract (DOM, CSS, ARIA, animations) is preserved exactly.

## Phase 1: Foundation

### Task 1.1: Rewrite StatusLine.tsx as compound component

**Size**: Large
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

Rewrite `apps/client/src/layers/features/status/ui/StatusLine.tsx` to contain only:

- `StatusLineContextValue` interface and `StatusLineContext` (React.createContext)
- `useStatusLineContext()` hook with provider guard (throws on missing provider)
- `ITEM_TRANSITION` module-level constant
- `StatusLineRoot` component with registration state (`registeredKeys`), `registerItem`/`unregisterItem` callbacks, context memoization, and two-boundary AnimatePresence JSX
- `StatusLineItem` component with registration `useEffect`, separator logic, and motion.div wrapper
- `StatusLineSeparator` internal component (middot, `aria-hidden="true"`)
- `Object.assign` export: `export const StatusLine = Object.assign(StatusLineRoot, { Item: StatusLineItem })`

Remove all data fetching hooks, all item component imports, and the `SessionStatusEvent` type import. The new `StatusLineProps` interface has `sessionId`, `isStreaming`, and `children` (no `sessionStatus`).

**Acceptance Criteria**:

- [ ] File contains only context, root, item, separator, and export — zero data fetching
- [ ] Provider guard throws exact message: `'StatusLine.Item must be used within a StatusLine.'`
- [ ] Registration uses `useEffect` (not render-time logic)
- [ ] Animation properties match original exactly (container and item)
- [ ] ARIA attributes preserved: `role="toolbar"`, `aria-label="Session status"`, `aria-live="polite"`, `data-testid="status-line"`
- [ ] File is under 250 LOC
- [ ] All TSDoc and inline comments from spec section 11 are present

### Task 1.2: Update status feature barrel exports

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

Add 7 missing item component exports to `apps/client/src/layers/features/status/index.ts`: `CwdItem`, `GitStatusItem`, `PermissionModeItem`, `ModelItem`, `CostItem`, `ContextItem`, `NotificationSoundItem`. Preserve all existing exports unchanged.

**Acceptance Criteria**:

- [ ] All 9 item components exported from barrel
- [ ] Existing exports preserved
- [ ] Module-level TSDoc preserved

## Phase 2: Consumer Migration

### Task 2.1: Migrate ChatStatusSection to compound StatusLine API

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

Modify `apps/client/src/layers/features/chat/ui/ChatStatusSection.tsx`:

1. Add imports for data hooks (`useSessionStatus`, `useQuery`, `useQueryClient`, `useTransport`, `useGitStatus`) and all 9 item components from the status barrel
2. Move all data fetching hooks and `handleDismissVersion` callback into the function body
3. Merge `showShortcutChips` into the destructured `useAppStore()` call
4. Extract compound `StatusLine` JSX to a `const statusLineContent` variable
5. Replace both mobile and desktop `<StatusLine>` call sites with `{statusLineContent}`
6. Remove `sessionStatus` from `StatusLine` props

**Acceptance Criteria**:

- [ ] All 5 data hooks are in `ChatStatusSection`
- [ ] `handleDismissVersion` and `dismissedVersions` are in `ChatStatusSection`
- [ ] 9 `StatusLine.Item` children in compound JSX
- [ ] Both branches use same `statusLineContent` variable
- [ ] `pnpm typecheck` and `pnpm lint` pass
- [ ] No FSD layer violations

## Phase 3: Testing

### Task 3.1: Write StatusLine compound component tests

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

Create `apps/client/src/layers/features/status/__tests__/StatusLine.test.tsx` with 12 test cases:

- Container visibility (3 tests): toolbar hidden when no items visible, toolbar renders when item visible, correct ARIA attributes
- Item visibility (3 tests): visible items render, invisible items don't render, multiple visible items all render
- Separator logic (5 tests): no separator for single item, one separator for two items, N-1 separators for N items, no separator before first visible when earlier items hidden, middot character content
- Provider guard (1 test): throws when `StatusLine.Item` used outside provider

Uses the motion mock proxy pattern from `ModelItem.test.tsx`.

**Acceptance Criteria**:

- [ ] All 12 new tests pass
- [ ] All 6 existing item test files pass without modification
- [ ] Motion mock uses Proxy pattern
- [ ] Console error spy restored in provider guard test

## Phase 4: Verification

### Task 4.1: Run full verification suite

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1, Task 3.1
**Can run parallel with**: None

Run complete verification: `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run`. Manual verification of visual parity, animation behavior, separator logic, interactive overlays, and mobile gestures.

**Acceptance Criteria**:

- [ ] All automated checks pass (typecheck, lint, test)
- [ ] Visual parity confirmed
- [ ] Interactive overlays functional
- [ ] Mobile gesture works
- [ ] No item component files modified
- [ ] No server files modified
