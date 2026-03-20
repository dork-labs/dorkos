---
slug: relay-mesh-quality-improvements
number: 119
status: draft
created: 2026-03-11
spec: relay-mesh-quality-improvements
---

# Relay & Mesh Quality Improvements

**Status:** Draft
**Authors:** Claude Code, 2026-03-11
**Ideation:** [01-ideation.md](./01-ideation.md)
**Branch:** preflight/relay-mesh-quality-improvements

---

## Overview

Five independent quality improvements identified during an architecture review of the Relay, Mesh, and Telegram adapter systems. Each improvement addresses a concrete code quality or UX gap: duplicated constants, truncated error messages, missing binding list view, oversized backend files, and lack of adapter-level event visibility.

## Background / Problem Statement

1. **CATEGORY_COLORS duplication** — The identical `CATEGORY_COLORS` constant is defined in both `AdapterCard.tsx` (lines 26-31) and `CatalogCard.tsx` (lines 6-11), violating DRY.
2. **Error truncation** — Adapter error messages are truncated at `max-w-[200px]` (AdapterCard line 88) with no way to read the full error, making debugging impossible from the UI.
3. **No binding list view** — Bindings can only be managed via the topology graph's drag-and-drop interface. There is no structured list to view, edit, or delete bindings.
4. **Oversized backend files** — Five backend files exceed the 500-line "must split" threshold: `relay-core.ts` (827), `claude-code-adapter.ts` (906), `mesh-core.ts` (776), `telegram-adapter.ts` (761), `relay-schemas.ts` (681).
5. **No adapter event log** — No way to see what an individual adapter is doing (connections, messages, errors, status changes) without reading server logs.

## Goals

- Eliminate the duplicated `CATEGORY_COLORS` constant
- Make adapter error messages fully readable via an accessible, keyboard-navigable expand pattern
- Provide a structured list view for creating, viewing, editing, and deleting bindings
- Split all 5 oversized files using the facade pattern with zero breaking changes
- Surface adapter lifecycle events in a per-adapter event log UI

## Non-Goals

- Maildir vs SQLite-only storage evaluation (explicitly deferred)
- Plugin adapter sandboxing
- Session eviction warnings
- Dead letter section repositioning
- Empty state contextual guidance improvements

## Technical Dependencies

| Dependency                    | Version      | Purpose                                                 |
| ----------------------------- | ------------ | ------------------------------------------------------- |
| `@radix-ui/react-collapsible` | (via shadcn) | WCAG-compliant expand/collapse for error messages       |
| `@tanstack/react-query`       | ^5           | Data fetching hooks for binding CRUD and adapter events |
| `drizzle-orm`                 | ^0.38        | Database schema and queries for adapter event traces    |
| `motion/react`                | ^12          | Animations for binding list and event log               |
| `lucide-react`                | ^0.473       | Icons for binding list rows and event types             |

**Prerequisites:**

- Install shadcn Collapsible component: `npx shadcn@latest add collapsible`

---

## Detailed Design

### Improvement 1: Extract CATEGORY_COLORS

**Pattern:** Follow the existing `status-colors.ts` template in `features/relay/lib/`.

**New file:** `apps/client/src/layers/features/relay/lib/category-colors.ts`

```typescript
/** Tailwind class map for adapter category badges. */
export const ADAPTER_CATEGORY_COLORS: Record<string, string> = {
  messaging: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  automation: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  internal: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
  custom: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
};

/**
 * Returns the Tailwind badge classes for a given adapter category.
 * Falls back to empty string for unknown categories.
 *
 * @param category - Adapter category string
 */
export function getCategoryColorClasses(category: string): string {
  return ADAPTER_CATEGORY_COLORS[category] ?? '';
}
```

**Changes to existing files:**

- `AdapterCard.tsx`: Remove lines 26-31 (`CATEGORY_COLORS`), import `getCategoryColorClasses` from `../lib/category-colors`, replace `CATEGORY_COLORS[manifest.category] ?? ''` with `getCategoryColorClasses(manifest.category)`
- `CatalogCard.tsx`: Remove lines 6-11 (`CATEGORY_COLORS`), import `getCategoryColorClasses` from `../lib/category-colors`, replace `CATEGORY_COLORS[manifest.category] ?? ''` with `getCategoryColorClasses(manifest.category)`

**Blast radius:** 2 files modified, 1 file created. All within `features/relay/` (FSD-compliant).

---

### Improvement 2: Fix Adapter Error Message Truncation

**Decision:** Use Radix Collapsible (WCAG-compliant). Radix manages `aria-expanded`/`aria-controls` automatically. Chosen over HoverCard (explicitly documented as "inaccessible to keyboard users") and Tooltip (wrong for multi-line content).

**Prerequisite:** Install shadcn Collapsible: `npx shadcn@latest add collapsible`

**Change in `AdapterCard.tsx`:** Replace the truncated error `<div>` (lines 87-91) with a Collapsible component.

Replace:

```tsx
{
  instance.status.lastError && (
    <div className="mt-1 max-w-[200px] truncate text-xs text-red-500">
      {instance.status.lastError}
    </div>
  );
}
```

With:

```tsx
{
  instance.status.lastError && (
    <Collapsible>
      <div className="mt-1 flex items-center gap-1">
        <CollapsibleTrigger asChild>
          <button
            className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600"
            aria-label="Toggle full error message"
          >
            <ChevronRight className="size-3 transition-transform data-[state=open]:rotate-90" />
            <span className="max-w-[200px] truncate">{instance.status.lastError}</span>
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mt-1 rounded-md bg-red-50 p-2 font-mono text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {instance.status.lastError}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
```

**New imports in AdapterCard.tsx:**

```typescript
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/layers/shared/ui/collapsible';
import { ChevronRight } from 'lucide-react';
```

**Accessibility:** Radix Collapsible provides `aria-expanded`, `aria-controls`, keyboard Enter/Space toggle automatically. The chevron rotates via CSS `data-[state=open]:rotate-90`.

**Blast radius:** 1 file modified (AdapterCard.tsx). Requires Collapsible to be installed in shared/ui first.

---

### Improvement 3: Add Binding List View

#### 3.1: Backend — Add Binding Update Support

The binding system currently lacks update capability. The following must be added:

**`apps/server/src/services/relay/binding-store.ts`** — Add `update()` method:

```typescript
/**
 * Update an existing binding's mutable fields.
 *
 * @param id - The binding UUID to update
 * @param updates - Fields to update (sessionStrategy, label, chatId, channelType)
 * @returns The updated binding, or undefined if not found
 */
async update(
  id: string,
  updates: Partial<Pick<AdapterBinding, 'sessionStrategy' | 'label' | 'chatId' | 'channelType'>>,
): Promise<AdapterBinding | undefined> {
  const existing = this.bindings.get(id);
  if (!existing) return undefined;
  const updated: AdapterBinding = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  this.bindings.set(id, updated);
  await this.save();
  return updated;
}
```

**`apps/server/src/routes/relay.ts`** — Add PATCH route:

```typescript
// PATCH /api/relay/bindings/:id — Update a binding
router.patch('/bindings/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body; // Validate via Zod schema
  const updated = await bindingStore.update(id, updates);
  if (!updated) return res.status(404).json({ error: 'Binding not found' });
  res.json(updated);
});
```

**`apps/client/src/layers/shared/lib/transport/relay-methods.ts`** — Add `updateBinding()`:

```typescript
async updateBinding(
  id: string,
  updates: Partial<Pick<AdapterBinding, 'sessionStrategy' | 'label' | 'chatId' | 'channelType'>>,
): Promise<AdapterBinding> {
  return this.patch(`/relay/bindings/${id}`, updates);
}
```

**`apps/client/src/layers/entities/binding/model/use-update-binding.ts`** — New hook:

```typescript
export function useUpdateBinding() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: ... }) =>
      transport.updateBinding(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['relay', 'bindings'] });
    },
  });
}
```

#### 3.2: Frontend — BindingList Component

**New file:** `apps/client/src/layers/features/relay/ui/BindingList.tsx`

Structure:

- Header with "Add Binding" button that opens the existing `BindingDialog`
- Binding rows in a list format:
  - Left: adapter icon/emoji + adapter display name (from catalog data)
  - Arrow indicator
  - Right: agent name + project path
  - Badges: session strategy, channel type (if set)
  - Kebab menu: Edit, Delete
- Edit opens `BindingDialog` from `features/mesh/ui/` pre-populated with current binding values
- Delete uses inline `AlertDialog` confirmation (same pattern as AdapterCard remove)
- Loading state: skeleton rows
- Empty state: icon + "No bindings configured" + "Create your first binding to route messages from adapters to agents" + CTA button

**Data hooks used:**

- `useBindings()` from `entities/binding/model/use-bindings`
- `useCreateBinding()` from `entities/binding/model/use-create-binding`
- `useUpdateBinding()` from `entities/binding/model/use-update-binding` (new)
- `useDeleteBinding()` from `entities/binding/model/use-delete-binding`
- `useAdapterCatalog()` from `entities/relay/model/use-adapter-catalog` (for adapter names/icons)

#### 3.3: Add Bindings Tab to RelayPanel

**Modify:** `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`

Add "Bindings" as the 3rd tab (between Endpoints and Adapters):

```
Activity | Endpoints | Bindings | Adapters
```

Add `<TabsContent value="bindings">` with `<BindingList />`.

**FSD compliance:** BindingList lives in `features/relay/ui/` (same feature as RelayPanel). It imports from `entities/binding/` (allowed: features can import entities). It imports `BindingDialog` from `features/mesh/ui/` (allowed: UI composition across features is permitted per FSD cross-module rule).

**Blast radius:** 1 new component, 1 new hook, 1 modified panel, 1 modified route, 1 modified store, 1 modified transport.

---

### Improvement 4: Split Oversized Backend Files

All splits use the **facade pattern**: the original file becomes a thin coordinator that re-exports from focused sub-modules. All existing imports via barrel `index.ts` files remain stable.

#### 4.1: relay-core.ts (827 lines → ~4 files)

**Directory:** `packages/relay/src/`

| New File                       | Extracted Responsibility                                                                    | Approx Lines |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------ |
| `relay-publish.ts`             | `publish()` method, `PublishResult` type, rate limiting + circuit breaker integration       | ~200         |
| `relay-subscriptions.ts`       | `subscribe()` method, `SubscriptionRegistry` delegation, signal handler registration        | ~150         |
| `relay-endpoint-management.ts` | `registerEndpoint()`/`unregisterEndpoint()`, Maildir store management, SQLite index updates | ~200         |
| `relay-core.ts` (facade)       | Class skeleton, constructor, `init()`, `close()`, dependency composition, re-exports        | ~200         |

**Re-export pattern in facade:**

```typescript
// Re-export public types/functions from sub-modules
export { publish, type PublishResult } from './relay-publish.js';
export { subscribe } from './relay-subscriptions.js';
export { registerEndpoint, unregisterEndpoint } from './relay-endpoint-management.js';
```

#### 4.2: telegram-adapter.ts (761 lines → ~4 files)

**Directory:** `packages/relay/src/adapters/`

| New File                       | Extracted Responsibility                                                               | Approx Lines |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------ |
| `telegram-inbound.ts`          | Message parsing helpers, `handleUpdate()` logic, payload normalization                 | ~200         |
| `telegram-outbound.ts`         | `deliver()` implementation, message chunking (4096-char limit), typing signal handling | ~180         |
| `telegram-webhook.ts`          | Webhook setup, HMAC verification, HTTP server lifecycle                                | ~150         |
| `telegram-adapter.ts` (facade) | Class, polling mode, start/stop lifecycle, re-exports                                  | ~180         |

#### 4.3: claude-code-adapter.ts (906 lines → ~4 files)

**Directory:** `packages/relay/src/adapters/`

| New File                          | Extracted Responsibility                                                               | Approx Lines |
| --------------------------------- | -------------------------------------------------------------------------------------- | ------------ |
| `claude-code-agent-handler.ts`    | `handleAgentMessage()`, session ID resolution, trace span creation, response streaming | ~250         |
| `claude-code-pulse-handler.ts`    | `handlePulseMessage()`, pulse payload parsing, job execution                           | ~200         |
| `claude-code-queue.ts`            | Queue management per agent, semaphore enforcement, `processWithQueue()`                | ~150         |
| `claude-code-adapter.ts` (facade) | Class, start/stop/deliver API, status tracking, re-exports                             | ~250         |

#### 4.4: mesh-core.ts (776 lines → ~4 files)

**Directory:** `packages/mesh/src/`

| New File                   | Extracted Responsibility                                                        | Approx Lines |
| -------------------------- | ------------------------------------------------------------------------------- | ------------ |
| `mesh-discovery.ts`        | `discover()` async generator, `register()` method, `upsertAutoImported()` logic | ~200         |
| `mesh-agent-management.ts` | list/get/update agent operations, status snapshots, agent inspection            | ~200         |
| `mesh-denial.ts`           | deny/undeny/isDenied delegation, denial list querying                           | ~100         |
| `mesh-core.ts` (facade)    | Class skeleton, constructor, init, close, reconciler startup, re-exports        | ~200         |

Note: `mesh-topology.ts` already exists as a separate file — move any remaining topology code there if needed.

#### 4.5: relay-schemas.ts (681 lines → ~5 files)

**Directory:** `packages/shared/src/`

| New File                    | Extracted Responsibility                                                                      | Approx Lines |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------ |
| `relay-envelope-schemas.ts` | `RelayBudgetSchema`, `RelayEnvelopeSchema`, `StandardPayloadSchema`, `AttachmentSchema`       | ~150         |
| `relay-access-schemas.ts`   | `RelayAccessRuleSchema`, `AccessControlSchema`, all enums                                     | ~100         |
| `relay-adapter-schemas.ts`  | `AdapterManifest`, `AdapterStatus`, `AdapterConfig`, `AdapterBinding`, `CreateBindingRequest` | ~150         |
| `relay-trace-schemas.ts`    | `TraceSpanSchema`, `TraceSpanStatus`, `DeliveryMetrics`                                       | ~100         |
| `relay-schemas.ts` (facade) | Module doc + `export * from` for all extracted files                                          | ~80          |

**Package exports:** The `@dorkos/shared` package already has subpath exports configured in `package.json`. The existing `./relay-schemas` export resolves to `relay-schemas.ts`, which re-exports everything — no changes to `package.json` needed since the facade preserves the public API.

#### Split Guidelines (All Files)

- Sub-module files export named functions/classes/types (no default exports)
- Facade file imports and re-exports everything: `export { X, Y } from './sub-module.js'`
- No internal barrel files within sub-modules
- All existing `import { X } from '@dorkos/relay'` or `import { X } from '@dorkos/shared/relay-schemas'` continue to work unchanged
- TypeScript types must be re-exported with `export type` where appropriate

---

### Improvement 5: Add Adapter Event Log

#### 5.1: Backend — Extend Trace System

**Approach:** Store adapter events as trace spans with adapter-specific event types. The `metadata` JSON column on `relayTraces` will carry the `adapterId` and `eventType` fields.

**Event types to track:**

| Event Type                 | When Recorded                            | Message Format                    |
| -------------------------- | ---------------------------------------- | --------------------------------- |
| `adapter.connected`        | Adapter start() completes                | "Connected to relay"              |
| `adapter.disconnected`     | Adapter stop() called or connection lost | "Disconnected from relay"         |
| `adapter.message_received` | Inbound message parsed                   | "Received message from {subject}" |
| `adapter.message_sent`     | Outbound delivery completes              | "Sent message to {subject}"       |
| `adapter.error`            | Error caught during operation            | Full error message                |
| `adapter.status_change`    | State transition                         | "State changed: {old} → {new}"    |

**TraceStore changes** (`apps/server/src/services/relay/trace-store.ts`):

Add a new method to insert adapter events:

```typescript
/**
 * Record an adapter lifecycle event as a trace span.
 *
 * @param adapterId - The adapter instance ID
 * @param eventType - The event type (e.g. 'adapter.connected')
 * @param message - Human-readable event description
 */
insertAdapterEvent(adapterId: string, eventType: string, message: string): void {
  this.db
    .insert(relayTraces)
    .values({
      id: ulid(),
      messageId: ulid(), // Unique per event
      traceId: adapterId, // Group by adapter
      subject: eventType,
      status: 'delivered' as const,
      sentAt: new Date().toISOString(),
      metadata: JSON.stringify({ adapterId, eventType, message }),
    })
    .run();
}
```

Add a query method to retrieve adapter events:

```typescript
/**
 * Get adapter events filtered by adapter ID, ordered by sentAt descending.
 *
 * @param adapterId - The adapter instance ID
 * @param limit - Maximum events to return (default 100)
 */
getAdapterEvents(adapterId: string, limit = 100): TraceSpanRow[] {
  return this.db
    .select()
    .from(relayTraces)
    .where(sql`json_extract(${relayTraces.metadata}, '$.adapterId') = ${adapterId}`)
    .orderBy(sql`${relayTraces.sentAt} DESC`)
    .limit(limit)
    .all();
}
```

**Adapter-manager changes** (`apps/server/src/services/relay/adapter-manager.ts`):

Record events at key lifecycle points:

- `startAdapter()` success → `adapter.connected`
- `startAdapter()` failure → `adapter.error`
- `stopAdapter()` → `adapter.disconnected`
- Status change callback → `adapter.status_change`

**Relay route changes** (`apps/server/src/routes/relay.ts`):

Add endpoint:

```typescript
// GET /api/relay/adapters/:id/events — Get adapter event log
router.get('/adapters/:id/events', async (req, res) => {
  const { id } = req.params;
  const limit = parseInt(req.query.limit as string) || 100;
  const events = traceStore.getAdapterEvents(id, limit);
  res.json(events);
});
```

#### 5.2: Frontend — Adapter Event Hook and Component

**New file:** `apps/client/src/layers/entities/relay/model/use-adapter-events.ts`

```typescript
export function useAdapterEvents(adapterId: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['relay', 'adapters', adapterId, 'events'],
    queryFn: () => transport.get(`/relay/adapters/${adapterId}/events`),
    enabled: !!adapterId,
    refetchInterval: 5_000,
  });
}
```

**New file:** `apps/client/src/layers/features/relay/ui/AdapterEventLog.tsx`

Component structure:

- Header: "Events" title + event type filter dropdown
- Scrollable event list:
  - Row format: `[HH:mm:ss tabular-nums] [type Badge] [message text break-words]`
  - Badge colors by event type category: green (connected/sent), red (error/disconnected), blue (received), amber (status_change)
- Auto-scroll with user-scroll detection:
  - Track `isAtBottom` state via scroll event listener
  - Only auto-scroll when `isAtBottom` is true
  - Show "Jump to bottom" button when user has scrolled up
- Loading state: skeleton rows
- Empty state: "No events recorded" message

**Integration point:** Add an "Events" button or expandable section to `AdapterCard.tsx`. When clicked, shows the `AdapterEventLog` for that adapter — either as a Sheet (slide-over panel) or as an expanded section below the card.

**Transport method:** Add `getAdapterEvents(adapterId: string)` to relay transport methods.

---

## User Experience

### Improvement 1 (CATEGORY_COLORS)

No visible change. Internal refactoring only.

### Improvement 2 (Error Display)

Users see a truncated error preview with a chevron. Clicking (or pressing Enter/Space) expands to show the full error in a styled monospace block. Clicking again collapses. Keyboard navigation works via standard Radix accessibility patterns.

### Improvement 3 (Binding List)

New "Bindings" tab appears between "Endpoints" and "Adapters" in the Relay panel. Shows a clean list of all bindings with adapter→agent routing info, strategy badges, and action menus. Users can create, edit, and delete bindings without navigating to the topology graph.

### Improvement 4 (File Splits)

No visible change. Internal refactoring only.

### Improvement 5 (Event Log)

Users can view a chronological event log for any adapter showing connections, messages, errors, and status changes. Events auto-update every 5 seconds with auto-scroll behavior.

---

## Testing Strategy

### Improvement 1: CATEGORY_COLORS

- **Unit test:** `category-colors.test.ts` — verify `getCategoryColorClasses()` returns correct classes for known categories and empty string for unknown
- **Smoke:** Verify AdapterCard and CatalogCard still render category badges correctly

### Improvement 2: Error Display

- **Component test:** `AdapterCard.test.tsx` — verify Collapsible renders when `lastError` is set, full error text is visible when expanded, trigger is keyboard accessible
- **Accessibility:** Verify `aria-expanded` attribute toggles

### Improvement 3: Binding List

- **Component test:** `BindingList.test.tsx` — verify list renders bindings, empty state shows when no bindings, create/edit/delete actions trigger correct mutations
- **Hook test:** `use-update-binding.test.ts` — verify mutation calls transport and invalidates query cache
- **Integration:** Verify BindingDialog pre-fills correctly in edit mode

### Improvement 4: File Splits

- **Existing tests:** All existing tests in `packages/relay/`, `packages/mesh/`, and `packages/shared/` must continue to pass without modification (the facade pattern preserves the public API)
- **Import verification:** Build the project and verify no import resolution errors

### Improvement 5: Event Log

- **Unit test:** `trace-store.test.ts` — verify `insertAdapterEvent()` persists and `getAdapterEvents()` queries correctly, filtered by adapterId
- **Component test:** `AdapterEventLog.test.tsx` — verify events render with correct format, filter dropdown works, auto-scroll behavior
- **Hook test:** `use-adapter-events.test.ts` — verify query key structure and polling interval

---

## Performance Considerations

- **File splits (Item 4):** No runtime impact — facade re-exports are resolved at compile time by TypeScript/bundler
- **Adapter events (Item 5):** `json_extract()` queries on the metadata column may slow down as the traces table grows. Mitigation: the `LIMIT` parameter caps query size at 100 rows. If performance degrades, add a dedicated `adapterId` column to `relayTraces` with an index in a follow-up migration
- **Binding list (Item 3):** `useBindings()` already fetches all bindings — no additional queries needed for the list view
- **Collapsible (Item 2):** Negligible — Radix Collapsible is a lightweight component

---

## Security Considerations

- **Binding update endpoint:** The PATCH `/api/relay/bindings/:id` route should validate input via Zod schema to prevent injection of unexpected fields. Only allow updating `sessionStrategy`, `label`, `chatId`, `channelType`.
- **Event log endpoint:** The GET `/api/relay/adapters/:id/events` route should validate `limit` parameter bounds (1-500) to prevent DoS via excessive query size.
- **No auth changes:** All new endpoints use the same authentication pattern as existing relay routes.

---

## Documentation

- No external documentation changes needed — these are internal quality improvements
- TSDoc on all new exported functions/classes per project conventions
- Update barrel `index.ts` files in affected packages if new public exports are added

---

## Implementation Phases

### Phase 1: Low-Risk Extractions (Items 1, 2)

- Extract `CATEGORY_COLORS` to shared lib
- Install shadcn Collapsible and replace error truncation
- Minimal blast radius, immediate value

### Phase 2: Binding List (Item 3)

- Add binding update support (store → route → transport → hook)
- Build `BindingList` component
- Add Bindings tab to RelayPanel
- Depends on existing binding infrastructure

### Phase 3: Backend File Splits (Item 4)

- Split all 5 files using facade pattern
- Run full test suite after each split to catch regressions
- Highest file count change but zero API changes

### Phase 4: Adapter Event Log (Item 5)

- Extend TraceStore with adapter event methods
- Add adapter event recording in adapter-manager
- Add API endpoint
- Build frontend hook and component
- Most backend surface area

---

## Open Questions

All questions were resolved during ideation:

1. ~~**Error display pattern**~~ (RESOLVED)
   **Answer:** Collapsible expand — WCAG compliant via Radix aria management.

2. ~~**Binding list placement**~~ (RESOLVED)
   **Answer:** New 'Bindings' tab in RelayPanel.

3. ~~**Backend split scope**~~ (RESOLVED)
   **Answer:** Split all 5 files using facade pattern.

4. ~~**Event log data source**~~ (RESOLVED)
   **Answer:** Extend existing trace system — zero new infrastructure.

---

## Related ADRs

| ADR      | Title                                               | Relevance                                           |
| -------- | --------------------------------------------------- | --------------------------------------------------- |
| ADR-0046 | Central BindingRouter for Adapter-Agent Routing     | Binding resolution logic that the list view exposes |
| ADR-0047 | Most-Specific-First Binding Resolution Order        | Binding scoring shown in binding list detail        |
| ADR-0028 | Store Message Traces in Existing Relay SQLite Index | Trace storage pattern extended by adapter events    |
| ADR-0021 | Restructure Server Services into Domain Folders     | Guides the organization of split files              |
| ADR-0002 | Adopt Feature-Sliced Design                         | FSD layer rules governing component placement       |

---

## References

- [Ideation document](./01-ideation.md) — Full research and decision rationale
- [Radix Collapsible docs](https://www.radix-ui.com/primitives/docs/components/collapsible) — Accessibility behavior
- `contributing/design-system.md` — Calm Tech design language
- `apps/client/src/layers/features/relay/lib/status-colors.ts` — Pattern template for CATEGORY_COLORS extraction
- `.claude/rules/file-size.md` — File size thresholds and split guidance
