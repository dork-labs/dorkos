---
slug: chat-input-always-editable
number: 111
created: 2026-03-10
status: specified
authors: [Claude Code]
---

# Chat Input Always Editable + Message Queuing

## Status

Specified

## Overview

The chat input textarea is fully disabled during agent streaming, blocking users from drafting their next message. This specification defines a two-phase improvement: (1) make the textarea always editable while blocking submission during streaming, and (2) add a FIFO message queue with inline card display, shell-history arrow-key editing, a three-state send/stop/queue button, auto-flush on stream completion, and timing annotations on queued messages.

No competitor does queue editing well. Roo Code has basic queuing but no inline editing. Our shell-history navigation model is novel UX purpose-built for developer mental models.

## Background / Problem Statement

The current `ChatInput.tsx` applies `disabled={isDisabled}` to the textarea where `isDisabled = isLoading || sessionBusy`. During the entire streaming lifecycle (often 30-120 seconds for complex agent tasks), the user cannot type, draft, or prepare their next instruction. This creates:

1. **Flow disruption** for power users (Kai runs 10-20 sessions/week, Priya's context-switching costs 15 minutes)
2. **Wasted time** — users stare at streaming output instead of composing follow-up thoughts
3. **Lost thoughts** — by the time streaming finishes, the user may have forgotten what they wanted to say next
4. **Inferior UX** compared to ChatGPT (always-editable) and Roo Code (full queuing)

The root cause is a single `isDisabled` boolean that conflates "input acceptance" with "submit readiness" — these are orthogonal concerns that must be decoupled.

## Goals

- Allow typing in the textarea at all times (except server-lock `sessionBusy`)
- Block submission during streaming via button state and Enter key guard
- Introduce a FIFO message queue for composing and managing multiple follow-up messages
- Provide shell-history arrow-key navigation for editing queued items inline
- Auto-flush queued messages sequentially when the agent becomes idle
- Prepend timing annotations on queued messages to prevent context misinterpretation
- Deliver delightful micro-interactions (stagger animations, dynamic placeholder, queue badge)

## Non-Goals

- Agent interruption / abort-and-replace (SDK lacks graceful `interrupt()` per Issue #120)
- Drag-to-reorder queued messages (future enhancement)
- Queue persistence across page refresh or session switch
- File attachments on queued messages (files attach to the current draft only)
- Server-side changes (queue is entirely client-side state)
- Queue depth limits (unbounded for now; practical usage rarely exceeds 3-5 items)

## Technical Dependencies

| Dependency              | Version  | Purpose                                                                                      |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `react`                 | ^19.0.0  | Hooks, refs, state                                                                           |
| `motion`                | ^12.33.0 | AnimatePresence, stagger animations, spring physics                                          |
| `lucide-react`          | latest   | Icons: `Clock`, `ListPlus`, `Check`, `Square`, `ArrowUp`, `CornerDownLeft`, `X`, `Paperclip` |
| `zustand`               | ^5.0.0   | App store (selectedCwd)                                                                      |
| `@tanstack/react-query` | ^5.62.0  | Session queries                                                                              |

No new dependencies required.

## Related ADRs

- **ADR-0075** (`decisions/0075-promise-chain-queue-for-cca-concurrency.md`): Server-side per-agentId promise chain for serializing relay messages. Queue flush must respect this — cannot fire rapid concurrent messages.
- **ADR-0093** (`decisions/0093-queuemicrotask-for-sse-event-batching.md`): `queueMicrotask` deferral pattern for SSE event batching. Relevant precedent for async state coordination.
- **ADR-0092** (`decisions/0092-user-scroll-intent-via-wheel-touchstart.md`): User intent detection via event listeners. Relevant pattern for arrow-key intent detection (cursor position gating).

## Detailed Design

### Architecture Overview

```
ChatPanel
 ├── useChatSession (status, handleSubmit, stop, input, setInput)
 ├── useMessageQueue (queue, editingIndex, addToQueue, updateQueueItem, removeFromQueue, flushNext, clearQueue)  ← NEW
 └── ChatInputContainer
      ├── CommandPalette / FilePalette
      ├── FileChipBar
      ├── QueuePanel  ← NEW (inline cards above textarea)
      └── ChatInput (textarea, send/stop/queue/update button, clear button, paperclip)
```

All queue state lives in `useMessageQueue`. The hook accepts `status`, `sessionBusy`, `handleSubmit`, `sessionId`, and `selectedCwd` as parameters. It returns queue state and methods that `ChatPanel` threads down to `ChatInputContainer` and `ChatInput`.

### Phase 1: Always-Editable Input

#### 1.1 Decouple disabled states in `ChatInput.tsx`

**Current (line 187):**

```typescript
const isDisabled = isLoading || sessionBusy;
```

**New:**

```typescript
const isInputDisabled = sessionBusy; // Only server lock disables textarea
const isSubmitDisabled = isLoading || sessionBusy; // Blocks submission
```

Apply `isInputDisabled` to:

- Textarea `disabled` prop (line 250)

Apply `isSubmitDisabled` to:

- Send button `disabled` logic (line 273)

Remove disabled from:

- Paperclip button (line 220) — always enabled, users can stage files for next message

#### 1.2 Update clear button logic

**Current:**

```typescript
const showClear = hasText && !isLoading && !sessionBusy;
```

**New:**

```typescript
const showClear = hasText && !sessionBusy;
```

Clear should work whenever text exists, regardless of streaming state.

#### 1.3 Guard Enter key submission

**Current (`handleKeyDown`, line 111-116):**

```typescript
if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
  e.preventDefault();
  if (!isLoading && value.trim()) {
    onSubmit();
  }
}
```

Phase 1 change — add explicit no-op when streaming (Enter does nothing):

```typescript
if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
  e.preventDefault();
  if (!isLoading && !sessionBusy && value.trim()) {
    onSubmit();
  }
}
```

Phase 2 change — Enter queues during streaming (see Section 2.4).

#### 1.4 Dynamic placeholder

**Current (line 247):**

```typescript
placeholder = 'Message Claude...';
```

**New — accept placeholder as prop:**

Add `placeholder?: string` to `ChatInputProps`. Default to `"Message Claude..."`. `ChatInputContainer` computes the placeholder based on state and passes it down.

Placeholder logic in `ChatInputContainer`:

```typescript
const placeholder = isStreaming ? 'Compose next \u2014 will send when ready' : 'Message Claude...';
```

Phase 2 extends this with queue count (see Section 2.6).

#### 1.5 Update `ChatInputContainer` prop threading

**Current (line 131):**

```typescript
isLoading={status === 'streaming' || isUploading}
```

**New — pass `isStreaming` separately for placeholder logic:**

The `isLoading` prop continues to indicate "a submission is in flight" (used by button state logic). Add `isStreaming` as a separate boolean that `ChatInputContainer` uses for placeholder computation.

Alternatively, since `ChatInputContainer` already receives `status`, compute `isStreaming` locally:

```typescript
const isStreaming = status === 'streaming';
```

### Phase 2: Message Queue with Inline Cards

#### 2.1 New hook: `useMessageQueue`

**File:** `apps/client/src/layers/features/chat/model/use-message-queue.ts`

```typescript
interface QueueItem {
  id: string;
  content: string;
  createdAt: number;
}

interface UseMessageQueueOptions {
  status: ChatStatus;
  sessionBusy: boolean;
  sessionId: string | null;
  selectedCwd: string | null;
  onFlush: (content: string) => void;
}

interface UseMessageQueueReturn {
  queue: QueueItem[];
  editingIndex: number | null;
  addToQueue: (content: string) => void;
  updateQueueItem: (index: number, content: string) => void;
  removeFromQueue: (index: number) => void;
  startEditing: (index: number) => string;
  cancelEditing: () => void;
  saveEditing: (content: string) => void;
  clearQueue: () => void;
}
```

**State management:**

- `queue` state via `useState<QueueItem[]>([])` (triggers renders for QueuePanel)
- `editingIndex` state via `useState<number | null>(null)`
- `onFlush` ref via `useRef` (avoids stale closure in auto-flush effect)
- Previous status ref via `useRef<ChatStatus>` (detects idle transition)

**Auto-flush effect:**

```typescript
useEffect(() => {
  // Only flush on transition from streaming → idle
  if (prevStatusRef.current === 'streaming' && status === 'idle') {
    if (queue.length > 0 && !sessionBusy) {
      const firstNonEditing =
        editingIndex === 0
          ? queue.length > 1
            ? 1
            : null // Skip the item being edited
          : 0;
      if (firstNonEditing !== null) {
        const item = queue[firstNonEditing];
        const annotated = `[Note: This message was composed while the agent was responding to the previous message]\n\n${item.content}`;
        setQueue((prev) => prev.filter((_, i) => i !== firstNonEditing));
        // Adjust editingIndex if it was after the flushed item
        if (editingIndex !== null && editingIndex > firstNonEditing) {
          setEditingIndex((prev) => (prev !== null ? prev - 1 : null));
        }
        onFlushRef.current(annotated);
      }
    }
  }
  prevStatusRef.current = status;
}, [status, sessionBusy, queue, editingIndex]);
```

**Cleanup effects:**

```typescript
// Clear queue on session or cwd change
useEffect(() => {
  setQueue([]);
  setEditingIndex(null);
}, [sessionId, selectedCwd]);
```

**Methods:**

- `addToQueue(content)`: Append `{ id: crypto.randomUUID(), content, createdAt: Date.now() }` to queue
- `updateQueueItem(index, content)`: Replace content at index, preserve id and createdAt
- `removeFromQueue(index)`: Filter out item at index; if `editingIndex === index`, set `editingIndex = null`; if `editingIndex > index`, decrement editingIndex
- `startEditing(index)`: Set `editingIndex = index`, return `queue[index].content` (caller loads into textarea)
- `cancelEditing()`: Set `editingIndex = null` (caller restores draft or clears textarea)
- `saveEditing(content)`: Call `updateQueueItem(editingIndex, content)`, set `editingIndex = null`
- `clearQueue()`: Set `queue = []`, `editingIndex = null`

#### 2.2 New component: `QueuePanel`

**File:** `apps/client/src/layers/features/chat/ui/QueuePanel.tsx`

```typescript
interface QueuePanelProps {
  queue: QueueItem[];
  editingIndex: number | null;
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}
```

**Layout:** Renders between FileChipBar and ChatInput in ChatInputContainer. Only visible when `queue.length > 0`.

**Structure:**

```
<AnimatePresence>
  {queue.length > 0 && (
    <motion.div initial/animate/exit>
      <header>Queued ({queue.length})</header>
      <motion.div variants={staggerContainer}>
        {queue.map((item, i) => (
          <motion.div key={item.id} variants={staggerChild}>
            <QueueCard
              item={item}
              index={i}
              isEditing={editingIndex === i}
              onEdit={() => onEdit(i)}
              onRemove={() => onRemove(i)}
            />
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  )}
</AnimatePresence>
```

**QueueCard (inline in QueuePanel or extracted):**

- Single line of truncated preview text (`line-clamp-1 text-sm text-muted-foreground`)
- Numbered: "1.", "2.", etc.
- `x` remove button visible on hover (`opacity-0 group-hover:opacity-100`)
- Selected state when `isEditing`: left accent bar (`border-l-2 border-primary`), slightly elevated background (`bg-muted`)
- Click handler calls `onEdit(index)`
- Card padding: `px-3 py-1.5` (compact, fits 8pt grid)

**Animation specs (from design system):**

- Container: `staggerChildren: 0.05`
- Each card: `initial: { opacity: 0, y: -4 }`, `animate: { opacity: 1, y: 0 }`, spring `stiffness: 320, damping: 28`
- Exit: `{ opacity: 0, scale: 0.95 }`, duration `0.15`
- Container height animation: `motion.div` with `layout` prop for smooth height changes

#### 2.3 Three-state button in `ChatInput`

**New prop:** Replace `isLoading: boolean` with:

```typescript
interface ChatInputProps {
  // ... existing props
  isStreaming: boolean; // Agent is streaming
  isUploading: boolean; // File upload in progress (separate concern)
  sessionBusy: boolean; // Server lock
  editingQueueItem: boolean; // Currently editing a queue item
  queueDepth: number; // Number of items in queue (for badge)
  onQueue?: () => void; // Queue the current input
  onSaveEdit?: () => void; // Save the queue item being edited
}
```

**Button state derivation:**

```typescript
type ButtonState = 'send' | 'stop' | 'queue' | 'update' | 'hidden';

const buttonState: ButtonState = (() => {
  if (editingQueueItem && hasText) return 'update';
  if (isStreaming && hasText) return 'queue';
  if (isStreaming) return 'stop';
  if (hasText) return 'send';
  return 'hidden';
})();
```

**Button rendering:**

| State    | Icon                                | Color                                        | onClick      | aria-label        |
| -------- | ----------------------------------- | -------------------------------------------- | ------------ | ----------------- |
| `send`   | `SendIcon` (ArrowUp/CornerDownLeft) | `bg-primary text-primary-foreground`         | `onSubmit`   | "Send message"    |
| `stop`   | `Square`                            | `bg-destructive text-destructive-foreground` | `onStop`     | "Stop generating" |
| `queue`  | `Clock` (or `ListPlus`)             | `bg-muted text-muted-foreground`             | `onQueue`    | "Queue message"   |
| `update` | `Check`                             | `bg-primary text-primary-foreground`         | `onSaveEdit` | "Save edit"       |
| `hidden` | —                                   | —                                            | —            | —                 |

**Queue badge:**

When `buttonState === 'queue'` and `queueDepth > 0`, render a small badge:

```tsx
{
  queueDepth > 0 && buttonState === 'queue' && (
    <span className="bg-foreground text-background absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium">
      {queueDepth}
    </span>
  );
}
```

The button container needs `relative` positioning for the badge.

#### 2.4 Enter key behavior update

**Phase 2 `handleKeyDown`:**

```typescript
if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
  e.preventDefault();
  if (editingQueueItem && value.trim()) {
    onSaveEdit?.();
  } else if (isStreaming && value.trim()) {
    onQueue?.();
  } else if (!isStreaming && !sessionBusy && value.trim()) {
    onSubmit();
  }
}
```

Priority chain: editing save > queue > submit.

#### 2.5 Arrow key queue navigation

Arrow key handling in `ChatInput.handleKeyDown`, gated by:

1. `queue.length > 0` (queue has items)
2. `!isPaletteOpen` (palette arrow keys take priority)
3. Cursor position check (Up: cursor on first line; Down: cursor on last line)

**New props for queue navigation:**

```typescript
interface ChatInputProps {
  // ... existing
  onQueueNavigateUp?: () => void;
  onQueueNavigateDown?: () => void;
  queueHasItems?: boolean;
}
```

**In handleKeyDown, BEFORE the palette-open block:**

```typescript
// Queue navigation (takes priority over palette when queue has items and palette is closed)
if (!isPaletteOpen && queueHasItems) {
  if (e.key === 'ArrowUp') {
    const textarea = textareaRef.current;
    const isAtStart = !textarea || textarea.selectionStart === 0;
    const isEmpty = !value.trim();
    if (isEmpty || isAtStart) {
      e.preventDefault();
      onQueueNavigateUp?.();
      return;
    }
  }
  if (e.key === 'ArrowDown') {
    const textarea = textareaRef.current;
    const isAtEnd = !textarea || textarea.selectionStart === textarea.value.length;
    if (editingQueueItem && isAtEnd) {
      e.preventDefault();
      onQueueNavigateDown?.();
      return;
    }
  }
}
```

**Escape when editing:**

```typescript
if (e.key === 'Escape' && editingQueueItem) {
  onCancelEdit?.();
  return;
}
```

This is added BEFORE the existing Escape logic.

**Navigation state machine in `ChatPanel` (or `ChatInputContainer`):**

The parent manages navigation by tracking a `draftInput` (the text the user was composing before navigating into the queue) and orchestrating `startEditing` / `cancelEditing`:

```typescript
const draftRef = useRef('');

const handleQueueNavigateUp = useCallback(() => {
  if (messageQueue.editingIndex === null) {
    // Entering queue from new composition — save draft
    draftRef.current = input;
    const content = messageQueue.startEditing(messageQueue.queue.length - 1);
    setInput(content);
  } else if (messageQueue.editingIndex > 0) {
    // Navigate to older item
    const content = messageQueue.startEditing(messageQueue.editingIndex - 1);
    setInput(content);
  } else {
    // At oldest item — wrap to composing new
    messageQueue.cancelEditing();
    setInput(draftRef.current);
  }
}, [input, messageQueue, setInput]);

const handleQueueNavigateDown = useCallback(() => {
  if (messageQueue.editingIndex !== null) {
    if (messageQueue.editingIndex < messageQueue.queue.length - 1) {
      // Navigate to newer item
      const content = messageQueue.startEditing(messageQueue.editingIndex + 1);
      setInput(content);
    } else {
      // At newest item — return to composing new
      messageQueue.cancelEditing();
      setInput(draftRef.current);
    }
  }
}, [messageQueue, setInput]);
```

#### 2.6 Dynamic placeholder (Phase 2 extension)

```typescript
const placeholder = (() => {
  if (messageQueue.editingIndex !== null) return ''; // Textarea has content
  if (isStreaming && messageQueue.queue.length > 0) {
    return `Compose another \u2014 ${messageQueue.queue.length} queued`;
  }
  if (isStreaming) return 'Compose next \u2014 will send when ready';
  return 'Message Claude...';
})();
```

#### 2.7 Editing visual state

When `editingIndex !== null`, the textarea wrapper in `ChatInput` gets visual differentiation:

```tsx
<div
  className={cn(
    'border-input flex items-end gap-1.5 rounded-md border bg-transparent p-1.5 shadow-xs transition-[color,box-shadow]',
    isFocused && 'border-ring ring-ring/50 ring-[3px]',
    editingQueueItem && 'border-primary/40',
    !onAttach && 'pl-3'
  )}
>
```

**Editing label** — rendered inside ChatInput, above the textarea:

```tsx
{
  editingQueueItem && (
    <div className="text-muted-foreground px-0.5 text-xs">
      Editing message {editingIndex + 1}/{queueDepth}
    </div>
  );
}
```

The label sits in the flex column before the textarea row.

#### 2.8 Integration in `ChatPanel`

```typescript
// In ChatPanel component body
const messageQueue = useMessageQueue({
  status,
  sessionBusy,
  sessionId,
  selectedCwd: cwd,
  onFlush: handleSubmit, // useChatSession.handleSubmit
});
```

`handleSubmit` in `useChatSession` currently guards with `if (!input.trim() || status === 'streaming') return`. For auto-flush to work, we need a way to submit content directly without relying on the `input` state. Two approaches:

**Option A (Recommended): Add `submitContent` method to `useChatSession`**

Add a new method that accepts content directly:

```typescript
const submitContent = useCallback(
  async (content: string) => {
    if (!content.trim() || status === 'streaming') return;
    // Same logic as handleSubmit but uses `content` instead of `input`
    // ...
  },
  [status, sessionId, relayEnabled, streamEventHandler, queryClient]
);
```

This is cleaner than manipulating `input` state and immediately calling `handleSubmit`.

**Option B: Set input then submit in next tick**

```typescript
const handleFlush = useCallback(
  (content: string) => {
    setInput(content);
    // handleSubmit reads from input state — need to wait for state update
    queueMicrotask(() => handleSubmit());
  },
  [setInput, handleSubmit]
);
```

This is fragile due to React batching. **Option A is preferred.**

The `onFlush` callback passed to `useMessageQueue` wraps `submitContent`:

```typescript
onFlush: (content: string) => submitContent(content),
```

#### 2.9 Queue action handlers threaded to `ChatInputContainer`

New props on `ChatInputContainerProps`:

```typescript
interface ChatInputContainerProps {
  // ... existing props
  queue: QueueItem[];
  editingIndex: number | null;
  onQueue: (content: string) => void;
  onQueueRemove: (index: number) => void;
  onQueueEdit: (index: number) => void;
  onQueueSaveEdit: (content: string) => void;
  onQueueCancelEdit: () => void;
  onQueueNavigateUp: () => void;
  onQueueNavigateDown: () => void;
}
```

#### 2.10 Barrel export update

Add `useMessageQueue` and `QueuePanel` to `apps/client/src/layers/features/chat/index.ts`:

```typescript
export { useMessageQueue } from './model/use-message-queue';
export type { QueueItem } from './model/use-message-queue';
```

`QueuePanel` is not exported from the barrel — it's an internal UI component used only by `ChatInputContainer`.

### File Change Summary

| File                                       | Change Type | Description                                                                                                        |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `features/chat/ui/ChatInput.tsx`           | Modify      | Decouple disabled states, add queue/update button states, arrow key navigation, editing label, dynamic placeholder |
| `features/chat/ui/ChatInputContainer.tsx`  | Modify      | Thread queue props, render QueuePanel, compute placeholder                                                         |
| `features/chat/ui/ChatPanel.tsx`           | Modify      | Instantiate useMessageQueue, thread queue state down, add submitContent, wire navigation handlers                  |
| `features/chat/model/use-chat-session.ts`  | Modify      | Add `submitContent` method for direct content submission                                                           |
| `features/chat/model/use-message-queue.ts` | Create      | Queue hook with auto-flush, editing state, cleanup                                                                 |
| `features/chat/ui/QueuePanel.tsx`          | Create      | Inline card list with stagger animation, selection state                                                           |
| `features/chat/model/chat-types.ts`        | Modify      | Export `QueueItem` type                                                                                            |
| `features/chat/index.ts`                   | Modify      | Export `useMessageQueue` and `QueueItem`                                                                           |

## User Experience

### Phase 1 Flow

1. User sends a message. Agent begins streaming.
2. Textarea remains editable. Placeholder changes to "Compose next — will send when ready".
3. User types their next thought while watching the agent work.
4. Agent finishes. Status transitions to idle. Placeholder reverts to "Message Claude...".
5. User presses Enter to submit their drafted message.

### Phase 2 Flow

1. User sends a message. Agent begins streaming.
2. User types "Can you also refactor the auth module?" and presses Enter.
3. Message appears as a card in QueuePanel: "Queued (1)". Textarea clears. Send button showed "Queue" (clock icon) before submission.
4. User types "And then run the tests" and presses Enter. Second card appears. Badge on queue button shows "2".
5. User presses Up arrow. Textarea loads "And then run the tests". Label shows "Editing message 2/2". Card 2 is highlighted.
6. User edits the text, presses Enter. Edit saved. Returns to composing new.
7. Agent finishes streaming. First queued message auto-sends with timing annotation. Status returns to streaming.
8. Agent finishes again. Second queued message auto-sends. Queue empties.

### Mobile Experience

- Queue works via button tap (Queue button adds to queue)
- Cards are tappable to edit (loads into textarea)
- No arrow key navigation (mobile keyboards don't have arrow keys in the same sense)
- Remove via x button on card (always visible on mobile, not hover-gated)

## Testing Strategy

### Unit Tests: `useMessageQueue`

**File:** `apps/client/src/layers/features/chat/__tests__/use-message-queue.test.ts`

```
- addToQueue appends item with unique id and content
- addToQueue with empty string is rejected
- updateQueueItem modifies content at index, preserves id
- removeFromQueue removes item and adjusts editingIndex
- removeFromQueue when editing the removed item resets editingIndex to null
- removeFromQueue when editing item after removed one decrements editingIndex
- startEditing sets editingIndex and returns content
- cancelEditing resets editingIndex to null
- saveEditing updates item content and resets editingIndex
- auto-flush fires on streaming → idle transition
- auto-flush prepends timing annotation to flushed content
- auto-flush skips when sessionBusy is true
- auto-flush skips the item being edited
- auto-flush does nothing when queue is empty
- queue clears on sessionId change
- queue clears on selectedCwd change
- multiple rapid idle transitions don't double-flush
```

### Unit Tests: `QueuePanel`

**File:** `apps/client/src/layers/features/chat/__tests__/QueuePanel.test.tsx`

```
- renders nothing when queue is empty
- renders card for each queue item with truncated text
- renders "Queued (N)" header with correct count
- clicking card calls onEdit with correct index
- clicking x button calls onRemove with correct index
- editing item shows selected state (accent border)
- AnimatePresence exit animation triggers on item removal
```

### Updated Tests: `ChatInput`

**File:** `apps/client/src/layers/features/chat/__tests__/ChatInput.test.tsx`

```
- textarea is NOT disabled during streaming (Phase 1 regression)
- textarea IS disabled when sessionBusy
- Enter key does not submit during streaming
- Enter key queues message during streaming when onQueue provided
- Enter key saves edit when editingQueueItem is true
- Escape cancels edit when editingQueueItem is true
- Up arrow navigates to queue when queue has items and palette is closed
- Up arrow does NOT navigate when palette is open
- Down arrow navigates forward through queue
- clear button works during streaming
- paperclip button works during streaming
- send button shows Queue icon during streaming with text
- send button shows Update icon when editing queue item
- queue badge renders with correct count
- editing label shows "Editing message M/N"
- dynamic placeholder shows streaming text
- dynamic placeholder shows queue count
```

### Integration Tests: `ChatPanel`

**File:** `apps/client/src/layers/features/chat/__tests__/ChatPanel.test.tsx`

```
- typing during streaming preserves draft
- queuing message during streaming shows card in QueuePanel
- auto-flush sends first queued message when streaming completes
- auto-flush includes timing annotation prefix
- arrow key navigation cycles through queue items
- editing queue item and pressing Enter saves and returns to new
- editing queue item and pressing Escape discards and returns to new
- queue clears when session changes
```

### Mocking Strategy

- Mock `useChatSession` return value to control `status` transitions
- Mock `Transport` via `createMockTransport()` from `@dorkos/test-utils`
- Use `renderHook` from `@testing-library/react` for `useMessageQueue` tests
- Use `userEvent.setup()` for keyboard interaction tests
- Use `vi.useFakeTimers()` for auto-flush timing tests

## Performance Considerations

- **Queue state:** `useRef` for the `onFlush` callback to avoid stale closures in the auto-flush effect. `useState` for `queue` and `editingIndex` since these trigger renders.
- **QueuePanel animation:** Use `motion.div` with `layout` prop for smooth height transitions. Avoid `max-height` animation (causes repaint cascades).
- **AnimatePresence keying:** Queue items use stable `id` (crypto.randomUUID) as React key — no index-based keys.
- **Relay handshake:** The `waitForStreamReady` polling in `handleSubmit` / `submitContent` already throttles flush frequency. No additional delay needed.
- **Render batching:** Queue state updates use functional `setState` to batch correctly with React 19 automatic batching.

## Security Considerations

- Queue is client-only state — no new server attack surface, no API changes.
- Timing annotation strings pass through the same content pipeline as user input (same `transformContent` chain, same sanitization).
- Tool permission dialogs are NOT auto-approved for queued messages — the agent still pauses for user approval on each tool call, regardless of whether the message was queued or direct.
- `sessionBusy` (server lock from another client) blocks queue flushing — prevents race conditions with concurrent writers.

## Documentation

- Update `contributing/design-system.md` to document the three-state button pattern (send/stop/queue) as a reusable component pattern.
- No user-facing documentation changes needed — the behavior is self-discoverable via placeholder text and visual affordances.

## Implementation Phases

### Phase 1: Always-Editable Input

1. Modify `ChatInput.tsx`: decouple `isDisabled` into `isInputDisabled` and `isSubmitDisabled`
2. Remove `disabled` from textarea (only `sessionBusy` disables)
3. Remove `disabled` from paperclip button
4. Update clear button logic (works during streaming)
5. Add `placeholder` prop, compute dynamic placeholder in `ChatInputContainer`
6. Update all affected tests in `ChatInput.test.tsx` and `ChatInputContainer.test.tsx`

### Phase 2: Message Queue Core

1. Create `use-message-queue.ts` hook with queue state, CRUD methods, auto-flush effect
2. Add `submitContent` method to `use-chat-session.ts`
3. Create `QueuePanel.tsx` component with card list and stagger animation
4. Wire `useMessageQueue` in `ChatPanel.tsx`, thread props to `ChatInputContainer`
5. Render `QueuePanel` in `ChatInputContainer` between FileChipBar and ChatInput
6. Update `ChatInput` button to three-state model (send/stop/queue/update)
7. Add queue badge rendering
8. Implement Enter key behavior: submit / queue / save-edit priority chain
9. Write tests for `useMessageQueue` and `QueuePanel`

### Phase 3: Shell-History Navigation & Polish

1. Implement arrow key navigation in `ChatInput.handleKeyDown`
2. Wire navigation handlers in `ChatPanel` with draft preservation
3. Add Escape-to-cancel-edit behavior
4. Add editing visual state (accent border, label, card highlight)
5. Extend dynamic placeholder with queue count
6. Mobile: ensure cards are tap-to-edit, x always visible
7. Write integration tests for full queue workflow
8. Update barrel exports in `features/chat/index.ts`

## Open Questions

_No open questions remain. All design decisions were resolved during ideation._

## References

- Ideation document: `specs/chat-input-always-editable/01-ideation.md`
- Roo Code message queuing: https://docs.roocode.com/features/message-queueing
- Relevance AI queuing: https://relevanceai.com/changelog/message-queuing-in-chat-continue-your-conversation-without-waiting
- Vercel AI Chatbot queue PR: https://github.com/vercel/ai-chatbot/pull/1212
- Claude Agent SDK streaming input mode: https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- SDK interrupt API gap: https://github.com/anthropics/claude-agent-sdk-typescript/issues/120
- Queued message context misinterpretation: https://github.com/anthropics/claude-code/issues/26388
