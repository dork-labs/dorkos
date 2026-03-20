# Relay Panel UX Fixes — Binding CRUD, Health Bar, Activity Feed

**Status:** Draft
**Authors:** Claude Code, 2026-03-15
**Spec Number:** 134
**Ideation:** `specs/relay-panel-ux-fixes/01-ideation.md`
**Predecessor:** Spec #132 (relay-panel-redesign) — implemented

---

## Overview

The relay-panel-redesign (#132) consolidated four tabs into two (Connections + Activity) and established Mode A/B progressive disclosure. The visual simplification was correct, but the implementation left three critical gaps: binding CRUD was removed entirely (AdapterCard is read-only), the health bar click handler is broken (scrolls to a hidden section), and the Activity tab contradicts the health bar metrics (empty feed vs. "3,852 failed"). This spec restores the missing functionality, fixes broken interactions, and polishes the UX across the entire Relay dialog.

## Background / Problem Statement

### Critical Gaps (P0)

1. **Binding CRUD is gone.** The redesign deleted the standalone Bindings tab because "bindings shown inline in AdapterCard; standalone list is redundant." But AdapterCard only _displays_ binding rows — it has no create, edit, or delete actions. `BindingList.tsx` (full CRUD) exists but nothing imports it. `BindingDialog.tsx` supports create+edit modes but is only reachable from `ConversationRow`'s route popover, not from `AdapterCard`. Users who configured an adapter and skipped the wizard bind step can never add a binding afterward (except through dead letter routing).

2. **Health bar click → empty screen.** `handleFailedClick` in `RelayPanel.tsx` sets `activeTab='activity'` and calls `deadLetterRef.current?.scrollIntoView()`, but the `DeadLetterSection` only renders when `showFailures` is `true` (defaults to `false`). The ref target doesn't exist in the DOM when `scrollIntoView` fires.

3. **Activity tab empty when metrics show data.** `useRelayConversations` (5s polling) returns conversations from the server, but `useDeliveryMetrics` (30s polling) reports aggregate counters from a separate source. When the Activity tab is empty while the health bar says "85% failure rate," the two surfaces contradict each other.

### UX Issues (P1)

4. **"Failed" filter vs. "Failures" button.** Two controls with near-identical names operate on different data (conversations vs. dead letters). Users don't know the difference.

5. **Dialog title says "Relay."** A system concept, not a user concept. Doesn't orient the user.

6. **DeliveryMetrics in a dialog-on-dialog.** The BarChart3 icon button (24×24px) opens a metrics dashboard dialog on top of the already-open relay dialog. Data exists in a place users won't find it.

7. **Dead letters hidden behind toggle.** The Failures section is collapsed by default. Hiding known failures behind a toggle is hiding the fire alarm behind a cabinet door.

### Polish (P2)

8. "No agent bound" amber text has no CTA.
9. Activity empty state says "Waiting for messages" with a "Set up an adapter" CTA (wrong when adapters are configured).
10. "Dismiss All" has no confirmation — one click permanently removes dead letters.
11. Route popover doesn't show existing bindings, risking duplicates.

## Goals

- Restore full binding CRUD accessible from AdapterCard (create, edit, delete)
- Fix health bar click to navigate to Activity tab AND auto-open dead letter section
- Resolve the Activity tab / health bar data contradiction
- Eliminate "Failed" vs. "Failures" confusion
- Move delivery metrics inline to the Activity tab
- Auto-show dead letters when they exist
- Rename dialog title from "Relay" to "Connections"
- Polish empty states, confirmation dialogs, and duplicate prevention

## Non-Goals

- Changing the adapter setup wizard flow (works fine for initial setup)
- Server-side changes to conversation persistence (if SSE-only, we update the UI to be honest about it)
- Binding resolution logic changes (ADR-0047 most-specific-first is fine)
- Modifying the `ConnectionStatusBanner` or `AdapterEventLog` (well-designed)
- Changing the health computation thresholds in `computeHealthState()`
- Adding multi-binding batch operations

## Technical Dependencies

- React 19, Tailwind CSS 4, shadcn/ui (new-york style)
- motion library for animations
- TanStack Query for server state
- Existing entity hooks: `useCreateBinding`, `useUpdateBinding`, `useDeleteBinding`, `useBindings`
- Existing `BindingDialog` component (453 lines, create+edit modes)
- Existing `useDeliveryMetrics`, `useAggregatedDeadLetters` hooks

## Detailed Design

### 1. Binding CRUD from AdapterCard (P0)

**Current state:** AdapterCard renders up to 3 `AdapterBindingRow` components read-only, with an overflow indicator "and X more." Kebab menu has Events, Configure, Remove — no binding management.

**Changes to `AdapterCard.tsx`:**

Add binding management state:

```typescript
const [bindingDialogOpen, setBindingDialogOpen] = useState(false);
const [bindingDialogMode, setBindingDialogMode] = useState<'create' | 'edit'>('create');
const [editingBinding, setEditingBinding] = useState<Binding | null>(null);
const [showAllBindings, setShowAllBindings] = useState(false);
```

Add binding CRUD hooks:

```typescript
const createBinding = useCreateBinding();
const updateBinding = useUpdateBinding();
const deleteBinding = useDeleteBinding();
```

**Kebab menu addition** — add "Manage Bindings" item with `Link2` icon after "Events":

```typescript
<DropdownMenuItem onClick={() => {
  setBindingDialogMode('create');
  setEditingBinding(null);
  setBindingDialogOpen(true);
}}>
  <Link2 className="mr-2 size-4" />
  Add Binding
</DropdownMenuItem>
```

**Make AdapterBindingRow clickable** — wrap each row in a button that opens BindingDialog in edit mode:

```typescript
<button
  type="button"
  className="group/row flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/50"
  onClick={() => {
    setEditingBinding(binding);
    setBindingDialogMode('edit');
    setBindingDialogOpen(true);
  }}
>
  <AdapterBindingRow {...rowProps} />
</button>
```

**Add "+" button** after the binding rows:

```typescript
<Button
  variant="ghost"
  size="sm"
  className="mt-1 h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
  onClick={() => {
    setBindingDialogMode('create');
    setEditingBinding(null);
    setBindingDialogOpen(true);
  }}
>
  <Plus className="size-3" />
  Add binding
</Button>
```

**Make "and X more" clickable** — toggle `showAllBindings` state:

```typescript
<button
  type="button"
  className="mt-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
  onClick={() => setShowAllBindings(true)}
>
  and {overflowCount} more
</button>
```

When `showAllBindings` is true, render all `boundAgentRows` instead of slicing to `MAX_VISIBLE_BINDINGS`. Add a "Show less" button to collapse back.

**Replace "No agent bound" amber text** with an actionable CTA:

```typescript
{!effectiveHasBindings && instance.status === 'connected' && (
  <Button
    variant="ghost"
    size="sm"
    className="mt-1 h-6 gap-1 px-2 text-xs text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:text-amber-500 dark:hover:bg-amber-950"
    onClick={() => {
      setBindingDialogMode('create');
      setEditingBinding(null);
      setBindingDialogOpen(true);
    }}
  >
    <Plus className="size-3" />
    Add binding
  </Button>
)}
```

**Render BindingDialog** at the bottom of AdapterCard:

```typescript
<BindingDialog
  open={bindingDialogOpen}
  onOpenChange={setBindingDialogOpen}
  mode={bindingDialogMode}
  initialValues={
    bindingDialogMode === 'edit' && editingBinding
      ? {
          adapterId: editingBinding.adapterId,
          agentId: editingBinding.agentId,
          sessionStrategy: editingBinding.sessionStrategy,
          label: editingBinding.label ?? '',
          chatId: editingBinding.chatId,
          channelType: editingBinding.channelType,
          canInitiate: editingBinding.canInitiate,
          canReply: editingBinding.canReply,
          canReceive: editingBinding.canReceive,
        }
      : { adapterId: instance.id }
  }
  adapterName={manifest.displayName}
  agentName={editingBinding ? lookupAgentName(editingBinding.agentId) : undefined}
  onConfirm={(values) => {
    if (bindingDialogMode === 'edit' && editingBinding) {
      updateBinding.mutate({ id: editingBinding.id, ...values });
    } else {
      createBinding.mutate(values);
    }
    setBindingDialogOpen(false);
  }}
/>
```

**Add delete action** — each binding row gets a delete button on hover (or in the BindingDialog edit mode as a footer action). The BindingDialog edit mode should include a "Delete binding" destructive button:

```typescript
// In the BindingDialog footer, when mode === 'edit':
<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
      <Trash2 className="mr-1.5 size-3.5" />
      Delete
    </Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete binding?</AlertDialogTitle>
      <AlertDialogDescription>
        This will disconnect {adapterName} from {agentName}. Messages will no longer be routed.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={() => onDelete?.(editingBinding.id)}>
        Delete
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Note:** The delete action requires extending `BindingDialog` props with an optional `onDelete?: (bindingId: string) => void` prop that only renders in edit mode.

**Clean up dead code:** Delete `BindingList.tsx` — its CRUD patterns are now handled inline by AdapterCard + BindingDialog. Verify no imports remain.

### 2. Health Bar Click → Auto-Open Failures (P0)

**Current state:** `RelayPanel.handleFailedClick` sets `activeTab='activity'` and scrolls to `deadLetterRef`, but `showFailures` is internal state of `ActivityFeed` and defaults to `false`.

**Fix:** Lift the "auto-show failures" signal from RelayPanel to ActivityFeed via a prop.

**Changes to `ActivityFeed.tsx`:**

Add prop:

```typescript
interface ActivityFeedProps {
  enabled: boolean;
  deadLetterRef?: RefObject<HTMLDivElement | null>;
  onSwitchToAdapters?: () => void;
  autoShowFailures?: boolean; // NEW: signal from health bar click
}
```

Use an effect to respond to the signal:

```typescript
useEffect(() => {
  if (autoShowFailures) {
    setShowFailures(true);
  }
}, [autoShowFailures]);
```

**Changes to `RelayPanel.tsx`:**

Add state and pass it through:

```typescript
const [autoShowFailures, setAutoShowFailures] = useState(false);

const handleFailedClick = useCallback(() => {
  setActiveTab('activity');
  setAutoShowFailures(true);
  // Reset after a tick so it can be triggered again
  setTimeout(() => setAutoShowFailures(false), 100);
  // Scroll deferred to allow section to mount
  setTimeout(() => {
    deadLetterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
}, []);
```

Pass to ActivityFeed:

```typescript
<ActivityFeed
  enabled={relayEnabled}
  deadLetterRef={deadLetterRef}
  autoShowFailures={autoShowFailures}
  onSwitchToAdapters={() => setActiveTab('connections')}
/>
```

### 3. Activity Tab Data Consistency (P0)

**Investigation approach:** The `useRelayConversations` hook calls `transport.listRelayConversations()`. The `useDeliveryMetrics` hook calls `transport.getRelayDeliveryMetrics()`. If the conversations endpoint only returns conversations observed during the current SSE session (not persisted), while metrics aggregate from the relay bus (persisted counters), there will be a permanent disconnect.

**Server-side check required:** Read the server route handler for `GET /api/relay/conversations` and `GET /api/relay/metrics` to determine:

- Are conversations persisted in SQLite or in-memory only?
- Does the conversations endpoint serve historical data?
- What is the lifecycle of a conversation record?

**If conversations are in-memory / SSE-only:**

Update the Activity tab empty state to be honest about this:

```typescript
// When no conversations AND metrics show activity:
<div className="flex flex-col items-center gap-2 py-8 text-center">
  <Radio className="size-5 text-muted-foreground" />
  <p className="text-sm font-medium">Live activity monitor</p>
  <p className="text-xs text-muted-foreground">
    Messages appear here in real time as your agents communicate
  </p>
</div>
```

**If conversations ARE persisted but the query is wrong:**

Fix the server endpoint or query params to return historical data.

**Either way:** The empty state must not contradict the health bar. If metrics show data and conversations are empty, the UI must explain why (different data sources, real-time vs. historical).

### 4. Merge "Failed" Filter and "Failures" Toggle Confusion (P1)

**Current state:**

- Status dropdown: "Failed" option filters conversations to `status === 'failed'`
- "Failures" button: toggles `DeadLetterSection` visibility

**Changes:**

Rename the toggle button from "Failures" to "Dead Letters" for clarity:

```typescript
<Button
  variant={showFailures ? 'secondary' : 'ghost'}
  size="sm"
  className="gap-1.5"
  onClick={() => setShowFailures(!showFailures)}
>
  <AlertTriangle className="size-3.5" />
  Dead Letters
  {deadLetterGroups.length > 0 && !showFailures && (
    <span className="size-1.5 rounded-full bg-red-500" />
  )}
</Button>
```

This keeps the two controls separate (they operate on genuinely different data) but gives them distinct names so users understand the difference. "Failed" = delivery failures (conversations). "Dead Letters" = rejected messages (never routed).

### 5. Dialog Title: "Relay" → "Connections" (P1)

**Changes to `DialogHost.tsx`:**

```typescript
<ResponsiveDialogTitle className="text-sm font-medium">
  Connections
</ResponsiveDialogTitle>
<ResponsiveDialogDescription className="sr-only">
  Manage adapters and monitor message activity
</ResponsiveDialogDescription>
```

### 6. Move DeliveryMetrics Inline to Activity Tab (P1)

**Remove from `RelayHealthBar.tsx`:**

- Delete the `Dialog`/`DialogTrigger`/`DialogContent` wrapping `DeliveryMetricsDashboard`
- Delete the BarChart3 icon button
- Delete the `metricsOpen` state
- Keep the existing tooltip on the healthy state (it already shows key metrics)

**Create `MetricsSummary` inline component** in `ActivityFeed.tsx` (or extract to a separate file `MetricsSummary.tsx`):

```typescript
function MetricsSummary({ enabled }: { enabled: boolean }) {
  const { data: metrics } = useDeliveryMetrics();
  if (!metrics) return null;

  const pills = [
    { label: 'Total', value: metrics.total, variant: 'default' as const },
    { label: 'Delivered', value: metrics.delivered, variant: 'success' as const },
    { label: 'Failed', value: metrics.failed, variant: metrics.failed > 0 ? 'danger' as const : 'default' as const },
    { label: 'Dead Letter', value: metrics.deadLetter, variant: metrics.deadLetter > 0 ? 'warning' as const : 'default' as const },
  ];

  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      {pills.map(({ label, value, variant }) => (
        <div key={label} className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className={cn(
            'font-medium tabular-nums',
            variant === 'success' && value > 0 && 'text-green-600 dark:text-green-500',
            variant === 'danger' && 'text-red-600 dark:text-red-500',
            variant === 'warning' && 'text-amber-600 dark:text-amber-500',
          )}>
            {value.toLocaleString()}
          </span>
        </div>
      ))}
      {metrics.avgLatency != null && (
        <div className="ml-auto flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Avg</span>
          <span className="font-medium tabular-nums">
            {metrics.avgLatency < 1000 ? `${Math.round(metrics.avgLatency)}ms` : `${(metrics.avgLatency / 1000).toFixed(1)}s`}
          </span>
        </div>
      )}
    </div>
  );
}
```

Render at the top of ActivityFeed, above the filter bar:

```typescript
<MetricsSummary enabled={enabled} />
```

**Budget rejections** — move from the deleted DeliveryMetrics dialog to DeadLetterSection. Add a summary row at the top of DeadLetterSection showing budget rejection counts when non-zero:

```typescript
{budgetRejections && Object.values(budgetRejections).some(v => v > 0) && (
  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950">
    <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
      Budget rejections: {budgetRejections.hop_limit} hop limit, {budgetRejections.cycle_detected} cycles, {budgetRejections.budget_exhausted} budget, {budgetRejections.ttl_expired} TTL
    </p>
  </div>
)}
```

**Clean up:** After moving metrics inline, `DeliveryMetrics.tsx` can be deleted or refactored into the `MetricsSummary` component.

### 7. Dead Letters Visible by Default When They Exist (P1)

**Changes to `ActivityFeed.tsx`:**

Replace the simple boolean state with a computed initial value:

```typescript
const { data: deadLetterGroups = [] } = useAggregatedDeadLetters(enabled);
const [showFailures, setShowFailures] = useState(false);
const [userToggled, setUserToggled] = useState(false);

// Auto-show when dead letters exist (unless user explicitly closed)
useEffect(() => {
  if (!userToggled && deadLetterGroups.length > 0) {
    setShowFailures(true);
  }
}, [deadLetterGroups.length, userToggled]);
```

Update the toggle button to track user intent:

```typescript
onClick={() => {
  setShowFailures(!showFailures);
  setUserToggled(true);
}}
```

The red dot badge should now indicate "new dead letters since user last viewed" rather than "section is closed":

```typescript
// Only show badge when section is manually closed and new dead letters arrived
{deadLetterGroups.length > 0 && !showFailures && userToggled && (
  <span className="size-1.5 rounded-full bg-red-500" />
)}
```

### 8. AdapterCard "No agent bound" → "Add binding" CTA (P2)

Covered in section 1 above — the amber text is replaced with an "Add binding" button that opens BindingDialog in create mode with `adapterId` pre-filled.

### 9. Activity Empty State Copy (P2)

**Changes to `ActivityFeed.tsx` empty state (lines 192-233):**

When adapters are configured (Mode B) but no conversations exist:

```typescript
<div className="flex flex-col items-center gap-2 py-8 text-center">
  <Inbox className="size-5 text-muted-foreground" />
  <p className="text-sm font-medium">No activity yet</p>
  <p className="text-xs text-muted-foreground">
    Messages will appear here as your agents communicate
  </p>
</div>
```

Remove the "Set up an adapter" CTA from this state — it's misleading when adapters are already configured.

### 10. "Dismiss All" Confirmation Dialog (P2)

**Changes to `DeadLetterSection.tsx`:**

Wrap the dismiss button with an `AlertDialog`:

```typescript
<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
      <Trash2 className="size-3.5" />
      Mark Resolved
    </Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Mark dead letters as resolved?</AlertDialogTitle>
      <AlertDialogDescription>
        This will dismiss {group.count} dead letter{group.count !== 1 ? 's' : ''} from{' '}
        <span className="font-medium">{group.source}</span> ({group.reason}).
        This action cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onClick={() => dismissMutation.mutate({
          source: group.source,
          reason: group.reason,
        })}
      >
        Mark Resolved
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Rename from "Dismiss All" to "Mark Resolved" — less destructive language for a destructive action.

### 11. Conversation Row Route Popover — Show Existing Bindings (P2)

**Changes to `ConversationRow.tsx` route popover:**

Before the agent selector, check if a binding already exists for this adapter:

```typescript
const { data: allBindings = [] } = useBindings();
const existingBindings = allBindings.filter(b => b.adapterId === extractedAdapterId);

// In the popover content:
{existingBindings.length > 0 && (
  <div className="mb-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs dark:border-blue-900 dark:bg-blue-950">
    <p className="font-medium text-blue-800 dark:text-blue-200">
      {existingBindings.length} binding{existingBindings.length !== 1 ? 's' : ''} already exist{existingBindings.length === 1 ? 's' : ''} for this adapter
    </p>
  </div>
)}
```

## User Experience

### Before (Current)

1. User opens Relay dialog → sees "Relay" title
2. Adapter card shows bindings but user cannot add/edit/delete them
3. Health bar shows "85% failure rate" → user clicks → sees empty Activity tab
4. User sees "Failures" button and "Failed" filter, confused about the difference
5. User never discovers the metrics icon (24px BarChart3)
6. Dead letters hidden behind toggle

### After (Fixed)

1. User opens dialog → sees "Connections" title (clear intent)
2. Adapter card: click any binding row to edit, "+" to add, kebab menu for management
3. Health bar click → Activity tab opens → dead letter section auto-expands → scrolls to failures
4. "Dead Letters" button (renamed) is distinct from "Failed" status filter
5. Metrics summary visible at top of Activity tab (Total | Delivered | Failed | Dead Letter | Avg latency)
6. Dead letters auto-shown when they exist, user can collapse manually

### Binding Management Flow

```
AdapterCard (connected, no bindings)
  └→ "Add binding" CTA button
      └→ BindingDialog (create mode, adapterId pre-filled)
          └→ Select agent → Set session strategy → Optional: chat filter, permissions
              └→ Confirm → binding created → AdapterCard updates

AdapterCard (has bindings)
  └→ Click any binding row
      └→ BindingDialog (edit mode, all fields populated)
          └→ Modify settings → Confirm → binding updated
          └→ Or: "Delete" → confirmation → binding removed

AdapterCard kebab menu
  └→ "Add Binding" → BindingDialog (create mode)
```

## Testing Strategy

### Unit Tests

**AdapterCard binding interactions:**

- Renders "Add binding" CTA when connected but no bindings
- Clicking binding row opens BindingDialog in edit mode with correct initial values
- "+" button opens BindingDialog in create mode with adapterId pre-filled
- "and X more" click shows all bindings
- Delete confirmation dialog prevents accidental deletion

**ActivityFeed auto-show failures:**

- `autoShowFailures` prop triggers `showFailures = true`
- Dead letters auto-show when `useAggregatedDeadLetters` returns non-empty groups
- User toggle overrides auto-show behavior
- Red dot badge only shows when user manually closed section

**MetricsSummary:**

- Renders all 4 metric pills with correct colors
- Hides when no metrics available
- Failed/dead letter counts use danger/warning colors only when > 0

**DeadLetterSection confirmation:**

- "Mark Resolved" button opens confirmation dialog
- Cancel does not dismiss dead letters
- Confirm calls `useDismissDeadLetterGroup` mutation

### Integration Tests

**Health bar → dead letters flow:**

- Click degraded/critical health bar message
- Verify tab switches to Activity
- Verify dead letter section is visible
- Verify scroll position targets dead letter section

**Binding CRUD round-trip:**

- Create binding from AdapterCard → verify it appears in binding rows
- Edit binding → verify changes reflected
- Delete binding → verify removal from display

### Mocking Strategy

- Mock `useBindings`, `useCreateBinding`, `useUpdateBinding`, `useDeleteBinding` from `entities/binding`
- Mock `useDeliveryMetrics` for MetricsSummary tests
- Mock `useAggregatedDeadLetters` for auto-show behavior tests
- Use `createMockTransport()` from `@dorkos/test-utils` for TransportProvider

## Performance Considerations

- **No new API calls.** All data sources already exist (`useBindings`, `useDeliveryMetrics`, `useAggregatedDeadLetters`). MetricsSummary reuses the same `useDeliveryMetrics` query key, so TanStack Query deduplicates.
- **BindingDialog lazy rendering.** The dialog component (453 lines) is only mounted when `bindingDialogOpen` is true, avoiding unnecessary DOM in the common case.
- **Dead letter auto-show effect.** The `useEffect` for auto-showing dead letters runs only when `deadLetterGroups.length` changes, not on every render.

## Security Considerations

- Binding CRUD uses the same mutation hooks already used by ConversationRow routing — no new attack surface.
- Delete confirmation prevents accidental data loss.
- No new user input surfaces beyond what BindingDialog already validates.

## Implementation Phases

### Phase 1: Critical Fixes (P0)

1. **Binding CRUD on AdapterCard** — Add BindingDialog integration, clickable rows, "+" button, "Add binding" CTA
2. **Health bar click fix** — Pass `autoShowFailures` prop through to ActivityFeed
3. **Activity data consistency** — Investigate server-side, update empty state copy
4. **Delete BindingList.tsx** — Remove dead code

### Phase 2: UX Improvements (P1)

5. **Rename "Failures" → "Dead Letters"** button
6. **Dialog title** — "Relay" → "Connections"
7. **Inline MetricsSummary** — Create component, add to ActivityFeed, remove dialog-on-dialog from RelayHealthBar
8. **Auto-show dead letters** — Computed initial state with user override

### Phase 3: Polish (P2)

9. **Activity empty state copy** — Updated messaging
10. **Dismiss confirmation** — AlertDialog on DeadLetterSection
11. **Route popover existing bindings** — Show info note in ConversationRow

## Open Questions

1. ~~**Activity tab data source**~~ (RESOLVED)
   **Answer:** Investigate during Phase 1. If conversations are SSE-only (not persisted), update the empty state to be honest about real-time-only monitoring. If persisted, fix the query.

2. **BindingDialog delete action placement**
   - Option A: Add "Delete" button to BindingDialog footer in edit mode (Recommended — keeps all binding actions in one place)
   - Option B: Add delete icon on each AdapterBindingRow hover state
   - Option C: Both A and B
   - Recommendation: Option A — single dialog for all CRUD operations

3. **MetricsSummary latency display**
   - Option A: Show avg latency only (compact)
   - Option B: Show avg + P95 latency (more detail)
   - Recommendation: Option A — P95 is in the health bar tooltip for those who need it

## Related ADRs

- **ADR-0046:** Central BindingRouter for adapter-agent routing — informs binding creation flow
- **ADR-0047:** Most-specific-first binding resolution — scoring affects how new bindings match
- **ADR-0133:** Semantic health status over raw metrics — health bar design decisions

## References

- Ideation: `specs/relay-panel-ux-fixes/01-ideation.md` (Steve Jobs / Jony Ive design critique)
- Predecessor: Spec #132 `specs/relay-panel-redesign/02-specification.md`
- BindingDialog: `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`
- AdapterCard: `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`
- Entity hooks: `apps/client/src/layers/entities/binding/`
- Status colors: `apps/client/src/layers/features/relay/lib/status-colors.ts`

## Changelog

- 2026-03-15: Initial specification created from design critique #134
