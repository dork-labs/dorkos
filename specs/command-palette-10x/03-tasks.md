# Task Breakdown: 10x Command Palette UX
Generated: 2026-03-03
Source: specs/command-palette-10x/02-specification.md
Last Decompose: 2026-03-03

## Overview

Elevate the existing Cmd+K global command palette from a functional launcher into a world-class, intelligent interface. Five enhancements: (1) Fuse.js fuzzy search with character-level highlighting, (2) Slack bucket frecency for natural ranking decay, (3) agent preview panel for informed switching, (4) agent sub-menu drill-down via cmdk pages, and (5) premium micro-interactions using motion.dev.

All changes are client-side within `features/command-palette/`. No server changes, no new API endpoints, no shared package changes. One new dependency: `fuse.js` (24kb, MIT, zero sub-deps).

---

## Phase 1: Search & Frecency Foundation

### Task 1.1: Install fuse.js and create use-palette-search hook
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:
- Install `fuse.js@^7.0.0` in `apps/client/`
- Create `use-palette-search.ts` with Fuse.js integration
- Fuse options: `includeMatches: true`, `threshold: 0.3`, `distance: 100`, `minMatchCharLength: 1`
- Category prefix detection: `@` for agents, `>` for commands, no prefix for all
- Export `SearchableItem` and `SearchResult` interfaces
- Memoize Fuse instance per item list change

**Implementation Steps**:
1. Install fuse.js dependency
2. Create hook with `parsePrefix()` for `@` / `>` detection
3. Filter items by prefix before passing to Fuse
4. Return results with match indices for highlighting
5. Write 11 unit tests (parsePrefix + usePaletteSearch)

**Acceptance Criteria**:
- [ ] fuse.js@^7.0.0 in apps/client package.json
- [ ] Prefix parsing handles @, >, and no-prefix
- [ ] Fuse instance memoized (not recreated per keystroke)
- [ ] All 11 tests pass

---

### Task 1.2: Create HighlightedText component for fuzzy match rendering
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:
- Build React nodes from Fuse.js `[start, endInclusive]` index pairs
- Matched characters wrapped in `<mark>` with `font-semibold`
- All content via React.createElement (no raw HTML injection)
- Plain `<span>` fallback when no indices

**Implementation Steps**:
1. Create `HighlightedText.tsx` in `features/command-palette/ui/`
2. Iterate index pairs, split text into matched/unmatched spans
3. Write 9 unit tests covering edge cases

**Acceptance Criteria**:
- [ ] Renders `<mark>` for matched ranges
- [ ] Renders plain `<span>` with no indices
- [ ] Full text content preserved
- [ ] All 9 tests pass

---

### Task 1.3: Upgrade frecency to Slack bucket algorithm
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

**Technical Requirements**:
- New storage key `dorkos:agent-frecency-v2` (old data ignored, no migration)
- 6 time buckets: 4h (100), 24h (80), 3d (60), 1w (40), 1mo (20), 90d (10), beyond (0)
- Formula: `totalCount * bucketSum / min(timestamps.length, 10)`
- Max 10 timestamps per agent, most recent first
- Preserve `useSyncExternalStore` pattern and public API

**Implementation Steps**:
1. Replace `use-agent-frecency.ts` with bucket algorithm
2. Change `FrecencyEntry` to `FrecencyRecord` with `timestamps: number[]`
3. Export `calcFrecencyScore` for testability
4. Write 15+ unit tests for bucket scoring and hook behavior

**Acceptance Criteria**:
- [ ] Bucket scores correct for each time window
- [ ] Timestamps capped at 10 entries
- [ ] New storage key, old key untouched
- [ ] All 15+ tests pass

---

### Task 1.4: Integrate Fuse.js search into CommandPaletteDialog
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, 1.2
**Can run parallel with**: None

**Technical Requirements**:
- Set `shouldFilter={false}` on `<Command>` (disable cmdk built-in filter)
- Drive all filtering via `usePaletteSearch` hook
- Add `searchableItems` field to `PaletteItems` return type
- Pass match indices to `HighlightedText` for agent names
- Add `>` command prefix support
- Update `AgentCommandItem` to accept `nameIndices` prop

**Implementation Steps**:
1. Add `searchableItems` builder to `usePaletteItems`
2. Remove cmdk `filter` prop, add `shouldFilter={false}`
3. Group search results by type for rendering
4. Wire up `HighlightedText` for matched items
5. Update existing tests for new mock shapes

**Acceptance Criteria**:
- [ ] All filtering via Fuse.js (not cmdk built-in)
- [ ] `@` and `>` prefixes work correctly
- [ ] Match highlighting renders `<mark>` elements
- [ ] Zero-query state unchanged
- [ ] Existing tests updated and passing

---

## Phase 2: Sub-menu & Preview Panel

### Task 2.1: Add previousCwd to Zustand store
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.4
**Can run parallel with**: Task 2.2

**Technical Requirements**:
- Add `previousCwd: string | null` to app-store (initial: null)
- Add `setPreviousCwd` action
- Set `previousCwd` before agent switches in `handleAgentSelect`
- No-op guard when switching to same CWD

**Acceptance Criteria**:
- [ ] previousCwd added to store
- [ ] Set on agent switch (before CWD change)
- [ ] Additive change only

---

### Task 2.2: Create use-preview-data hook
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.4
**Can run parallel with**: Task 2.1

**Technical Requirements**:
- Aggregate session count, recent sessions (max 3), mesh health
- `useDeferredValue` on agentId for debounced preview
- Filter sessions by agent CWD
- Return nullable health

**Implementation Steps**:
1. Create `use-preview-data.ts` with entity hook consumption
2. Write 6 unit tests

**Acceptance Criteria**:
- [ ] Returns correct session count per agent CWD
- [ ] Max 3 recent sessions
- [ ] Health nullable when unavailable
- [ ] All 6 tests pass

---

### Task 2.3: Create AgentPreviewPanel component
**Size**: Large
**Priority**: Medium
**Dependencies**: Task 2.2
**Can run parallel with**: None

**Technical Requirements**:
- Right-side panel showing agent identity, CWD, persona, sessions, health
- Spring-based width animation via `motion.div`
- Dialog width transitions: 480px to 720px
- Hidden on mobile (`useIsMobile()`)
- Conditional render inside `<AnimatePresence>`

**Implementation Steps**:
1. Create `AgentPreviewPanel.tsx` with all content sections
2. Integrate into `CommandPaletteDialog` with flex-row layout
3. Track selected agent via cmdk value state
4. Add width transition to dialog content

**Acceptance Criteria**:
- [ ] Panel shows for agent items, hidden for others
- [ ] Spring animation on panel entrance/exit
- [ ] Dialog width expands when preview shown
- [ ] Hidden on mobile

---

### Task 2.4: Implement sub-menu drill-down with cmdk pages
**Size**: Large
**Priority**: Medium
**Dependencies**: Task 2.1, 2.3
**Can run parallel with**: None

**Technical Requirements**:
- cmdk `pages` stack: `useState<string[]>([])`, last element is current page
- `AgentSubMenu.tsx` with Open Here, Open in New Tab, New Session, Recent Sessions
- Enter on agent pushes `'agent-actions'` page
- Cmd+Enter fast path: open in new tab directly
- Backspace (empty input) pops page, Escape in sub-menu pops with `stopPropagation()`
- Breadcrumb: "All / Agent: {name}"
- CSS height transition on `[cmdk-list]`
- Reset pages/selectedAgent on palette close

**Implementation Steps**:
1. Create `AgentSubMenu.tsx` with actions and recent sessions
2. Add pages stack state to `CommandPaletteDialog`
3. Implement keyboard navigation (Escape, Backspace, Cmd+Enter)
4. Add breadcrumb UI
5. Add CSS height transition
6. Wire up page content rendering

**Acceptance Criteria**:
- [ ] Sub-menu opens on Enter
- [ ] Cmd+Enter opens new tab (fast path)
- [ ] Backspace/Escape go back
- [ ] Breadcrumb shows current location
- [ ] State resets on close

---

## Phase 3: Micro-interactions & Polish

### Task 3.1: Add sliding selection indicator with layoutId
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.4
**Can run parallel with**: Task 3.2, 3.3

**Technical Requirements**:
- `motion.div` with `layoutId="cmd-palette-selection"` behind selected item
- `position: absolute, inset-0` for indicator, `position: relative, z-10` for content
- Spring: `stiffness: 500, damping: 40`
- Wrap `CommandList` content in `<LayoutGroup>`
- Track selection via cmdk `value` / `onValueChange`

**Acceptance Criteria**:
- [ ] Indicator slides between items on arrow keys
- [ ] Does not interfere with cmdk navigation
- [ ] Respects prefers-reduced-motion

---

### Task 3.2: Add dialog entrance, stagger, page transition, and hover animations
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.4
**Can run parallel with**: Task 3.1, 3.3

**Technical Requirements**:
- Dialog entrance: spring scale 0.96->1, fade, y -8->0 (500/35 spring)
- Dialog exit: opacity 0, scale 0.96, y -8, 120ms
- Stagger on open + page transitions only (not per-keystroke), 40ms per item, max 8 items
- Directional page transition: forward slides right-to-left, back left-to-right, 150ms
- Item hover: 2px rightward nudge (600/40 spring)
- Update test mocks for `motion/react`

**Acceptance Criteria**:
- [ ] Dialog animates on open/close
- [ ] Stagger limited to open + page transitions
- [ ] Page transitions directional
- [ ] Hover nudge on items
- [ ] Tests pass with motion mocks

---

### Task 3.3: Create PaletteFooter and add contextual suggestions
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.4
**Can run parallel with**: Task 3.1, 3.2

**Technical Requirements**:
- `PaletteFooter.tsx` with dynamic `<kbd>` hints based on page/selection state
- Mac vs non-Mac modifier key detection
- Three suggestion rules: Continue session (<1h), Active Pulse runs, Switch back to previous agent
- Max 3 suggestions in "Suggestions" group at top of zero-query state
- `handleSuggestionAction` dispatcher for action string prefixes

**Acceptance Criteria**:
- [ ] Footer shows correct context-aware hints
- [ ] Suggestions computed from session/Pulse/previousCwd state
- [ ] Max 3 suggestions
- [ ] Only shown in zero-query root state

---

### Task 3.4: Update barrel exports and write integration tests
**Size**: Large
**Priority**: High
**Dependencies**: Task 3.1, 3.2, 3.3
**Can run parallel with**: None

**Technical Requirements**:
- Update `index.ts` exports: add `usePaletteSearch`, `SearchableItem`, `SearchResult`
- Integration tests for: preview panel, sub-menu, breadcrumb, Escape/Backspace, search highlighting, `@`/`>` prefixes, footer hints, contextual suggestions
- Update all existing test mocks for new dependencies
- Update `AgentCommandItem` tests for new props

**Acceptance Criteria**:
- [ ] Barrel exports complete
- [ ] Full integration test coverage
- [ ] All existing tests updated and passing
- [ ] `pnpm vitest run apps/client/src/layers/features/command-palette/` passes

---

## Phase 4: Documentation

### Task 4.1: Update documentation for new palette features
**Size**: Small
**Priority**: Low
**Dependencies**: Task 3.4
**Can run parallel with**: None

**Technical Requirements**:
- `contributing/keyboard-shortcuts.md`: 5 new shortcuts (Cmd+Enter, > prefix, Backspace, Escape in sub-menu, Enter for drill-down)
- `contributing/animations.md`: layoutId selection indicator pattern and stagger-on-open pattern
- `decisions/0063`: update status from `proposed` to `accepted`

**Acceptance Criteria**:
- [ ] Keyboard shortcuts documented
- [ ] Animation patterns documented
- [ ] ADR status updated
- [ ] No new files created

---

## Dependency Graph

```
Phase 1: [1.1, 1.2, 1.3] (parallel) -> [1.4]
Phase 2: [2.1, 2.2] (parallel, depend on 1.4) -> [2.3] -> [2.4]
Phase 3: [3.1, 3.2, 3.3] (parallel, depend on 2.4) -> [3.4]
Phase 4: [4.1] (depends on 3.4)
```

## Critical Path

1.1 + 1.2 -> 1.4 -> 2.2 -> 2.3 -> 2.4 -> 3.4 -> 4.1
