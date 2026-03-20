---
title: 'Interactive Card Focus Navigation — Keyboard & Focus Management for QuestionPrompt and ToolApproval'
date: 2026-03-17
type: external-best-practices
status: active
tags:
  [
    focus-management,
    keyboard-navigation,
    aria,
    wai-aria,
    roving-tabindex,
    aria-activedescendant,
    focus-trap,
    focus-scope,
    react-19,
    interactive-card,
    question-prompt,
    tool-approval,
    chat-ui,
  ]
feature_slug: interactive-card-focus-navigation
searches_performed: 16
sources_count: 34
---

# Interactive Card Focus Navigation — Keyboard & Focus Management

## Research Summary

The DorkOS `QuestionPrompt` and `ToolApproval` components already have a solid keyboard shortcut foundation: a global `document` keydown listener (`useInteractiveShortcuts`) delegates to whichever interactive card is currently "active" via an imperative handle pattern. The missing pieces are: (1) automatic scroll-and-visual-focus acquisition when a card appears in the stream, (2) focus restoration to the chat input when a card is dismissed, and (3) proper DOM-level focus management within the card so keyboard navigation is visible and accessible to assistive technologies. The WAI-ARIA recommendation for this pattern is **roving tabindex** (not `aria-activedescendant`) because the options must scroll into view. The correct ARIA role for the option list is `role="radiogroup"` / `role="radio"` for single-select and `role="group"` with `role="checkbox"` for multi-select — both already partially present. The `<kbd>` shortcut hints should appear **after** the option label text, not before, to match WCAG accessible name ordering and real-world convention in Linear and VS Code.

---

## Key Findings

### 1. Roving Tabindex is Correct for This Use Case

**WAI-ARIA APG distinguishes two approaches:**

| Approach                  | Focus location                                                                         | Key benefit                                            | Key drawback                                                |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| **Roving tabindex**       | Actual DOM focus moves to each option element                                          | User agent auto-scrolls into view; standard AT support | Requires `tabIndex` mutation on each option                 |
| **aria-activedescendant** | DOM focus stays on container; `aria-activedescendant` attribute points to active child | No tabIndex manipulation                               | Does NOT auto-scroll; requires container to be in tab order |

**For `QuestionPrompt`, roving tabindex is the right choice** because:

- Options can overflow a viewport in long question prompts — auto-scroll on focus is essential
- `aria-activedescendant` requires the container to hold DOM focus and have a focusable container element — this conflicts with the current architecture where `isActive` + a global keyboard listener manages "logical focus"
- Screen readers (NVDA, JAWS, VoiceOver) have historically had better support for roving tabindex than `aria-activedescendant` in dynamically generated lists

**For `ToolApproval`**, there are only two actionable elements (Approve/Deny buttons) — roving tabindex is not needed since the existing `Enter`/`Escape` shortcuts cover both actions without arrow key navigation between them.

**Citation:** "One benefit of using roving tabindex rather than aria-activedescendant to manage focus is that the user agent will scroll the newly focused element into view." — [WAI-ARIA APG: Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)

---

### 2. Correct ARIA Roles for the Options

The radio group pattern from WAI-ARIA APG specifies:

**Single-select (radio):**

```html
<div role="radiogroup" aria-labelledby="question-label-id">
  <div role="radio" aria-checked="false" tabindex="-1">Option A</div>
  <div role="radio" aria-checked="true" tabindex="0">Option B</div>
  <div role="radio" aria-checked="false" tabindex="-1">Option C</div>
</div>
```

**Multi-select (checkbox group):**

```html
<div role="group" aria-labelledby="question-label-id">
  <div role="checkbox" aria-checked="true" tabindex="0">Option A</div>
  <div role="checkbox" aria-checked="false" tabindex="-1">Option B</div>
</div>
```

The DorkOS `QuestionPrompt` currently uses Radix UI `RadioGroup` / `RadioGroupItem` for single-select (correct), and a plain `<div role="group">` with Radix `Checkbox` for multi-select (correct). However, the **visual focus indicator** (the `isFocused` prop on `OptionRow`) is purely cosmetic CSS — it does not move actual DOM focus. This means screen reader users have no way to know which option is "keyboard focused" in the current implementation.

**Keyboard interaction spec from WAI-ARIA APG (radio group):**

- `Tab` / `Shift+Tab`: Enter or exit the group; focus goes to the checked option (or first if none checked)
- `ArrowDown` / `ArrowRight`: Move to next option, check it (single-select) or just move focus (multi-select)
- `ArrowUp` / `ArrowLeft`: Move to previous option, wrap around
- `Space`: Check the focused option (for multi-select, toggle it)
- `1`–`9`: DorkOS custom extension — not in WAI-ARIA spec, fine to add as progressive enhancement

**Citation:** [Radio Group Pattern — APG | WAI | W3C](https://www.w3.org/WAI/ARIA/apg/patterns/radio/)

---

### 3. Automatic Focus Acquisition When Card Appears

When a new `QuestionPrompt` or `ToolApproval` card appears in the stream, the card should immediately become the active keyboard target. The pattern has two sub-concerns:

**A. Logical activation (already exists)**
`useToolShortcuts` tracks the last pending interactive tool call by `toolCallId` and marks it as `isActive`. This already works.

**B. Visual scroll-into-view + DOM focus (missing)**
The card should scroll into view when it becomes active. `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` is the right call. This should be triggered in a `useEffect` when `isActive` transitions from `false` to `true`.

For `QuestionPrompt`, when it becomes active, the first option in the currently visible question should also receive DOM focus (via roving tabindex). This replaces the purely cosmetic `isFocused` highlight.

```tsx
// In QuestionPrompt or a wrapper
const cardRef = useRef<HTMLDivElement>(null);
const firstOptionRef = useRef<HTMLElement>(null);

useEffect(() => {
  if (!isActive) return;
  // Scroll card into view
  cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // Move DOM focus to first option after scroll
  requestAnimationFrame(() => {
    firstOptionRef.current?.focus();
  });
}, [isActive]);
```

`requestAnimationFrame` defers the `.focus()` call until after the scroll animation starts, avoiding a jarring focus jump before the element is visible.

**React 19 note:** In React 19, `flushSync` from `react-dom` can also be used to synchronously commit state before DOM operations when timing is critical. For smooth scroll + focus, `requestAnimationFrame` is sufficient and avoids the overhead of `flushSync`.

---

### 4. Focus Restoration on Card Dismissal

**The pattern:** Save `document.activeElement` before activating the card; restore focus to that element when the card is decided/dismissed.

**Why a focus stack is better than a single saved ref:**

React Aria's `FocusScope` (Adobe's production implementation used by Radix UI, Headless UI, etc.) uses an internal focus stack. When a new scope mounts, it pushes `document.activeElement` onto the stack. When the scope unmounts, it pops the stack and focuses the top element. If that element is no longer in the DOM (e.g., the message was scrolled away), it moves to the next item in the stack.

For DorkOS, a simplified single-element save is sufficient because the chat input (`<textarea>`) is always in the DOM:

```tsx
// In useToolShortcuts or useInteractiveShortcuts
const previousFocusRef = useRef<HTMLElement | null>(null);

// When a new interaction becomes active:
useEffect(() => {
  if (activeInteraction) {
    previousFocusRef.current = document.activeElement as HTMLElement;
  } else {
    // Interaction ended — restore focus
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
  }
}, [activeInteraction?.toolCallId]);
```

**When to NOT restore focus:** If the user dismissed the card by clicking something else (e.g., typed in the chat input), `document.activeElement` has already moved — restoring focus would be disruptive. Add a guard: only restore if `document.activeElement` is still inside the card or is `document.body` (default when focus leaves without landing anywhere specific).

**React Aria FocusScope API (reference for production-grade implementation):**

```tsx
import { FocusScope } from '@react-aria/focus';

<FocusScope autoFocus restoreFocus contain={false}>
  {/* Card content */}
</FocusScope>;
```

- `autoFocus`: Focuses the first focusable element on mount
- `restoreFocus`: Returns focus to the element that had it before the scope mounted
- `contain={false}`: Does NOT trap focus (soft scope, not hard trap) — correct for inline chat elements

**Citation:** [FocusScope — React Aria](https://react-aria.adobe.com/FocusScope)

---

### 5. Focus Trap vs. Focus Scope — The Right Call for Inline Cards

**Full focus trap (WRONG for this use case):**
A full focus trap (`focus-trap-react`, Radix `Dialog`, etc.) prevents `Tab`/`Shift+Tab` from leaving the trapped element. This is correct for **modal dialogs** but wrong for inline chat cards because:

- The user may want to Tab to other parts of the UI (sidebar, other messages)
- Multiple cards can be pending simultaneously — a trap would lock the user in the first one
- The DorkOS pattern uses a "logically active" card, not a UI-blocking overlay

**Soft focus scope (CORRECT):**
A focus scope that `autoFocus`es on mount and `restoreFocus`es on unmount, but does NOT `contain` focus. This is what React Aria's `FocusScope` with `contain={false}` does. The user can Tab out if they want to — the keyboard shortcuts (`1`–`9`, `ArrowUp/Down`, `Enter`, etc.) are global listeners that only fire when `activeInteraction` is set.

**The existing DorkOS approach is architecturally correct:** A global `document.addEventListener('keydown', ...)` that checks `activeInteraction` is a soft focus scope pattern in spirit. The missing piece is DOM-level focus for accessibility (roving tabindex) and scroll-into-view.

**Slack's approach for inline interactive messages:** Slack's Block Kit interactive messages (buttons, select menus, etc.) in the Slack web client do NOT trap focus. They use standard focusable elements that respond to Tab navigation. The keyboard shortcut layer is separate from DOM focus management. This matches DorkOS's architecture.

---

### 6. Kbd Hint Placement — After the Label

**Industry standard:** Keyboard shortcut hints (`<kbd>`) appear **after** the label text, right-aligned. This is the universal convention in Linear, VS Code, GitHub, Slack, and Discord.

**Why after, not before:**

- Screen readers compute "accessible name" left-to-right; putting `<kbd>` before the label would cause SR to announce "1 Option A" instead of "Option A, keyboard shortcut 1"
- The WAI-ARIA APG examples for keyboard shortcuts in menus always show shortcut hints right-aligned after the label
- WCAG accessible name computation: `aria-labelledby` / label text comes first; descriptive annotations (`aria-describedby`) come after

**Using `aria-keyshortcuts`:** The `aria-keyshortcuts` attribute on each option element tells AT about the keyboard shortcut programmatically, independent of the visual `<kbd>` element:

```tsx
<div
  role="radio"
  aria-checked={isSelected}
  aria-keyshortcuts={optionIndex < 9 ? String(optionIndex + 1) : undefined}
  tabIndex={isFocused ? 0 : -1}
>
  <span>{option.label}</span>
  {isActive && optionIndex < 9 && (
    <Kbd className="text-2xs text-muted-foreground ml-auto">{optionIndex + 1}</Kbd>
  )}
</div>
```

**Citation:** [ARIA: aria-keyshortcuts — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-keyshortcuts)

---

### 7. Textarea Interaction — Suppressing Arrow Keys Correctly

The current `useInteractiveShortcuts` suppresses ALL shortcuts (except `Enter`) when `isTextInput` is true. This is correct behavior, but the implementation could be more precise for `ArrowUp`/`ArrowDown` when the cursor is at the first/last line:

**The "exit textarea on boundary" pattern:**

```typescript
function isTextareaAtBoundary(target: HTMLTextAreaElement, direction: 'up' | 'down'): boolean {
  const { selectionStart, value } = target;
  if (direction === 'up') {
    // At first line if no newline before cursor
    return !value.substring(0, selectionStart ?? 0).includes('\n');
  }
  // At last line if no newline after cursor
  return !value.substring(selectionStart ?? 0).includes('\n');
}
```

With this, when the user presses `ArrowUp` in the "Other" textarea and the cursor is on the first line, focus can move back to the option row above (exiting the textarea). This matches how VS Code's multi-line input fields handle arrow-key boundary exit.

**However:** The current DorkOS implementation — suppress arrows in textarea entirely — is simpler and acceptable UX. Most users will press `Tab` or click to exit a textarea. The boundary-exit pattern adds complexity for marginal UX benefit. **Recommendation: keep the current simpler approach**, but document why the arrows are suppressed.

---

### 8. React 19 ref-as-prop

**Relevant to `QuestionPrompt`:** The component currently uses `forwardRef<QuestionPromptHandle, QuestionPromptProps>()`. In React 19, this can be simplified to pass `ref` as a regular prop:

```tsx
// React 19 pattern (no forwardRef wrapper needed)
interface QuestionPromptProps {
  // ...
  ref?: React.Ref<QuestionPromptHandle>;
}

export function QuestionPrompt({ ref, ...props }: QuestionPromptProps) {
  useImperativeHandle(
    ref,
    () => ({
      /* ... */
    }),
    []
  );
  // ...
}
```

`ToolApproval` already uses this React 19 pattern (`ref?: React.Ref<ToolApprovalHandle>` as a direct prop). `QuestionPrompt` still uses `forwardRef` and should be migrated for consistency.

---

## Detailed Analysis

### Current Architecture Assessment

The existing keyboard shortcut system is architecturally sound:

```
ChatPanel
├── useToolShortcuts(activeInteraction)
│   ├── activeToolHandleRef (ref to imperative handle)
│   ├── focusedOptionIndex (tracked in state)
│   └── useInteractiveShortcuts(...)
│       └── document.addEventListener('keydown', handler)
│
├── MessageList → MessageItem → AssistantMessageContent
│   └── QuestionPrompt { ref={handleToolRef}, isActive, focusedOptionIndex }
│       └── OptionRow { isFocused } (CSS-only focus indicator)
```

**What works well:**

- Global keyboard listener with `activeInteraction` guard — correct "soft focus scope" pattern
- `isActive` prop on `InteractiveCard` shows visual ring
- `isFocused` on `OptionRow` shows visual highlight on the focused option
- `forwardRef` + `useImperativeHandle` pattern cleanly exposes `toggleOption`, `navigateOption`, `navigateQuestion`, `submit` without coupling parent to internal state

**What is missing:**

| Gap                                    | Impact                                                                                 | Fix                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No DOM focus on card appearance        | Screen readers can't know a card appeared; no auto-scroll                              | `scrollIntoView` + `cardRef.current?.focus()` or roving tabindex                          |
| `isFocused` is CSS-only, not DOM focus | AT users can't navigate with Tab; SR announces options in order, not the "focused" one | Switch to roving tabindex: `tabIndex={isFocused ? 0 : -1}` + `optionRef.current?.focus()` |
| No focus restoration on decide         | After Enter/Esc, focus stays wherever it was (or goes to `body`)                       | Save/restore `document.activeElement` in `useInteractiveShortcuts`                        |
| `QuestionPrompt` uses `forwardRef`     | Inconsistency with React 19 pattern used by `ToolApproval`                             | Migrate to `ref` as prop                                                                  |
| `aria-keyshortcuts` missing on options | AT users don't know about `1`–`9` shortcuts                                            | Add `aria-keyshortcuts="1"` etc. to each option                                           |

---

### Approach Comparison

#### Approach 1: Roving Tabindex (RECOMMENDED)

**How it works:** Each option element gets `tabIndex={isFocused ? 0 : -1}`. When `focusedOptionIndex` changes (via ArrowUp/Down or `1`–`9`), the corresponding option ref's `.focus()` is called.

**Integration with current system:**

- `focusedOptionIndex` is already tracked in `useToolShortcuts`
- `isFocused` is already passed to each `OptionRow`
- Only change needed: attach `optionRef` to each option element and call `.focus()` when `isFocused` becomes true

```tsx
// In OptionRow or each option in QuestionPrompt
const optionRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (isFocused && isActive) {
    optionRef.current?.focus();
  }
}, [isFocused, isActive]);

return (
  <div
    ref={optionRef}
    role="radio" // or "checkbox"
    aria-checked={isSelected}
    tabIndex={isActive ? (isFocused ? 0 : -1) : undefined}
    // ...
  />
);
```

**Pros:**

- Screen readers announce correctly as focus moves
- Browser auto-scrolls to focused option
- Integrates cleanly with existing `focusedOptionIndex` state
- WAI-ARIA recommended pattern for this widget type

**Cons:**

- Requires `tabIndex` mutation (minor DOM manipulation on each arrow key)
- Need to reset all to `-1` except the focused one when `focusedOptionIndex` changes

#### Approach 2: aria-activedescendant (NOT RECOMMENDED)

**How it would work:** The `RadioGroup` container has DOM focus + `aria-activedescendant="option-id-{focusedIndex}"`. Each option has a unique ID but no tabIndex.

**Problems for DorkOS:**

- The global keyboard listener approach works independently of DOM focus — adding `aria-activedescendant` would require the container to hold actual DOM focus, which conflicts with the "logical focus" architecture
- AT support for `aria-activedescendant` in dynamic lists is historically buggier than roving tabindex
- Does not auto-scroll to the active option

#### Approach 3: Full Focus Trap (WRONG for this use case)

As discussed in Finding #5, a full focus trap is incorrect for inline chat cards. Excluded.

#### Approach 4: Soft Focus Scope Only (CURRENT APPROACH)

**What this means:** Keep the current CSS-only `isFocused` highlight, no DOM focus change. The global keyboard listener handles all key events when `isActive`.

**Pros:**

- Simplest implementation
- Works for mouse/touch users

**Cons:**

- Inaccessible to screen reader users — they have no way to detect the card appeared or navigate its options
- No auto-scroll to focused option (must scroll manually)
- Does not meet WCAG 2.1 Level AA (keyboard access must be operable by AT)

**Verdict:** Approach 4 (current) is insufficient for accessibility. Approach 1 (roving tabindex) is the correct upgrade path.

---

### Recommended Implementation Plan

**Phase 1: Scroll-into-view on activation (low effort, high value)**

In `InteractiveCard` or each component:

```tsx
const cardRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (isActive) {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}, [isActive]);
```

This alone fixes the "card appears off-screen and user doesn't notice" problem.

**Phase 2: Focus restoration on decide (low effort)**

In `useInteractiveShortcuts`, save and restore `document.activeElement`:

```typescript
const previousFocusRef = useRef<HTMLElement | null>(null);

useEffect(() => {
  if (activeInteraction) {
    // Card became active — save current focus
    previousFocusRef.current = document.activeElement as HTMLElement | null;
  } else {
    // Card dismissed — restore focus if it went to body
    if (!document.activeElement || document.activeElement === document.body) {
      previousFocusRef.current?.focus();
    }
    previousFocusRef.current = null;
  }
}, [activeInteraction?.toolCallId]);
```

**Phase 3: Roving tabindex in QuestionPrompt (medium effort)**

Convert `isFocused` from a CSS-only prop to a DOM focus driver:

1. Add `optionRef` to each option element in `QuestionPrompt`
2. Assign `tabIndex={isActive ? (isFocused ? 0 : -1) : undefined}`
3. In a `useEffect` that watches `isFocused && isActive`, call `optionRef.current?.focus()`
4. Add `role="radio"` / `role="checkbox"` with `aria-checked` to each option div (Radix already handles this for `RadioGroupItem` / `Checkbox`, but the `OptionRow` wrapper needs its own role if it's the target of tabindex)
5. Add `aria-keyshortcuts` attribute to each option

**Phase 4: Migrate QuestionPrompt to React 19 ref-as-prop pattern**

Remove `forwardRef` wrapper, accept `ref` as a direct prop like `ToolApproval` already does.

---

### ARIA Role Clarification: RadioGroupItem vs. OptionRow

The current `QuestionPrompt` renders:

```
<RadioGroup>            → role="radiogroup"
  <OptionRow>           → plain <div> (no ARIA role)
    <RadioGroupItem />  → role="radio" aria-checked tabIndex (Radix manages this)
    <label>Option A <Kbd>1</Kbd></label>
  </OptionRow>
</RadioGroup>
```

The `RadioGroupItem` is the actual roving tabindex target in Radix's implementation — Radix already applies roving tabindex within the `RadioGroup`. However, the `Kbd` hint and the `focusedOptionIndex` visual state are on `OptionRow`, not on `RadioGroupItem`.

**The cleanest approach:** Let Radix's `RadioGroup` handle its own roving tabindex (as it already does when focused), and have `InteractiveCard` activation just call `.focus()` on the first `RadioGroupItem` when the card becomes active. This avoids duplicating Radix's tabindex management.

```tsx
// In QuestionPrompt — ref to the radio group container
const radioGroupRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!isActive) return;
  // Focus the first radio input inside the Radix RadioGroup
  const firstRadio = radioGroupRef.current?.querySelector<HTMLElement>(
    '[role="radio"]:not([disabled])'
  );
  firstRadio?.focus();
}, [isActive]);
```

This is the most idiomatic approach: let Radix handle its own keyboard navigation, and just give it initial focus when the card activates. Radix's `RadioGroup` already implements the full WAI-ARIA radio group keyboard pattern (Arrow keys navigate, Space checks, wrapping).

However, this creates a conflict: Radix's `RadioGroup` arrow key behavior (check on navigate) would compete with the global `useInteractiveShortcuts` handler. Solution: remove `ArrowUp`/`ArrowDown`/`Space` from the global handler when the focused element is inside a Radix RadioGroup (check `document.activeElement.closest('[role="radiogroup"]')`), and let Radix's native keyboard handling take over.

---

### Specific Answers to Research Questions

**Q1: Should `<kbd>` hints appear before or after the label?**

**After the label, right-aligned.** This is the universal convention (Linear, VS Code, GitHub command palette) and matches screen reader accessible name computation — the SR announces the option label first, then encounters the `<kbd>` as supplementary visual information. Use `aria-keyshortcuts="1"` on the element for AT, and the visible `<kbd>1</kbd>` for sighted users. Do not put `<kbd>` in the accessible name calculation path.

```tsx
<label htmlFor={optionId} className="flex w-full items-center justify-between">
  <span className="text-sm font-medium">{opt.label}</span>
  {isActive && oIdx < 9 && <Kbd className="text-2xs text-muted-foreground ml-auto">{oIdx + 1}</Kbd>}
</label>
```

**Q2: Focus restoration — save the ref or use a focus stack?**

**Save a single `previousFocusRef`** for DorkOS's current complexity. A focus stack is only needed when nested focus scopes can be active simultaneously (e.g., a modal inside a modal). DorkOS has at most one active interactive card at a time, so a single ref suffices. `document.activeElement` captured at the moment `activeInteraction` becomes truthy is the correct reference.

**Q3: How should textarea focus interact with arrow key navigation?**

**Current approach is correct:** suppress Arrow keys entirely in `isTextInput`. The `isTextInput` check already handles both `TEXTAREA` and `INPUT` (the "Other" textarea appears on selecting the Other option). The user exits the textarea by pressing `Enter` (submits), `Shift+Enter` (newline — already guarded with `!e.shiftKey`), or clicking elsewhere. Adding textarea boundary detection adds complexity for marginal UX gain. Keep the current suppression.

**Q4: Should the active card trap focus or just capture keyboard shortcuts globally?**

**Soft scope — no true trap.** The global listener with `activeInteraction` guard is correct. A true focus trap would prevent Tab navigation to the rest of the UI, which is wrong for inline chat elements. The existing architecture (global `keydown` listener + `isActive` guard) is the right pattern. The missing pieces are DOM focus for AT and scroll-into-view, not a focus trap.

---

## Code Patterns

### Pattern 1: Card activation with scroll + DOM focus

```tsx
// In InteractiveCard.tsx or each component
const cardRef = useRef<HTMLDivElement>(null);
const firstFocusableRef = useRef<HTMLElement | null>(null);

useEffect(() => {
  if (!isActive) return;
  // Scroll card into view without jarring jump
  cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // After scroll, focus the first interactive element
  requestAnimationFrame(() => {
    firstFocusableRef.current?.focus({ preventScroll: true });
  });
}, [isActive]);
```

### Pattern 2: Focus restoration on dismissal

```typescript
// In useInteractiveShortcuts
const previousFocusRef = useRef<HTMLElement | null>(null);

useEffect(() => {
  if (activeInteraction) {
    previousFocusRef.current = document.activeElement as HTMLElement;
    return;
  }
  // Restore only if focus went to body (not if user clicked elsewhere)
  const isOnBody = !document.activeElement || document.activeElement === document.body;
  if (isOnBody && previousFocusRef.current) {
    previousFocusRef.current.focus();
  }
  previousFocusRef.current = null;
}, [activeInteraction?.toolCallId]);
```

### Pattern 3: Radix RadioGroup with automatic initial focus

```tsx
// In QuestionPrompt — let Radix handle its own keyboard navigation
const radioGroupRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!isActive) return;
  // Give focus to the checked radio, or the first one if none checked
  const checked = radioGroupRef.current?.querySelector<HTMLElement>(
    '[role="radio"][aria-checked="true"]'
  );
  const first = radioGroupRef.current?.querySelector<HTMLElement>('[role="radio"]:not([disabled])');
  (checked ?? first)?.focus();
}, [isActive]);

// Remove ArrowUp/ArrowDown from global handler when focused inside radiogroup:
function handler(e: KeyboardEvent) {
  const isInRadioGroup = !!(e.target as HTMLElement).closest?.('[role="radiogroup"]');
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === ' ') && isInRadioGroup) {
    // Let Radix handle it natively
    return;
  }
  // ... rest of global handler
}
```

### Pattern 4: aria-keyshortcuts on options

```tsx
<RadioGroupItem
  value={opt.label}
  id={optionId}
  disabled={submitting}
  aria-keyshortcuts={isActive && oIdx < 9 ? String(oIdx + 1) : undefined}
/>
```

### Pattern 5: QuestionPrompt React 19 ref-as-prop migration

```tsx
// Before (forwardRef)
export const QuestionPrompt = forwardRef<QuestionPromptHandle, QuestionPromptProps>(
  function QuestionPrompt({ sessionId, ... }, ref) {
    useImperativeHandle(ref, () => ({ ... }), [...]);
  }
);

// After (React 19 ref-as-prop)
export function QuestionPrompt({
  sessionId,
  ...,
  ref,
}: QuestionPromptProps & { ref?: React.Ref<QuestionPromptHandle> }) {
  useImperativeHandle(ref, () => ({ ... }), [...]);
}
```

---

## Architecture Recommendation: Let Radix Handle Navigation

The cleanest architecture, given Radix UI is already managing the radio group and checkbox ARIA attributes, is a **two-layer system**:

**Layer 1 — Radix native keyboard (within the card):**

- Radix `RadioGroup` handles: `ArrowUp`/`ArrowDown`, `Space` (check), wrapping, `aria-checked`, roving tabindex — all per WAI-ARIA spec
- Radix `Checkbox` handles: `Space` to toggle, `aria-checked`
- DorkOS provides initial focus when the card becomes active (`scrollIntoView` + `focus()` on first radio/checkbox)

**Layer 2 — Global handler (cross-card navigation):**

- `Enter` → submit/approve
- `Escape` → deny (approval only)
- `1`–`9` → toggle option by number (unique DorkOS feature)
- `ArrowLeft`/`ArrowRight` (or `[`/`]`) → navigate between questions (tabs)
- Suppressed when focused in a `TEXTAREA`/`INPUT`
- **Deferred** for `ArrowUp`/`ArrowDown`/`Space` when focused inside `[role="radiogroup"]` (let Radix handle these)

This avoids duplicating Radix's keyboard management and keeps the global handler focused on features Radix doesn't cover (`1`–`9` shortcuts, cross-question navigation).

**Key guard to add to `useInteractiveShortcuts`:**

```typescript
function isInNativeWidget(target: HTMLElement): boolean {
  return !!(target.closest('[role="radiogroup"]') || target.closest('[role="group"]'));
}

// In handler:
const inNativeWidget = isInNativeWidget(target as HTMLElement);
if (inNativeWidget && ['ArrowUp', 'ArrowDown', ' '].includes(e.key)) {
  // Let Radix/browser handle these natively
  return;
}
```

---

## Sources & Evidence

- [Radio Group Pattern — APG | WAI | W3C](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) — Full keyboard interaction specification
- [Developing a Keyboard Interface — APG | WAI | W3C](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) — Roving tabindex vs aria-activedescendant, "last focused" memory pattern
- [Radio Group Example Using Roving tabindex — APG](https://www.w3.org/WAI/ARIA/apg/patterns/radio/examples/radio/) — Reference implementation
- [Radio Group Example Using aria-activedescendant — APG](https://www.w3.org/WAI/ARIA/apg/patterns/radio/examples/radio-activedescendant/) — Alternative approach comparison
- [FocusScope — React Aria](https://react-aria.adobe.com/FocusScope) — `autoFocus`, `restoreFocus`, `contain` props; `useFocusManager` hook for arrow key navigation
- [ARIA: aria-keyshortcuts — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-keyshortcuts) — Attribute syntax, visual hint placement guidance
- [Focus management in React with forwardRef and useImperativeHandle — antn.se](https://antn.se/focus-management-forwardref-useimperativehandle/) — Imperative focus patterns
- [Mastering Focus Management in React with flushSync — Epic React](https://www.epicreact.dev/mastering-focus-management-in-react-with-flush-sync-f5b38) — Timing issues with focus in React state updates
- [react-focus-lock — npm](https://www.npmjs.com/package/react-focus-lock) — Focus trap reference (for contrast with soft scope)
- [React 19: No More forwardRef — Medium](https://medium.com/@ozhanli/react-19-no-more-forwardref-refs-just-got-simpler-297c050ac71c) — ref-as-prop migration pattern
- [FocusScope fails to restore focus when element unmounted — GitHub](https://github.com/adobe/react-spectrum/issues/2444) — Known edge case in focus restoration
- [Restoring ActiveElement Focus After User Interaction — Ben Nadel](https://www.bennadel.com/blog/4097-restoring-activeelement-focus-after-a-user-interaction-in-javascript.htm) — Manual focus save/restore pattern
- [WAI-ARIA: Role=Radiogroup — DigitalA11Y](https://www.digitala11y.com/radiogroup-role/) — Role specification and AT support
- [Accessibility — Radix Primitives](https://www.radix-ui.com/primitives/docs/overview/accessibility) — How Radix handles roving focus
- [ARIA Keyboard Shortcuts — BOIA](https://www.boia.org/blog/aria-keyboard-shortcuts-what-to-know) — Guideline: don't override OS/browser shortcuts
- DorkOS codebase: `use-interactive-shortcuts.ts`, `QuestionPrompt.tsx`, `ToolApproval.tsx`, `use-tool-shortcuts.ts`, `InteractiveCard.tsx`

---

## Research Gaps & Limitations

- Radix UI `RadioGroup`'s exact internal implementation of roving tabindex was not audited — the recommendation to "let Radix handle its own keyboard navigation" assumes it implements the WAI-ARIA spec correctly, which is consistent with its documentation
- No user testing was conducted on DorkOS keyboard navigation — the recommendations are based on WAI-ARIA standards and industry patterns, not observed usage
- The `textarea` at-first-line detection pattern (using `selectionStart` + `\n` counting) was researched but not fully validated against browsers — the simpler "suppress all arrows in textarea" approach is recommended as more reliable
- GitHub Copilot Chat and Cursor's exact implementations of inline approval UX were not accessible for inspection (closed source)

---

## Contradictions & Disputes

- **Roving tabindex vs. aria-activedescendant:** Both are valid WAI-ARIA patterns; the APG explicitly offers both as examples for radio groups. The recommendation for roving tabindex is based on better AT support and the auto-scroll benefit — for a simple two-item layout like `ToolApproval`, either would work, but since `QuestionPrompt` can have many options, roving tabindex is the safer universal choice
- **Let Radix handle vs. global handler:** The two-layer approach has a coordination problem — the global handler must yield to Radix for some keys but intercept others. The `isInNativeWidget()` guard resolves this but adds coupling. Alternative: replace the global `document` listener entirely with `onKeyDown` handlers directly on the card components. This is more contained but conflicts with the current architecture where `useToolShortcuts` is at the `ChatPanel` level, far above the cards in the tree

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: "WAI-ARIA roving tabindex vs aria-activedescendant radio group", "React focus management forwardRef useImperativeHandle", "React Aria FocusScope restoreFocus autoFocus", "detect cursor position first last line textarea", "aria-keyshortcuts visual hint position label"
- Primary sources: W3C WAI-ARIA APG (authoritative), React Aria documentation (production reference implementation), MDN (attribute specifications), DorkOS codebase (existing implementation context)
