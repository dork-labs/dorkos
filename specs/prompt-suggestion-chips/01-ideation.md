---
slug: prompt-suggestion-chips
number: 140
created: 2026-03-16
status: ideation
---

# Prompt Suggestion Chips

**Slug:** prompt-suggestion-chips
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/prompt-suggestion-chips

---

## 1) Intent & Assumptions

- **Task brief:** Surface `prompt_suggestion` SDK messages as clickable follow-up suggestion chips in the chat UI. The SDK emits `{ type: 'prompt_suggestion', suggestions: string[] }` after certain completions, but they're silently dropped in `sdk-event-mapper.ts`. This is a missed UX opportunity — after an agent finishes a task, showing 2-3 suggested follow-ups ("Run the tests", "Review the changes", "Commit this work") reduces friction and helps users discover capabilities.
- **Assumptions:**
  - SDK emits `prompt_suggestion` once per completion, after the `result` message
  - The `suggestions` array contains 1-5 short text strings (natural language prompts)
  - The feature follows the existing full-stack pattern: SDK message → mapper → StreamEvent → SSE → client handler → React state → UI
  - The existing `ShortcutChips.tsx` component provides a proven chip rendering pattern to follow
  - Cross-client sync works naturally through the existing SSE pipeline
- **Out of scope:**
  - Generating our own suggestions (we only surface what the SDK provides)
  - Modifying SDK behavior or suggestion content
  - Prompt suggestion curation, filtering, or ranking
  - Persisting suggestions in JSONL session history
  - Hook events, status messages, or other dropped SDK event types (separate audit items)

## 2) Pre-reading Log

- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: Core mapper that transforms SDK messages to StreamEvents. Currently drops `prompt_suggestion` messages — no branch handles this type. Lines 210-252 show `result` handling where suggestions arrive immediately after.
- `packages/shared/src/schemas.ts`: Defines `StreamEventTypeSchema` (lines 29-56) with all valid event types and `StreamEventSchema` discriminated union (lines 389-418). No `prompt_suggestion` type exists yet. Pattern to follow: each event has a dedicated Zod schema added to the union.
- `packages/shared/src/types.ts`: Re-exports types from schemas. Must add export for new `PromptSuggestionEvent` type.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Client-side handler processing SSE events into React state. Lines 164-462 show a switch statement handling each event type. No case for `prompt_suggestion`. Pattern: add a new case that calls a setter from `StreamEventDeps`.
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Renders message parts (text, tool_call, subagent, thinking, error). Lines 121-200 show the part-mapping loop. Suggestions render separately, not as message parts.
- `apps/client/src/layers/features/chat/ui/ChatInput.tsx`: Input textarea with ref `textareaRef` (line 84), `focusAt()` method (lines 90-95), and `setInput` callback. This is how we populate the input when a chip is clicked.
- `apps/client/src/layers/features/chat/ui/ShortcutChips.tsx`: Existing chip component (46 lines) rendering `/` (Commands) and `@` (Files) triggers. Lines 31-44 show chip button pattern with `motion` animation, icon, keyboard shortcut display, and onClick handler. **This is the exact pattern to follow for prompt suggestion chips.**
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Main chat container orchestrating state from hooks. Renders ShortcutChips. This is where PromptSuggestionChips would also render.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Hook managing chat state. Must add `promptSuggestions: string[]` state and expose setter via `StreamEventDeps`.
- `apps/server/src/services/runtimes/claude-code/message-sender.ts`: SDK query execution pipeline. Line 22 imports `mapSdkMessage`. Events yielded by the mapper are sent to clients via SSE.
- `apps/server/src/services/core/stream-adapter.ts`: SSE wire protocol helpers. `sendSSEEvent()` (lines 10-26) formats StreamEvent as `event: {type}\ndata: {json}`.
- `specs/shortcut-chips/02-spec.md`: Well-documented spec showing chip implementation patterns (P1-P5 phases). Chips render below ChatInput with motion animation, store toggle in Zustand.
- `specs/system-status-compact-boundary/01-ideation.md`: Explicitly defers `prompt_suggestion` as a separate P2 item (line 30).
- `contributing/animations.md`: Motion library patterns — `AnimatePresence` + `motion.div` for enter/exit animations.
- `.temp/agent-sdk-audit.md`: Comprehensive SDK audit. Item #17 is `prompt_suggestion` — rated P2, "Missed UX opportunity for follow-up suggestions."

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/shared/src/schemas.ts` — Zod schemas for all StreamEvent types. Add `PromptSuggestionEventSchema` + update discriminated union.
  - `packages/shared/src/types.ts` — Type re-exports. Add `PromptSuggestionEvent` export.
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — SDK→StreamEvent mapper. Add `prompt_suggestion` case.
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Client event handler. Add `prompt_suggestion` case.
  - `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Chat state hook. Add `promptSuggestions` state + setter.
  - `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Main chat container. Render `PromptSuggestionChips`, wire click handler.
  - **NEW** `apps/client/src/layers/features/chat/ui/PromptSuggestionChips.tsx` — New chip component.

- **Shared dependencies:**
  - `@dorkos/shared/types` — StreamEvent type union
  - `@dorkos/shared/schemas` — Zod validation schemas
  - `motion/react` — `AnimatePresence` + `motion.button` for chip animations
  - `lucide-react` — Icon for chip visual (e.g., `Sparkles`, `ArrowRight`, or `MessageSquare`)
  - React 19 hooks (`useState`, refs)

- **Data flow:**
  ```
  SDK emits prompt_suggestion { suggestions: string[] }
    ↓
  sdk-event-mapper.ts → yield { type: 'prompt_suggestion', data: { suggestions } }
    ↓
  message-sender.ts → SSE stream → stream-adapter.ts formats wire protocol
    ↓
  Client SSE listener (use-chat-session.ts)
    ↓
  stream-event-handler.ts case 'prompt_suggestion' → setPromptSuggestions(suggestions)
    ↓
  ChatPanel renders <PromptSuggestionChips suggestions={...} />
    ↓
  User clicks chip → setInput(suggestion) + focus input
    ↓
  User presses Enter → sendMessage() → suggestions clear
  ```

- **Feature flags/config:** None needed. SDK controls whether it emits `prompt_suggestion` via its own configuration. Client renders whatever arrives.

- **Potential blast radius:**
  - Direct: 7 files (5 modified, 1 new component, 1 new test)
  - Indirect: Files importing `StreamEventType` or `StreamEvent` from `@dorkos/shared` — changes are additive (new union member), so existing consumers are unaffected
  - Tests: New test for `PromptSuggestionChips`, update `stream-event-handler` tests for new case, update `sdk-event-mapper` tests for new SDK message type

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

Research agent consulted 14 sources including NN/G articles, Material Design 3 chip guidelines, Perplexity/ChatGPT/Gemini UX patterns, and Motion animation docs. Full research saved to `research/20260316_prompt_suggestion_chips_ux.md`.

### Potential Solutions

**1. Inline Chips Below Last Assistant Message (Recommended)**
- Chips rendered as pill buttons in a horizontal row directly below the final message bubble, scrolling with the conversation
- Pros: Industry consensus location (ChatGPT, Perplexity, Gemini), contextually associated with the message that generated them, natural keyboard tab order, no z-index conflicts, fully accessible via native `<button>` elements
- Cons: Requires scroll if user is far up in history — mitigated by the existing scroll-to-bottom behavior that fires on `done`
- Complexity: Low — single new component, follows existing `ShortcutChips.tsx` pattern
- Maintenance: Low — purely additive, no existing behavior changes

**2. Floating Bar Above Input Area**
- Fixed-position area above the chat textarea, always visible
- Pros: Always reachable regardless of scroll position
- Cons: Permanent layout real estate, layout shift when chips appear/disappear, competes with command palette z-index, wrong aesthetic for DorkOS's control-panel feel
- Complexity: High — requires careful z-index management, layout animation
- Maintenance: Medium — coupling with input area layout

**3. Inside the Input Area (Ghost Text / Embedded Chips)**
- Suggestions appear as ghost text or chips embedded in the textarea
- Pros: Zero extra layout space
- Cons: Conflicts with typed content, multiple suggestions don't map to a single ghost string, destroys input simplicity, observed to confuse users in research
- Complexity: Very high — textarea overlay management
- Maintenance: High — fragile coupling with input behavior

**4. Inline with Auto-Scroll Anchor (Refinement of #1)**
- Same as #1 but scroll is guarded by IntersectionObserver — only scrolls if user is already near bottom
- Pros: Guarantees visibility without jarring scroll for users reading history
- Cons: Marginally more complexity than #1
- Complexity: Low-Medium — use existing scroll guard in `useChatSession`
- Maintenance: Low

### Security Considerations
- Suggestion text is plain text from the Claude SDK. React JSX auto-escaping provides full XSS protection when rendered as `{suggestion}` inside `<button>`. Never use `dangerouslySetInnerHTML`.
- When submitted as a user message, the suggestion flows through the existing `sendMessage` pipeline — no additional sanitization needed.

### Performance Considerations
- `prompt_suggestion` events are sparse (one per turn, not a stream of deltas). No debounce or batching needed.
- Chips are plain text `<button>` elements — negligible DOM cost.
- `AnimatePresence` with 2-3 items adds no measurable overhead.
- Store as `string[]` in local `useState` — no Zustand store needed for ephemeral session-local UI state.

### Accessibility Considerations
- Use native `<button>` elements for keyboard focusability and Enter/Space activation
- Wrap chips in `role="group"` container with `aria-label="Suggested follow-ups"`
- Use `aria-label` on each chip when text is truncated
- Do not auto-move focus to chips on appearance — let user navigate naturally
- Visible focus ring via existing `focus-visible:ring-2` Tailwind utilities

### Recommendation
**Recommended: Approach #1 (Inline chips below last assistant message)**. Industry consensus, lowest complexity, follows existing `ShortcutChips.tsx` pattern, fully accessible, no layout shift concerns. Auto-scroll already handles visibility.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Click behavior | Populate input only (no auto-send) | NN/G research + Perplexity pattern. Gives power users review control before execution. Aligns with Kai persona who prefers to verify before sending. |
| 2 | Chip persistence | Clear on any message send | Ephemeral UI — chips vanish when user sends any message (suggestion or typed). Never persisted in JSONL history. Clean, predictable lifecycle. |
| 3 | Input overlap behavior | Hide when input has text | Chips fade out when user starts typing, fade back if input is cleared. Prevents confusion about replace-vs-append. Clean UX with no ambiguity. |
