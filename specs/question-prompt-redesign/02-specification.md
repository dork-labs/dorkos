# QuestionPrompt Component Redesign — Specification

**Spec:** 144
**Slug:** question-prompt-redesign
**Author:** Claude Code
**Date:** 2026-03-16
**Status:** specification

---

## 1. Overview

Redesign the `QuestionPrompt` component to be minimal, compact, keyboard-navigable, and visually consistent with the Calm Tech design system and sibling inline components (`ToolApproval`, `ToolCallCard`, `ThinkingBlock`).

The current implementation uses warning-level amber coloring for conversational questions, wastes vertical space with redundant headers and extravagant option layouts, uses unstyled native radio/checkbox inputs, and lacks proper ARIA roles. The goal is an Apple-quality interactive component that feels like a natural part of the conversation.

### Goals

- Reduce vertical height by ~40-50% through layout compaction
- Replace raw amber color values with semantic design tokens
- Replace native radio/checkbox inputs with shared shadcn primitives
- Add proper ARIA roles and keyboard navigation
- Align visual treatment with sibling components (ThinkingBlock left-border pattern)
- Distinguish non-active pending questions from the active one

### Non-Goals

- Changing the SDK message format or server-side handling
- Changing `MessageItem` or `AssistantMessageContent` rendering pipeline
- Redesigning `ToolApproval` (though this redesign references its patterns)
- Changing the imperative handle API surface (method signatures stay the same)
- Changing the `Transport.submitAnswers` call signature

---

## 2. User Decisions

These decisions were made during ideation review and are final:

| #   | Decision                     | Choice                                                              | Rationale                                                                  |
| --- | ---------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Card style                   | Left border accent: `bg-muted/50` + `border-l-2 border-status-info` | Matches ThinkingBlock pattern. Questions are conversational, not warnings. |
| 2   | Custom indicators            | Install shadcn RadioGroup + Checkbox into `shared/ui/`              | Reusable across the app. Consistent with design system.                    |
| 3   | Stale question styling       | `opacity-60` on non-active pending questions                        | Visual distinction without layout change.                                  |
| 4   | Pending state color          | Neutral with `status-info` accent (not amber)                       | Questions are informational, not warnings.                                 |
| 5   | Header row (single-question) | Remove entirely                                                     | Question text is self-explanatory.                                         |
| 6   | Header row (multi-question)  | Remove from content (tab label is sufficient)                       | Eliminates duplication.                                                    |
| 7   | Option description placement | Inline after label, lighter weight                                  | Halves per-option height.                                                  |
| 8   | Submit button                | Shared `Button` component, size `"sm"`                              | Consistency with design system.                                            |
| 9   | Navigate hint                | Remove                                                              | Trust discoverability over permanent clutter.                              |
| 10  | Kbd number badges            | Keep but subtler: `text-2xs text-muted-foreground`                  | Useful for keyboard users, less visually dominant.                         |
| 11  | Submitted state              | `status-success` design tokens                                      | Consistent with ToolApproval approved state.                               |

---

## 3. Architecture & Data Flow

### Unchanged

The data model, imperative handle API, and transport call remain unchanged:

```
SSE `question_prompt` event
  -> stream-tool-handlers.ts
  -> ToolCallPart with interactiveType: 'question'
  -> AssistantMessageContent
  -> QuestionPrompt
  -> user selects options
  -> transport.submitAnswers(sessionId, toolCallId, answers)
  -> collapsed submitted state
```

### Props Interface (unchanged)

```typescript
interface QuestionPromptProps {
  sessionId: string;
  toolCallId: string;
  questions: QuestionItem[];
  answers?: Record<string, string>;
  isActive?: boolean;
  focusedOptionIndex?: number;
}
```

### Imperative Handle (unchanged signatures)

```typescript
interface QuestionPromptHandle {
  toggleOption: (index: number) => void;
  navigateOption: (direction: 'up' | 'down') => void;
  navigateQuestion: (direction: 'prev' | 'next') => void;
  submit: () => void;
  getOptionCount: () => number;
  getActiveTab: () => string;
}
```

The `navigateOption` method is currently a no-op (focus handled externally via `focusedOptionIndex` prop). This remains unchanged.

---

## 4. Detailed Design

### 4.1 New Shared Primitives

Install shadcn RadioGroup and Checkbox into `apps/client/src/layers/shared/ui/`:

**Files to create:**

- `apps/client/src/layers/shared/ui/radio-group.tsx` — RadioGroup, RadioGroupItem
- `apps/client/src/layers/shared/ui/checkbox.tsx` — Checkbox

**Exports to add to `apps/client/src/layers/shared/ui/index.ts`:**

```typescript
export { RadioGroup, RadioGroupItem } from './radio-group';
export { Checkbox } from './checkbox';
```

These are standard shadcn components installed via `npx shadcn@latest add radio-group checkbox`. They use Radix primitives under the hood and render custom-styled indicators that match the design system.

### 4.2 New TV Variant: `questionState`

Add to `apps/client/src/layers/features/chat/ui/message/message-variants.ts`:

```typescript
/**
 * Variant for question prompt state styling.
 * Maps question lifecycle state to semantic border/background/text classes.
 */
export const questionState = tv({
  variants: {
    state: {
      pending: 'border-l-2 border-status-info bg-muted/50',
      answered: 'border-status-success-border bg-status-success-bg text-status-success-fg',
    },
  },
});
```

This mirrors the `approvalState` pattern but uses `status-info` for pending (informational) rather than `status-warning` (ToolApproval's warning semantics).

### 4.3 Container Styling

**Pending state (active question):**

```
rounded-msg-tool p-3 text-sm transition-all duration-200
+ questionState({ state: 'pending' })
+ isActive && 'ring-2 ring-status-info/30'
```

This produces: `bg-muted/50 rounded-msg-tool border-l-2 border-status-info p-3` — matching the ThinkingBlock pattern (`bg-muted/50 rounded-msg-tool border-l-2 border-muted-foreground/20`), but with the info-colored left border to signal interactivity.

**Pending state (non-active / stale question):**

```
Same as above + 'opacity-60'
```

Applied when `isActive === false` and the component is not in submitted state. This visually dims older unanswered questions.

**Submitted state:**

```
my-1 rounded-msg-tool border px-3 py-2 text-sm transition-colors duration-200
+ questionState({ state: 'answered' })
```

Replaces raw `border-emerald-500/20 bg-emerald-500/10` with `border-status-success-border bg-status-success-bg text-status-success-fg`.

### 4.4 Header Row Removal

**Current:** Every question renders a header row with `MessageSquare` icon + bold header text, then the question text below.

**New:** Remove the header row entirely. The question text (`q.question`) becomes the primary visual element, rendered as:

```tsx
<p className="text-foreground mb-1.5">{q.question}</p>
```

In multi-question mode, the tab label (`q.header`) already provides context. In single-question mode, the question text is self-explanatory.

The `MessageSquare` icon import can be removed from the file.

### 4.5 Option Layout (Compact)

**Current per-option layout (single-select):**

```tsx
<label className="flex items-start gap-2 px-2 py-1.5">
  <input type="radio" className="accent-amber-500" />
  <div>
    <span className="font-medium">
      {label} <Kbd>{n}</Kbd>
    </span>
    <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
  </div>
</label>
```

**New per-option layout (single-select with RadioGroup):**

```tsx
<div
  className="flex items-center gap-2 rounded px-2 py-1 transition-all duration-150"
  data-selected={isSelected}
>
  <RadioGroupItem value={opt.label} id={optionId} />
  <label htmlFor={optionId} className="flex-1 cursor-pointer">
    <span className="text-sm font-medium">{opt.label}</span>
    {isActive && oIdx < 9 && (
      <Kbd className="text-2xs text-muted-foreground ml-1.5">{oIdx + 1}</Kbd>
    )}
    {opt.description && (
      <span className="text-muted-foreground ml-1.5 text-xs"> — {opt.description}</span>
    )}
  </label>
</div>
```

**New per-option layout (multi-select with Checkbox):**

```tsx
<div
  className="flex items-center gap-2 rounded px-2 py-1 transition-all duration-150"
  data-selected={isSelected}
>
  <Checkbox
    checked={isSelected}
    id={optionId}
    onCheckedChange={(checked) => handleMultiSelect(qIdx, opt.label, !!checked)}
  />
  <label htmlFor={optionId} className="flex-1 cursor-pointer">
    <span className="text-sm font-medium">{opt.label}</span>
    {isActive && oIdx < 9 && (
      <Kbd className="text-2xs text-muted-foreground ml-1.5">{oIdx + 1}</Kbd>
    )}
    {opt.description && (
      <span className="text-muted-foreground ml-1.5 text-xs"> — {opt.description}</span>
    )}
  </label>
</div>
```

**Key changes:**

- `py-1` instead of `py-1.5` (saves 4px per option)
- `space-y-0.5` instead of `space-y-1.5` on the container (saves 4px per gap)
- Description inline after label with `—` separator instead of below on a separate line (saves ~20px per option with description)
- Kbd badges use `text-2xs text-muted-foreground` for subtlety
- Selected state highlight: `bg-muted` instead of `bg-amber-500/15`
- Focused state ring: `ring-1 ring-status-info/50` instead of `ring-1 ring-amber-500/50`
- Hover state: `hover:bg-muted/80` instead of `hover:bg-amber-500/5`

### 4.6 "Other" Option

The "Other" free-text option retains the same functionality but adopts the new styling:

- Uses `RadioGroupItem` or `Checkbox` instead of native input
- Selected state shows textarea below (unchanged behavior)
- Textarea border changes from `border-amber-500/30` to `border-border`, focus ring from `ring-amber-500/50` to `ring-ring`

### 4.7 Submit Button

**Current:**

```tsx
<button className="mt-3 flex items-center gap-1 rounded bg-amber-600 px-3 py-1.5 text-xs text-white ...">
```

**New:**

```tsx
<Button size="sm" onClick={handleSubmit} disabled={!isComplete() || submitting} className="mt-2">
  {submitting ? (
    'Submitting...'
  ) : (
    <>
      <Check className="size-(--size-icon-xs)" /> Submit
      {isActive && <Kbd className="ml-1.5">Enter</Kbd>}
    </>
  )}
</Button>
```

Uses the shared `Button` component from `@/layers/shared/ui`. The `size="sm"` variant provides consistent sizing. The margin reduces from `mt-3` to `mt-2`.

### 4.8 Tab Bar (Multi-Question)

**Remove the "navigate questions" hint:**

```tsx
// DELETE this block entirely:
{
  isActive && questions.length > 1 && (
    <div className="text-2xs text-muted-foreground mb-2 flex items-center gap-1">
      <Kbd>&larr;</Kbd>
      <Kbd>&rarr;</Kbd>
      <span>navigate questions</span>
    </div>
  );
}
```

**Update tab trigger styling** — replace amber active state with neutral:

```tsx
<TabsTrigger
  className="data-[state=inactive]:bg-muted/50 h-auto rounded-full px-2.5 py-1 text-xs font-medium data-[state=active]:bg-foreground/10 data-[state=active]:shadow-none"
>
```

Removes `data-[state=active]:bg-amber-500/20 data-[state=active]:text-amber-700 dark:data-[state=active]:text-amber-300`.

### 4.9 Submitted State

**Current:**

```tsx
<div className="my-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm">
  <Check className="text-emerald-500" />
  <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{q.header}</span>
  <p className="text-sm text-emerald-600 dark:text-emerald-400">{displayValue}</p>
</div>
```

**New:**

```tsx
<div
  className={cn(
    'rounded-msg-tool my-1 border px-3 py-2 text-sm transition-colors duration-200',
    questionState({ state: 'answered' })
  )}
>
  <Check className="text-status-success" />
  <span className="text-xs font-semibold">{q.header}</span>
  <p className="text-sm break-words">{displayValue}</p>
</div>
```

The `questionState({ state: 'answered' })` applies `border-status-success-border bg-status-success-bg text-status-success-fg`, which handles both light and dark mode through the design token system. Raw emerald values are eliminated.

Also uses `rounded-msg-tool` for consistency with other inline chat cards.

### 4.10 Accessibility Enhancements

**Options container — single-select:**

```tsx
<RadioGroup
  value={selections[qIdx] as string ?? ''}
  onValueChange={(value) => handleSingleSelect(qIdx, value)}
  aria-label={q.question}
  className="ml-1 space-y-0.5"
>
```

The shadcn `RadioGroup` renders with `role="radiogroup"` automatically via Radix.

**Options container — multi-select:**

```tsx
<div
  role="group"
  aria-label={q.question}
  className="ml-1 space-y-0.5"
>
```

**Keyboard navigation (existing behavior, now with proper ARIA):**

- Arrow up/down: Handled externally via `focusedOptionIndex` prop (unchanged)
- Number keys 1-9: Toggle option via imperative `toggleOption` (unchanged)
- Enter: Submit via imperative `submit` (unchanged)
- Left/right arrows: Navigate tabs in multi-question (unchanged)

The RadioGroup component from Radix provides built-in roving tabindex for arrow key navigation between radio items. For multi-select (checkbox group), the `focusedOptionIndex` prop continues to drive visual focus indication.

---

## 5. Space Budget

| Element                                    | Current                             | New                               | Savings               |
| ------------------------------------------ | ----------------------------------- | --------------------------------- | --------------------- |
| Header row (icon + text)                   | ~28px                               | Removed (0px)                     | 28px                  |
| Question text margin                       | `mb-2` (8px)                        | `mb-1.5` (6px)                    | 2px                   |
| Option vertical padding                    | `py-1.5` per option (6px each side) | `py-1` per option (4px each side) | 4px/option            |
| Option spacing                             | `space-y-1.5` (6px/gap)             | `space-y-0.5` (2px/gap)           | 4px/gap               |
| Description placement                      | Below label (+20px each)            | Inline after label                | 20px/option with desc |
| Navigate hint                              | ~24px                               | Removed                           | 24px                  |
| Submit button margin                       | `mt-3` (12px)                       | `mt-2` (8px)                      | 4px                   |
| **Total (4 options, 2 with descriptions)** | **~300px**                          | **~160px**                        | **~47% reduction**    |

---

## 6. Files Changed

### New Files

| File                                               | Purpose                            |
| -------------------------------------------------- | ---------------------------------- |
| `apps/client/src/layers/shared/ui/radio-group.tsx` | Shadcn RadioGroup + RadioGroupItem |
| `apps/client/src/layers/shared/ui/checkbox.tsx`    | Shadcn Checkbox                    |

### Modified Files

| File                                                                     | Changes                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| `apps/client/src/layers/shared/ui/index.ts`                              | Add RadioGroup, RadioGroupItem, Checkbox exports |
| `apps/client/src/layers/features/chat/ui/message/message-variants.ts`    | Add `questionState` TV variant                   |
| `apps/client/src/layers/features/chat/ui/QuestionPrompt.tsx`             | Full visual redesign (see section 4)             |
| `apps/client/src/layers/features/chat/__tests__/QuestionPrompt.test.tsx` | Update assertions for new markup                 |

### Potentially Modified Files

| File                                                 | Condition                                      |
| ---------------------------------------------------- | ---------------------------------------------- |
| `apps/client/src/dev/showcases/MessageShowcases.tsx` | If showcase markup references removed elements |
| `apps/client/src/dev/mock-chat-data.ts`              | Only if data shape changes (unlikely)          |

---

## 7. Test Impact

### Tests Requiring Updates

The existing test suite at `QuestionPrompt.test.tsx` (697 lines, 30+ test cases) will need these updates:

**Markup changes affecting queries:**

1. **`screen.getByText('Approach')` (header text)** — In pending state, the header row is removed. Tests asserting the header text is visible in pending mode must be updated. The header still appears in: tab triggers (multi-question), submitted summary.

2. **`screen.getAllByRole('radio')` / `screen.getAllByRole('checkbox')`** — Shadcn RadioGroupItem and Checkbox render differently from native inputs. RadioGroupItem renders a `<button role="radio">` (Radix pattern). Tests querying by role should still work, but the element type changes from `<input>` to `<button>`.

3. **`fireEvent.click(radio)` on RadioGroupItem** — Radix radio items respond to click events on the button, so `fireEvent.click` should still work. The `checked` property assertion may need updating since Radix uses `data-state="checked"` instead of `.checked`.

4. **Class name assertions** — Tests checking for `ring-amber-500/30`, `ring-amber-500/50`, and `emerald` classes must be updated to `ring-status-info/30`, `ring-status-info/50`, and `status-success` token classes respectively.

5. **Navigation hints test** — The test `'shows arrow navigation hints when isActive and multiple questions'` asserting `screen.getByText('navigate questions')` must be removed since the hint is deleted.

6. **Kbd mock** — If the Radix Tabs mock needs updating due to RadioGroup being from the same package family, the mock setup may need adjustment.

**Tests that should pass without changes:**

- Imperative handle tests (toggleOption, navigateQuestion, submit, getOptionCount, getActiveTab) — these test behavior, not markup
- Transport.submitAnswers call format tests — data format unchanged
- Multi-question tab switching tests — Tabs component unchanged
- Error display tests — error text rendering unchanged

### New Test Cases to Add

1. **Stale question opacity** — Verify `opacity-60` class when `isActive={false}` and not submitted
2. **RadioGroup ARIA** — Verify `role="radiogroup"` present on single-select options container
3. **Group ARIA** — Verify `role="group"` present on multi-select options container
4. **Status-info styling** — Verify pending container uses `border-status-info` class
5. **Status-success styling** — Verify submitted container uses `status-success` token classes (replaces the existing emerald class assertion)

---

## 8. Acceptance Criteria

1. QuestionPrompt uses neutral styling with `status-info` left border accent; no amber color values remain in the component
2. Header row (MessageSquare icon + bold text) is removed in both single and multi-question modes
3. Options use shadcn `RadioGroup`/`RadioGroupItem` (single-select) and `Checkbox` (multi-select) instead of native inputs
4. Option descriptions are inline with labels using `—` separator, not on separate lines
5. Vertical height is reduced by ~40-50% compared to current implementation (measurable via the space budget)
6. Submit button uses shared `Button` component with `size="sm"`
7. "Navigate questions" hint line is removed
8. Kbd number badges use `text-2xs text-muted-foreground` styling
9. Non-active pending questions render with `opacity-60`
10. Submitted state uses `questionState({ state: 'answered' })` with `status-success` design tokens
11. Single-select options container has `role="radiogroup"` (via RadioGroup)
12. Multi-select options container has `role="group"` with `aria-label`
13. Keyboard navigation works: number keys toggle options, Enter submits, left/right navigate tabs
14. All existing tests pass after updates for new markup
15. `RadioGroup` and `Checkbox` are exported from `layers/shared/ui/index.ts`
16. `questionState` TV variant exists in `message-variants.ts` with `pending` and `answered` states
17. Showcases render correctly with the new design
18. No raw color values (amber-_, emerald-_) remain in QuestionPrompt.tsx

---

## 9. Implementation Phases

### Phase 1: Foundation (~30 min)

**Install shared primitives:**

1. Run `npx shadcn@latest add radio-group checkbox` to install into `layers/shared/ui/`
2. Verify files created: `radio-group.tsx`, `checkbox.tsx`
3. Add exports to `layers/shared/ui/index.ts`
4. Verify TypeScript compilation

**Add TV variant:**

1. Add `questionState` to `message-variants.ts`
2. Verify import works from QuestionPrompt

### Phase 2: Core Redesign (~90 min)

**Rewrite QuestionPrompt.tsx:**

1. Replace container styling with `questionState` variant + `rounded-msg-tool`
2. Remove header row (`MessageSquare` icon + bold header) from `renderQuestionContent`
3. Remove `MessageSquare` import from lucide-react
4. Replace native `<input type="radio">` with `RadioGroup` + `RadioGroupItem`
5. Replace native `<input type="checkbox">` with `Checkbox`
6. Make option descriptions inline (same line as label, `—` separator)
7. Reduce option padding to `py-1`, container spacing to `space-y-0.5`
8. Update Kbd badge styling to `text-2xs text-muted-foreground`
9. Replace raw `<button>` submit with `<Button size="sm">`
10. Remove "navigate questions" hint block
11. Update tab trigger active state styling (remove amber)
12. Rewrite submitted state to use `questionState({ state: 'answered' })` + `status-success` tokens
13. Add `opacity-60` for non-active pending state
14. Replace all `amber-*` and `emerald-*` raw color references
15. Add `role="group"` + `aria-label` on multi-select options container
16. Update "Other" option styling to match new pattern

### Phase 3: Testing & Polish (~60 min)

**Update tests:**

1. Update class name assertions (amber -> status-info, emerald -> status-success)
2. Update RadioGroupItem element queries (Radix `<button role="radio">` vs native `<input type="radio">`)
3. Remove navigation hints test case
4. Add new test cases (stale opacity, ARIA roles, token classes)
5. Verify all 30+ existing test cases pass
6. Run full test suite: `pnpm vitest run apps/client/src/layers/features/chat/__tests__/QuestionPrompt.test.tsx`

**Verify showcases:**

1. Check `MessageShowcases.tsx` renders correctly
2. Visual check in dev playground for all states: pending, active, stale, submitted, multi-question, error

**Dark mode verification:**

1. Confirm design tokens render correctly in both light and dark themes
2. Verify `status-info` and `status-success` token contrast ratios meet AA standards

---

## 10. Risk Assessment

| Risk                                                                  | Likelihood | Impact | Mitigation                                                                                     |
| --------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------- |
| Radix RadioGroup API differs from native `<input>` in tests           | High       | Medium | Update test queries early; Radix uses `role="radio"` on `<button>`, so role queries still work |
| Shadcn RadioGroup/Checkbox installation conflicts                     | Low        | Low    | Standard shadcn install; check `components.json` config                                        |
| Stale question opacity breaks readability                             | Low        | Low    | `opacity-60` is visually distinct but still readable; test in both themes                      |
| Multi-select Checkbox doesn't integrate with existing selection state | Medium     | Medium | Checkbox `onCheckedChange` maps directly to `handleMultiSelect`; test thoroughly               |
| Existing downstream consumers of QuestionPrompt break                 | Low        | Low    | Only consumed by `AssistantMessageContent`; props unchanged                                    |

---

## 11. Design Reference

### Visual Comparison: ThinkingBlock (Pattern Source)

```
ThinkingBlock: bg-muted/50 rounded-msg-tool border-l-2 border-muted-foreground/20
QuestionPrompt: bg-muted/50 rounded-msg-tool border-l-2 border-status-info
```

Same base pattern, different left-border color to signal interactivity.

### Visual Comparison: ToolApproval (Sibling)

```
ToolApproval pending:  border-status-warning-border bg-status-warning-bg (amber wash)
ToolApproval approved: border-status-success-border bg-status-success-bg (green wash)
QuestionPrompt pending:  border-l-2 border-status-info bg-muted/50 (neutral + blue accent)
QuestionPrompt answered: border-status-success-border bg-status-success-bg (green wash)
```

ToolApproval uses full border + wash because it signals security-relevant decisions. QuestionPrompt uses left-border accent because it signals conversational questions.

### Token Reference

| Token                   | Light Mode       | Dark Mode        | Usage                        |
| ----------------------- | ---------------- | ---------------- | ---------------------------- |
| `status-info`           | Blue             | Blue             | Pending question left border |
| `status-info/30`        | Blue 30% opacity | Blue 30% opacity | Active question ring         |
| `status-success-border` | Green border     | Green border     | Answered question border     |
| `status-success-bg`     | Green background | Green background | Answered question background |
| `status-success-fg`     | Green text       | Green text       | Answered question text       |
| `bg-muted/50`           | Gray 50% opacity | Gray 50% opacity | Pending question background  |
| `text-muted-foreground` | Gray             | Gray             | Descriptions, Kbd badges     |

---

## Changelog

### 2026-03-16 - Post-Implementation Feedback #1

**Source:** Feedback #1 (see specs/question-prompt-redesign/05-feedback.md)

**Issue:** Submitted/final/approved states across QuestionPrompt, ToolApproval, and AssistantMessageContent are visually inconsistent with each other and with the ToolCallCard collapsed pattern. Missing shadows, inconsistent padding, mismatched transitions, and varying icon/layout treatment.

**Decision:** Implement comprehensive unification — all final/submitted/approved/denied states adopt ToolCallCard-like compact single-row pattern.

**Changes to Specification:**

- Section 4.9 (Submitted State): Replace multi-line layout with compact single-row pattern matching ToolCallCard: `shadow-msg-tool`, `py-1`, icon + label + value inline
- New Section: ToolApproval approved/denied state alignment — same compact row pattern, add status icon, use `shadow-msg-tool`
- New Section: ToolApproval pending state updates — align Button usage with QuestionPrompt (shared `Button` component)
- Update `questionState` and `approvalState` TV variants for the unified "completed" pattern

**Implementation Impact:**

- Priority: High
- Approach: ToolCallCard-like compact row — all final states become single-row with `shadow-msg-tool`, `py-1`, status icon + mono label + value/status
- Affected components: QuestionPrompt.tsx (submitted), ToolApproval.tsx (approved/denied/pending buttons), message-variants.ts (TV variants)
- Test impact: QuestionPrompt.test.tsx submitted state assertions, ToolApproval.test.tsx approved/denied assertions

**Next Steps:**

1. Update affected spec sections
2. Run `/spec:decompose specs/question-prompt-redesign/02-specification.md`
3. Run `/spec:execute specs/question-prompt-redesign/02-specification.md`
