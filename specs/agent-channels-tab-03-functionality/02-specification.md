---
slug: agent-channels-tab-03-functionality
number: 222
status: specification
created: 2026-04-06
---

# Agent Dialog → Channels Tab — New Functionality (Pause, Test, Activity) (03 of 03)

## Table of Contents

1. [Overview](#1-overview)
2. [Problem Statement](#2-problem-statement)
3. [Goals](#3-goals)
4. [Non-Goals](#4-non-goals)
5. [Schema Changes](#5-schema-changes)
6. [Server Changes](#6-server-changes)
7. [Client Changes](#7-client-changes)
8. [User Experience](#8-user-experience)
9. [Data Flow](#9-data-flow)
10. [Implementation Phases](#10-implementation-phases)
11. [Testing Strategy](#11-testing-strategy)
12. [Security Considerations](#12-security-considerations)
13. [Performance Considerations](#13-performance-considerations)
14. [Documentation](#14-documentation)
15. [Migration & Rollback](#15-migration--rollback)
16. [Open Questions](#16-open-questions)
17. [Related ADRs](#17-related-adrs)
18. [References](#18-references)

---

## 1. Overview

After Spec 01 (correctness) and Spec 02 (polish), the Channels tab looks and behaves well but lacks three capabilities that every world-class integration surface provides: **pause**, **test**, and **last-activity metadata**. This spec adds them.

**Blast radius:** 1 schema change, 2 new server routes, ~4 client files modified, 1 new client hook. Includes a backward-compatible migration path via Zod defaults.

**Scope-setting:** This is the most speculative of the three specs — the value of each feature is hypothesized based on observed patterns in Slack, Linear, Zapier, and the project's own persona research (Kai's "agents running overnight" scenario). Before starting implementation, re-read this spec with a fresh eye and confirm each feature still feels load-bearing. Cut what does not.

**Design decisions locked before spec creation:**

| #   | Decision                   | Choice                                                                                                                                          |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pause model                | Per-binding, not per-adapter. Add `enabled: boolean` to `AdapterBinding` (default `true`)                                                       |
| 2   | Pause enforcement location | `BindingRouter` — same place that already enforces `canInitiate`/`canReply`/`canReceive`                                                        |
| 3   | Pause persistence          | File-first (`.dork/bindings.jsonl` or equivalent), mirrored to DB (ADR-0043 pattern)                                                            |
| 4   | Test button                | Sends a synthetic relay event through the binding and reports delivery                                                                          |
| 5   | Test isolation             | The synthetic message carries a `test: true` flag in trace metadata and is recognized by the `BindingRouter` as a dry-run — no agent invocation |
| 6   | Activity metadata surface  | "Last received X ago" computed from `useObservedChats` per binding (already available client-side)                                              |
| 7   | Rate of activity refresh   | 30s interval (piggyback on existing `useAdapterCatalog` cadence)                                                                                |
| 8   | Budget warnings            | Deferred. `budget.maxCallsPerHour` surface is a separate concern; not part of this spec.                                                        |

---

## 2. Problem Statement

### 2.1 No way to temporarily pause a binding

Kai's scenario: his agent is bound to a Telegram group. He goes on vacation. He does not want the agent to reply to messages while he's away, but he does not want to delete and recreate the binding when he gets back. Today, his only option is to delete the binding — destructive, and loses the configuration (chat filter, permissions, label).

Linear, Slack, Zapier, and every similar tool support a pause/disable toggle on each integration or webhook. DorkOS does not.

### 2.2 No way to verify a binding works without bothering humans

The `AdapterSetupWizard` has a `TestStep` during the initial setup, but once a binding is created, there is no way to re-test it. Users who change an adapter configuration (e.g., rotate a Telegram bot token), reorder chat filters, or flip permission settings have to send a real message in a real chat and hope a human doesn't reply first.

Stripe, Vercel, GitHub webhooks, and basically every webhook platform include a "Send test event" button. Its absence is a signal that DorkOS is not yet a trust-building tool for Kai.

### 2.3 Cards look alive but carry no liveness information

After Spec 02, every card shows a status dot and a preview sentence, but no activity metadata. A user cannot tell whether a "connected" channel has actually received a message in the last hour or has been silent for a week. For an overnight-agent workflow, "is this thing actually receiving?" is the primary anxiety.

The data to answer this question is **already in the client**: `useObservedChats` returns `{ chatId, lastMessageAt, messageCount }` per adapter instance. It is not yet used on the Channels tab.

---

## 3. Goals

1. **Pause/resume per binding.** A toggle in the kebab menu and/or the BindingDialog. When paused, no messages are routed to the agent and no replies are published from the agent — a hard mute without deleting the binding.
2. **Test button on every binding.** Sends a synthetic relay message that exercises the routing path (adapter → router → agent dispatcher) but short-circuits before invoking the agent. Reports success or failure with an elapsed-time latency in the UI.
3. **Last-received activity metadata on each card.** "Last message: 3m ago" for connected channels, "No recent activity" when there's nothing to report. Updated reactively via existing query refetch intervals.
4. **Zero regressions** to existing binding behavior. Paused bindings must not accidentally become deletable via the old routing path; tests must not accidentally trigger real agent runs; activity metadata must degrade gracefully when `useObservedChats` returns empty data.

---

## 4. Non-Goals

- **Budget / rate-limit surfacing.** `budget.maxCallsPerHour` is real, but not part of this spec. Separate effort.
- **Per-chat activity breakdown.** We show "last received" at the binding level, not per-chat.
- **Activity graphs or history panes.** A single "X ago" string per card; no charts, no history view. Future concern.
- **Cross-agent activity aggregation.** If multiple agents are bound to the same channel, each card shows its own view of the same "last received" timestamp — we do not try to show "last received by anyone."
- **Scheduled pauses / do-not-disturb windows.** Pause is manual for now.
- **Visual redesign of the card.** Spec 02 owns that; we only add subtitles/actions to its established structure.
- **New ChannelBindingCard component.** Extend in place.

---

## 5. Schema Changes

### 5.1 `AdapterBindingSchema` — add `enabled`

**File:** `packages/shared/src/relay-adapter-schemas.ts` _(modified)_

```diff
 export const AdapterBindingSchema = z
   .object({
     id: z.string().uuid(),
     adapterId: z.string().min(1),
     agentId: z.string().min(1),
     chatId: z.string().optional(),
     channelType: ChannelTypeSchema.optional(),
     sessionStrategy: SessionStrategySchema.default('per-chat'),
     label: z.string().default(''),
     permissionMode: PermissionModeSchema.optional().default('acceptEdits'),
+    /**
+     * When false, the binding is paused — the router skips it for both
+     * inbound delivery and agent-initiated publishes. The binding remains
+     * persisted so the user can resume it without reconfiguration.
+     */
+    enabled: z.boolean().default(true),
     canInitiate: z.boolean().default(false),
     canReply: z.boolean().default(true),
     canReceive: z.boolean().default(true),
     createdAt: z.string().datetime(),
     updatedAt: z.string().datetime(),
   })
   .openapi('AdapterBinding');
```

**Backward compatibility:** existing persisted bindings (on disk as JSONL per ADR-0043 / ADR-0130 patterns) do not have an `enabled` field. The Zod `.default(true)` fills it in at parse time. No migration required; no data loss.

**`UpdateBindingRequest`** (derived from `AdapterBindingSchema.partial()` somewhere in the same file) picks up `enabled` automatically because it is a partial. Verify the update route accepts it.

### 5.2 Trace metadata flag for synthetic test messages

**File:** `packages/shared/src/relay-schemas.ts` or wherever trace metadata is schematized _(modified)_

Add an optional boolean `isSyntheticTest?: boolean` to the trace metadata payload schema. When true, the `BindingRouter`:

1. Evaluates the full routing path (adapter → binding resolution → permission check).
2. Records whether the binding would have fired (success) or not, and why.
3. **Does not** invoke the agent runtime.
4. Emits a synthetic `test_result` event on an internal topic consumed only by the test-run client.

This flag is the distinguishing feature between a real message and a test probe. It must be set by the server-side test endpoint and must never be accepted from an inbound adapter (sanitize at the adapter boundary).

---

## 6. Server Changes

### 6.1 Route — `POST /api/bindings/:id/test`

**File:** `apps/server/src/routes/bindings.ts` _(modified)_ or new sub-route file

**Request:** no body required. Route accepts the binding UUID in the path.

**Behavior:**

1. Load the binding by `id`. 404 if not found.
2. If `binding.enabled === false`, return `409 Conflict` with `{ error: 'Binding is paused. Resume to run a test.' }`.
3. Construct a synthetic `RelayMessage` with:
   - `traceMetadata.isSyntheticTest: true`
   - `adapterId: binding.adapterId`
   - `chatId: binding.chatId ?? '__test__'`
   - `channelType: binding.channelType ?? 'dm'`
   - `body: '[synthetic test probe]'`
4. Dispatch the synthetic message through `BindingRouter.routeInbound()`.
5. Await the router's resolution verdict (it short-circuits before agent invocation due to the flag).
6. Return `200 OK` with:

```json
{
  "ok": true,
  "resolved": true,
  "latencyMs": 42,
  "wouldDeliverTo": "agent-id-here",
  "details": "Routing succeeded. No agent was invoked."
}
```

or

```json
{
  "ok": false,
  "resolved": false,
  "latencyMs": 18,
  "reason": "No matching binding (chat filter excluded this message)."
}
```

**Error handling:** if the router throws, return `500` with the error message. If the adapter is in an error state, return `200 { ok: false, reason: 'Adapter is in error state: ...' }` — a non-throwing failure so the UI can render it as a test result.

**Auth:** same middleware as other `/api/bindings/*` routes (no new auth surface).

### 6.2 `BindingRouter.routeInbound()` — honor the `enabled` flag and the test flag

**File:** `apps/server/src/services/relay/binding-router.ts` (or equivalent) _(modified)_

Add two new early-exit conditions before the existing permission checks:

1. **Skip disabled bindings.** When iterating candidate bindings, filter out any with `enabled === false`. They do not participate in resolution.
2. **Short-circuit on synthetic test.** After binding resolution but before invoking the agent runtime, check `message.traceMetadata?.isSyntheticTest`. If true, record the resolution verdict and return it to the caller (the test route) without calling `runtime.sendMessage()` or any other agent dispatch.

Implementation sketch:

```ts
async routeInbound(message: RelayMessage): Promise<RouteResult> {
  const candidates = this.resolveCandidateBindings(message)
    .filter((b) => b.enabled)  // NEW: skip paused bindings
    .filter((b) => this.checkReceivePermission(b, message));

  if (candidates.length === 0) {
    return { resolved: false, reason: 'No matching enabled binding' };
  }

  const binding = this.selectBinding(candidates);

  // NEW: short-circuit for synthetic test probes
  if (message.traceMetadata?.isSyntheticTest) {
    return {
      resolved: true,
      binding,
      wouldDeliverTo: binding.agentId,
      details: 'Routing succeeded. No agent was invoked.',
    };
  }

  return this.dispatchToAgent(binding, message);
}
```

**Agent-initiated path** (`routeOutbound` or equivalent): also filter by `enabled === true`. A paused binding must not allow the agent to publish outbound messages either — that is the whole point of "pause."

### 6.3 Route — `PATCH /api/bindings/:id` — no new route, but verify it accepts `enabled`

**File:** `apps/server/src/routes/bindings.ts` _(verify)_

The existing update route should already accept any subset of binding fields. Confirm that:

1. `UpdateBindingRequestSchema` (or the equivalent) includes `enabled` (automatically, via `AdapterBindingSchema.partial()`).
2. The handler writes the `enabled` field to the file-first store and mirrors to DB per the pattern in ADR-0043.
3. The response returns the full updated binding including `enabled`.

If the schema does not automatically propagate, add `enabled` explicitly.

### 6.4 Test coverage for router changes

New unit tests in `apps/server/src/services/relay/__tests__/binding-router.test.ts`:

```ts
/** Verifies that paused bindings are skipped for inbound routing. */
it('skips bindings with enabled=false during inbound resolution', async () => { ... });

/** Verifies that paused bindings are skipped for agent-initiated outbound publishes. */
it('skips bindings with enabled=false when the agent initiates', async () => { ... });

/** Verifies that isSyntheticTest short-circuits before agent invocation. */
it('short-circuits synthetic test messages without invoking the agent runtime', async () => { ... });

/** Verifies that a synthetic test through a paused binding returns resolved=false. */
it('returns resolved=false when a synthetic test hits a paused binding', async () => { ... });
```

Use the existing `FakeAgentRuntime` from `@dorkos/test-utils`. Confirm `runtime.sendMessage` was never called in synthetic-test scenarios.

### 6.5 Route test — `bindings.test.ts`

New tests for `POST /api/bindings/:id/test`:

```ts
/** Verifies a successful test returns ok:true with latency. */
it('returns ok=true with latencyMs for a healthy binding', async () => { ... });

/** Verifies a paused binding returns 409 Conflict. */
it('returns 409 when testing a paused binding', async () => { ... });

/** Verifies a non-existent binding returns 404. */
it('returns 404 for an unknown binding id', async () => { ... });

/** Verifies an adapter-error state returns ok:false with reason. */
it('returns ok=false when the adapter is in error state', async () => { ... });
```

---

## 7. Client Changes

### 7.1 New mutation hook — `useTestBinding`

**File:** `apps/client/src/layers/entities/binding/model/use-test-binding.ts` _(new)_

```ts
import { useMutation } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

interface TestResult {
  ok: boolean;
  resolved: boolean;
  latencyMs: number;
  wouldDeliverTo?: string;
  reason?: string;
  details?: string;
}

/**
 * Sends a synthetic test probe through a binding. The server short-circuits
 * before invoking the agent; no real messages are delivered to any platform.
 */
export function useTestBinding() {
  const transport = useTransport();
  return useMutation<TestResult, Error, string>({
    mutationFn: (bindingId) => transport.testBinding(bindingId),
  });
}
```

Add `testBinding(bindingId: string): Promise<TestResult>` to the `Transport` interface and both `HttpTransport` (POST to `/api/bindings/:id/test`) and `DirectTransport` (invoke the route handler in-process).

Export `useTestBinding` from `@/layers/entities/binding`.

### 7.2 `ChannelBindingCard` — add activity subtitle, test menu item, pause toggle

**File:** `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx` _(modified from Spec 02 output)_

**New props:**

```ts
interface ChannelBindingCardProps {
  binding: AdapterBinding;
  channelName: string;
  channelIconId?: string;
  channelAdapterType: string;
  adapterState: 'connected' | 'disconnected' | 'error' | 'connecting';
  errorMessage?: string;
  chatDisplayName?: string;
  /** ISO timestamp of the last observed inbound message for this binding's adapter instance. */
  lastMessageAt?: string;
  /** Called when the user toggles pause/resume. */
  onTogglePause: (enabled: boolean) => void;
  /** Called when the user runs a test. Returns a promise for the UI to await. */
  onTest: () => Promise<TestResult>;
  onEdit: () => void;
  onRemove: () => void;
}
```

**Additions to the card UI:**

1. **Activity subtitle** under the preview sentence (or in place of it when the card is in an idle state):
   - `lastMessageAt` present and within 24h: `Last received {relativeTime}` e.g. "Last received 3m ago"
   - `lastMessageAt` present and older than 24h: `Last received {abs date}` e.g. "Last received Apr 2"
   - `lastMessageAt` absent: `No recent activity`
   - Use `formatRelativeTime` from `@/layers/shared/lib` (already exists, referenced by `IdentityTab.tsx:6`).
2. **Paused visual state:** when `binding.enabled === false`:
   - Card dims to `opacity-60`.
   - Status dot is gray regardless of adapter state.
   - A "Paused" pill renders next to the channel name.
   - The preview/activity subtitle is replaced with "Paused — no messages routing".
3. **Kebab menu new items:**
   - Above `Edit`: `Pause` / `Resume` (toggles `enabled` via `onTogglePause`).
   - Above `Edit`: `Send test` (fires `onTest`, shows an inline spinner in the menu item while pending, and a toast with the result on resolution).

**Kebab menu layout after changes:**

```
┌──────────────────┐
│ Send test        │
│ ─────            │
│ Pause / Resume   │
│ ─────            │
│ Edit             │
│ Remove           │  (destructive)
└──────────────────┘
```

**Relative time recomputation:** the card uses `useEffect` + a 60s interval to re-render the relative time label. This is a small, per-card concern; we do not globalize it.

### 7.3 `ChannelsTab` — wire new handlers

**File:** `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx` _(modified)_

1. Add `useTestBinding()` mutation hook at the top.
2. Add `handleTogglePause(binding, enabled)` which calls `updateBinding.mutateAsync({ id: binding.id, updates: { enabled } })`.
3. Add `handleTest(binding)` which calls `testBinding.mutateAsync(binding.id)` and returns the promise. Also surfaces a toast with the result:
   - Success: `toast.success('Test OK — routing in 42ms')`
   - Failure: `toast.error('Test failed: {reason}')`
4. Compute `lastMessageAt` per binding via `BoundChannelRow` (already wraps `useObservedChats`). Extend `BoundChannelRow` to pull `Math.max(...observedChats.map((c) => c.lastMessageAt))` from the hook and pass it down as a prop.
5. Pass `onTogglePause`, `onTest`, and `lastMessageAt` to each `ChannelBindingCard`.

### 7.4 `BoundChannelRow` — compute and pass activity metadata

**File:** `apps/client/src/layers/features/agent-settings/ui/BoundChannelRow.tsx` _(modified from Spec 02 output)_

Extend to extract the latest `lastMessageAt` from the observed chats list:

```ts
const lastMessageAt = useMemo(() => {
  if (observedChats.length === 0) return undefined;
  // If the binding has a specific chatId filter, use that chat's timestamp;
  // otherwise, use the newest across all observed chats.
  if (binding.chatId) {
    const match = observedChats.find((c) => c.chatId === binding.chatId);
    return match?.lastMessageAt;
  }
  return observedChats
    .map((c) => c.lastMessageAt)
    .reduce<string | undefined>((newest, ts) => {
      if (!newest) return ts;
      return ts > newest ? ts : newest;
    }, undefined);
}, [binding.chatId, observedChats]);
```

Pass `lastMessageAt` to `ChannelBindingCard`.

### 7.5 Transport interface update

**File:** `packages/shared/src/transport.ts` _(modified)_

Add:

```ts
interface Transport {
  // ... existing methods
  testBinding(bindingId: string): Promise<BindingTestResult>;
}
```

And the response type `BindingTestResult` schema, derived from the server's response shape in §6.1.

**`HttpTransport`** (`apps/client/src/layers/shared/lib/transport/...`) adds a POST method.

**`DirectTransport`** (Obsidian plugin, in-process) calls the route handler directly.

### 7.6 Files summary

| File                                                                                      | Change                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/shared/src/relay-adapter-schemas.ts`                                            | Add `enabled` field to `AdapterBindingSchema`           |
| `packages/shared/src/relay-schemas.ts`                                                    | Add `isSyntheticTest` to trace metadata schema          |
| `packages/shared/src/transport.ts`                                                        | Add `testBinding` method                                |
| `apps/server/src/routes/bindings.ts`                                                      | Add `POST /api/bindings/:id/test`                       |
| `apps/server/src/services/relay/binding-router.ts`                                        | Filter disabled bindings, short-circuit synthetic tests |
| `apps/server/src/routes/__tests__/bindings.test.ts`                                       | New route tests                                         |
| `apps/server/src/services/relay/__tests__/binding-router.test.ts`                         | New router tests                                        |
| `apps/client/src/layers/entities/binding/model/use-test-binding.ts`                       | **New.** Mutation hook                                  |
| `apps/client/src/layers/entities/binding/index.ts`                                        | Export new hook                                         |
| `apps/client/src/layers/shared/lib/transport/http-transport.ts`                           | Implement `testBinding`                                 |
| `apps/client/src/layers/shared/lib/transport/direct-transport.ts`                         | Implement `testBinding` (in-process)                    |
| `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`                       | Wire test/pause handlers                                |
| `apps/client/src/layers/features/agent-settings/ui/BoundChannelRow.tsx`                   | Extract `lastMessageAt`                                 |
| `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx`                | New props, paused state, kebab items, activity line     |
| `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelBindingCard.test.tsx` | Tests for paused state, test action, activity line      |
| `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx`        | Tests for pause/test wiring                             |

Approximately 12 files touched. Non-trivial, but each change is surgical.

---

## 8. User Experience

### 8.1 Pause flow

1. User opens `AgentDialog → Channels → ⋯ → Pause` on a binding.
2. Card dims, status dot goes gray, "Paused" pill appears, subtitle changes to "Paused — no messages routing".
3. The binding persists to disk with `enabled: false` (write-through).
4. Any incoming message to that adapter+chat combination is now dropped at the router (not delivered to the agent).
5. User can resume at any time via `⋯ → Resume`. Card re-activates immediately.

**Toast feedback:** `Channel paused` / `Channel resumed`. Short, confident.

### 8.2 Test flow

1. User opens `⋯ → Send test` on a binding.
2. Menu item shows a spinner; the kebab menu stays open during the request.
3. Server routes a synthetic probe, returns `{ ok, latencyMs, reason? }`.
4. Toast on success: `Test OK — routed in 42ms`.
5. Toast on failure: `Test failed: {reason}`. Failure details are specific (e.g., "Adapter is in error state: Invalid bot token" or "No matching chat filter").
6. If the binding is paused: `Test blocked — binding is paused. Resume it first.`

**Constraints:**

- The test must complete in under 5 seconds or be cancelled (client-side abort).
- A rapid-fire tester (more than one test per second) is rate-limited on the server.
- The test must never trigger an agent run — the server-side short-circuit is the guarantee.

### 8.3 Activity metadata

On every connected card:

- If a message was received in the last minute: `Last received just now`.
- Last hour: `Last received {N}m ago`.
- Last 24 hours: `Last received {N}h ago`.
- Older: `Last received {abs date}` (e.g., `Apr 2`).
- Never: `No recent activity`.

The label refreshes automatically every 60 seconds while the card is mounted. TanStack Query's 30s interval on `useAdapterCatalog` and `useObservedChats` drives the underlying data freshness; the 60s local interval handles the "X minutes ago" string update without a re-fetch.

### 8.4 Paused + activity interaction

If a binding is paused, the activity subtitle is replaced with "Paused — no messages routing". The `lastMessageAt` metadata is not shown because it would be misleading (messages arriving while paused are dropped, so "last received" might still be old, and users might interpret that as the feature being broken).

---

## 9. Data Flow

### 9.1 Pause

```
User clicks Pause in kebab
  → handleTogglePause(binding, false)
  → useUpdateBinding.mutateAsync({ id, updates: { enabled: false } })
  → HTTP PATCH /api/bindings/:id { enabled: false }
  → Server writes .dork/bindings.jsonl (file-first, ADR-0043)
  → Server mirrors to DB
  → Response returns updated binding
  → Query invalidation on ['bindings']
  → ChannelsTab re-renders; ChannelBindingCard shows paused state
  → Router resolution now skips this binding for all future messages
```

### 9.2 Test

```
User clicks Send test in kebab
  → handleTest(binding)
  → useTestBinding.mutateAsync(binding.id)
  → HTTP POST /api/bindings/:id/test
  → Server loads binding
  → Server constructs synthetic RelayMessage with isSyntheticTest: true
  → Server calls BindingRouter.routeInbound(syntheticMessage)
  → Router resolves candidate, checks enabled/permissions
  → Router sees isSyntheticTest flag → short-circuits before agent dispatch
  → Server returns { ok, latencyMs, reason }
  → Client shows toast
```

### 9.3 Activity metadata

```
Periodic (TanStack Query refetch every 30s)
  → useObservedChats refetches for each adapterId
  → BoundChannelRow extracts latest lastMessageAt
  → Passes to ChannelBindingCard as prop
  → Card renders relative-time subtitle
Local (60s interval)
  → ChannelBindingCard re-renders to update "X minutes ago" string
  → No refetch — just a forced re-render of the formatted label
```

---

## 10. Implementation Phases

### Phase 1 — Schema and server foundation

1. Add `enabled` to `AdapterBindingSchema`.
2. Add `isSyntheticTest` to trace metadata schema.
3. Update `BindingRouter` to filter disabled bindings and short-circuit on synthetic tests.
4. Add `POST /api/bindings/:id/test` route.
5. Write router tests and route tests.
6. Verify via `pnpm test -- --run` that no existing tests regress.

This phase is backward-compatible on its own — the new field defaults to `true`, the new route is additive, the router changes are strict additions to the filter pipeline. Safe to merge standalone.

### Phase 2 — Client wiring

1. Add `testBinding` to the `Transport` interface and implement in both adapters.
2. Create `useTestBinding` mutation hook.
3. Extend `BoundChannelRow` to compute `lastMessageAt`.
4. Extend `ChannelBindingCard` with new props: `enabled`, `lastMessageAt`, `onTogglePause`, `onTest`.
5. Add paused visual state and the "Paused" pill.
6. Add kebab menu items: Send test, Pause/Resume.
7. Add activity subtitle rendering with relative time.
8. Wire `ChannelsTab` to `useTestBinding` and the pause mutation.
9. Add tests for the new card states and the wiring.
10. Manual verification (see Testing Strategy).

### Phase 3 — (Optional) polish pass

If any rough edges surface in manual testing (latency display formatting, toast timing, keyboard access to the new kebab items), address them here. No new features — just fit-and-finish.

---

## 11. Testing Strategy

### 11.1 Unit tests

**`build-relative-time` (if we need a new helper)** — existing `formatRelativeTime` in `@/layers/shared/lib` may already cover our needs. Verify before adding.

**`ChannelBindingCard.test.tsx`** — add:

```ts
/** Verifies the paused visual state (dim, gray dot, Paused pill, subtitle replacement). */
it('renders paused visual state when binding.enabled is false', () => { ... });

/** Verifies the activity subtitle renders relative time for a recent lastMessageAt. */
it('renders "X minutes ago" for a recent last message', () => { ... });

/** Verifies the activity subtitle renders "No recent activity" when lastMessageAt is absent. */
it('renders no-activity fallback when lastMessageAt is undefined', () => { ... });

/** Verifies the kebab menu includes Send test and Pause/Resume items. */
it('renders Send test and Pause items in the kebab menu', () => { ... });

/** Verifies clicking Send test calls onTest and shows a spinner while pending. */
it('calls onTest when Send test is clicked', () => { ... });

/** Verifies clicking Pause calls onTogglePause(false). */
it('calls onTogglePause(false) when Pause is clicked', () => { ... });

/** Verifies clicking Resume on a paused binding calls onTogglePause(true). */
it('calls onTogglePause(true) when Resume is clicked on a paused binding', () => { ... });
```

**`ChannelsTab.test.tsx`** — add:

```ts
/** Verifies the pause mutation is dispatched with enabled=false. */
it('dispatches update mutation with enabled=false when Pause is clicked', () => { ... });

/** Verifies the test mutation is dispatched with the correct binding id. */
it('dispatches test mutation with binding id when Send test is clicked', () => { ... });

/** Verifies the BoundChannelRow passes lastMessageAt derived from observed chats. */
it('passes lastMessageAt from observed chats down to the card', () => { ... });
```

**`binding-router.test.ts`** — already covered in §6.4.

**`bindings.test.ts` (route tests)** — already covered in §6.5.

### 11.2 Integration test (optional, high-value)

A single Playwright test in `apps/e2e/` that:

1. Boots the server with a mock adapter.
2. Creates a binding.
3. Clicks Pause in the UI.
4. Sends a real (mocked) inbound message to the adapter.
5. Asserts the agent runtime was not invoked.
6. Clicks Resume.
7. Sends another message.
8. Asserts the agent runtime was invoked once.

This catches wiring regressions that unit tests miss. Optional — if the Phase 1 router tests are thorough, they provide the primary safety.

### 11.3 Manual verification checklist

1. Open agent → Channels → click ⋯ → Pause on a connected binding.
2. Confirm: card dims, "Paused" pill appears, subtitle changes.
3. Send a real message through the paused channel; confirm the agent does not respond.
4. Click ⋯ → Resume. Confirm card re-activates.
5. Send a real message; confirm the agent responds.
6. Click ⋯ → Send test on a healthy binding. Confirm success toast with latency.
7. Click Send test on a paused binding. Confirm the block/error toast.
8. Break an adapter (invalid config). Click Send test. Confirm the error reason is specific.
9. Wait 5+ minutes. Confirm the relative-time label updates ("5 min ago" → "6 min ago").
10. Restart the server mid-test. Confirm the `enabled: false` persists after restart.
11. Confirm no existing binding-related tests regress.

### 11.4 Regression safety

- Run `pnpm test -- --run` end-to-end before merging.
- Run `pnpm smoke:integration` (Docker) to confirm the CLI + server + client stack still boots cleanly.
- Run `pnpm typecheck` to catch any transport-interface drift between `HttpTransport` and `DirectTransport`.

---

## 12. Security Considerations

### 12.1 Test probe sanitization

The `isSyntheticTest` flag is the only gate between a test probe and a real message. Two rules must hold:

1. **Adapters must never set this flag when ingesting inbound messages.** Add an assertion at the inbound adapter boundary: strip `traceMetadata.isSyntheticTest` from any payload received from an external adapter. This prevents an attacker from spoofing a "test" message that would appear to succeed while leaving no audit trail.
2. **The test route is the only server-side setter of the flag.** Do not let any other server code path set `isSyntheticTest: true`. Grep and confirm.

### 12.2 Pause race conditions

When a user pauses a binding, there may be in-flight messages already past the router filter. The router's early-exit filters future messages but does not cancel in-flight ones. This is acceptable behavior — the pause is effective "at the next routing decision," not instantaneously. Document this in the TSDoc on the `enabled` field.

### 12.3 Rate limiting the test endpoint

The test route must be rate-limited to prevent abuse. Use the existing `express-rate-limit` pattern (referenced in `apps/server/src/routes/admin.ts`). Proposed limit: 10 tests per minute per IP. Tune based on observation.

### 12.4 No auth change

No new authentication surface. The test and update routes reuse the existing `/api/bindings/*` auth middleware.

---

## 13. Performance Considerations

- **Pause filter is O(N) on bindings per message.** Already the shape of the existing router. Adding one more filter predicate is negligible.
- **Test probe round-trip should be under 100ms locally.** If higher, investigate — the short-circuit path does no I/O beyond the router pass.
- **Activity metadata does not trigger new network requests.** `useObservedChats` is already called by the card for display-name resolution in Spec 02; we reuse the same query result.
- **60s local re-render interval per card** is cheap. Ten bindings = one re-render per card per minute. Negligible.

---

## 14. Documentation

- **TSDoc on `enabled` field** explaining: default `true`, paused behavior, router semantics, persistence model, race-condition caveat.
- **TSDoc on the test route** explaining: synthetic nature, non-invocation guarantee, rate limit.
- **Update `contributing/api-reference.md`** (if that file documents the bindings API) with the new field and test endpoint.
- **Update `contributing/architecture.md`** if it covers `BindingRouter` — add a sentence about the enabled filter and synthetic test short-circuit.
- **Changelog entry** at merge time: user-facing blurb for each of the three features.

---

## 15. Migration & Rollback

### 15.1 Migration

None required. The `enabled` field defaults to `true` via Zod, so every existing binding on disk parses correctly. The new route is additive. The new router filter skips bindings with `enabled === false` — existing bindings will always have `enabled === true` after first parse, so their behavior is unchanged.

### 15.2 Rollback

If a critical issue surfaces post-merge:

- **Client rollback alone is safe.** The server changes are all additive; a pre-Spec-221 client simply won't send `enabled: false` updates or call the test endpoint. Existing bindings continue to work.
- **Server rollback requires client rollback.** If the server reverts to a version without the `enabled` filter, paused bindings silently become active again. Roll both client and server together.
- **Schema rollback is safe.** Removing `enabled` from `AdapterBindingSchema` causes Zod to drop the field on re-parse. Existing JSONL files still contain the field, but the old schema ignores it on the way in and the old router has no awareness of it. No data loss; just a loss of the pause semantics until the next re-deploy.

---

## 16. Open Questions

**None block implementation.** The following are pre-implementation re-reads rather than blockers:

1. **Should the test probe check all candidate bindings or only the selected one?** Current design picks one binding. A "comprehensive test" mode could report on all candidates for the same adapter+chat. Out of scope for v1 — add if users ask.
2. **Should paused bindings show in the picker's "already bound" check?** Yes. The user should still see "this channel is already bound (paused)" so they don't accidentally create a duplicate. Implementation: `boundAdapterIds` in `ChannelsTab` already includes all bindings for the agent; no change needed.
3. **Where does the pause toggle live in the edit dialog?** Considered adding it to `BindingDialog`; decided to keep it kebab-only to avoid duplicating the affordance. Revisit if user research shows people look for it in the dialog.

---

## 17. Related ADRs

- **ADR-0043 (File-First Write-Through for Agents)** — pattern to follow for the `enabled` field on bindings. Bindings should follow the same pattern.
- **ADR-0046 (Central Binding Router for Adapter-Agent Routing)** — the router that enforces the new `enabled` filter.
- **ADR-0131 (Binding-Level Permissions Over Adapter-Level)** — established that binding-level toggles are the right granularity. `enabled` follows the same principle as `canReply` / `canReceive`.
- **ADR-0094 (Per-Message Correlation ID for Relay Event Filtering)** — the test event needs a correlation ID for the client to match the result.

**Possibly new ADR:** "Synthetic test probes as a first-class routing mode." Defer — a single spec introducing a new routing mode does not yet need a dedicated ADR. Revisit if we add more probe-like semantics (heartbeats, dry-runs for permission checks, etc.).

---

## 18. References

**Series — execute in order:**

1. **`agent-channels-tab-01-correctness`** — bug fixes and architecture cleanup. Must be merged before this spec begins.
2. **`agent-channels-tab-02-polish`** — visual redesign, brand icons, humanized copy, tab reorder, color semantics, empty-state redesign. Must be merged before this spec begins.
3. **`agent-channels-tab-03-functionality`** _(this spec)_ — pause/mute, test button, last-activity metadata.

This spec builds directly on the card structure, `BoundChannelRow`, shared hooks, and progressive-disclosure layout introduced by Specs 01 and 02. Starting this work before either is merged will create rebase pain.

**Source files modified:**

- `packages/shared/src/relay-adapter-schemas.ts`
- `packages/shared/src/relay-schemas.ts`
- `packages/shared/src/transport.ts`
- `apps/server/src/routes/bindings.ts`
- `apps/server/src/services/relay/binding-router.ts`
- `apps/client/src/layers/shared/lib/transport/http-transport.ts`
- `apps/client/src/layers/shared/lib/transport/direct-transport.ts`
- `apps/client/src/layers/entities/binding/index.ts`
- `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`
- `apps/client/src/layers/features/agent-settings/ui/BoundChannelRow.tsx`
- `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx`
- Associated tests

**Source files created:**

- `apps/client/src/layers/entities/binding/model/use-test-binding.ts`
- Associated test file

**Design references:**

- Stripe → Webhooks → Send test event
- GitHub → Repository webhooks → Recent deliveries + Redeliver
- Vercel → Integrations → Test
- Slack → Apps → Pause
- Linear → Workflow integrations → Disable
