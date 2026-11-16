# Task Breakdown: Fix Chat UI Streaming vs History Inconsistencies

Generated: 2026-03-08
Source: specs/fix-chat-streaming-history-consistency/02-specification.md
Last Decompose: 2026-03-08

---

## Overview

Two client-side rendering bugs cause the live streaming chat view to diverge visually from the history view in DorkOS. Both are observable in the self-test evidence report (`test-results/chat-self-test/20260307-204840.md`) and require targeted changes to two files in `apps/client/`.

**Bug 1 — Orphaned "Done" text:** A `"Done"` string appears as a floating plain-text element between a collapsed tool card and the next assistant response during streaming. Absent in history view.

**Bug 2 — Auto-scroll disengagement:** Auto-scroll silently stops working after long message sequences, requiring the user to manually click the ↓ button to see new responses.

All fixes are confined to `apps/client/`. No new dependencies are introduced. No server-side, relay, or SSE protocol changes are needed.

**Files changed:**

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (Bug 1 fix — 1 line)
- `apps/client/src/layers/features/chat/ui/MessageList.tsx` (Bug 2 fix — ~25 lines across 4 locations)
- `apps/client/src/layers/features/chat/__tests__/MessageList.test.tsx` (3 new tests)
- `apps/client/src/layers/features/chat/__tests__/MessageItem.test.tsx` (1 new test)

---

## Phase 1: Core Fixes

All tasks in this phase can be executed by a single implementer in sequence, or Tasks 1.1 and 1.2 can be parallelised since they touch different files. Tasks 1.3 and 1.4 depend on their respective fixes landing first but can also run in parallel with each other. Task 1.5 is the final verification gate.

```
1.1 ──┐
      ├──→ 1.4 ──┐
1.2 ──┤          ├──→ 1.5
      └──→ 1.3 ──┘
```

---

### Task 1.1: Defer tool_result re-render with queueMicrotask in stream-event-handler

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

#### Problem

In `createStreamEventHandler` (`stream-event-handler.ts`), the `tool_result` case calls `updateAssistantMessage(assistantId)` synchronously after setting `existing.result`. This forces a React render while the next `text_delta("Done")` SSE event is still in-flight. The intermediate render creates a state where the tool card is settled but there is no text part yet. The immediately-following `text_delta("Done")` then creates a new text part, which renders as a standalone floating element between the collapsed tool card and whatever assistant text follows.

The history view is immune because `transcript-parser.ts` collapses all content atomically — no intermediate render state.

#### File to Change

`apps/client/src/layers/features/chat/model/stream-event-handler.ts`

Target: the `tool_result` case of the `switch` statement inside the returned `handleStreamEvent` function (currently lines 185–198).

#### Before (line 196)

```typescript
case 'tool_result': {
  const tc = data as ToolCallEvent;
  const existing = findToolCallPart(tc.toolCallId);
  if (existing) {
    existing.result = tc.result;
    existing.status = 'complete';
    // Mark AskUserQuestion as answered so QuestionPrompt shows collapsed on remount
    if (existing.interactiveType === 'question' && !existing.answers) {
      existing.answers = {};
    }
  }
  updateAssistantMessage(assistantId);  // ← synchronous: fires before text_delta("Done")
  break;
}
```

#### After

```typescript
case 'tool_result': {
  const tc = data as ToolCallEvent;
  const existing = findToolCallPart(tc.toolCallId);
  if (existing) {
    existing.result = tc.result;
    existing.status = 'complete';
    // Mark AskUserQuestion as answered so QuestionPrompt shows collapsed on remount
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

#### Why This Works

`queueMicrotask` schedules `updateAssistantMessage` after the current synchronous execution completes but before the next macrotask (rendering frame). The immediately-following `text_delta("Done")` SSE event arrives synchronously in the same event loop turn (SSE parsing is synchronous within a `ReadableStream` chunk). By the time `queueMicrotask` fires, `currentPartsRef.current` already contains the `"Done"` text part from the `text_delta` handler, so `updateAssistantMessage` creates a unified render with both the completed tool result and the text — matching history view.

#### Fallback

If `queueMicrotask` does not fully eliminate the orphan in all SSE delivery scenarios (chunked HTTP), replace with `setTimeout(() => updateAssistantMessage(assistantId), 0)`. This defers to the next macrotask, guaranteeing all in-flight SSE events have been processed. The spec classifies this risk as low.

#### Blast Radius

One line changed in one case of one switch statement. No other cases are affected.

#### Acceptance Criteria

- [ ] The `tool_result` case uses `queueMicrotask(() => updateAssistantMessage(assistantId))` instead of `updateAssistantMessage(assistantId)` directly
- [ ] All other `switch` cases remain unchanged
- [ ] `pnpm test -- --run` passes with no regressions
- [ ] `pnpm typecheck` passes (`queueMicrotask` is a browser-native global — no import required)
- [ ] Live browser: no floating "Done" text visible during streaming of tool call sequences

---

### Task 1.2: Add user-scroll-intent tracking to MessageList to prevent reflow-driven auto-scroll disengagement

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

#### Problem

`handleScroll` in `MessageList.tsx` cannot distinguish between a user intentionally scrolling up and a layout reflow-driven scroll position jitter. TanStack Virtual's `measureElement` ResizeObserver fires frequently during long message streaming, temporarily changing `scrollHeight`. When `scrollHeight` shifts mid-render, `distanceFromBottom` temporarily exceeds 200px, `handleScroll` sets `isAtBottomRef.current = false`, and all three auto-scroll paths (ResizeObserver callback, `messages.length` effect, message-delivered guard) stop firing.

#### File to Change

`apps/client/src/layers/features/chat/ui/MessageList.tsx`

Four targeted changes within the same file:

#### Change 2a: Add two new refs

Add alongside the existing `isAtBottomRef`, `contentRef`, `rafIdRef`, and `isTouchActiveRef` (currently lines 80–101):

```typescript
const isUserScrollingRef = useRef(false);
const clearScrollIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

#### Change 2b: Merge wheel + touchstart intent-tracking into the existing event-listener effect

Replace the current `useEffect` that registers `scroll`, `touchstart`, `touchend`, `touchcancel` (lines 117–136) with the merged version below. The `isUserScrollingRef` logic is merged into the existing `onTouchStart` handler; a new `onWheel` handler is registered:

```typescript
useEffect(() => {
  const container = parentRef.current;
  if (!container) return;
  const onTouchStart = () => {
    isTouchActiveRef.current = true;
    // Mark user scroll intent on touch
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

#### Change 2c: Gate isAtBottomRef = false behind the intent flag in handleScroll

Replace the existing `handleScroll` useCallback (lines 104–115):

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

Logic: `isAtBottomRef` is only set to `false` when `isUserScrollingRef.current === true`. Setting to `true` (when `distanceFromBottom < 200`) is always allowed.

#### Change 2d: Add queueMicrotask before RAF in ResizeObserver callback

Replace the ResizeObserver `useEffect` (lines 167–188):

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

#### Data Flow After Fix

```
Virtualizer ResizeObserver fires → scrollHeight jitters
→ handleScroll fires → distanceFromBottom > 200
→ isUserScrollingRef.current === false → isAtBottomRef stays true
→ All three auto-scroll paths: isAtBottomRef.current === true → scroll fires correctly
→ New message appears scrolled into view
```

#### Acceptance Criteria

- [ ] `isUserScrollingRef` and `clearScrollIntentTimerRef` refs are declared in the component body
- [ ] The `useEffect` for event listeners registers `wheel` as a passive listener and merges `isUserScrollingRef` logic into `onTouchStart`
- [ ] The cleanup function removes the `wheel` listener and clears the intent timer
- [ ] `handleScroll` sets `isAtBottomRef` to `false` only when `isUserScrollingRef.current === true`
- [ ] `handleScroll` sets `isAtBottomRef` to `true` unconditionally when `distanceFromBottom < 200`
- [ ] ResizeObserver callback wraps `requestAnimationFrame` inside `queueMicrotask`
- [ ] `pnpm test -- --run` passes with no regressions
- [ ] `pnpm typecheck` passes
- [ ] Live browser: new assistant responses auto-scroll into view after long streaming with multiple tool calls

---

### Task 1.3: Add scroll-intent regression tests to MessageList.test.tsx

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 1.4

#### File to Modify

`apps/client/src/layers/features/chat/__tests__/MessageList.test.tsx`

#### Existing Infrastructure (no new setup needed)

- `globalThis.ResizeObserver` and `globalThis.IntersectionObserver` mocks already in place
- `vi.mock('@tanstack/react-virtual', ...)` returning all items
- `vi.mock('streamdown', ...)`, `vi.mock('../ToolApproval', ...)`, `vi.mock('../QuestionPrompt', ...)` already present
- `data-testid="message-list"` attribute exists on the scroll container (line 218 of `MessageList.tsx`)

No new imports or mock setup are required.

#### Test 1: Scroll without preceding wheel does not disengage auto-scroll

```typescript
it('does not disengage auto-scroll when scroll fires without wheel/touch', () => {
  // Purpose: Confirms that a programmatic scrollTop change (simulated by directly
  // firing a scroll event on the container, without a preceding wheel event)
  // does not flip isAtBottomRef to false — preventing the layout-reflow race.
  const onScrollStateChange = vi.fn();
  const messages: ChatMessage[] = [
    {
      id: '1',
      role: 'user' as const,
      content: 'Hi',
      parts: [{ type: 'text' as const, text: 'Hi' }],
      timestamp: new Date().toISOString(),
    },
  ];
  const { container } = render(
    <MessageList
      sessionId="test"
      messages={messages}
      onScrollStateChange={onScrollStateChange}
    />
  );

  const scrollEl = container.querySelector('[data-testid="message-list"]') as HTMLElement;

  // Simulate scrollHeight > clientHeight + scrollTop (distanceFromBottom > 200)
  Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(scrollEl, 'scrollTop', { value: 0, configurable: true });
  Object.defineProperty(scrollEl, 'clientHeight', { value: 200, configurable: true });

  // Fire a scroll event with NO preceding wheel/touchstart — simulates layout reflow
  scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));

  // onScrollStateChange should not report isAtBottom:false because no user intent was signaled
  const reportedFalse = onScrollStateChange.mock.calls.some(([state]) => state.isAtBottom === false);
  expect(reportedFalse).toBe(false);
});
```

#### Test 2: Wheel event followed by scroll disengages auto-scroll

```typescript
it('disengages auto-scroll when wheel event precedes scroll', () => {
  // Purpose: Confirms that a wheel event (user intent) followed by a scroll
  // event where distanceFromBottom > 200 correctly allows isAtBottomRef to
  // become false and reports isAtBottom:false to the parent.
  const onScrollStateChange = vi.fn();
  const messages: ChatMessage[] = [
    {
      id: '1',
      role: 'user' as const,
      content: 'Hi',
      parts: [{ type: 'text' as const, text: 'Hi' }],
      timestamp: new Date().toISOString(),
    },
  ];
  const { container } = render(
    <MessageList
      sessionId="test"
      messages={messages}
      onScrollStateChange={onScrollStateChange}
    />
  );

  const scrollEl = container.querySelector('[data-testid="message-list"]') as HTMLElement;

  // Simulate user scrolling: wheel event first sets the intent flag
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

#### Test 3: Intent flag clears after 150ms debounce

```typescript
it('clears user-scroll intent after 150ms debounce', () => {
  // Purpose: Confirms the isUserScrollingRef flag resets after 150ms, so a
  // subsequent reflow-driven scroll (>150ms after the gesture) does not
  // incorrectly disengage auto-scroll.
  vi.useFakeTimers();
  const onScrollStateChange = vi.fn();
  const messages: ChatMessage[] = [
    {
      id: '1',
      role: 'user' as const,
      content: 'Hi',
      parts: [{ type: 'text' as const, text: 'Hi' }],
      timestamp: new Date().toISOString(),
    },
  ];
  const { container } = render(
    <MessageList
      sessionId="test"
      messages={messages}
      onScrollStateChange={onScrollStateChange}
    />
  );

  const scrollEl = container.querySelector('[data-testid="message-list"]') as HTMLElement;

  // User scrolls via wheel
  scrollEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));

  // Advance timers past the 150ms debounce to clear the intent flag
  vi.advanceTimersByTime(200);

  // Fire a scroll event — intent flag should be cleared; should not disengage
  Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(scrollEl, 'scrollTop', { value: 0, configurable: true });
  Object.defineProperty(scrollEl, 'clientHeight', { value: 200, configurable: true });
  scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));

  const reportedFalseAfterDebounce = onScrollStateChange.mock.calls.filter(
    ([state]) => state.isAtBottom === false
  );
  expect(reportedFalseAfterDebounce.length).toBe(0);

  vi.useRealTimers();
});
```

#### Where to Insert

Append all three tests at the bottom of the existing `describe('MessageList', ...)` block, after the existing `'scroll container uses native scrollTop for scrollToBottom'` test. Do not modify existing tests.

#### jsdom Notes

- `wheel` and `touchstart` event dispatch works in jsdom.
- `scrollHeight`, `scrollTop`, and `clientHeight` are not dynamic in jsdom — use `Object.defineProperty` before dispatching `scroll` events.
- Always call `vi.useRealTimers()` at the end of the fake-timer test to prevent timer state leaking.

#### Acceptance Criteria

- [ ] Three new tests added inside the existing `describe('MessageList', ...)` block
- [ ] Test 1 verifies that scroll without prior wheel/touch does not report `isAtBottom: false`
- [ ] Test 2 verifies that wheel + scroll reports `isAtBottom: false`
- [ ] Test 3 uses `vi.useFakeTimers()` and verifies the 150ms debounce clears the flag
- [ ] `vi.useRealTimers()` called at end of Test 3
- [ ] All existing tests continue to pass
- [ ] `pnpm test -- --run` exits with zero failures

---

### Task 1.4: Add tool_result text isolation test to MessageItem.test.tsx

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.3

#### File to Modify

`apps/client/src/layers/features/chat/__tests__/MessageItem.test.tsx`

#### Existing Infrastructure (no new setup needed)

- `vi.mock('streamdown', ...)` renders `<div data-testid='streamdown'>{children}</div>`
- `vi.mock('../ToolApproval', ...)` with `data-tool-name` attribute
- `vi.mock('../QuestionPrompt', ...)`
- `onlyGrouping = { position: 'only', groupIndex: 0 }` constant
- `beforeEach` sets `autoHideToolCalls: false` — completed tool calls remain visible
- `afterEach` calls `cleanup()`

#### New Test

```typescript
it('renders text parts adjacent to tool call without orphaned standalone rendering', () => {
  // Purpose: Verifies that text parts immediately following a tool_call part
  // are rendered as part of the natural parts flow, not isolated at a
  // different DOM depth. This guards against the regression where a
  // text_delta("Done") appearing after a tool_result SSE event created
  // a floating element visually detached from the surrounding text.
  //
  // autoHideToolCalls is false (set in beforeEach), so the completed
  // tool call renders its ToolCallCard in the parts list.
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

  // Both text parts should appear in the document
  const allText = container.textContent ?? '';
  expect(allText).toContain('Done');
  expect(allText).toContain('Some response text');

  // The tool call card for 'TodoWrite' should be present
  expect(allText).toContain('TodoWrite');

  // 'Done' should render inside a streamdown element (standard rendering path),
  // not as a bare text node floating at a different DOM level
  const streamdownElements = container.querySelectorAll('[data-testid="streamdown"]');
  expect(streamdownElements.length).toBeGreaterThanOrEqual(2);

  const doneInStreamdown = Array.from(streamdownElements).some(
    (el) => el.textContent === 'Done'
  );
  expect(doneInStreamdown).toBe(true);
});
```

#### Why This Test Validates the Fix

The orphan bug caused the 'Done' text to render as a floating element visually disconnected from the tool card. This test validates:

1. 'Done' is present in the DOM (not dropped)
2. It renders inside a `data-testid='streamdown'` element — the standard `StreamingText` rendering path — not as an ad-hoc text node at a different DOM level
3. Multiple text parts after a tool call all render as expected siblings

#### Where to Insert

Append this test at the bottom of the existing `describe('MessageItem', ...)` block. Do not modify existing tests.

#### Acceptance Criteria

- [ ] One new test added at the bottom of `describe('MessageItem', ...)`
- [ ] Test asserts that 'Done' renders inside a `data-testid='streamdown'` element
- [ ] Test asserts that 'TodoWrite' (the tool call card) is present
- [ ] Test asserts that 'Some response text' is present
- [ ] Test asserts at least 2 streamdown elements (for the two text parts)
- [ ] All existing tests continue to pass
- [ ] `pnpm test -- --run` exits with zero failures

---

### Task 1.5: Run full test suite and verify fixes in live browser

**Size**: Small
**Priority**: High
**Dependencies**: Tasks 1.1, 1.2, 1.3, 1.4
**Can run parallel with**: None (verification gate)

#### Steps

**Step 1: Full test suite**

```bash
pnpm test -- --run
```

Expected: zero failures across all packages. All four new tests pass.

**Step 2: Type check**

```bash
pnpm typecheck
```

Expected: zero TypeScript errors.

**Step 3: Live browser verification — Bug 1 (orphaned "Done" text)**

1. `pnpm dev`
2. Open DorkOS in a browser
3. Start a new session
4. Send: `"Create a simple todo list using the TodoWrite tool"`
5. During streaming, observe the area between the collapsed tool card and any following assistant text
6. **Expected:** No floating "Done" plain-text element between the collapsed tool card and the next response block
7. Navigate away and back via sidebar history
8. **Expected:** History view looks identical to the streaming view — no floating text in either view

**Step 4: Live browser verification — Bug 2 (auto-scroll)**

1. Send a message producing a long response with 4+ tool calls (e.g., `"Read AGENTS.md and summarize it, then list the top 5 files in this repo"`)
2. Keep the chat window scrolled to the bottom without touching the scroll while the response streams
3. When streaming completes, send another follow-up message
4. **Expected:** The follow-up response auto-scrolls into view — the ↓ button does NOT appear
5. To verify user-scroll still disengages: scroll up with the mouse wheel during streaming
6. **Expected:** The ↓ button appears, indicating auto-scroll correctly disengaged

**Step 5 (conditional): Fallback to setTimeout(0)**

If the orphaned "Done" text still appears in some live browser cases (indicating chunked SSE delivery), replace `queueMicrotask` in `stream-event-handler.ts` with:

```typescript
setTimeout(() => updateAssistantMessage(assistantId), 0);
```

Re-run `pnpm test -- --run` — tests should still pass since they test behavior, not deferral implementation.

#### Acceptance Criteria

- [ ] `pnpm test -- --run` exits with zero failures
- [ ] `pnpm typecheck` exits with zero errors
- [ ] Live browser: no orphaned "Done" text during streaming
- [ ] Live browser: streaming and history views are visually identical for tool call sequences
- [ ] Live browser: new messages auto-scroll into view after long streaming with 4+ tool calls
- [ ] Live browser: manually scrolling up with wheel/trackpad correctly shows the ↓ button
- [ ] Live browser: clicking ↓ recovers auto-scroll for subsequent messages

---

## Summary

| Task                                             | File(s)                   | Size   | Parallel With |
| ------------------------------------------------ | ------------------------- | ------ | ------------- |
| 1.1 — queueMicrotask in tool_result handler      | `stream-event-handler.ts` | Small  | 1.2           |
| 1.2 — User scroll intent tracking in MessageList | `MessageList.tsx`         | Medium | 1.1           |
| 1.3 — Scroll intent tests                        | `MessageList.test.tsx`    | Medium | 1.4           |
| 1.4 — Tool result text isolation test            | `MessageItem.test.tsx`    | Small  | 1.3           |
| 1.5 — Full test run + live browser verification  | —                         | Small  | None          |

**Total tasks:** 5
**Parallelisation opportunities:** Tasks 1.1+1.2 can run simultaneously; Tasks 1.3+1.4 can run simultaneously after their respective dependencies.
**Estimated implementation time:** 1–2 hours (single implementer, sequential).
