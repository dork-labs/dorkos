---
slug: question-prompt-redesign
number: 144
created: 2026-03-16
status: ideation
---

# QuestionPrompt Component Redesign

**Slug:** question-prompt-redesign
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/question-prompt-redesign

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the `QuestionPrompt` component to be minimal, compact, keyboard-navigable, and visually consistent with the rest of the chat UI. The current implementation uses warning-level amber coloring for conversational questions, wastes vertical space with redundant headers and extravagant option layouts, uses unstyled native radio/checkbox inputs, and lacks proper ARIA roles for keyboard accessibility. The goal is an Apple-quality interactive component that feels like a natural part of the conversation — not a form dropped into a chat.

- **Assumptions:**
  - The data model (`QuestionItem`, `QuestionOption`, `ToolCallState`) stays unchanged
  - The imperative handle API (`toggleOption`, `navigateQuestion`, `submit`, etc.) stays unchanged since MessageItem depends on it
  - The Transport `submitAnswers` call stays unchanged
  - The submitted/collapsed state still collapses to a summary
  - Multi-question tab navigation stays but becomes more refined
  - "Other" free-text option is still supported

- **Out of scope:**
  - Changing the SDK message format or server-side handling
  - Adding new shared RadioGroup/Checkbox primitives to the design system (use visually-hidden inputs with custom indicators instead)
  - Changing the `MessageItem` or `AssistantMessageContent` rendering pipeline
  - Redesigning ToolApproval (though this redesign should be informed by its patterns)

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/QuestionPrompt.tsx`: 418 lines. Main component — forwardRef, manages selections/otherText/submitted/submitting/error/activeTab state. Renders two modes: collapsed (submitted) and pending (form). Uses raw amber colors throughout instead of design tokens.
- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx`: 272 lines. Sibling interactive component — uses `approvalState` TV variant from `message-variants.ts`, semantic status tokens (`status-warning`, `status-success`, `status-error`), `rounded-msg-tool` class, shared `Kbd` component. Good reference for design consistency.
- `apps/client/src/layers/features/chat/ui/message/message-variants.ts`: 95 lines. TV variants for message styling. Has `approvalState` variant but no equivalent for questions. Should add a `questionState` variant.
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`: Uses `rounded-msg-tool`, `bg-muted/50`, `shadow-msg-tool`. Reference for card styling in the chat context.
- `apps/client/src/layers/features/chat/ui/ThinkingBlock.tsx`: Uses `rounded-msg-tool`, `bg-muted/50`, `border-l-2`. Reference for subtle inline card styling.
- `apps/client/src/layers/features/chat/__tests__/QuestionPrompt.test.tsx`: 30+ test cases covering all states. Tests will need updates for changed markup/classes.
- `apps/client/src/layers/shared/ui/index.ts`: Exports Tabs, TabsList, TabsTrigger, TabsContent, Kbd, Button — all available for use.
- `apps/client/src/index.css`: Status design tokens — `status-info` (blue) for informational, `status-warning` (amber) for warnings, `status-success` (green) for success. Question prompts should use `status-info` or neutral, not `status-warning`.
- `packages/shared/src/schemas.ts`: QuestionItemSchema and QuestionOptionSchema definitions.
- `apps/client/src/dev/showcases/MessageShowcases.tsx`: Showcase page with all QuestionPrompt variants.
- `apps/client/src/dev/mock-chat-data.ts`: Mock data for showcases.
- `contributing/design-system.md`: Calm Tech design language — card radius 16px, button radius 10px, 8pt grid.

## 3) Codebase Map

**Primary components/modules:**
- `apps/client/src/layers/features/chat/ui/QuestionPrompt.tsx` — Main component being redesigned
- `apps/client/src/layers/features/chat/ui/message/message-variants.ts` — TV variants, needs new `questionState` variant
- `apps/client/src/layers/features/chat/__tests__/QuestionPrompt.test.tsx` — Test suite needing updates

**Shared dependencies:**
- `@/layers/shared/ui`: Tabs, TabsList, TabsTrigger, TabsContent, Kbd, Button
- `@/layers/shared/model`: useTransport
- `@/layers/shared/lib`: cn
- `@dorkos/shared/types`: QuestionItem
- `lucide-react`: Check, MessageSquare

**Data flow:**
SSE `question_prompt` event -> `stream-tool-handlers.ts` -> `ToolCallPart` with `interactiveType: 'question'` -> `AssistantMessageContent` -> `QuestionPrompt` -> user selects -> `transport.submitAnswers()` -> collapsed state

**Feature flags/config:** None

**Potential blast radius:**
- Direct: `QuestionPrompt.tsx`, `message-variants.ts`
- Tests: `QuestionPrompt.test.tsx`
- Showcases: `MessageShowcases.tsx`, `mock-chat-data.ts` (may need updates if markup changes)
- No impact on server, shared schemas, or other components

## 4) Root Cause Analysis

N/A — this is a design improvement, not a bug fix.

## 5) Research

### Design Review Findings

**Visual inspection** of the component in the browser design system playground revealed these issues ranked by severity:

**Issue 1: Semantic color mismatch**
- QuestionPrompt uses amber (`bg-amber-500/10`, `border-amber-500/20`) — the same color as ToolApproval's "warning" state
- A question is not a warning. Amber signals urgency/danger; questions are conversational
- ToolApproval correctly uses semantic tokens (`status-warning-bg`, `status-warning-border`)
- QuestionPrompt uses raw amber values instead of design tokens
- **Recommendation:** Use neutral styling (`bg-muted/50`) or `status-info` tokens (blue) for pending, `status-success` tokens for submitted

**Issue 2: Redundant header row**
- Every question renders `[MessageSquare icon] [bold header]` then the question text below
- In single-question mode: header adds nothing ("Framework" then "Which testing framework should we use?")
- In multi-question mode: header is already the tab label — showing it again inside content is duplication
- Takes ~28px of vertical space per question
- **Recommendation:** Remove header row entirely. Question text is the header. Tabs provide context in multi-question mode.

**Issue 3: Native form controls**
- Uses `<input type="radio">` and `<input type="checkbox">` with `accent-amber-500`
- Native controls look different on every OS/browser and don't match the design system
- No shared RadioGroup/Checkbox in the design system currently
- **Recommendation:** Use visually-hidden native inputs with custom CSS indicators (circles/squares with transitions)

**Issue 4: Vertically extravagant options**
- Each option: `py-1.5` padding + bold label + description on separate line + `space-y-1.5` gap
- 4 options + Other = ~280px vertical height
- Descriptions below labels double per-option height
- **Recommendation:** Inline descriptions on same line as label. Reduce padding. Target ~160px (47% reduction).

**Issue 5: Weak submit button**
- Raw `<button>` with hand-rolled classes instead of shared `Button` component
- `bg-amber-600 px-3 py-1.5 text-xs` looks muted, uncertain
- **Recommendation:** Use shared `Button` component, size "sm"

**Issue 6: Kbd number badges add clutter**
- Numbered badges on every option visible whenever `isActive`
- Useful for keyboard users but noise for mouse/touch majority
- **Recommendation:** Make much more subtle (smaller, lighter), or only show in keyboard-nav state

**Issue 7: "Navigate questions" hint wastes space**
- Full line for `← → navigate questions` — permanent clutter after one-time learning
- **Recommendation:** Remove. Trust discoverability or use tooltip on tab bar.

**Issue 8: Keyboard navigation gaps**
- No `role="radiogroup"` or `role="listbox"` on options container
- No `aria-activedescendant` for screen reader focus tracking
- `navigateOption` is a no-op in the imperative handle
- Tab key skips options (jumps to Submit)
- Space key doesn't toggle focused option
- **Recommendation:** Add proper ARIA roles, implement roving tabindex pattern

**Issue 9: Submitted state uses raw colors**
- Collapsed state uses `bg-emerald-500/10`, `border-emerald-500/20` — raw emerald
- Should use `status-success-bg`, `status-success-border`, `status-success-fg` tokens
- **Recommendation:** Use `approvalState({ state: 'approved' })` from message-variants or create equivalent

**Issue 10: No visual distinction for stale questions**
- Old unanswered questions look identical to the active one
- **Recommendation:** Non-active pending questions should be visually dimmed

### Space Budget Analysis

| Element | Current | Proposed | Savings |
|---|---|---|---|
| Header row (icon + text) | ~28px | Remove (0px) | 28px |
| Question text margin | `mb-2` (8px) | `mb-1.5` (6px) | 2px |
| Option vertical padding | `py-1.5` per option | `py-1` per option | 4px/option |
| Option spacing | `space-y-1.5` | `space-y-0.5` | 4px/gap |
| Description placement | Below label (+20px each) | Inline after label | 20px/option |
| Navigate hint | ~24px | Remove | 24px |
| Submit button margin | `mt-3` | `mt-2` | 4px |
| **Total (4 options)** | **~300px** | **~160px** | **~47% reduction** |

### Recommendation

**Approach:** Redesign QuestionPrompt with these principles:
1. Use neutral card styling consistent with other chat inline elements (`rounded-msg-tool`, `bg-muted/50` or `status-info` tokens)
2. Remove all redundant information (header row, navigate hint)
3. Compact option layout with inline descriptions
4. Custom-styled selection indicators (no native radio/checkbox)
5. Proper ARIA roles and keyboard navigation
6. Semantic design tokens instead of raw color values
7. Shared `Button` component for submit
8. Add `questionState` TV variant to `message-variants.ts` for consistency with `approvalState`

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Pending state color | Neutral (`bg-muted/50` with subtle `status-info` accent) | Questions are conversational, not warnings. Amber misleads. Blue info or neutral reads correctly. |
| 2 | Header row in single-question | Remove entirely | Question text is self-explanatory. Header is redundant noise. |
| 3 | Header row in multi-question | Remove from content (tab label is sufficient) | Duplication — tab already shows the header. |
| 4 | Option description placement | Inline after label, lighter weight | Halves per-option height. Still readable but compact. |
| 5 | Selection indicators | Custom CSS (visually-hidden native input + styled div) | Consistent with design system. No new shared primitives needed. |
| 6 | Submit button | Use shared `Button` component, size "sm" | Consistency with design system, confident CTA. |
| 7 | Navigate hint | Remove | One-time learning affordance not worth permanent vertical space. |
| 8 | Kbd number badges | Keep but make subtler (smaller, `text-muted-foreground`) | Still useful for keyboard users, just less visually dominant. |
