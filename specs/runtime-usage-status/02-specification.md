---
slug: runtime-usage-status
number: 260707-124033
created: 2026-07-07
status: specified
---

# Runtime-agnostic usage/cost status: one abstraction across runtimes and subscription states

**Status:** Draft <!-- Draft | Under Review | Approved | Implemented -->
**Author:** Dorian (via DOR-100 design task)
**Date:** 2026-07-07
**Tracker:** DOR-100
**Verified against:** `apps/server` claude-code/codex/opencode runtimes, `packages/shared` schemas, `apps/client` status feature (all on `main` as of 2026-07-07)

## Overview

Replace the Claude-Code-specific usage-status UI with one runtime-neutral `UsageStatus` abstraction. Every runtime describes its usage in the same shape; runtimes with no meaningful quota or cost report nothing and the item hides. On the client, merge the two current status items (Usage and Cost) into one intelligent `UsageStatusItem` whose primary metric flips by kind: a subscription shows utilization first with cost secondary; pay-as-you-go shows cost first.

`UsageStatus` is carried as data on the existing `session_status` projection (the same durable SSE path that already delivers cost, context, and cache), not through a new synchronous runtime method. This is the honest fit for push-derived data and it repairs a live regression: the current Usage item is dead because its source event is dropped on the durable path (see Background).

## Background / Problem Statement

Two independent numbers exist today:

1. **Session cost** (`costUsd`): rides `session_status` (StreamEvent) which the normalizer folds into a `status_change` SessionEvent, merged by the projector, exposed on the snapshot, and read by the client via `deriveStatusBarValues`. This path **works**. It is capability-gated on `supportsCostTracking` (claude-code true, codex false, opencode true).
2. **Subscription utilization** (`UsageInfo`): claude-code's `result-event-mapper.ts` emits it as a separate `usage_info` StreamEvent on `rate_limit_event`. But `session-event-normalizer.ts` has **no case** for `usage_info` (nor for `rate_limit`), so both are dropped on the durable `/events` path. On the client, `session-chat-store.ts` declares a `usageInfo` field that **no code ever writes** (there is no `setUsageInfo`), and `setRateLimitRetryAfter`/`setIsRateLimited` are defined but **never called**.

Net effect: the Usage status item and the mid-turn "rate limited" strip state are both non-functional in the current durable-SSE architecture (a regression from the spec-255 stream-reconnection migration, which removed the old raw-StreamEvent consumer without migrating `usage_info`/`rate_limit`). The Cost item works but is Claude-shaped conceptually and sits beside a dead sibling.

As DorkOS adds Codex and OpenCode, we need one abstraction rather than three UI code paths, and we should fix the regression while we are here.

## Goals

- Define one runtime-neutral `UsageStatus` shape that expresses subscription utilization, pay-as-you-go cost, and "nothing meaningful".
- Carry it on the existing session-status projection so no new SSE plumbing or client allowlist entry is required.
- Populate it per runtime: claude-code (subscription + utilization + cost), opencode (pay-as-you-go + cost), codex (nothing).
- Merge Usage + Cost into one `UsageStatusItem` that stays legible in both modes.
- Delete the superseded `UsageInfo` type, the dead `usageInfo` store field, and the two dead rate-limit actions (no lingering dead code, per AGENTS.md).

## Non-Goals

- A synchronous `getUsageStatus()` method on `AgentRuntime` (explicitly rejected below).
- Account-scoped usage surfaces beyond the per-session strip (designed-compatible, not built).
- A dedicated usage/billing page; plan or purchase management.
- Codex dollar-cost accounting (the SDK does not expose it; codex stays `kind: 'none'`).

## Resolved Open Questions

### (a) How do no-single-subscription runtimes (OpenCode) report?

**Resolution: OpenCode reports `kind: 'pay-as-you-go'` with a cumulative session `costUsd`, no quota, no per-provider breakdown.** OpenCode fronts multiple providers with no shared quota, so an aggregate utilization would be a fabricated number and a per-provider list would bloat a one-line status item. OpenCode already emits real per-assistant-message USD cost, which is the one honest, legible signal. The active model/provider can be named in the tooltip via `detail`. Per-provider quota is a future extension the type does not preclude, not a v1 concern.

### (b) Which states must the type support?

**Resolution: four, expressed by `kind` plus optional fields (never a placeholder).**

| State                                  | `kind`          | Fields present                                                        | Item renders                                         |
| -------------------------------------- | --------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| Active subscription, utilization known | `subscription`  | `utilization`, `windowLabel`, `resetsAt`, optional `costUsd`, `state` | utilization % primary, cost in tooltip               |
| Subscription, utilization not yet seen | `subscription`  | `costUsd` only (or nothing yet)                                       | cost if present, else item hidden until first signal |
| Pay-as-you-go, cost, no quota          | `pay-as-you-go` | `costUsd`, optional `detail`                                          | cost primary                                         |
| Nothing meaningful                     | (no `usage`)    | `usage` omitted entirely                                              | item hidden                                          |

"No credentials" is not a distinct usage state: an unconnected runtime cannot start a session, and a connected runtime with nothing to report simply omits `usage`. The self-gating rule is uniform: **the item shows iff `usage` is present and renders a metric.**

### (c) Merge Usage and Cost into one item?

**Resolution: yes, one `UsageStatusItem`.** The Rams answer holds and legibility survives because the two numbers are never both primary for a given kind:

- **Subscription** (Claude Max/Pro): utilization is the decision-relevant number for someone running many agents ("am I about to hit my 5-hour cap"); flat-rate per-session dollars are secondary. Render `47%` (gauge icon) primary, session cost in the tooltip.
- **Pay-as-you-go** (OpenCode, or a future Claude API-key session): cost is the only meaningful number. Render `$0.42` (dollar icon) primary.

This collapses the `cost` and `usage` registry keys into one toggle. `supportsCostTracking` is retained as the guard that keeps a stray cost value off a runtime that has no cost concept (Codex).

## Proposed Types

### `UsageStatus` (new, in `packages/shared/src/schemas.ts`, replacing `UsageInfoSchema`)

```ts
/** Utilization health for a subscription window (drives amber/red styling). */
export const UsageStateSchema = z.enum(['ok', 'warning', 'exhausted']);
export type UsageState = z.infer<typeof UsageStateSchema>;

/**
 * Runtime-neutral usage/cost descriptor for the status strip. Each runtime
 * populates the fields it can honestly report; a runtime with no meaningful
 * quota or cost omits `usage` entirely and the item hides.
 */
export const UsageStatusSchema = z
  .object({
    /**
     * How this session's usage should be read:
     * - `subscription`: a metered plan with a utilization window (Claude Max/Pro).
     * - `pay-as-you-go`: per-token billing with cost-to-date, no quota (OpenCode).
     */
    kind: z.enum(['subscription', 'pay-as-you-go']),
    /** Fraction 0..1 of the active subscription window consumed. Subscription only. */
    utilization: z.number().min(0).optional(),
    /** Human label for the active window/plan, e.g. "5-hour window", "7-day Opus". */
    windowLabel: z.string().optional(),
    /** ISO timestamp when the current window resets. Subscription only. */
    resetsAt: z.string().optional(),
    /**
     * Cumulative USD cost for the relevant scope: session cost for
     * `pay-as-you-go` (primary) and an optional secondary figure for
     * `subscription`.
     */
    costUsd: z.number().min(0).optional(),
    /** Utilization health. Absent implies `ok`. Subscription only. */
    state: UsageStateSchema.optional(),
    /** One-line tooltip detail (e.g. "Using overage capacity", active provider). */
    detail: z.string().optional(),
  })
  .openapi('UsageStatus');

export type UsageStatus = z.infer<typeof UsageStatusSchema>;
```

Note the `kind` enum drops the `'none'` member from the brief's candidate: "nothing meaningful" is expressed by **omitting `usage`**, not by a `none` object. This keeps the self-gating rule ("present iff renderable") a single boolean and avoids a `kind: 'none'` object that would have to be filtered out downstream anyway.

### Carrier: extend `SessionStatusEventSchema` (StreamEvent) and the `status_change` SessionEvent

```ts
// packages/shared/src/schemas.ts — SessionStatusEventSchema gains:
usage: UsageStatusSchema.optional(),

// packages/shared/src/session-stream.ts — the status_change status payload gains:
usage: UsageStatusSchema.optional(),
```

### Where the "method" goes: nowhere on `AgentRuntime`

**We do not add `getUsageStatus()` to the `AgentRuntime` interface.** Rationale (ADR-0258): usage is push-derived live data that changes per turn, and DorkOS already has a push channel for exactly this (the `session_status` projection that carries cost). A synchronous getter would need its own polling loop, would duplicate the stream, and would return stale-or-null before the first turn. Adding a method that non-subscription runtimes implement as `return null` is precisely the no-op-method anti-pattern ADR-0258 rejects. Instead, each runtime **produces** `usage` in its event mapper, exactly as it already produces `costUsd`.

`RuntimeCapabilities` is unchanged: `supportsCostTracking` stays as the cost guard. No new capability field is needed because the data self-gates.

## Per-Runtime Plan

### claude-code (`services/runtimes/claude-code/`)

- On `rate_limit_event` with `rate_limit_info`: stop emitting the standalone `usage_info` StreamEvent. Instead emit a `session_status` StreamEvent carrying only `{ usage }` (the projector merges partial status payloads, so a usage-only status is valid). Map:
  - `kind: 'subscription'`
  - `utilization` from `info.utilization`
  - `windowLabel` from the existing `formatLimitType(info.rateLimitType)` logic (move that mapping server-side so the label is authored once)
  - `resetsAt` from `info.resetsAt`
  - `state`: `rejected -> 'exhausted'`, `allowed_warning -> 'warning'`, else `'ok'`
  - `detail`: `'Using overage capacity'` when `info.isUsingOverage`
- On `result`: continue emitting `costUsd` on `session_status` as today. Additionally stamp `usage.costUsd` and `usage.kind: 'subscription'` onto that status so the merged item has session cost for the tooltip. Hold the last observed subscription utilization on `AgentSession` (beside `lastRequestUsage`) so a cost-only `result` status can re-attach the known `utilization`/`windowLabel`/`resetsAt` and the item does not flicker between kinds.
- Auth nuance: if a future Claude session runs on an API key rather than a subscription login, it will never receive a `rate_limit_event`; it then reports `kind: 'pay-as-you-go'` with `costUsd`. This falls out naturally from "utilization only when a rate_limit_event arrives" and needs no explicit auth probe in v1.

### opencode (`services/runtimes/opencode/`)

- On a completed assistant message (which already carries real `cost` + token usage, source of the existing `session_status.costUsd`): stamp `usage: { kind: 'pay-as-you-go', costUsd }`. Optionally set `detail` to the active model/provider name. No `utilization`, no `resetsAt`.

### codex (`services/runtimes/codex/`)

- Omit `usage` entirely (`supportsCostTracking: false`, no subscription utilization exposed by the SDK). The item never shows for Codex. No mapper change beyond confirming `usage` is never set.

## Data Flow

No new SSE stream, no new SessionEvent **type**, so **no new client allowlist entry**. Usage rides the existing `status_change` carrier:

1. Runtime event mapper emits `session_status` StreamEvent with `usage`.
2. `session-event-normalizer.ts` `toStatusChange`: add one line folding `data.usage` into `status.usage` (all-or-nothing, like `model`/`cost`).
3. `session-state-projector.ts`: extend the held status merge to carry `usage`, preserving a prior value when a later partial omits it (same merge discipline already used for `contextUsage`/`cacheStats`). The cold-snapshot status has `usage: null`.
4. Snapshot exposes the held status; `useSessionStreamStatus` reads it on cold mount and live.
5. `derive-status-bar.ts`: add `usage: UsageStatus | null` to its output.
6. `ChatStatusSection.tsx`: read `usage` from `deriveStatusBarValues`; render one `<UsageStatusItem usage={usage} />`, capability-gated so a stray cost cannot appear on a runtime with `supportsCostTracking: false`.

Because we extend an existing carrier rather than add a new SessionEvent member, the `session-stream-store.ts` case list is untouched. This is called out explicitly to satisfy the project rule that new SessionEvent/status members must join the client allowlist: **no new member is added**, so the rule is satisfied by construction. (If a reviewer prefers a first-class `usage_update` SessionEvent instead of a `status_change` field, that variant WOULD require an allowlist entry and a projector case; it is documented as the rejected alternative below.)

## Client Design

### New component: `features/status/ui/UsageStatusItem.tsx`

Replaces `UsageItem.tsx` and `CostItem.tsx` (both deleted). Props: `{ usage: UsageStatus }`. Behavior:

- `kind === 'subscription'` and `utilization != null`: gauge icon + `${pct}%` primary; amber at `state === 'warning'` or `pct >= 80`, red at `state === 'exhausted'`. Tooltip: utilization, window (`windowLabel`), resets-at (localized time), session cost (`costUsd`), and `detail` (e.g. overage) when present. This preserves the existing `UsageItem` tooltip content.
- `kind === 'subscription'` with no `utilization` but `costUsd != null`: dollar icon + `$${costUsd.toFixed(2)}` (degrades to cost until the first rate-limit signal).
- `kind === 'pay-as-you-go'`: dollar icon + `$${costUsd.toFixed(2)}` primary; tooltip shows `detail` (provider/model) when present.
- Nothing renderable: the parent does not mount it (visibility is `usage != null && hasRenderableMetric`).

### Registry change: collapse two keys into one

In `status-bar-registry.ts`, remove the `cost` entry and repurpose the `usage` entry:

```ts
{
  key: 'usage',
  label: 'Usage & cost',
  description: 'Subscription utilization or session cost',
  group: 'session',
  icon: Gauge,
  defaultVisible: true,
},
```

- Drop `'cost'` from `StatusBarItemKey`.
- Remove `showStatusBarCost`/`setShowStatusBarCost` from the app store and the configure popover. These are client Zustand UI prefs (localStorage-persisted, not server `~/.dork/config.json`), so removal needs a store-version bump / `partialize` cleanup, not a `conf` migration. A user who had Cost visible keeps the single merged item (default-visible); a user who had hidden Cost only loses that specific toggle, which is acceptable for a pre-launch alpha.

### Store cleanup (dead code removal)

- Delete `usageInfo: UsageInfo | null` from `SessionState` and `DEFAULT_SESSION_STATE` in `session-chat-store.ts` (never written).
- Delete the unused `setRateLimitRetryAfter` and `setIsRateLimited` actions from `use-session-store-actions.ts` **only if** the rate-limited strip repair (below) is not done in the same phase; otherwise wire them.
- Remove the `usageInfo` read and the separate `costUsd`/`supportsCostTracking` cost item from `ChatStatusSection.tsx`, replaced by the single `usage`-driven item.

### Adjacent repair (optional, same phase): rate-limited strip state

The mid-turn "Rate limited, retrying in Ns" state in `ChatStatusStrip` is fed by `isRateLimited`/`rateLimitRetryAfter`, which nothing sets (same regression). If we route the Claude `rate_limit` `retryAfter` onto a status field or a small SessionEvent in the same mapper touch, the strip comes back to life. Recommended to include because the source event (`rate_limit_event`) is already being handled, but it is severable if scope must shrink. Note: reviving this DOES touch the strip, which reads from the legacy chat store, so wire `setIsRateLimited`/`setRateLimitRetryAfter` from the normalized path rather than leaving them dead.

## Testing Strategy

- **Shared schema** (`packages/shared`): unit tests for `UsageStatusSchema` (valid subscription, valid pay-as-you-go, rejects negative utilization/cost); assert `SessionStatusEventSchema` and the `status_change` payload accept `usage`.
- **Per-runtime mapper units**:
  - claude-code: `rate_limit_event` -> `session_status` with `kind: 'subscription'` + utilization + windowLabel + state; `isUsingOverage` -> `detail`; `result` -> `usage.costUsd` with held utilization re-attached (no kind flicker).
  - opencode: assistant message -> `usage: { kind: 'pay-as-you-go', costUsd }`.
  - codex: no `usage` on any emitted event.
- **Conformance** (`packages/test-utils/runtime-conformance.ts`): in the turn-based assertions, when an emitted `session_status`/`status_change` carries `usage`, assert it parses against `UsageStatusSchema` and that `utilization`/`resetsAt`/`windowLabel` appear only when `kind === 'subscription'`. This is a light additive check (no new required method), consistent with the suite being a behavioral gate over what runtimes emit.
- **Projector** (`apps/server`): a usage-only `status_change` merges into the held status without zeroing cost/context; a later cost-only status preserves prior `usage`.
- **Client**: `UsageStatusItem` render tests for each kind and the degraded subscription-without-utilization case; `ChatStatusSection` integration test that the merged item shows utilization for a subscription snapshot and cost for a pay-as-you-go snapshot, and hides for codex; update the dev showcase `StatusShowcases.tsx` (currently uses `UsageInfo`) to the new shape.
- **Grep gate**: after the change, `UsageInfo`, `usage_info`, and `usageInfo` have zero references outside their deletion diff.

## Implementation Phases

- **Phase 0 — Shared contract.** Add `UsageStatusSchema`/`UsageStatus`; add `usage?` to `SessionStatusEventSchema` and the `status_change` payload; remove `UsageInfoSchema`/`UsageInfo`; re-export from `types.ts`. Rebuild `@dorkos/shared`. Schema tests green.
- **Phase 1 — Server producers + projection.** claude-code, opencode mappers; move `formatLimitType` server-side; hold last utilization on `AgentSession`; `toStatusChange` fold; projector merge. Mapper + projector tests green.
- **Phase 2 — Client merge.** `UsageStatusItem`; delete `UsageItem`/`CostItem`; registry collapse + store pref removal; `derive-status-bar` `usage`; `ChatStatusSection` wiring; delete dead `usageInfo` field. Client tests + showcase green.
- **Phase 3 — Conformance + adjacent repair (optional).** Conformance `usage` assertion; optional rate-limited-strip revival. Full `pnpm verify` on affected packages.

## Related ADRs

- **ADR-0256 (RuntimeCapabilities shape).** Touched by decision, not by edit: we deliberately do **not** add a capability field for usage; the data self-gates. Worth a one-line note in the new ADR referencing why 0256's `features` hatch was not used.
- **ADR-0258 (capability-gated sub-interfaces, not no-op methods).** The governing precedent for rejecting a `getUsageStatus()` method on the universal `AgentRuntime` surface. Cited as rationale.
- **ADR-0255 / ADR-0310 (durable session stream, runtime-owned storage, `session_status` projection).** The carrier this design reuses.
- **New ADR warranted: yes.** Proposed title: **"Runtime usage/cost as a session-status field, not a runtime method"** (suggested slug `runtime-usage-as-session-status-field`). It records two real decisions that clear the significance bar: (1) usage is push data on the existing projection, rejecting the candidate `getUsageStatus()` method per 0258; (2) Usage and Cost merge into one kind-driven status item. Name only; author via `/adr:from-spec` at extraction, do not write it here.

## Rejected Alternatives

- **Synchronous `getUsageStatus(): UsageStatus | null` on `AgentRuntime`** (the brief's candidate): fights the push architecture, duplicates the stream, returns stale/null pre-turn, and makes non-subscription runtimes implement a no-op `return null` (the 0258 anti-pattern). Rejected.
- **A first-class `usage_update` SessionEvent type:** cleaner separation, but requires a new client allowlist entry, a new projector case, and new snapshot handling for a value that is conceptually part of session status (it sits next to cost and context). More surface for no legibility gain. Rejected in favor of the `status_change` field; documented so a reviewer can pick it up if they disagree.
- **Keep two separate items (Usage + Cost):** the fallback if the merge reads worse in review. Retained as the escape hatch, not the recommendation.
  </content>
