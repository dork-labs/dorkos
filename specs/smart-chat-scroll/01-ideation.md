---
slug: smart-chat-scroll
---

# Smart Chat Scroll Behavior

**Slug:** smart-chat-scroll
**Author:** Claude Code
**Date:** 2026-02-12
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Improve the chat message list scroll behavior to be natural and polished:
1. Auto-scroll to bottom as new messages arrive when user is already at the bottom
2. Preserve scroll position when user is NOT at bottom and new messages arrive
3. Show a "new messages available" indicator (fade in/out) when scrolled up and new messages arrive
4. Fix the scroll-to-bottom floating button — it currently scrolls with content instead of staying fixed above the input area

**Assumptions:**
- Virtual scrolling via `@tanstack/react-virtual` stays as the rendering strategy
- Changes are scoped to `MessageList.tsx` and `ChatPanel.tsx` — no server changes
- The "new messages" indicator and scroll-to-bottom button are two distinct UI elements
- Animations use `motion` (already in project) for consistency with existing patterns
- No new dependencies needed — use native `IntersectionObserver` and existing libraries

**Out of scope:**
- Changing the message data model or streaming architecture
- Infinite scroll / loading older messages on scroll-up
- Unread message count badges in the sidebar
- Smooth scroll behavior (known to have issues with dynamic heights in TanStack Virtual)

---

## 2) Pre-reading Log

- `apps/client/src/components/chat/MessageList.tsx`: **PRIMARY target.** Virtual scrolling with `useVirtualizer`, scroll button positioned `absolute bottom-4` inside the scroll container (root cause of positioning bug). Auto-scroll fires via `useEffect` on `scrollTrigger` string. Scroll detection via scroll event listener with 100px threshold.
- `apps/client/src/components/chat/ChatPanel.tsx`: Parent layout — `flex flex-col h-full`. MessageList is `flex-1`, followed by TaskListPanel, error display, then `chat-input-container`. The scroll button needs to move here or use a different positioning strategy.
- `apps/client/src/components/chat/MessageItem.tsx`: Receives `isNew` prop for entrance animations. No changes needed.
- `apps/client/src/hooks/use-chat-session.ts`: Streaming events update messages via `currentPartsRef` → `setMessages`. Returns `messages`, `status`, `isLoadingHistory`. May need to expose a "new messages since last viewed" signal.
- `apps/client/src/index.css`: `.chat-scroll-area` has `touch-action: pan-y` on mobile. `.chat-input-container` has safe-area-inset padding. Keyframe animations for typing-dot and blink-cursor already defined.
- `guides/design-system.md`: Animation timings — Fast: 150ms (hover), Normal: 200ms (enter/exit), Slow: 300ms (expand/collapse).

---

## 3) Codebase Map

**Primary Components/Modules:**
- `apps/client/src/components/chat/MessageList.tsx` — Virtual scroll container, scroll detection, scroll-to-bottom button
- `apps/client/src/components/chat/ChatPanel.tsx` — Parent flex layout, orchestrates MessageList + ChatInput

**Shared Dependencies:**
- `@tanstack/react-virtual` — `useVirtualizer` for virtual scrolling
- `motion/react` — `AnimatePresence`, `motion.button` for scroll button animation
- `lucide-react` — `ArrowDown` icon

**Data Flow (scroll state):**
```
Messages arrive (streaming/history)
  → setMessages() in useChatSession
  → MessageList receives new messages prop
  → scrollTrigger string changes (`${messages.length}:${toolCalls.length}`)
  → useEffect fires → conditionally calls virtualizer.scrollToIndex()
  → handleScroll callback tracks position → sets showScrollButton
```

**CSS/Layout Structure:**
```
ChatPanel (flex flex-col h-full)
├── MessageList (chat-scroll-area, flex-1, overflow-y-auto, relative)  ← SCROLL CONTAINER
│   ├── Virtual items container (relative, height: getTotalSize())
│   │   └── MessageItem[] (absolute, translateY positioned)
│   └── Scroll button (absolute bottom-4)  ← BUG: scrolls with content
├── TaskListPanel (border-t)
├── Error message (optional)
└── chat-input-container (relative, border-t, p-4)  ← BUTTON SHOULD BE ABOVE THIS
```

**Potential Blast Radius:**
- **Direct changes:** `MessageList.tsx`, `ChatPanel.tsx`, possibly `index.css`
- **No changes needed:** `MessageItem.tsx`, `use-chat-session.ts`, `ChatInput.tsx`
- **Test files:** `apps/client/src/components/chat/__tests__/` (if MessageList tests exist)

---

## 4) Root Cause Analysis

### Bug: Scroll-to-bottom button scrolls with content

**Observed:** As the user scrolls the message list, the floating button moves up/down with the content instead of staying fixed in position.

**Expected:** Button stays visually fixed just above the chat input area, regardless of scroll position.

**Root cause:** The button is rendered INSIDE `MessageList` with `className="absolute bottom-4"`. The `absolute` position is relative to `MessageList`'s scroll container (`overflow-y-auto` + `position: relative`). Since the button is a child of the scroll container, it participates in the scroll flow.

**Evidence:** `MessageList.tsx:114` — the parent div has `className="chat-scroll-area flex-1 overflow-y-auto relative"`. The button at line 156 uses `absolute bottom-4 left-1/2`. Because `absolute` positioning resolves against the nearest positioned ancestor, and that ancestor IS the scroll container, the button's `bottom: 4` is measured from the bottom of the scroll container's content area — not its viewport.

**Fix:** Move the button (and new indicator) OUT of the scroll container. Position them in `ChatPanel` using `absolute` positioning relative to the `ChatPanel` flex container, or use a wrapper div with `relative` that contains both the scroll area and the overlays.

---

## 5) Research

### Potential Solutions

**1. Move overlays to ChatPanel with absolute positioning (Recommended)**
- Create a `relative` wrapper in ChatPanel around the MessageList area
- Position scroll button and new-messages indicator as `absolute` children of the wrapper
- Button uses `bottom-0` (sits at bottom of the wrapper, which is above TaskListPanel/ChatInput)
- Pros: Clean separation, button stays fixed, no CSS hacks
- Cons: Requires MessageList to expose scroll state to parent via callback/ref

**2. Use `position: sticky` on the button inside the scroll container**
- Pros: Simpler, keeps button inside MessageList
- Cons: `sticky` does NOT work when parent has `overflow: auto/scroll` (our exact case). This approach won't work.

**3. Use `position: fixed` on the button**
- Pros: Always visible regardless of scroll
- Cons: Positioned relative to viewport, not the chat area. Breaks in Obsidian embedded mode. Hard to position above ChatInput dynamically.

**Recommendation:** Option 1 — Move overlays to a wrapper in ChatPanel.

### Scroll Detection Strategy

**Current:** Scroll event listener with 100px threshold — fires on every scroll tick.

**Better:** Keep the scroll event listener (it's already `{ passive: true }` and throttled by the browser). The existing approach is fine and more reliable than IntersectionObserver for tracking continuous scroll position. Add a `newMessagesCount` ref that increments when `messages.length` changes while `isAtBottom` is false.

### Animation Specs (from design system)

| Element | Duration | Easing |
|---------|----------|--------|
| Scroll button appear/disappear | 150ms | ease-out |
| New messages indicator fade in | 200ms | ease-out |
| New messages indicator fade out | 150ms | ease-in |

---

## 6) Decisions (Resolved)

1. **New messages indicator design:** Simple text pill — "New messages" (no count). Clean, low visual noise, Slack-style.

2. **New messages indicator position:** Horizontally centered in the message area. Scroll-to-bottom button is right-aligned. They are independent, non-overlapping elements.

3. **Scroll-to-bottom button threshold:** 200px from bottom. Appears fairly quickly after deliberate scroll-up, prevents flickering on small adjustments.

4. **Clicking "new messages" pill:** Yes — scrolls to bottom and fades out. Same behavior as the scroll button.

5. **Layout when both visible:** Both visible simultaneously. Pill centered, scroll button bottom-right. Both clickable, both scroll to bottom. Both fade out when user reaches bottom.
