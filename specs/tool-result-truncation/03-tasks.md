# Task Breakdown: Tool Result Truncation

Generated: 2026-03-16
Source: specs/tool-result-truncation/02-specification.md
Last Decompose: 2026-03-16

## Overview

Large tool results (100KB+ from Bash output, file reads, grep results) render fully in the DOM as a raw `<pre>` tag, causing browser freezes. This feature adds character-based truncation at 5KB with a "Show more" button. The existing `ProgressOutput` truncation pattern is extracted into a shared `TruncatedOutput` component and applied to both tool results and the raw JSON fallback path in `ToolArgumentsDisplay`. This is a client-only change.

## Phase 1: Foundation

### Task 1.1: Extract TruncatedOutput component and apply to tool results

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- Rename `PROGRESS_TRUNCATE_BYTES` to `TRUNCATE_THRESHOLD` (single constant, 5120)
- Rename `ProgressOutput` to `TruncatedOutput` with generalized props: `content` (required), `threshold` (optional, defaults to `TRUNCATE_THRESHOLD`), `className` (optional)
- Replace the raw `<pre>` result block with `<TruncatedOutput content={toolCall.result} />`
- `TruncatedOutput` is NOT exported (private to the file)
- One-way expand: clicking "Show full output" expands, no collapse

**Implementation Steps**:

1. Rename `PROGRESS_TRUNCATE_BYTES` constant to `TRUNCATE_THRESHOLD`, update JSDoc
2. Replace `ProgressOutput` with `TruncatedOutput`, add `TruncatedOutputProps` interface
3. Replace the raw `<pre>` result block (lines 100-104) with `<TruncatedOutput>`
4. Update the progress output usage from `<ProgressOutput>` to `<TruncatedOutput>`

**Acceptance Criteria**:

- [ ] `PROGRESS_TRUNCATE_BYTES` renamed to `TRUNCATE_THRESHOLD`
- [ ] `ProgressOutput` renamed to `TruncatedOutput` with generalized props
- [ ] Raw `<pre>` result block replaced with `<TruncatedOutput>`
- [ ] Tool results under 5KB render fully (no button)
- [ ] Tool results over 5KB show truncated content with "Show full output (X.XKB)" button
- [ ] Clicking "Show full output" expands to full content (one-way)
- [ ] Existing auto-expand and expand/collapse behavior unaffected
- [ ] No new dependencies added

---

### Task 1.2: Add inline truncation to tool-arguments-formatter fallback paths

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- Truncate at 5120 characters with Unicode ellipsis (`\u2026`) on both raw JSON fallback paths
- Inline implementation (no import from features layer — FSD rules)
- Two locations: JSON parse failure (line 82) and non-object parsed result (line 86)

**Implementation Steps**:

1. At the JSON parse catch block (line 82), add `const displayInput = input.length > 5120 ? input.slice(0, 5120) + '\u2026' : input;` and use `displayInput` in the `<pre>`
2. At the non-object check (line 86), add the same truncation logic

**Acceptance Criteria**:

- [ ] JSON parse failure path truncates at 5120 chars with ellipsis
- [ ] Non-object parsed result path truncates at 5120 chars with ellipsis
- [ ] Input under 5120 characters renders fully
- [ ] No new imports added
- [ ] No FSD layer violations

---

## Phase 2: Testing

### Task 2.1: Add unit tests for TruncatedOutput in ToolCallCard

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- New test file: `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx`
- jsdom vitest environment
- 5 test cases covering: short result, long result truncated, expand button, long progress truncated, short progress

**Test Cases**:

1. Short result renders fully without show-more button
2. Long result (6000 chars) truncated to 5120 with "Show full output (5.9KB)" button
3. Clicking expand button shows full content and hides button (one-way)
4. Progress output over 5KB is truncated with button
5. Short progress output renders fully without button

**Acceptance Criteria**:

- [ ] All 5 test cases pass
- [ ] Tests use `@testing-library/react` with `userEvent`
- [ ] Tests validate content length, button presence/absence, button text
- [ ] No arbitrary timeouts

---

### Task 2.2: Add unit tests for tool-arguments-formatter truncation

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- New test file: `apps/client/src/layers/shared/lib/__tests__/tool-arguments-formatter.test.tsx`
- jsdom vitest environment
- 4 test cases covering: short invalid JSON, long invalid JSON truncated, non-object JSON truncated, valid object JSON regression

**Test Cases**:

1. Short invalid JSON renders fully
2. Invalid JSON over 5KB truncated with ellipsis (5121 chars total)
3. Non-object parsed JSON over 5KB truncated with ellipsis
4. Valid object JSON still renders as key-value grid (regression test)

**Acceptance Criteria**:

- [ ] All 4 test cases pass
- [ ] Tests validate truncation at 5120 chars with ellipsis character
- [ ] Regression test confirms valid JSON still uses structured display
