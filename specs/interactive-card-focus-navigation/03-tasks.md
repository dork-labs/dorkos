# Task Breakdown: Unified Input Zone for Interactive Cards

Generated: 2026-03-17
Source: specs/interactive-card-focus-navigation/02-specification.md
Last Decompose: 2026-03-17

## Overview

Transform the chat input zone into a unified interaction surface. When the agent needs user input (tool approval or question answers), `ChatInputContainer` replaces its normal content with the interactive card UI. The message stream shows only compact placeholders. This eliminates the dual-focus problem where interactive cards in the message stream compete with the input zone for attention.

## Phase 1: Foundation

### Task 1.1: Widen activeInteraction type to expose full ToolCallState

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- The `pendingInteractions` derivation in `use-chat-session.ts` already produces full `ToolCallState` objects
- Currently narrows to `{ toolCallId, interactiveType }` — needs to return the full object
- Full object includes `toolName`, `input`, `questions`, `answers`, `timeoutMs`, `status`
- All existing consumers must continue to compile

**Implementation Steps**:

1. Update `use-chat-session.ts` to return full `ToolCallState` for `activeInteraction`
2. Update `ActiveInteraction` type alias in `chat-types.ts` if it exists
3. Verify all consumers compile (`ChatPanel`, `useInteractiveShortcuts`, etc.)

**Acceptance Criteria**:

- [ ] `activeInteraction` exposes all `ToolCallState` fields
- [ ] All existing consumers compile without errors
- [ ] `pnpm typecheck` passes
- [ ] Existing tests pass

---

### Task 1.2: Create CompactPendingRow primitive component

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- New file: `apps/client/src/layers/features/chat/ui/primitives/CompactPendingRow.tsx`
- Matches `CompactResultRow` styling (`bg-muted/50 rounded-msg-tool border px-3 py-1 text-sm shadow-msg-tool`)
- Shows spinning `Loader2` icon with type-specific label
- Accepts `type: 'approval' | 'question'` and `data-testid` props

**Implementation Steps**:

1. Create `CompactPendingRow.tsx` in primitives directory
2. Export from `primitives/index.ts`

**Acceptance Criteria**:

- [ ] Renders "Waiting for approval..." for approval type
- [ ] Renders "Answering questions..." for question type
- [ ] Shows spinning loader icon
- [ ] Container classes match `CompactResultRow`
- [ ] Exported from `primitives/index.ts`

---

## Phase 2: Core Features

### Task 2.1: Add mode switching to ChatInputContainer

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Add `activeInteraction`, `focusedOptionIndex`, `onToolRef`, `onToolDecided` props
- Mode derived as `activeInteraction ? 'interactive' : 'normal'`
- Draft text preservation via `interactiveDraftRef`
- `AnimatePresence mode="wait"` crossfade between modes (150ms opacity transitions)
- Outer container stays stable; inner content swaps
- Interactive mode renders `ToolApproval` or `QuestionPrompt` based on `interactiveType`
- Normal mode wraps all existing content (palettes, file chips, queue, input, status)

**Implementation Steps**:

1. Add new props to `ChatInputContainerProps`
2. Add `interactiveDraftRef` for draft preservation
3. Add save/restore effects keyed on `activeInteraction`
4. Wrap existing content in `<motion.div key="normal">`
5. Add `<motion.div key="interactive">` with ToolApproval/QuestionPrompt
6. Wrap both in `<AnimatePresence mode="wait">`

**Acceptance Criteria**:

- [ ] Normal mode shows all existing content
- [ ] Interactive mode shows ToolApproval for approval type
- [ ] Interactive mode shows QuestionPrompt for question type
- [ ] All normal-mode elements hidden during interactive mode
- [ ] Draft text preserved and restored on mode switch
- [ ] Textarea re-focused after restoration
- [ ] Outer container stable during transitions

---

### Task 2.2: Thread inputZoneToolCallId to message stream and show CompactPendingRow

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Add `inputZoneToolCallId: string | null` to `MessageContextValue`
- Thread from `ChatPanel` (`activeInteraction?.toolCallId ?? null`) through `MessageList` -> `MessageItem` -> `MessageContext`
- `AssistantMessageContent` renders `CompactPendingRow` when tool call matches `inputZoneToolCallId`
- Check must come BEFORE existing rendering logic
- Only one tool call shows placeholder at a time
- Other pending interactions render as full cards with `isActive={false}`

**Implementation Steps**:

1. Add field to `MessageContext`
2. Thread through `MessageList` and `MessageItem`
3. Update `AssistantMessageContent` rendering logic
4. Pass from `ChatPanel`

**Acceptance Criteria**:

- [ ] Matching tool calls show `CompactPendingRow` placeholder
- [ ] Non-matching pending tools render full cards (dimmed)
- [ ] History replay unchanged
- [ ] Resolved interactions show `CompactResultRow`

---

### Task 2.3: Thread interactive props from ChatPanel to ChatInputContainer

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: None

**Technical Requirements**:

- Pass `activeInteraction`, `focusedOptionIndex`, `handleToolRef`, and a wrapped `markToolCallResponded` to `ChatInputContainer`
- `onToolDecided` extracts `toolCallId` from current `activeInteraction`

**Implementation Steps**:

1. Add the four new props to the `ChatInputContainer` JSX in `ChatPanel`
2. Verify the full pipeline works end-to-end

**Acceptance Criteria**:

- [ ] `ChatInputContainer` receives all four new props
- [ ] Interactive card appears when pending interaction exists
- [ ] Keyboard shortcuts work
- [ ] Mode returns to normal after acting on interaction

---

## Phase 3: Keyboard & Navigation

### Task 3.1: Relax textarea arrow key guard in useInteractiveShortcuts

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 3.2, 3.3, 3.4

**Technical Requirements**:

- In the `isTextInput` block of the question branch, allow ArrowUp/ArrowDown through
- Continue blocking digits and Space (let them type normally)
- Enter (without Shift) still submits/advances
- Shift+Enter produces newline (not intercepted)

**Implementation Steps**:

1. Replace the `isTextInput` early return block with a more granular check

**Acceptance Criteria**:

- [ ] ArrowUp/ArrowDown navigate options from textarea
- [ ] Enter submits/advances from textarea
- [ ] Shift+Enter produces newline
- [ ] Digits and Space type normally in textarea

---

### Task 3.2: Replace TabsList with Back/Next buttons and step indicator in QuestionPrompt

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 3.1, 3.3, 3.4

**Technical Requirements**:

- Replace `TabsList`/`TabsTrigger` with step indicator text + Back/Next buttons
- Step indicator shows `question.header` or "Question N of M"
- Back disabled on first question
- Next on non-last questions, Submit on last question
- Submit button integrated into navigation bar (remove standalone Submit button)
- Keep `Tabs`/`TabsContent` for content switching (controlled via `value` prop)
- Kbd hints: left arrow for Back, right arrow for Next, Enter for Submit

**Implementation Steps**:

1. Replace `TabsList` section with new navigation UI
2. Remove standalone Submit button below the form
3. Remove unused `TabsList`/`TabsTrigger` imports

**Acceptance Criteria**:

- [ ] Step indicator shows question header
- [ ] Back button disabled on first question
- [ ] Next button on non-last, Submit on last
- [ ] Navigation buttons work correctly
- [ ] Standalone Submit button removed
- [ ] Single-question flows unchanged

---

### Task 3.3: Modify QuestionPrompt submit() to advance question before final submit

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 3.1, 3.2, 3.4

**Technical Requirements**:

- `submit()` imperative handle checks if on last question
- Non-last: advance to next question via `setActiveTab`
- Last: call `handleSubmit()` (actual submission)
- Single-question: submits directly (0 is not < 0)

**Implementation Steps**:

1. Modify the `submit()` method in the imperative handle

**Acceptance Criteria**:

- [ ] Enter on non-last question advances
- [ ] Enter on last question submits
- [ ] Single-question prompts submit directly

---

### Task 3.4: Right-align Kbd hints and standardize option spacing in QuestionPrompt

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Task 3.1, 3.2, 3.3

**Technical Requirements**:

- Labels get `flex items-center` layout
- Kbd badge uses `ml-auto shrink-0` after description
- Remove `isActive` conditional on Kbd visibility (always visible)
- Update in all three locations: single-select, multi-select, "Other" option
- Container spacing from `space-y-0.5` to `space-y-1`

**Implementation Steps**:

1. Update single-select option labels
2. Update multi-select option labels
3. Update "Other" option label
4. Change `space-y-0.5` to `space-y-1` on RadioGroup and checkbox group

**Acceptance Criteria**:

- [ ] Kbd badges right-aligned via `ml-auto shrink-0`
- [ ] Kbd badges always visible (no `isActive` guard)
- [ ] Labels use `flex items-center`
- [ ] Option spacing is `space-y-1`
- [ ] All three option locations updated

---

## Phase 4: Testing & Polish

### Task 4.1: Add tests for CompactPendingRow component

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.2
**Can run parallel with**: Task 4.2, 4.3, 4.4

**Technical Requirements**:

- Test file: `apps/client/src/layers/features/chat/__tests__/CompactPendingRow.test.tsx`
- Test both type variants, spinning loader, data-testid forwarding, class matching with CompactResultRow

**Acceptance Criteria**:

- [ ] 5 test cases passing
- [ ] Covers both approval and question types

---

### Task 4.2: Add tests for ChatInputContainer mode switching

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.1, Task 2.3
**Can run parallel with**: Task 4.1, 4.3, 4.4

**Technical Requirements**:

- Test file: `apps/client/src/layers/features/chat/__tests__/ChatInputContainer.test.tsx`
- Test normal mode rendering, approval mode, question mode, hidden elements during interactive mode
- Requires mock Transport and QueryClient providers

**Acceptance Criteria**:

- [ ] Tests cover normal and both interactive modes
- [ ] Tests verify hidden elements during interactive mode

---

### Task 4.3: Update QuestionPrompt tests for Back/Next, Kbd position, and Enter behavior

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.2, 3.3, 3.4
**Can run parallel with**: Task 4.1, 4.2, 4.4

**Technical Requirements**:

- Update existing tab navigation tests to use Back/Next buttons
- Add Kbd `ml-auto` class assertion
- Add Enter-advances-question imperative handle tests
- Add `space-y-1` spacing assertion
- Add step indicator assertion

**Acceptance Criteria**:

- [ ] Tab tests replaced with Back/Next button tests
- [ ] Kbd positioning verified
- [ ] Enter behavior verified (advance vs submit)
- [ ] Spacing verified

---

### Task 4.4: Update useInteractiveShortcuts tests for relaxed textarea guard

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.1
**Can run parallel with**: Task 4.1, 4.2, 4.3

**Technical Requirements**:

- Test ArrowUp/ArrowDown from textarea
- Test digits and Space blocked in textarea
- Test Enter from textarea

**Acceptance Criteria**:

- [ ] Arrow key tests from textarea context
- [ ] Digit/Space blocking tests
- [ ] Enter submission test from textarea

---

### Task 4.5: Run full test suite and verify all acceptance criteria

**Size**: Medium
**Priority**: High
**Dependencies**: Task 4.1, 4.2, 4.3, 4.4
**Can run parallel with**: None

**Technical Requirements**:

- Run `pnpm test -- --run`, `pnpm typecheck`, `pnpm lint`
- Fix any failures
- Verify all 15 acceptance criteria from spec Section 9
- Check dev playground showcases for needed updates

**Acceptance Criteria**:

- [ ] Full test suite passes
- [ ] Type checking passes
- [ ] Linting passes
- [ ] All 15 spec acceptance criteria verified
