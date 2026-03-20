---
slug: question-prompt-tabs
number: 15
created: 2026-02-13
status: implemented
---

# Question Prompt Tabs & Answer Summary

**Slug:** question-prompt-tabs
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Improve the QuestionPrompt UI (AskUserQuestion tool) in two ways: (1) when multiple questions arrive simultaneously, display a tab bar so users answer one question at a time instead of seeing all questions at once; (2) fix the poorly formatted answer summary that displays after questions are answered.
- **Assumptions:**
  - The project already has a Radix `Tabs` component at `apps/client/src/components/ui/tabs.tsx` (from settings-tabs work)
  - Questions arrive as an array in a single `question_prompt` event — no protocol changes needed
  - The answer submission API (`transport.submitAnswers`) remains unchanged — all answers still submitted as a single `Record<string, string>` batch
  - When only 1 question is present, the tab bar should be hidden (no visual change from current behavior)
- **Out of scope:**
  - Changing the AskUserQuestion SDK protocol or server-side handling
  - Modifying how answers are persisted in JSONL transcripts
  - Adding new question types (sliders, date pickers, etc.)

## 2) Pre-reading Log

- `apps/client/src/components/chat/QuestionPrompt.tsx`: Main component (257 lines). Renders all questions vertically in a single form. Collapsed state uses `flex flex-wrap gap-2` with inline spans showing `Header: value` pairs — causes poor formatting with long answers.
- `apps/client/src/components/chat/__tests__/QuestionPrompt.test.tsx`: 11 tests covering single/multi-select, Other input, submit flow, collapsed state, error handling.
- `apps/client/src/components/ui/tabs.tsx`: Radix Tabs wrapper with `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` exports. Uses shadcn styling patterns.
- `apps/client/src/components/chat/MessageItem.tsx`: Renders QuestionPrompt when `part.interactiveType === 'question'`. Passes `questions`, `answers`, `sessionId`, `toolCallId`.
- `apps/client/src/hooks/use-chat-session.ts`: `ToolCallState` interface holds `questions?: QuestionItem[]` and `answers?: Record<string, string>`. Answer key is question index as string.
- `packages/shared/src/schemas.ts`: `QuestionItem` has `header`, `question`, `options[]`, `multiSelect`. `QuestionOption` has `label`, `description?`.
- `packages/shared/src/transport.ts`: `submitAnswers(sessionId, toolCallId, answers: Record<string, string>)` — single batch call.
- `guides/interactive-tools.md`: Documents the full AskUserQuestion flow from SDK through server to client and back.

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/components/chat/QuestionPrompt.tsx` — The component being modified
- `apps/client/src/components/ui/tabs.tsx` — Existing Radix Tabs primitive to reuse
- `apps/client/src/components/chat/MessageItem.tsx` — Parent that renders QuestionPrompt

**Shared dependencies:**

- `@dorkos/shared/types` — `QuestionItem`, `QuestionOption` types
- `../../contexts/TransportContext` — `useTransport()` for `submitAnswers()`
- `lucide-react` — `Check`, `MessageSquare` icons

**Data flow:**
SDK `question_prompt` event → server SSE → `useChatSession` adds tool call part with `interactiveType: 'question'` → `MessageItem` renders `<QuestionPrompt>` → user selects answers → `transport.submitAnswers()` → server resolves deferred promise → SDK resumes

**Answer format:**

- Key: question index as string (`"0"`, `"1"`, etc.)
- Value: selected label string (single-select) or `JSON.stringify([...labels])` (multi-select)
- `__other__` sentinel replaced with user's typed text before submission

**Potential blast radius:**

- Direct: `QuestionPrompt.tsx` (rewrite pending/collapsed states)
- Tests: `__tests__/QuestionPrompt.test.tsx` (update for tabs, new summary tests)
- No changes to server, transport, types, or MessageItem

## 4) Root Cause Analysis

N/A — this is a feature improvement, not a bug fix.

## 5) Research

### Navigation Approaches Compared

**1. Pill-styled Radix Tabs (question headers as tab labels)**

- Pros: Built-in a11y (keyboard nav, ARIA), controlled state, compact pill styling, non-linear navigation (users can jump between questions)
- Cons: Longer headers can overflow horizontally, requires truncation for long labels
- Complexity: Low (reuses existing `ui/tabs.tsx`)

**2. Step indicators (1/3, 2/3) with Next/Prev buttons**

- Pros: Clear linear progression, minimal horizontal space, checkmarks on completed steps
- Cons: No built-in component (manual ARIA needed), harder to jump to specific question, requires multiple clicks to go back
- Complexity: Medium

**3. Pure pill tabs without navigation buttons**

- Pros: Simplest implementation
- Cons: Users may not realize they should click tabs, no guided flow
- Complexity: Low

### Answer Summary Approaches Compared

**1. Vertical stacked cards (header above, value below)**

- Pros: Clear visual hierarchy, handles long answers well, scannable
- Cons: Takes more vertical space
- Complexity: Low

**2. Inline flex-wrap chips (current approach)**

- Pros: Compact when answers are short
- Cons: Wraps awkwardly with long values, poor readability with multiple answers
- Complexity: N/A (current)

**3. Accordion/collapsible summary**

- Pros: Saves space collapsed
- Cons: Requires interaction to see answers, overkill for 1-4 items
- Complexity: Medium

### Recommendation

**Navigation:** Pill-styled Radix Tabs using question `header` as tab label. When only 1 question exists, render directly without tabs (no visual regression). The existing `ui/tabs.tsx` component can be reused as-is.

**Answer Summary:** Vertical stacked layout — each Q&A pair on its own line with the header as a subdued label and the answer value below or beside it. This fixes the wrapping issue while remaining compact enough for the tool card context.

## 6) Clarification

1. **Tab behavior with 1 question:** Should we hide the tab bar entirely when there's only 1 question (no visual change from today), or always show it? Recommendation: hide when 1 question.

2. **Answer summary layout:** The current inline `flex-wrap` chips layout breaks with long answers. Two options:
   - **A) Vertical stack** — Each Q&A pair on its own row: `Header:` label on top, answer value below. Clean and handles any length.
   - **B) Inline but improved** — Keep horizontal but use pill/badge styling with `max-width` and truncation on long values.
     Recommendation: A (vertical stack) since it handles all answer lengths gracefully.

3. **Single submit vs per-question:** Currently all answers are submitted in one batch. Should we keep the single "Submit All" button, or add individual "Next" buttons that auto-advance? Recommendation: Keep single submit — the SDK expects all answers at once, and adding per-question submission would require protocol changes.

4. **Tab completion indicators:** Should answered tabs show a checkmark or visual indicator that they've been completed? Recommendation: Yes — show a subtle checkmark or filled dot on tabs where a selection has been made.
