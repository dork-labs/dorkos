# Unified Input Zone for Interactive Cards — Specification

**Spec:** 145
**Slug:** interactive-card-focus-navigation
**Author:** Claude Code
**Date:** 2026-03-17
**Status:** specification

---

## 1. Overview

Transform the chat input zone into a unified interaction surface that adapts to conversation requirements. When the agent needs user input (tool approval or question answers), the `ChatInputContainer` replaces its normal content (textarea, file chips, queue, autocomplete, status section) with the interactive card UI. The message stream shows only compact placeholders. This eliminates dual focus zones and creates a single, predictable interaction point.

### Goals

- Eliminate the dual-focus problem: interactive cards in the message stream compete with the input zone for attention
- Create a single, predictable interaction point at the bottom of the chat (the input zone)
- Reduce the in-stream footprint of pending interactive tools to a compact single-line indicator
- Simplify keyboard shortcut architecture by leveraging natural input zone focus
- Replace the multi-question tab strip with sequential Back/Next buttons and a step indicator
- Right-align Kbd hints after option labels for visual consistency with industry conventions
- Standardize option row vertical spacing

### Non-Goals

- Touch/gesture navigation
- Mobile-specific input zone adaptations
- Changes to ToolApproval countdown timer behavior (relocates as-is)
- Changes to server-side tool approval/question event format
- Redesigning option row visual style beyond spacing and Kbd position
- Adding a focus trap (the input zone naturally captures keyboard events)

---

## 2. User Decisions

These decisions were made during ideation and are final:

| #   | Decision                         | Choice                                                                  | Rationale                                                                                                                 |
| --- | -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where interactive cards render   | Input zone transformation                                               | Eliminates dual focus. Matches Claude Code Desktop pattern. The message stream is history; the input zone is the present. |
| 2   | Kbd hint position                | After label, right-aligned                                              | Industry standard (Linear, VS Code, GitHub). WCAG accessible name ordering.                                               |
| 3   | Arrow keys in textarea           | Up/Down always navigate options                                         | Consistent behavior. Shift+Enter for newlines in "Other" text.                                                            |
| 4   | Multi-question navigation        | Replace tab strip with Back/Next buttons + step indicator               | Simpler, more focused sequential flow. Left/Right arrows for keyboard nav.                                                |
| 5   | Draft handling when card appears | Replace input entirely, preserve draft invisibly                        | All input-related elements hidden. Draft text and pending files restored after resolution.                                |
| 6   | In-stream placeholder            | Compact pending indicator (single-line, matches CompactResultRow style) | Minimal stream footprint while interaction is handled in the input zone.                                                  |
| 7   | Transition animation             | Crossfade with shared container                                         | Outer shell stays stable, inner content crossfades via AnimatePresence.                                                   |

---

## 3. Architecture & Data Flow

### Current Data Flow

```
1. Server sends tool_call via SSE
2. stream-event-handler processes event, adds to message store (toolCalls array)
3. useChatSession.pendingInteractions derives activeInteraction from pending tool calls
4. AssistantMessageContent renders ToolApproval/QuestionPrompt inline in the stream
5. useToolShortcuts + useInteractiveShortcuts bind document-level keydown listener
6. User interacts -> imperative handle -> transport method -> server responds
```

### New Data Flow

```
1. Server sends tool_call via SSE (unchanged)
2. stream-event-handler processes event, adds to message store (unchanged)
3. useChatSession.pendingInteractions derives activeInteraction (unchanged)
4. Message stream shows CompactPendingRow placeholder (NOT full interactive card)
5. ChatInputContainer detects activeInteraction and switches to interactive mode
6. Interactive card (ToolApproval or QuestionPrompt) renders inside the input zone
7. Keyboard events captured naturally by the focused input zone
8. User interacts -> transport method -> resolved: CompactResultRow in stream,
   input zone crossfades back to normal mode
```

### Key Architectural Change

The `activeInteraction` object (already computed in `useChatSession` and threaded through `ChatPanel`) becomes the signal for `ChatInputContainer` to switch modes. No new state management is needed — the existing `activeInteraction` drives the mode switch.

### Props Threading (New)

`ChatPanel` already has `activeInteraction` from `useChatSession`. It needs to pass this plus the tool shortcut state down to `ChatInputContainer`:

```typescript
// New props on ChatInputContainer
activeInteraction: ActiveInteraction | null;
focusedOptionIndex: number;
onToolRef: (handle: InteractiveToolHandle | null) => void;
onToolDecided: () => void;
```

`AssistantMessageContent` needs to know whether a given tool call is being handled in the input zone (to render placeholder vs full card):

```typescript
// New prop on MessageList -> MessageItem -> MessageContext
inputZoneToolCallId: string | null;
```

---

## 4. Detailed Design

### 4.1 ChatInputContainer Mode Switching

Add a `mode` concept to `ChatInputContainer`:

- **`normal`**: Shows ChatInput, FileChipBar, QueuePanel, CommandPalette, FilePalette, ChatStatusSection (current behavior)
- **`interactive`**: Shows the active interactive card (ToolApproval or QuestionPrompt)

**New props on `ChatInputContainerProps`:**

```typescript
interface ChatInputContainerProps {
  // ... all existing props ...

  /** The currently active interactive tool awaiting user input, or null. */
  activeInteraction: {
    toolCallId: string;
    interactiveType?: string;
    toolName: string;
    input: string;
    questions?: QuestionItem[];
    answers?: Record<string, string>;
    timeoutMs?: number;
  } | null;
  /** Index of the currently keyboard-focused option (question prompts). */
  focusedOptionIndex: number;
  /** Ref callback to attach to the interactive tool's imperative handle. */
  onToolRef: (handle: InteractiveToolHandle | null) => void;
  /** Called after the user approves/denies/submits to clear waiting state. */
  onToolDecided: () => void;
}
```

**Mode derivation:**

```typescript
const mode = activeInteraction ? 'interactive' : 'normal';
```

**Draft text preservation:**

```typescript
const interactiveDraftRef = useRef('');

// When entering interactive mode, save the current input
useEffect(() => {
  if (activeInteraction) {
    interactiveDraftRef.current = input;
  }
}, [activeInteraction?.toolCallId]);

// When leaving interactive mode, restore the draft
useEffect(() => {
  if (!activeInteraction && interactiveDraftRef.current) {
    setInput(interactiveDraftRef.current);
    interactiveDraftRef.current = '';
    // Re-focus the textarea after restoring
    chatInputRef.current?.focus();
  }
}, [activeInteraction, setInput]);
```

Note: `interactiveDraftRef` is separate from the existing `draftRef` in `ChatPanel` used for queue navigation. They serve different purposes and do not conflict. The `interactiveDraftRef` lives inside `ChatInputContainer` because it manages the container's mode transition, while the queue `draftRef` lives in `ChatPanel` because it manages queue navigation state.

**Render structure:**

```tsx
<div
  {...getRootProps()}
  onPaste={handlePaste}
  className="chat-input-container bg-surface relative m-2 rounded-xl border p-2"
>
  <input {...getInputProps()} />

  {/* Drag overlay — always rendered */}
  <AnimatePresence>
    {isDragActive && (/* existing drag overlay */)}
  </AnimatePresence>

  {/* Inner content crossfade */}
  <AnimatePresence mode="wait">
    {mode === 'interactive' ? (
      <motion.div
        key="interactive"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
      >
        {activeInteraction.interactiveType === 'approval' ? (
          <ToolApproval
            ref={onToolRef}
            sessionId={sessionId}
            toolCallId={activeInteraction.toolCallId}
            toolName={activeInteraction.toolName}
            input={activeInteraction.input}
            isActive
            onDecided={onToolDecided}
            timeoutMs={activeInteraction.timeoutMs}
          />
        ) : (
          <QuestionPrompt
            ref={onToolRef}
            sessionId={sessionId}
            toolCallId={activeInteraction.toolCallId}
            questions={activeInteraction.questions!}
            answers={activeInteraction.answers}
            isActive
            focusedOptionIndex={focusedOptionIndex}
          />
        )}
      </motion.div>
    ) : (
      <motion.div
        key="normal"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
      >
        {/* All existing normal-mode content: palettes, file chips, queue, input, status */}
      </motion.div>
    )}
  </AnimatePresence>
</div>
```

The outer container div (`chat-input-container bg-surface rounded-xl border`) stays stable. Only the inner content swaps via `AnimatePresence mode="wait"`, producing a crossfade effect.

### 4.2 In-Stream Placeholder: CompactPendingRow

Create a new `CompactPendingRow` component as a "pending" variant alongside `CompactResultRow` in the primitives directory.

**File:** `apps/client/src/layers/features/chat/ui/primitives/CompactPendingRow.tsx`

```typescript
import { Loader2 } from 'lucide-react';

interface CompactPendingRowProps {
  /** Type of interaction being handled in the input zone. */
  type: 'approval' | 'question';
  'data-testid'?: string;
}

/** Compact single-line placeholder for interactions handled in the input zone. */
export function CompactPendingRow({ type, ...dataProps }: CompactPendingRowProps) {
  const label = type === 'approval'
    ? 'Waiting for approval...'
    : 'Answering questions...';

  return (
    <div
      className="bg-muted/50 rounded-msg-tool border px-3 py-1 text-sm text-muted-foreground
                 shadow-msg-tool transition-all duration-150"
      {...dataProps}
    >
      <div className="flex items-center gap-2">
        <Loader2 className="size-(--size-icon-sm) shrink-0 animate-spin" />
        <span className="text-xs">{label}</span>
      </div>
    </div>
  );
}
```

Style matches `CompactResultRow` exactly (`bg-muted/50 rounded-msg-tool border px-3 py-1 text-sm shadow-msg-tool`) with `text-muted-foreground` for the pending state and a spinning `Loader2` icon as the animated indicator.

**Export from primitives barrel:**

Add `CompactPendingRow` to `apps/client/src/layers/features/chat/ui/primitives/index.ts`.

### 4.3 AssistantMessageContent Rendering Changes

`AssistantMessageContent` needs to know which tool call is currently being handled in the input zone, so it can render a placeholder instead of the full interactive card.

**New prop via MessageContext:** `inputZoneToolCallId: string | null`

This is threaded from `ChatPanel` -> `MessageList` -> `MessageItem` -> `MessageContext`.

**Rendering logic change:**

```typescript
// For approval parts
if (toolPart.interactiveType === 'approval') {
  // If this tool is being handled in the input zone, show placeholder
  if (toolPart.toolCallId === inputZoneToolCallId) {
    return <CompactPendingRow key={toolPart.toolCallId} type="approval" />;
  }
  // Otherwise render normally (history replay, already decided, etc.)
  const isActive = toolPart.toolCallId === activeToolCallId;
  return (
    <ToolApproval
      key={toolPart.toolCallId}
      ref={isActive ? approvalRefCallback : undefined}
      sessionId={sessionId}
      toolCallId={toolPart.toolCallId}
      toolName={toolPart.toolName}
      input={toolPart.input ?? ''}
      isActive={isActive}
      onDecided={onToolDecided}
      timeoutMs={toolPart.timeoutMs}
    />
  );
}

// Same pattern for question parts
if (toolPart.interactiveType === 'question' && toolPart.questions) {
  if (toolPart.toolCallId === inputZoneToolCallId) {
    return <CompactPendingRow key={toolPart.toolCallId} type="question" />;
  }
  // Already-answered questions render CompactResultRow (existing behavior)
  // Active but NOT in input zone: render full card (shouldn't happen in normal flow)
  const isActive = toolPart.toolCallId === activeToolCallId;
  return (
    <QuestionPrompt
      key={toolPart.toolCallId}
      ref={isActive ? questionRefCallback : undefined}
      sessionId={sessionId}
      toolCallId={toolPart.toolCallId}
      questions={toolPart.questions}
      answers={toolPart.answers}
      isActive={isActive}
      focusedOptionIndex={focusedOptionIndex}
    />
  );
}
```

**History replay:** When `answers` is provided (pre-submitted from history), `QuestionPrompt` renders `CompactResultRow` directly. When `decided` is set on `ToolApproval`, it renders `CompactResultRow` directly. No input zone involvement for historical data. This is the existing behavior and remains unchanged.

**Transition from pending to resolved:** When the user acts in the input zone, the tool call's status transitions from `pending` to another state. The `CompactPendingRow` placeholder in the stream transitions to `CompactResultRow` (for approvals) or collapsed submitted state (for questions) as the component re-renders with the updated tool call state.

### 4.4 Keyboard Navigation Changes

#### ToolApproval in Input Zone

When rendered in the input zone, the card is always the active interaction. The `isActive` prop is always `true` (hardcoded in the ChatInputContainer render). Keyboard shortcuts:

- **Enter** -> approve
- **Escape** -> deny
- Kbd hints always visible (no conditional on `isActive`)

No changes needed to ToolApproval internals — it already supports `isActive={true}`.

#### QuestionPrompt in Input Zone

When rendered in the input zone, always active. Keyboard shortcuts:

- **Up/Down arrows** -> navigate options (even when "Other" textarea is focused)
- **Left/Right arrows** -> navigate between questions (Back/Next)
- **Number keys 1-9** -> select option
- **Enter** -> Next question (or Submit on last question)
- **Space** -> toggle focused option
- Kbd hints always visible

**Key behavioral change for Enter:** Currently, Enter always submits. In the new flow, Enter advances to the next question when not on the last question, and submits only on the last question. This is implemented inside `QuestionPrompt` itself by checking the active tab index against the total question count.

**Key behavioral change for useInteractiveShortcuts:** The `isTextInput` guard currently prevents arrow keys from working when a textarea is focused. For the input zone approach, Up/Down should always navigate options regardless of focus target. The guard should be relaxed:

```typescript
// Current: text input blocks everything except Enter/Esc
if (isTextInput) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSubmit?.();
  }
  return;
}

// New: text input blocks digits/space but allows arrows and Enter
if (isTextInput) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSubmit?.();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    onNavigateOption?.('up');
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    onNavigateOption?.('down');
    return;
  }
  // Block digits and space in text input (let them type normally)
  return;
}
```

This allows Up/Down arrows to navigate options even when the "Other" textarea is focused. Users use Shift+Enter for newlines in the textarea.

#### Enter Key for Multi-Question Advancement

The `onSubmit` callback in `useToolShortcuts` currently calls `handle.submit()` directly. To support the "Enter advances to next question" behavior, the submit logic needs a check:

```typescript
// In useToolShortcuts:
const onSubmit = useCallback(() => {
  const handle = activeToolHandleRef.current;
  if (handle && 'submit' in handle) {
    if ('navigateQuestion' in handle && 'getActiveTab' in handle) {
      // For question prompts: if not on last question, advance instead of submit
      // The QuestionPrompt component handles this internally via its submit() method
    }
    handle.submit();
  }
}, []);
```

The cleaner approach is to modify `QuestionPrompt.submit()` to check if there are more questions and advance instead of submitting:

```typescript
// In QuestionPrompt imperative handle:
submit() {
  if (activeTabIndex < questions.length - 1) {
    // Advance to next question
    setActiveTabIndex(activeTabIndex + 1);
    // Reset focused option for the new question
    return;
  }
  // On last question: actually submit
  handleSubmit();
}
```

This keeps the submit logic self-contained in QuestionPrompt.

### 4.5 Multi-Question Back/Next Buttons

Replace the existing `TabsList` with a sequential navigation UI.

**Current (TabsList):**

```tsx
<TabsList>
  {questions.map((q, i) => (
    <TabsTrigger key={i} value={String(i)}>
      {q.header}
    </TabsTrigger>
  ))}
</TabsList>
```

**New (Step indicator + Back/Next buttons):**

```tsx
<div className="mb-2 flex items-center justify-between">
  <span className="text-muted-foreground text-xs">
    {questions[activeIndex].header ?? `Question ${activeIndex + 1} of ${questions.length}`}
  </span>
  <div className="flex items-center gap-1.5">
    <Button
      size="sm"
      variant="ghost"
      onClick={() => navigateQuestion('prev')}
      disabled={activeIndex === 0}
      className="h-7 px-2 text-xs"
    >
      Back {<Kbd className="ml-1">&larr;</Kbd>}
    </Button>
    {activeIndex < questions.length - 1 ? (
      <Button size="sm" onClick={() => navigateQuestion('next')} className="h-7 px-2 text-xs">
        Next {<Kbd className="ml-1">&rarr;</Kbd>}
      </Button>
    ) : (
      <Button
        size="sm"
        onClick={handleSubmit}
        disabled={!isComplete() || submitting}
        className="h-7 px-2 text-xs"
      >
        <Check className="size-(--size-icon-xs)" /> Submit
        {<Kbd className="ml-1">Enter</Kbd>}
      </Button>
    )}
  </div>
</div>
```

The underlying `Tabs` / `TabsContent` component can still be used for content switching (hidden `TabsList` or controlled via `value` prop), but the visible navigation is the Back/Next buttons with the step indicator.

**Keyboard mapping:**

- Left arrow / `[` -> Back (existing `navigateQuestion('prev')`)
- Right arrow / `]` -> Next (existing `navigateQuestion('next')`)
- Enter -> Next (or Submit on last question, via modified `submit()`)

### 4.6 OptionRow Kbd Hint Repositioning

Move Kbd badges from inline after the label to right-aligned within the row.

**Current OptionRow children pattern (inside QuestionPrompt):**

```tsx
<OptionRow isSelected={isSelected} isFocused={isFocused} control={<RadioGroupItem ... />}>
  <label className="flex-1 cursor-pointer">
    <span className="text-sm font-medium">{opt.label}</span>
    <Kbd className="ml-1.5 text-2xs text-muted-foreground">{oIdx + 1}</Kbd>
    {opt.description && (
      <span className="text-muted-foreground ml-1.5 text-xs"> — {opt.description}</span>
    )}
  </label>
</OptionRow>
```

**New pattern:**

```tsx
<OptionRow isSelected={isSelected} isFocused={isFocused} control={<RadioGroupItem ... />}>
  <label className="flex flex-1 cursor-pointer items-center">
    <span className="text-sm font-medium">{opt.label}</span>
    {opt.description && (
      <span className="text-muted-foreground ml-1.5 text-xs"> — {opt.description}</span>
    )}
    {oIdx < 9 && (
      <Kbd className="text-2xs text-muted-foreground ml-auto shrink-0">{oIdx + 1}</Kbd>
    )}
  </label>
</OptionRow>
```

Key changes:

- Label uses `flex items-center` layout
- Kbd badge uses `ml-auto shrink-0` to push it to the right edge
- The `isActive` conditional on Kbd visibility is removed — when rendered in the input zone, hints are always visible
- Description stays inline between label text and Kbd

### 4.7 Option Row Spacing Standardization

The option list container should use consistent spacing:

```tsx
{/* Single-select */}
<RadioGroup className="ml-1 space-y-1" ...>
  {options.map(...)}
</RadioGroup>

{/* Multi-select */}
<div role="group" className="ml-1 space-y-1" ...>
  {options.map(...)}
</div>
```

`OptionRow` padding is already standardized at `px-2 py-1` (from the question-prompt-redesign spec). The container spacing changes from `space-y-0.5` to `space-y-1` for slightly more breathing room between options.

### 4.8 ToolApproval and QuestionPrompt Rendering Context

Both components need to work in two contexts:

1. **Input zone** (new): Always active, always focused. `isActive={true}` is hardcoded by `ChatInputContainer`.
2. **In-stream** (existing, for edge cases): For already-decided/answered history items. `CompactResultRow` rendering is self-contained in each component and does not need the input zone.

No changes to the `isActive` prop API are needed. The prop continues to control visual treatment (focus ring, Kbd visibility for in-stream rendering). When rendered in the input zone, it's simply always `true`.

The `InteractiveCard` wrapper styling remains unchanged. When `isActive={true}`, it shows `ring-2 ring-ring/30`. When the component renders in the input zone, this ring reinforces the active state visually within the input container's border.

### 4.9 Multiple Pending Interactions (Queue)

`useChatSession` already computes `pendingInteractions` as an array and exposes `activeInteraction = pendingInteractions[0]`. This means the input zone shows the oldest pending interaction first. When it resolves, the next pending interaction becomes `activeInteraction` and the input zone switches to it.

The `inputZoneToolCallId` passed to the message stream is `activeInteraction?.toolCallId ?? null`. Only one tool call shows a `CompactPendingRow` at a time. Other pending interactions that are not yet active render as full interactive cards in the stream (with `isActive={false}`, dimmed at `opacity-60`). When the active one resolves, the next one becomes active and moves to the input zone.

This matches the existing behavior where only one interaction is "active" at a time, but now the active one renders in the input zone instead of in the stream.

---

## 5. Files Changed

### New Files

| File                                                                       | Purpose                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/client/src/layers/features/chat/ui/primitives/CompactPendingRow.tsx` | Compact spinning-loader placeholder for interactions handled in the input zone |

### Modified Files

| File                                                                          | Changes                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx`              | Add `activeInteraction`, `focusedOptionIndex`, `onToolRef`, `onToolDecided` props. Add mode switching (normal vs interactive). Add draft preservation via `interactiveDraftRef`. Add AnimatePresence crossfade between modes. Render ToolApproval or QuestionPrompt in interactive mode. |
| `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`                       | Thread `activeInteraction` (enriched with tool data), `focusedOptionIndex`, `handleToolRef`, `markToolCallResponded` to ChatInputContainer. Compute `inputZoneToolCallId` and pass to MessageList.                                                                                       |
| `apps/client/src/layers/features/chat/ui/MessageList.tsx`                     | Accept and thread `inputZoneToolCallId` prop.                                                                                                                                                                                                                                            |
| `apps/client/src/layers/features/chat/ui/message/MessageItem.tsx`             | Thread `inputZoneToolCallId` through MessageContext.                                                                                                                                                                                                                                     |
| `apps/client/src/layers/features/chat/ui/message/MessageContext.tsx`          | Add `inputZoneToolCallId: string \| null` to context shape.                                                                                                                                                                                                                              |
| `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` | Read `inputZoneToolCallId` from MessageContext. Render `CompactPendingRow` when tool call matches. Import CompactPendingRow.                                                                                                                                                             |
| `apps/client/src/layers/features/chat/ui/primitives/index.ts`                 | Export `CompactPendingRow`.                                                                                                                                                                                                                                                              |
| `apps/client/src/layers/features/chat/ui/QuestionPrompt.tsx`                  | Replace TabsList with Back/Next buttons + step indicator. Modify `submit()` imperative handle to advance question before submitting on last. Reposition Kbd badges to right-aligned (ml-auto). Update option container spacing to `space-y-1`.                                           |
| `apps/client/src/layers/shared/model/use-interactive-shortcuts.ts`            | Relax `isTextInput` guard to allow ArrowUp/ArrowDown even when textarea is focused.                                                                                                                                                                                                      |

### Potentially Modified Files

| File                                                               | Condition                                                                                                                                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`   | May need to enrich `activeInteraction` with tool call data (toolName, input, questions, timeoutMs) if not already available. Currently exposes only `toolCallId` and `interactiveType`. |
| `apps/client/src/layers/features/chat/model/chat-types.ts`         | May need to export an enriched `ActiveInteraction` type with tool call details.                                                                                                         |
| `apps/client/src/layers/features/chat/model/use-tool-shortcuts.ts` | May need minor adjustments for the Enter-advances-question behavior, though this is primarily handled inside QuestionPrompt.                                                            |
| `apps/client/src/dev/showcases/MessageShowcases.tsx`               | If showcases render interactive tools, may need updates for the new rendering context.                                                                                                  |

---

## 6. Enriching `activeInteraction`

The current `activeInteraction` from `useChatSession` only contains `toolCallId` and `interactiveType`. The input zone needs additional data to render the interactive card: `toolName`, `input`, `questions`, `answers`, `timeoutMs`.

**Option A (Recommended): Enrich at the source.**

Modify the `pendingInteractions` derivation in `use-chat-session.ts` to include the full tool call data:

```typescript
const pendingInteractions = useMemo(() => {
  return messages
    .flatMap((m) => m.toolCalls || [])
    .filter((tc) => tc.interactiveType && tc.status === 'pending');
}, [messages]);

const activeInteraction = pendingInteractions[0] || null;
```

`pendingInteractions` already contains `ToolCallState` objects which have `toolCallId`, `interactiveType`, `toolName`, `input`, `questions`, `answers`, `timeoutMs`, and `status`. The return type of `activeInteraction` just needs to be typed as `ToolCallState | null` instead of the current narrow shape.

**Implementation:** Update the return type in `useChatSession` to expose the full `ToolCallState` for `activeInteraction`. No data computation change needed — the data is already there.

**Option B: Look up in ChatPanel.**

ChatPanel could look up the full tool call from messages using `activeInteraction.toolCallId`. This duplicates the lookup already done in `useChatSession`.

**Decision:** Option A. The data is already computed; we just need to widen the exposed type.

---

## 7. Test Impact

### Tests Requiring Updates

**`apps/client/src/layers/features/chat/__tests__/QuestionPrompt.test.tsx`:**

- Tab navigation tests: Replace TabsList/TabsTrigger assertions with Back/Next button assertions
- Kbd positioning tests: Update expectations for `ml-auto` class on Kbd elements
- Submit behavior tests: Add tests for Enter advancing to next question on non-last questions
- Option spacing tests: Update class assertions from `space-y-0.5` to `space-y-1`

**`apps/client/src/layers/features/chat/__tests__/ToolApproval.test.tsx`:**

- No structural changes needed — ToolApproval component API is unchanged
- May add tests verifying it works correctly with `isActive={true}` (already covered)

**`apps/client/src/layers/features/chat/__tests__/ChatPanel.test.tsx` (or ChatInputContainer tests):**

- New tests for mode switching behavior
- New tests for draft preservation/restoration

**`apps/client/src/layers/shared/model/__tests__/use-interactive-shortcuts.test.ts`:**

- Update tests for relaxed textarea arrow key guard

### New Test Cases

#### ChatInputContainer Mode Switching

```
- renders normal mode content when no activeInteraction
- renders ToolApproval when activeInteraction.interactiveType is 'approval'
- renders QuestionPrompt when activeInteraction.interactiveType is 'question'
- hides file chips, queue panel, autocomplete, status section during interactive mode
- crossfades between normal and interactive mode (AnimatePresence)
- preserves draft text when entering interactive mode
- restores draft text when leaving interactive mode
- focuses textarea after restoring draft
```

#### CompactPendingRow

```
- renders "Waiting for approval..." text for approval type
- renders "Answering questions..." text for question type
- renders spinning loader icon
- matches CompactResultRow visual footprint (same container classes)
```

#### AssistantMessageContent Placeholder

```
- renders CompactPendingRow when tool call matches inputZoneToolCallId
- renders full ToolApproval when tool call does NOT match inputZoneToolCallId
- renders full QuestionPrompt when tool call does NOT match inputZoneToolCallId
- transitions from CompactPendingRow to CompactResultRow when resolved
- renders CompactResultRow directly for history replay (pre-answered)
```

#### QuestionPrompt Back/Next Buttons

```
- renders Back button disabled on first question
- renders Next button on non-last questions
- renders Submit button on last question
- Back button navigates to previous question
- Next button navigates to next question
- Enter key advances to next question on non-last
- Enter key submits on last question
- step indicator shows correct question number and total
```

#### Keyboard Shortcuts in Input Zone Context

```
- ArrowUp navigates options even when textarea is focused
- ArrowDown navigates options even when textarea is focused
- digit keys do not trigger in textarea (type normally)
- Space does not trigger option toggle in textarea
- Enter submits/advances in textarea
```

---

## 8. Implementation Phases

### Phase 1: Foundation — Input Zone Mode Switching

**Estimated effort:** Medium

1. Widen `activeInteraction` return type in `use-chat-session.ts` to expose full `ToolCallState` (see Section 6)
2. Add new props to `ChatInputContainerProps`: `activeInteraction`, `focusedOptionIndex`, `onToolRef`, `onToolDecided`
3. Add `interactiveDraftRef` for draft text preservation
4. Add `mode` derivation (`normal` vs `interactive`)
5. Wrap existing normal-mode content in a `motion.div` with key `"normal"`
6. Add interactive-mode `motion.div` with key `"interactive"` rendering ToolApproval or QuestionPrompt
7. Wrap both in `<AnimatePresence mode="wait">` for crossfade
8. Thread new props from `ChatPanel` to `ChatInputContainer`
9. Verify: interactive cards render in input zone, normal mode works unchanged

### Phase 2: In-Stream Placeholder

**Estimated effort:** Small

1. Create `CompactPendingRow` component in `primitives/`
2. Export from `primitives/index.ts`
3. Add `inputZoneToolCallId` prop to MessageList, MessageItem, MessageContext
4. Thread from ChatPanel (`activeInteraction?.toolCallId ?? null`)
5. Update `AssistantMessageContent` to render `CompactPendingRow` when tool call matches `inputZoneToolCallId`
6. Verify: stream shows placeholder, resolved state shows CompactResultRow, history replay unchanged

### Phase 3: Keyboard & Navigation Overhaul

**Estimated effort:** Medium

1. Update `useInteractiveShortcuts`: relax `isTextInput` guard to allow ArrowUp/ArrowDown
2. Update `QuestionPrompt`: replace `TabsList` with Back/Next buttons + step indicator
3. Update `QuestionPrompt.submit()`: advance to next question on non-last, submit on last
4. Update `QuestionPrompt` option rendering: move Kbd badges to right-aligned (`ml-auto`)
5. Update option container spacing from `space-y-0.5` to `space-y-1`
6. Verify: all keyboard shortcuts work correctly in input zone context
7. Verify: Shift+Enter produces newlines in "Other" textarea

### Phase 4: Testing & Polish

**Estimated effort:** Medium

1. Update `QuestionPrompt.test.tsx` for Back/Next buttons, Kbd positioning, Enter behavior
2. Add ChatInputContainer mode switching tests
3. Add CompactPendingRow tests
4. Add AssistantMessageContent placeholder tests
5. Update `use-interactive-shortcuts` tests for relaxed textarea guard
6. Run full test suite: `pnpm test -- --run`
7. Visual verification in dev playground for all states
8. Dark mode verification

---

## 9. Acceptance Criteria

1. When a tool approval arrives, the input zone transforms to show the approval card with a crossfade animation
2. When a question prompt arrives, the input zone transforms to show the question form with a crossfade animation
3. The message stream shows a compact "Waiting for approval..." or "Answering questions..." placeholder with a spinning indicator instead of the full interactive card
4. All input-related elements (file chips, queue, autocomplete, status section) are hidden during interactive mode
5. The user's draft text is preserved when entering interactive mode and restored when the interaction resolves
6. The textarea is re-focused after draft restoration
7. Keyboard shortcuts work correctly: Enter/Escape for approval, arrows/digits/Enter for questions
8. Multi-question flows use Back/Next buttons with a step indicator instead of tabs
9. Kbd hints appear after labels, right-aligned via `ml-auto`
10. Option row spacing uses `space-y-1` consistently
11. Up/Down arrows navigate options even when the "Other" textarea is focused
12. After interaction resolves, the input zone smoothly crossfades back to normal mode and the stream shows CompactResultRow
13. History replay (pre-answered questions, already-decided approvals) renders CompactResultRow directly in the stream with no input zone involvement
14. Multiple pending interactions are queued — input zone shows the oldest pending one, resolves it, then shows the next
15. Existing tests continue to pass after updates for new rendering context

---

## 10. Risk Assessment

| Risk                                                                    | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft text lost during rapid interaction resolution                     | Low        | Medium | `interactiveDraftRef` is set before mode switch; restore is triggered by `activeInteraction` becoming null. Test this edge case explicitly.                                                                                                                                                                                                                                                                                                                          |
| Keyboard shortcut conflicts between input zone and global listeners     | Medium     | Medium | The `useInteractiveShortcuts` hook already guards on `activeInteraction` being set. When in interactive mode, shortcuts route to the card; when in normal mode, they don't fire. Ensure no double-handling.                                                                                                                                                                                                                                                          |
| AnimatePresence `mode="wait"` causes flash of empty content             | Low        | Low    | The `"wait"` mode ensures the exiting content finishes before entering content starts. With 150ms transitions, this is a very brief crossfade. Test visually.                                                                                                                                                                                                                                                                                                        |
| QuestionPrompt Back/Next changes break multi-question imperative handle | Medium     | Medium | `navigateQuestion` already exists and works. The Tab strip is replaced visually but the underlying Tabs component can still drive content switching via controlled `value` prop.                                                                                                                                                                                                                                                                                     |
| `ToolCallState` type widening causes type errors downstream             | Low        | Low    | `ToolCallState` is already the type of the array items. Widening the return from a narrow pick to the full type only adds optional fields.                                                                                                                                                                                                                                                                                                                           |
| ToolApproval countdown timer resets on re-mount in input zone           | Medium     | High   | The countdown uses `useEffect` with `timeoutMs` as dependency and computes `expiresAt = Date.now() + timeoutMs`. If ToolApproval unmounts from stream and remounts in input zone, the timer restarts. Mitigation: track `expiresAt` at the parent level (ChatInputContainer or ChatPanel) and pass it down instead of `timeoutMs`. Alternatively, ensure ToolApproval only ever mounts once (in the input zone) and the stream shows the placeholder from the start. |

---

## 11. Performance Considerations

- `AnimatePresence` crossfade is lightweight: opacity transition only, 150ms duration
- `CompactPendingRow` is simpler than the full interactive card — the message stream renders less during interaction
- Draft text stored in a ref (no state-driven re-renders during interactive mode)
- `inputZoneToolCallId` is a primitive string comparison, negligible cost per tool call part
- No additional network requests or server-side changes

---

## 12. Security Considerations

- No new user input surfaces — tool approval and question prompt already sanitize input
- No changes to transport layer or server communication
- No new data exposed to the client — `ToolCallState` fields are already available in the message store

---

## 13. Design Reference

### Visual States

| State            | Input Zone                                    | Message Stream                                            |
| ---------------- | --------------------------------------------- | --------------------------------------------------------- |
| No interaction   | Normal mode (textarea, chips, queue, status)  | No interactive cards                                      |
| Pending approval | ToolApproval card (crossfaded in)             | CompactPendingRow ("Waiting for approval...")             |
| Pending question | QuestionPrompt card (crossfaded in)           | CompactPendingRow ("Answering questions...")              |
| Resolved         | Normal mode (crossfaded back, draft restored) | CompactResultRow (approved/denied or answered)            |
| History replay   | Normal mode (no interaction)                  | CompactResultRow (existing behavior)                      |
| Multiple pending | Shows oldest pending                          | CompactPendingRow for active; dimmed full card for others |

### Crossfade Animation Spec

```
Container: stable (no animation)
Exit:  opacity 1 -> 0, duration 150ms, ease-out
Enter: opacity 0 -> 1, duration 150ms, ease-in
Mode:  AnimatePresence mode="wait" (exit completes before enter starts)
Total perceived transition: ~300ms
```

### References

- Claude Code Desktop: proven UX pattern for input zone transformation
- WAI-ARIA Radio Group pattern for keyboard navigation
- Contributing guides: `contributing/keyboard-shortcuts.md`, `contributing/interactive-tools.md`
- Previous spec: `specs/question-prompt-redesign/02-specification.md` (recently implemented)
- Ideation: `specs/interactive-card-focus-navigation/01-ideation.md`
