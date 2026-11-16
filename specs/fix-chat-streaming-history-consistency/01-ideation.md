---
slug: fix-chat-streaming-history-consistency
number: 102
created: 2026-03-08
status: ideation
---

# Fix Chat UI Streaming vs History Inconsistencies

**Slug:** fix-chat-streaming-history-consistency
**Author:** Claude Code
**Date:** 2026-03-08
**Branch:** preflight/fix-chat-streaming-history-consistency

---

## 1) Intent & Assumptions

- **Task brief:** Two bugs in the DorkOS chat UI cause the live streaming view to diverge visually from the history view: (1) a "Done" text fragment appears as a floating orphaned element between a collapsed tool card and the next assistant response during streaming, and (2) auto-scroll silently disengages after long message sequences, requiring manual ↓ click to see new responses.
- **Assumptions:**
  - Both bugs are pure client-side rendering/scroll issues
  - The self-test evidence (test-results/chat-self-test/20260307-204840.md) accurately describes repro conditions
  - The SDK emits a `text_delta("Done")` event immediately after `tool_result` in at least some tool call sequences (this is the source of Bug 1's orphan text)
  - The virtualizer's ResizeObserver-driven measurement causes temporary `scrollHeight` fluctuations during long messages (this is the source of Bug 2's threshold flip)
- **Out of scope:** Relay transport path, SSE protocol changes, server-side modifications, ToolCallCard expand/collapse UX changes

---

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/MessageItem.tsx`: Renders individual messages by mapping `parts[]`; passes each `tool_call` part through `AutoHideToolCall → ToolCallCard`; `tool_result` content is gated inside the card's `expanded === true` block — not the source of the orphan
- `apps/client/src/layers/features/chat/ui/MessageList.tsx`: Virtual list container; tracks `isAtBottomRef` with a 200px threshold via `handleScroll`; three auto-scroll paths (ResizeObserver, `message.length` effect, manual button) all gate on `isAtBottomRef.current`
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Pure function handling SSE events; `tool_result` case mutates the existing `ToolCallPart.result` field then calls `updateAssistantMessage(assistantId)` synchronously — this is the root of Bug 1
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`: Result string only rendered inside `AnimatePresence` when `expanded === true`; correctly gates display — not the leak point
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Hook managing history, streaming, relay path; creates `streamEventHandler` and wires it to both SSE and relay paths
- `packages/shared/src/schemas.ts`: `ToolCallPartSchema` has optional `result: z.string()` field — result is stored on the part, not emitted as a separate renderable element
- `test-results/chat-self-test/20260307-204840.md`: Live evidence showing Bug 1 (floating "Done" during Message 4 TodoWrite) and Bug 2 (auto-scroll failure at Message 4→5 transition)
- `apps/client/src/layers/features/chat/__tests__/MessageItem.test.tsx`: Tests rendering order of text + tool calls; mocks ToolApproval/QuestionPrompt
- `apps/client/src/layers/features/chat/__tests__/MessageList.test.tsx`: Tests computeGrouping, virtual rendering, and scroll state callback; mocks ResizeObserver/IntersectionObserver

---

## 3) Codebase Map

**Primary Components/Modules:**

| Path                                                                 | Role                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts` | Pure SSE event handler — root of Bug 1                                        |
| `apps/client/src/layers/features/chat/ui/MessageList.tsx`            | Virtual list + scroll state — root of Bug 2                                   |
| `apps/client/src/layers/features/chat/ui/MessageItem.tsx`            | Individual message renderer (parts map)                                       |
| `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`           | Collapsible tool call card; result gated behind expanded state                |
| `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`              | Chat coordinator; receives scroll state, shows ↓ button                       |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`     | Session state machine; wires streamEventHandler to SSE and relay paths        |
| `packages/shared/src/schemas.ts`                                     | Defines `MessagePart` discriminated union with `ToolCallPart.result?: string` |

**Shared Dependencies:**

- TanStack Virtual (virtualizer) — used by MessageList for item virtualization; its internal ResizeObserver measurement interacts with the scroll threshold race

**Data Flow (Bug 1 — streaming path):**

```
SSE: tool_call_end → updateAssistantMessage() → re-render (card shows ✓)
SSE: tool_result   → existing.result = ...; updateAssistantMessage() → re-render (intermediate state)
SSE: text_delta("Done") → new text part created; updateAssistantMessage() → "Done" appears as floating text
```

**Data Flow (Bug 1 — history path):**

```
GET /api/sessions/:id/messages → transcript-parser maps HistoryToolCall → ToolCallPart with result
→ MessageItem renders same as above but without intermediate re-render states
→ "Done" text absent or merged into main text block
```

**Data Flow (Bug 2):**

```
Long message streams in → ResizeObserver fires → scrollTop = scrollHeight (scroll to bottom)
Virtualizer internal measurement changes getTotalSize() temporarily
→ scrollHeight fluctuates → handleScroll fires → distanceFromBottom > 200
→ isAtBottomRef.current = false
→ ResizeObserver callback: isAtBottomRef false → skips scroll
→ New message arrives → message.length effect: isAtBottomRef false → skips scroll
→ User sees scroll-down ↓ button; must click manually
```

**Feature Flags/Config:**

- `expandToolCalls` setting in app-store controls default card expansion state (default: false/collapsed)
- No relay feature flag interaction

**Potential Blast Radius:**

- **Direct:** `stream-event-handler.ts` (1-line change), `MessageList.tsx` (3 additions: ref + 2 listeners)
- **Indirect:** `ChatPanel.tsx` may need no changes; `MessageItem.tsx` no changes needed
- **Tests:** `MessageList.test.tsx` (new test for scroll intent flag), `MessageItem.test.tsx` (new test verifying tool_result text doesn't render standalone)

---

## 4) Root Cause Analysis

### Bug 1: Orphaned "Done" Text During Streaming

**Repro steps:**

1. Start a new session
2. Send a message that triggers a tool call (e.g., "Create a todo list")
3. During streaming, observe the area between the collapsed tool card and assistant response text
4. "Done" appears as a floating plain-text element at that position
5. Open the same session from history — "Done" is absent

**Observed vs Expected:**

- Observed: "Done" renders as an isolated text element during streaming, disappears in history view
- Expected: Streaming view and history view are visually identical; no standalone text between collapsed tool cards and assistant responses

**Evidence:**

- `stream-event-handler.ts` `tool_result` case (line ~196): calls `updateAssistantMessage(assistantId)` synchronously after setting `existing.result`
- The SDK emits `text_delta("Done")` as the very next SSE event after `tool_result` in at least some sequences
- `MessageItem`'s `parts.map()` creates a new `text` part from the `text_delta`, rendering it between the tool card and the next block
- History view uses `transcript-parser.ts` which collapses all content — the ephemeral "Done" text_delta is absent or merged

**Root-cause hypotheses:**

- **H1 (selected, high confidence):** The synchronous `updateAssistantMessage` call in the `tool_result` handler causes a React render before the next `text_delta("Done")` arrives. This intermediate render already has the tool card in its final state but the text part unfilled. The next `text_delta` fires synchronously, creating a visible "Done" text block with no attachment to the tool card. Deferring the `tool_result` re-render with `queueMicrotask` allows the `text_delta` to batch, eliminating the orphan.
- H2 (low confidence): `tool_result` content is rendered as a separate text element somewhere in MessageItem. Ruled out — MessageItem's `parts.map()` only renders `tool_call` parts through ToolCallCard, which gates result behind `expanded`.

**Decision:** H1. Fix: defer the `updateAssistantMessage` call in the `tool_result` case with `queueMicrotask`.

---

### Bug 2: Auto-Scroll Disengagement After Long Messages

**Repro steps:**

1. Send a message that produces a long response with multiple tool calls (Messages 4→5 in self-test)
2. Watch the auto-scroll stop during or after Message 4's streaming
3. Send another message (Message 5)
4. Response arrives but is not scrolled into view; ↓ button appears

**Observed vs Expected:**

- Observed: Auto-scroll stops working after long messages; manual ↓ required
- Expected: New AI responses always scroll into view unless user has explicitly scrolled up

**Evidence:**

- `MessageList.tsx` line ~109: `const isAtBottom = distanceFromBottom < 200;`
- During long message streaming, TanStack Virtual's `measureElement` ResizeObserver callback fires frequently, causing `getTotalSize()` to fluctuate
- `scrollHeight` changes mid-render → `distanceFromBottom` temporarily exceeds 200px → `isAtBottomRef.current = false`
- All three auto-scroll trigger points (ResizeObserver callback line ~172, `message.length` effect line ~192, message-delivered guard) are gated on `isAtBottomRef.current`
- Manual ↓ button calls `scrollToBottom()` directly (no `isAtBottomRef` check), which recovers the flag

**Root-cause hypotheses:**

- **H1 (selected, high confidence):** The `handleScroll` callback cannot distinguish user-initiated scrolls from layout-reflow-driven scroll position changes. Any `scroll` event where `distanceFromBottom > 200` flips `isAtBottomRef` to false, including events caused by programmatic scrollTop assignment during measurement reflow.
- H2 (low confidence): The 200px threshold is simply too small. Partially true, but increasing the threshold alone doesn't eliminate the race — it only makes it less likely.

**Decision:** H1. Fix: add `isUserScrollingRef` flag set by `wheel`/`touchstart` events (which only fire for user-initiated input); gate `isAtBottomRef = false` behind this flag in `handleScroll`.

---

## 5) Research

### Bug 1 — Tool Result Orphan

**Potential solutions:**

1. **Option B: Defer `updateAssistantMessage` in `tool_result` handler (Recommended)**
   - Replace synchronous `updateAssistantMessage(assistantId)` with `queueMicrotask(() => updateAssistantMessage(assistantId))` in the `tool_result` case
   - Pros: One-line surgical change. Matches history view semantics (no intermediate "result received" render). Aligned with Vercel AI SDK v5's "transient parts" principle. The following `text_delta` may batch into the same microtask flush.
   - Cons: Relies on `text_delta` arriving in the same microtask batch. If SSE parsing is asynchronous across ticks, `setTimeout(0)` may be needed.
   - Complexity: Low

2. **Option A: Filter `tool_result` blocks in `MessageItem` render**
   - Pros: Renderer-side containment
   - Cons: The orphan is a `text` part (not a `tool_call` part) so type-filtering misses the target; would need fragile heuristics (detect short text parts immediately after tool_call parts)
   - Complexity: Medium, fragile

3. **Option C: ToolCallCard absorption**
   - Ruled out — orphan is a separate text part, not a ToolCallCard rendering issue

**Recommendation:** Option B. Vercel AI SDK community has explicitly documented this pattern ("transient parts are sent to the client but not added to message history" — AI SDK 5 blog). The `queueMicrotask` approach is the minimal-invasive fix.

---

### Bug 2 — Auto-Scroll Disengagement

**Potential solutions:**

1. **Option C: User-scroll-intent tracking with `wheel`/`touchstart` (Recommended)**
   - Add `isUserScrollingRef = useRef(false)`. Attach passive `wheel` and `touchstart` listeners that set the flag for 150ms. In `handleScroll`, only allow `isAtBottomRef.current = false` when `isUserScrollingRef.current === true`.
   - Pros: Precisely distinguishes user intent from layout reflow. Browser-native (`wheel`/`touchstart` cannot fire from programmatic scroll). Community-validated pattern (autoscroll-react library).
   - Cons: Two additional event listeners; 150ms timer per gesture
   - Complexity: Medium

2. **Option D: ResizeObserver double-RAF deferral (Complementary)**
   - Add `queueMicrotask` before the existing `requestAnimationFrame` in the ResizeObserver scroll callback to let virtualizer measurement complete first
   - Pros: Reduces frequency of the race
   - Cons: Doesn't fix the `handleScroll` race on its own
   - Complexity: Low

3. **Option B: IntersectionObserver sentinel**
   - Zero-height sentinel div observed by IntersectionObserver after virtualizer content
   - Pros: Immune to layout reflow; fires after layout settles
   - Cons: Requires structural JSX change (sentinel outside virtualizer's absolute-positioned div); async one-frame delay
   - Complexity: Medium-high

4. **Option A: Increase threshold**
   - Pros: One-line change
   - Cons: Arbitrary; any fixed threshold can be exceeded by extreme reflow
   - Complexity: Trivial but insufficient

**Recommendation:** Option C (primary) + Option D (complementary). Option C is the correct conceptual fix — it adds user-intent awareness. Option D reduces the measurement timing window as a secondary improvement.

---

## 6) Decisions

No ambiguities identified — task brief was precise, and exploration + research findings converged strongly on the same two targeted fixes. Both bugs have clear, non-overlapping root causes and well-defined minimal changes.

| #   | Decision                                     | Choice                                                                     | Rationale                                                                                                                                                                                                                                                |
| --- | -------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How to fix the tool_result orphan (Bug 1)    | `queueMicrotask` deferral in `stream-event-handler.ts` `tool_result` case  | Surgical one-line change. Exploration confirmed `tool_result` handler fires synchronous re-render. Research confirmed this matches Vercel AI SDK "transient parts" pattern. Eliminates intermediate render without touching MessageItem or ToolCallCard. |
| 2   | How to fix auto-scroll disengagement (Bug 2) | `isUserScrollingRef` + `wheel`/`touchstart` listeners in `MessageList.tsx` | Precisely distinguishes user intent from layout-reflow-driven scroll events. Exploration confirmed all three auto-scroll paths gate on `isAtBottomRef`. Research confirmed this is the community-standard fix for this class of race condition.          |
| 3   | Scope of test updates                        | Add tests to existing `MessageList.test.tsx` and `MessageItem.test.tsx`    | Existing tests already mock ResizeObserver and IntersectionObserver — adding scroll intent and tool_result isolation tests is straightforward                                                                                                            |
