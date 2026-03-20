# Task Breakdown: Chat Input Always Editable + Message Queuing

Generated: 2026-03-10
Source: specs/chat-input-always-editable/02-specification.md
Last Decompose: 2026-03-10

## Overview

Transform the chat input from a fully-disabled-during-streaming model to an always-editable textarea with a FIFO message queue. Phase 1 decouples disabled states so users can type during streaming. Phase 2 adds a message queue with inline card display, three-state send button, auto-flush on stream completion, and timing annotations. Phase 3 adds shell-history arrow-key navigation, mobile polish, and integration tests.

## Phase 1: Always-Editable Input

### Task 1.1: Decouple disabled states and make textarea always editable during streaming

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- Split `isDisabled = isLoading || sessionBusy` into `isInputDisabled = sessionBusy` and `isSubmitDisabled = isLoading || sessionBusy`
- Textarea only disabled by `sessionBusy`, not by `isLoading`
- Paperclip button always enabled (remove `disabled` prop)
- Clear button works during streaming: `showClear = hasText && !sessionBusy`
- Enter key guarded: `!isLoading && !sessionBusy && value.trim()`

**Implementation Steps**:

1. Replace `const isDisabled = isLoading || sessionBusy` with two separate booleans
2. Apply `isInputDisabled` to textarea `disabled` prop
3. Remove `disabled` from paperclip button entirely
4. Update `showClear` to allow clearing during streaming
5. Add `!sessionBusy` guard to Enter key submission
6. Update and add tests in `ChatInput.test.tsx`

**Acceptance Criteria**:

- [ ] Textarea remains editable when `isLoading=true` (streaming)
- [ ] Textarea is disabled when `sessionBusy=true`
- [ ] Enter key does not submit during streaming
- [ ] Clear button works during streaming
- [ ] Paperclip button works during streaming
- [ ] All existing tests updated and passing
- [ ] New regression tests written and passing

---

### Task 1.2: Add dynamic placeholder and isStreaming prop threading

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- Add optional `placeholder` prop to `ChatInputProps` (default: "Message Claude...")
- Compute dynamic placeholder in `ChatInputContainer` based on `status`
- Streaming placeholder: "Compose next — will send when ready"
- Idle placeholder: "Message Claude..."

**Implementation Steps**:

1. Add `placeholder?: string` to `ChatInputProps` in `ChatInput.tsx`
2. Replace hardcoded `placeholder="Message Claude..."` with `placeholder={placeholder}`
3. Compute placeholder in `ChatInputContainer` based on `status === 'streaming'`
4. Pass computed placeholder to `ChatInput`
5. Add tests for custom and default placeholders

**Acceptance Criteria**:

- [ ] Placeholder changes during streaming
- [ ] Placeholder reverts to default when idle
- [ ] Custom placeholder prop works correctly
- [ ] Tests written and passing

---

## Phase 2: Message Queue Core

### Task 2.1: Create useMessageQueue hook with queue state and auto-flush

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- `QueueItem` interface: `{ id: string; content: string; createdAt: number }`
- Queue state via `useState<QueueItem[]>([])`
- Editing state via `useState<number | null>(null)`
- Auto-flush on `streaming -> idle` transition with timing annotation prefix
- Auto-flush skips the item being edited
- Queue clears on sessionId or selectedCwd change
- CRUD methods: addToQueue, updateQueueItem, removeFromQueue, startEditing, cancelEditing, saveEditing, clearQueue

**Implementation Steps**:

1. Create `apps/client/src/layers/features/chat/model/use-message-queue.ts`
2. Implement queue state management with `useState`
3. Implement auto-flush effect with `prevStatusRef` transition detection
4. Implement cleanup effect on session/cwd change
5. Implement all CRUD methods with `useCallback`
6. Write 16 unit tests

**Acceptance Criteria**:

- [ ] All CRUD methods work correctly
- [ ] Auto-flush fires only on streaming-to-idle transition
- [ ] Timing annotation prepended to flushed content
- [ ] Auto-flush skips items being edited
- [ ] Queue clears on session/cwd change
- [ ] 16 tests written and passing

---

### Task 2.2: Add submitContent method to useChatSession

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- New `submitContent(content: string)` method accepts content directly
- Does NOT clear `input` state (preserves user's current draft)
- Same streaming guard, session creation, error handling as `handleSubmit`
- Shared submission logic extracted to avoid code duplication

**Implementation Steps**:

1. Extract common submission logic from `handleSubmit` into a private helper
2. Create `submitContent` that calls the helper without clearing input
3. Update `handleSubmit` to use the same helper
4. Return `submitContent` from the hook
5. Write 4 tests

**Acceptance Criteria**:

- [ ] `submitContent` submits without touching `input` state
- [ ] Guards against streaming status and empty content
- [ ] Session creation logic works for first message
- [ ] Error handling matches `handleSubmit`
- [ ] Tests written and passing

---

### Task 2.3: Create QueuePanel component with stagger animations

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Task 2.4

**Technical Requirements**:

- AnimatePresence with stagger children (0.05s interval)
- Spring physics: stiffness 320, damping 28
- Exit animation: opacity 0, scale 0.95, 150ms
- Cards: numbered, truncated single-line, click-to-edit
- Remove button: hover-gated on desktop, always visible on mobile
- Editing state: left accent border, muted background
- Stable React keys via `item.id`

**Implementation Steps**:

1. Create `apps/client/src/layers/features/chat/ui/QueuePanel.tsx`
2. Implement stagger animation variants
3. Implement card layout with numbering and truncation
4. Implement remove button with stopPropagation
5. Implement editing highlight state
6. Write 7 tests

**Acceptance Criteria**:

- [ ] Returns null when queue is empty
- [ ] Cards show numbered, truncated text
- [ ] Click triggers onEdit, x triggers onRemove
- [ ] Editing state shows accent border
- [ ] Animations use correct spring physics
- [ ] 7 tests written and passing

---

### Task 2.4: Implement three-state button and queue-aware Enter key in ChatInput

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 2.3

**Technical Requirements**:

- Replace `isLoading` prop with `isStreaming` + `isUploading`
- Button state machine: send/stop/queue/update/hidden
- Queue badge on queue button showing depth count
- Enter key priority chain: edit save > queue > submit
- Editing visual state: accent border, editing label
- Import Clock and Check icons from lucide-react

**Implementation Steps**:

1. Update `ChatInputProps` with new props
2. Implement `ButtonState` derivation logic
3. Create `buttonConfig` mapping for icon, className, label, onClick
4. Render queue badge when queue button active and depth > 0
5. Update Enter key handler with priority chain
6. Add editing label and accent border
7. Update all existing tests for `isStreaming` rename
8. Write 10 new tests

**Acceptance Criteria**:

- [ ] Button correctly shows send/stop/queue/update based on state
- [ ] Enter key priority chain works correctly
- [ ] Queue badge shows correct count
- [ ] Editing label and border accent appear
- [ ] All existing tests updated and passing
- [ ] 10 new tests written and passing

---

### Task 2.5: Wire useMessageQueue into ChatPanel and thread props through ChatInputContainer

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2, Task 2.3, Task 2.4
**Can run parallel with**: None

**Technical Requirements**:

- Instantiate `useMessageQueue` in ChatPanel with `onFlush: submitContent`
- Draft preservation via `draftRef` for arrow key navigation
- Create queue action handlers: handleQueue, handleQueueEdit, handleQueueSaveEdit, handleQueueCancelEdit, handleQueueRemove
- Add queue props to `ChatInputContainerProps`
- Render QueuePanel between FileChipBar and ChatInput
- Thread all props through ChatInputContainer to ChatInput
- Update dynamic placeholder with queue count

**Implementation Steps**:

1. Import and instantiate useMessageQueue in ChatPanel
2. Create draft preservation ref and navigation handlers
3. Create all queue action handlers
4. Update ChatInputContainerProps interface
5. Render QueuePanel in ChatInputContainer
6. Thread all queue props to ChatInput
7. Update dynamic placeholder logic
8. Verify TypeScript compilation

**Acceptance Criteria**:

- [ ] useMessageQueue wired with submitContent as onFlush
- [ ] QueuePanel rendered in correct position
- [ ] All handlers properly thread through
- [ ] Draft preservation works
- [ ] Dynamic placeholder includes queue count
- [ ] All existing tests pass
- [ ] TypeScript compiles cleanly

---

## Phase 3: Shell-History Navigation & Polish

### Task 3.1: Implement arrow key queue navigation with cursor position gating

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.4
**Can run parallel with**: Task 3.2, Task 3.3

**Technical Requirements**:

- ArrowUp navigates to queue when: textarea empty OR cursor at position 0
- ArrowDown navigates forward when: editing queue item AND cursor at end
- Palette open takes priority over queue navigation
- Escape cancels edit when editing a queue item
- Navigation block inserted BEFORE palette-open block in handleKeyDown

**Implementation Steps**:

1. Add queue navigation block before palette-open interception
2. Implement cursor position gating (selectionStart/selectionEnd)
3. Add Escape-to-cancel-edit before existing Escape logic
4. Update handleKeyDown dependency array
5. Write 9 tests

**Acceptance Criteria**:

- [ ] ArrowUp navigates when empty or cursor at start
- [ ] ArrowUp does NOT navigate when palette is open
- [ ] ArrowDown navigates only when editing and cursor at end
- [ ] Escape cancels edit
- [ ] 9 tests written and passing

---

### Task 3.2: Mobile polish and barrel export updates

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.5
**Can run parallel with**: Task 3.1, Task 3.3

**Technical Requirements**:

- Remove button always visible on mobile (opacity-100 < md, hover-gated >= md)
- Barrel export: `useMessageQueue` and `QueueItem` type from `features/chat/index.ts`
- QueuePanel NOT exported from barrel
- Mobile Enter key continues to insert newline

**Implementation Steps**:

1. Update QueuePanel remove button classes for responsive visibility
2. Add exports to `features/chat/index.ts`
3. Verify mobile behavior unchanged

**Acceptance Criteria**:

- [ ] Remove button visible on mobile
- [ ] Remove button hover-gated on desktop
- [ ] Barrel exports updated
- [ ] Mobile Enter inserts newline

---

### Task 3.3: Write integration tests for full queue workflow

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.5
**Can run parallel with**: Task 3.1, Task 3.2

**Technical Requirements**:

- Full workflow test: queue during streaming, auto-flush on idle
- Timing annotation format verification
- Arrow key navigation with draft preservation
- Edit and save workflow
- Session change cleanup
- Auto-flush skip-editing behavior
- Double-flush prevention

**Implementation Steps**:

1. Create `queue-integration.test.tsx` with renderHook-based tests
2. Test complete queue-then-flush lifecycle
3. Test navigation cycling through items
4. Test edit/save/cancel workflows
5. Test session change cleanup
6. Test edge cases (skip editing, double flush)
7. Write 7 integration tests

**Acceptance Criteria**:

- [ ] Full workflow end-to-end tested
- [ ] Timing annotation format correct
- [ ] Navigation and draft preservation work
- [ ] Session cleanup verified
- [ ] Double-flush prevented
- [ ] 7 integration tests written and passing
