---
slug: relay-panel-redesign
number: 132
created: 2026-03-15
status: specified
---

# Specification: Relay Panel Redesign

**Status:** Specified
**Authors:** Claude Code, 2026-03-15
**Ideation:** [01-ideation.md](./01-ideation.md)
**Supersedes:** Spec #68 (relay-ux-elevation), Spec #120 (adapter-binding-ux-overhaul)

---

## Overview

Redesign the Relay Panel from four system-architecture tabs (Activity, Endpoints, Bindings, Adapters) to two user-mental-model tabs (Connections, Activity). Replace raw metric counters with a semantic health status indicator, aggregate dead letters into failure insight cards, wire the unused `RelayEmptyState` ghost preview, refine the Adapter Setup Wizard, add binding-level permissions for overnight agent safety, and fix four P0 data integrity bugs.

This is a single comprehensive specification covering UI restructure, backend changes, and bug fixes.

## Background / Problem Statement

A full Jobs/Ive design critique and independent bindings code review converged on the same diagnosis: the Relay Panel mirrors the system's internal architecture rather than the user's mental model.

**Problems identified:**

1. **Four tabs map to four system concepts** (Activity, Endpoints, Bindings, Adapters) — but users think in two: "my connections" and "what's happening." Kai navigates four tabs to answer one question.
2. **Health bar lies** — "X today" shows all-time message count because `TraceStore.getMetrics()` has no date filter. Trust is destroyed.
3. **15,044 identical dead letter rows** — flat list with no aggregation. Each row is an individual failure for what is often the same error repeating thousands of times.
4. **Ghost preview exists but is unused** — `RelayEmptyState.tsx` was designed and built but never imported anywhere. Dead code.
5. **SSE disconnected from Activity Feed** — `useRelayEventStream` injects into query key `['relay', 'messages', undefined]`, but `ActivityFeed` reads from `['relay', 'conversations']`. Real-time updates never arrive; the feed polls at 5-second intervals.
6. **Double toast on adapter add** — both `useAddAdapter` and `AdapterSetupWizard` fire success toasts.
7. **`extractAdapterId` regex fails** — matches pattern `relay.adapter.<id>.*` but current subjects use `relay.human.<platform>.<chatId>`. Returns empty string, creating broken quick-route bindings.
8. **No binding permissions** — Kai's agents can initiate outbound messages to any connected platform with no guard rails. His #1 safety concern for overnight autonomous runs.
9. **Bindings appear in 6 UI surfaces** — standalone tab, inline in AdapterCard, BindingDialog, ConversationRow quick-route, sidebar Connections view, wizard bind step. Redundancy without value.
10. **Session strategy noise** — every binding shows "Per Chat" badge even when that is the only practical option.

## Goals

- Users assess Relay health in under 1 second via semantic status (healthy/degraded/critical)
- Users manage connections (adapters + bindings) in a single tab
- Dead letters are aggregated into actionable failure insights, not an unbounded flat list
- Empty states guide the user forward with ghost previews and contextual CTAs
- Binding permissions (`canInitiate`, `canReply`, `canReceive`) are enforced server-side
- All four P0 data bugs are fixed before or alongside the UI restructure
- Panel reduces from 4 tabs to 2, eliminating 3 redundant components

## Non-Goals

- Relay core library changes (`packages/relay`)
- Adapter protocol implementations (Telegram, Slack, Webhook adapter code)
- Topology graph / Mesh panel changes
- Server-side binding resolution algorithm changes (ADR-0047 scoring is correct)
- Rate limiting / circuit breaker UI (reliability schemas exist but are out of scope)
- Sidebar "Connections" view changes (ADR-0107 — separate surface, separate spec)
- Visual cron builder or Pulse integration
- Mobile-specific layout changes

## Technical Dependencies

### Existing Dependencies (no changes)

| Package | Used For |
|---------|----------|
| `motion` (motion.dev) | AnimatePresence, spring animations for tab transitions and mode switch |
| `@tanstack/react-query` | Data fetching hooks, SSE cache injection |
| `lucide-react` | Icons (AlertTriangle, Shield, ShieldCheck, ChevronDown) |
| `sonner` | Toast notifications |
| `zod` | Schema validation for binding permissions |
| shadcn/ui primitives | Tabs, Badge, Button, Dialog, Collapsible, Tooltip |

No new external dependencies required.

## Detailed Design

### Phase 1: P0 Bug Fixes (Trust Restoration)

These fixes must ship before or alongside the UI restructure. Each addresses a data integrity or trust violation.

#### 1.1 Fix "Today" Label — Add Date Filter to `getMetrics()`

**File:** `apps/server/src/services/relay/trace-store.ts`

The current `getMetrics()` method queries all-time counts with no WHERE clause on `sentAt`. The health bar labels the result "today," which is a lie.

**Change:** Add an optional `since` parameter and compute a 24-hour window:

```typescript
getMetrics(options?: { since?: string }): DeliveryMetrics {
  const sinceIso = options?.since ?? new Date(Date.now() - 86_400_000).toISOString();

  const [counts] = this.db
    .select({
      total: count(),
      delivered: count(sql`CASE WHEN ${relayTraces.status} = 'delivered' THEN 1 END`),
      failed: count(sql`CASE WHEN ${relayTraces.status} = 'failed' THEN 1 END`),
      deadLettered: count(sql`CASE WHEN ${relayTraces.status} = 'timeout' THEN 1 END`),
    })
    .from(relayTraces)
    .where(sql`${relayTraces.sentAt} >= ${sinceIso}`)
    .all();

  // ... rest of latency computation
}
```

The route handler in `routes/relay.ts` calls `getMetrics()` with no arguments, which now defaults to the last 24 hours. The `DeliveryMetrics` type in `@dorkos/shared/relay-schemas` does not change — field names remain `totalMessages`, `failedCount`, etc.

**Test:** Verify that inserting a span with `sentAt` older than 24h does not appear in `getMetrics()` results.

#### 1.2 Wire SSE to Conversations Query Cache

**File:** `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`

The SSE stream currently injects into `['relay', 'messages', undefined]`, but `ActivityFeed` reads from `['relay', 'conversations']`. These are disconnected — the feed polls at 5-second intervals instead of updating in real-time.

**Change:** Replace both `relay_message` and `relay_delivery` event handlers to invalidate the conversations query key:

```typescript
source.addEventListener('relay_message', (e) => {
  try {
    JSON.parse(e.data); // validate parseable
    // Invalidate conversations — the buildConversations() server function
    // handles grouping, so we let TanStack Query refetch the structured data
    queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
  } catch {
    console.warn('[Relay] Failed to parse relay_message event:', e.data);
  }
});

source.addEventListener('relay_delivery', (e) => {
  try {
    JSON.parse(e.data);
    queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
  } catch {
    console.warn('[Relay] Failed to parse relay_delivery event:', e.data);
  }
});
```

This replaces direct cache mutation with invalidation-driven refetch. The tradeoff is a network request per SSE event, but `buildConversations()` on the server is the only correct way to group messages into conversations. The 5-second polling interval can be increased to 60 seconds (or removed) since SSE now drives freshness.

**Test:** Verify that sending a relay message triggers an Activity Feed update without waiting for the poll interval.

#### 1.3 Fix Double Toast on Adapter Add

**File:** `apps/client/src/layers/entities/relay/model/use-adapter-catalog.ts`

The `useAddAdapter` mutation hook fires `toast.success('Adapter added')` in its `onSuccess` callback. The `AdapterSetupWizard` also fires its own success toast after the mutation completes (with adapter-specific messaging like "Telegram adapter configured").

**Change:** Remove the toast from `useAddAdapter`:

```typescript
export function useAddAdapter() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, config }: { type: string; id: string; config: Record<string, unknown> }) =>
      transport.addRelayAdapter(type, id, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...CATALOG_KEY] });
      queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
      // Toast removed — wizard provides adapter-specific success message
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });
}
```

The error toast stays — it fires when the wizard's own error handling may not catch the failure.

#### 1.4 Fix `extractAdapterId` Regex

**File:** `apps/client/src/layers/features/relay/ui/ConversationRow.tsx`

The current regex matches `relay.adapter.<id>.*` but the actual subject format is `relay.human.<platform>.<chatId>`:

```typescript
// Current (broken):
const match = conversation.from.raw.match(/^relay\.adapter\.([^.]+)/);

// Fixed — match relay.human.<platform>.<chatId> and derive adapter from metadata or platform:
function extractAdapterId(conversation: RelayConversation): string {
  // Prefer explicit adapterId from payload metadata
  if (conversation.payload && typeof conversation.payload === 'object') {
    const payload = conversation.payload as Record<string, unknown>;
    if (typeof payload.adapterId === 'string') return payload.adapterId;
  }
  // Infer from subject: relay.human.<platform>.<chatId>
  const match = conversation.from.raw.match(/^relay\.human\.([^.]+)/);
  if (match) return match[1];
  return '';
}
```

**Test:** Verify that a conversation with subject `relay.human.telegram.12345` returns `'telegram'` as the adapter ID.

---

### Phase 2: Information Architecture (Tab Restructure)

#### 2.1 Merge to Two Tabs: Connections + Activity

**File:** `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`

Replace the four-tab structure with two tabs. The "Connections" tab contains the current AdaptersTab content (configured adapters with inline bindings + available adapter catalog). The "Activity" tab contains the current ActivityFeed.

**Current structure (to be replaced):**

```
TabsList: Activity | Endpoints | Bindings | Adapters
```

**New structure:**

```
TabsList: Connections | Activity
```

```tsx
<TabsList className="mx-4 mt-3 shrink-0">
  <TabsTrigger value="connections">Connections</TabsTrigger>
  <TabsTrigger value="activity">Activity</TabsTrigger>
</TabsList>
```

The default tab changes from `'activity'` to `'connections'` — connections are the primary configuration surface, and a user opening the Relay Panel for the first time should see their adapters, not an empty activity feed.

**State changes:**
- Remove `selectedEndpoint` state (Endpoints tab removed)
- Update `activeTab` default from `'activity'` to `'connections'`
- Remove `onBindClick` callback (no standalone Bindings tab to switch to)
- Keep `deadLetterRef` for scroll-to-failures from health bar

#### 2.2 Extract AdaptersTab to Standalone File

**New file:** `apps/client/src/layers/features/relay/ui/ConnectionsTab.tsx`

The `AdaptersTab` inner function in `RelayPanel.tsx` is ~173 lines. Extract it as `ConnectionsTab` into its own file. This is a rename + extraction, not a redesign — the component's behavior is preserved.

The `onBindClick` prop is removed since there is no standalone Bindings tab to navigate to. Inline binding management in `AdapterCard` remains the primary binding surface.

#### 2.3 Remove Endpoints Tab Components

**Files to delete:**
- `apps/client/src/layers/features/relay/ui/EndpointList.tsx`
- `apps/client/src/layers/features/relay/ui/InboxView.tsx`

Endpoints are an implementation detail (system-generated NATS-like subject subscriptions). They provide no user value — Kai never thinks "I need to manage my endpoints." The information they display (registered subject patterns) is implicit in the adapter + binding configuration.

Remove these imports from `RelayPanel.tsx` and delete the files.

#### 2.4 Remove Standalone BindingList

**File to delete:** `apps/client/src/layers/features/relay/ui/BindingList.tsx`

Bindings are already shown inline in `AdapterCard` (per-adapter), in `ConversationRow` (quick-route), and in the `BindingDialog` (create/edit). The standalone flat list adds no value — it shows the same data without adapter context.

Remove the import from `RelayPanel.tsx` and delete the file.

#### 2.5 Update Barrel Exports

**File:** `apps/client/src/layers/features/relay/index.ts`

Remove exports for `EndpointList`, `InboxView`, and `BindingList`. Add export for `ConnectionsTab`.

---

### Phase 3: Health Bar Semantic Status

#### 3.1 Redesign RelayHealthBar

**File:** `apps/client/src/layers/features/relay/ui/RelayHealthBar.tsx`

Replace the four raw-number stats bar with a semantic status indicator. The bar should answer "is my system healthy?" in under 1 second.

**Three states:**

| State | Condition | Display | Color |
|-------|-----------|---------|-------|
| Healthy | All adapters connected, failure rate < 5% | "3 connections active" with latency on hover | Green dot (`bg-emerald-500`) |
| Degraded | Any adapter disconnected OR failure rate 5-50% | Specific problem: "Telegram: 12 failures in last hour" | Amber dot (`bg-amber-500`) |
| Critical | Failure rate > 50% OR zero adapters connected | "90% failure rate — X messages failed today" | Red dot (`bg-red-500`) |

**Computation logic:**

```typescript
type HealthState = 'healthy' | 'degraded' | 'critical';

function computeHealthState(
  metrics: DeliveryMetrics,
  connected: number,
  total: number,
): { state: HealthState; message: string } {
  const failureRate = metrics.totalMessages > 0
    ? (metrics.failedCount + metrics.deadLetteredCount) / metrics.totalMessages
    : 0;

  if (total === 0) {
    return { state: 'healthy', message: 'No connections configured' };
  }

  if (failureRate > 0.5 || connected === 0) {
    const pct = Math.round(failureRate * 100);
    return {
      state: 'critical',
      message: `${pct}% failure rate — ${metrics.failedCount} messages failed today`,
    };
  }

  if (connected < total || failureRate >= 0.05) {
    const disconnected = total - connected;
    if (disconnected > 0) {
      return {
        state: 'degraded',
        message: `${disconnected} connection${disconnected > 1 ? 's' : ''} disconnected`,
      };
    }
    return {
      state: 'degraded',
      message: `${metrics.failedCount} failures in last 24h`,
    };
  }

  return {
    state: 'healthy',
    message: `${connected} connection${connected > 1 ? 's' : ''} active`,
  };
}
```

**Visual design:**

```
┌─────────────────────────────────────────────────┐
│  ● 3 connections active · <1ms              [📊]│
└─────────────────────────────────────────────────┘
```

The status dot color follows the state. The latency appears after a middle dot (`·`) when healthy. The `[📊]` button opens the `DeliveryMetricsDashboard` dialog (preserved from the current implementation). When degraded or critical, the failure count is clickable to scroll to dead letters in the Activity tab.

**Hover tooltip (healthy state only):** Shows the detailed breakdown — `"142 messages today · 0 failed · <1ms avg latency"`.

---

### Phase 4: Dead Letter Aggregation

#### 4.1 New Server Endpoint: Aggregated Dead Letters

**File:** `apps/server/src/routes/relay.ts`

Add `GET /api/relay/dead-letters/aggregated` returning dead letters grouped by source + error reason.

**Response schema:**

```typescript
const AggregatedDeadLetterSchema = z.object({
  source: z.string(),
  reason: z.string(),
  count: z.number().int().nonnegative(),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  sample: z.unknown().optional(),
});

const AggregatedDeadLettersResponseSchema = z.object({
  groups: z.array(AggregatedDeadLetterSchema),
});
```

**Implementation:** Query `relayCore.getDeadLetters()`, then aggregate in-memory:

```typescript
router.get('/dead-letters/aggregated', async (_req, res) => {
  const deadLetters = await relayCore.getDeadLetters();

  const groups = new Map<string, {
    source: string;
    reason: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    sample: unknown;
  }>();

  for (const dl of deadLetters) {
    const key = `${dl.source ?? 'unknown'}::${dl.reason}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (dl.failedAt < existing.firstSeen) existing.firstSeen = dl.failedAt;
      if (dl.failedAt > existing.lastSeen) existing.lastSeen = dl.failedAt;
    } else {
      groups.set(key, {
        source: dl.source ?? 'unknown',
        reason: dl.reason,
        count: 1,
        firstSeen: dl.failedAt,
        lastSeen: dl.failedAt,
        sample: dl.envelope,
      });
    }
  }

  return res.json({ groups: [...groups.values()] });
});
```

#### 4.2 Client Hook for Aggregated Dead Letters

**File:** `apps/client/src/layers/entities/relay/model/use-dead-letters.ts`

Add a new `useAggregatedDeadLetters` hook alongside the existing `useDeadLetters`:

```typescript
export interface AggregatedDeadLetter {
  source: string;
  reason: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sample?: unknown;
}

export function useAggregatedDeadLetters(enabled = true) {
  const transport = useTransport();
  return useQuery<AggregatedDeadLetter[]>({
    queryKey: ['relay', 'dead-letters', 'aggregated'],
    queryFn: async () => {
      const response = await transport.fetch('/api/relay/dead-letters/aggregated');
      const data = await response.json();
      return data.groups;
    },
    enabled,
    refetchInterval: 30_000,
  });
}
```

#### 4.3 Redesign DeadLetterSection as Aggregated Failure Cards

**File:** `apps/client/src/layers/features/relay/ui/DeadLetterSection.tsx`

Replace the flat list of individual dead letters with aggregated failure cards. Each card shows source, reason, count, time range, and two actions: "Dismiss All" and "View Sample."

**New structure:**

```
┌─────────────────────────────────────────────────┐
│ ⚠ Delivery Failures                        [3] │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │ Pulse Scheduler                             │ │
│ │ No registered endpoint                      │ │
│ │ 15,044 failures · Mar 1 – Mar 15            │ │
│ │                    [View Sample] [Dismiss]   │ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ Telegram Adapter                            │ │
│ │ TTL expired                                 │ │
│ │ 23 failures · Mar 14 – Mar 15               │ │
│ │                    [View Sample] [Dismiss]   │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

The component switches from `useDeadLetters` to `useAggregatedDeadLetters`. The `REASON_CONFIG` map is preserved for color-coded reason badges.

**"View Sample" action:** Opens a `Dialog` with the sample envelope JSON (pretty-printed). This replaces the per-row expandable envelope detail.

**"Dismiss All" action:** Calls a new `DELETE /api/relay/dead-letters` endpoint with `{ source, reason }` body to clear all dead letters matching that group. After mutation, invalidates `['relay', 'dead-letters']` query keys.

#### 4.4 Dead Letters as Activity Filter State

Dead letters are no longer a separate pinned section below the Activity Feed. Instead, the Activity tab shows a filter toggle: "Show failures" that reveals the aggregated dead letter cards inline. When failures exist, the toggle shows a red dot indicator.

This keeps the Activity tab focused on message flow by default, while making failures one click away.

---

### Phase 5: Empty State Overhaul

#### 5.1 ADR-0038 Mode A/B for RelayPanel

**File:** `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`

Apply the Mode A/B progressive disclosure pattern from ADR-0038:

**Mode A (no configured adapters):** Hide the tab bar and health bar entirely. Show a full-bleed empty state with the `RelayEmptyState` ghost preview component. The "Add Adapter" CTA opens the adapter catalog inline (not in a dialog).

```tsx
const { data: catalog = [] } = useAdapterCatalog(relayEnabled);
const hasConfiguredAdapters = catalog.some((entry) => entry.instances.length > 0);

if (!hasConfiguredAdapters) {
  return <RelayEmptyState onAddAdapter={() => setShowCatalog(true)} />;
}

// Mode B: full tabbed interface
return (
  <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
    {/* ... */}
  </Tabs>
);
```

**Mode B (one or more adapters configured):** Show the full two-tab interface with health bar.

The transition between modes uses `AnimatePresence` for a smooth crossfade:

```tsx
<AnimatePresence mode="wait">
  {hasConfiguredAdapters ? (
    <motion.div key="mode-b" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      {/* Tabbed interface */}
    </motion.div>
  ) : (
    <motion.div key="mode-a" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <RelayEmptyState onAddAdapter={() => setShowCatalog(true)} />
    </motion.div>
  )}
</AnimatePresence>
```

#### 5.2 Wire RelayEmptyState Ghost Preview

**File:** `apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx`

The component already exists with hardcoded example message rows. It is currently dead code — not imported anywhere.

**Changes:**
- Update copy to follow the what/why/what-to-do-next pattern:
  - **What:** "Connect your agents to the world"
  - **Why:** "Relay routes messages between your agents and external platforms like Telegram and Slack"
  - **What to do next:** "Add your first adapter to start sending and receiving messages"
- Keep the ghost preview rows (they demonstrate the value proposition visually)
- Ensure the "Add Adapter" button triggers the wizard flow

#### 5.3 Activity Tab Empty State

**File:** `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`

When the Activity tab has no conversations (adapters exist but no messages have flowed), show a contextual empty state:

```
┌─────────────────────────────────────────────────┐
│                                                 │
│         [Ghost preview of messages]             │
│              (faded, non-interactive)           │
│                                                 │
│     Waiting for messages                        │
│     Messages will appear here when your         │
│     agents send or receive through Relay.       │
│                                                 │
└─────────────────────────────────────────────────┘
```

Reuse the ghost preview pattern from `RelayEmptyState` but with different copy and without the CTA button (adapters are already configured in this state).

---

### Phase 6: Wizard Refinements

#### 6.1 Remove Adapter ID Field

**File:** `apps/client/src/layers/features/relay/ui/wizard/ConfigureStep.tsx`

The Adapter ID field asks users to provide a kebab-case identifier. This is an implementation detail — users should not name internal IDs.

**Auto-generation logic:**

```typescript
function generateAdapterId(type: string, existingIds: string[]): string {
  const base = type; // e.g., 'telegram'
  if (!existingIds.includes(base)) return base;

  let counter = 2;
  while (existingIds.includes(`${base}-${counter}`)) counter++;
  return `${base}-${counter}`;
}
```

Remove the Adapter ID `ConfigField` from the configure step's rendered fields. The wizard generates the ID automatically when submitting.

**File:** `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`

Update the wizard's submit handler to call `generateAdapterId()` instead of reading from form state.

#### 6.2 Fix Step Indicator

**File:** `apps/client/src/layers/features/relay/ui/wizard/StepIndicator.tsx`

The current step indicator uses em-dash characters (`—`) as connectors between step labels. Replace with a proper visual stepper showing active, complete, and pending states.

**Design:**

```
  ●━━━━━━●━━━━━━○━━━━━━○
 Configure  Test   Confirm  Bind
```

- Completed steps: filled circle with checkmark (`bg-primary`)
- Active step: filled circle with number (`bg-primary ring-2 ring-primary/30`)
- Pending steps: outlined circle with number (`border border-muted-foreground`)
- Connectors: thin lines between circles, solid when connecting completed steps, dashed when connecting to pending

#### 6.3 Add Back and Cancel Buttons

**File:** `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`

The wizard currently has only a "Continue" button and the dialog's X close button. Add:

- **Back button:** Navigates to the previous wizard step. Hidden on the first step (`configure`). Uses `variant="ghost"` and left-arrow icon.
- **Cancel button:** Closes the dialog entirely with a confirmation if form data has been entered. Uses `variant="outline"` text "Cancel". Placed in the `DialogFooter` alongside Back and Continue.

**Footer layout:**

```
┌─────────────────────────────────────────────┐
│  [← Back]              [Cancel] [Continue →]│
└─────────────────────────────────────────────┘
```

On the first step, Back is hidden. On the last step ("Bind"), Continue becomes "Done."

---

### Phase 7: Binding Permissions

#### 7.1 Schema Changes

**File:** `packages/shared/src/relay-adapter-schemas.ts`

Add three permission fields to `AdapterBindingSchema`:

```typescript
export const AdapterBindingSchema = z
  .object({
    id: z.string().uuid(),
    adapterId: z.string(),
    agentId: z.string(),
    chatId: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    sessionStrategy: SessionStrategySchema.default('per-chat'),
    label: z.string().default(''),
    canInitiate: z.boolean().default(false),
    canReply: z.boolean().default(true),
    canReceive: z.boolean().default(true),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('AdapterBinding');
```

**Field semantics:**

| Field | Default | Meaning |
|-------|---------|---------|
| `canInitiate` | `false` | Agent can send unprompted messages to external platform. Conservative default prevents overnight spam. |
| `canReply` | `true` | Agent can respond when a human sends a message through the adapter. |
| `canReceive` | `true` | Inbound messages from the adapter are delivered to the agent. |

All fields have defaults, making this a backward-compatible schema addition. Existing bindings stored on disk will parse correctly with Zod defaults applied.

The `CreateBindingRequestSchema` already uses `.omit()` on `id`, `createdAt`, `updatedAt` — the new fields with defaults will be included automatically.

#### 7.2 Server Enforcement in BindingRouter

**File:** `apps/server/src/services/relay/binding-router.ts`

Add permission checks at the two routing decision points:

**Inbound routing (human to agent):** Before delivering an inbound message, check `canReceive` on the resolved binding:

```typescript
// In the relay.human.* subscription handler:
const binding = this.deps.bindingStore.resolve(adapterId, chatId, channelType);
if (!binding) return; // no binding, drop message

if (!binding.canReceive) {
  logger.debug('[BindingRouter] Dropping inbound — canReceive=false for binding %s', binding.id);
  return;
}
```

**Outbound routing (agent to human):** Before forwarding an agent response, check `canReply`:

```typescript
// In the relay.agent.* subscription handler:
if (!binding.canReply) {
  logger.debug('[BindingRouter] Dropping reply — canReply=false for binding %s', binding.id);
  return;
}
```

**Agent-initiated messages:** Before allowing an agent to publish to `relay.human.*` without a preceding inbound message, check `canInitiate`:

```typescript
// When an agent publishes to relay.human.* with no inbound context:
if (!binding.canInitiate) {
  logger.warn('[BindingRouter] Blocked agent-initiated message — canInitiate=false for binding %s', binding.id);
  // Dead-letter the message instead of silently dropping
  return;
}
```

#### 7.3 Binding Dialog Permissions Section

**File:** `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`

Add a collapsible "Advanced" section below the existing binding fields. This section contains:

1. **Permissions toggles:**
   - "Allow agent to initiate messages" (maps to `canInitiate`, default off)
   - "Allow agent to reply" (maps to `canReply`, default on)
   - "Receive inbound messages" (maps to `canReceive`, default on)

2. **Session strategy selector** (moved from always-visible to inside Advanced)

The Advanced section is collapsed by default. Uses shadcn `Collapsible` primitive:

```tsx
<Collapsible>
  <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <ChevronRight className="size-3 transition-transform data-[state=open]:rotate-90" />
    Advanced
  </CollapsibleTrigger>
  <CollapsibleContent className="space-y-3 pt-3">
    {/* Permission toggles */}
    {/* Session strategy selector */}
  </CollapsibleContent>
</Collapsible>
```

#### 7.4 AdapterCard Permission Indicators

**File:** `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`

In each binding row within the AdapterCard, show permission indicators only when they deviate from defaults:

- `canInitiate: true` shows a small shield icon with tooltip "Can initiate messages"
- `canReply: false` shows a muted badge "Reply disabled"
- `canReceive: false` shows a muted badge "Receive disabled"

When all permissions are at their defaults, show nothing — no noise.

Similarly, the session strategy badge ("Per Chat") is hidden when it matches the default (`per-chat`). Only non-default strategies show a badge.

---

### Phase 8: Cleanup

#### 8.1 Orphan Binding Auto-Cleanup

**File:** `apps/server/src/services/relay/adapter-manager.ts`

When `removeAdapter()` is called, automatically delete all bindings that reference the removed adapter's ID:

```typescript
async removeAdapter(id: string): Promise<void> {
  // ... existing adapter removal logic ...

  // Clean orphan bindings
  const orphanBindings = this.bindingStore.list().filter((b) => b.adapterId === id);
  for (const binding of orphanBindings) {
    this.bindingStore.remove(binding.id);
  }
  if (orphanBindings.length > 0) {
    logger.info('[AdapterManager] Cleaned %d orphan bindings for removed adapter %s', orphanBindings.length, id);
  }
}
```

Currently, orphan bindings are warned about in logs but left in place. Stale bindings confuse routing and accumulate as clutter.

#### 8.2 Remove Legacy Field Stripping

**File:** `apps/server/src/services/relay/binding-store.ts`

Remove any code that strips `projectPath` and `agentDir` fields from bindings. These legacy fields were part of the pre-ADR-0043 binding format. The migration is complete and the stripping logic is dead code.

#### 8.3 Delete Removed Components

Delete the following files after all imports have been removed:

| File | Reason |
|------|--------|
| `apps/client/src/layers/features/relay/ui/BindingList.tsx` | Bindings shown inline in AdapterCard; standalone list is redundant |
| `apps/client/src/layers/features/relay/ui/EndpointList.tsx` | Endpoints tab removed; endpoints are an implementation detail |
| `apps/client/src/layers/features/relay/ui/InboxView.tsx` | Part of Endpoints tab; removed with it |

#### 8.4 Update Specs Manifest

**File:** `specs/manifest.json`

Update the manifest entries for superseded specs:

- Spec #68 (`relay-ux-elevation`): Set `status` to `"superseded"`, add `"superseded-by": 132`
- Spec #120 (`adapter-binding-ux-overhaul`): Set `status` to `"superseded"`, add `"superseded-by": 132`
- Spec #132 (`relay-panel-redesign`): Add entry with `status: "specified"`

---

## File Change Summary

### Client — Modified

| File | Change |
|------|--------|
| `features/relay/ui/RelayPanel.tsx` | 4 tabs to 2, Mode A/B, extract AdaptersTab, remove endpoint/binding state |
| `features/relay/ui/RelayHealthBar.tsx` | Semantic status indicator (healthy/degraded/critical) |
| `features/relay/ui/DeadLetterSection.tsx` | Aggregated failure cards, dismiss/view-sample actions |
| `features/relay/ui/ActivityFeed.tsx` | Dead letters as filter toggle, activity empty state |
| `features/relay/ui/RelayEmptyState.tsx` | Updated copy (what/why/next), wired into Mode A |
| `features/relay/ui/AdapterSetupWizard.tsx` | Remove adapter ID field, add Back/Cancel buttons |
| `features/relay/ui/wizard/StepIndicator.tsx` | Visual stepper (active/complete/pending states) |
| `features/relay/ui/wizard/ConfigureStep.tsx` | Remove adapter ID field from rendered fields |
| `features/relay/ui/AdapterCard.tsx` | Permission indicators, hide default session badge |
| `features/relay/ui/ConversationRow.tsx` | Fix `extractAdapterId` regex |
| `features/mesh/ui/BindingDialog.tsx` | Add Advanced section with permissions + session strategy |
| `entities/relay/model/use-relay-event-stream.ts` | SSE injects into `['relay', 'conversations']` |
| `entities/relay/model/use-adapter-catalog.ts` | Remove duplicate toast from `useAddAdapter` |
| `entities/relay/model/use-dead-letters.ts` | Add `useAggregatedDeadLetters` hook, `AggregatedDeadLetter` type |
| `features/relay/index.ts` | Update barrel exports |

### Client — New

| File | Purpose |
|------|---------|
| `features/relay/ui/ConnectionsTab.tsx` | Extracted from RelayPanel's inner `AdaptersTab` function |

### Client — Deleted

| File | Reason |
|------|--------|
| `features/relay/ui/BindingList.tsx` | Redundant with inline AdapterCard bindings |
| `features/relay/ui/EndpointList.tsx` | Endpoints tab removed |
| `features/relay/ui/InboxView.tsx` | Part of removed Endpoints tab |

### Server — Modified

| File | Change |
|------|--------|
| `services/relay/trace-store.ts` | Add `since` param to `getMetrics()` for 24h date filter |
| `services/relay/adapter-manager.ts` | Auto-clean orphan bindings on `removeAdapter()` |
| `services/relay/binding-store.ts` | Remove legacy `projectPath`/`agentDir` field stripping |
| `services/relay/binding-router.ts` | Enforce `canInitiate`/`canReply`/`canReceive` permissions |
| `routes/relay.ts` | Add `GET /api/relay/dead-letters/aggregated`, add `DELETE /api/relay/dead-letters` |

### Shared — Modified

| File | Change |
|------|--------|
| `packages/shared/src/relay-adapter-schemas.ts` | Add `canInitiate`, `canReply`, `canReceive` to `AdapterBindingSchema` |

---

## Acceptance Criteria

### User-Visible

- [ ] Panel opens with 2 tabs (Connections, Activity), not 4
- [ ] Default tab is Connections
- [ ] Health bar shows semantic status with colored dot (green/amber/red) and human-readable text
- [ ] Health bar "today" count reflects last 24 hours, not all-time
- [ ] Dead letters show as aggregated failure cards with count, time range, source, and reason
- [ ] "View Sample" on a dead letter group shows the envelope JSON in a dialog
- [ ] "Dismiss All" on a dead letter group removes all matching dead letters
- [ ] Dead letters appear as a filter toggle on the Activity tab, not a pinned section
- [ ] Mode A (no adapters): full-bleed ghost preview with "Connect your agents" CTA, no tabs visible
- [ ] Mode B (adapters exist): full tabbed interface with health bar
- [ ] Activity tab empty state shows ghost preview and "Waiting for messages" guidance
- [ ] Wizard no longer asks for Adapter ID
- [ ] Wizard has a proper visual step indicator (filled/outlined circles, not em-dashes)
- [ ] Wizard has Back button on steps 2-4 and Cancel button on all steps
- [ ] Session strategy is hidden under "Advanced" toggle in binding creation
- [ ] Session badge only appears on binding rows when strategy is non-default
- [ ] Permission indicators appear on binding rows only when non-default

### Technical

- [ ] SSE events trigger Activity Feed updates without 5-second polling delay
- [ ] No double toast on adapter add
- [ ] `extractAdapterId` correctly parses `relay.human.<platform>.<chatId>` subjects
- [ ] Binding permissions (`canInitiate`, `canReply`, `canReceive`) enforced server-side in BindingRouter
- [ ] Orphan bindings auto-cleaned when adapter is removed
- [ ] New aggregated dead letter endpoint returns grouped data
- [ ] Binding schema additions are backward compatible (all new fields have defaults)
- [ ] Existing bindings on disk parse correctly with Zod defaults
- [ ] `BindingList.tsx`, `EndpointList.tsx`, `InboxView.tsx` deleted with no remaining imports

### Non-Regression

- [ ] Adapter Setup Wizard works for Telegram, Slack, Webhook (existing ConfigField system unaffected)
- [ ] Existing bindings preserved across schema migration (additive fields with defaults)
- [ ] Topology graph unaffected (separate feature, separate panel)
- [ ] Sidebar Connections view unaffected (ADR-0107, reads from same data but renders independently)
- [ ] Obsidian plugin DirectTransport interface unaffected (Relay is HTTP transport only)
- [ ] All existing tests pass
- [ ] `DeliveryMetricsDashboard` dialog still accessible from health bar chart icon

### New Tests Required

- [ ] `trace-store.test.ts`: `getMetrics()` with date filter — spans older than 24h excluded
- [ ] `binding-router.test.ts`: Permission enforcement — `canInitiate=false` blocks agent-initiated, `canReply=false` blocks responses, `canReceive=false` drops inbound
- [ ] `binding-store.test.ts`: Schema migration — existing bindings without permission fields parse with correct defaults
- [ ] `adapter-manager.test.ts`: Orphan binding cleanup on adapter removal
- [ ] `relay.test.ts` (routes): Aggregated dead letter endpoint returns grouped results
- [ ] `RelayPanel.test.tsx`: Mode A/B transition — no adapters shows empty state, adapters shows tabs
- [ ] `RelayHealthBar.test.tsx`: Semantic status computation — healthy/degraded/critical thresholds
- [ ] `DeadLetterSection.test.tsx`: Aggregated cards render with correct counts and actions

---

## Implementation Order

The phases are designed to be implementable sequentially with each phase leaving the system in a shippable state:

1. **Phase 1 (P0 Bug Fixes)** — Can ship independently. Fixes trust-destroying data bugs.
2. **Phase 2 (Tab Restructure)** — Depends on nothing. Removes components and restructures tabs.
3. **Phase 3 (Health Bar)** — Depends on Phase 1 (accurate metrics). Redesigns the status indicator.
4. **Phase 4 (Dead Letters)** — Independent. New endpoint + client redesign.
5. **Phase 5 (Empty States)** — Depends on Phase 2 (two-tab structure). Wires Mode A/B.
6. **Phase 6 (Wizard)** — Independent. Light-touch refinements.
7. **Phase 7 (Permissions)** — Independent. Schema + server + client changes.
8. **Phase 8 (Cleanup)** — Depends on Phases 2, 7. Removes dead code and legacy patterns.

Phases 1, 4, 6, and 7 can be developed in parallel. Phase 8 is a final sweep after all other phases merge.

---

## Open Questions

None. All decisions were resolved during ideation and clarification phases. See [01-ideation.md](./01-ideation.md) Section 6 (Decisions) for the full decision log.
