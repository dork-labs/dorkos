---
slug: task-completion-notifications
id: 260711-031801
created: 2026-07-10
status: specified
linearIssue: DOR-240
---

# Automatic task-completion notifications ("your agent finished")

**Status:** Draft
**Author:** Beacon (flow SPECIFY)
**Date:** 2026-07-10

## Overview

Make the launch promise true: when a **scheduled or manual Task run finishes while the user is
away, their phone buzzes with a useful message — with zero agent cooperation required.** Today
the only proactive path is the agent voluntarily calling the `relay_notify_user` MCP tool, which
needs an established chat and (since DOR-239) `canInitiate=true` + `enabled=true`. This spec adds
a **system-level** notification actor that fires when any Task run reaches a terminal status,
resolves the linked agent's bound channel, and delivers a completion message through the existing
Relay pipeline — inheriting budgets, dead-lettering, and permission gates for free.

## Background / Problem Statement

The homepage ("Your agents can reach you anywhere") and the flagship demo (Script 1, "2:47 AM":
an unprompted Telegram buzz — _"Atlas: test suite expanded, 14 new tests, 2 real bugs found.
Opened PR #312"_) describe **fully automatic** completion notifications for unattended work.
DOR-236's smoke test confirmed the code cannot do this:

1. No session/turn-completion hook pushes to a bound channel when a run finishes.
2. `relay_notify_user` is agent-initiated — nothing defaults or forces the agent to call it.
3. It hard-fails with `NO_ACTIVE_SESSIONS` unless the human messaged the bot first.
4. Auto-delivery only happens for turns that _originated_ from that same chat; web/CLI-dispatched
   background work never reaches Telegram.

Per the AGENTS.md demo-claim gate (`meta/positioning-202607/09-gtm-plan.md` §2.0), a pillar we
cannot demonstrate cannot ship as copy. This spec closes the gap so the claim is honest.

**Measurable outcome:** on a fresh instance, bind a Telegram channel to an agent with
`canInitiate` enabled, message the bot once, create a `* * * * *` scheduled task on that agent,
walk away — every minute the phone receives one glanceable completion message, and no
`relay_notify_user` tool call appears in the run transcript.

## Goals

- A Task run reaching a terminal status triggers **exactly one** notification attempt, on any
  execution path (relay task-handler, direct execution, or a failure/no-receiver write).
- Zero agent cooperation: the agent never calls a tool; the message originates server-side.
- Delivery rides `RelayCore.publish` so budgets (PR #210 / DOR-260), dead-lettering,
  rate-limiting, and access control apply identically to `relay_notify_user`.
- Honor user consent: respect `enabled` and `canInitiate` on the resolved binding (DOR-239),
  plus the new per-binding opt-in.
- Always notify on **failure**; notify on **success** per the opt-in; never on **cancelled**.
- Honest bootstrap: when no chat session exists, no-op silently and surface a "message your bot
  once" hint in the binding UI — never error a run.
- Message content matches the demo bar: task name, outcome, duration, first line of output.

## Non-Goals

- Notifying on **interactive session turns** (spam; the user is watching).
- Quiet hours / DND (would break the 2:47 AM demo), batching/digests, cross-channel fan-out —
  all deferred.
- Email/SMS or any non-Relay channel; Telegram is the reference adapter (Slack/webhook inherit
  automatically via the same publish path).
- Replacing or changing `relay_notify_user` — the agent-initiated path stays for ad-hoc,
  mid-run pings.
- Notifying for **global (agent-less)** tasks in v1 (see Open Question 2).

## Technical Dependencies

- `@dorkos/relay` `RelayCore.publish` + the PR #210 budget gate (`relay-publish.ts`).
- `@dorkos/shared/relay-adapter-schemas` `AdapterBindingSchema` (additive field).
- Existing `BindingStore`, `BindingRouter` (`getSessionsByBinding`, reads persisted
  `sessions.json`), `AdapterManager`.
- `croner`-driven `TaskSchedulerService`, `TaskStore`, and the `packages/relay`
  `claude-code/task-handler.ts` (both write terminal status through `TaskStore.updateRun`).
- No new external libraries.

## Detailed Design

### Architecture changes

Introduce one new server-side actor, `TaskCompletionNotifier`, fed by a single **store-level
terminal hook**. Extract the channel-resolution logic currently embedded in
`createRelayNotifyUserHandler` into a shared helper reused by both the tool and the notifier.

```
run reaches terminal
   │  (relay task-handler.ts  OR  executeRunDirect  OR  a failure write)
   ▼
TaskStore.updateRun(id, {status: terminal})   ← DOR-248 guard: fires the hook exactly once
   │  onRunTerminal(run, task)   (optional injected callback; fire-and-forget)
   ▼
TaskCompletionNotifier.handle(run, task)
   │  1. gate: status policy (fail→always, complete→opt-in, cancel→never)
   │  2. resolve opt-in: task.notifyOnComplete ?? binding.notifyOnTaskComplete
   │  3. resolveNotifyTarget(agentId, …)  ← shared with relay_notify_user
   │        (enabled!==false, canInitiate===true, most-recent active chat session)
   │  4. format message (writing-for-humans)
   ▼
RelayCore.publish('relay.human.<type>.<adapterId>.<chatId>', msg, { budget })
   ▼
adapter delivers → phone buzzes
```

### Implementation approach

**1. Store-level terminal hook (`TaskStore`).**
`TaskStore` gains an optional injected callback:

```ts
export type RunTerminalListener = (run: TaskRun, task: Task | null) => void;
```

Wired via the constructor/setter (`setOnRunTerminal`). Inside `updateRun`, the DOR-248 terminal
guard already detects "this run just became terminal": the callback fires **only** on the
write that transitions a non-terminal run to a terminal status (never on the ignored
already-terminal no-op, never on a `running` write). It is invoked **after** the DB write, wrapped
in try/catch so a notifier failure can never corrupt run persistence, and dispatched
fire-and-forget (`queueMicrotask`) so notification latency never blocks the run's status write.
When no listener is set (tests, `packages/relay` consumers that construct their own store), the
behavior is unchanged.

> Design note: the store stays a pure data layer — it holds a callback reference and calls it,
> and contains **no** binding/relay/notification logic. This mirrors DOR-248's decision to keep
> the run-lifecycle authority in the store.

**2. `TaskCompletionNotifier` service** — `apps/server/src/services/tasks/task-completion-notifier.ts`.
Dependencies (all injected, all optional-tolerant): `bindingStore`, `bindingRouter`,
`adapterManager`, `relayCore`, `taskStore` (to read the task if not passed), `logger`. `handle`:

- Returns immediately if `!isRelayEnabled()` or relay deps are missing (no channel to deliver on).
- **Status policy:** `cancelled` → return; `failed` → proceed (always); `completed` → proceed
  only if the opt-in resolves truthy.
- **Opt-in resolution:** `task.notifyOnComplete` when set (per-task override), else the resolved
  binding's `notifyOnTaskComplete`.
- **Target resolution:** `resolveNotifyTarget(agentId, {bindingStore, bindingRouter,
adapterManager, channel?})` — the extracted helper. If `agentId` is null (global task) → return
  (Open Question 2). If no binding, no active session, `enabled===false`, or `canInitiate===false`
  → return silently (these are expected, not errors; log at debug).
- **Message:** `formatCompletionMessage(task, run)` (see UX).
- **Publish:** `relayCore.publish(subject, message, { from: <system principal>, budget: { maxHops:
2, ttl: Date.now() + 30_000, callBudgetRemaining: 1 } })`. A completion ping is a terminal leaf
  (no downstream agent turn), so a minimal budget is correct; the PR #210 gate rejects + dead-
  letters if ever over budget. On a `rejected`/`deliveredTo===0` result, log at debug — never throw.

**3. Extract the shared resolver.** Move the binding-filter → active-session-pick → `canInitiate`
gate → subject-build block out of `createRelayNotifyUserHandler` into
`resolveNotifyTarget(...)` in `relay-helpers.ts` (or a new `notify-target.ts` under
`services/relay/`). `createRelayNotifyUserHandler` calls it and maps the structured result to its
existing tool error codes (`NO_BINDING`, `NO_ACTIVE_SESSIONS`, `INITIATE_NOT_ALLOWED`) so its
behavior and tests are unchanged; the notifier calls the same helper and treats every "cannot
resolve" outcome as a silent no-op. Result shape:

```ts
type NotifyTarget =
  | {
      ok: true;
      subject: string;
      adapterId: string;
      adapterType: string;
      chatId: string;
      bindingId: string;
    }
  | {
      ok: false;
      reason: 'NO_BINDING' | 'NO_ACTIVE_SESSIONS' | 'INITIATE_NOT_ALLOWED';
      availableChannels?: string[];
    };
```

**4. Wiring (`index.ts`).** After `BindingRouter`, `AdapterManager`, `RelayCore`, and `TaskStore`
are constructed, build the `TaskCompletionNotifier` and register it via
`taskStore.setOnRunTerminal((run, task) => notifier.handle(run, task))`. Because the relay
task-handler and the scheduler share the **same in-process `TaskStore` instance**, this single
registration covers both execution paths.

### API changes

None to HTTP routes. The binding PATCH body (`UpdateBindingRequestSchema`) and create body gain
the optional `notifyOnTaskComplete` field (see Data model). Tasks create/update
(`CreateTaskStoreInput` / `UpdateTaskRequest` + the task SKILL.md frontmatter) gain optional
`notifyOnComplete`.

### Data model changes

- **`AdapterBindingSchema`** (`packages/shared/src/relay-adapter-schemas.ts`): add
  `notifyOnTaskComplete: z.boolean().default(false)`. Add to `CreateBindingRequestSchema`
  (inherited via omit) and `UpdateBindingRequestSchema` (`.optional()`). Default **false** so
  nothing fires until the user opts a channel in — and note `canInitiate` also defaults false, so
  the notifier is doubly gated by default (see Open Question 1 — founder may flip the default to
  true-gated-behind-canInitiate). Persisted in the binding store (`~/.dork/relay/bindings*`),
  **not** `conf` — so this uses the binding-store's own load-time defaulting (Zod `.default()`
  backfills old records on read), not a `config-schema.ts` `conf` migration. No `adding-config-fields`
  conf migration is required; the `adding-config-fields` _discipline_ (schema → default → read-path
  backfill → docs → test) still applies to the binding schema.
- **Task** (`packages/shared` task types + `@dorkos/skills` `TaskDefinition` meta): add optional
  `notifyOnComplete?: boolean` (SKILL.md frontmatter key `notify-on-complete`), `null`/absent =
  inherit the binding default. Threaded through `TaskStore` create/upsert and `mapTaskRow`.

### Code structure & file organization

- `apps/server/src/services/tasks/task-completion-notifier.ts` — new service (+ `__tests__/`).
- `apps/server/src/services/tasks/task-store.ts` — add `setOnRunTerminal` + fire in `updateRun`.
- `apps/server/src/services/relay/notify-target.ts` (or extend `relay-helpers.ts`) — shared
  `resolveNotifyTarget`.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts` — refactor
  `createRelayNotifyUserHandler` to call the shared resolver.
- `packages/shared/src/relay-adapter-schemas.ts` — `notifyOnTaskComplete`.
- `packages/skills/*` + task types — `notifyOnComplete`.
- Client binding UI (`BindingAdvancedSection.tsx` / `BindingDialog.tsx`) — toggle + bootstrap hint.
- `apps/server/src/index.ts` — wiring.

## User Experience

**Setup (once):** Agents → open agent → Settings → Channels → add Telegram (paste BotFather
token, validate, choose Long Polling) → Bind (per-chat) → toggle **"Notify me when tasks
finish"** on → enable **"Agent can start conversations"** (`canInitiate`). The binding row shows a
one-line hint while no chat session exists: **"Message your bot once to activate notifications"**
(bots can't text you first). After the user sends any message to the bot, the hint clears.

**Steady state:** create a scheduled task on that agent, walk away. On each terminal run, the
phone receives one message. Proposed copy (writing-for-humans; control-panel tone, plain
language):

- Success: `✅ Nightly tests — done in 4m 12s. 14 new tests, 2 bugs found. Opened PR #312.`
  (task display name + duration + first line of `outputSummary`, truncated ~200 chars).
- Failure: `⚠️ Nightly tests — failed after 2m 03s. <error, first line>.`

**Error/exit paths (all silent no-ops, never surfaced as a failed run):** relay off; no binding;
`enabled=false`; `canInitiate=false`; no active chat session; over-budget publish (dead-lettered
by the pipeline). Each logs at debug for diagnosis.

## Testing Strategy

- **Unit — `TaskStore.updateRun` hook:** fires the listener exactly once on non-terminal→terminal;
  does **not** fire on the already-terminal no-op (DOR-248 path); does **not** fire on a
  `running` write; a throwing listener does not break the DB write or the returned run.
- **Unit — `TaskCompletionNotifier.handle`:** (purpose-commented, each can fail)
  - `failed` run → publishes even when opt-in is off.
  - `completed` + opt-in on → publishes; `completed` + opt-in off → no publish.
  - `cancelled` → never publishes.
  - per-task `notifyOnComplete` overrides the binding default (both directions).
  - `canInitiate=false` → no publish (reuses DOR-239 semantics via the shared resolver).
  - `enabled=false` binding → no publish.
  - no active session → no publish, no throw.
  - relay disabled / missing deps → no publish, no throw.
  - publish carries a bounded budget; a `rejected` publish result is swallowed (no throw).
  - `agentId=null` (global task) → no publish (documents Open Question 2 behavior).
- **Unit — `resolveNotifyTarget`:** binding filter tiers, most-recent-session pick,
  `canInitiate`/`enabled` gates, subject construction — moved from the existing
  `relay_notify_user` tests; assert `createRelayNotifyUserHandler` still maps outcomes to its
  original error codes (regression: DOR-239 tests stay green unchanged).
- **Integration — end-to-end via relay task path:** using `FakeAgentRuntime` + a fake adapter,
  dispatch a scheduled run through `executeRunViaRelay`; on terminal completion assert exactly one
  message published to the expected `relay.human.…` subject with the formatted body. Confirms the
  in-process shared-`TaskStore` wiring covers the default relay path with **no** `relay_notify_user`
  call.
- **Schema/migration:** an old binding record without `notifyOnTaskComplete` loads with the field
  defaulted (read-path backfill), and round-trips through PATCH.
- **Mocking:** `RelayCore.publish` spy; fake `BindingStore`/`BindingRouter`/`AdapterManager` from
  `@dorkos/test-utils` patterns.

## Performance Considerations

Negligible. The hook is a single `queueMicrotask` per terminal run (runs are minutes apart at
most); resolution is in-memory map/array lookups already used by `relay_notify_user`; one
bounded relay publish. Fire-and-forget dispatch keeps run-status writes off the notification path.

## Security Considerations

- **Consent is enforced, not decorative:** the notifier honors `enabled` and `canInitiate`
  (DOR-239) via the shared resolver — a user who left "Agent can start conversations" off gets no
  proactive pings from tasks either. The new opt-in adds a second explicit gate.
- **No spoofing:** publishes use the server-injected system principal (same pattern as every send
  tool), so namespace access rules apply; the run/task never supplies the `from`.
- **Budget-bounded:** the PR #210 gate rejects + dead-letters an over-budget notification before
  any dispatch, so the pathway cannot be turned into an amplification vector.
- **No secret leakage:** the message body is the task name + truncated first line of output; the
  spec must ensure `outputSummary` truncation does not ship full tool output. (Output already
  capped at 500–1000 chars upstream; the notifier further truncates to ~200.)

## Documentation

- `docs/` Tasks + Channels guides: document the "Notify me when tasks finish" toggle, the
  `canInitiate` requirement, and the "message your bot once" precondition (honest bootstrap).
- Update `meta/value-architecture-applied.md` / demo reality-ledger only **after** an end-to-end
  live-token verification (demo-claim gate) — not part of this spec's merge.
- A `changelog/unreleased/` fragment at EXECUTE (writing-for-humans).

## Implementation Phases

- **Phase 1 — MVP/core:** store terminal hook; `TaskCompletionNotifier`; extract
  `resolveNotifyTarget`; `notifyOnTaskComplete` binding field (default per Open Question 1);
  always-on failure notifications + opt-in success; wiring; tests. Delivers the acceptance
  criterion for agent-linked Telegram tasks.
- **Phase 2 — controls:** per-task `notifyOnComplete` override + SKILL.md frontmatter; binding-UI
  toggle + bootstrap hint.
- **Phase 3 — polish (deferred, out of this spec):** global-default channel for agent-less tasks;
  quiet hours; digest batching.

## Open Questions

1. **Default of `notifyOnTaskComplete`** — ship default `false` (fully opt-in) or `true`
   (relying on `canInitiate` — itself default `false` — as the real gate so the demo works with
   one toggle)? Spec currently draws it `false` for conservatism; **founder call.**
2. **Global (agent-less) tasks** — `agentId=null` tasks have no binding to resolve. v1 = no
   notification (documented). Acceptable for launch, or is a global-default notification channel
   needed for the demo? **founder call.**
3. **Message copy/voice** — confirm the emoji + name + duration + first-output-line shape and the
   ~200-char truncation. **founder sign-off.**

## Related ADRs

- Draft ADR `260711-031624` (seeded by this spec): "System-level task-completion notifications
  originate from a store terminal hook." See `decisions/`.
- ADR-285 (task firing/leader/idempotency), DOR-248/DOR-249 (run terminal-status guard),
  DOR-260/PR #210 (budget gate), DOR-239/PR #219 (`canInitiate` enforcement) — all constraints
  this design threads through.

## References

- Linear: DOR-240 (this), DOR-236 (smoke findings), DOR-239 (PR #219), DOR-248 (PR #199), DOR-260 (PR #210).
- `meta/positioning-202607/08-demo-video-scripts.md` (Script 1 "2:47 AM").
- `meta/value-architecture-applied.md` (notification-routing claims).
- `research/20260324_relay_outbound_awareness.md` (contact-context / `relay_notify_user` design).
- Code: `task-store.ts`, `task-scheduler-service.ts`, `packages/relay/adapters/claude-code/task-handler.ts`,
  `binding-router.ts`, `relay-tools.ts`, `relay-adapter-schemas.ts`, `relay-publish.ts`.
