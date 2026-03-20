# Task Breakdown: Chat Message Theming & MessageItem Architecture

Generated: 2026-03-09
Source: specs/chat-message-theming/02-specification.md
Last Decompose: 2026-03-09

## Overview

Redesign the chat message theming system and MessageItem architecture to establish a semantic design token foundation, variant-driven styling via tailwind-variants, and composable sub-component decomposition. This is an internal refactoring with zero user-visible changes.

The work decomposes into 5 phases: Foundation (CSS tokens + TV setup), Context & Types, Component Decomposition (4 tasks), Test Updates, and Documentation.

---

## Phase 1: Foundation

### Task 1.1: Add status and message semantic tokens to index.css

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

Add all 7 categories of semantic design tokens to `apps/client/src/index.css`:

- Status color tokens (success, error, warning, info, pending) in `:root` and `.dark`
- Message color tokens (`--msg-assistant-bg`, `--msg-system-bg`, etc.)
- Typography tokens (`--msg-user-font-weight`, `--msg-assistant-line-height`, etc.)
- Spacing tokens (`--msg-padding-x`, `--msg-padding-y-start`, `--msg-gap`, etc.)
- Shape tokens (`--msg-radius`, `--msg-tool-radius`, `--msg-divider-color`)
- Motion tokens (`--msg-enter-y`, `--msg-enter-stiffness`, etc.)
- Interactive state tokens (`--msg-hover-user`, `--msg-actions-opacity-hover`)
- Elevation tokens (`--msg-tool-shadow`, `--msg-tool-border`)
- Register status colors in `@theme inline` for Tailwind utility generation
- Add Obsidian `.copilot-view-content` bridge overrides

**Acceptance Criteria**:

- [ ] All 7 token categories defined in `:root` with light mode values
- [ ] Dark mode overrides in `.dark` for all color tokens
- [ ] Status colors registered in `@theme inline`
- [ ] Obsidian bridge has all status color overrides
- [ ] No visual changes (tokens exist but are not yet consumed)
- [ ] All existing tests pass

---

### Task 1.2: Install tailwind-variants and create message-variants.ts

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

Install `tailwind-variants` (~3.5KB min+gzip) and create `message-variants.ts` with three TV definitions:

- `messageItem` — 5-slot multi-variant (root, leading, content, timestamp, divider) with role/position/density axes
- `toolStatus` — single variant mapping tool execution state to semantic token classes
- `approvalState` — single variant mapping approval lifecycle to border/bg/text classes

**Acceptance Criteria**:

- [ ] `tailwind-variants` added to client dependencies
- [ ] `messageItem` has 5 slots and 3 variant axes
- [ ] `toolStatus` maps 4 statuses to semantic classes
- [ ] `approvalState` maps 3 states to semantic classes
- [ ] `pnpm typecheck` and `pnpm build` pass

---

## Phase 2: Context & Types

### Task 2.1: Create MessageContext and shared types module

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

Create `MessageContext.tsx` with `MessageProvider` and `useMessageContext()` hook. Create `types.ts` with `InteractiveToolHandle` union type. The context provides `sessionId`, `isStreaming`, `activeToolCallId`, `onToolRef`, `focusedOptionIndex`, and `onToolDecided` to all message sub-components.

**Acceptance Criteria**:

- [ ] `types.ts` exports `InteractiveToolHandle` as union of `ToolApprovalHandle | QuestionPromptHandle`
- [ ] `MessageProvider` memoizes value using individual field dependencies
- [ ] `useMessageContext` throws descriptive error when used outside provider
- [ ] `pnpm typecheck` passes

---

## Phase 3: Component Decomposition

### Task 3.1: Extract UserMessageContent sub-component

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Task 3.2

Extract user message rendering (plain text, command, compaction) into `UserMessageContent.tsx`. Handles three sub-types with local `compactionExpanded` state.

**Acceptance Criteria**:

- [ ] Handles all 3 message sub-types: plain, command, compaction
- [ ] Compaction state is local to the component
- [ ] Respects FSD layer import rules
- [ ] `pnpm typecheck` passes

---

### Task 3.2: Extract AssistantMessageContent sub-component

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Task 3.1

Extract assistant message rendering (parts mapping, AutoHideToolCall, useToolCallVisibility) into `AssistantMessageContent.tsx`. Consumes `useMessageContext()` instead of receiving drilled props.

**Acceptance Criteria**:

- [ ] Renders all 4 part types: text, tool_call, approval, question
- [ ] `useToolCallVisibility` and `AutoHideToolCall` moved into this file
- [ ] Context values consumed via `useMessageContext()` instead of props
- [ ] Ref callbacks properly memoized
- [ ] `pnpm typecheck` passes

---

### Task 3.3: Migrate ToolCallCard to semantic status tokens

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 3.4

Replace `text-blue-500`, `text-green-500`, `text-red-500` in ToolCallCard with `toolStatus()` TV variant. Uses `cn()` to merge TV output with base icon classes.

**Acceptance Criteria**:

- [ ] No hardcoded color classes remain in ToolCallCard.tsx
- [ ] All status icon colors use `toolStatus()` TV variant
- [ ] Visual appearance identical to before
- [ ] `pnpm typecheck` passes

---

### Task 3.4: Rewrite MessageItem as orchestrator with TV variants and sub-components

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, Task 3.1, Task 3.2
**Can run parallel with**: Task 3.3

Replace monolithic `MessageItem.tsx` (~272 lines) with thin orchestrator (~80 lines) using `messageItem()` TV variants. Create barrel `index.ts` and backward-compatible re-export shim. `motion.div` remains outermost element for virtualizer compatibility.

**Acceptance Criteria**:

- [ ] New orchestrator is ~80 lines
- [ ] Old file is a 2-line re-export shim
- [ ] Barrel exports `MessageItem` and `InteractiveToolHandle`
- [ ] `MessageProvider` wraps all children
- [ ] TV `messageItem()` replaces all inline conditional styling
- [ ] `data-testid="message-item"` and `data-role` preserved
- [ ] `motion.div` is outermost element
- [ ] Import path `'../ui/MessageItem'` continues to work

---

### Task 3.5: Migrate ToolApproval to semantic tokens and ref-as-prop

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

Replace hardcoded emerald/red/amber colors in ToolApproval with `approvalState()` TV variant. Migrate from `forwardRef` to React 19 ref-as-prop pattern.

**Acceptance Criteria**:

- [ ] No `forwardRef` usage remains
- [ ] No hardcoded color classes remain
- [ ] All state styling uses `approvalState()` TV variant
- [ ] Button colors use `bg-status-success` and `bg-status-error`
- [ ] Visual appearance identical to before
- [ ] `pnpm typecheck` passes

---

## Phase 4: Test Updates

### Task 4.1: Update MessageItem tests for TV classes and sub-component architecture

**Size**: Large
**Priority**: High
**Dependencies**: Task 3.3, Task 3.4, Task 3.5
**Can run parallel with**: None

Update existing test selectors for TV-generated class names (e.g., `max-w-[80ch]` -> `max-w-[var(--msg-content-max-width)]`, `pt-0.5` -> `pt-[var(--msg-padding-y-mid)]`). Add new tests for MessageContext, UserMessageContent variants, and TV class application. Update ToolCallCard and ToolApproval test assertions for semantic token classes.

**Acceptance Criteria**:

- [ ] All 20 existing MessageItem tests pass with updated selectors
- [ ] New sub-component tests added and passing
- [ ] ToolCallCard tests pass with semantic token classes
- [ ] ToolApproval tests pass with semantic tokens and ref-as-prop
- [ ] No test uses hardcoded color class assertions
- [ ] `pnpm test -- --run` passes with zero failures

---

## Phase 5: Documentation

### Task 5.1: Update design-system and styling docs for status tokens and TV

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 4.1
**Can run parallel with**: None

Update `contributing/design-system.md` with Status Tokens and Message Tokens sections. Update `contributing/styling-theming.md` with TV vs CVA decision guide. Update `CLAUDE.md` FSD layer table to mention `message/` sub-module.

**Acceptance Criteria**:

- [ ] `design-system.md` documents all 5 status token categories
- [ ] `styling-theming.md` explains TV vs CVA usage criteria
- [ ] `CLAUDE.md` FSD table mentions message/ sub-module
- [ ] Documentation reflects actual implementation

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 (CSS tokens) ──┐
  1.2 (TV + variants) ┤
                       ▼
Phase 2:          2.1 (Context + types)
                       │
Phase 3:          ┌────┴────┐
                  ▼         ▼
             3.1 (User)  3.2 (Assistant)   3.3 (ToolCallCard) ←── 1.1, 1.2
                  │         │               3.5 (ToolApproval) ←── 1.1, 1.2
                  └────┬────┘
                       ▼
                  3.4 (Orchestrator + barrel)
                       │
Phase 4:          4.1 (Test updates) ←── 3.3, 3.4, 3.5
                       │
Phase 5:          5.1 (Documentation)
```

## Critical Path

1.1/1.2 -> 2.1 -> 3.1/3.2 -> 3.4 -> 4.1 -> 5.1

## Parallel Opportunities

- Tasks 1.1 and 1.2 can run in parallel (no dependencies)
- Tasks 3.1 and 3.2 can run in parallel (both depend on 2.1 only)
- Tasks 3.3 and 3.4 can run in parallel (3.3 depends on 1.1/1.2, 3.4 depends on 2.1/3.1/3.2)
- Task 3.5 can start as soon as 1.1 and 1.2 are done (independent of 2.1/3.x chain)
