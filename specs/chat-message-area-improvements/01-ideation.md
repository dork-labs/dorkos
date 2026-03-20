---
slug: chat-message-area-improvements
number: 16
created: 2026-02-13
status: implemented
---

# Chat Message Area Improvements

**Slug:** chat-message-area-improvements
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Two improvements to the chat/message history area:

1. **Defer empty assistant response**: The assistant response area (with the "dot" indicator on the left) currently appears immediately after the user submits a prompt. When Claude takes a while to start responding, this leaves a blank area with just a dot that looks broken. We need to defer showing the response area until there's actual content to display.
2. **Fix auto-scroll behavior**: When the user is at the bottom of the chat and new content arrives, auto-scroll has two issues: (a) tool calls break the auto-scroll, causing the user to get stuck above the new content, and (b) the InferenceIndicator (rotating verb + timer) gets pushed below the fold and isn't visible during streaming.

**Assumptions:**

- The fix should not break history loading (messages loaded from transcripts should still render normally)
- Tool calls that arrive before any text should still be visible (we defer the empty shell, not the tool calls themselves)
- The InferenceIndicator should be visible at all times during streaming, regardless of scroll position
- Performance should not regress — no layout thrashing or excessive re-renders

**Out of scope:**

- Changing the InferenceIndicator design/content
- Changing the message grouping algorithm
- Modifying the SSE streaming protocol or server-side logic
- Adding a "typing indicator" / shimmer skeleton (though this may be a natural follow-up)

---

## 2) Pre-reading Log

- `apps/client/src/hooks/use-chat-session.ts`: Core streaming hook. Lines 177-185 create an empty assistant message immediately after user submits. `handleStreamEvent` updates this message as events arrive.
- `apps/client/src/components/chat/MessageList.tsx`: Virtualized message list using `@tanstack/react-virtual`. InferenceIndicator is positioned absolutely at `top: virtualizer.getTotalSize()` (line 188). Auto-scroll uses `scrollToIndex` triggered by `scrollTrigger` (line 130-138).
- `apps/client/src/components/chat/MessageItem.tsx`: Renders individual messages. Assistant messages with no parts render a `●` dot + empty content area (lines 136-143, 174-218).
- `apps/client/src/components/chat/InferenceIndicator.tsx`: Shows rotating verbs + elapsed time + token count during streaming. Returns `null` when idle and no `showComplete`. Positioned inside the virtual list's content div.
- `apps/client/src/components/chat/ChatPanel.tsx`: Parent orchestrator. Passes `status`, `isTextStreaming`, `streamStartTime`, `estimatedTokens` down to MessageList.
- `apps/client/src/components/chat/StreamingText.tsx`: Wraps Streamdown markdown renderer. Shows blinking cursor when `isStreaming`.
- `apps/client/src/index.css`: CSS animations for typing dots, blinking cursor, shimmer pulse.
- `guides/interactive-tools.md`: Documents the tool approval and question prompt flows.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/hooks/use-chat-session.ts` — Manages streaming lifecycle, creates assistant message shell, handles SSE events
- `apps/client/src/components/chat/MessageList.tsx` — Virtual list rendering, auto-scroll logic, InferenceIndicator placement
- `apps/client/src/components/chat/MessageItem.tsx` — Individual message rendering (dot indicator, parts iteration)
- `apps/client/src/components/chat/InferenceIndicator.tsx` — Streaming status display (verb + timer + tokens)
- `apps/client/src/components/chat/ChatPanel.tsx` — Parent container, scroll state management, scroll-to-bottom button

**Shared Dependencies:**

- `@tanstack/react-virtual` (useVirtualizer) — Virtual scrolling
- `motion/react` — Animations (message entrance, indicator transitions)
- Zustand (`app-store.ts`) — UI preferences (autoHideToolCalls, expandToolCalls, showTimestamps)

**Data Flow:**
User submits → `useChatSession.handleSubmit()` → creates empty assistant message → SSE stream begins → `handleStreamEvent` receives `text_delta` / `tool_call_start` / etc. → updates `currentPartsRef` → calls `updateAssistantMessage()` → `setMessages()` triggers re-render → `MessageList` virtualizer re-renders → `MessageItem` shows content

**Auto-scroll Flow:**
`scrollTrigger` = `${messages.length}:${lastMsg?.toolCalls?.length}` → useEffect calls `virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })` — BUT this only triggers on message count or toolCalls array length changes, not on:

- Text delta accumulation within the same message
- InferenceIndicator height changes
- Individual tool call status changes (running → complete)

**Potential Blast Radius:**

- Direct: `use-chat-session.ts`, `MessageList.tsx`, `MessageItem.tsx`
- Indirect: `ChatPanel.tsx` (may need new props), `InferenceIndicator.tsx` (position change)
- Tests: `MessageList.test.tsx`, `use-chat-session.test.tsx`, potentially new test file

---

## 4) Root Cause Analysis

### Issue 1: Empty Assistant Response Area

**Observed:** After user submits, a blank assistant message area (dot + empty content) appears immediately, before any streaming data arrives. Can persist for several seconds.

**Root Cause:** In `use-chat-session.ts` lines 177-185, `handleSubmit` eagerly creates an empty assistant message:

```ts
setMessages((prev) => [
  ...prev,
  {
    id: assistantId,
    role: 'assistant',
    content: '',
    toolCalls: [],
    parts: [],
    timestamp: new Date().toISOString(),
  },
]);
```

This is added to the messages array before any SSE event arrives. `MessageItem` then renders this message with the `●` dot indicator and an empty content area.

**Evidence:** The assistant message is created with `content: ''` and `parts: []`. In `MessageItem`, assistant messages iterate over `parts` (line 175), which is empty, so nothing renders in the content area — but the outer `motion.div` with the dot indicator still takes up space.

### Issue 2a: Tool Calls Break Auto-scroll

**Observed:** When the user is at the bottom and tool calls arrive, the chat doesn't scroll to keep them visible.

**Root Cause:** The `scrollTrigger` in `MessageList.tsx` (line 130) is:

```ts
const scrollTrigger = `${messages.length}:${lastMsg?.toolCalls?.length ?? 0}`;
```

This triggers on the _count_ of tool calls changing. However, tool call content grows (input deltas, status changes from running → complete) without changing the count. More importantly, `useVirtualizer` doesn't automatically detect content height changes within already-rendered items. The `measureElement` ref measures on mount, but tool cards expand/collapse with animations that change height after measurement.

Additionally, the `scrollToIndex(messages.length - 1, { align: 'end' })` scrolls to the last _message_, but the InferenceIndicator is positioned _after_ the last message at `top: virtualizer.getTotalSize()`. So "scrolled to end of last message" doesn't necessarily mean the InferenceIndicator is visible.

### Issue 2b: InferenceIndicator Below the Fold

**Observed:** As auto-scroll keeps the last message in view, the InferenceIndicator (positioned absolutely after all virtual items) sits below the visible viewport.

**Root Cause:** The InferenceIndicator is placed at:

```tsx
<div style={{ position: 'absolute', top: virtualizer.getTotalSize(), left: 0, width: '100%' }}>
  <InferenceIndicator ... />
</div>
```

`scrollToIndex(messages.length - 1, { align: 'end' })` aligns the bottom of the last message with the bottom of the viewport. The InferenceIndicator, which lives _below_ the virtualizer's total size, is therefore below the fold. The virtualizer's `getTotalSize()` represents the sum of measured item heights, and the indicator adds additional height beyond that.

**Decision:** All three issues stem from the scroll + rendering architecture. Fix requires:

1. Deferring the assistant message creation until first content arrives
2. Making auto-scroll account for content changes within messages (not just count)
3. Ensuring the InferenceIndicator is always visible during streaming

---

## 5) Research

### Potential Solutions

#### Issue 1: Defer Empty Assistant Response

**1A. Don't create the assistant message until first content event arrives** (Recommended)

- Move the `setMessages(prev => [...prev, assistantMsg])` from `handleSubmit` into `handleStreamEvent`, triggered on the first `text_delta` or `tool_call_start`
- Use a ref (`assistantIdRef`) to track whether the assistant message has been created yet
- Pros: Clean — no empty messages in state, no visual artifact, InferenceIndicator still shows (it's tied to `status === 'streaming'`, not message count)
- Cons: Slightly more complex logic in `handleStreamEvent`; need to handle edge case where `done` arrives without any content events

**1B. Filter out empty assistant messages in MessageList rendering**

- Keep the eager creation but skip rendering messages with empty parts
- Pros: Simple, localized change in MessageList
- Cons: The message still exists in state (confusing), grouping algorithm still counts it, scroll behavior may still glitch

**1C. Create the message but render it collapsed/invisible until content arrives**

- Use `visibility: hidden` or `height: 0` on the MessageItem when parts are empty
- Pros: Message exists for event handling
- Cons: Still takes up space in virtual list (even if zero height, the virtualizer row exists), adds conditional rendering complexity

**Recommendation:** 1A — defer creation. The assistant message should only exist when there's something to show. The InferenceIndicator handles the "waiting for response" feedback independently.

#### Issue 2: Fix Auto-scroll

**2A. Use `scrollToOffset` targeting the bottom of the container instead of `scrollToIndex`** (Recommended)

- Replace `scrollToIndex(messages.length - 1, { align: 'end' })` with `scrollToOffset(virtualizer.getTotalSize() + indicatorHeight, { align: 'end' })`
- This ensures the full content including the InferenceIndicator is in view
- Trigger on a broader dependency: not just `scrollTrigger` but also `virtualizer.getTotalSize()` (which changes as items are re-measured)
- Pros: Addresses both tool call scroll breakage and InferenceIndicator visibility in one fix
- Cons: Need to account for InferenceIndicator height (fixed or measured)

**2B. Make InferenceIndicator a sticky/fixed element outside the scroll container**

- Move InferenceIndicator out of MessageList, position it as an overlay at the bottom of the scroll area
- Pros: Always visible regardless of scroll position; no scroll logic needed
- Cons: Overlaps message content; changes the visual layout; the "complete" state summary (elapsed time + tokens) would float awkwardly

**2C. Add InferenceIndicator as a virtual item in the list**

- Include it as a virtual row with its own index (count = messages.length + 1)
- `scrollToIndex(count - 1)` would then scroll to the indicator
- Pros: Works naturally with virtualizer
- Cons: The indicator is not a message, complicating the data model; index offsets may cause bugs

**2D. Use ResizeObserver on the virtualizer content to trigger scroll updates**

- Attach a ResizeObserver to the virtualizer's inner div
- When height changes and `isAtBottomRef.current` is true, scroll to bottom
- Pros: Catches ALL height changes (text growth, tool card expansion, animations)
- Cons: May fire too frequently causing layout thrashing; needs debouncing

**Recommendation:** Hybrid of 2A + 2D. Use `scrollToOffset` targeting the full content height (including indicator), and trigger it via ResizeObserver on the content div for real-time responsiveness. This catches all height-change scenarios (text deltas, tool card expansion, animation completion) without needing to enumerate every possible trigger in `scrollTrigger`.

---

## 6) Clarification

1. **When to show the assistant message shell for tool-call-only responses:** If Claude starts with tool calls before any text, should the tool calls appear immediately (creating the assistant message), or should we wait for text specifically?
   - Recommended: Show immediately when _any_ content event arrives (text_delta OR tool_call_start). Tool calls are real content.

2. **InferenceIndicator positioning approach:** Should we keep it inside the scroll area (always scroll to include it) or float it outside (always visible overlay)?
   - Recommended: Keep inside the scroll area with improved scroll-to-bottom logic. The "complete" summary state (elapsed + tokens) should scroll naturally with the conversation history.

3. **Scroll-to-bottom trigger mechanism:** Should we use ResizeObserver (automatic, catches everything) or expand the `scrollTrigger` dependency (explicit, more predictable)?
   - Recommended: ResizeObserver — it's the only approach that reliably catches dynamic height changes from animations, async image loading, tool card expansion, etc. The `scrollTrigger` string approach is fundamentally limited to state changes we can enumerate.

4. **Should we add a loading indicator between user message and first response?** The InferenceIndicator already shows "Thinking..." / rotating verbs, but it's positioned after the (nonexistent) assistant message. Without the empty shell, the indicator is the only feedback.
   - Recommended: The InferenceIndicator already provides this feedback. Deferring the assistant message creation means the indicator appears at the bottom of the message list immediately (since `status === 'streaming'`), which is actually better placement than the current behavior.
