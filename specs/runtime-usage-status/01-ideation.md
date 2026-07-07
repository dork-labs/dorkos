---
slug: runtime-usage-status
number: 260707-124033
created: 2026-07-07
status: ideation
---

# Runtime-agnostic usage/cost status: one abstraction across runtimes and subscription states

**Slug:** runtime-usage-status
**Author:** Dorian (via DOR-100 design task)
**Date:** 2026-07-07
**Tracker:** DOR-100

---

## 1) Intent & Assumptions

- **Task brief:** The usage-status UI is Claude-Code-specific today (it reads Claude SDK rate-limit events). As DorkOS hosts more runtimes (Codex, OpenCode), usage/quota/cost display needs one abstraction defined at the runtime/data layer, not per-runtime UI. Introduce a single runtime-neutral `UsageStatus` shape that every runtime can populate, render it with one intelligent status item, and hide it for runtimes that have no meaningful quota or cost.
- **Assumptions:**
  - The status strip is fed by the durable per-session SSE path (snapshot then gap-free replay then live events), not by synchronous runtime method calls. Cost already rides this path via `session_status`; usage should too.
  - Subscription utilization is account-scoped and push-derived (it arrives opportunistically on Claude `rate_limit_event`). Session cost is session-scoped and push-derived (it arrives on `result`). A pull-style getter would have to poll and duplicate the stream, so a data-on-the-stream design is the honest fit.
  - "Fewer status items is the Rams answer if legibility survives" (from the brief). One merged item is in scope; two separate items is the fallback if the merge reads worse.
  - Runtimes without meaningful usage return nothing and the item hides. No placeholder, no "n/a".
- **Out of scope:**
  - Account-scoped usage surfaces beyond the per-session status strip (a dedicated "usage" page, org-level burn dashboards). Noted as a future extension the type is designed to accommodate.
  - Billing, plan management, or purchasing flows.
  - The mid-turn "Rate limited, retrying in Ns" strip state in `ChatStatusStrip` is adjacent (it shares the same Claude `rate_limit_event` source and is also currently dead, see below). It is called out as an in-scope repair opportunity in the same server mapper touch, but the headline deliverable is the status-bar item.

## 2) Pre-reading Log

- `packages/shared/src/agent-runtime.ts`: the `AgentRuntime` interface and `RuntimeCapabilities`. Capabilities keep genuinely-boolean flags flat (`supportsCostTracking` among them), promote permission modes to a structured shape, and offer a typed `features: Record<string, unknown>` escape hatch (ADR-0256). Optional methods already exist on the interface (`getMcpStatus?`, `reloadPlugins?`), so the pattern for an optional per-runtime capability is established.
- `packages/shared/src/schemas.ts`: `SessionStatusEventSchema` (the `session_status` StreamEvent carrier, already carries `costUsd`, `model`, token/cache fields) and `UsageInfoSchema` (the current Claude-specific subscription-utilization shape: `status`, `utilization`, `resetsAt`, `rateLimitType`, `isUsingOverage`). `UsageInfo` is the type this spec supersedes.
- `apps/server/src/services/runtimes/claude-code/sdk/event-mappers/result-event-mapper.ts`: on `rate_limit_event` it emits a `rate_limit` StreamEvent (retryAfter) plus a separate `usage_info` StreamEvent built from `rate_limit_info`. On `result` it emits `session_status` with `costUsd` and token/cache figures.
- `apps/server/src/services/session/session-event-normalizer.ts`: folds StreamEvents into durable SessionEvents. It has a `session_status` case (folded into a partial `status_change`) but **no case for `usage_info` or `rate_limit`**. So these two StreamEvents are dropped on the durable path.
- `apps/server/src/services/session/session-state-projector.ts`: merges partial `status_change` payloads into a held status (`model`, `cost`, `contextUsage`, `cacheStats`), field-wise, preserving absent fields. This is the merge engine `usage` must plug into.
- `apps/client/src/layers/entities/session/model/session-chat-store.ts`: declares a per-session `usageInfo: UsageInfo | null` field, initialized to `null`. **No code ever writes it.** `apps/client/src/layers/features/chat/model/use-session-store-actions.ts` defines `setRateLimitRetryAfter` and `setIsRateLimited`, but neither is called anywhere, and there is no `setUsageInfo` action at all.
- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx`: the status-bar wiring hub. It reads `usageInfo` from the legacy store (always null in practice) and `costUsd` from the snapshot-backed `deriveStatusBarValues`. Cost is capability-gated on `supportsCostTracking` via `useCapabilitiesForRuntime`.
- `apps/client/src/layers/features/status/ui/UsageItem.tsx` and `CostItem.tsx`: the two presentational items this spec merges. `apps/client/src/layers/features/status/model/status-bar-registry.ts`: the static, runtime-agnostic registry with separate `cost` and `usage` keys and their Zustand visibility bridge.
- `apps/client/src/layers/features/chat/model/stream/derive-status-bar.ts`: projects the snapshot status into `{ contextPercent, costUsd, model, cacheStatus }`. This is where a `usage` field is added.
- `apps/server/src/services/runtimes/{claude-code,codex,opencode}/runtime-constants.ts`: capability declarations. claude-code `supportsCostTracking: true`; codex `false` (tokens only, no dollar cost); opencode `true` (real per-message USD cost). None declares anything about subscription usage today.
- `packages/test-utils/src/runtime-conformance.ts`: the shared behavioral gate. Its `capabilities` block structurally validates `getCapabilities()`. Any new capability surface must fit here.
- `decisions/0256-...capabilities-shape...md` and `decisions/0258-capability-gated-sub-interfaces...md`: the two governing ADRs. 0258 is the load-bearing one here: runtime-specific behavior is exposed as data/typed sub-interfaces, never as no-op methods on the universal `Transport`/`AgentRuntime` surface.

## 3) Codebase Map

- **Shared types** (`packages/shared/src/schemas.ts`, `types.ts`): add `UsageStatusSchema` + `UsageStatus`; add `usage?` to `SessionStatusEventSchema`; add `usage?` to the `status_change` SessionEvent status payload (`session-stream.ts`); remove `UsageInfoSchema`/`UsageInfo`.
- **Server mappers** (`apps/server/src/services/runtimes/*/`): claude-code stamps `usage` (subscription + utilization) onto a `session_status` StreamEvent; opencode stamps `usage` (pay-as-you-go + cost); codex omits it. `session-event-normalizer.ts` `toStatusChange` folds `usage` through; `session-state-projector.ts` merges it.
- **Client** (`apps/client/src/layers/features/status/` and `.../chat/`): new merged `UsageStatusItem`, delete `UsageItem`/`CostItem`, collapse the `cost` + `usage` registry keys into one, add `usage` to `derive-status-bar`, delete the dead `usageInfo` store field and the two dead rate-limit actions.
- **Tests**: shared schema test; per-runtime mapper unit tests; a conformance addition validating any emitted `usage`; `ChatStatusSection` integration; dev showcase (`StatusShowcases.tsx`) update.

## 4) Open Questions to Resolve in the Spec

- **(a) How do no-single-subscription runtimes report?** OpenCode fronts multiple providers with no shared quota. Aggregate utilization is meaningless. Resolution below: OpenCode reports `pay-as-you-go` with cumulative session `costUsd`; no per-provider quota.
- **(b) What states must the type support?** active subscription with utilization; kind-known-but-utilization-not-yet-observed; pay-as-you-go with cost and no quota; nothing meaningful (hide).
- **(c) Merge Usage and Cost into one item?** Resolution below: yes, one item that flips its primary metric by kind.

## 5) Direction (carried into 02-specification.md)

- Define `UsageStatus` as runtime-neutral data carried on the existing `session_status` projection. Reject the standalone `getUsageStatus()` method (it fights the push architecture and 0258).
- Merge Usage + Cost into one `UsageStatusItem`: subscription renders utilization primary with cost in the tooltip; pay-as-you-go renders cost primary.
- Repair the regression: the current Usage item is dead because `usage_info` is dropped on the durable path. Routing usage onto `session_status` fixes it as a side effect.
  </content>
