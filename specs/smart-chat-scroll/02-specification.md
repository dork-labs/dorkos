---
slug: smart-chat-scroll
---

# Specification: Smart Chat Scroll Behavior

**Slug:** smart-chat-scroll
**Author:** Claude Code
**Date:** 2026-02-12
**Source:** [01-ideation.md](./01-ideation.md)

---

## Overview

Improve the chat message list scroll behavior to feel natural and polished. Four capabilities:

1. **Auto-scroll**: When the user is at the bottom, new messages automatically scroll into view
2. **Position preservation**: When the user has scrolled up, new messages do NOT change their scroll position
3. **New messages pill**: A centered "New messages" pill fades in when new messages arrive while scrolled up; clicking it or reaching the bottom dismisses it
4. **Fixed scroll-to-bottom button**: A right-aligned button that stays visually fixed above the input area (currently broken — scrolls with content)

---

## Technical Design

### Architecture Change: Overlay Wrapper Pattern

The root cause of the scroll button bug is that it's rendered **inside** the scroll container (`overflow-y-auto` + `position: relative`). The `absolute bottom-4` positioning resolves against the scroll content area, not the visible viewport.

**Solution:** Wrap the message area in a `relative` container in `ChatPanel`. The scroll button and new-messages pill become `absolute` children of this wrapper — outside the scroll container — so they stay visually fixed.

```
ChatPanel (flex flex-col h-full)
├── Message area wrapper (relative, flex-1, min-h-0)  ← NEW
│   ├── MessageList (h-full, overflow-y-auto)          ← MODIFIED (no longer flex-1)
│   ├── "New messages" pill (absolute, top-2, centered) ← NEW
│   └── Scroll-to-bottom button (absolute, bottom-4, right-4) ← MOVED HERE
├── TaskListPanel
├── Error message
└── chat-input-container
```

### Component Interface Changes

#### MessageList

**Remove:** Scroll-to-bottom button JSX, `motion/react` imports, `showScrollButton` state, `AnimatePresence`

**Add:**

- `onScrollStateChange` callback prop: `(state: { isAtBottom: boolean }) => void`
- `forwardRef` + `useImperativeHandle` exposing `scrollToBottom(): void`

The `isAtBottom` threshold changes from 100px to **200px** (per user decision) to trigger the scroll button earlier on deliberate scroll-up.

**Retained:** `computeGrouping` export, virtualizer setup, `IntersectionObserver` for Obsidian tab-switch, auto-scroll logic (fires only when `isAtBottom` is true).

#### ChatPanel

**Add:**

- `useRef<MessageListHandle>` to call `scrollToBottom()`
- `isAtBottom` state (from `onScrollStateChange` callback)
- `hasNewMessages` state (derived from message count changes while `!isAtBottom`)
- Overlay wrapper `div` around the message display area
- Scroll-to-bottom button (moved from MessageList, now `absolute bottom-4 right-4`)
- "New messages" pill (new, `absolute top-2 left-1/2 -translate-x-1/2`)

### Scroll State Logic

```typescript
// In ChatPanel
const [isAtBottom, setIsAtBottom] = useState(true);
const [hasNewMessages, setHasNewMessages] = useState(false);
const prevMessageCountRef = useRef(messages.length);

// Track new messages arriving while scrolled up
useEffect(() => {
  if (messages.length > prevMessageCountRef.current && !isAtBottom) {
    setHasNewMessages(true);
  }
  prevMessageCountRef.current = messages.length;
}, [messages.length, isAtBottom]);

// Clear indicator when reaching bottom
useEffect(() => {
  if (isAtBottom) {
    setHasNewMessages(false);
  }
}, [isAtBottom]);
```

### Auto-Scroll Behavior

The existing auto-scroll in `MessageList` uses a `scrollTrigger` string (`${messages.length}:${toolCalls.length}`) and fires `virtualizer.scrollToIndex()` when `!showScrollButton` (i.e., user is near bottom).

**Change:** Replace `!showScrollButton` condition with an `isAtBottomRef` (ref, not state, to avoid re-render loops). The ref is updated by the scroll event handler. Auto-scroll fires only when `isAtBottomRef.current` is true.

### UI Elements

#### Scroll-to-Bottom Button

Moves to ChatPanel's overlay wrapper. Styled as:

- `absolute bottom-4 right-4`
- `rounded-full bg-background border shadow-sm p-2 hover:shadow-md`
- `ArrowDown` icon from lucide-react
- `aria-label="Scroll to bottom"`
- Animated with `motion.button`: fade + slide up (150ms, ease-out)
- Visible when `!isAtBottom` (200px threshold)

#### "New Messages" Pill

New element in ChatPanel's overlay wrapper. Styled as:

- `absolute top-2 left-1/2 -translate-x-1/2`
- `rounded-full bg-primary text-primary-foreground text-sm px-4 py-1.5 shadow-sm cursor-pointer`
- Text: "New messages" (static, no count)
- `aria-label="Scroll to new messages"`
- Animated with `motion.button`: fade in 200ms ease-out, fade out 150ms ease-in
- Visible when `hasNewMessages && !isAtBottom`
- Click handler: calls `messageListRef.current.scrollToBottom()`

### Animation Specs

| Element           | Enter                       | Exit                       | Easing             |
| ----------------- | --------------------------- | -------------------------- | ------------------ |
| Scroll button     | opacity 0→1, y 10→0, 150ms  | opacity 1→0, y 0→10, 150ms | ease-out / ease-in |
| New messages pill | opacity 0→1, y -10→0, 200ms | opacity 1→0, 150ms         | ease-out / ease-in |

Both wrapped in `<AnimatePresence>` for exit animations.

---

## Files to Modify

| File                                              | Changes                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/client/src/components/chat/MessageList.tsx` | Remove button/AnimatePresence/motion imports. Add `forwardRef`, `useImperativeHandle`, `onScrollStateChange` prop. Change threshold to 200px. Replace `showScrollButton` with `isAtBottomRef`. Change container from `flex-1` to `h-full`. |
| `apps/client/src/components/chat/ChatPanel.tsx`   | Add overlay wrapper `div`. Add scroll button + pill JSX. Add `isAtBottom`, `hasNewMessages` state. Add `messageListRef`. Import `motion`, `AnimatePresence`, `ArrowDown`.                                                                  |

No server changes. No new dependencies. No changes to `MessageItem.tsx`, `use-chat-session.ts`, or `ChatInput.tsx`.

---

## Acceptance Criteria

1. When user is at the bottom of messages, new messages auto-scroll into view
2. When user has scrolled up, new messages do NOT change their scroll position
3. When user is scrolled up and new messages arrive, a centered "New messages" pill fades in
4. Clicking the pill scrolls to bottom and the pill fades out
5. Reaching the bottom by manual scrolling also fades out the pill
6. The scroll-to-bottom button stays visually fixed at bottom-right of the message area (does NOT scroll with content)
7. The scroll-to-bottom button appears when user scrolls 200px+ from bottom
8. Both pill and button can be visible simultaneously without overlapping
9. Animations respect `prefers-reduced-motion` (via existing `<MotionConfig reducedMotion="user">`)
10. Virtual scrolling performance is not degraded

---

## Out of Scope

- Changing the message data model or streaming architecture
- Infinite scroll / loading older messages on scroll-up
- Unread message count badges in the sidebar
- Smooth scroll behavior (known issues with TanStack Virtual dynamic heights)
- Changes to `MessageItem.tsx` or `use-chat-session.ts`

---

## Implementation Phases

### Phase 1: Core Refactor (P1)

1. Refactor `MessageList` — extract scroll state, remove button, add `forwardRef`/callback
2. Refactor `ChatPanel` — add overlay wrapper, receive scroll state, render button in new position

### Phase 2: New Features (P2)

3. Implement new messages detection logic in ChatPanel
4. Add "New messages" pill indicator UI with animations
5. Verify scroll position preservation works correctly after refactor

### Phase 3: Quality (P3)

6. Update tests for MessageList and ChatPanel
7. Manual verification of all acceptance criteria
