# Task Breakdown: Relay & Mesh Quality Improvements

Generated: 2026-03-11
Source: specs/relay-mesh-quality-improvements/02-specification.md
Last Decompose: 2026-03-11

## Overview

Five independent quality improvements to the Relay, Mesh, and Telegram adapter systems: (1) extract duplicated CATEGORY_COLORS constant, (2) fix adapter error message truncation UX, (3) add a binding list view, (4) split 5 oversized backend files, and (5) surface adapter lifecycle events in a per-adapter event log UI.

---

## Phase 1: Foundation

Low-risk extractions that provide immediate value with minimal blast radius.

### Task 1.1: Extract CATEGORY_COLORS to shared lib

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 1.2

Extract the duplicated `CATEGORY_COLORS` constant from `AdapterCard.tsx` and `CatalogCard.tsx` into `features/relay/lib/category-colors.ts`, following the existing `status-colors.ts` pattern. Both files import from the new shared lib and use `getCategoryColorClasses()` instead of direct map access.

**Files Changed**:

- `apps/client/src/layers/features/relay/lib/category-colors.ts` (new)
- `apps/client/src/layers/features/relay/lib/__tests__/category-colors.test.ts` (new)
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx` (modified)
- `apps/client/src/layers/features/relay/ui/CatalogCard.tsx` (modified)

**Acceptance Criteria**:

- [ ] `CATEGORY_COLORS` no longer exists in either component file
- [ ] Both components use `getCategoryColorClasses()` from the new lib
- [ ] Unit test covers all 4 categories + unknown fallback
- [ ] Existing tests pass without modification

---

### Task 1.2: Fix adapter error message truncation with Collapsible

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 1.1

Replace the truncated `max-w-[200px]` error div in `AdapterCard.tsx` with a Radix Collapsible component. Users see a truncated preview with a chevron; clicking expands to show the full error in a styled monospace block. Keyboard accessible via Radix's built-in aria management.

**Prerequisites**: Install shadcn Collapsible (`npx shadcn@latest add collapsible`).

**Files Changed**:

- `apps/client/src/layers/shared/ui/collapsible.tsx` (new, via shadcn CLI)
- `apps/client/src/layers/shared/ui/index.ts` (modified)
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx` (modified)
- `apps/client/src/layers/features/relay/__tests__/AdapterCard.test.tsx` (modified)

**Acceptance Criteria**:

- [ ] Error preview truncated by default with chevron indicator
- [ ] Click expands to full error in monospace red block
- [ ] `aria-expanded` toggles between true/false
- [ ] Enter/Space keys toggle the Collapsible
- [ ] No error display when `lastError` is null

---

## Phase 2: Binding List Feature

Structured list view for managing adapter-agent bindings with full CRUD support.

### Task 2.1: Add binding update support (store, route, transport, hook)

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: Task 1.1, 1.2

Full-stack binding update support: `BindingStore.update()` method, PATCH `/api/relay/bindings/:id` route with Zod validation, transport `updateBinding()` method, and `useUpdateBinding` TanStack Query mutation hook.

**Files Changed**:

- `apps/server/src/services/relay/binding-store.ts` (modified)
- `apps/server/src/routes/relay.ts` (modified)
- `apps/client/src/layers/shared/lib/transport/relay-methods.ts` (modified)
- `apps/client/src/layers/entities/binding/model/use-update-binding.ts` (new)
- `apps/client/src/layers/entities/binding/index.ts` (modified)
- `apps/server/src/services/relay/__tests__/binding-store.test.ts` (modified)
- `apps/client/src/layers/entities/binding/model/__tests__/use-update-binding.test.ts` (new)

**Acceptance Criteria**:

- [ ] `BindingStore.update()` updates only mutable fields and persists to disk
- [ ] PATCH route validates with Zod `.strict()`, returns 404/503 appropriately
- [ ] Transport unwraps response correctly
- [ ] Hook invalidates bindings query cache on success
- [ ] All tests pass

---

### Task 2.2: Build BindingList component and add Bindings tab to RelayPanel

**Size**: Large | **Priority**: High | **Dependencies**: Task 2.1 | **Parallel with**: None

Create `BindingList.tsx` in `features/relay/ui/` with binding rows (adapter icon/name, arrow, agent name, strategy badge, kebab menu with Edit/Delete), empty state, loading skeletons, and integration with `BindingDialog` for editing. Add "Bindings" as the 3rd tab in RelayPanel between Endpoints and Adapters.

**Files Changed**:

- `apps/client/src/layers/features/relay/ui/BindingList.tsx` (new)
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx` (modified)
- `apps/client/src/layers/features/relay/index.ts` (modified)
- `apps/client/src/layers/features/relay/ui/__tests__/BindingList.test.tsx` (new)

**Acceptance Criteria**:

- [ ] Empty state with icon, message, and CTA button
- [ ] Binding rows with adapter/agent info, strategy badges, kebab menu
- [ ] Delete shows AlertDialog confirmation
- [ ] Edit opens BindingDialog pre-populated
- [ ] Tab order: Activity | Endpoints | Bindings | Adapters
- [ ] FSD-compliant imports

---

## Phase 3: Backend File Splits

Split all 5 oversized files using the facade pattern. Zero API changes. All splits are independent and can run in parallel.

### Task 3.1: Split relay-schemas.ts into focused sub-modules

**Size**: Medium | **Priority**: Medium | **Dependencies**: None | **Parallel with**: Task 3.2, 3.3, 3.4, 3.5

Split `packages/shared/src/relay-schemas.ts` (681 lines) into 4 sub-modules: `relay-envelope-schemas.ts`, `relay-access-schemas.ts`, `relay-adapter-schemas.ts`, `relay-trace-schemas.ts`. Facade re-exports everything via `export *`.

**Files Changed**:

- `packages/shared/src/relay-envelope-schemas.ts` (new)
- `packages/shared/src/relay-access-schemas.ts` (new)
- `packages/shared/src/relay-adapter-schemas.ts` (new)
- `packages/shared/src/relay-trace-schemas.ts` (new)
- `packages/shared/src/relay-schemas.ts` (rewritten as facade)

**Acceptance Criteria**:

- [ ] Facade under 100 lines
- [ ] Each sub-module under 200 lines
- [ ] All existing imports from `@dorkos/shared/relay-schemas` unchanged
- [ ] Build, typecheck, and tests pass

---

### Task 3.2: Split relay-core.ts into focused sub-modules

**Size**: Large | **Priority**: Medium | **Dependencies**: None | **Parallel with**: Task 3.1, 3.3, 3.4, 3.5

Split `packages/relay/src/relay-core.ts` (827 lines) into 3 sub-modules: `relay-publish.ts`, `relay-subscriptions.ts`, `relay-endpoint-management.ts`. Facade retains the `RelayCore` class shell.

**Files Changed**:

- `packages/relay/src/relay-publish.ts` (new)
- `packages/relay/src/relay-subscriptions.ts` (new)
- `packages/relay/src/relay-endpoint-management.ts` (new)
- `packages/relay/src/relay-core.ts` (rewritten as facade)

**Acceptance Criteria**:

- [ ] Facade under 250 lines
- [ ] All existing relay-core tests pass unchanged
- [ ] All imports from `@dorkos/relay` stable

---

### Task 3.3: Split telegram-adapter.ts into focused sub-modules

**Size**: Large | **Priority**: Medium | **Dependencies**: None | **Parallel with**: Task 3.1, 3.2, 3.4, 3.5

Split `packages/relay/src/adapters/telegram-adapter.ts` (761 lines) into 3 sub-modules: `telegram-inbound.ts`, `telegram-outbound.ts`, `telegram-webhook.ts`. Facade retains the `TelegramAdapter` class.

**Files Changed**:

- `packages/relay/src/adapters/telegram-inbound.ts` (new)
- `packages/relay/src/adapters/telegram-outbound.ts` (new)
- `packages/relay/src/adapters/telegram-webhook.ts` (new)
- `packages/relay/src/adapters/telegram-adapter.ts` (rewritten as facade)

**Acceptance Criteria**:

- [ ] Facade under 200 lines
- [ ] All existing telegram adapter tests pass unchanged
- [ ] All imports from `@dorkos/relay` stable

---

### Task 3.4: Split claude-code-adapter.ts into focused sub-modules

**Size**: Large | **Priority**: Medium | **Dependencies**: None | **Parallel with**: Task 3.1, 3.2, 3.3, 3.5

Split `packages/relay/src/adapters/claude-code-adapter.ts` (906 lines, largest file) into 3 sub-modules: `claude-code-agent-handler.ts`, `claude-code-pulse-handler.ts`, `claude-code-queue.ts`. Facade retains the `ClaudeCodeAdapter` class and all type exports.

**Files Changed**:

- `packages/relay/src/adapters/claude-code-agent-handler.ts` (new)
- `packages/relay/src/adapters/claude-code-pulse-handler.ts` (new)
- `packages/relay/src/adapters/claude-code-queue.ts` (new)
- `packages/relay/src/adapters/claude-code-adapter.ts` (rewritten as facade)

**Acceptance Criteria**:

- [ ] Facade under 300 lines
- [ ] All 3 existing Claude Code adapter test files pass unchanged
- [ ] All imports from `@dorkos/relay` stable

---

### Task 3.5: Split mesh-core.ts into focused sub-modules

**Size**: Large | **Priority**: Medium | **Dependencies**: None | **Parallel with**: Task 3.1, 3.2, 3.3, 3.4

Split `packages/mesh/src/mesh-core.ts` (776 lines) into 3 sub-modules: `mesh-discovery.ts`, `mesh-agent-management.ts`, `mesh-denial.ts`. Facade retains the `MeshCore` class. Note: `mesh-topology.ts` already exists separately.

**Files Changed**:

- `packages/mesh/src/mesh-discovery.ts` (new)
- `packages/mesh/src/mesh-agent-management.ts` (new)
- `packages/mesh/src/mesh-denial.ts` (new)
- `packages/mesh/src/mesh-core.ts` (rewritten as facade)

**Acceptance Criteria**:

- [ ] Facade under 250 lines
- [ ] All existing mesh-core tests pass unchanged
- [ ] All imports from `@dorkos/mesh` stable

---

## Phase 4: Adapter Event Log

Surface adapter lifecycle events in a per-adapter event log UI.

### Task 4.1: Extend TraceStore with adapter event methods and add API endpoint

**Size**: Medium | **Priority**: Medium | **Dependencies**: None | **Parallel with**: None

Add `insertAdapterEvent()` and `getAdapterEvents()` methods to TraceStore, instrument AdapterManager lifecycle with event recording, and add `GET /api/relay/adapters/:id/events` endpoint with limit validation (1-500).

**Files Changed**:

- `apps/server/src/services/relay/trace-store.ts` (modified)
- `apps/server/src/services/relay/adapter-manager.ts` (modified)
- `apps/server/src/routes/relay.ts` (modified)
- `apps/server/src/services/relay/__tests__/trace-store.test.ts` (modified)

**Acceptance Criteria**:

- [ ] Events persisted with correct metadata JSON structure
- [ ] Query filters by adapterId, orders DESC, respects limit
- [ ] AdapterManager records connected/error/disconnected events
- [ ] API endpoint returns events array with limit validation
- [ ] All trace store tests pass

---

### Task 4.2: Build AdapterEventLog frontend component and hook

**Size**: Large | **Priority**: Medium | **Dependencies**: Task 4.1 | **Parallel with**: None

Create `useAdapterEvents` hook (5s polling), `AdapterEventLog` component with event type filter, auto-scroll with user-scroll detection, and "Jump to bottom" button. Integrate into AdapterCard via Sheet (slide-over panel) triggered from the kebab menu.

**Files Changed**:

- `apps/client/src/layers/shared/lib/transport/relay-methods.ts` (modified)
- `apps/client/src/layers/entities/relay/model/use-adapter-events.ts` (new)
- `apps/client/src/layers/entities/relay/index.ts` (modified)
- `apps/client/src/layers/features/relay/ui/AdapterEventLog.tsx` (new)
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx` (modified)
- `apps/client/src/layers/features/relay/index.ts` (modified)
- `apps/client/src/layers/features/relay/ui/__tests__/AdapterEventLog.test.tsx` (new)
- `apps/client/src/layers/entities/relay/model/__tests__/use-adapter-events.test.ts` (new)

**Acceptance Criteria**:

- [ ] Hook polls every 5s, disabled when adapterId is null
- [ ] Events display with HH:mm:ss timestamp, colored type badge, message
- [ ] Type filter dropdown works
- [ ] Auto-scroll only when user is at bottom
- [ ] "Jump to bottom" button when scrolled up
- [ ] Empty and loading states
- [ ] AdapterCard kebab menu has "Events" option opening Sheet
- [ ] All tests pass

---

## Dependency Graph

```
Phase 1 (parallel):     1.1 ──┐
                         1.2 ──┤
                               │
Phase 2 (sequential):   2.1 ──┼── (can start with Phase 1)
                         2.2 ──┘   (depends on 2.1)

Phase 3 (all parallel): 3.1 ─┐
                         3.2 ─┤
                         3.3 ─┤── (fully independent)
                         3.4 ─┤
                         3.5 ─┘

Phase 4 (sequential):   4.1 ──── 4.2
```

## Critical Path

1.1/1.2 (parallel) --> 2.1 --> 2.2

The backend file splits (Phase 3) and adapter event log (Phase 4) can run entirely in parallel with the binding list feature (Phase 2) since they touch different files.
