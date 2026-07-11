---
slug: task-completion-notifications
id: 260711-031801
created: 2026-07-10
status: ideation
linearIssue: DOR-240
---

# Automatic "your agent finished" notifications

**Slug:** task-completion-notifications
**Author:** Beacon (flow IDEATE)
**Date:** 2026-07-10

---

## 1) Intent & Assumptions

- **Task brief (DOR-240):** The homepage and the launch demo (Script 1, "2:47 AM") promise
  "Get a Telegram message when your agent finishes a task" and show an _unprompted_ phone
  buzz at 2:47 AM while the founder sleeps. The code cannot do this today. The only proactive
  path is the agent voluntarily calling the `relay_notify_user` MCP tool, which (a) the agent
  must decide to call, (b) hard-fails with `NO_ACTIVE_SESSIONS` unless the human messaged the
  bot at least once, and (c) since DOR-239 (PR #219) additionally requires the resolved binding
  to have `canInitiate=true` and `enabled=true`. Make the marketing claim true: an unattended
  task run finishes → the user's phone buzzes with a useful message, with **zero agent
  cooperation required**.

- **Assumptions:**
  - The high-signal, in-scope completion event is a **scheduled or manual Task run** (the
    Tasks subsystem), because that is unattended work — exactly the 2:47 AM story. The user is
    away; the buzz is the whole point.
  - Delivery rides the **existing Relay publish pipeline** (`relay.human.<type>.<id>.<chat>`
    → adapter), so budgets (PR #210 / DOR-260), dead-lettering, rate-limiting, and access
    control apply for free and consistently with `relay_notify_user`.
  - The Telegram platform constraint is real and permanent: a bot **cannot** DM a user who has
    never messaged it. So "user messaged the bot once" is a genuine precondition, not a bug —
    it must be surfaced honestly in UI, not papered over.
  - Relay is the default-on transport; the Tasks scheduler already runs unattended runs through
    it (`executeRunViaRelay`), and DOR-248 (PR #199) fixed run completion so terminal status
    (`completed`/`failed`) is now reliably written for every run.

- **Out of scope:**
  - Notifying on **interactive session turns** — the user is watching; per-turn pings are spam.
  - Quiet hours / do-not-disturb — the flagship demo _wants_ the 2:47 AM buzz; a quiet-hours
    default would break it. Deferred.
  - Batching / digest rollups. Deferred.
  - Email/SMS channels — Relay adapters (Telegram first) only.
  - Making `relay_notify_user` smarter — this spec adds a system-level path _alongside_ it,
    it does not replace it.

## 2) Pre-reading Log

- `DOR-240`, `DOR-236` (smoke findings), `DOR-239` (PR #219, canInitiate enforcement),
  `DOR-248` (PR #199, run terminal-status fix): established the exact gap and the constraints an
  automatic hook must honor.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts`
  (`createRelayNotifyUserHandler`): the current agent-initiated path. It resolves the agent's
  bindings, filters `enabled !== false`, finds the most recent active chat session via
  `bindingRouter.getSessionsByBinding`, gates on `canInitiate`, then publishes to
  `relay.human.<adapterType>.<adapterId>.<chatId>`. **This resolution logic is exactly what a
  system-level notifier needs** — it should be extracted and reused, not reimplemented.
- `apps/server/src/services/tasks/task-scheduler-service.ts`: `executeRunViaRelay` publishes a
  `TaskDispatchPayload` to `relay.system.tasks.<taskId>` and marks the run `running`; the real
  completion write happens in the relay task-handler. `executeRunDirect` (relay-off path) writes
  the terminal status itself. `emitRunEvent` fires an ActivityService event — but **only** in
  the direct/failure paths, not on a relay-path success. So ActivityService is _not_ a reliable
  completion seam.
- `packages/relay/src/adapters/claude-code/task-handler.ts`: on the default relay path, THIS is
  where a successful run's terminal status is written (`deps.taskStore.updateRun(runId, {status:
'completed', outputSummary, durationMs, ...})`). It runs in-process in the same server, against
  the same `TaskStore` instance.
- `apps/server/src/services/tasks/task-store.ts`: `updateRun` is the **single chokepoint** every
  path funnels through, and it already owns the DOR-248 terminal-status guard
  (`isTerminalRunStatus`). A run reaches terminal here exactly once. This is the natural,
  path-agnostic hook point.
- `apps/server/src/services/relay/binding-router.ts`: `getSessionsByBinding` reads the persisted
  `sessions.json` session map (survives restart), so a known chat session persists across
  reboots — a notification does not need a live in-memory session established this boot.
- `packages/shared/src/relay-adapter-schemas.ts` (`AdapterBindingSchema`): bindings carry
  `enabled`, `canInitiate` (default false), `canReply`, `canReceive`, `chatId?`. The binding is
  the object that already means "this agent may reach me on this channel" — the right home for a
  notification preference.
- PR #210 / DOR-260 (`packages/relay/src/relay-publish.ts` budget gate): any proactive publish
  must carry a budget; the pipeline rejects + dead-letters an over-budget message before any
  costly dispatch. A completion notification is a terminal leaf (no downstream agent turn), so a
  minimal budget is correct and safe.
- `meta/positioning-202607/08-demo-video-scripts.md` (Script 1) &
  `meta/value-architecture-applied.md`: the exact promises — "Your agents can reach you," the
  2:47 AM Telegram buzz with a run summary ("test suite expanded, 14 new tests, 2 real bugs
  found. Opened PR #312"). The message content bar is: specific, useful, glanceable.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/tasks/task-store.ts` — `updateRun` terminal chokepoint (add the
    completion hook here).
  - `apps/server/src/services/tasks/` — home for a new `TaskCompletionNotifier` service.
  - `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts` +
    `relay-helpers.ts` — extract the binding/session/channel resolution used by
    `relay_notify_user` into a shared helper both callers use.
  - `packages/shared/src/relay-adapter-schemas.ts` — `AdapterBinding` schema (new opt-in field).
  - `apps/server/src/services/relay/binding-store.ts` / `binding-router.ts` — binding lookup +
    active-session resolution.
- **Shared dependencies:** `RelayCore.publish`, `BindingStore`, `BindingRouter`,
  `AdapterManager`, `ActivityService` (already emits run events for the UI).
- **Data flow (target):** task run reaches terminal in `TaskStore.updateRun` → fire
  `onRunTerminal(run, task)` → `TaskCompletionNotifier` checks opt-in + resolves the linked
  agent's bound channel + formats a message → `RelayCore.publish('relay.human.…', msg, {budget})`
  → adapter delivers → phone buzzes.
- **Feature flags/config:** `isRelayEnabled()` (relay must be on to deliver); new per-binding
  opt-in field; optional per-task override.
- **Potential blast radius:** `TaskStore` (new optional callback — must not change existing
  behavior when unset); binding schema (additive field + a `conf`-independent binding-store
  migration); Tasks wiring in `index.ts`; the shared resolution helper (refactor of
  `relay_notify_user`, covered by existing tests DOR-239 added).

## 4) Root Cause Analysis

Not a bug in the classic sense — a **missing capability** the marketing already claims. The
"root cause" of the claim/reality gap: completion is only ever surfaced (a) to the Activity feed
(in-app) and (b) to the originating chat when the run _came from_ that chat. There is no
server-side actor that, on any run's terminal transition, proactively pushes to a bound channel.
Nothing forces or defaults the agent to call `relay_notify_user`, and even a well-behaved agent
hits `NO_ACTIVE_SESSIONS` / `INITIATE_NOT_ALLOWED`. The fix is to add that missing actor at the
one place every run terminates.

## 5) Research

### Potential solutions (where to originate the notification)

1. **Store-level terminal hook → `TaskCompletionNotifier` service (RECOMMENDED).**
   Add an optional `onRunTerminal(run, task)` callback to `TaskStore`, fired from inside the
   existing DOR-248 terminal guard in `updateRun` (so it fires **exactly once** per run,
   regardless of which path — relay task-handler, `executeRunDirect`, or a failure write — got
   there). A new `TaskCompletionNotifier` subscribes, applies the opt-in preference, resolves the
   linked agent's channel via the shared helper, formats a message, and publishes through Relay.
   - _Pros:_ one seam catches **every** completion path; mirrors the DOR-248 instinct (the store
     is already the authority on "a run finished, once"); notifier logic lives server-side, out
     of `packages/relay`; reuses the proven `relay_notify_user` resolution (budgets, canInitiate,
     enabled, dead-lettering all inherited); zero agent cooperation.
   - _Cons:_ `TaskStore` gains one outward callback (kept a pure, injected, fire-and-forget
     side-effect — no notifier logic in the store).

2. **Subscribe a notifier to `relay.system.tasks.*.response` (or a new completion subject).**
   - _Pros:_ fully decoupled from the store.
   - _Cons:_ the relay-off `executeRunDirect` path publishes no response, so coverage is
     inconsistent; would require the scheduler to publish a synthetic completion event on both
     paths — more moving parts than a single store hook. Rejected.

3. **Duplicate notify logic at each terminal call site** (task-handler.ts in `packages/relay`
   _and_ `executeRunDirect` in the server).
   - _Cons:_ DRY violation; forces notification-preference + binding logic into `packages/relay`,
     which must not own it; two places to keep in sync. Rejected.

4. **Force/instruct the agent to call `relay_notify_user` on completion** (prompt injection in
   `buildTaskAppend`).
   - _Cons:_ still "agent cooperation required," still hits `NO_ACTIVE_SESSIONS`, unreliable
     (the model may not comply), and burns a tool call / tokens. Fails the acceptance criterion.
     Rejected as the primary mechanism (though the agent path remains available for ad-hoc
     mid-run pings).

### Recommendation

**Option 1.** Originate notifications from a store-level terminal hook feeding a
`TaskCompletionNotifier`, delivering via the extracted-and-shared Relay resolution helper. Scope
v1 to Task runs (scheduled + manual). Always notify on **failure**; notify on **success**
per the opt-in. Reuse DOR-239's `canInitiate` gate and the `enabled` filter unchanged. Surface
the "message your bot once" precondition honestly in the binding UI.

### Design tensions & resolutions (from the brief)

- **(a) Opt-in surface:** per-binding toggle as the zero-config default (the binding already
  means "this agent may reach me here"), with an optional per-task override for noise control.
  See Decision 2.
- **(b) Which completions notify:** scheduled + manual **Task** runs only; interactive session
  turns explicitly excluded. See Decision 1.
- **(c) Noise control:** always-notify-on-failure + opt-in-on-success; no batching/quiet-hours in
  v1 (quiet hours would kill the 2:47 AM demo). Cancelled runs do not notify (user-initiated).
- **(d) Bootstrap:** "user messaged the bot once" is a hard, honestly-surfaced precondition;
  when no chat session exists the notifier no-ops silently (and the binding UI shows an
  "activate by messaging your bot" hint). It never errors a run.
- **(e) Delivery:** through `RelayCore.publish` with a minimal budget so budgets / permissions /
  dead-lettering apply for free.

## 6) Decisions

| #   | Decision                          | Choice                                                                                                          | Rationale                                                                                                                                                            |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which completions notify (v1)     | Scheduled + manual **Task** runs; NOT interactive session turns                                                 | Unattended work is the high-signal case and the literal demo; interactive turns are spam.                                                                            |
| 2   | Opt-in surface                    | Per-binding `notifyOnTaskComplete` toggle (zero-config default) + optional per-task `notifyOnComplete` override | Binding is already "this agent may reach me here"; per-task gives Kai noise control without per-task friction in the common case. Exact default is an Open Question. |
| 3   | Where the notification originates | `TaskStore.updateRun` terminal hook → `TaskCompletionNotifier` service                                          | Single path-agnostic chokepoint that fires exactly once; mirrors the DOR-248 terminal guard already living there.                                                    |
| 4   | Delivery path                     | Existing Relay publish pipeline (`relay.human.…`) via a shared resolver extracted from `relay_notify_user`      | Inherits budgets (PR #210), dead-lettering, rate-limits, access control, and the `canInitiate`/`enabled` gates (DOR-239) with no duplication.                        |
| 5   | Permission gates honored          | `enabled !== false` AND `canInitiate === true` on the resolved binding                                          | A completion ping is a proactive/initiated message; it must respect the same user consent DOR-239 enforced for `relay_notify_user`.                                  |
| 6   | Failure vs success                | Always notify on `failed`; notify on `completed` per opt-in; never on `cancelled`                               | Failures are always worth an interrupt; cancellation is user-initiated (they already know).                                                                          |
| 7   | Bootstrap when no chat session    | Silent no-op + honest UI hint; never error the run                                                              | Telegram bots cannot DM first; this is a platform limit, surfaced not hidden.                                                                                        |

## 7) Open Questions (for SPECIFY / founder)

1. **Default of `notifyOnTaskComplete`** — on or off by default per binding? "On" makes the
   demo true with zero config once a channel is bound + `canInitiate` on; "off" is more
   conservative/opt-in. Leaning **on**, gated behind `canInitiate` (which already defaults
   **false**, so nothing fires until the user explicitly enables the channel to initiate).
2. **Global (agent-less) tasks** — a task with `agentId=null` has no binding to resolve. Fall
   back to the system agent (DorkBot) bindings, a global default channel, or simply don't notify?
   Leaning **don't notify in v1** (document the limitation); revisit with a global default channel.
3. **Message tone/format** — confirm the copy shape (see spec draft): emoji + task name +
   outcome + duration + first line of `outputSummary`. Founder sign-off on voice.

## Recommended next step

**SPECIFY** — proceed to `02-specification.md`. The problem is well-formed and the design has a
clear, low-risk seam; the three open questions are refinements resolvable during specification.
