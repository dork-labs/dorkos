---
title: 'Chat UI Streaming vs History Consistency: Tool Result Orphan & Auto-Scroll Disengagement'
date: 2026-03-07
type: implementation
status: active
tags: [chat, streaming, auto-scroll, tool-result, React, SSE, MessageItem, MessageList]
feature_slug: fix-chat-streaming-history-consistency
searches_performed: 9
sources_count: 18
---

# Research Summary

Two distinct bugs in the DorkOS chat UI require targeted fixes. Bug 1 (tool_result orphan) stems from `stream-event-handler.ts` mutating a `ToolCallPart` in-place on `tool_result` events and calling `updateAssistantMessage`, which re-renders the `parts` array — including the mutated tool_call part — through `MessageItem`. Because `MessageItem` iterates all parts and renders each `tool_call` part through `AutoHideToolCall → ToolCallCard`, any intermediary render triggered by `tool_result` briefly places visible text (the result string) outside the card. The root fix is in the event handler — not the renderer. Bug 2 (auto-scroll disengagement) occurs because the 200px `isAtBottomRef` threshold check fires as a scroll event during layout reflow caused by long tool output, which temporarily makes the scroll container appear not-at-bottom. The cleanest fix is tracking explicit user scroll intent separately using `wheel`/`pointerdown` events, so layout-reflow-driven scroll events cannot flip the intent flag.

# Key Findings

## Bug 1: Tool Result Orphan — Root Cause Identified

**What the code does today:**

1. `tool_call_end` arrives → `existing.status = 'complete'` → `updateAssistantMessage()` re-renders `parts`
2. `tool_result` arrives → `existing.result = tc.result; existing.status = 'complete'` → `updateAssistantMessage()` re-renders `parts`

The problem is in step 2. When `tool_result` triggers `updateAssistantMessage`, the `parts` snapshot includes the updated `tool_call` part with `result` set. `MessageItem` maps all parts. For each `tool_call` part it renders `AutoHideToolCall → ToolCallCard`. `ToolCallCard` renders the result string only inside the `expanded && ...` block — so result text is not visible inside the card when collapsed. However the "Done" text seen as a floating element is **not** from `ToolCallCard.result`. It comes from the SDK emitting an additional `text_delta` event with `"Done"` content immediately after `tool_result`, which lands in a new `text` part. This text_delta appears between the (now-complete) tool card and the next assistant text, exactly matching the described symptom.

**Verification:** In `stream-event-handler.ts`, the `tool_result` case finds an existing `ToolCallPart` and mutates it. The `text_delta` handler creates a new text part or appends to the last existing one. If the last part is a `tool_call` (not `text`), the delta creates a new `text` part inline between tool cards. In history view, the SDK transcript-parser aggregates all text into a single content string, so this ephemeral "Done" text may either be absent (if not persisted) or merged into the main text block.

**Confirmed pattern from Vercel AI SDK research:** The Vercel AI SDK community has debated whether tool_result events should stream to the UI at all. Discussion #3952 ("do not stream tool results to UI") confirms this is a known design tension. The SDK v5/v6 separates "transient parts" (sent to client but not added to message history) from persistent parts. DorkOS has no equivalent transient-vs-persistent distinction, so every intermediate streaming state renders immediately.

## Bug 2: Auto-Scroll Disengagement — Root Cause Identified

**What the code does today:**

- `handleScroll` fires on every `scroll` event (passive listener)
- Computes `distanceFromBottom = scrollHeight - scrollTop - clientHeight`
- Sets `isAtBottomRef.current = distanceFromBottom < 200`
- `ResizeObserver` on `contentRef` fires when content height changes, checks `isAtBottomRef.current` and scrolls to bottom if true

**The race condition:**
During a long assistant message with many tool calls, `ResizeObserver` fires frequently. Each firing calls `scrollTop = scrollHeight - clientHeight` (scroll to bottom). Simultaneously, the virtualizer re-measures items via its internal `measureElement` ResizeObserver. The virtualizer's internal measurement can temporarily change `getTotalSize()`, which changes the `contentRef` height, which changes the scroll container's `scrollHeight`. If `scrollTop` has already been set but `scrollHeight` hasn't caught up, `distanceFromBottom` computes as > 200 and `handleScroll` sets `isAtBottomRef.current = false`. The next `ResizeObserver` callback sees `isAtBottomRef.current === false` and does not scroll. The user is now stuck.

The 200px threshold is insufficient for virtualizer-driven layout reflow because the virtualizer can temporarily report a `getTotalSize()` that is far below the final rendered size when many items are being measured simultaneously.

**Confirmed pattern from community research:** This is a known issue with TanStack Virtual + dynamic item measurement. The community confirms ResizeObserver warnings and viewport jumps when many items resize simultaneously.

# Detailed Analysis

## Analysis: Bug 1 Options

### Option A: Filter `tool_result` content blocks in `MessageItem` render

**What this means:** Add a guard in `MessageItem`'s `parts.map()` to skip rendering any `tool_call` part whose content comes from a `tool_result` intermediate state — or to skip rendering orphaned text parts that immediately follow a `tool_call` part.

**Why this misidentifies the bug:** The orphan is not a `tool_call` part rendered incorrectly — it is a `text` part containing `"Done"` emitted as a `text_delta` after the `tool_result`. `MessageItem` correctly renders `text` parts as `StreamingText`. Filtering by type would not target this text part.

**Pros:** Simple guard, low risk
**Cons:** Wrong target — doesn't address the actual orphan. Would require heuristic detection (e.g., "is this a very short text part immediately after a tool_call part?") which is fragile.
**Complexity:** Medium (because the heuristic is unreliable)

### Option B: Fix `stream-event-handler` to not trigger a re-render on `tool_result`

**What this means:** In the `tool_result` case of `createStreamEventHandler`, update `existing.result` and `existing.status` but do **not** call `updateAssistantMessage`. The result data is stored on the part (for when the card later expands) but the re-render is skipped. The next `text_delta` or `tool_call_start` will trigger the render that includes the now-result-bearing tool_call part.

**Why this is sound:** In history view, `tool_result` is not a separate event — the result is embedded directly on the `HistoryToolCall` record. History renders without an intermediate "result received" state. Suppressing the re-render on `tool_result` makes streaming match history behavior.

**Pros:** Eliminates the intermediate render. Directly matches history view semantics. Clean, surgical change in one function.
**Cons:** If `tool_result` is the final event (no subsequent `text_delta`), the card won't re-render to show `status: 'complete'`. Needs a deferred update or must update via the next natural render cycle. Fixable by scheduling a microtask or using `requestAnimationFrame` to defer the re-render slightly.
**Complexity:** Low

### Option C: `ToolCallCard` absorption of result display even when collapsed

**What this means:** The card always "absorbs" tool result content — but since the orphan is a text_delta, not inside the card, this does not help.
**Pros:** None relevant to this bug
**Cons:** Wrong target
**Complexity:** N/A

### Recommendation for Bug 1: Option B

Suppress the `updateAssistantMessage` call in the `tool_result` handler. Store `existing.result` and `existing.status = 'complete'` in-place on the part (already happens). Instead of calling `updateAssistantMessage` immediately, defer the update with `requestAnimationFrame` or schedule it after the next event. This is the same principle the Vercel AI SDK uses with "transient parts" — the result data is stored but the UI update is deferred/batched.

If the "Done" text delta is emitted by the SDK immediately after `tool_result`, suppressing the `tool_result` re-render means the `text_delta` handler will trigger the re-render that shows both the result-bearing card and the new text in one paint — eliminating the orphan appearance. If there is no subsequent `text_delta`, a single deferred re-render (via `setTimeout(0)` or `queueMicrotask`) after storing the result data is sufficient.

**Minimum change:** In the `tool_result` case, remove the `updateAssistantMessage(assistantId)` call. Add a `queueMicrotask(() => updateAssistantMessage(assistantId))` call instead. This allows the immediately-following `text_delta` to batch into the same microtask queue flush if one arrives, or defers the render to the next microtask if not.

## Analysis: Bug 2 Options

### Option A: Increase threshold or add hysteresis to `isAtBottomRef`

**What this means:** Change `distanceFromBottom < 200` to `distanceFromBottom < 600` or similar.

**Pros:** One-line change
**Cons:** Arbitrary. Does not fix the race — just makes it less likely to trigger. With enough tool calls and long enough output, any fixed threshold can be exceeded by layout reflow. Does not distinguish user intent from layout reflow.
**Complexity:** Trivial but insufficient

### Option B: Replace threshold check with IntersectionObserver on a sentinel element

**What this means:** Place a zero-height `<div ref={sentinelRef}/>` as the last child inside the scroll container. Use `IntersectionObserver` to observe it with `root: parentRef.current`. When the sentinel is intersecting, the user is at the bottom. When it leaves the viewport, the user has scrolled up.

**Why this is better for this specific bug:** IntersectionObserver fires asynchronously after layout and paint, not during layout reflow. It is immune to intermediate `scrollHeight` changes during virtualizer measurement. The sentinel's intersection state changes only when the user genuinely scrolls away from the bottom — not during programmatic scroll events or height recalculations.

**Pros:** Eliminates the layout-reflow race entirely. Established pattern (used by Vercel's `StreamingText` implementations, Shadcn AI components). Browser-native, no threshold tuning needed.
**Cons:** Adds a DOM node. Intersection callbacks are asynchronous — there is a one-frame delay. In a virtualized list, the sentinel's position changes with `getTotalSize()`, requiring it to be outside the virtualizer's content area (after the virtualizer div).
**Complexity:** Medium

### Option C: Track "user has manually scrolled up" intent separately

**What this means:** Add a `userScrolledUpRef = useRef(false)` flag. Set it to `true` when `wheel` or `pointerdown` events fire on the scroll container, and the subsequent `scroll` event measures `distanceFromBottom > threshold`. Clear it when the user scrolls back to the bottom. The auto-scroll ResizeObserver only fires when `!userScrolledUpRef.current`.

**Core insight:** The browser does not provide a direct API to distinguish user-initiated scroll from programmatic scroll (`scrollTop = ...`). The canonical workaround is to listen to `wheel` and `touchstart` events (which only fire for user input) and set a "user intends to scroll up" flag that is checked in the `scroll` event handler before updating `isAtBottomRef`.

**Pattern from community research (autoscroll-react library):** The library uses a threshold-plus-monitoring approach. The improvement over the current DorkOS implementation is to gate the `isAtBottomRef = false` assignment behind a "did the user trigger this scroll?" check.

**Pros:** Precisely distinguishes user intent. Allows layout reflow to scroll the container without flipping `isAtBottomRef`. Works well with the existing ResizeObserver pattern.
**Cons:** Requires two new event listeners (`wheel`, `touchstart`). The `wheel` event fires before `scroll`, allowing the flag to be set in time. However, there is a subtle timing issue: programmatic scroll also fires `scroll` events, and the `wheel` flag must be cleared after the intent is confirmed or after a short timeout.
**Complexity:** Medium

### Option D: ResizeObserver re-trigger with double-RAF

**What this means:** Instead of immediately setting `scrollTop` in the ResizeObserver callback, use `requestAnimationFrame(() => requestAnimationFrame(() => scrollTop = ...))` to defer the scroll until after two paint cycles, when the virtualizer has finished its measurement pass.

**Pros:** Low-risk, directly addresses the timing issue
**Cons:** Does not fix the `handleScroll` race — if `scrollTop` settles before layout reflow is done (because the double-RAF isn't long enough), `isAtBottomRef` can still flip. Also does not distinguish user intent from layout reflow.
**Complexity:** Low, but does not fully solve the problem

### Recommendation for Bug 2: Option C + Option D in combination

The most robust fix is Option C (user intent tracking via `wheel`/`touchstart` events) with Option D (double-RAF deferral in ResizeObserver) as a complementary improvement.

**Primary fix (Option C):** Add `wheel` and `touchstart` listeners on the scroll container that set `isUserScrollingRef.current = true`. In `handleScroll`, only update `isAtBottomRef.current = false` when `isUserScrollingRef.current === true`. Clear `isUserScrollingRef` after 150ms (covers the full scroll gesture). The ResizeObserver callback's conditional check of `isAtBottomRef.current` continues to work correctly, but now `isAtBottomRef` cannot be flipped to `false` by layout reflow.

**Secondary fix (Option D):** Replace the single `requestAnimationFrame` in the ResizeObserver callback with `cancelAnimationFrame` + single `requestAnimationFrame` (already present). Add a `queueMicrotask` guard before the rAF to let the virtualizer complete its synchronous measurement pass. This prevents the ResizeObserver → scroll → ResizeObserver feedback loop.

A sentinel IntersectionObserver (Option B) is a valid and elegant alternative, but requires a structural change to the virtualizer layout (sentinel must live outside the virtualizer's absolute-positioned content div). Option C is less invasive.

# Performance Considerations

**Bug 1 fix:** Replacing one synchronous `updateAssistantMessage` call with a `queueMicrotask`-deferred version adds no meaningful overhead. `queueMicrotask` runs before the next event loop tick but after the current synchronous block — if a `text_delta` arrives in the same synchronous batch, the microtask will see the updated parts.

**Bug 2 fix:** Adding `wheel` and `touchstart` listeners is negligible overhead (passive listeners, no `preventDefault` calls). `isUserScrollingRef` is a ref (no re-render). The 150ms timeout is a ref-guarded timer with no state updates.

**Virtualizer interaction:** The existing virtualizer `measureElement` callback uses `getBoundingClientRect().height`, which is accurate after layout. The auto-scroll fix does not change measurement behavior.

# Recommendation Summary

## Bug 1 — Tool Result Orphan

**Fix:** In `stream-event-handler.ts`, in the `tool_result` case, replace the synchronous `updateAssistantMessage(assistantId)` call with `queueMicrotask(() => updateAssistantMessage(assistantId))`. This defers the re-render so that any immediately-following `text_delta` (the "Done" text) can batch with it, eliminating the orphan intermediate state.

**File to change:** `apps/client/src/layers/features/chat/model/stream-event-handler.ts`, line 196 (`tool_result` case).

**One-line change:**

```typescript
// Before
updateAssistantMessage(assistantId);

// After (in tool_result case only)
queueMicrotask(() => updateAssistantMessage(assistantId));
```

## Bug 2 — Auto-Scroll Disengagement

**Fix:** Add a `isUserScrollingRef = useRef(false)` flag in `MessageList`. Attach `wheel` and `touchstart` passive listeners that set `isUserScrollingRef.current = true` and schedule a 150ms reset via `clearTimeout`/`setTimeout`. In `handleScroll`, gate the `isAtBottomRef.current = false` assignment behind `if (isUserScrollingRef.current)`. This prevents layout-reflow-driven scroll events from clearing the at-bottom flag.

**File to change:** `apps/client/src/layers/features/chat/ui/MessageList.tsx`, specifically the `handleScroll` callback and the scroll event effect.

**Pattern:**

```typescript
const isUserScrollingRef = useRef(false);
const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

// In useEffect (alongside existing scroll listener):
const onUserScroll = () => {
  isUserScrollingRef.current = true;
  clearTimeout(userScrollTimeoutRef.current);
  userScrollTimeoutRef.current = setTimeout(() => {
    isUserScrollingRef.current = false;
  }, 150);
};
container.addEventListener('wheel', onUserScroll, { passive: true });
container.addEventListener('touchstart', onUserScroll, { passive: true });

// In handleScroll:
const handleScroll = useCallback(() => {
  const container = parentRef.current;
  if (!container) return;
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  const isAtBottom = distanceFromBottom < 200;
  // Only flip to false when user explicitly scrolled; layout reflow cannot disengage
  if (isAtBottom || isUserScrollingRef.current) {
    const changed = isAtBottomRef.current !== isAtBottom;
    isAtBottomRef.current = isAtBottom;
    if (changed) {
      onScrollStateChange?.({ isAtBottom, distanceFromBottom });
    }
  }
}, [onScrollStateChange]);
```

# Sources & Evidence

- "streamText & useChat: do not stream tool results to UI" — [Discussion #3952, vercel/ai](https://github.com/vercel/ai/discussions/3952) — confirms the design tension and intent to separate tool_result from UI rendering
- "useChat support for new tool stream part type: tool_result_delta" — [Discussion #5923, vercel/ai](https://github.com/vercel/ai/discussions/5923) — confirms tool_result parts stream to client as transient state
- Vercel AI SDK 5 blog: "Transient parts are sent to the client but not added to the message history" — [AI SDK 5 — Vercel](https://vercel.com/blog/ai-sdk-5)
- IntersectionObserver sentinel pattern for chat scroll: [Intuitive Scrolling for Chatbot Message Streaming](https://tuffstuff9.hashnode.dev/intuitive-scrolling-for-chatbot-message-streaming)
- autoscroll-react library threshold-based intent detection: [GitHub — thk2b/autoscroll-react](https://github.com/thk2b/autoscroll-react)
- TanStack Virtual ResizeObserver measurement race: [Discussion #195, TanStack/virtual](https://github.com/TanStack/virtual/discussions/195)
- ResizeObserver fires between layout and paint: [ResizeObserver: It's Like document.onresize for Elements — Medium](https://medium.com/dev-channel/after-mutationobserver-performanceobserver-and-intersectionobserver-we-have-another-observer-for-2c541bcb531b)
- AI SDK Stream Protocols documentation: [AI SDK UI: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)

# Research Gaps & Limitations

- The exact SDK event sequence (whether "Done" text_delta is emitted by Claude Agent SDK on every tool result or only sometimes) was not confirmed from codebase inspection — the `sdk-event-mapper.ts` would need to be read to confirm this hypothesis.
- The `queueMicrotask` timing assumption (that the next `text_delta` arrives in the same synchronous event loop tick as the `tool_result` SSE parse) should be verified; if SSE events are processed asynchronously across ticks, `queueMicrotask` may not be sufficient and `setTimeout(0)` may be needed.
- The virtualizer's interaction with the ResizeObserver auto-scroll was analyzed structurally but not profiled; actual measurement timing may differ.

# Search Methodology

- Searches performed: 9
- Most productive terms: "Vercel AI SDK tool_result streaming render suppress", "chat autoscroll user intent scrolled up separate layout reflow", "autoscroll-react threshold intent", "TanStack Virtual ResizeObserver race condition"
- Primary sources: GitHub vercel/ai discussions, TanStack Virtual discussions, autoscroll-react library, hashnode chatbot scrolling article, Vercel AI SDK docs
