# Task Breakdown: QuestionPrompt Component Redesign

Generated: 2026-03-16
Source: specs/question-prompt-redesign/02-specification.md
Last Decompose: 2026-03-16
Mode: Incremental (Post-Implementation Feedback #1)

## Overview

Initial redesign (Phases 1-3) is **complete**. This incremental update adds Phases 4-6 to unify all submitted/final/approved/denied states across QuestionPrompt and ToolApproval to match the ToolCallCard compact single-row pattern, per Post-Implementation Feedback #1.

---

## Phase 1: Foundation -- DONE

### Task 1.1: Install shadcn RadioGroup and Checkbox primitives -- DONE

**Size**: Small | **Priority**: High | Completed in Session 1.

### Task 1.2: Add questionState TV variant to message-variants.ts -- DONE

**Size**: Small | **Priority**: High | Completed in Session 1.

---

## Phase 2: Core Redesign -- DONE

### Task 2.1: Rewrite QuestionPrompt pending state with new styling and primitives -- DONE

**Size**: Large | **Priority**: High | Completed in Session 1.

### Task 2.2: Rewrite QuestionPrompt submitted state with status-success tokens -- DONE

**Size**: Medium | **Priority**: High | Completed in Session 1.

---

## Phase 3: Testing & Polish -- DONE

### Task 3.1: Update QuestionPrompt test suite for new markup and add new test cases -- DONE

**Size**: Large | **Priority**: High | Completed in Session 1.

### Task 3.2: Verify showcases and visual correctness -- DONE

**Size**: Small | **Priority**: Medium | Completed in Session 1.

---

## Phase 4: Compact Final States Unification

Three parallel tasks that unify all final/submitted/approved/denied states to match ToolCallCard's compact single-row pattern.

### Task 4.1: Rewrite QuestionPrompt submitted state to compact single-row pattern

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 4.2, Task 4.3

Replace multi-line submitted state with compact single-row matching ToolCallCard:

- `bg-muted/50` neutral background (not status-tinted)
- `shadow-msg-tool` shadow, `py-1` compact padding, `transition-all duration-150`
- Single row: green Check icon + `header: value` (single-question) or `N questions answered` (multi-question)
- Add `data-testid="question-prompt-submitted"`

**Files modified:**

- `apps/client/src/layers/features/chat/ui/QuestionPrompt.tsx`

---

### Task 4.2: Rewrite ToolApproval approved/denied states to compact single-row pattern

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 4.1, Task 4.3

Replace decided state with compact single-row:

- `bg-muted/50` neutral background (not status-tinted)
- `shadow-msg-tool` shadow, `py-1` compact padding, `transition-all duration-150`
- Approved: green Check icon + `font-mono text-3xs` tool name + green "Approved" pill badge
- Denied: red X icon + `font-mono text-3xs` tool name + red "Denied" pill badge
- Auto-denied timeout message preserved below the row

**Files modified:**

- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx`

---

### Task 4.3: Update ToolApproval pending state buttons to use shared Button component

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 4.1, Task 4.2

Replace raw `<button>` elements with shared `<Button>` from `@/layers/shared/ui`:

- Approve: `Button size="sm"` with `bg-status-success` override
- Deny: `Button size="sm" variant="destructive"`
- Import `Button` from `@/layers/shared/ui`

**Files modified:**

- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx`

---

## Phase 5: Testing

Two parallel tasks for updating test suites after the component changes.

### Task 5.1: Update QuestionPrompt tests for compact submitted state

**Size**: Medium | **Priority**: High | **Dependencies**: Task 4.1 | **Parallel with**: Task 5.2

Update submitted state test assertions:

- `header: value` format for single-question, `N questions answered` for multi-question
- `bg-muted/50`, `shadow-msg-tool`, `py-1` on container
- Use `data-testid="question-prompt-submitted"` for targeting
- Add check icon color assertion

**Files modified:**

- `apps/client/src/layers/features/chat/__tests__/QuestionPrompt.test.tsx`

---

### Task 5.2: Update ToolApproval tests for compact decided state and Button usage

**Size**: Medium | **Priority**: High | **Dependencies**: Task 4.2, Task 4.3 | **Parallel with**: Task 5.1

Update decided state test assertions:

- Approved: check icon with `text-status-success`, neutral `bg-muted/50`, `shadow-msg-tool`
- Denied: X icon with `text-status-error`, neutral `bg-muted/50`, `shadow-msg-tool`
- Add tool name mono styling test (`font-mono text-3xs`)
- Add status badge pill styling tests (`rounded-full`, status bg/fg colors)
- Verify pending state tests still pass with Button component

**Files modified:**

- `apps/client/src/layers/features/chat/__tests__/ToolApproval.test.tsx`

---

## Phase 6: Verification

### Task 6.1: Visual verification of all compact final states in dev playground

**Size**: Small | **Priority**: Medium | **Dependencies**: Task 5.1, Task 5.2

Cross-component consistency check in dev playground:

- All final states match ToolCallCard: `bg-muted/50`, `shadow-msg-tool`, `py-1`, `rounded-msg-tool`
- Status colors only on icons and badges (not container backgrounds)
- ToolApproval pending buttons use shared Button component
- Dark mode renders correctly

---

## Dependency Graph

```
Phase 1-3: DONE (all 6 tasks complete)

Phase 4 (parallel):
  4.1 QuestionPrompt submitted ──┐
  4.2 ToolApproval decided ──────┤
  4.3 ToolApproval buttons ──────┘
                                  │
Phase 5 (parallel):               │
  4.1 → 5.1 QuestionPrompt tests ┤
  4.2 + 4.3 → 5.2 ToolApproval tests
                                  │
Phase 6:                          │
  5.1 + 5.2 → 6.1 Visual verification
```

## Summary

| Phase                         | Tasks              | Status                |
| ----------------------------- | ------------------ | --------------------- |
| Phase 1: Foundation           | 2 tasks            | DONE                  |
| Phase 2: Core Redesign        | 2 tasks            | DONE                  |
| Phase 3: Testing & Polish     | 2 tasks            | DONE                  |
| Phase 4: Compact Final States | 3 tasks (parallel) | Pending               |
| Phase 5: Testing              | 2 tasks (parallel) | Pending               |
| Phase 6: Verification         | 1 task             | Pending               |
| **Total**                     | **12 tasks**       | **6 done, 6 pending** |
