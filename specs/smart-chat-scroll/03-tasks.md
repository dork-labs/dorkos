# Smart Chat Scroll -- Task Breakdown

| Field            | Value                                         |
| ---------------- | --------------------------------------------- |
| **Spec**         | `specs/smart-chat-scroll/02-specification.md` |
| **Feature Slug** | `smart-chat-scroll`                           |
| **Created**      | 2026-02-12                                    |
| **Total Tasks**  | 7                                             |
| **Total Phases** | 3                                             |

---

## Phase 1: Foundation -- Restructure Layout

### Task 1.1: Refactor MessageList to extract scroll state and remove scroll button

**Status:** Not Started
**Blocked by:** None
**Files to modify:**

- `apps/client/src/components/chat/MessageList.tsx`

**Description:**

Refactor `MessageList` to remove the scroll-to-bottom button UI and expose scroll state + scroll imperative handle to the parent component. The button is currently rendered INSIDE the scroll container (`absolute bottom-4`), which causes it to scroll with content instead of staying fixed. Moving it out requires MessageList to communicate scroll state upward.

**Implementation:**

1. **Add new props and ref interface.** Replace the current `MessageListProps` interface and component signature:

```typescript
// Add at top of file, after imports:
import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';

// Remove these imports (no longer needed in MessageList):
// import { motion, AnimatePresence } from 'motion/react';
// import { ArrowDown } from 'lucide-react';

export interface ScrollState {
  isAtBottom: boolean;
  distanceFromBottom: number;
}

export interface MessageListHandle {
  scrollToBottom: () => void;
}

interface MessageListProps {
  messages: ChatMessage[];
  sessionId: string;
  status?: 'idle' | 'streaming' | 'error';
  onScrollStateChange?: (state: ScrollState) => void;
}
```

2. **Convert to forwardRef.** Change the component declaration:

```typescript
export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { messages, sessionId, status, onScrollStateChange },
  ref
) {
  // ... component body
});
```

3. **Update scroll tracking.** Replace the current `handleScroll` callback and `showScrollButton` state. Remove `const [showScrollButton, setShowScrollButton] = useState(false);`. Replace with a ref-based approach:

```typescript
const isAtBottomRef = useRef(true);

const handleScroll = useCallback(() => {
  const container = parentRef.current;
  if (!container) return;
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  // 200px threshold for "at bottom" (used by parent for scroll button visibility)
  const isAtBottom = distanceFromBottom < 200;
  isAtBottomRef.current = isAtBottom;
  onScrollStateChange?.({ isAtBottom, distanceFromBottom });
}, [onScrollStateChange]);
```

4. **Expose scrollToBottom via imperative handle:**

```typescript
const scrollToBottom = useCallback(() => {
  virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
}, [virtualizer, messages.length]);

useImperativeHandle(
  ref,
  () => ({
    scrollToBottom,
  }),
  [scrollToBottom]
);
```

5. **Update auto-scroll useEffect.** Replace `!showScrollButton` guard with `isAtBottomRef.current`:

```typescript
useEffect(() => {
  if (messages.length > 0 && isAtBottomRef.current) {
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }
}, [scrollTrigger, virtualizer]);
```

6. **Remove the scroll button JSX.** Delete the entire `<AnimatePresence>` block at the bottom of the return statement (lines 154-168 in current code). The button will be rendered by ChatPanel instead.

7. **Remove `relative` from the scroll container class.** The container div no longer needs to be a positioning context since the button has moved out:

```typescript
return (
  <div ref={parentRef} className="chat-scroll-area h-full overflow-y-auto">
    {/* ... virtual items ... */}
  </div>
);
```

Note: Also remove `flex-1` from the className since the parent wrapper will handle flex sizing.

**Complete updated MessageList.tsx:**

```typescript
import { useRef, useEffect, useState, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage, MessageGrouping } from '../../hooks/use-chat-session';
import { MessageItem } from './MessageItem';

export function computeGrouping(messages: ChatMessage[]): MessageGrouping[] {
  let groupIndex = 0;
  return messages.map((msg, i) => {
    const prevRole = i > 0 ? messages[i - 1].role : null;
    const nextRole = i < messages.length - 1 ? messages[i + 1].role : null;
    const isFirst = prevRole !== msg.role;
    const isLast = nextRole !== msg.role;
    if (isFirst && i > 0) groupIndex++;
    let position: MessageGrouping['position'];
    if (isFirst && isLast) position = 'only';
    else if (isFirst) position = 'first';
    else if (isLast) position = 'last';
    else position = 'middle';
    return { position, groupIndex };
  });
}

export interface ScrollState {
  isAtBottom: boolean;
  distanceFromBottom: number;
}

export interface MessageListHandle {
  scrollToBottom: () => void;
}

interface MessageListProps {
  messages: ChatMessage[];
  sessionId: string;
  status?: 'idle' | 'streaming' | 'error';
  onScrollStateChange?: (state: ScrollState) => void;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList({ messages, sessionId, status, onScrollStateChange }, ref) {
    const parentRef = useRef<HTMLDivElement>(null);
    const [historyCount, setHistoryCount] = useState<number | null>(null);
    const isAtBottomRef = useRef(true);
    const groupings = useMemo(() => computeGrouping(messages), [messages]);

    useEffect(() => {
      if (historyCount === null && messages.length > 0) {
        setHistoryCount(messages.length);
      }
    }, [messages.length, historyCount]);

    const virtualizer = useVirtualizer({
      count: messages.length,
      getScrollElement: () => parentRef.current,
      estimateSize: () => 80,
      overscan: 5,
      measureElement: (el) => el?.getBoundingClientRect().height ?? 80,
    });

    const handleScroll = useCallback(() => {
      const container = parentRef.current;
      if (!container) return;
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const isAtBottom = distanceFromBottom < 200;
      isAtBottomRef.current = isAtBottom;
      onScrollStateChange?.({ isAtBottom, distanceFromBottom });
    }, [onScrollStateChange]);

    useEffect(() => {
      const container = parentRef.current;
      if (!container) return;
      container.addEventListener('scroll', handleScroll, { passive: true });
      return () => container.removeEventListener('scroll', handleScroll);
    }, [handleScroll]);

    // When the scroll container becomes visible again (e.g. switching Obsidian
    // sidebar tabs), the virtualizer loses its scroll position. Detect
    // visibility changes and scroll to bottom when re-shown.
    useEffect(() => {
      const container = parentRef.current;
      if (!container || messages.length === 0) return;
      let wasHidden = false;
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) {
            wasHidden = true;
          } else if (wasHidden) {
            wasHidden = false;
            requestAnimationFrame(() => {
              virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
            });
          }
        },
        { threshold: 0.1 }
      );
      observer.observe(container);
      return () => observer.disconnect();
    }, [virtualizer, messages.length]);

    const lastMsg = messages[messages.length - 1];
    const scrollTrigger = `${messages.length}:${lastMsg?.toolCalls?.length ?? 0}`;

    // Auto-scroll to bottom on new messages or tool call additions
    useEffect(() => {
      if (messages.length > 0 && isAtBottomRef.current) {
        virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
      }
    }, [scrollTrigger, virtualizer]);

    const scrollToBottom = useCallback(() => {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }, [virtualizer, messages.length]);

    useImperativeHandle(ref, () => ({
      scrollToBottom,
    }), [scrollToBottom]);

    return (
      <div ref={parentRef} className="chat-scroll-area h-full overflow-y-auto">
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            width: '100%',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const msg = messages[virtualRow.index];
            const isNew = historyCount !== null && virtualRow.index >= historyCount;
            const isLastAssistant =
              virtualRow.index === messages.length - 1 && msg.role === 'assistant';
            const isStreaming = isLastAssistant && status === 'streaming';
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <MessageItem
                  message={msg}
                  grouping={groupings[virtualRow.index]}
                  sessionId={sessionId}
                  isNew={isNew}
                  isStreaming={isStreaming}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);
```

**Acceptance criteria:**

- `MessageList` no longer renders a scroll-to-bottom button
- `MessageList` accepts `onScrollStateChange` callback prop
- `MessageList` exposes `scrollToBottom()` via `forwardRef` + `useImperativeHandle`
- The `onScrollStateChange` callback reports `{ isAtBottom: boolean, distanceFromBottom: number }` with a 200px threshold
- Auto-scroll only fires when `isAtBottomRef.current` is true
- The scroll container div no longer has `relative` or `flex-1` classes
- `computeGrouping` function and all virtualizer logic unchanged
- IntersectionObserver visibility restore logic unchanged
- `turbo build --filter=@dorkos/client` succeeds

---

### Task 1.2: Refactor ChatPanel to add overlay wrapper and receive scroll state

**Status:** Not Started
**Blocked by:** Task 1.1 (MessageList must expose scroll state and ref)
**Files to modify:**

- `apps/client/src/components/chat/ChatPanel.tsx`

**Description:**

Wrap the MessageList area (including loading/empty states) in a new `relative` wrapper div that serves as the positioning context for the scroll-to-bottom button overlay. Receive scroll state from MessageList and render the scroll button as an `absolute` child of the wrapper.

**Target layout structure:**

```
ChatPanel (flex flex-col h-full)
├── Wrapper div (relative, flex-1, min-h-0)  <-- NEW: positioning context
│   ├── MessageList (chat-scroll-area, h-full, overflow-y-auto)
│   │   └── Virtual items container (relative, height: getTotalSize())
│   │       └── MessageItem[] (absolute, translateY positioned)
│   └── Scroll Button (absolute, bottom-4, right-4)  <-- MOVED HERE
├── TaskListPanel (border-t)
├── Error message (optional)
└── chat-input-container (relative, border-t, p-4)
```

**Implementation:**

1. **Add imports:**

```typescript
import { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { MessageList } from './MessageList';
import type { MessageListHandle, ScrollState } from './MessageList';
```

2. **Add scroll state and ref inside the component:**

```typescript
export function ChatPanel({ sessionId, transformContent }: ChatPanelProps) {
  const messageListRef = useRef<MessageListHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // ... existing state and hooks ...

  const handleScrollStateChange = useCallback((state: ScrollState) => {
    setIsAtBottom(state.isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom();
    setIsAtBottom(true);
  }, []);
```

3. **Update the JSX return.** Wrap the message area in a `relative` wrapper and add the scroll button:

```typescript
return (
  <div className="flex flex-col h-full">
    <div className="relative flex-1 min-h-0">
      {isLoadingHistory ? (
        <div className="h-full flex items-center justify-center">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <div className="flex gap-1">
              <span className="h-2 w-2 rounded-full bg-muted-foreground" style={{ animation: 'typing-dot 1.4s ease-in-out infinite', animationDelay: '0s' }} />
              <span className="h-2 w-2 rounded-full bg-muted-foreground" style={{ animation: 'typing-dot 1.4s ease-in-out infinite', animationDelay: '0.2s' }} />
              <span className="h-2 w-2 rounded-full bg-muted-foreground" style={{ animation: 'typing-dot 1.4s ease-in-out infinite', animationDelay: '0.4s' }} />
            </div>
            Loading conversation...
          </div>
        </div>
      ) : messages.length === 0 ? (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <p className="text-muted-foreground text-base">Start a conversation</p>
            <p className="text-muted-foreground/60 text-sm mt-2">Type a message below to begin</p>
          </div>
        </div>
      ) : (
        <MessageList
          ref={messageListRef}
          messages={messages}
          sessionId={sessionId}
          status={status}
          onScrollStateChange={handleScrollStateChange}
        />
      )}

      {/* Scroll-to-bottom button — positioned outside the scroll container */}
      <AnimatePresence>
        {!isAtBottom && messages.length > 0 && !isLoadingHistory && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 rounded-full bg-background border shadow-sm p-2 hover:shadow-md transition-shadow"
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="size-(--size-icon-md)" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>

    <TaskListPanel ... />

    {error && ( <div className="..."> {error} </div> )}

    <div className="chat-input-container relative border-t p-4">
      {/* ... existing command palette and chat input ... */}
    </div>
  </div>
);
```

Key changes from current layout:

- Loading and empty states change from `flex-1` to `h-full` (wrapper provides flex sizing)
- MessageList no longer has `flex-1` (wrapper provides flex sizing)
- Scroll button is `absolute bottom-4 right-4` (right-aligned, not centered -- the centered position is reserved for the "New messages" pill in Task 2.2)
- Button visibility is driven by `!isAtBottom` state from the scroll callback

**Acceptance criteria:**

- A new `relative flex-1 min-h-0` wrapper div exists in ChatPanel around the message area
- Scroll-to-bottom button renders as a child of the wrapper, NOT inside the scroll container
- Button stays visually fixed above the input area regardless of scroll position
- Button appears when user scrolls 200px+ from bottom, disappears when near bottom
- Clicking button scrolls to bottom and hides the button
- Loading and empty states render correctly within the wrapper
- `turbo build --filter=@dorkos/client` succeeds

---

## Phase 2: Core Features

### Task 2.1: Implement "new messages" detection logic

**Status:** Not Started
**Blocked by:** Task 1.2 (ChatPanel must have scroll state tracking)
**Files to modify:**

- `apps/client/src/components/chat/ChatPanel.tsx`

**Description:**

Track when new messages arrive while the user is scrolled up. This provides the `hasNewMessages` boolean that drives the pill indicator UI.

**Implementation:**

Add a `hasNewMessages` state and a ref to track the previous message count:

```typescript
const [hasNewMessages, setHasNewMessages] = useState(false);
const prevMessageCountRef = useRef(messages.length);

// Detect new messages arriving when user is scrolled up
useEffect(() => {
  const prevCount = prevMessageCountRef.current;
  prevMessageCountRef.current = messages.length;

  // If messages increased and user is NOT at bottom, flag new messages
  if (messages.length > prevCount && !isAtBottom) {
    setHasNewMessages(true);
  }
}, [messages.length, isAtBottom]);

// Reset hasNewMessages when user scrolls to bottom
useEffect(() => {
  if (isAtBottom) {
    setHasNewMessages(false);
  }
}, [isAtBottom]);
```

Update the `scrollToBottom` callback to also reset the indicator:

```typescript
const scrollToBottom = useCallback(() => {
  messageListRef.current?.scrollToBottom();
  setIsAtBottom(true);
  setHasNewMessages(false);
}, []);
```

**Acceptance criteria:**

- `hasNewMessages` becomes `true` when `messages.length` increases while `isAtBottom` is `false`
- `hasNewMessages` resets to `false` when `isAtBottom` becomes `true` (manual scroll or button click)
- `scrollToBottom` resets `hasNewMessages`
- No false positives on initial load or history fetch

---

### Task 2.2: Add "New messages" pill indicator UI

**Status:** Not Started
**Blocked by:** Task 2.1 (new messages detection must exist)
**Files to modify:**

- `apps/client/src/components/chat/ChatPanel.tsx`

**Description:**

Render a "New messages" pill indicator as an `absolute` child of the wrapper div in ChatPanel. The pill appears when `hasNewMessages` is true, positioned centered horizontally above the scroll button area. Clicking it scrolls to bottom.

**Implementation:**

Add the pill inside the wrapper div, alongside the scroll button:

```typescript
{/* New messages pill — centered, above scroll button */}
<AnimatePresence>
  {hasNewMessages && !isAtBottom && (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{
        duration: 0.2,
        exit: { duration: 0.15, ease: 'easeIn' },
      }}
      onClick={scrollToBottom}
      className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 rounded-full bg-foreground text-background text-xs font-medium px-3 py-1.5 shadow-sm cursor-pointer hover:bg-foreground/90 transition-colors"
      role="status"
      aria-live="polite"
    >
      New messages
    </motion.button>
  )}
</AnimatePresence>

{/* Scroll-to-bottom button — right-aligned */}
<AnimatePresence>
  {!isAtBottom && messages.length > 0 && !isLoadingHistory && (
    <motion.button
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.15 }}
      onClick={scrollToBottom}
      className="absolute bottom-4 right-4 rounded-full bg-background border shadow-sm p-2 hover:shadow-md transition-shadow"
      aria-label="Scroll to bottom"
    >
      <ArrowDown className="size-(--size-icon-md)" />
    </motion.button>
  )}
</AnimatePresence>
```

**Design specs:**

- Pill shape: `rounded-full`
- Colors: `bg-foreground text-background` (inverted, high contrast -- dark pill on light bg, light pill on dark bg)
- Typography: `text-xs font-medium`
- Padding: `px-3 py-1.5`
- Shadow: `shadow-sm`
- Position: `absolute bottom-16 left-1/2 -translate-x-1/2` (centered, 64px from bottom of wrapper)
- Animation enter: 200ms ease-out (opacity 0->1, y 8->0)
- Animation exit: 150ms ease-in (opacity 1->0, y 0->4)
- Accessibility: `role="status"` and `aria-live="polite"` for screen readers

**Layout when both visible:**

- Pill: centered, `bottom-16` (64px from bottom)
- Scroll button: right-aligned, `bottom-4` (16px from bottom)
- Both are clickable, both scroll to bottom, both fade out when user reaches bottom

**Acceptance criteria:**

- "New messages" pill appears centered when new messages arrive while scrolled up
- Pill fades in over 200ms and fades out over 150ms
- Clicking the pill scrolls to bottom and the pill disappears
- Pill and scroll button can be visible simultaneously without overlapping
- Pill has `role="status"` and `aria-live="polite"` for accessibility
- Pill uses inverted foreground/background colors for high contrast

---

### Task 2.3: Verify scroll position preservation after refactor

**Status:** Not Started
**Blocked by:** Task 2.2 (all scroll features must be implemented)
**Files to modify:** None (verification only)

**Description:**

Verify that when `isAtBottom` is false, the auto-scroll `useEffect` in MessageList does NOT fire. The current code uses `!showScrollButton` as a guard; after refactor it uses `isAtBottomRef.current`. Confirm the behavior is correct:

1. User scrolls up 300px (beyond 200px threshold)
2. New streaming text arrives (assistant is typing)
3. Scroll position stays exactly where the user left it
4. "New messages" pill appears
5. User clicks pill or scroll button -> scrolls to bottom
6. New streaming text now auto-scrolls as expected

**Manual verification steps:**

1. Start a chat session, send a message that triggers a long response
2. While assistant is streaming, scroll up significantly
3. Verify: scroll position does NOT jump, new content appears below viewport
4. Verify: "New messages" pill appears
5. Verify: scroll-to-bottom button appears (right-aligned, stays fixed)
6. Click the pill -> verify: smooth scroll to bottom, both indicators disappear
7. Repeat: scroll up again, this time click the scroll button instead
8. Verify: same behavior as clicking the pill

**Acceptance criteria:**

- Scroll position is preserved when user is scrolled up and new messages arrive
- Auto-scroll resumes when user returns to bottom (manually or via button/pill)
- No jank or flicker in scroll position during streaming

---

## Phase 3: Testing & Polish

### Task 3.1: Update existing MessageList and ChatPanel tests

**Status:** Not Started
**Blocked by:** Task 2.2 (all implementation changes must be complete)
**Files to modify:**

- `apps/client/src/components/chat/__tests__/MessageList.test.tsx`

**Description:**

Update the existing `MessageList.test.tsx` to account for:

1. Removed scroll-to-bottom button from MessageList
2. New `onScrollStateChange` callback prop
3. `forwardRef` wrapper on MessageList
4. Removed `relative` and `flex-1` classes from scroll container
5. Removed `motion/react` and `lucide-react` imports from MessageList

**Implementation:**

1. **Remove the motion mock** from MessageList tests (MessageList no longer uses motion). The mock can be removed or kept for other test files that import it. If other tests in the same file don't need it, remove:

```typescript
// Remove this entire block if MessageList no longer uses motion:
vi.mock('motion/react', () => ({
  motion: { ... },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
```

However, if the test file tests components that still use motion (e.g. through MessageItem), keep the mock.

2. **Update the scroll container class assertion** (line 192-193):

```typescript
it('has scroll container with overflow', () => {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'Test', timestamp: new Date().toISOString() },
  ];
  const { container } = render(
    <MessageList sessionId="test-session" messages={messages} />
  );
  const scrollContainer = container.querySelector('.overflow-y-auto');
  expect(scrollContainer).not.toBeNull();
  // Verify it no longer has 'relative' class (button moved to parent)
  expect(scrollContainer?.classList.contains('relative')).toBe(false);
});
```

3. **Add test for onScrollStateChange callback:**

```typescript
it('accepts onScrollStateChange callback prop', () => {
  const handleScrollState = vi.fn();
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'Test', timestamp: new Date().toISOString() },
  ];
  // Should render without error when callback is provided
  const { container } = render(
    <MessageList
      sessionId="test-session"
      messages={messages}
      onScrollStateChange={handleScrollState}
    />
  );
  expect(container).toBeDefined();
});
```

4. **Add test verifying no scroll button in MessageList:**

```typescript
it('does not render scroll-to-bottom button', () => {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'Test', timestamp: new Date().toISOString() },
  ];
  const { container } = render(
    <MessageList sessionId="test-session" messages={messages} />
  );
  const button = container.querySelector('button[aria-label="Scroll to bottom"]');
  expect(button).toBeNull();
});
```

5. **All existing `computeGrouping` tests remain unchanged** -- they test a pure function with no UI dependencies.

6. **All existing MessageList rendering tests remain unchanged** -- they test message rendering, not scroll button behavior.

**Acceptance criteria:**

- All existing tests pass after the refactor
- No test references the scroll button inside MessageList
- New test verifies `onScrollStateChange` callback prop is accepted
- New test verifies scroll button is NOT rendered inside MessageList
- `npx vitest run apps/client/src/components/chat/__tests__/MessageList.test.tsx` passes
- `turbo test` passes with zero failures

---

### Task 3.2: Manual verification checklist

**Status:** Not Started
**Blocked by:** Task 3.1 (all tests must pass)
**Files to modify:** None (manual QA only)

**Description:**

Perform end-to-end manual verification of all four scroll behaviors in different environments.

**Checklist:**

**Behavior 1: Auto-scroll when at bottom**

- [ ] Send a message, assistant starts streaming
- [ ] Chat auto-scrolls as new content appears
- [ ] Neither the pill nor the scroll button is visible

**Behavior 2: Preserve scroll when scrolled up**

- [ ] While assistant is streaming, scroll up 300px+
- [ ] New content continues arriving but scroll position stays
- [ ] Scroll button appears (bottom-right, stays fixed)
- [ ] "New messages" pill appears (centered)

**Behavior 3: New messages indicator**

- [ ] Pill text reads "New messages"
- [ ] Clicking pill scrolls to bottom
- [ ] Pill fades out after reaching bottom
- [ ] Pill and scroll button are both visible simultaneously

**Behavior 4: Fixed scroll button**

- [ ] Scroll button stays visually fixed above input area
- [ ] Button does NOT scroll with content (the original bug)
- [ ] Clicking button scrolls to bottom
- [ ] Button fades out after reaching bottom

**Environment-specific:**

- [ ] Obsidian embedded mode: switch sidebar tabs, return to chat -- scroll position restores correctly (IntersectionObserver logic)
- [ ] Mobile viewport (375px wide): both indicators render without overflow
- [ ] Dark mode: pill uses inverted colors correctly (light pill on dark bg)
- [ ] Empty state: no indicators visible when no messages
- [ ] Loading state: no indicators visible while history loads

**Acceptance criteria:**

- All checklist items pass
- No visual regressions in existing chat behavior
- Scroll-to-bottom button is demonstrably fixed (no longer scrolls with content)

---

## Dependency Graph

```
Task 1.1 (Refactor MessageList)
  └──> Task 1.2 (Refactor ChatPanel + wrapper)
         └──> Task 2.1 (New messages detection)
                └──> Task 2.2 (New messages pill UI)
                       └──> Task 2.3 (Verify scroll preservation)
                              └──> Task 3.1 (Update tests)
                                     └──> Task 3.2 (Manual verification)
```

**Summary:**

- Phase 1 (Tasks 1.1, 1.2): Sequential -- 1.2 depends on 1.1's new exports
- Phase 2 (Tasks 2.1, 2.2, 2.3): Sequential -- each builds on the previous
- Phase 3 (Tasks 3.1, 3.2): Sequential -- tests first, then manual QA
