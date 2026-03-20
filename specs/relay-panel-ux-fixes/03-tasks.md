# Relay Panel UX Fixes -- Task Breakdown

**Spec:** `specs/relay-panel-ux-fixes/02-specification.md`
**Generated:** 2026-03-15
**Mode:** Full decomposition

---

## Phase 1: Critical Fixes (P0)

### Task 1.1 -- Add Binding CRUD to AdapterCard via BindingDialog Integration

**Size:** Large | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2, 1.3

Restore full binding CRUD (create, edit, delete) to AdapterCard by integrating the existing `BindingDialog` component. Currently AdapterCard only displays binding rows read-only -- users cannot add, edit, or delete bindings from the adapter card.

**Changes:**

- **AdapterCard.tsx:** Add binding dialog state (`bindingDialogOpen`, `bindingDialogMode`, `editingBinding`, `showAllBindings`), import mutation hooks (`useCreateBinding`, `useUpdateBinding`, `useDeleteBinding`), add "Add Binding" to kebab menu, wrap each binding row in a clickable button for edit mode, add "+" button after rows, make "and X more" clickable to expand/collapse, replace "No agent bound" amber text with "Add binding" CTA button, render BindingDialog at bottom of component
- **BindingDialog.tsx:** Extend with `onDelete?: (bindingId: string) => void` prop, add destructive "Delete" button with AlertDialog confirmation in footer when `mode === 'edit'`

**Tests:** AdapterCard.test.tsx -- CTA renders when connected/no bindings, click row opens edit mode, "+" opens create mode, "and X more" toggles, delete confirmation works

---

### Task 1.2 -- Fix Health Bar Click to Auto-Open Dead Letter Section

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1, 1.3

Fix the broken `handleFailedClick` in RelayPanel -- it sets `activeTab='activity'` and scrolls to `deadLetterRef`, but the `DeadLetterSection` only renders when `showFailures` is true (defaults to false). The scroll target doesn't exist in the DOM.

**Changes:**

- **ActivityFeed.tsx:** Add `autoShowFailures?: boolean` prop, add effect that sets `showFailures = true` when prop is true
- **RelayPanel.tsx:** Add `autoShowFailures` state, update `handleFailedClick` to set it (with reset after 100ms), defer scroll to 150ms, pass prop to ActivityFeed

**Tests:** ActivityFeed.test.tsx -- `autoShowFailures={true}` opens dead letter section

---

### Task 1.3 -- Investigate and Fix Activity Tab Data Consistency with Health Bar

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1, 1.2

Resolve the contradiction where the Activity tab shows no conversations while the health bar reports failures. Conversations are built from in-memory relay messages (lost on restart), while metrics may aggregate from persisted data.

**Changes:**

- **ActivityFeed.tsx:** Update empty state copy from "Waiting for messages" to "No activity yet" with description "Messages will appear here as your agents communicate". Remove the "Set up an adapter" CTA button (misleading when adapters are configured in Mode B). Keep ghost preview rows.

**Tests:** Empty state renders correct text, no "Set up an adapter" button in Mode B

---

## Phase 2: UX Improvements (P1)

### Task 2.1 -- Rename Failures Button to Dead Letters and Dialog Title to Connections

**Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel with:** 2.2, 2.3

Two labeling fixes to reduce user confusion.

**Changes:**

- **ActivityFeed.tsx:** Rename toggle button text "Failures" to "Dead Letters", update aria-label to "Show dead letters", adjust badge dot styling from absolute to inline
- **DialogHost.tsx:** Change dialog title from "Relay" to "Connections", update sr-only description to "Manage adapters and monitor message activity"

**Tests:** Text renders correctly in both locations

---

### Task 2.2 -- Move Delivery Metrics Inline to Activity Tab as MetricsSummary

**Size:** Medium | **Priority:** Medium | **Dependencies:** None | **Parallel with:** 2.1, 2.3

Remove the dialog-on-dialog pattern (BarChart3 icon -> DeliveryMetricsDashboard dialog on top of relay dialog). Replace with an inline MetricsSummary row at the top of the Activity tab.

**Changes:**

- **Create MetricsSummary.tsx:** Compact row showing Total, Delivered, Failed, Dead Letter counts with color-coded values, plus average latency. Uses `useDeliveryMetrics` hook.
- **ActivityFeed.tsx:** Import and render MetricsSummary above the filter bar
- **RelayHealthBar.tsx:** Remove `metricsOpen` state, BarChart3 icon button, Dialog components, and DeliveryMetricsDashboard import
- **DeliveryMetrics.tsx:** Delete file (no longer imported anywhere)
- **DeadLetterSection.tsx:** Add budget rejections display (moved from deleted DeliveryMetricsDashboard)

**Tests:** MetricsSummary.test.tsx -- pills render with correct values and colors, null when no metrics, latency formatting

---

### Task 2.3 -- Auto-Show Dead Letters When They Exist with User Override

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.2 | **Parallel with:** 2.1, 2.2

Dead letters are hidden by default behind a toggle. Auto-show them when they exist, but respect the user's explicit close action.

**Changes:**

- **ActivityFeed.tsx:** Add `userToggled` state, add effect that auto-opens section when dead letters arrive (unless user toggled), update toggle onClick to set `userToggled = true`, update badge to only show when user manually closed section, make `autoShowFailures` prop reset `userToggled`

**Tests:** Auto-show when dead letters arrive, user toggle prevents auto-show, badge logic, autoShowFailures resets state

---

## Phase 3: Polish (P2)

### Task 3.1 -- Add Dismiss Confirmation Dialog to DeadLetterSection

**Size:** Small | **Priority:** Low | **Dependencies:** None | **Parallel with:** 3.2

The "Dismiss All" button permanently removes dead letters with one click. Add confirmation and rename to "Mark Resolved".

**Changes:**

- **DeadLetterSection.tsx:** Wrap dismiss button in AlertDialog with confirmation showing count, source, and reason. Rename "Dismiss All" to "Mark Resolved". Change button color from destructive to muted-foreground.

**Tests:** DeadLetterSection.test.tsx -- dialog opens, cancel doesn't trigger mutation, confirm does

---

### Task 3.2 -- Show Existing Bindings in ConversationRow Route Popover

**Size:** Small | **Priority:** Low | **Dependencies:** None | **Parallel with:** 3.1

The route popover doesn't warn about existing bindings for the adapter, risking duplicates.

**Changes:**

- **ConversationRow.tsx:** Import `useBindings`, filter bindings by extracted adapter ID, show blue info note in popover with existing binding count before the agent selector

**Tests:** Info note renders with correct count/pluralization, doesn't render when no bindings match

---

## Summary

| Phase       | Tasks         | Sizes   | Can Parallelize              |
| ----------- | ------------- | ------- | ---------------------------- |
| P0 Critical | 1.1, 1.2, 1.3 | L, S, M | All three                    |
| P1 UX       | 2.1, 2.2, 2.3 | S, M, S | 2.1+2.2 (2.3 depends on 1.2) |
| P2 Polish   | 3.1, 3.2      | S, S    | Both                         |

**Note:** `BindingList.tsx` (mentioned in the spec as dead code to delete) does not exist in the codebase -- it was already removed. No action needed for that item.
