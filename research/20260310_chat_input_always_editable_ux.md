---
title: 'Chat Input Always Editable: UX Research & Best Practices'
date: 2026-03-10
type: external-best-practices
status: active
tags: [chat, ux, micro-interactions, message-queue, input, streaming, delight, agent-sdk]
feature_slug: chat-input-always-editable
searches_performed: 16
sources_count: 28
---

# Chat Input Always Editable: UX Research & Best Practices

## Research Summary

The disabled-during-streaming chat input is a conservative default in most AI chat libraries (including the Vercel AI SDK), but it is neither the state of the art nor what the best-in-class tools do. The Claude Agent SDK's **streaming input mode** has native support for message queuing and sequential processing. Several open-source tools (Roo Code, Relevance AI, Vercel AI chatbot via a community PR) have shipped queuing UIs with card-based pending message displays. The key insight from the research: the disabled input is not a technical requirement — it is a design choice, and a worse one.

The recommended path for DorkOS is **Always-On Input + Optimistic Queue** (Approach 3 below): the textarea is never disabled, Enter queues a message when the agent is busy, and the queue flushes automatically on completion. Combined with a morphing send/stop/queue button and subtle micro-animations, this turns the waiting state into a feature rather than a friction point.

---

## Key Findings

### 1. Competitive Analysis: What Major Chat Apps Do

**ChatGPT (OpenAI)**

- The submit button transforms into a Stop button (filled square icon) during generation.
- The textarea is **not fully disabled** during streaming — users can type ahead, but submitting a new message while one is in-flight can crash the stream or cause errors per the OpenAI community forum.
- OpenAI has shipped and removed the Stop button in various iterations; the behavior is not stable or intentional from a design standpoint.
- There is no official message queue — sending during streaming is unsupported and error-prone.

**Claude.ai (Anthropic)**

- Input is disabled during generation. A mid-response rollback (Issue #29684) was reported to silently lose user work typed during the response — validating that this is a real problem Anthropic itself faces.
- No queue indicator exists.

**Cursor (AI Code Editor)**

- Cursor's chat panel (VS Code-based) shows a generating state but developers report issues with the Enter key shortcut not working from agent chat during generation.
- No documented queue; input appears disabled/blocked during generation.

**Roo Code (VS Code Extension)**

- Ships the most mature message queuing UI of any tool surveyed.
- **The textarea stays active at all times.** Enter queues messages immediately.
- Visual queue indicators: card-based display with "Queued Messages:" label above the input, per-item edit/delete controls, trash icons on hover.
- Queued messages act as implicit auto-approval for pending tool calls.
- Keyboard: Enter to queue, Escape to cancel editing, click-to-edit queued items.
- Known bug (Issue #9315): queued messages sometimes injected late (after 10+ LLM turns instead of on the next available turn). This is an implementation bug, not a design flaw.

**Relevance AI**

- Ships "Message Queuing in Chat: Continue your conversation without waiting" as a named product feature.
- Visual queue indicator shows count of messages waiting.
- Automatic sequential delivery, FIFO order.
- Described as seamless background operation — minimal UI chrome.

**Perplexity AI**

- Prompt controls (Focus, format buttons, etc.) are present around the input.
- No specific documentation on whether input is disabled during generation found.
- General UX philosophy (per NN/G analysis) is "search-like" — users expect fast query/response cycles, less relevant to queuing.

**GitHub Copilot Chat**

- Input disabled or blocked during multi-step agent operations.
- "Agent: Max Requests" setting controls turn limits; Copilot asks for confirmation at each limit.
- No message queue feature.

**Notion AI**

- Uses inline overlay prompts within the page editor.
- "Keep", "Try again", "Discard" response controls — flow is sequential, not queue-based.
- Not directly applicable (document-first interaction model vs. chat).

**Vercel AI SDK / AI Chatbot Template**

- Default recommendation: `disabled={status !== 'ready'}` — disables input during streaming.
- Community PR #1212 adds a queue UI: collapsible panel above input, visually merges with input card, per-item remove on hover, auto-flush when status returns to `ready`.
- Stop button intentionally shows only during streaming when input is empty.

---

### 2. Message Queuing Analysis

**Do major apps support queuing?**
Only Roo Code (shipping, with bugs), Relevance AI (shipping), and the Vercel AI chatbot community PR (pending) have documented queue UIs. ChatGPT, Claude.ai, Cursor, and Copilot do not support queuing.

**How queuing should work (consensus pattern):**

1. User types message while agent is responding.
2. Enter submits — message enters a FIFO queue, not the network.
3. A queue indicator appears above the input (collapsed by default, expandable).
4. On agent completion, the queue flushes one message at a time.
5. Items in the queue can be edited or deleted before they send.
6. A "queued message" sent during an active stream should be tagged with timing context (Issue #26388 from claude-code repo): `[typed while Claude was writing]` — so the agent understands the message was composed mid-response, not as a reply to the completed response.

**Technical challenge — queue ordering and context:**
The most subtle issue (Issue #26388) is that if a user types "let's go with option A" while the agent is mid-response, the agent sees that as a reply to its completed message rather than a response to the earlier question. The fix is a client-side timing tag injected before the queued message is sent. This is pure client logic — no SDK changes needed.

**Queue size:**
No hard limit necessary; browser memory is the practical constraint (per Roo Code documentation).

---

### 3. Claude Agent SDK Capabilities

**Streaming Input Mode** is the SDK's preferred and recommended mode. It explicitly supports:

- Queued Messages: "Send multiple messages that process sequentially, with ability to interrupt"
- The SDK accepts an AsyncGenerator as the `prompt` argument — yielding new `user` messages at any time during the loop
- Image attachments, hooks, tool integration, real-time feedback, context persistence

The SDK docs show queuing via an async generator:

```typescript
async function* generateMessages() {
  yield { type: "user", message: { role: "user", content: "First message" } };
  await new Promise(resolve => setTimeout(resolve, 2000)); // wait
  yield { type: "user", message: { role: "user", content: "Follow-up" } };
}
for await (const msg of query({ prompt: generateMessages() })) { ... }
```

**Interrupt / Cancel:**

- The V1 API had `query.interrupt()` — graceful stop while keeping session alive.
- The V2 API (current) does **not have a built-in interrupt method** on `SDKSession`. Issue #120 is open requesting `session.interrupt()`.
- Current workaround: `session.close()` — closes the entire session and loses context.
- The existing `AbortController` in `use-chat-session.ts` works for the legacy SSE path (`transport.sendMessage`) but has edge cases on the relay path.

**Key implication:** The SDK natively supports message queuing on the infrastructure side. The gap is entirely in DorkOS's client UX — the disable-while-streaming behavior is self-imposed, not SDK-mandated.

---

### 4. The Current DorkOS Implementation

Reading `ChatInput.tsx` and `use-chat-session.ts` reveals:

**Current behavior:**

- `isDisabled = isLoading || sessionBusy` — textarea gets `disabled={isDisabled}`
- `sessionBusy` fires when `SESSION_LOCKED` error is returned (concurrent write attempt)
- `handleSubmit` guard: `if (!input.trim() || status === 'streaming') return;`
- The `stop()` function calls `abortRef.current?.abort()` and sets status to `idle`
- Tests explicitly verify: "disables textarea when loading", "disables textarea when sessionBusy is true"
- A "Session is busy. Please wait..." message renders when `sessionBusy === true`

**What needs to change:**

1. Remove `disabled={isDisabled}` from the textarea
2. Change the `handleSubmit` guard to queue instead of no-op when streaming
3. Add queue state (array) to `useChatSession` or a new `useChatQueue` hook
4. Auto-flush queue on status transition to `idle`
5. Add timing tag injection for messages composed during streaming (context preservation)
6. Update the `sessionBusy` state to show a queue indicator instead of a disabled input

---

### 5. Delight and Micro-interaction Opportunities

**The morphing action button (highest value):**
The send/stop button already morphs between two states using `motion/react`. The opportunity is to add a **third state: "queue"** — when the agent is streaming and the user has text, the button becomes a "queue it" affordance (different icon, different color, perhaps a subtle badge showing queue depth).

Icon candidates for queue state:

- Clock or hourglass (implies "later")
- Stack or layers icon (implies queued)
- A subtle `+` or "plus arrow" variant

**Breathing / pulse animation on status bar during streaming:**
The `InferenceIndicator` and `ChatStatusSection` already exist. A slow breathing pulse (opacity oscillation at ~1-2s period, very low amplitude) on the streaming indicator communicates "alive and thinking" without being distracting. This is the AI equivalent of iMessage's three-dot typing indicator.

**Queue drawer animation (medium value):**
The queue panel should slide down from above the input (`AnimatePresence` + `initial={{ height: 0 }} animate={{ height: 'auto' }}`). Each queued message card should stagger in (`staggerChildren: 0.05s`). On flush, the card should scale down and fade out before the next message sends.

**Draft preservation (critical for delight):**
The LibreChat PR #9719 identified the exact bug: after a response completes, draft restoration can overwrite what the user just typed. The fix (65ms quick-save debounce vs. 850ms for empty-value debounce) maps directly to DorkOS's pattern. The always-on input combined with fast draft capture prevents this entirely.

**Keyboard shortcut surface:**

- `Enter` → queue message (when streaming) / send immediately (when idle)
- `Shift+Enter` → newline (unchanged)
- `Escape` → existing double-escape-to-clear pattern (keep)
- `Escape` during streaming (when queue is non-empty) → could offer "clear queue" affordance

**The waiting state as productivity:**
Psychology of waiting research confirms: users who feel "something is happening" perceive waits as shorter. The `ChatStatusSection` with tool call names already addresses this. The always-on textarea amplifies this: "I can keep going" is cognitively productive, even if the message doesn't send until later. The user's mental state stays in the conversation rather than pausing and re-engaging.

**Haptic feedback (mobile):**
iOS/Android support `navigator.vibrate()` for queued message confirmation. A single short pulse (10ms) on queue confirmation is subtle and satisfying. Already used by Apple in iMessage. Low effort to add.

---

### 6. Steve Jobs / Jony Ive Design Filter

**What would make this feel "inevitable"?**
The disabled textarea is an implementation detail leaking into the UX. A well-designed control panel operator never sees "system busy" — they see a queue. The input should always feel like it belongs to the user, not the system.

**The simplest version that still delights:**

1. Remove the `disabled` from the textarea. No other changes required for "always editable."
2. Prevent submission (silently, not with an error) when streaming.
3. An "Enter queues when busy" affordance requires only: queue state array, a visual counter badge on the button, and auto-flush logic. ~150 lines of code total.

**What surprises a user expecting a typical disabled input?**
They type while the agent is running. The textarea accepts their input. The send button shows a queued state. When the agent finishes, the message sends automatically. They never had to wait to compose their thought. The tool respected their cognitive flow.

**Making waiting feel productive:**
Kai (10-20 agent sessions/week) will want to stack his next instruction before the current one finishes — like queuing commands in a terminal. The metaphor is a pipeline, not a locked door. A queue turns the agent from a slow single-threaded system into a responsive one. Priya's context-switching cost is eliminated because she can type her next thought immediately without losing mental state.

---

## Potential Solutions

### Approach 1: Always-On Input, Submit Blocked (Minimum Change)

**Description:** Remove `disabled` from the textarea. Keep the `if (status === 'streaming') return` guard in `handleSubmit`. Show a subtle hint when the user tries to submit during streaming ("Sending when ready..." toast or inline note).

**Pros:**

- Minimal code change (remove ~3 lines from ChatInput.tsx, update tests)
- User can type and compose draft freely
- No queuing complexity
- Draft is preserved across the response

**Cons:**

- Still frustrating: user has to manually re-submit after the agent finishes
- No feedback about the system understanding their intent
- Loses the "queue and forget" delight opportunity

**Complexity:** Very low (1-2 hours)
**Maintenance:** Very low (no new state)

---

### Approach 2: Always-On Input, Toast-on-Block with Auto-Resubmit

**Description:** Remove `disabled`. When user submits during streaming, show a brief toast ("Message queued") and store the pending message in a single-item buffer. On agent completion, auto-send the buffered message.

**Pros:**

- Simple: only one message in the buffer at a time
- Clear user feedback via toast
- Auto-sends so user doesn't have to remember to re-send

**Cons:**

- Single-item buffer means a second attempt while the first is queued overwrites or is lost
- Toast is noisy and ephemeral — harder to edit or cancel a queued message
- No visual persistence of the queue state

**Complexity:** Low (3-4 hours)
**Maintenance:** Low

---

### Approach 3: Always-On Input + Optimistic Queue (Recommended)

**Description:** Remove `disabled` from textarea. When user submits during streaming, the message enters a local queue (array in `useChatSession` or a new `useChatQueue` hook). A collapsible queue panel appears above the input showing queued messages with edit/delete per item. On agent completion, queue flushes FIFO. Each queued message is tagged with a timing annotation (`wasTypedDuringStream: true`) so the agent receives context about when it was composed.

**Pros:**

- Full creative control for the user — type as many follow-ups as needed
- Queue is visible and editable (cancellable before it sends)
- Auto-flushes so no action required
- Maps directly to what the SDK already supports (streaming input mode, sequential messages)
- Timing tag solves the "misinterpreted context" bug (Issue #26388)
- Delightful and unexpected — feels like a control panel, not a chatbot
- Matches DorkOS brand: operators work in queues and pipelines

**Cons:**

- More complex to implement (~150-250 lines net new)
- Queue panel adds UI surface area (though collapsible)
- Queued messages auto-approving tool calls (Roo Code behavior) requires care — DorkOS should probably NOT auto-approve tools for queued messages, since tool permission dialogs should still surface

**Complexity:** Medium (1-2 days)
**Maintenance:** Medium — queue state needs to be cleared on session change, error handling needed if a queued send fails

---

### Approach 4: Interrupt + Immediate Send (Replace Current Response)

**Description:** When the user submits during streaming, interrupt the current agent run (abort), then immediately send the new message. The in-progress response is truncated.

**Pros:**

- Most responsive: new message sends immediately
- Matches how a user would interrupt someone mid-sentence in conversation

**Cons:**

- V2 SDK API does not have a graceful `interrupt()` method (Issue #120 is open)
- Current `stop()` calls `abortRef.current?.abort()` which works for legacy SSE path but has edge cases on relay path
- Abruptly truncating a partial response is jarring — the assistant message is incomplete
- Loses context from the partial response (agent was mid-thought)
- Appropriate only for specific cases (user realizes they asked the wrong question entirely)

**Complexity:** Medium-High (3-4 days to do correctly with session state preservation)
**Maintenance:** High — interrupt + resume logic is fragile

---

### Approach 5: Queue as Full Side Panel (Over-engineered)

**Description:** A persistent queue panel in the sidebar showing all pending messages, their order, status, and scheduling. Drag-to-reorder, bulk cancel, per-message edit.

**Pros:**

- Maximum power-user control

**Cons:**

- Overkill for a chat input UX improvement
- Violates "less, but better" — a queue counter badge on the button communicates queue depth adequately
- Would distract from the chat view which is already information-dense

**Complexity:** Very High
**Maintenance:** Very High

---

## Security Considerations

- **Queue injection:** The local queue array is client-side state. Messages are not sent to the server until the agent is idle. No server-side changes are required for the queue to work securely.
- **Timing tag injection:** The `wasTypedDuringStream` prefix is injected as a prepended string before the user's content. It must be sanitized/escaped the same way the main content is. The server should not treat this as a special instruction — it is purely context for the model's understanding.
- **Auto-approval risk:** Roo Code queued messages act as implicit tool approval. DorkOS should explicitly **not** follow this pattern. Tool permission dialogs must still surface even when triggered from a queued message flush.

---

## Performance Considerations

- **Queue state in React:** A simple array (`useState<string[]>`) in `useChatSession` is sufficient. No Zustand store needed — queue lifecycle is entirely within the session hook.
- **Auto-flush timing:** Flush on `useEffect` when `status` transitions from `'streaming'` to `'idle'`. Use a `useRef` to track the queue rather than `useState` to avoid stale closure issues in the flush callback.
- **Draft preservation:** The `input` state is already controlled by `useChatSession`. Since the textarea is no longer disabled during streaming, the `input` state is never cleared except on explicit submit. No debounce needed — the issue only arises when the disabled input's `value` prop fights with controlled state on re-enable.
- **Animation performance:** The queue panel should use `height: auto` with `motion/react`'s layout animation (`layoutId` or `AnimatePresence` + `initial={{ height: 0 }}`). Avoid animating `max-height` (causes repaints); animate `height` with `overflow: hidden`.

---

## Recommendation

**Recommended Approach: Approach 3 — Always-On Input + Optimistic Queue**

### Rationale

1. **The SDK already supports this.** The Claude Agent SDK's streaming input mode is designed for sequential message delivery. The client UI is the bottleneck — not the infrastructure.

2. **It maps to Kai's mental model.** Kai thinks in pipelines. He wants to queue his next instruction before the current one finishes, the same way he chains shell commands. A queue turns DorkOS from "wait your turn" to "keep going."

3. **It serves Priya's flow preservation.** Priya loses 15 minutes of mental state on context switches. The always-on input means she never has to "come back" to the chat — she can type her next thought and trust the system to deliver it. This is the single highest-value change for her.

4. **It differentiates from every major competitor.** ChatGPT, Claude.ai, Cursor, and Copilot all disable their inputs during streaming. A DorkOS agent session that never locks its input is a tangible, demonstrable differentiator that Kai will notice immediately and tell other developers about.

5. **The timing tag solves the hardest edge case.** The context-misinterpretation problem (Issue #26388) is solved with ~5 lines of client code. Without it, queuing creates a subtle degradation in response quality; with it, queuing is strictly better.

6. **"Control panel, not a chatbot."** The DorkOS brand is an operator's control panel. Operators work with queues. A chat input that accepts and queues messages while the agent runs is exactly the metaphor the product should embody.

### Minimum Viable Delight (Phased)

**Phase 1 (1-2 hours — do this now):**

- Remove `disabled={isDisabled}` from the textarea in `ChatInput.tsx`
- Change the `isLoading` guard in ChatInput's `handleKeyDown` to allow typing but show a subtle placeholder hint change: `"Message Claude... (will send when ready)"` while streaming
- Update the 8 tests that currently assert `disabled=true` during loading
- This delivers "always editable" with zero queue complexity

**Phase 2 (1-2 days — full delight):**

- Add `pendingQueue: string[]` state to `useChatSession`
- On submit while streaming: push to queue, clear input, show queue badge on send button
- Queue panel: collapsible card list above the input (`AnimatePresence`, stagger animation)
- Auto-flush: `useEffect` on `status === 'idle'` that calls `handleSubmit` with first queue item
- Inject timing annotation for queued messages: prepend `[Note: composed while agent was responding]\n` to queued messages before sending
- Morph send button: three states — send (arrow), stop (square), queue (clock or stack icon)
- Update `ChatInputContainer.tsx` to render queue panel between palettes and the input

### Caveats

1. **Relay path:** The relay path (`transport.sendMessageRelay`) uses a `waitForStreamReady` handshake before each send. The queue flush must respect this — it cannot fire multiple messages in rapid succession without the handshake. The existing `resetStalenessTimer` pattern handles the timing.

2. **`sessionBusy` state:** The current `sessionBusy` fires on `SESSION_LOCKED` (concurrent write from another client). This is distinct from "streaming" — it means another client already holds the session lock. The queue should clear or pause when `sessionBusy` is true, since queueing additional messages against a locked session would also fail. The "Session is busy" UI should remain for this case (it is an actual server lock, not just streaming).

3. **Tool permission dialogs:** Queued messages should not auto-approve pending tool calls. The existing `QuestionPrompt` flow should continue to surface and block queue flush until the user explicitly responds to the permission dialog.

4. **Empty-queue cleanup:** The queue state must be cleared when the session changes (the existing `useEffect` on `[sessionId, selectedCwd]` that clears messages should also clear the queue).

---

## Research Gaps

- Whether Claude.ai's own team has a roadmap for always-on input (not publicly disclosed)
- Whether the V2 Claude Agent SDK `interrupt()` method will ship (Issue #120 has 4 thumbs-up but no timeline)
- User testing data on whether developers prefer queue-and-forget vs. explicit queue management

## Contradictions and Disputes

- The AI SDK's official documentation recommends `disabled={status !== 'ready'}` (conservative, safe default), while community PRs and competitors like Roo Code ship always-on input. The conservative default is appropriate for generic implementations; DorkOS's developer-first context warrants the more ambitious approach.
- ChatGPT's behavior is inconsistent across versions — the stop button has appeared, disappeared, and changed behavior multiple times. OpenAI does not document their intended input UX formally.

---

## Sources & Evidence

- "Streaming Input Mode" (Default & Recommended) - [Claude Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- "Send multiple messages that process sequentially, with ability to interrupt" - [Claude Agent SDK Streaming Docs](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- "The agent loop" / `ResultMessage` / interrupt gap - [Claude Agent SDK Agent Loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- V2 interrupt API missing: [Issue #120 anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues/120)
- Queued message context misinterpretation: [Issue #26388 anthropics/claude-code](https://github.com/anthropics/claude-code/issues/26388)
- Message queuing blocks UI in Coder Tasks: [Issue #20770 coder/coder](https://github.com/coder/coder/issues/20770)
- Roo Code message queueing documentation: [docs.roocode.com](https://docs.roocode.com/features/message-queueing)
- Roo Code queue injection bug: [Issue #9315 RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code/issues/9315)
- Relevance AI message queuing feature: [Relevance AI Changelog](https://relevanceai.com/changelog/message-queuing-in-chat-continue-your-conversation-without-waiting)
- Vercel AI chatbot queue UI PR: [PR #1212 vercel/ai-chatbot](https://github.com/vercel/ai-chatbot/pull/1212)
- AI SDK official `disabled={status !== 'ready'}` pattern: [AI SDK UI Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)
- LibreChat draft preservation fix: [PR #9719 danny-avila/LibreChat](https://github.com/danny-avila/LibreChat/pull/9719)
- NN/G prompt controls best practices: [NN/G Prompt Controls](https://www.nngroup.com/articles/prompt-controls-genai/)
- Psychology of waiting / skeleton screens: [NN/G Skeleton Screens](https://www.nngroup.com/articles/skeleton-screens/)
- Motion UI micro-interaction trends 2025: [Beta Soft Technology](https://www.betasofttechnology.com/motion-ui-trends-and-micro-interactions/)

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: "message queue AI chat UX queued message indicator", "Claude agent SDK sequential messages streaming input mode", "Roo Code message queueing", "chat input always enabled during streaming", "LibreChat draft preservation during AI generation"
- Primary information sources: platform.claude.com/docs, github.com (anthropics/claude-agent-sdk-typescript, RooCodeInc/Roo-Code, vercel/ai-chatbot, danny-avila/LibreChat), docs.roocode.com, relevanceai.com, nngroup.com, ai-sdk.dev
