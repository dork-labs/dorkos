# Feedback Log: QuestionPrompt Component Redesign

## Feedback #1

**Date:** 2026-03-16
**Status:** Implement now
**Type:** UX/UI
**Priority:** High

### Description

Review and update AssistantMessageContent final/submitted states, ToolApproval pending/approved/denied states, and QuestionPrompt submitted state. The final/completed/submitted states should look similar to ToolCallCard (but rethought as a compact single-row pattern).

### Code Exploration Findings

**Inconsistencies found across submitted/final states:**

| Aspect | ToolCallCard (ref) | QuestionPrompt answered | ToolApproval approved/denied |
|---|---|---|---|
| Shadow | `shadow-msg-tool` | Missing | Missing |
| Padding | `px-3 py-1` | `px-3 py-2` | `px-3 py-2` |
| Transition | `transition-all 150` | `transition-colors 200` | `transition-colors 200` |
| Icon | Status icon | `<Check>` icon | No icon |
| Layout | Single row, compact | Multi-line (header + value) | Inline (tool name + status) |

**Consistent foundations:** All share `rounded-msg-tool`, full `border`, semantic `status-*` tokens.

**Additional findings:**
- ToolApproval pending uses raw `<button>` elements instead of shared `Button` component
- ToolApproval approved/denied has no icon (inconsistent with QuestionPrompt answered)
- Padding varies: `py-1` vs `py-2` vs `p-3` across states

### Research Findings

Research skipped by user.

### Decisions

- **Action:** Implement now
- **Scope:** Comprehensive — unify all submitted/final/approved states
- **Approach:** ToolCallCard-like compact row — all final states become single-row with `shadow-msg-tool`, `py-1`, status icon + label + value
- **Priority:** High

### Actions Taken

- Added changelog entry to `specs/question-prompt-redesign/02-specification.md`
- Created this feedback log

---
