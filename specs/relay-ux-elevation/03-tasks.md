# Task Breakdown: Relay UX Elevation

**Spec:** `specs/relay-ux-elevation/02-specification.md`
**Generated:** 2026-02-27
**Mode:** Full

---

## Phase 1: Foundation (Health Bar + Dead Letters + Trace Wiring + Metrics Mount)

Core infrastructure that provides the health narrative and surfaces orphaned components.

### 1.1 — Add listRelayDeadLetters to Transport interface and adapters
**Size:** Small | **Priority:** High | **Dependencies:** None

Add `listRelayDeadLetters(filters?)` to the `Transport` interface in `packages/shared/src/transport.ts`, then implement in `HttpTransport` (calls `GET /api/relay/dead-letters`) and `DirectTransport` (returns empty array stub). The server endpoint already exists in `routes/relay.ts`.

**Files:** `packages/shared/src/transport.ts`, `apps/client/src/layers/shared/lib/http-transport.ts`, `apps/client/src/layers/shared/lib/direct-transport.ts`

---

### 1.2 — Create useDeadLetters entity hook
**Size:** Small | **Priority:** High | **Dependencies:** 1.1

New TanStack Query hook at `entities/relay/model/use-dead-letters.ts` with query key `['relay', 'dead-letters']`, 30-second polling interval, and `enabled` feature gate. Exported from `entities/relay/index.ts` barrel. Includes unit tests for enabled/disabled states.

**Files:** `apps/client/src/layers/entities/relay/model/use-dead-letters.ts`, `apps/client/src/layers/entities/relay/index.ts`, `apps/client/src/layers/entities/relay/__tests__/use-dead-letters.test.ts`

---

### 1.3 — Create RelayHealthBar component
**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Compact health summary bar following the `MeshStatsHeader` pattern. Shows adapter connectivity ("3/3 connected" with green/amber dot), message throughput ("142 today"), failure count (red, clickable to scroll to dead letters), and average latency. Includes a BarChart3 icon button that opens a Sheet containing the existing `DeliveryMetricsDashboard` component (which is currently orphaned).

**Files:** `apps/client/src/layers/features/relay/ui/RelayHealthBar.tsx`, `apps/client/src/layers/features/relay/__tests__/RelayHealthBar.test.tsx`

---

### 1.4 — Create DeadLetterSection component
**Size:** Medium | **Priority:** High | **Dependencies:** 1.2

Collapsible section at top of ActivityFeed showing failed messages. Hidden when count is 0. Header shows "Failed Messages" with red badge count. Each entry displays subject (monospace), from, timestamp, and rejection reason as colored badges (hop_limit=amber, ttl_expired=orange, cycle_detected=red, budget_exhausted=purple). Red 2px left border accent on rows.

**Files:** `apps/client/src/layers/features/relay/ui/DeadLetterSection.tsx`, `apps/client/src/layers/features/relay/__tests__/DeadLetterSection.test.tsx`

---

### 1.5 — Wire MessageTrace into MessageRow with expand/collapse
**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1, 1.2

Connect the existing `MessageTrace` component to `MessageRow`. Add Activity icon button in expanded message view. Clicking toggles inline `MessageTrace` below the message. Only fetches trace data when expanded (lazy loading). Changes MessageRow outer element from `<button>` to `<div>` with nested interactive elements.

**Files:** `apps/client/src/layers/features/relay/ui/MessageRow.tsx`

---

### 1.6 — Update RelayPanel layout with health bar and dead letters
**Size:** Medium | **Priority:** High | **Dependencies:** 1.3, 1.4

Integration task. Mount `RelayHealthBar` above `<Tabs>` in `RelayPanel`. Change tabs from uncontrolled (`defaultValue`) to controlled (`value/onValueChange`) to support programmatic tab switching. Pass `deadLetterRef` to `ActivityFeed` for scroll-to-dead-letters. Add `DeadLetterSection` import to `ActivityFeed`. Wire `onFailedClick` from health bar to switch tab + scroll.

**Files:** `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`, `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`

---

## Phase 2: Motion + Visual Polish

Animations and visual consistency, matching the Mesh and Pulse panel polish.

### 2.1 — Add motion animations to ActivityFeed message list
**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.6 | **Parallel with:** 2.2, 2.3

New SSE-delivered messages animate in (`opacity: 0, y: 8 -> opacity: 1, y: 0`, 200ms). History messages on initial load do NOT animate (tracked via `initialIdsRef`). Filtered-out messages exit with height/opacity animation. Uses `AnimatePresence mode="popLayout"`. Motion mocked in tests.

**Files:** `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`

---

### 2.2 — Add motion to MessageRow expand/collapse and tab transitions
**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.5, 1.6 | **Parallel with:** 2.1, 2.3

Smooth height + opacity animation on MessageRow expand/collapse and trace expand/collapse using `AnimatePresence initial={false}`. Subtle fade transitions (150ms) on RelayPanel tab content. Cross-fade (200ms) between AdapterSetupWizard steps. Card hover depth with `hover:shadow-sm transition-shadow`.

**Files:** `apps/client/src/layers/features/relay/ui/MessageRow.tsx`, `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`, `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`

---

### 2.3 — Apply unified status color system and visual refinements
**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.5, 1.6 | **Parallel with:** 2.1, 2.2

Create shared `features/relay/lib/status-colors.ts` with dot/text/border color maps for all states (healthy, pending, degraded, failed, inactive). Replace AdapterCard status dot with 2px colored left border. Add "System" badge for built-in adapters. Add red left border to failed MessageRow entries. Enhanced remove confirmation dialog. All cards get `hover:shadow-sm transition-shadow`.

**Files:** `apps/client/src/layers/features/relay/lib/status-colors.ts`, `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`, `apps/client/src/layers/features/relay/ui/MessageRow.tsx`

---

## Phase 3: Interactivity + UX

User-facing features and onboarding flows.

### 3.1 — Create ConnectionStatusBanner and useRelayConnection hook
**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.6 | **Parallel with:** 3.2, 3.3

Refactor `useRelayEventStream` to return `{ connectionState, failedAttempts }`. Track state transitions via `EventSource.onopen` (connected) and `onerror` (reconnecting, then disconnected after 3 failures). New `ConnectionStatusBanner` component: hidden when connected, amber when reconnecting, red after 3+ failures. Positioned between health bar and tabs.

**Files:** `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`, `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx`, `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`, `apps/client/src/layers/features/relay/__tests__/ConnectionStatusBanner.test.tsx`

---

### 3.2 — Enhance ActivityFeed filters with status, subject, and content preview
**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.1 | **Parallel with:** 3.1, 3.3

Replace single source dropdown with three filters: Source (dropdown), Status (All/Delivered/Failed/Pending), Subject (text input with case-insensitive substring match). Horizontal flex-wrap layout with gap-2. "Clear filters" button when any filter is active. Add content preview (first ~80 chars of payload) to collapsed MessageRow using `extractPreview()` helper that tries common content fields before falling back to JSON. All filtering is client-side.

**Files:** `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`, `apps/client/src/layers/features/relay/ui/MessageRow.tsx`

---

### 3.3 — Create ComposeMessageDialog for test messaging
**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.6 | **Parallel with:** 3.1, 3.2

Dialog triggered by Compose button (PenLine icon) in Activity tab. Three fields: Subject (required), From (required, default: `relay.human.console`), Payload (textarea, JSON or plain text). Uses existing `useSendRelayMessage()` mutation. Success: toast + close + reset. Error: inline error message. Loading state with spinner. Surfaces the previously un-used `useSendRelayMessage` hook.

**Files:** `apps/client/src/layers/features/relay/ui/ComposeMessageDialog.tsx`, `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`, `apps/client/src/layers/features/relay/__tests__/ComposeMessageDialog.test.tsx`

---

### 3.4 — Implement onboarding empty states with contextual CTAs
**Size:** Small | **Priority:** Medium | **Dependencies:** 3.2 | **Parallel with:** 3.5

Replace generic empty states: Activity (no filters) gets "Set up an adapter" CTA that switches to Adapters tab. Activity (with filters) gets "Clear filters" button. Endpoints gets updated text about automatic creation. Adapters configured section directs to available adapters below. EndpointList icon changed from `Radio` to `Inbox`. All empty states use centered layout with icon + heading + description + optional CTA.

**Files:** `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`, `apps/client/src/layers/features/relay/ui/EndpointList.tsx`, `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`

---

### 3.5 — Enhance EndpointList with health indicators and card layout
**Size:** Small | **Priority:** Low | **Dependencies:** 2.3 | **Parallel with:** 3.4

Upgrade EndpointList from bare subject strings to informative cards: health dot (using shared `getStatusDotColor()`), subject in monospace font-medium, last activity timestamp (relative time), message count in/out if available, description text. `hover:shadow-sm transition-shadow` on cards. Graceful degradation when health data is unavailable from server.

**Files:** `apps/client/src/layers/features/relay/ui/EndpointList.tsx`

---

### 3.6 — Update barrel exports and CLAUDE.md documentation
**Size:** Small | **Priority:** Low | **Dependencies:** 3.1, 3.3, 3.4, 3.5

Final integration task. Ensure all new components (RelayHealthBar, DeadLetterSection, ConnectionStatusBanner, ComposeMessageDialog) are exported from `features/relay/index.ts`. Export `useDeadLetters` and `RelayConnectionState` type from `entities/relay/index.ts`. Update CLAUDE.md FSD Layers table with new component and hook names.

**Files:** `apps/client/src/layers/features/relay/index.ts`, `apps/client/src/layers/entities/relay/index.ts`, `CLAUDE.md`

---

## Dependency Graph

```
Phase 1 (Foundation):
  1.1 ─┬─> 1.2 ──> 1.4 ─┐
       └─> 1.3 ──────────┼─> 1.6
  1.5 ────────────────────┘

Phase 2 (Motion + Visual):
  1.6 ──> 2.1 ─┐
  1.5 + 1.6 ──> 2.2 ├─ (parallel)
  1.5 + 1.6 ──> 2.3 ─┘

Phase 3 (Interactivity):
  1.6 ──> 3.1 ─┐
  2.1 ──> 3.2 ─┼─ (parallel)
  1.6 ──> 3.3 ─┘
  3.2 ──> 3.4 ─┐
  2.3 ──> 3.5 ─┼─ (parallel)
               └──> 3.6 (final)
```

## Summary

| Phase | Tasks | Parallel Groups |
|-------|-------|----------------|
| P1: Foundation | 6 tasks | 1.5 runs parallel with 1.1-1.2 |
| P2: Motion + Visual | 3 tasks | All 3 can run in parallel |
| P3: Interactivity | 6 tasks | 3.1/3.2/3.3 parallel, 3.4/3.5 parallel |
| **Total** | **15 tasks** | |
