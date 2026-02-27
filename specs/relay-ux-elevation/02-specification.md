---
slug: relay-ux-elevation
number: 68
created: 2026-02-27
status: draft
---

# Specification: Relay UX Elevation

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-27

---

## Overview

Elevate the Relay panel UI/UX from functional to world-class. This specification addresses the highest-impact gaps identified in a deep UX review: missing system health narrative, orphaned components that exist but aren't mounted, zero motion animations (unique among panels), missing dead letter visibility, disconnected trace information, and inconsistent visual design language. The improvements are organized into three tiers: foundation fixes, experience elevation, and visual polish.

## Background / Problem Statement

The Relay panel is functionally complete but falls short of the polish seen in the Mesh and Pulse panels. Specific gaps:

1. **No health narrative** — Users cannot answer "is my system healthy?" at a glance. The Mesh panel has `MeshStatsHeader`; Relay has nothing equivalent.
2. **Orphaned components** — `DeliveryMetricsDashboard` exists but is never rendered. `MessageTrace` exists but isn't connected to `MessageRow`. `useSendRelayMessage` hook exists but has no compose UI.
3. **Zero motion animations** — Relay is the only major panel that uses no motion library animations. Messages snap into view, expand/collapse is instant, tab transitions have no animation.
4. **Dead letters are invisible** — The `GET /api/relay/dead-letters` endpoint exists, but there is no UI to display failed messages. The `listRelayDeadLetters()` method is missing from the Transport interface.
5. **Primitive filtering** — Only a source dropdown exists. No status filter, no subject filter, no content preview in collapsed messages.
6. **No SSE connection health** — When the EventSource disconnects, nothing is shown to the user. The hook has no error handling.
7. **Inconsistent visual language** — Status indicators vary between components (dots vs text vs badges). No unified color system for status states.
8. **Generic empty states** — Empty states show "No messages" without guiding users to their next action.

These gaps mean Kai (Autonomous Builder persona) cannot quickly assess system health, Priya (Knowledge Architect) cannot trace message delivery issues, and new users get no onboarding guidance.

## Goals

- Users can assess overall Relay health in under 1 second via a persistent health bar
- Failed messages are immediately visible without user action (dead letter section + red accents)
- Message delivery traces are accessible inline from any message row
- All motion animations follow the design system patterns used by Mesh and Pulse panels
- Empty states guide users to their next action with contextual CTAs
- SSE connection issues are clearly communicated with auto-recovery indication
- Visual design is consistent across all Relay components (unified status colors, typography hierarchy, card styles)
- The "compose test message" flow exists for debugging and onboarding

## Non-Goals

- Relay protocol changes (no new message types, no schema changes beyond Transport methods)
- Server-side performance optimization (not changing polling intervals, query patterns)
- Mobile-specific layout changes (responsive improvements are a separate effort)
- Message replay/retry functionality (noted as future aspiration)
- Subject hierarchy visualization (future work — would require new server endpoints)
- Adapter reliability diagnostics dashboard (complex feature deserving its own spec)

## Technical Dependencies

- **motion** (v12.33.0) — Already installed, used by Mesh/Pulse/Chat panels
- **lucide-react** — Already installed, used across all panels for iconography
- **TanStack Query** — Already used for all Relay entity hooks
- **shadcn/ui primitives** — Badge, Collapsible, Sheet, Dialog already available in shared/ui
- **Transport interface** — Needs `listRelayDeadLetters()` method added

No new external dependencies required.

## Detailed Design

### 1. Relay Health Bar

A compact, always-visible health summary bar above the tab list in `RelayPanel`, following the `MeshStatsHeader` pattern.

**New file:** `apps/client/src/layers/features/relay/ui/RelayHealthBar.tsx`

```tsx
interface RelayHealthBarProps {
  enabled?: boolean;
  onFailedClick?: () => void;
}
```

**Data sources:** Compose from existing hooks:
- `useAdapterCatalog()` — adapter count and connected count
- `useDeliveryMetrics()` — totalMessages, failedCount, avgDeliveryLatencyMs

**Displayed stats:**
- Adapter status: `"3/3 connected"` (green dot) or `"2/3 connected"` (amber dot)
- Message throughput: `"142 today"` — totalMessages from metrics
- Failure count: `"0 failed"` (green) or `"3 failed"` (red, clickable → scrolls to dead letters)
- Avg latency: `"45ms"` from avgDeliveryLatencyMs (hidden if null)

**Visual spec:** Follows MeshStatsHeader exactly — `flex items-center gap-3 border-b px-3 py-1.5 text-xs text-muted-foreground`. Status dots use `h-2 w-2 rounded-full` with semantic colors.

**Mounting:** In `RelayPanel.tsx`, render `<RelayHealthBar />` above the `<Tabs>` component.

### 2. Dead Letter Queue UI

**New file:** `apps/client/src/layers/features/relay/ui/DeadLetterSection.tsx`

A collapsible section at the top of `ActivityFeed` showing failed messages.

**New entity hook:** `apps/client/src/layers/entities/relay/model/use-dead-letters.ts`
```tsx
export function useDeadLetters(enabled: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['relay', 'dead-letters'],
    queryFn: () => transport.listRelayDeadLetters(),
    enabled,
    refetchInterval: 30_000,
  });
}
```

**New Transport method:** Add `listRelayDeadLetters(filters?)` to:
- `packages/shared/src/transport.ts` — interface definition
- `apps/client/src/layers/shared/lib/http-transport.ts` — `GET /api/relay/dead-letters`
- `apps/client/src/layers/shared/lib/direct-transport.ts` — delegate to RelayCore

**UI behavior:**
- Hidden when dead letter count is 0
- Collapsible with header: `"Failed Messages (3)"` with red badge count
- Each entry shows: subject (monospace), from, timestamp, rejection reason
- Red 2px left border accent on each dead letter row
- Rejection reasons displayed as colored badges: `hop_limit`, `ttl_expired`, `cycle_detected`, `budget_exhausted`

### 3. Wire MessageTrace to MessageRow

Connect the existing `MessageTrace` component to `MessageRow` interactions.

**Modify:** `apps/client/src/layers/features/relay/ui/MessageRow.tsx`

- Add an Activity icon button (lucide `Activity`) in the message row action area
- Clicking toggles inline expansion of `<MessageTrace messageId={message.id} />` below the message details
- Uses existing `useMessageTrace(messageId)` — only fetches when expanded
- Animate expand/collapse with motion (see section 5)

### 4. Mount DeliveryMetricsDashboard

The component exists at `apps/client/src/layers/features/relay/ui/DeliveryMetricsDashboard.tsx` but is never rendered.

**Option chosen:** Accessible via a "Metrics" button in the RelayHealthBar that opens a Sheet (side drawer).

**Modify:** `RelayHealthBar.tsx` — add a BarChart3 icon button that opens a `<Sheet>` containing `<DeliveryMetricsDashboard />`.

**Modify:** `RelayPanel.tsx` — no tab changes needed since we use a sheet overlay.

### 5. Motion Animations

Add motion library animations consistent with Mesh and Pulse panels.

**Message entrance** (ActivityFeed): New SSE-delivered messages animate with `initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: 'easeOut' }}`. History messages on initial load do NOT animate.

**MessageRow expand/collapse**: Wrap expandable content in `<motion.div>` with `initial={false}` and `animate={{ height: 'auto', opacity: 1 }}`. Use `<AnimatePresence>` for exit animations.

**Wizard step transitions** (AdapterSetupWizard): Cross-fade between Configure/Test/Confirm steps — `opacity: 0 → 1, 200ms`.

**Adapter status indicator**: CSS transition on status dot color, `transition-colors duration-300`.

**Tab content**: Subtle fade via `<AnimatePresence mode="wait">` on tab panels.

**Animated lists**: Wrap `ActivityFeed` message list in `<AnimatePresence>` for proper exit animations on filtered-out messages.

### 6. Enhanced Activity Feed Filters

**Modify:** `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`

Replace single source dropdown with a filter bar:

- **Source filter**: Keep existing (All/Telegram/Webhook/System)
- **Status filter**: New Select — All / Delivered / Failed / Pending
- **Subject filter**: Text Input with autocomplete from known subjects (from `useRelayEndpoints()`)
- **Content preview**: Show first ~80 chars of `payload.content` in collapsed `MessageRow` (text-sm text-muted-foreground). This eliminates most expand clicks.

Layout: Horizontal flex row with gap-2, wrapping on narrow viewports.

### 7. Endpoint Health Indicators

**Modify:** `apps/client/src/layers/features/relay/ui/EndpointList.tsx`

Enhance from bare subject strings to informative cards:

- Subject displayed in monospace font
- Message count indicator (in/out) if available from metrics
- Last activity timestamp (relative time via `formatDistanceToNow`)
- Health dot: green (healthy), amber (rate limited/high latency), red (circuit broken)
- Description text if available from endpoint registration
- Replace Radio icon with Inbox (lucide) for better semantic meaning
- Add `hover:shadow-sm transition-shadow` for card interactivity feedback

**Note:** Endpoint health data may require a server-side enhancement to include per-endpoint metrics in the `GET /api/relay/endpoints` response. If not available, show subject + description only (graceful degradation).

### 8. SSE Connection Status

**New file:** `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx`

**New hook:** `apps/client/src/layers/entities/relay/model/use-relay-connection.ts`

Extract connection state from `useRelayEventStream`:
- States: `connected` | `reconnecting` | `disconnected`
- Track via `EventSource.onerror` → `reconnecting`, `EventSource.onopen` → `connected`

**Banner behavior:**
- Hidden when connected (default state)
- Amber banner below health bar when reconnecting: "Connection lost. Reconnecting..."
- Green flash (200ms) when connection restores, then dismiss
- Red banner after 3 failed reconnection attempts: "Unable to connect. Messages may be delayed."

**Mounting:** In `RelayPanel.tsx`, render `<ConnectionStatusBanner />` between `<RelayHealthBar />` and `<Tabs>`.

### 9. Onboarding Empty States

Replace generic empty states with context-aware guided CTAs.

**Activity (no messages):**
> "No messages yet. Messages will appear here once your adapters are connected and agents start communicating."
> `[Set up an adapter →]` button that switches to Adapters tab

**Endpoints (none registered):**
> "No endpoints registered. Endpoints are created automatically when adapters subscribe to message subjects."

**Activity (filter active, no results):**
> "No messages match your filters." + `[Clear filters]` button

Each empty state uses the standard empty state pattern: centered text with muted-foreground color, icon above text, CTA button below.

### 10. Send Test Message Dialog

**New file:** `apps/client/src/layers/features/relay/ui/ComposeMessageDialog.tsx`

Triggered by a "Compose" button (PenLine icon) in the Activity tab header.

**Fields:**
- Subject (text input, required)
- From (text input, required, default: `"relay.human.console"`)
- Payload (textarea, supports JSON or plain text)

**Behavior:**
- Send button uses existing `useSendRelayMessage()` mutation
- On success: toast notification + close dialog. Message appears in feed via SSE.
- On error: inline error message in dialog, button returns to enabled state

### 11. Visual Design Refinements

**Unified status color system** (apply across ALL Relay components):

| State | Color | Usage |
|-------|-------|-------|
| healthy / delivered / connected | `text-green-500` / `bg-green-500` | Adapter connected, message delivered |
| pending / starting / new | `text-blue-500` / `bg-blue-500` | Message in transit, adapter starting |
| degraded / warning / rate-limited | `text-amber-500` / `bg-amber-500` | Partial failure, approaching limits |
| failed / error / disconnected | `text-red-500` / `bg-red-500` | Delivery failure, adapter error |
| inactive / stopped | `text-gray-400` / `bg-gray-400` | Disabled adapter, idle endpoint |

**Left border accents:** Replace tiny status dots on AdapterCard with 2px colored left border (`border-l-2`). Apply same pattern to failed MessageRow entries.

**Typography hierarchy in ActivityFeed:**
- Subject: `text-sm font-medium` (primary)
- Content preview: `text-sm text-muted-foreground` (secondary)
- From / Time / Status: `text-xs text-muted-foreground` (metadata)

**Card hover depth:** Add `hover:shadow-sm transition-shadow` on interactive cards (MessageRow, EndpointList items, AdapterCard).

### 12. Adapter Card Enhancements

**Modify:** `apps/client/src/layers/features/relay/ui/AdapterCard.tsx`

- Replace status dot with colored left border (2px, matches status color from unified system)
- Add "System" badge (muted variant) for built-in adapters (`builtin: true`) to differentiate from user-configured
- Show last error as expandable section (click to show last 5 errors with timestamps)
- Enhanced remove confirmation dialog explaining consequences: "This will stop the adapter and remove its configuration. Messages to its subjects will no longer be delivered."

## User Experience

### Information Flow

```
RelayPanel
├── RelayHealthBar (always visible — adapters, throughput, failures, latency)
│   └── [Metrics button] → Sheet with DeliveryMetricsDashboard
├── ConnectionStatusBanner (only visible on SSE issues)
└── Tabs
    ├── Activity
    │   ├── [Compose button] → ComposeMessageDialog
    │   ├── DeadLetterSection (collapsible, hidden when empty)
    │   ├── FilterBar (source + status + subject)
    │   └── MessageList
    │       └── MessageRow (content preview, trace button)
    │           └── [Trace expand] → MessageTrace inline
    ├── Endpoints
    │   └── EndpointCard (health dot, counts, last activity)
    └── Adapters
        └── AdapterCard (left border, system badge, error history)
```

### Persona Journeys

**Kai (Autonomous Builder):** Opens Relay → health bar shows "3/3 connected, 142 today, 0 failed, 45ms" → confident system is healthy → continues working. If failures: clicks "3 failed" → dead letter section expands → sees rejection reasons → knows which budget constraint to adjust.

**Priya (Knowledge Architect):** Investigating slow message delivery → clicks trace icon on a message → sees delivery timeline (sent 10:23:01 → delivered 10:23:04, 3000ms latency) → clicks Metrics in health bar → opens dashboard sheet → identifies p95 latency spike → navigates to adapter config.

**New User:** Opens Relay → sees empty state with "Set up an adapter" CTA → clicks → arrives at Adapters tab → uses wizard to configure first adapter → sends test message via Compose → sees it appear in the feed via SSE.

## Testing Strategy

### Unit Tests

- `RelayHealthBar`: Renders correct stats from mock hook data, handles null/loading states, fires onFailedClick callback
- `DeadLetterSection`: Hidden when empty, shows correct count badge, displays rejection reasons, collapsible behavior
- `ComposeMessageDialog`: Form validation (required fields), submit calls mutation, success/error states
- `ConnectionStatusBanner`: Renders nothing when connected, shows amber banner when reconnecting, shows red after 3 failures
- `useDeadLetters`: Correct query key, respects enabled flag, refetch interval
- `useRelayConnection`: State transitions (connected → reconnecting → connected), error counting

### Integration Tests

- Filter bar + ActivityFeed: Applying status filter reduces visible messages
- MessageRow + MessageTrace: Expanding trace fetches trace data and renders timeline
- Health bar + DeadLetterSection: Clicking "failed" count scrolls to dead letter section
- Compose dialog + SSE: Sending message triggers mutation and appears in feed

### Approach

- Client component tests use React Testing Library with mock Transport (existing pattern)
- Motion animations: Mock `motion/react` to render plain elements in tests (existing pattern in codebase)
- TanStack Query: Use `QueryClientProvider` wrapper with test query client

## Performance Considerations

- **Dead letter polling**: 30-second interval (same as endpoints) — low overhead
- **Content preview extraction**: Computed once during message rendering, not on every render
- **Motion animations**: Only applied to new SSE-delivered messages, not initial history load (prevents animation storm on page load)
- **Filter state**: Local component state, no server round-trips for client-side filtering
- **Sheet for metrics**: Lazy-loaded content — DeliveryMetricsDashboard only fetches when sheet opens
- **AnimatePresence**: Uses `mode="popLayout"` to avoid layout thrashing during exit animations

## Security Considerations

- Dead letter content may contain sensitive payload data — same trust model as existing message display
- Compose dialog sends messages through existing authenticated transport — no new attack surface
- No new server endpoints required (dead letters API already exists)
- Content preview truncates at 80 chars — no risk of rendering excessively large payloads inline

## Documentation

- Update `contributing/architecture.md` Relay section with new component inventory
- Update `CLAUDE.md` client architecture table with new UI components and hooks
- No external user documentation changes needed (internal feature improvements)

## Implementation Phases

### Phase 1: Foundation (Health Bar + Dead Letters + Trace Wiring + Metrics Mount)

Core infrastructure that provides the health narrative:

1. Add `listRelayDeadLetters()` to Transport interface, HttpTransport, DirectTransport
2. Create `useDeadLetters` entity hook
3. Create `RelayHealthBar` component
4. Create `DeadLetterSection` component
5. Wire `MessageTrace` into `MessageRow` with expand/collapse
6. Mount `DeliveryMetricsDashboard` in Sheet from health bar
7. Update `RelayPanel` layout (health bar above tabs, dead letters in Activity)

### Phase 2: Motion + Visual Polish

Animations and visual consistency:

8. Add motion animations to ActivityFeed (message entrance, list exit)
9. Add motion to MessageRow expand/collapse
10. Add motion to AdapterSetupWizard step transitions
11. Apply unified status color system across all components
12. Add left border accents to AdapterCard and failed MessageRow
13. Apply typography hierarchy and card hover depth
14. Add AdapterCard enhancements (system badge, error history, remove confirmation)

### Phase 3: Interactivity + UX

User-facing features and onboarding:

15. Create `ConnectionStatusBanner` + `useRelayConnection` hook
16. Enhance ActivityFeed filters (status, subject, content preview)
17. Create `ComposeMessageDialog`
18. Implement onboarding empty states with CTAs
19. Enhance EndpointList with health indicators and card layout

## Open Questions

1. **Endpoint health data**: Does the current `GET /api/relay/endpoints` response include per-endpoint message counts and last activity? If not, do we enhance the server endpoint in this spec or defer to a follow-up?

2. **Dead letter purge**: Should the dead letter section include a "Clear all" action, or is that too dangerous for a first iteration?

## Related ADRs

- **ADR-0010**: Maildir-Inspired Message Storage — foundational storage design
- **ADR-0013**: Hybrid Maildir-SQLite Architecture — index + trace storage
- **ADR-0026**: Receipt+SSE Delivery Protocol — SSE streaming patterns
- **ADR-0028**: SQLite Trace Storage — trace data model
- **ADR-0037**: Relay Signals for Mesh Observability — signal integration

## References

- Existing Relay specs: `relay-core-library`, `relay-server-client-integration`, `relay-convergence`, `relay-runtime-adapters`, `relay-release-preparation`, `relay-advanced-reliability`
- MeshStatsHeader pattern: `apps/client/src/layers/features/mesh/ui/MeshStatsHeader.tsx`
- Motion animation guide: `contributing/animations.md`
- Design system: `contributing/design-system.md`
- Calm Tech design language: `contributing/design-system.md` > Philosophy section
