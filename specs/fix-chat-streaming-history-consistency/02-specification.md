---
slug: fix-chat-streaming-history-consistency
number: 102
title: Fix Chat UI Streaming vs History Inconsistencies
status: Draft
created: 2026-03-08
authors: Claude Code
ideation: specs/fix-chat-streaming-history-consistency/01-ideation.md
---

# Fix Chat UI Streaming vs History Inconsistencies

## Overview

Two client-side rendering bugs cause the live streaming chat view to diverge visually from the history view in DorkOS. Both are observable and documented in the self-test evidence report (`test-results/chat-self-test/20260307-204840.md`).

**Bug 1 — Orphaned "Done" text:** A `"Done"` string appears as a floating plain-text element between a collapsed tool card and the next assistant response during streaming. It is absent in the history view.

**Bug 2 — Auto-scroll disengagement:** Auto-scroll silently stops working after long message sequences, requiring the user to manually click the ↓ button to see new responses.

Both bugs are pure client-side issues requiring minimal, targeted changes.

---

## Background / Problem Statement

### Bug 1: Orphaned "Done" Text During Tool Call Streaming

When an assistant performs a tool call, the SSE event sequence is:

```
tool_call_start → tool_call_delta(s) → tool_call_end → tool_result → text_delta("Done")
```

In `stream-event-handler.ts`, the `tool_result` case mutates the tool call part's `result` field and then calls `updateAssistantMessage(assistantId)` **synchronously**. This triggers a React render while the next `text_delta("Done")` SSE event is still in-flight. The render creates an intermediate state where the tool card is settled but there is no text part yet — then the `text_delta("Done")` arrives, causing React to append a new text part containing just `"Done"`.

This `"Done"` text part renders as a standalone string element between the collapsed tool card and whatever assistant text follows. It is an artifact of the intermediate render, not real content.

The history view is immune because `transcript-parser.ts` collapses all content atomically from the JSONL file — there is no intermediate render state.

**Root cause (high confidence):** Synchronous `updateAssistantMessage` call in the `tool_result` SSE handler forces an intermediate React render before the next `text_delta` batches.

### Bug 2: Auto-Scroll Disengagement After Long Messages

`MessageList.tsx` tracks whether the user is at the bottom of the chat via `isAtBottomRef`. Three auto-scroll trigger paths gate on this flag:

1. **ResizeObserver callback** — fires on content height changes
2. **`messages.length` effect** — fires when a new message is added
3. **message-delivered guard** — fires on relay delivery

Auto-scroll disengages when `isAtBottomRef.current` becomes `false`. This happens inside `handleScroll` when `distanceFromBottom >= 200`.

The problem: TanStack Virtual's `measureElement` ResizeObserver fires frequently during long message streaming. Each measurement triggers a layout reflow, which briefly changes `scrollHeight`. When `scrollHeight` shifts mid-render, `distanceFromBottom` temporarily exceeds 200px. `handleScroll` fires for this layout-driven scroll event, sets `isAtBottomRef.current = false`, and all three auto-scroll paths skip until the user manually clicks ↓ (which calls `scrollToBottom()` directly, recovering the flag).

`handleScroll` cannot distinguish between a user intentionally scrolling up and a layout reflow-driven scroll position jitter. Any scroll event with `distanceFromBottom > 200` flips the flag.

**Root cause (high confidence):** `handleScroll` lacks user-intent awareness. Layout reflow events from TanStack Virtual measurement spuriously disengage auto-scroll.

---

## Goals

- Eliminate the orphaned "Done" text element between collapsed tool cards and assistant responses during streaming
- Make streaming view and history view visually identical for tool call sequences
- Prevent auto-scroll from disengaging during long message streaming unless the user explicitly scrolls up
- Ensure `wheel` and `touchstart` events are the only mechanism that can disengage auto-scroll
- Add tests that cover both behaviors and can fail if regressions occur

---

## Non-Goals

- Changes to the relay transport path
- Changes to the SSE protocol or server-side event emission
- Changes to `ToolCallCard` expand/collapse UX
- Increasing the 200px threshold as the sole fix (insufficient alone)
- Changes to `MessageItem`, `ChatPanel`, or `ToolCallCard` components
- Any changes outside `apps/client/`

---

## Technical Dependencies

- **TanStack Virtual** (`@tanstack/react-virtual`) — virtual list library used by `MessageList`. Its `measureElement` ResizeObserver callback is the source of the layout reflow that triggers Bug 2.
- **React 19** — concurrent renderer; `queueMicrotask` scheduling interacts with React's batching.
- **Browser APIs** — `wheel` event (desktop scroll intent), `touchstart` event (mobile scroll intent), `setTimeout` (150ms debounce), `ResizeObserver`, `requestAnimationFrame`.

No new dependencies are introduced.

---

## Detailed Design

### Fix 1: `queueMicrotask` Deferral in `tool_result` Handler

**File:** `apps/client/src/layers/features/chat/model/stream-event-handler.ts`

**Change:** In the `tool_result` case, wrap the `updateAssistantMessage(assistantId)` call in `queueMicrotask`.

**Before (line 196):**

```typescript
case 'tool_result': {
  const tc = data as ToolCallEvent;
  const existing = findToolCallPart(tc.toolCallId);
  if (existing) {
    existing.result = tc.result;
    existing.status = 'complete';
    if (existing.interactiveType === 'question' && !existing.answers) {
      existing.answers = {};
    }
  }
  updateAssistantMessage(assistantId); // ← synchronous: fires before text_delta("Done")
  break;
}
```

**After:**

```typescript
case 'tool_result': {
  const tc = data as ToolCallEvent;
  const existing = findToolCallPart(tc.toolCallId);
  if (existing) {
    existing.result = tc.result;
    existing.status = 'complete';
    if (existing.interactiveType === 'question' && !existing.answers) {
      existing.answers = {};
    }
  }
  // Defer re-render by one microtask so the immediately-following
  // text_delta("Done") event can batch into the same React flush,
  // preventing an orphaned "Done" text part from appearing.
  queueMicrotask(() => updateAssistantMessage(assistantId));
  break;
}
```

**Why this works:** `queueMicrotask` schedules the `updateAssistantMessage` call after the current synchronous execution completes but before the next macrotask (rendering frame). The immediately-following `text_delta("Done")` SSE event arrives synchronously in the same event loop turn (SSE parsing is synchronous within a `ReadableStream` chunk). By the time `queueMicrotask` fires, `currentPartsRef.current` already contains the `"Done"` text part from `text_delta`, so `updateAssistantMessage` creates a unified render with both the completed tool result and the text, matching the history view.

**Risk:** If SSE parsing is asynchronous across event loop ticks (e.g., chunked SSE delivery where `tool_result` and `text_delta("Done")` are in separate HTTP chunks), `queueMicrotask` may not be sufficient. In that case, a `setTimeout(fn, 0)` fallback would be needed. The ideation research classifies this risk as low — SSE events within the same server response are typically delivered in a single chunk. If the `queueMicrotask` fix does not fully eliminate the orphan in all observed scenarios, upgrade to `setTimeout(fn, 0)` on the `updateAssistantMessage` call in the `tool_result` case.

**Blast radius:** One line changed in one file. No other cases in the switch statement are affected.

---

### Fix 2: User-Scroll-Intent Detection in `MessageList.tsx`

**File:** `apps/client/src/layers/features/chat/ui/MessageList.tsx`

**Changes:**

#### 2a. Add `isUserScrollingRef` and a `clearScrollIntentTimerRef`

Add two new refs at the top of the component body, alongside the existing `isAtBottomRef` and `isTouchActiveRef`:

```typescript
const isUserScrollingRef = useRef(false);
const clearScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

#### 2b. Attach `wheel` and `touchstart` listeners that set the intent flag

Add to the existing `useEffect` that manages event listeners on the scroll container (the one that registers `scroll`, `touchstart`, `touchend`, `touchcancel`):

```typescript
useEffect(() => {
  const container = parentRef.current;
  if (!container) return;

  const onTouchStart = () => {
    isTouchActiveRef.current = true;
    // Mark user scroll intent
    isUserScrollingRef.current = true;
    if (clearScrollIntentTimerRef.current) clearTimeout(clearScrollIntentTimerRef.current);
    clearScrollIntentTimerRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 150);
  };
  const onTouchEnd = () => {
    isTouchActiveRef.current = false;
  };
  const onWheel = () => {
    // wheel only fires for user-initiated scroll, never for programmatic scrollTop assignment
    isUserScrollingRef.current = true;
    if (clearScrollIntentTimerRef.current) clearTimeout(clearScrollIntentTimerRef.current);
    clearScrollIntentTimerRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 150);
  };

  container.addEventListener('scroll', handleScroll, { passive: true });
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });
  container.addEventListener('wheel', onWheel, { passive: true });

  return () => {
    container.removeEventListener('scroll', handleScroll);
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
    container.removeEventListener('wheel', onWheel);
    if (clearScrollIntentTimerRef.current) clearTimeout(clearScrollIntentTimerRef.current);
  };
}, [handleScroll]);
```

> **Note on existing `touchstart`/`touchend` handlers:** The existing code already registers `touchstart`/`touchend`/`touchcancel` on the container (for `isTouchActiveRef`). Merge the `isUserScrollingRef` logic into the existing `onTouchStart` handler rather than creating a duplicate listener. The implementation above shows the merged form.

#### 2c. Gate `isAtBottomRef = false` in `handleScroll` behind intent flag

**Before:**

```typescript
const handleScroll = useCallback(() => {
  const container = parentRef.current;
  if (!container) return;
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  const isAtBottom = distanceFromBottom < 200;
  const changed = isAtBottomRef.current !== isAtBottom;
  isAtBottomRef.current = isAtBottom;
  if (changed) {
    onScrollStateChange?.({ isAtBottom, distanceFromBottom });
  }
}, [onScrollStateChange]);
```

**After:**

```typescript
const handleScroll = useCallback(() => {
  const container = parentRef.current;
  if (!container) return;
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  const isAtBottom = distanceFromBottom < 200;

  // Only disengage auto-scroll when the user has explicitly scrolled up.
  // Layout reflow events from TanStack Virtual measurement also fire the
  // scroll event — gating behind isUserScrollingRef prevents these from
  // spuriously flipping the flag.
  const newValue = isAtBottom || !isUserScrollingRef.current ? isAtBottom : isAtBottomRef.current;
  const changed = isAtBottomRef.current !== newValue;
  isAtBottomRef.current = newValue;
  if (changed) {
    onScrollStateChange?.({ isAtBottom: newValue, distanceFromBottom });
  }
}, [onScrollStateChange]);
```

Simplified logic: `isAtBottomRef` is only set to `false` when `isUserScrollingRef.current === true`. Setting to `true` (when the user scrolls back to bottom) is always allowed — it's safe and desired.

#### 2d. Add `queueMicrotask` before RAF in ResizeObserver callback (Option D, complementary)

In the ResizeObserver callback that drives auto-scroll:

**Before:**

```typescript
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
```

**After:**

```typescript
const observer = new ResizeObserver(() => {
  if (isAtBottomRef.current && !isTouchActiveRef.current) {
    cancelAnimationFrame(rafIdRef.current);
    // queueMicrotask lets the virtualizer finish measurement before the RAF
    // fires, reducing the window where scrollHeight fluctuates mid-scroll.
    queueMicrotask(() => {
      rafIdRef.current = requestAnimationFrame(() => {
        const scrollEl = parentRef.current;
        if (scrollEl) {
          scrollEl.scrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
        }
      });
    });
  }
});
```

---

### Data Flow After Fix

**Bug 1 — tool_result sequence (fixed):**

```
SSE: tool_result → existing.result = ...; queueMicrotask(() => updateAssistantMessage())
SSE: text_delta("Done") → currentPartsRef.current = [...parts, { type: 'text', text: 'Done' }]
  → updateAssistantMessage() called (synchronously in text_delta case)
  → [microtask runs]: updateAssistantMessage() for tool_result — parts now include text part
  → React batches or deduplicates the update; "Done" is attached to the correct text run
```

**Bug 2 — reflow scroll event (fixed):**

```
Virtualizer ResizeObserver fires → scrollHeight jitters
→ handleScroll fires → distanceFromBottom > 200
→ isUserScrollingRef.current === false → isAtBottomRef stays true
→ All three auto-scroll paths: isAtBottomRef.current === true → scroll fires correctly
→ New message appears scrolled into view
```

---

## User Experience

- **Before fix 1:** During streaming of a message with tool calls, `"Done"` appears as a floating text element between the collapsed tool card and the next response block. It disappears when navigating to the history view of the same session.
- **After fix 1:** No floating text is visible between tool cards and response text. Streaming and history views are identical.

- **Before fix 2:** After a long assistant response with tool calls (e.g., 4+ tool calls), the next message from the assistant is not auto-scrolled into view. The ↓ button appears and the user must click it.
- **After fix 2:** New messages always scroll into view unless the user has explicitly scrolled up using the mouse wheel or touch gesture.

---

## Testing Strategy

### New Tests for `MessageList.test.tsx`

#### Test: Wheel event sets scroll intent flag; reflow scroll event does not disengage auto-scroll

```typescript
it('does not disengage auto-scroll on scroll events without prior wheel/touch input', () => {
  // Purpose: Verifies that handleScroll only sets isAtBottomRef=false when
  // isUserScrollingRef is true (i.e., user explicitly scrolled).
  // A reflow-driven scroll event without a preceding wheel/touchstart should
  // NOT flip isAtBottomRef to false.

  let scrollCallback: (() => void) | null = null;
  const mockContainer = {
    scrollHeight: 1000,
    scrollTop: 0,    // at top — would compute distanceFromBottom=800 (> 200)
    clientHeight: 200,
    addEventListener: vi.fn((event, cb) => {
      if (event === 'scroll') scrollCallback = cb;
    }),
    removeEventListener: vi.fn(),
  };
  vi.spyOn(React, 'useRef').mockReturnValueOnce({ current: mockContainer });

  const onScrollStateChange = vi.fn();
  render(
    <MessageList
      sessionId="test"
      messages={[{ id: '1', role: 'user', content: 'Hi', parts: [{ type: 'text', text: 'Hi' }], timestamp: '' }]}
      onScrollStateChange={onScrollStateChange}
    />
  );

  // Simulate a reflow scroll event with no prior wheel/touchstart
  scrollCallback?.();

  // isAtBottom should NOT have been reported as false (user didn't scroll)
  expect(onScrollStateChange).not.toHaveBeenCalledWith(
    expect.objectContaining({ isAtBottom: false })
  );
});
```

> **Implementation note:** Because `parentRef` is an internal ref, this test is best written as a behavioral integration test using the `onScrollStateChange` callback to observe the output, rather than asserting on internal ref values. The approach above mocks `useRef` — alternatively, dispatch actual `scroll` events on the rendered container element in jsdom.

**Preferred implementation (jsdom event dispatch):**

```typescript
it('does not disengage auto-scroll when scroll fires without wheel/touch', () => {
  // Purpose: Confirms that a programmatic scrollTop change (simulated by
  // directly firing a scroll event on the container, without a preceding
  // wheel event) does not flip isAtBottomRef to false.
  const onScrollStateChange = vi.fn();
  const messages = [
    { id: '1', role: 'user' as const, content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }], timestamp: '' },
  ];
  const { container } = render(
    <MessageList sessionId="test" messages={messages} onScrollStateChange={onScrollStateChange} />
  );

  const scrollEl = container.querySelector('[data-testid="message-list"]') as HTMLElement;
  // Fire a scroll event without preceding wheel — simulates layout reflow
  scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));

  // onScrollStateChange should not report isAtBottom:false
  const calls = onScrollStateChange.mock.calls;
  expect(calls.every(([state]) => state.isAtBottom !== false)).toBe(true);
});

it('disengages auto-scroll when wheel event precedes scroll', () => {
  // Purpose: Confirms that a wheel event (user intent) followed by a scroll
  // event correctly allows isAtBottomRef to become false.
  const onScrollStateChange = vi.fn();
  const messages = [
    { id: '1', role: 'user' as const, content: 'Hi', parts: [{ type: 'text' as const, text: 'Hi' }], timestamp: '' },
  ];
  const { container } = render(
    <MessageList sessionId="test" messages={messages} onScrollStateChange={onScrollStateChange} />
  );

  const scrollEl = container.querySelector('[data-testid="message-list"]') as HTMLElement;

  // Simulate user scrolling: wheel event first, then scroll
  scrollEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));

  // Mutate scroll position to simulate being scrolled up (distanceFromBottom > 200)
  Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(scrollEl, 'scrollTop', { value: 0, configurable: true });
  Object.defineProperty(scrollEl, 'clientHeight', { value: 200, configurable: true });
  scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));

  expect(onScrollStateChange).toHaveBeenCalledWith(
    expect.objectContaining({ isAtBottom: false })
  );
});
```

### New Tests for `MessageItem.test.tsx`

#### Test: `tool_result` with queueMicrotask does not create a standalone text part

This test lives in `MessageItem.test.tsx` as it validates rendering behavior given specific `parts` arrays. It verifies that a message with `[tool_call_part, text_part("Done")]` renders the text contiguously with the surrounding content, not as a visually isolated orphan.

```typescript
it('renders "Done" text adjacent to tool call without orphaned standalone rendering', () => {
  // Purpose: Verifies that text parts immediately following a tool_call part
  // are rendered as part of the natural parts flow, not isolated.
  // This guards against the orphan regression where "Done" appeared as a
  // floating element between the tool card and the next text block.
  const msg = {
    id: '1',
    role: 'assistant' as const,
    content: 'DoneSome response text',
    parts: [
      {
        type: 'tool_call' as const,
        toolCallId: 'tc-1',
        toolName: 'TodoWrite',
        input: '{}',
        status: 'complete' as const,
      },
      { type: 'text' as const, text: 'Done' },
      { type: 'text' as const, text: 'Some response text' },
    ],
    timestamp: new Date().toISOString(),
  };
  const { container } = render(
    <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />
  );

  // Both text parts should be present in the DOM
  expect(screen.getByText('Done')).toBeDefined();
  expect(screen.getByText('Some response text')).toBeDefined();

  // The content container should have 3 children: tool card, text "Done", text "Some response text"
  const contentDiv = container.querySelector('.max-w-\\[80ch\\]');
  expect(contentDiv?.children.length).toBe(3);

  // Tool call card should be first child
  expect(contentDiv?.children[0].textContent).toContain('TodoWrite');

  // "Done" text should be the second child (not a floating orphan at a different DOM level)
  expect(contentDiv?.children[1].textContent).toBe('Done');
});
```

### Existing Tests

All existing tests in both files must continue to pass. No changes to existing test cases.

### Test Strategy Notes

- **jsdom limitations:** `wheel` and `touchstart` event dispatch in jsdom does work; however, jsdom does not implement `scrollHeight`/`scrollTop` as dynamic properties. Tests relying on `distanceFromBottom` computation need to `Object.defineProperty` these on the container element.
- **`vi.useFakeTimers()`:** Tests that verify the 150ms intent debounce timer must call `vi.useFakeTimers()` and `vi.advanceTimersByTime(150)` to clear the flag.
- **Mocks remain stable:** The existing mocks for `ResizeObserver`, `IntersectionObserver`, `@tanstack/react-virtual`, `streamdown`, `ToolApproval`, and `QuestionPrompt` are sufficient; no new mocks required.

---

## Performance Considerations

- **`queueMicrotask`** adds negligible overhead (~0 microseconds scheduling, one extra microtask flush per `tool_result` event). No performance impact.
- **`wheel` and `touchstart` listeners** are registered as `{ passive: true }` — no scroll blocking. Two additional lightweight event listeners per mounted `MessageList` instance. Memory footprint is negligible (one closure each).
- **`setTimeout(fn, 150)`** per scroll gesture — standard debounce pattern. One timer per active gesture window, cleared on next gesture or unmount.
- **`queueMicrotask` in ResizeObserver** adds one microtask per content height change. This slightly delays the RAF, which is the desired effect (allows virtualizer measurement to settle first). No user-perceptible latency change.

---

## Security Considerations

No security implications. Both changes are confined to client-side event handling and React state updates. No data is transmitted, stored, or exposed.

---

## Documentation

No user-facing documentation changes required. Both fixes resolve internal rendering artifacts — no feature flags, no API changes, no new configuration.

Internal: Update `contributing/architecture.md` if there is a section on chat scroll behavior describing the scroll state machine — add a note about the `isUserScrollingRef` intent flag pattern.

---

## Implementation Phases

### Phase 1: Core Fixes (single PR)

1. **`stream-event-handler.ts`** — Add `queueMicrotask` wrapper in `tool_result` case
2. **`MessageList.tsx`** — Add `isUserScrollingRef` + `clearScrollIntentTimerRef`, merge `onWheel` into event listener effect, gate `isAtBottomRef = false` behind intent flag, add `queueMicrotask` in ResizeObserver callback
3. **`MessageList.test.tsx`** — Add scroll intent tests
4. **`MessageItem.test.tsx`** — Add tool_result text isolation test
5. Run full test suite: `pnpm test -- --run`
6. Run self-test: `/chat:self-test` to verify both bugs are absent in live browser

### Phase 2 (if needed): `setTimeout(0)` fallback

If `queueMicrotask` does not fully eliminate the orphan "Done" in all SSE delivery scenarios (chunked HTTP), replace with `setTimeout(() => updateAssistantMessage(assistantId), 0)` in the `tool_result` case. This defers to the next macrotask, guaranteeing all same-event-loop SSE events have been processed.

---

## Open Questions

None. All decisions were resolved during ideation:

| Decision           | Resolution                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug 1 fix approach | `queueMicrotask` deferral in `tool_result` handler (with `setTimeout(0)` fallback if needed)                                                      |
| Bug 2 fix approach | `isUserScrollingRef` + `wheel`/`touchstart` listeners (Option C primary) + `queueMicrotask` before RAF in ResizeObserver (Option D complementary) |
| Test scope         | Add tests to existing `MessageList.test.tsx` and `MessageItem.test.tsx`                                                                           |

---

## Related ADRs

No directly applicable existing ADRs. The `isUserScrollingRef` intent-tracking pattern may warrant a new ADR if it is adopted more broadly for scroll behavior in future features.

---

## References

- **Self-test evidence:** `test-results/chat-self-test/20260307-204840.md` — live browser evidence of both bugs
- **Ideation document:** `specs/fix-chat-streaming-history-consistency/01-ideation.md`
- **Vercel AI SDK v5 "transient parts" pattern:** [AI SDK 5 blog — stream protocol](https://sdk.vercel.ai/blog/announcing-ai-sdk-5-alpha) — documents that tool result events can precede a final text delta; the fix aligns with how AI SDK v5 handles this
- **Community scroll intent pattern:** [autoscroll-react source](https://github.com/remarkablemark/autoscroll-react) — `wheel`/`touchstart` intent detection is the established community pattern for distinguishing user scroll from programmatic scroll
- **TanStack Virtual docs:** [https://tanstack.com/virtual/latest/docs](https://tanstack.com/virtual/latest/docs) — `measureElement` and ResizeObserver behavior
- **Primary source files:**
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (Bug 1 fix)
  - `apps/client/src/layers/features/chat/ui/MessageList.tsx` (Bug 2 fix)
  - `apps/client/src/layers/features/chat/__tests__/MessageList.test.tsx`
  - `apps/client/src/layers/features/chat/__tests__/MessageItem.test.tsx`
