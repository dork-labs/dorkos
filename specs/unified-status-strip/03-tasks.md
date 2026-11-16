# Task Breakdown: Unified Status Strip

Generated: 2026-03-20
Source: specs/unified-status-strip/02-specification.md
Last Decompose: 2026-03-20

## Overview

Consolidate `InferenceIndicator` and `SystemStatusZone` into a single `ChatStatusStrip` component using a state machine architecture. One morphing container, positioned between `MessageList` and the chat input, displays exactly one status type at a time using a prioritized state selector. Visual styles converge on the muted `SystemStatusZone` aesthetic while preserving the data richness of `InferenceIndicator` (rotating verbs, elapsed time, token count). The refactoring eliminates 7 props threaded through `MessageList` solely for status display.

---

## Phase 1: Foundation

### Task 1.1: Create deriveStripState pure function and StripState types

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:

- Define `StripState` discriminated union with 6 variants: `rate-limited`, `waiting`, `system-message`, `streaming`, `complete`, `idle`
- Define `StripStateInput` interface with all raw inputs needed by the state machine
- Implement `deriveStripState()` pure function with strict priority ordering: rate-limited > waiting > system-message > streaming > complete > idle
- Implement `deriveSystemIcon()` helper mapping system message content to Lucide icons (compact -> RefreshCw, permission -> Shield, default -> Info)
- Move `formatTokens()` from InferenceIndicator (formats count with k suffix for 1000+)
- All functions exported with TSDoc comments

**Implementation Steps**:

1. Create `apps/client/src/layers/features/chat/ui/ChatStatusStrip.tsx`
2. Define and export `StripState` type and `StripStateInput` interface
3. Implement and export `deriveSystemIcon()` with case-insensitive pattern matching
4. Implement and export `deriveStripState()` with priority-ordered conditionals
5. Implement and export `formatTokens()` (moved from InferenceIndicator)

**Acceptance Criteria**:

- [ ] File exists with all types and pure functions
- [ ] `StripState` has 6 variants with correct shapes
- [ ] `deriveStripState()` follows exact priority order
- [ ] `deriveSystemIcon()` maps known patterns correctly
- [ ] `formatTokens()` handles <1000 and >=1000 cases
- [ ] All exports have TSDoc comments
- [ ] File passes `pnpm typecheck`

---

### Task 1.2: Create useStripState hook for lifecycle management

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Hook manages: elapsed time via `useElapsedTime`, verb rotation via `useRotatingVerb`, bypass verb detection, snapshot refs for post-stream display, complete auto-dismiss (8s), rate-limit countdown (1s tick)
- Accepts `UseStripStateInput` interface, returns `StripState`
- Calls `deriveStripState()` with all computed inputs
- Manages `showComplete` state triggered on streaming->idle transition when tokens > 0

**Implementation Steps**:

1. Create `apps/client/src/layers/features/chat/model/use-strip-state.ts`
2. Compute verb list (add bypass verbs when `permissionMode === 'bypassPermissions'`)
3. Call `useElapsedTime` (null startTime when not streaming)
4. Call `useRotatingVerb` with computed verb list
5. Implement snapshot refs (`lastElapsedRef`, `lastTokensRef`)
6. Implement complete state trigger + 8s auto-dismiss timer
7. Implement rate-limit countdown with setInterval
8. Call `deriveStripState()` and return result

**Acceptance Criteria**:

- [ ] Hook file exists and exports `useStripState`
- [ ] Accepts `UseStripStateInput`, returns `StripState`
- [ ] Correctly manages all lifecycle concerns
- [ ] Has TSDoc comment
- [ ] File passes `pnpm typecheck`

---

### Task 1.3: Create ChatStatusStrip component with three-layer animation

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:

- Three-layer animation stack: outer height (200ms ease-out), inner crossfade (150ms AnimatePresence mode="wait"), verb sub-animation (300ms)
- Per-state renderers: `StreamingContent`, `WaitingContent`, `RateLimitedContent`, `SystemMessageContent`, `CompleteContent`
- All states share container: `text-xs py-2 flex items-center justify-center gap-1.5 px-4`
- `data-testid` attributes: `chat-status-strip-streaming`, `chat-status-strip-waiting`, `chat-status-strip-rate-limited`, `chat-status-strip-system-message`, `chat-status-strip-complete`
- Props interface with defaults matching existing behavior

**Implementation Steps**:

1. Add props interface and component to `ChatStatusStrip.tsx`
2. Implement outer height animation with `motion.div initial={false}`
3. Implement inner crossfade with `AnimatePresence mode="wait"` keyed by `state.type`
4. Implement each per-state renderer with correct styling and icons
5. Implement verb sub-animation (Layer 3) inside StreamingContent

**Acceptance Criteria**:

- [ ] Component exported from `ChatStatusStrip.tsx`
- [ ] Three animation layers work correctly
- [ ] All 6 states render with correct `data-testid` attributes
- [ ] Visual styling matches specification
- [ ] File passes `pnpm typecheck`

---

### Task 1.4: Write tests for deriveStripState, deriveSystemIcon, and ChatStatusStrip

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2, Task 1.3
**Can run parallel with**: None

**Technical Requirements**:

- Four test groups: `deriveStripState()` pure function, `deriveSystemIcon()`, component rendering, lifecycle
- Pure function tests cover all 6 states and all priority ordering combinations
- Component tests mock `useElapsedTime` and `useRotatingVerb` (matching existing InferenceIndicator.test.tsx patterns)
- Lifecycle tests use `vi.useFakeTimers()` for 8s auto-dismiss and countdown
- No Transport mock needed (pure UI component)

**Implementation Steps**:

1. Create `apps/client/src/layers/features/chat/__tests__/ChatStatusStrip.test.tsx`
2. Set up vi.mock for `useElapsedTime` and `useRotatingVerb`
3. Write `deriveStripState()` tests (13 test cases covering all priorities and edge cases)
4. Write `deriveSystemIcon()` tests (5 test cases)
5. Write component rendering tests (8 test cases for each state variant)
6. Write lifecycle tests (2 test cases: complete trigger and auto-dismiss)

**Acceptance Criteria**:

- [ ] Test file exists with all 4 groups
- [ ] All priority ordering tests pass
- [ ] All component rendering tests pass
- [ ] Lifecycle tests pass with fake timers
- [ ] All tests pass with `pnpm vitest run`

---

## Phase 2: Integration

### Task 2.1: Wire ChatStatusStrip into ChatPanel and remove SystemStatusZone usage

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Replace `SystemStatusZone` import with `ChatStatusStrip`
- Replace `<SystemStatusZone message={systemStatus} />` with full `<ChatStatusStrip>` invocation
- Remove 7 inference props from `<MessageList>` invocation
- Position remains between main content div and PromptSuggestionChips

**Implementation Steps**:

1. Update imports in `ChatPanel.tsx`
2. Replace `<SystemStatusZone>` with `<ChatStatusStrip>` (with all props)
3. Remove 7 props from `<MessageList>`: `streamStartTime`, `estimatedTokens`, `permissionMode`, `isWaitingForUser`, `waitingType`, `isRateLimited`, `rateLimitRetryAfter`

**Acceptance Criteria**:

- [ ] SystemStatusZone import removed
- [ ] ChatStatusStrip wired with all required props
- [ ] 7 inference props removed from MessageList invocation
- [ ] `pnpm typecheck` passes

---

### Task 2.2: Remove InferenceIndicator from MessageList and clean up props

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Remove `InferenceIndicator` import
- Remove `PermissionMode` type import (if no other usages)
- Remove 7 props from `MessageListProps` interface
- Remove 7 destructured parameters from component function
- Remove the entire InferenceIndicator render block (absolute-positioned div inside virtualizer)

**Implementation Steps**:

1. Remove imports from `MessageList.tsx`
2. Remove 7 props from `MessageListProps` interface
3. Remove 7 destructured parameters
4. Remove InferenceIndicator render block (lines 211-225)

**Acceptance Criteria**:

- [ ] No references to InferenceIndicator remain in MessageList
- [ ] 7 props removed from interface and destructured params
- [ ] Absolute-positioned render block removed
- [ ] `pnpm typecheck` passes

---

### Task 2.3: Update barrel exports and delete old files

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: None

**Technical Requirements**:

- Add `ChatStatusStrip`, `deriveStripState`, `deriveSystemIcon`, `StripState` exports to barrel
- Delete 4 files: `InferenceIndicator.tsx`, `SystemStatusZone.tsx`, `InferenceIndicator.test.tsx`, `SystemStatusZone.test.tsx`
- Verify no broken imports across codebase

**Implementation Steps**:

1. Update `layers/features/chat/index.ts` with new exports
2. Delete `InferenceIndicator.tsx` and `SystemStatusZone.tsx`
3. Delete `InferenceIndicator.test.tsx` and `SystemStatusZone.test.tsx`
4. Run `pnpm typecheck` to verify

**Acceptance Criteria**:

- [ ] Barrel exports updated with new component and utilities
- [ ] All 4 old files deleted
- [ ] No broken imports
- [ ] `pnpm typecheck` passes

---

## Phase 3: Polish

### Task 3.1: Update StatusShowcases and chat-sections registry for ChatStatusStrip

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.3
**Can run parallel with**: None

**Technical Requirements**:

- Replace `InferenceIndicator` and `SystemStatusZone` imports with `ChatStatusStrip`
- Replace both old `<PlaygroundSection>` blocks with single `ChatStatusStrip` section
- Showcase all states: streaming, waiting (approval + question), rate-limited (with + without countdown), system-message (3 variants), idle
- Update `chat-sections.ts` registry: replace 2 entries with 1 combined entry

**Implementation Steps**:

1. Update imports in `StatusShowcases.tsx`
2. Replace InferenceIndicator section with ChatStatusStrip showcases
3. Remove SystemStatusZone section
4. Update TSDoc on StatusShowcases component
5. Update `chat-sections.ts`: replace `inferenceindicator` and `systemstatuszone` entries with `chatstatusstrip`

**Acceptance Criteria**:

- [ ] Imports updated
- [ ] All 6+ state variants showcased
- [ ] Registry entries updated
- [ ] `pnpm typecheck` passes
- [ ] Dev playground renders correctly

---

### Task 3.2: Run full validation suite and fix any remaining issues

**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Technical Requirements**:

- Run `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run`, `pnpm format`
- Search for any remaining references to `InferenceIndicator` or `SystemStatusZone`
- Fix any lint warnings (unused imports, missing TSDoc, eslint-disable comments)
- Verify all new exports have TSDoc comments

**Implementation Steps**:

1. Run `pnpm typecheck` and fix errors
2. Run `pnpm lint` and fix warnings
3. Run `pnpm test -- --run` and fix failures
4. Run `pnpm format` to ensure formatting
5. Search for stale references to old components
6. Add any missing eslint-disable comments matching existing patterns

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test -- --run` passes
- [ ] `pnpm format` produces no changes
- [ ] No stale references remain
- [ ] All exports have TSDoc comments

---

## Summary

| Phase                | Tasks              | Description                                                 |
| -------------------- | ------------------ | ----------------------------------------------------------- |
| Phase 1: Foundation  | 1.1, 1.2, 1.3, 1.4 | Core state machine, hook, component, and tests              |
| Phase 2: Integration | 2.1, 2.2, 2.3      | Wire into ChatPanel, clean up MessageList, delete old files |
| Phase 3: Polish      | 3.1, 3.2           | Update playground showcases, full validation                |

**Parallel Opportunities**: Tasks 2.1 and 2.2 can run in parallel (they modify different files with no cross-dependency).

**Critical Path**: 1.1 -> 1.2 -> 1.3 -> 1.4 -> 2.1/2.2 -> 2.3 -> 3.1 -> 3.2

**Files Created**: 3 (ChatStatusStrip.tsx, use-strip-state.ts, ChatStatusStrip.test.tsx)
**Files Modified**: 4 (ChatPanel.tsx, MessageList.tsx, index.ts, StatusShowcases.tsx, chat-sections.ts)
**Files Deleted**: 4 (InferenceIndicator.tsx, SystemStatusZone.tsx, InferenceIndicator.test.tsx, SystemStatusZone.test.tsx)
