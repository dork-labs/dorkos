# Specification: Chat Message Area Improvements

**Status:** Draft
**Authors:** Claude Code, 2026-02-13
**Slug:** chat-message-area-improvements
**Related:** `specs/smart-chat-scroll/`, `specs/inference-status-indicator/`

---

## 1. Overview

Three targeted fixes to the chat/message history area that share the same component surface:

1. **Defer empty assistant response** — Don't render the assistant message shell until the first content event arrives
2. **Fix auto-scroll via ResizeObserver** — Replace the limited `scrollTrigger` string with a ResizeObserver that catches all height changes
3. **Keep InferenceIndicator visible** — Use `scrollToOffset` instead of `scrollToIndex` so the indicator stays in view during streaming

## 2. Background / Problem Statement

### Problem 1: Empty Assistant Response Area

After the user submits a message, an empty assistant message area (with `●` dot indicator) appears immediately. When Claude takes time to start responding, this blank area persists for several seconds and looks broken.

**Root cause:** `use-chat-session.ts` line 177-185 eagerly creates an assistant message with `content: ''` and `parts: []` in `handleSubmit`, before any SSE event arrives. `MessageItem` renders this with the dot indicator and an empty content area.

### Problem 2a: Tool Calls Break Auto-scroll

When the user is at the bottom and tool calls arrive or expand, the chat doesn't auto-scroll to keep new content visible.

**Root cause:** The `scrollTrigger` (`${messages.length}:${lastMsg?.toolCalls?.length ?? 0}`) only fires on message count or tool call count changes. It misses: text delta accumulation, tool card height changes (expansion/collapse animations), and tool call status transitions that change rendered height.

### Problem 2b: InferenceIndicator Below the Fold

The InferenceIndicator (rotating verbs + timer + tokens) gets pushed below the viewport during streaming.

**Root cause:** The indicator is positioned at `top: virtualizer.getTotalSize()` but `scrollToIndex(messages.length - 1, { align: 'end' })` scrolls to the bottom of the last _message_, not to the indicator below it.

## 3. Goals

- Eliminate the empty assistant message shell that appears before any streaming content
- Auto-scroll reliably when content height changes (text growth, tool card expansion, tool status changes)
- Keep the InferenceIndicator visible during streaming when the user is at the bottom
- Preserve existing scroll behavior: no auto-scroll when user has scrolled up, touch scrolling not disrupted

## 4. Non-Goals

- Changing the InferenceIndicator design/content
- Changing the message grouping algorithm
- Modifying the SSE streaming protocol or server-side logic
- Adding a typing indicator / shimmer skeleton
- Changing the scroll-to-bottom button or "new messages" pill behavior (beyond making them work with the new scroll mechanism)

## 5. Technical Dependencies

| Dependency                     | Version  | Purpose                                                |
| ------------------------------ | -------- | ------------------------------------------------------ |
| `@tanstack/react-virtual`      | ^3.11.0  | Virtual scrolling — `useVirtualizer`, `scrollToOffset` |
| `motion`                       | ^12.33.0 | Animations — message entrance, tool card transitions   |
| `ResizeObserver` (browser API) | Native   | Detect content height changes for auto-scroll          |

No new dependencies required. `scrollToOffset` is already available on the `@tanstack/react-virtual` virtualizer instance but not currently used.

## 6. Detailed Design

### 6.1 Fix 1: Defer Assistant Message Creation

**Current flow:**

```
handleSubmit() → creates empty assistant message → SSE starts → handleStreamEvent() updates it
```

**New flow:**

```
handleSubmit() → stores assistantId in ref → SSE starts → handleStreamEvent() creates + updates message on first content event
```

**Changes to `use-chat-session.ts`:**

1. Add a ref to track whether the assistant message has been created:

   ```typescript
   const assistantCreatedRef = useRef(false);
   ```

2. In `handleSubmit`, remove the eager `setMessages` call (lines 177-185). Keep the `assistantId` generation but store it in a ref:

   ```typescript
   const assistantIdRef = useRef<string>('');
   // In handleSubmit:
   assistantIdRef.current = crypto.randomUUID();
   assistantCreatedRef.current = false;
   ```

3. In `handleStreamEvent`, before the first call to `updateAssistantMessage`, check if the message exists. If not, create it:

   ```typescript
   function ensureAssistantMessage(assistantId: string) {
     if (!assistantCreatedRef.current) {
       assistantCreatedRef.current = true;
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
     }
   }
   ```

4. Call `ensureAssistantMessage(assistantId)` at the start of `updateAssistantMessage`. This means the assistant message is created on the first `text_delta`, `tool_call_start`, `approval_required`, or `question_prompt` event — any event that triggers `updateAssistantMessage`.

5. Handle edge case: if `done` arrives without any content events, no assistant message is created. This is correct — there's nothing to display.

**Impact on history loading:** None. History-loaded messages already have content, so they render normally through the existing `useEffect` that seeds from `historyQuery.data`.

### 6.2 Fix 2: Auto-scroll via ResizeObserver

**Current implementation (to be replaced):**

```typescript
// MessageList.tsx lines 129-138
const lastMsg = messages[messages.length - 1];
const scrollTrigger = `${messages.length}:${lastMsg?.toolCalls?.length ?? 0}`;

useEffect(() => {
  if (messages.length > 0 && isAtBottomRef.current && !isTouchActiveRef.current) {
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }
}, [scrollTrigger, virtualizer]);
```

**New implementation:**

1. Attach a `ResizeObserver` to the virtualizer's inner content div (the `div` with `style={{ height: virtualizer.getTotalSize(), position: 'relative' }}`). Use a ref to capture this element.

2. When the observer fires and `isAtBottomRef.current === true` and `!isTouchActiveRef.current`, scroll to bottom using `scrollToOffset`.

3. Debounce with `requestAnimationFrame` to avoid layout thrashing:

   ```typescript
   const contentRef = useRef<HTMLDivElement>(null);
   const rafIdRef = useRef<number>(0);

   useEffect(() => {
     const contentEl = contentRef.current;
     if (!contentEl) return;

     const observer = new ResizeObserver(() => {
       if (isAtBottomRef.current && !isTouchActiveRef.current) {
         cancelAnimationFrame(rafIdRef.current);
         rafIdRef.current = requestAnimationFrame(() => {
           const scrollEl = parentRef.current;
           if (scrollEl) {
             scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
           }
         });
       }
     });

     observer.observe(contentEl);
     return () => {
       observer.disconnect();
       cancelAnimationFrame(rafIdRef.current);
     };
   }, []);
   ```

4. Keep a message-count-based scroll trigger as well, for the case where a new message is added (the ResizeObserver may not fire synchronously when a new virtual row appears):
   ```typescript
   useEffect(() => {
     if (messages.length > 0 && isAtBottomRef.current && !isTouchActiveRef.current) {
       requestAnimationFrame(() => {
         const scrollEl = parentRef.current;
         if (scrollEl) {
           scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
         }
       });
     }
   }, [messages.length]);
   ```

**Why `scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight` instead of `virtualizer.scrollToOffset`:** The scroll container's `scrollHeight` includes everything rendered inside it — both the virtualizer items and the InferenceIndicator positioned below them. This naturally accounts for the indicator's height without needing to measure it separately.

### 6.3 Fix 3: InferenceIndicator Visibility

This fix is largely addressed by Fix 2. Since the ResizeObserver triggers on _any_ height change within the content div, and the scroll target is the container's full `scrollHeight`, the InferenceIndicator (positioned at `top: virtualizer.getTotalSize()`) is automatically included.

**Additional change:** Update the `scrollToBottom` imperative method (exposed via `MessageListHandle`) to also use the native scroll approach:

```typescript
const scrollToBottom = useCallback(() => {
  const scrollEl = parentRef.current;
  if (scrollEl) {
    scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
  }
}, []);
```

**Also update the IntersectionObserver re-show logic** (lines 105-125) to use the same native scroll approach instead of `virtualizer.scrollToIndex`.

## 7. User Experience

### Before (Current)

1. User submits message
2. Empty assistant bubble with `●` dot appears immediately
3. Seconds pass with blank area (looks broken)
4. Content starts appearing
5. Tool calls may push user off bottom
6. InferenceIndicator not visible during streaming

### After (Fixed)

1. User submits message
2. InferenceIndicator shows "Thinking..." at bottom of message list (already works — tied to `status === 'streaming'`)
3. First content arrives → assistant message appears with content
4. As content grows (text, tool calls), auto-scroll keeps user at bottom
5. InferenceIndicator stays visible below the content

## 8. Testing Strategy

### Unit Tests: `use-chat-session.test.tsx`

Tests for deferred message creation:

1. **"does not create assistant message immediately on submit"** — After calling `handleSubmit`, verify messages array contains only the user message, no empty assistant message.

2. **"creates assistant message on first text_delta"** — Simulate a `text_delta` event arriving; verify the assistant message now exists in state with the delta text.

3. **"creates assistant message on first tool_call_start"** — Simulate a `tool_call_start` event; verify the assistant message exists with the tool call part.

4. **"does not create duplicate assistant messages on subsequent events"** — After the first event creates the message, verify subsequent `text_delta` events update (not duplicate) it.

5. **"handles done without content gracefully"** — Simulate `done` event without any prior content events; verify no assistant message is created and status returns to 'idle'.

### Unit Tests: `MessageList.test.tsx`

Tests for scroll behavior:

6. **"attaches ResizeObserver to content container"** — Mock `ResizeObserver` and verify it's called with the content div.

7. **"scroll container uses native scrollTop for scrollToBottom"** — Call the imperative `scrollToBottom` and verify it sets `scrollTop` on the scroll container.

### Integration / Manual Testing

8. **Submit a message and verify no empty bubble** — The `●` dot area should not appear before content starts streaming.

9. **Submit a message with slow response** — InferenceIndicator should be the only feedback until content arrives.

10. **Tool calls during streaming** — When tool calls arrive and expand, user stays at bottom.

11. **Tool card expansion/collapse** — Clicking to expand a tool card while at bottom keeps user at bottom.

12. **Manual scroll up** — Scrolling up during streaming disengages auto-scroll (existing behavior).

13. **Touch scrolling** — On mobile, touch scroll doesn't fight with auto-scroll (existing behavior).

14. **History loading** — Opening an existing session renders all messages normally (no regression).

15. **Scroll-to-bottom button** — Still works to jump to bottom when scrolled up.

### Mocking Strategy

- `ResizeObserver`: Mock globally in test setup; provide `observe`, `unobserve`, `disconnect` methods; store the callback to trigger it manually
- `requestAnimationFrame`: Use `vi.fn()` that calls its callback synchronously (or use vitest's fake timers)
- `@tanstack/react-virtual`: Keep existing mock but add `scrollToOffset` to the mock return value

## 9. Performance Considerations

- **ResizeObserver frequency:** The `requestAnimationFrame` debounce ensures at most one scroll per frame (~16ms). No layout thrashing.
- **No additional re-renders:** The ResizeObserver scroll uses native `scrollTop` assignment, which doesn't trigger React re-renders.
- **Deferred message creation:** One fewer `setMessages` call in `handleSubmit` (the assistant message is created lazily). Marginal improvement.
- **`ensureAssistantMessage` guard:** The `assistantCreatedRef` check is O(1) and runs only during streaming events.

## 10. Security Considerations

No security implications. All changes are client-side rendering and scroll behavior. No new data flows, no new inputs, no server-side changes.

## 11. Documentation

No documentation updates required. The changes are internal implementation fixes that don't affect the API, user-facing configuration, or developer guides.

## 12. Implementation Phases

### Phase 1: Defer Assistant Message Creation

- Modify `use-chat-session.ts` — move assistant message creation into `ensureAssistantMessage` called from `updateAssistantMessage`
- Update `use-chat-session.test.tsx` — add tests for deferred creation
- Verify: no empty bubble, history still works, InferenceIndicator shows during wait

### Phase 2: ResizeObserver Auto-scroll

- Modify `MessageList.tsx` — add ResizeObserver on content div, replace `scrollTrigger` useEffect
- Add `contentRef` to the inner div
- Update `scrollToBottom` and IntersectionObserver re-show to use native scroll
- Update `MessageList.test.tsx` — add ResizeObserver mock and tests
- Verify: tool calls don't break scroll, InferenceIndicator stays visible

### Phase 3: Validation

- Run `npx turbo test` — all tests pass
- Run `npx turbo build` — build passes
- Manual QA: test all scenarios from testing strategy

## 13. Files Modified

| File                                                             | Action                                                           | Phase |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----- |
| `apps/client/src/hooks/use-chat-session.ts`                      | **Modify** — Defer assistant message creation                    | 1     |
| `apps/client/src/hooks/__tests__/use-chat-session.test.tsx`      | **Modify** — Add deferred creation tests                         | 1     |
| `apps/client/src/components/chat/MessageList.tsx`                | **Modify** — ResizeObserver scroll, native scrollTop, contentRef | 2     |
| `apps/client/src/components/chat/__tests__/MessageList.test.tsx` | **Modify** — ResizeObserver mock and tests                       | 2     |

Files NOT modified:

- `ChatPanel.tsx` — No changes needed; it already passes `status` and streaming props correctly
- `MessageItem.tsx` — No changes needed; it will simply never receive an empty-parts assistant message
- `InferenceIndicator.tsx` — No changes needed; its positioning is fixed by the scroll improvements

## 14. Open Questions

None. All design decisions were resolved during ideation:

1. ~~**When to show assistant message**~~ (RESOLVED)
   **Answer:** On ANY content event (text_delta OR tool_call_start)

2. ~~**InferenceIndicator positioning**~~ (RESOLVED)
   **Answer:** Keep inside scroll area with improved scroll-to-bottom logic

3. ~~**Scroll trigger mechanism**~~ (RESOLVED)
   **Answer:** ResizeObserver with rAF debounce

4. ~~**Additional loading indicator**~~ (RESOLVED)
   **Answer:** InferenceIndicator is sufficient, no additional skeleton needed

## 15. Acceptance Criteria

1. After submitting a message, no empty assistant bubble appears — the next visible element below the user message is the InferenceIndicator
2. When the first `text_delta` or `tool_call_start` arrives, the assistant message renders immediately with content
3. History-loaded messages (with existing content) render normally — no regression
4. When user is at bottom and text deltas arrive, chat auto-scrolls to keep new content visible
5. When user is at bottom and tool calls arrive/expand, chat auto-scrolls to keep content visible
6. The InferenceIndicator (rotating verbs + timer) stays visible during streaming when user is at bottom
7. When user manually scrolls up, auto-scroll does NOT engage (existing behavior preserved)
8. Touch scrolling (mobile) is not disrupted by auto-scroll (existing behavior preserved)
9. The scroll-to-bottom button and "new messages" pill continue to work correctly
10. The "complete" summary (elapsed + tokens) scrolls naturally with history after streaming ends
11. All existing tests pass + new tests for deferred message creation and ResizeObserver scroll
12. Build passes: `npx turbo build`

## 16. References

- Ideation: `specs/chat-message-area-improvements/01-ideation.md`
- Existing scroll spec: `specs/smart-chat-scroll/02-specification.md`
- `@tanstack/react-virtual` docs: `scrollToOffset` method on Virtualizer instance
- MDN ResizeObserver: standard browser API, no polyfill needed for modern browsers
