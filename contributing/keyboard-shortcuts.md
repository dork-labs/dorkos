# Keyboard Shortcuts & Focus State Machine

## Overview

Interactive tools (Tool Approval and AskUserQuestion) pause the Claude Agent SDK mid-execution to collect user input. While these tools are pending, global keyboard shortcuts allow the user to respond without reaching for the mouse. This guide documents the focus state machine, the shortcut hook, the visual active/inactive states, and the full component wiring.

## Focus State Machine

The chat UI has four focus states. At any given time, exactly one is active.

```
                          user sends message
  IDLE/TYPING  ──────────────────────────────────►  STREAMING
  (ChatInput focused,                               (ChatInput disabled,
   no global shortcuts)                               no shortcuts needed)
       ▲                                                   │
       │                                                   │
       │  tool resolved                  SSE: approval_required
       │  (next pending auto-promotes)         or question_prompt
       │                                                   │
       │                                                   ▼
  WAITING_FOR_APPROVAL  ◄───────────┐    WAITING_FOR_ANSWER
  (Enter=Approve, Esc=Deny)         │    (1-9, Arrows, Space,
       │                            │     Enter, [, ])
       │                            │         │
       └────────────────────────────┘─────────┘
                tool resolved, next pending auto-promotes
                or SDK resumes and stream completes → IDLE
```

### State Details

| State                    | ChatInput              | Global Shortcuts                            | Trigger                                                               |
| ------------------------ | ---------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| **IDLE/TYPING**          | Enabled, focused       | None                                        | Default state; also entered when streaming ends with no pending tools |
| **STREAMING**            | Disabled (`isLoading`) | None                                        | User sends a message; `status === 'streaming'`                        |
| **WAITING_FOR_APPROVAL** | Disabled               | `Enter` = approve, `Esc` = deny             | SSE `approval_required` event received                                |
| **WAITING_FOR_ANSWER**   | Disabled               | `1`-`9`, arrows, `Space`, `Enter`, `[`, `]` | SSE `question_prompt` event received                                  |

### Why Global Shortcuts Work

The chat textarea is `disabled={isLoading}` during streaming. Interactive tools only appear while the SSE connection is open (i.e., during streaming). Because the textarea is disabled, it cannot receive focus or keystrokes, so `document.addEventListener('keydown', ...)` handlers fire without conflicting with text input.

**Exception:** When the user selects the "Other" option in `QuestionPrompt`, a textarea appears for free-text input. While this textarea is focused, most shortcuts are suppressed -- only `Enter` (submit) still works from inside a text input.

## Hook: `useInteractiveShortcuts`

**Location:** `apps/client/src/layers/features/chat/model/use-interactive-shortcuts.ts`

The hook attaches a global `keydown` listener only when `activeInteraction` is non-null (i.e., a tool is waiting for user input). It removes the listener when the interaction is resolved.

### Interface

```typescript
interface UseInteractiveShortcutsOptions {
  activeInteraction: { type: 'approval' | 'question'; toolCallId: string } | null;
  onApprove?: () => void;
  onDeny?: () => void;
  onToggleOption?: (index: number) => void;
  onNavigateOption?: (direction: 'up' | 'down') => void;
  onNavigateQuestion?: (direction: 'prev' | 'next') => void;
  onSubmit?: () => void;
  optionCount?: number;
  focusedIndex?: number;
}
```

### Key Behaviors

1. **Guard:** If `activeInteraction` is `null`, no listener is attached.
2. **Text input filter:** If the `keydown` target is an enabled `<textarea>` or `<input>`, only `Enter` (submit) is handled. All other keys pass through to the text input normally.
3. **Double-fire prevention:** A `respondingRef` prevents the approve/deny callbacks from firing twice on rapid key presses. The ref resets when `activeInteraction.toolCallId` changes (new tool becomes active).
4. **Approval mode:** `Enter` calls `onApprove`, `Escape` calls `onDeny`. No other keys are handled.
5. **Question mode:** Digit keys `1`-`9` toggle options (bounds-checked against `optionCount`), arrow keys navigate, `Space` toggles the focused option, `[`/`]` and `ArrowLeft`/`ArrowRight` navigate between question tabs, `Enter` submits.

## Keyboard Shortcut Reference

### Approval Mode (`WAITING_FOR_APPROVAL`)

| Key      | Action                |
| -------- | --------------------- |
| `Enter`  | Approve the tool call |
| `Escape` | Deny the tool call    |

### Question Mode (`WAITING_FOR_ANSWER`)

| Key                 | Action                                |
| ------------------- | ------------------------------------- |
| `1` - `9`           | Toggle option at that index (1-based) |
| `Arrow Up`          | Move focus to previous option (wraps) |
| `Arrow Down`        | Move focus to next option (wraps)     |
| `Space`             | Toggle the currently focused option   |
| `Enter`             | Submit answers                        |
| `Arrow Left` / `[`  | Navigate to previous question tab     |
| `Arrow Right` / `]` | Navigate to next question tab         |

**Inside "Other" textarea:** Only `Enter` (submit) is active. All other shortcuts are suppressed so the user can type freely.

## Active vs. Inactive Tool Visual State

When multiple interactive tools are pending simultaneously (e.g., the SDK calls `canUseTool` concurrently), only the **first pending** tool is the "active" shortcut target. The active tool is determined by `useChatSession`'s `activeInteraction` property, which returns the first tool call with `status === 'pending'` and a non-null `interactiveType`.

### Visual Differences

| Property             | Active (first pending)                  | Inactive (subsequent pending) |
| -------------------- | --------------------------------------- | ----------------------------- |
| Border ring          | `ring-2 ring-amber-500/30`              | No ring                       |
| `Kbd` shortcut hints | Visible (e.g., `Enter`, `Esc`, `1`-`9`) | Hidden                        |
| Keyboard shortcuts   | Functional                              | No effect (must click)        |

### Auto-Promotion

When the active tool is resolved (approved, denied, or answered), the next pending tool automatically becomes active. This is derived from the message state -- `activeInteraction` simply finds the first pending interactive tool call in the current message list.

## Component Integration

### Wiring Diagram

```
ChatPanel
  ├── useInteractiveShortcuts(activeInteraction, callbacks)
  ├── focusedOptionIndex state
  ├── activeToolHandleRef (InteractiveToolHandle)
  │
  └── MessageList
        └── MessageItem (receives activeToolCallId, onToolRef, focusedOptionIndex)
              ├── ToolApproval (forwardRef → ToolApprovalHandle)
              │     isActive={toolCallId === activeToolCallId}
              │     ref={isActive ? approvalRefCallback : undefined}
              │
              └── QuestionPrompt (forwardRef → QuestionPromptHandle)
                    isActive={toolCallId === activeToolCallId}
                    ref={isActive ? questionRefCallback : undefined}
                    focusedOptionIndex={isActive ? focusedOptionIndex : -1}
```

### `ChatPanel.tsx`

`ChatPanel` is the orchestrator. It:

1. Reads `activeInteraction` from `useChatSession`
2. Maintains `focusedOptionIndex` state (reset to `0` when `activeInteraction.toolCallId` changes)
3. Holds `activeToolHandleRef` -- an imperative handle to the active interactive component
4. Wires `useInteractiveShortcuts` with callbacks that delegate to the imperative handle:

```typescript
useInteractiveShortcuts({
  activeInteraction: activeInteractionForShortcuts,
  onApprove: useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'approve' in handle) handle.approve();
  }, []),
  onDeny: useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'deny' in handle) handle.deny();
  }, []),
  onToggleOption: useCallback((index: number) => {
    const handle = activeToolHandleRef.current;
    if (handle && 'toggleOption' in handle) {
      handle.toggleOption(index);
      setFocusedOptionIndex(index);
    }
  }, []),
  // ... onNavigateOption, onNavigateQuestion, onSubmit
});
```

### `MessageItem.tsx`

Threads three props from `ChatPanel` through `MessageList`:

- **`activeToolCallId`** -- The `toolCallId` of the currently active interactive tool
- **`onToolRef`** -- Callback to register the imperative handle of the active component
- **`focusedOptionIndex`** -- Which option is keyboard-focused in `QuestionPrompt`

For each tool call part, `MessageItem` checks `part.toolCallId === activeToolCallId` and conditionally passes the `ref` callback. Only the active tool's ref is captured -- inactive tools do not register handles.

### `ToolApproval.tsx`

Exposes `ToolApprovalHandle` via `forwardRef` + `useImperativeHandle`:

```typescript
export interface ToolApprovalHandle {
  approve: () => void;
  deny: () => void;
}
```

When `isActive` is `true`, the component renders:

- Amber `ring-2 ring-amber-500/30` border
- `<Kbd>Enter</Kbd>` next to the Approve button
- `<Kbd>Esc</Kbd>` next to the Deny button

### `QuestionPrompt.tsx`

Exposes `QuestionPromptHandle` via `forwardRef` + `useImperativeHandle`:

```typescript
export interface QuestionPromptHandle {
  toggleOption: (index: number) => void;
  navigateOption: (direction: 'up' | 'down') => void;
  navigateQuestion: (direction: 'prev' | 'next') => void;
  submit: () => void;
  getOptionCount: () => number;
  getActiveTab: () => string;
}
```

When `isActive` is `true`, the component renders:

- Amber `ring-2 ring-amber-500/30` border
- `<Kbd>` hints on each option label (e.g., `1`, `2`, `3`)
- Arrow key navigation hint (`<Kbd>&larr;</Kbd><Kbd>&rarr;</Kbd> navigate questions`) when multiple question tabs exist
- `<Kbd>Enter</Kbd>` on the Submit button
- Focused option highlight via `ring-1 ring-amber-500/50` on the option at `focusedOptionIndex`

Option count includes the "Other" free-text option (i.e., `options.length + 1`).

### `InferenceIndicator.tsx`

Displays contextual status text below the message list. When `isWaitingForUser` is `true`:

- **Approval:** Shows `Shield` icon + "Waiting for your approval"
- **Question:** Shows `MessageSquare` icon + "Waiting for your answer"

Both use amber coloring (`text-amber-500` icon, `text-amber-600` text) to match the interactive tool cards.

## `Kbd` Component

**Location:** `apps/client/src/layers/shared/ui/kbd.tsx`

A presentational component that renders keyboard shortcut hints.

```typescript
function Kbd({ className, children, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'pointer-events-none hidden md:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
```

Key details:

- **Hidden on mobile:** `hidden md:inline-flex` ensures hints only show on screens >= 768px. Mobile users tap buttons directly.
- **Non-interactive:** `pointer-events-none select-none` prevents the hint from interfering with click targets.
- **Styled to match shadcn/ui:** Uses `bg-muted`, `text-muted-foreground`, `border`, `font-mono` for a consistent appearance with the design system.

## Adding Shortcuts for a New Interactive Tool

If you add a new interactive tool (see `contributing/interactive-tools.md` for the full pattern), extend the keyboard shortcut system:

1. **Add a new type** to `activeInteraction.type` (currently `'approval' | 'question'`).
2. **Add a new branch** in the `useInteractiveShortcuts` handler for your type's key bindings.
3. **Define a handle interface** for your component (e.g., `MyToolHandle`) and add it to the `InteractiveToolHandle` union in `MessageItem.tsx`.
4. **Expose the handle** via `forwardRef` + `useImperativeHandle` in your component.
5. **Wire callbacks** in `ChatPanel.tsx` that delegate from the shortcut hook to the imperative handle.
6. **Render `Kbd` hints** in your component, conditioned on `isActive`.
