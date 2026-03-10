---
slug: chat-input-always-editable
number: 111
created: 2026-03-10
status: ideation
---

# Chat Input Always Editable + Message Queuing

**Slug:** chat-input-always-editable
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/chat-input-always-editable

---

## 1) Intent & Assumptions

- **Task brief:** The chat input textarea becomes fully disabled (`disabled={isDisabled}`) while the agent is streaming a response, preventing users from drafting their next message. We should keep the input always editable, prevent submission during streaming, and introduce message queuing so users can compose and queue multiple follow-up messages that auto-send when the agent finishes. This is a 10x UX opportunity inspired by best-in-class chat apps.
- **Assumptions:**
  - The current `disabled` state is applied to both the textarea and submit button identically — we need to decouple these
  - The Claude Agent SDK's streaming input mode supports sequential message delivery, so queuing is technically viable without SDK changes
  - Queued messages should auto-flush in FIFO order, not require manual re-submission
  - The relay path's `waitForStreamReady` handshake must be respected between queued message flushes
  - File uploads can coexist with queuing (files attach to the current draft, not queued items)
  - Mobile UX follows the same patterns (button-based queue, no arrow key navigation)
- **Out of scope:**
  - Agent interruption/abort-and-replace (SDK lacks graceful `interrupt()` — Issue #120)
  - Drag-to-reorder queued messages (nice-to-have, not MVP)
  - Queue persistence across page refresh or session switch
  - File attachments on queued messages (files attach to current draft only)

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/ChatInput.tsx` (~250 lines): Core input component. Textarea disabled via `isDisabled = isLoading || sessionBusy` at line 187. Auto-resize textarea capped at 200px. Motion-animated send/stop/clear buttons. Escape key dismisses palette then clears input on double-tap. Mobile vs desktop enter behavior split.
- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` (~157 lines): Wraps ChatInput with file upload dropzone, command/file palettes, file chip bar, status section. Derives `isLoading={status === 'streaming' || isUploading}` at line 131. Passes `sessionBusy` through.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` (~268 lines): Top-level chat composition. Destructures `status, error, sessionBusy, stop, input, setInput, handleSubmit` from `useChatSession`. Wraps file upload into message content. Renders ChatInputContainer, MessageList, TaskPanel, celebrations.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` (~516 lines): Core chat state machine. Status states: `idle`, `streaming`, `error`. `handleSubmit` sets status to `streaming`, clears input, adds optimistic user message. Relay path uses EventSource SSE with staleness detector. Legacy path uses POST with inline SSE response. Returns `{ status, input, setInput, handleSubmit, stop, sessionBusy }`.
- `apps/client/src/layers/features/chat/model/use-file-upload.ts`: File upload lifecycle. Returns `{ pendingFiles, isUploading, uploadAndGetPaths, addFiles, removeFile, clearFiles }`.
- `apps/client/src/layers/features/chat/model/use-input-autocomplete.ts`: Command/file palette state. Manages keyboard navigation, filtering, cursor tracking for autocomplete triggers.
- `packages/shared/src/transport.ts`: Transport interface. `sendMessage()` takes `onEvent` callback + `AbortSignal`. `sendMessageRelay()` for relay mode with correlation ID.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store for UI state. No chat input state stored here — all in `useChatSession`.
- `contributing/design-system.md`: Color palette, typography, 8pt grid spacing, motion specs.
- `contributing/animations.md`: Motion library patterns — `AnimatePresence`, `motion.div`, spring physics.
- `contributing/state-management.md`: Zustand for UI state, TanStack Query for server state.
- `contributing/data-fetching.md`: TanStack Query patterns, mutations.
- `meta/personas/the-autonomous-builder.md`: Kai — 10-20 agent sessions/week, thinks in systems, wants agents to work while he sleeps. Flow: compose → send → context-switch → return to results.
- `meta/personas/the-knowledge-architect.md`: Priya — staff architect, lives in Obsidian, context-switching costs 15 minutes. Keyboard-first, flow preservation is core emotional need.

## 3) Codebase Map

### Primary Components/Modules

| File | Role |
|---|---|
| `apps/client/src/layers/features/chat/ui/ChatInput.tsx` | Textarea, send/stop/clear buttons, keyboard shortcuts, auto-resize |
| `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` | Wraps ChatInput with dropzone, palettes, file chips, status section |
| `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` | Top-level chat composition, file upload orchestration |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts` | Chat state machine: messages, streaming, status, submit |
| `apps/client/src/layers/features/chat/model/use-file-upload.ts` | File upload lifecycle |
| `apps/client/src/layers/features/chat/model/use-input-autocomplete.ts` | Command/file palette state + keyboard nav |

### Shared Dependencies

| Dependency | Used By |
|---|---|
| `packages/shared/src/transport.ts` | `use-chat-session` — `sendMessage`, `sendMessageRelay` |
| `apps/client/src/layers/shared/model/app-store.ts` | `use-chat-session` — `selectedCwd` |
| `motion/react` (v12) | `ChatInput` — button animations; `ChatPanel` — scroll overlay |
| TanStack Query | `use-chat-session` — session queries |
| Zustand | `app-store` — UI state |

### Data Flow: Message Submit

```
User types in ChatInput textarea
  → onChange → autocomplete.handleInputChange
  → User presses Enter or clicks Send
  → ChatInput.onSubmit()
  → ChatPanel.handleSubmitWithFiles()
  → useChatSession.handleSubmit(content)
  → setStatus('streaming'), setInput(''), add optimistic user message
  → Transport.sendMessage (legacy) or Transport.sendMessageRelay (relay)
  → SSE events stream in → streamEventHandler updates messages/parts/toolCalls
  → On 'done' event: setStatus('idle')
  → [CURRENT PROBLEM] Textarea disabled={true} the entire time
```

### Current Disable Logic

```
isDisabled = isLoading || sessionBusy
  where isLoading = (status === 'streaming') || isUploading
  and sessionBusy = (SESSION_LOCKED error during handleSubmit, 3s timeout)

Applied to:
  - Textarea:       disabled={isDisabled}
  - Paperclip btn:  disabled={isDisabled}
  - Send button:    disabled={!showButton || sessionBusy}
  - Clear button:   disabled={!showClear} where showClear = hasText && !isLoading && !sessionBusy
```

### Feature Flags/Config

- `DORKOS_RELAY_ENABLED` — controls relay vs legacy message path
- `relayEnabled` — boolean from `useRelayEnabled()` entity hook
- `TIMING.DONE_STALENESS_MS` — relay staleness detector timeout
- `TIMING.SESSION_BUSY_CLEAR_MS` — session lock clear timeout

### Potential Blast Radius

- **Direct changes (4 files):** `ChatInput.tsx`, `ChatInputContainer.tsx`, `ChatPanel.tsx`, `use-chat-session.ts`
- **New files (2):** Queue hook (`use-message-queue.ts`), Queue panel component (`QueuePanel.tsx`)
- **Test updates (4):** `ChatInput.test.tsx`, `ChatInputContainer.test.tsx`, `ChatPanel.test.tsx`, `use-chat-session.test.ts`
- **No server changes** — queue is entirely client-side state

## 4) Root Cause Analysis

N/A — This is a UX improvement, not a bug fix.

## 5) Research

### Competitive Analysis

| App | Type During Stream | Queue Support | Stop Button | Notable UX |
|---|---|---|---|---|
| **ChatGPT** | Yes | No (errors on submit) | Yes (square) | Input always editable, submit blocked |
| **Claude.ai** | No (disabled) | No | No | Mid-response rollback can lose user draft |
| **Cursor** | Blocked | No | Undocumented | Enter key bugs in agent chat |
| **Roo Code** | Yes | Yes (full UI) | N/A | Most mature queue: card display, per-item edit/delete |
| **Relevance AI** | Yes | Yes (visual) | N/A | Seamless background queuing, auto-flush, FIFO |
| **Vercel AI SDK** | No (official) | Community PR pending | Yes (abort) | Default: `disabled={status !== 'ready'}` |
| **GitHub Copilot** | Blocked | No | Yes (per-step) | Agents pause every N turns for confirmation |

**Key finding:** Roo Code and Relevance AI — both developer-focused tools — have shipped always-on input with message queuing. They are the benchmark. No app does the queue editing UX we're proposing.

### Claude Agent SDK Capabilities

- The SDK's streaming input mode is designed for sequential message delivery via `AsyncGenerator`
- No graceful `interrupt()` method exists (Issue #120) — only `session.close()` which destroys context
- The queue approach avoids needing interrupt: messages queue and flush cleanly without interrupting the current run
- This is compatible with both the legacy and relay message paths in DorkOS

### Message Queuing Edge Case: Context Misinterpretation

Messages composed while the agent is streaming can be misinterpreted as replies to the completed response (GitHub Issue #26388). Solution: auto-inject a timing annotation before queued messages reach the agent — pure client logic, ~5 lines of code.

### Potential Solutions Evaluated

| # | Approach | Complexity | Verdict |
|---|---|---|---|
| 1 | Always-on input, submit blocked, no queue | Very Low | Phase 1 — ships immediately |
| 2 | Single-item auto-resubmit | Low | Too limited — Kai queues multiple thoughts |
| 3 | **Full FIFO queue with inline cards, edit/delete, auto-flush** | **Medium** | **Phase 2 — recommended** |
| 4 | Interrupt + immediate send | Medium-High | SDK doesn't support graceful interrupt |
| 5 | Full queue side panel | Very High | Over-engineered |

### Security Considerations

- Queue is client-only state — no server changes, no new attack surface
- Timing annotation strings sanitized identically to user input
- Tool permission dialogs must NOT be auto-approved for queued messages
- `sessionBusy` (server lock from another client) must still block queue flushing

### Performance Considerations

- Queue state: `useRef<string[]>` for the flush callback to avoid stale closures; `useState` for render triggers
- Queue panel animation: `motion/react` `height` animation with `overflow: hidden`, not `max-height`
- Relay path: `waitForStreamReady` handshake must be honored between queued message flushes — cannot fire rapidly

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Scope | Both phases: Phase 1 (always-editable, ~1-2h) + Phase 2 (message queue, ~1-2d) | Phase 1 is a quick win. Phase 2 differentiates DorkOS from every major competitor. The Claude Agent SDK's streaming input mode is built for sequential delivery. Kai thinks in pipelines, not locked doors. |
| 2 | Queue submit UX | Third button state: "Queue" (clock/stack icon, neutral color) | During streaming with typed text, send button transforms to queue button. Makes queuing visible and intentional — honest design per Dieter Rams. Badge shows queue depth. |
| 3 | Queue display | Inline cards above input + textarea editor with shell-history navigation | Cards show the queue visually. Arrow keys navigate the stack (like shell history). Clicking a card loads its content into the textarea for editing. "Editing message 2/3" label provides context. Enter saves edits, Escape discards. This is shell-history UX meets visual queue — discoverable for new users, fast for power users. |
| 4 | Timing annotation | Auto-inject context metadata on queued messages | Prepend `[Note: This message was composed while the agent was responding to the previous message]` before queued messages. Solves the known context misinterpretation bug. ~5 lines of code, huge quality-of-life gain. |

### Phase 1: Always-Editable Input (Quick Win)

**Changes:**
1. Remove `disabled` from textarea — always editable
2. Keep submit button disabled during streaming (but change to stop icon as today)
3. Keep paperclip button usable during streaming (attach files for next message)
4. Update placeholder text during streaming: `"Compose next — will send when ready"`
5. Clear button always functional when text exists
6. Update tests

**Interaction model:**
- Textarea: always accepts input
- Send button: disabled during streaming (shows stop icon for abort)
- Paperclip: enabled during streaming
- Clear: enabled when text exists
- Enter key: blocked from submitting during streaming (no-op, just newline on Shift+Enter)

### Phase 2: Message Queue with Inline Cards

**New state: `useMessageQueue` hook**
```
queue: QueueItem[]          // { id, content, createdAt }
editingIndex: number | null // which queue item is loaded in textarea
addToQueue(content)         // append to queue
updateQueueItem(index, content)  // edit in place
removeFromQueue(index)      // delete with animation
flushNext()                 // pop first item, submit
clearQueue()                // clear all (on session change)
```

**New component: `QueuePanel`**
- Renders above the textarea, below status section
- Collapsible card list with stagger animation (`AnimatePresence` + `staggerChildren: 0.05`)
- Each card: truncated preview text, `x` remove button (hover), selected state indicator (`>`)
- Header: "Queued (N)"

**Button states (three-state model):**

| State | Condition | Icon | Color | Action |
|---|---|---|---|---|
| Send | `idle` + has text | Arrow up | Primary | Submit message |
| Stop | `streaming` + no text | Square | Red | Abort streaming |
| Queue | `streaming` + has text | Clock/stack | Neutral | Add to queue |

**Queue editing via arrow keys (shell-history model):**

```
[Empty textarea]  ← composing new (editingIndex = null)
      ↑ Up
[Message N text]  ← editing newest (editingIndex = N-1)
      ↑ Up
[Message 1 text]  ← editing oldest (editingIndex = 0)
      ↑ Up
[Empty textarea]  ← wraps back to composing new
```

- **Up arrow** (when textarea is empty or cursor at line 1): navigate to previous queue item
- **Down arrow** (when editing queue item): navigate to next item or back to new
- **Click card**: load that item into textarea, set editingIndex
- **Enter** (when editing): save changes back to that queue slot, return to composing new
- **Escape** (when editing): discard changes, return to composing new
- **Enter** (when composing new): add to queue (during streaming)
- **x on card**: remove from queue with scale-down exit animation

**Visual state when editing queued item:**
- Textarea border color changes (subtle accent)
- Label above textarea: "Editing message 2/3" (replaces placeholder)
- Button changes from Queue (clock) to Update (checkmark)

**Auto-flush lifecycle:**
1. Status transitions from `streaming` to `idle`
2. If `queue.length > 0`, pop first item
3. Prepend timing annotation: `[Note: This message was composed while the agent was responding to the previous message]`
4. Call `handleSubmit(annotatedContent)` — triggers status back to `streaming`
5. Repeat on next `idle` transition until queue is empty
6. Respect `sessionBusy` — pause flushing if server lock detected
7. Respect relay `waitForStreamReady` handshake between flushes

**Queue cleanup:**
- Clear queue on `sessionId` change
- Clear queue on `selectedCwd` change
- Clear queue on page unload (no persistence)

### Delight Opportunities

1. **Placeholder evolution**: `"Message Claude..."` → `"Compose next — will send when ready"` during streaming → `"Queued 2 — compose another or wait"` with items queued
2. **Stagger animation**: Queue cards appear with spring physics stagger (0.05s delay between cards)
3. **Badge on queue button**: Small count badge (like notification dots) showing queue depth
4. **Breathing pulse**: Subtle opacity pulse on the inference indicator during streaming (1-2s period, 0.6-1.0 opacity) — communicates "alive" without distraction
5. **Haptic feedback (mobile)**: Single 10ms `navigator.vibrate()` pulse on queue confirmation
6. **Sound**: Optional queue confirmation sound (using existing notification sound infrastructure from spec #27)
