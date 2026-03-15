# Tasks: Relay Panel Redesign

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-03-15
**Mode:** Full

---

## Phase 1: P0 Bug Fixes

Four trust-destroying data bugs that must ship before or alongside the UI restructure. All tasks in this phase are independent and can be developed in parallel.

### Task 1.1 — Fix "today" label by adding date filter to TraceStore.getMetrics()

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.2, 1.3, 1.4

**Files:**
- `apps/server/src/services/relay/trace-store.ts` (modify)
- `apps/server/src/services/relay/__tests__/trace-store.test.ts` (modify)

Add optional `since` parameter to `getMetrics()` defaulting to 24 hours ago. Apply `WHERE sentAt >= sinceIso` to all three sub-queries (counts, latency, endpoint count). The `DeliveryMetrics` type does not change. Route handler continues to call `getMetrics()` with no arguments.

**Tests:** Verify spans older than 24h are excluded; verify custom `since` parameter is respected.

---

### Task 1.2 — Wire SSE events to conversations query cache

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1, 1.3, 1.4

**Files:**
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts` (modify)

Replace `queryClient.setQueryData(['relay', 'messages', undefined], ...)` with `queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] })` in both `relay_message` and `relay_delivery` event handlers. Keeps JSON.parse validation. Removes the polling-only behavior.

---

### Task 1.3 — Fix double toast on adapter add and extractAdapterId regex

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1, 1.2, 1.4

**Files:**
- `apps/client/src/layers/entities/relay/model/use-adapter-catalog.ts` (modify)
- `apps/client/src/layers/features/relay/ui/ConversationRow.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/__tests__/ConversationRow.test.tsx` (modify)

Remove `toast.success('Adapter added')` from `useAddAdapter` (wizard handles it). Fix `extractAdapterId` regex from `/^relay\.adapter\.([^.]+)/` to `/^relay\.human\.([^.]+)/`.

**Tests:** Verify `relay.human.telegram.12345` extracts `'telegram'`.

---

### Task 1.4 — Add binding permission fields to shared schema

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1, 1.2, 1.3

**Files:**
- `packages/shared/src/relay-adapter-schemas.ts` (modify)

Add `canInitiate: z.boolean().default(false)`, `canReply: z.boolean().default(true)`, `canReceive: z.boolean().default(true)` to `AdapterBindingSchema`. Backward-compatible — all defaults.

---

## Phase 2: Tab Restructure

### Task 2.1 — Restructure RelayPanel from 4 tabs to 2 tabs (Connections + Activity)

**Size:** Medium | **Priority:** High | **Dependencies:** None

**Files:**
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/ConnectionsTab.tsx` (create)
- `apps/client/src/layers/features/relay/index.ts` (modify)
- `apps/client/src/layers/features/relay/ui/EndpointList.tsx` (delete)
- `apps/client/src/layers/features/relay/ui/InboxView.tsx` (delete)
- `apps/client/src/layers/features/relay/ui/BindingList.tsx` (delete)
- `apps/client/src/layers/features/relay/ui/__tests__/EndpointList.test.tsx` (delete)
- `apps/client/src/layers/features/relay/ui/__tests__/BindingList.test.tsx` (delete)

Extract `AdaptersTab` to standalone `ConnectionsTab`. Remove imports for deleted components. Change default tab from `'activity'` to `'connections'`. Remove `selectedEndpoint` state and `onBindClick`.

---

## Phase 3: Health Bar Semantic Status

### Task 3.1 — Redesign RelayHealthBar with semantic status indicator

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1

**Files:**
- `apps/client/src/layers/features/relay/ui/RelayHealthBar.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/__tests__/RelayHealthBar.test.tsx` (modify)

Replace four raw-number stats with `computeHealthState()` function returning healthy/degraded/critical. Shows colored dot, human-readable message, optional latency. Preserves chart icon for DeliveryMetricsDashboard dialog.

**Tests:** Verify all threshold boundaries: healthy (<5% failure), degraded (5-50% or disconnected), critical (>50% or zero connected).

---

## Phase 4: Dead Letter Aggregation

### Task 4.1 — Add aggregated dead letters server endpoint

**Size:** Medium | **Priority:** Medium | **Dependencies:** None | **Parallel:** 4.2

**Files:**
- `apps/server/src/routes/relay.ts` (modify)

Add `GET /api/relay/dead-letters/aggregated` — groups dead letters by source + reason with count, firstSeen, lastSeen, sample. Add `DELETE /api/relay/dead-letters` — clears dead letters matching source + reason.

---

### Task 4.2 — Add client hook and redesign DeadLetterSection as aggregated failure cards

**Size:** Large | **Priority:** Medium | **Dependencies:** 4.1

**Files:**
- `apps/client/src/layers/entities/relay/model/use-dead-letters.ts` (modify)
- `apps/client/src/layers/features/relay/ui/DeadLetterSection.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/__tests__/DeadLetterSection.test.tsx` (modify)

Add `useAggregatedDeadLetters` hook. Redesign DeadLetterSection as aggregated cards with "View Sample" dialog and "Dismiss All" mutation. Move dead letters to Activity tab filter toggle with red dot indicator.

---

## Phase 5: Empty State Overhaul

### Task 5.1 — Wire Mode A/B and RelayEmptyState ghost preview

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.1

**Files:**
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx` (modify)

Mode A (no adapters): hide tabs/health bar, show full-bleed `RelayEmptyState`. Mode B: show tabbed interface. AnimatePresence crossfade between modes. Update RelayEmptyState copy. Add Activity tab empty state.

---

## Phase 6: Wizard Refinements

### Task 6.1 — Remove adapter ID field and refine wizard UX

**Size:** Medium | **Priority:** Medium | **Dependencies:** None

**Files:**
- `apps/client/src/layers/features/relay/ui/wizard/ConfigureStep.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/wizard/StepIndicator.tsx` (modify)

Auto-generate adapter IDs via `generateAdapterId()`. Redesign step indicator with circles/checkmarks/connectors. Add Back button (steps 2-4) and Cancel button (all steps) to dialog footer.

---

## Phase 7: Binding Permissions

### Task 7.1 — Enforce binding permissions server-side in BindingRouter

**Size:** Medium | **Priority:** High | **Dependencies:** 1.4 | **Parallel:** 7.2

**Files:**
- `apps/server/src/services/relay/binding-router.ts` (modify)
- `apps/server/src/services/relay/__tests__/binding-router.test.ts` (modify)

Add `canReceive` check after binding resolution (drop inbound if false). Add `canReply` check on outbound responses. Add `canInitiate` check on agent-initiated messages. All log with binding ID.

---

### Task 7.2 — Add permissions UI to BindingDialog and AdapterCard

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.4 | **Parallel:** 7.1

**Files:**
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx` (modify)
- `apps/client/src/layers/features/relay/ui/AdapterBindingRow.tsx` (modify)
- `apps/server/src/services/relay/binding-store.ts` (modify)

Collapsible "Advanced" section in BindingDialog with permission toggles and session strategy. Non-default permission indicators on binding rows. Hide default session badge ("Per Chat").

---

## Phase 8: Cleanup

### Task 8.1 — Auto-clean orphan bindings, remove legacy fields, and update specs manifest

**Size:** Medium | **Priority:** Low | **Dependencies:** 2.1, 7.1

**Files:**
- `apps/server/src/services/relay/adapter-manager.ts` (modify)
- `apps/server/src/services/relay/binding-store.ts` (modify)
- `apps/server/src/services/relay/__tests__/adapter-manager.test.ts` (modify)
- `apps/server/src/services/relay/__tests__/binding-store.test.ts` (modify)
- `specs/manifest.json` (modify)

Change `removeAdapter()` from warning about orphans to auto-deleting them. Remove legacy `projectPath`/`agentDir` stripping from `BindingStore.load()`. Update specs manifest for #68, #120, #132.

---

## Dependency Graph

```
Phase 1 (all parallel):
  1.1  Fix date filter
  1.2  Wire SSE
  1.3  Fix toast + regex
  1.4  Schema permissions
         |
         +---> 7.1 Server enforcement  (parallel with 7.2)
         +---> 7.2 Permissions UI      (parallel with 7.1)

Phase 2:
  2.1  Tab restructure
         |
         +---> 5.1 Empty states (depends on 2-tab structure)
         +---> 8.1 Cleanup      (depends on 2.1 + 7.1)

Phase 3:
  1.1 ---> 3.1 Health bar (depends on accurate metrics)

Phase 4:
  4.1  Server endpoint ---> 4.2 Client hook + UI

Phase 6:
  6.1  Wizard refinements (independent)
```

## Summary

| Metric | Count |
|--------|-------|
| Total tasks | 12 |
| Phases | 8 |
| High priority | 6 |
| Medium priority | 5 |
| Low priority | 1 |
| Small tasks | 4 |
| Medium tasks | 7 |
| Large tasks | 1 |
| Max parallel width | 4 (Phase 1) |
