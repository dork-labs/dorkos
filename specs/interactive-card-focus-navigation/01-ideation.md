---
slug: interactive-card-focus-navigation
number: 145
created: 2026-03-17
status: ideation
---

# Unified Input Zone for Interactive Cards

**Slug:** interactive-card-focus-navigation
**Author:** Claude Code
**Date:** 2026-03-17
**Branch:** preflight/interactive-card-focus-navigation

---

## 1) Intent & Assumptions

- **Task brief:** Overhaul how QuestionPrompt and ToolApproval interactive cards handle focus, keyboard navigation, and user interaction. The core insight (from the user) is to relocate interactive cards from the message stream into the chat input zone — transforming the bottom input area into a unified interaction surface that adapts to what the conversation requires. This eliminates dual focus areas and creates a single, predictable interaction point.

- **Assumptions:**
  - The existing `InteractiveCard` primitive handles visual styling (left accent bar, `bg-muted/50`)
  - The existing `useInteractiveShortcuts` hook provides global keyboard listener infrastructure
  - Both components already have imperative handle patterns (`useImperativeHandle`)
  - The `CompactResultRow` primitive already renders collapsed decided/submitted states in the stream
  - The Claude Code Desktop app uses this input-zone pattern as proven UX
  - The input zone approach replaces (not supplements) the current in-stream interactive card placement

- **Out of scope:**
  - Touch/gesture navigation
  - Changes to the ToolApproval countdown timer behavior
  - Changes to how the server sends tool approval / question events
  - Redesigning the option row visual style beyond spacing and Kbd position changes
  - Mobile-specific input zone behavior (will follow desktop pattern initially)

## 2) Pre-reading Log

- `contributing/keyboard-shortcuts.md` (328 lines): Complete focus state machine documentation. Defines the concept of "active interactive tool" — only one at a time. Documents keyboard shortcut bindings for approval (Enter/Escape) and question (digits, arrows, Enter) flows. Currently binds at `document` level.
- `contributing/interactive-tools.md` (664 lines): Architecture and data flow for interactive tools. Describes the imperative handle pattern, how `activeToolCallId` is determined, and the tool → render pipeline.
- `apps/client/src/layers/features/chat/ui/QuestionPrompt.tsx` (432 lines): Multi-question form with tabs, radio/checkbox options, "Other" free-text. Uses `forwardRef` + `useImperativeHandle`. Renders inline in the message stream. Has `isActive` and `focusedOptionIndex` props.
- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx` (280 lines): Tool approval card with countdown timer, approve/deny buttons. Uses ref-as-prop + `useImperativeHandle`. Renders inline in the message stream. Has `isActive` prop.
- `apps/client/src/layers/features/chat/ui/primitives/InteractiveCard.tsx` (35 lines): Shared container with active/inactive/resolved visual states. Left accent bar, ring on active, opacity on inactive.
- `apps/client/src/layers/features/chat/ui/primitives/OptionRow.tsx`: Option row primitive with focused/selected states.
- `apps/client/src/layers/features/chat/ui/primitives/CompactResultRow.tsx`: Compact single-row result display for decided/submitted states.
- `apps/client/src/layers/shared/model/use-interactive-shortcuts.ts` (132 lines): Global `document` keydown listener. Routes keys to the active card based on `activeInteraction` type ('approval' or 'question'). Handles Enter, Escape, digits 1-9, arrows, Space, `[`/`]` for question navigation.
- `apps/client/src/layers/features/chat/model/use-tool-shortcuts.ts` (104 lines): Wires `useInteractiveShortcuts` to imperative handles. Determines `activeInteraction` from the active tool's type. Manages `focusedOptionIndex` state with bounds checking.
- `apps/client/src/layers/features/chat/ui/message/MessageItem.tsx` (101 lines): Message orchestrator. Passes `activeToolCallId`, `onToolRef`, `focusedOptionIndex` down via `MessageProvider` context.
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Renders tool calls, including ToolApproval and QuestionPrompt inline within assistant messages.
- `apps/client/src/layers/features/chat/__tests__/QuestionPrompt.test.tsx` (697 lines, 30+ tests): Comprehensive test suite.
- `apps/client/src/layers/features/chat/__tests__/ToolApproval.test.tsx` (349 lines): Tests for approval/deny flow, countdown timer, decided states.
- `apps/client/src/layers/features/chat/ui/primitives/__tests__/InteractiveCard.test.tsx`: Tests for InteractiveCard primitive.
- `specs/question-prompt-redesign/02-specification.md`: Recent visual redesign spec (implemented).

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/layers/features/chat/ui/QuestionPrompt.tsx` — Multi-question form (target for relocation)
- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx` — Tool approval card (target for relocation)
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Main chat panel containing message list + input area
- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` — The bottom input zone (target for transformation)
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Chat session state, manages pending interactive tools
- `apps/client/src/layers/features/chat/model/use-tool-shortcuts.ts` — Keyboard shortcut wiring
- `apps/client/src/layers/shared/model/use-interactive-shortcuts.ts` — Global keyboard listener

**Shared dependencies:**

- `apps/client/src/layers/features/chat/ui/primitives/` — InteractiveCard, OptionRow, CompactResultRow
- `apps/client/src/layers/shared/ui/` — Button, Kbd, RadioGroup, Checkbox, Tabs components
- `apps/client/src/layers/shared/model/TransportContext` — Transport for `approveTool`, `denyTool`, `submitAnswers`
- `motion/react` — Animation library for transitions

**Data flow:**

1. Server sends tool_call with `requiresApproval` or `question` type via SSE
2. `stream-event-handler.ts` processes event, adds to message store
3. `AssistantMessageContent` renders the tool call inline in the message stream
4. `use-tool-shortcuts.ts` determines which tool is "active" (the latest pending one)
5. `useInteractiveShortcuts` binds keyboard events for the active tool
6. User interacts → imperative handle calls transport method → server responds

**With the new approach, data flow changes:**

1. Server sends event (same)
2. Stream handler processes event, adds to message store (same)
3. Message stream shows a **placeholder/pending marker** (NOT the full interactive card)
4. **ChatInputContainer transforms** to show the interactive card's UI
5. Keyboard events are naturally captured by the focused input zone (no global listener needed)
6. User interacts → transport method called → resolved state shown in both input zone (briefly) and message stream (CompactResultRow)

**Potential blast radius:**

- Direct: ChatInputContainer, ChatPanel, QuestionPrompt, ToolApproval, AssistantMessageContent, use-tool-shortcuts, use-interactive-shortcuts
- Indirect: MessageItem, MessageProvider (props may change), use-chat-session (state management)
- Tests: QuestionPrompt tests, ToolApproval tests, ChatPanel tests, use-interactive-shortcuts tests
- The in-stream rendering of interactive cards changes fundamentally (from full card to placeholder → compact result)

## 4) Root Cause Analysis

N/A — this is a UX enhancement, not a bug fix.

## 5) Research

### Potential Solutions

**1. Input Zone Transformation (Claude Code Desktop pattern)**

- Description: The chat input area transforms into the interactive card when user action is needed. The message stream shows a pending placeholder that resolves to a `CompactResultRow` after action. One interaction point.
- Pros:
  - Eliminates dual focus zones entirely
  - Natural attention flow (eyes read up, hands interact down)
  - Proven pattern (Claude Code Desktop)
  - Simplifies keyboard architecture — no global listener routing
  - The input area becomes a "conversation surface" that adapts
- Cons:
  - Significant refactor of how interactive cards render
  - Transition animation complexity (text input ↔ card morph)
  - Must handle edge case of user typing when card appears
  - Queue management for multiple pending cards
- Complexity: High
- Maintenance: Medium (simpler mental model long-term)

**2. Improved In-Stream Cards with Focus Management**

- Description: Keep cards in the message stream but add proper focus management — auto-scroll, focus save/restore, enhanced keyboard routing.
- Pros:
  - Smaller change footprint
  - Cards stay where they semantically belong (with the tool call)
  - No input zone redesign needed
- Cons:
  - Doesn't solve the fundamental dual-focus problem
  - Focus save/restore is fragile (what if the saved element is removed from DOM?)
  - Still requires global keyboard listener with routing logic
- Complexity: Medium
- Maintenance: Medium

**3. Hybrid: In-Stream Card + Input Zone Summary Bar**

- Description: Card stays in stream but a summary/action bar appears in the input zone (like "Tool approval needed — Enter to approve, Esc to deny"). Clicking the bar scrolls to the card.
- Pros:
  - Low disruption to current architecture
  - Input zone provides a "you need to do something" signal
  - Card context (tool name, args) stays in the message stream
- Cons:
  - Still two interaction points
  - Adds UI complexity without fully solving the problem
  - Feels like a compromise, not a design conviction
- Complexity: Medium
- Maintenance: High (two UIs to keep in sync)

### Recommendation

**Recommended Approach: Input Zone Transformation (#1)**

This is the approach that Steve Jobs would demand, Jony Ive would design, and Dieter Rams would approve. It's the most ambitious but solves the problem at its root rather than treating symptoms. The chat input area IS the interaction surface — it should adapt to whatever the conversation requires.

The key architectural insight: the message stream is a **history**. The input zone is the **present**. Interactive cards are a present-tense action. They belong in the present.

### Specific UX Research Findings

**Keyboard navigation:**

- **Roving tabindex** is the correct ARIA pattern for option navigation (not `aria-activedescendant`) — better AT support, auto-scrolls focused option into view
- **`<kbd>` hints should appear after the label, right-aligned** — universal industry convention (Linear, VS Code, GitHub), matches WCAG accessible name ordering
- **Arrow keys should always navigate options**, even when textarea is focused — consistent, predictable behavior; Shift+Enter for newlines in "Other" text
- **Back/Next buttons replace tab strip** for multi-question flows — simpler, more focused UI with step indicator ("2 of 3")

**Focus management:**

- Soft focus scope (not a focus trap) — the input zone naturally captures keyboard events
- `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` for focused option visibility
- No need for `document.activeElement` save/restore with the input zone approach — the input zone simply transforms back to text input after resolution

**Textarea interaction:**

- Current "suppress arrows in textarea" approach is correct and simpler than textarea boundary detection
- User uses Shift+Enter for multi-line "Other" text

## 6) Decisions

| #   | Decision                       | Choice                                   | Rationale                                                                                                                                              |
| --- | ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Where interactive cards render | Input zone transformation                | User insight: "create a single place for users to interact / send input." Eliminates dual focus, matches Claude Code Desktop. Steve Jobs: "One place." |
| 2   | Kbd hint position              | After label, right-aligned               | Industry standard (Linear, VS Code, GitHub). WCAG accessible name ordering. Clean visual hierarchy: control → label → hint.                            |
| 3   | Arrow keys in textarea         | Up/Down always navigate options          | Consistent behavior. Shift+Enter for newlines. Predictable — user always knows what arrows do.                                                         |
| 4   | Multi-question navigation      | Replace tab strip with Back/Next buttons | Simpler UI, sequential flow with step indicator. Left/Right arrows for keyboard nav. Enter advances to next question, Submit on last.                  |
