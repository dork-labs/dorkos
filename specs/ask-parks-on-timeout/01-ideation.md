---
slug: ask-parks-on-timeout
id: 260819-023725
created: 2026-08-18
status: ideation
tracker: DOR-1350
project: Unified Conversation Surfaces
---

# An Ask that times out parks the agent instead of refusing for it

**Slug:** ask-parks-on-timeout
**Author:** Claude (IDEATE+SPECIFY author, DOR-1350)
**Date:** 2026-08-18

---

## 1) Intent & Assumptions

### Task brief

Today an unanswered SDK prompt — a tool approval, an `AskUserQuestion`, or an MCP
elicitation — is **auto-denied** after `SESSIONS.INTERACTION_TIMEOUT_MS` (10
minutes, `apps/server/src/config/constants.ts:171`). The model is handed a
refusal it did not earn, the agent carries on and either gives no answer or a bad
one, and the only durable trace is one `warn` line in the server log
(`interactive-handlers.ts:530-549`, whose own TSDoc calls this out).

The `unified-conversation` programme made that prompt **findable** everywhere
(ADR `260818-002803`) and deliberately left it **impatient**. Its closing record
names this as the single most valuable follow-on
(`specs/unified-conversation/04-implementation.md:745, 770`;
`design-decisions.md:44-48`, approvals tier C).

This item makes the agent **park** instead of refusing for you.

### Assumptions

- The Claude Agent SDK permits an indefinite hold on a `canUseTool` decision.
  **Verified, not assumed** — see §2 and §5.1.
- A person who walked away wants the work waiting for them, not guessed at. The
  failures on record are 20 to 41 minutes long (DOR-784), which is a lunch, a
  meeting, or a school run.
- The cockpit's Ask surfaces (`features/ask`, the lane's `ask` rung) are the
  right and only place to show a parked state. They shipped in P3/P4 of
  `unified-conversation` and need small, additive changes, not a redesign.
- One PR is achievable. The change is a runtime hold-semantics change plus copy;
  it does not touch the Ask's wire shape beyond one optional field.

### Out of scope

- **Notification actions** (desktop / Telegram / Slack Allow and Deny buttons for
  the new Ask object). Named as a follow-on in §6 and in the spec's "What is not
  done".
- **Scope options** ("Allow and don't ask again for this file / this folder /
  this agent in this room"). Named as a follow-on in §6.
- **Codex parity.** Codex has no approval channel at all
  (`services/runtimes/codex/NOTES.md` Verdict 1, `codex-runtime.ts:747-751`), so
  there is nothing to park. DOR-803 is unchanged by this item.
- **Durable receipts for an expired prompt.** DOR-1158's live notice is still
  best-effort and still clears with the next turn event. Parking removes almost
  every occasion for it; making it durable is a separate change.
- **A park that survives a server restart.** Impossible while the SDK's held
  decision lives in a child process of this server. Named honestly instead.

---

## 2) Pre-reading Log

Every file below was opened at `d7e4768e6`; every line number was read, not
inferred.

| File                                                                                                                                                                     | Takeaway                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:196-205` (`CanUseTool`)                                                                                            | **The load-bearing fact.** Verbatim: "an accidental null means no control_response is sent and the tool stays blocked indefinitely — permission prompts have no park deadline." The SDK imposes no deadline of its own.                                                                                                                                                     |
| same, `Query.reinitialize()` (`:2436-2450`)                                                                                                                              | "the CLI's response carries any `can_use_tool` / `request_user_dialog` control requests the loop is still blocked on, and the SDK redelivers them." The CLI holds the loop open across a transport gap and redelivers. Confirms the hold is a first-class state, not a leak.                                                                                                |
| same, `PermissionResult` (`:2167-2179`), `PermissionUpdate` (`:2186-2213`), `PermissionUpdateDestination` (`:2215`)                                                      | The always-allow primitive is `updatedPermissions: PermissionUpdate[]`, whose destination is one of `session`, `localSettings`, `projectSettings`, `userSettings` or `cliArg`. There is no field named `alwaysAllow` in the SDK.                                                                                                                                            |
| `apps/server/src/config/constants.ts:165-246`                                                                                                                            | `INTERACTION_TIMEOUT_MS` 10 min, `TIMEOUT_MS` 30 min (session record), `WARM_IDLE_MS` 5 min, `MAX_WARM_SESSIONS` 12, `TURN_STALL_TIMEOUT_MS` 10 min. The constants that bound any park.                                                                                                                                                                                     |
| `services/runtimes/claude-code/messaging/interactive-handlers.ts:653-715, 717-800, 900-1068`                                                                             | The three `setTimeout(…, INTERACTION_TIMEOUT_MS)` call sites (`:686`, `:766`, `:1022`) and their shared shape: clear the entry, log, `notifyInteractionCancelled(…, 'timeout')`, push a `system_status` notice, resolve a denial.                                                                                                                                           |
| same, `:502-549` (`logInteractionTimeout`)                                                                                                                               | The only durable trace an expired prompt leaves, `warn` with `visibility: 'silent'`. Its TSDoc names DOR-784 and the durability gap DOR-1158 did not close.                                                                                                                                                                                                                 |
| same, `:431-474`                                                                                                                                                         | `PendingApproval` / `PendingQuestion` / `PendingElicitation` each hold a single `timeout: ReturnType<typeof setTimeout>` field.                                                                                                                                                                                                                                             |
| `services/session/pending-interactions.ts:61-89`                                                                                                                         | `listPendingInteractions` — the ONE selector. `budgetMs = dto.timeoutMs ?? INTERACTION_TIMEOUT_MS`; entries with `remainingMs <= 0` are dropped; the budget ships beside the remainder so the two cannot disagree (DOR-810, DOR-1330).                                                                                                                                      |
| `services/session/session-state-projector.ts:1204-1262` (`trackInteraction`)                                                                                             | Folds a blocking-interaction event into `this.interactions`, sets `lifecycle: 'blocked'`, computes the DTO through the canonical selector, then fires `notifyInteractionChange({type:'pending'})`. The order (set, then notify) is documented as load-bearing.                                                                                                              |
| same, `:1463-1493` (`hasPendingInteractions`)                                                                                                                            | **The second load-bearing fact.** The bound is deliberate: "a stranded entry read as 'still waiting' would be permanent — the watchdog could never fire and the lock could never expire". It delegates to `listPendingInteractions`, so whatever budget that selector uses is the budget the watchdog and the write-lock use.                                               |
| same, `:1340-1376` (`markInterrupted`)                                                                                                                                   | Leaves `this.interactions` populated on purpose, and announces every entry `resolved` with `outcome: 'cancelled'`. Eviction degradation.                                                                                                                                                                                                                                    |
| `services/runtimes/claude-code/sessions/session-store.ts:699-721` (`checkSessionHealth`)                                                                                 | **The third load-bearing fact.** At `now - lastActivity > 30 min` a session record is deleted, its pending interactions' timers cleared, no exemption for a parked prompt. `lastActivity` is stamped at session creation, at `message-sender.ts:119` and at `persistent-dispatch.ts:314` — never during a wait. So today's real hard ceiling is 30 minutes from turn start. |
| same, `:482-506` (`approveTool`)                                                                                                                                         | `alwaysAllow` forwards `pending.suggestions` verbatim as `updatedPermissions`. Already shipped end to end; DorkOS never inspects the destination.                                                                                                                                                                                                                           |
| `services/runtimes/claude-code/sessions/session-pump.ts:445-470`, `session-pump-registry.ts:344-367, 400-410`                                                            | A reap is DECLINED for a session parked on a person, and the decline re-arms a full idle window rather than retrying. Only WARM pumps are reclaim candidates, so a parked session is unreclaimable.                                                                                                                                                                         |
| `packages/shared/src/agent-runtime.ts:1108-1123` (`reapSession`)                                                                                                         | "Never call it while a pending interaction is open… `INTERACTION_TIMEOUT_MS` (10 min) outlasts the warm idle window (5 min), so that race is real rather than theoretical."                                                                                                                                                                                                 |
| `services/session/trigger-turn.ts:552-585`, `trigger-command-intent.ts:186-192`, `stall-guard.ts:218-262`, `message-dispatcher.ts:327-335, 1905-1915`                    | The four consumers of `hasPendingInteractions()`: the write-lock's TTL, the stall watchdog, and two queue gates. All inherit whatever bound the selector applies.                                                                                                                                                                                                           |
| `services/session/ring-buffer.ts:23-29`                                                                                                                                  | `RING_BUFFER_TTL_MS` is 10 minutes and explicitly mirrors `INTERACTION_TIMEOUT_MS`, but it only starts at `turn_end`, so a park (mid-turn) never touches it.                                                                                                                                                                                                                |
| `packages/shared/src/schemas.ts:1170-1229`                                                                                                                               | `PendingInteractionDTOSchema`, a three-member discriminated union. `timeoutMs` is optional on all three and was added exactly the way a new optional field would be.                                                                                                                                                                                                        |
| `packages/shared/src/interaction-events.ts` (whole)                                                                                                                      | The fleet-wide Ask wire: `InteractionPendingEvent`, `InteractionResolvedEvent` with an `outcome` of `answered`, `cancelled` or `expired`, and `PendingInteractionsResponse`.                                                                                                                                                                                                |
| `services/session/session-event-normalizer.ts:263-271, 334-350`                                                                                                          | `interaction_cancelled` normalizes to `interaction_resolved`; `reason: 'timeout'` maps to `resolution: 'expired'`. The one place a new event kind would be taught.                                                                                                                                                                                                          |
| `apps/client/src/layers/features/ask/ui/AskCard.tsx:48-72, 248-307`                                                                                                      | `askUrgency(null)` is already `'neutral'`, `secondsLeft` is already nullable, and the draining bar renders **only when `timeoutMs !== undefined`**. A parked card needs no new component state.                                                                                                                                                                             |
| `apps/client/src/layers/features/ask/lib/format-time-left.ts:44-48`                                                                                                      | `formatAskTimeLeft` returns `expired` at or below zero.                                                                                                                                                                                                                                                                                                                     |
| `apps/client/src/layers/features/conversation/model/lane-state.ts:148-341`                                                                                               | The `ask` rung is rung 1 and outranks even `stalled`; the state carries the whole `InteractionPendingEvent`, so a parked flag arrives there for free.                                                                                                                                                                                                                       |
| `apps/client/src/layers/entities/attention/model/describe-interaction.ts`                                                                                                | "wants to edit standup.md" / "has a question" / "needs something from X". One vocabulary, two readers. It never invents.                                                                                                                                                                                                                                                    |
| `services/rooms/notices/notice-copy.ts:193-213`                                                                                                                          | `WAITING_LINES`, three sentences ending "it gives up if nobody does". The TSDoc explains why no countdown is in them, and that reasoning survives this change; the "gives up" clause does not.                                                                                                                                                                              |
| `services/runtimes/opencode/approvals.ts:73-175, 255-337`                                                                                                                | OpenCode's own `PendingApprovalStore` arms an auto-deny timer for the same constant, answers the sidecar `reject`, and marks the id `expired` so the echo can be told apart from a person's refusal.                                                                                                                                                                        |
| `services/runtimes/codex/NOTES.md:27-56`, `codex-runtime.ts:747-751`                                                                                                     | Codex has no approval channel: `supportsToolApproval: false`, the mapper never emits `approval_required`, `approveTool()` returns `false`.                                                                                                                                                                                                                                  |
| `services/runtimes/test-mode/interactive-scenarios.ts:495-552`                                                                                                           | `questionExpires` reaches the timeout state through the real code path, released by `ctx.awaitStep()` rather than a clock. The pattern a browser test for parking must copy.                                                                                                                                                                                                |
| `apps/desktop/src/main/agent-activity.ts:34-37, 138-146, 222-238`, `tray.ts:14-16, 101-141`                                                                              | The desktop shell reads `/api/events` for `session_status` and `session_removed` only, folds `blocked` into one "N agents working" count, and constructs no `Notification` anywhere.                                                                                                                                                                                        |
| `decisions/0009-calm-tech-notification-layers.md:22`                                                                                                                     | Excludes the Browser Notification API on purpose. Any push surface is a deliberate exception, not an extension.                                                                                                                                                                                                                                                             |
| `services/core/approvals/approval-grant-service.ts:141-156`, `packages/db/src/schema/approval-grants.ts:20-87`, `services/core/capabilities/tier-enforcement.ts:656-674` | Standing permissions are keyed `(agentPath, capabilityId)`, live in SQLite, and have exactly one consumer: the capability tier gate. Nothing in `createCanUseTool` reads them.                                                                                                                                                                                              |
| `decisions/260801-035912-*`                                                                                                                                              | Every session records a permission decision; the overlay matches by **tool-call id**. Any change to how a prompt ends must still produce a tool-call-id-keyed resolution.                                                                                                                                                                                                   |
| `decisions/0240-*` (accepted), `0241-*` (superseded by ADR-256)                                                                                                          | Permission modes pass through to the SDK with no local allowlist. `0241` is stale; cite ADR-256 for how a runtime declares mode support.                                                                                                                                                                                                                                    |
| `meta/agent-etiquette.md` §9 and `.claude/rules/room-conduct.md`                                                                                                         | `awaiting_approval` is the one notice reported while it is true rather than as an outcome, is deliberately late (`WAITING_NOTICE_GRACE_MS`), and over-participation is the failure mode. A park must not become a second line.                                                                                                                                              |

---

## 3) Codebase Map

**Primary modules**

- `apps/server/src/services/runtimes/claude-code/messaging/interactive-handlers.ts`
  — the three timeout call sites (`:686`, `:766`, `:1022`), the shared notice
  helpers (`:530-642`), and the three pending-entry shapes (`:431-474`).
- `apps/server/src/services/session/pending-interactions.ts` — the ONE selector
  that decides what "still pending" means, for the wire and for the watchdog.
- `apps/server/src/services/session/session-state-projector.ts` —
  `trackInteraction` (`:1204`), `hasPendingInteractions` (`:1487`), the
  `notifyInteractionChange` seam.
- `apps/server/src/services/session/session-event-normalizer.ts` — where a new
  runtime event kind is taught its session-stream projection.
- `apps/server/src/services/runtimes/claude-code/sessions/session-store.ts` —
  `checkSessionHealth` (`:699`), the 30-minute record eviction.
- `apps/server/src/services/runtimes/opencode/approvals.ts` — the parallel
  auto-deny timer for the OpenCode sidecar.
- `packages/shared/src/schemas.ts` (`PendingInteractionDTOSchema`) and
  `packages/shared/src/session-stream.ts` (the session-stream union).
- `apps/client/src/layers/features/ask/**` — `AskCard`, `AskStack`, `AskList`,
  `InteractionAsk`, `format-time-left.ts`.
- `apps/client/src/layers/features/conversation/model/lane-state.ts` — rung 1.
- `apps/server/src/services/rooms/notices/notice-copy.ts` — `WAITING_LINES`.

**Data flow**

```
SDK canUseTool  →  handleToolApproval  →  session.eventQueue
                        │                        ↓
                   (park timer)          session-event-normalizer
                        ↓                        ↓
                 interaction_parked  →   SessionStateProjector.interactions
                                                 ↓
                              listPendingInteractions (the ONE selector)
                                     ↙                        ↘
                    notifyInteractionChange            hasPendingInteractions
                            ↓                                   ↓
            session-list-broadcaster                 write-lock TTL, stall
            → interaction_pending on /api/events      watchdog, queue gates
                            ↓
        features/ask (card, tray, stack) + lane rung 1 + room notice
```

**Feature flags / config:** none today. `SESSIONS.*` constants only.

**Potential blast radius**

- Everything that asks "is this turn parked on a person" — the write-lock TTL,
  the stall watchdog, two message-queue gates, the warm-process reap, the room's
  waiting notice, the Telegram typing indicator.
- The warm-process ceiling (`MAX_WARM_SESSIONS: 12`). A parked session declines
  every reap, so a longer park holds a subprocess longer. This is the single
  largest cost of the change and it is what bounds the design (§5, decision 2).

---

## 4) Root Cause Analysis

This is a deliberate behaviour, not a bug, so the analysis is of the behaviour's
cost rather than of a defect.

- **Repro:** raise a gated tool call, walk away for eleven minutes, come back.
- **Observed:** the card is gone; the agent has continued past a refusal it was
  told a person gave; there is nothing in the transcript saying a clock decided.
  The one record is a `warn` line with `visibility: 'silent'`
  (`interactive-handlers.ts:534-548`).
- **Expected:** the agent is still waiting, and says so.
- **Evidence:** DOR-784 — two agents hit this twice each, invisibly, inside one
  forty-one minute silence; reconstructing it afterwards needed the SDK
  transcripts because the server log had nothing.
- **Cause:** `INTERACTION_TIMEOUT_MS` exists because a `canUseTool` promise that
  never settles was believed to strand a turn. §5.1 shows the SDK contradicts
  that belief in its own type documentation.

---

## 5) Research

### 5.1 Can a `canUseTool` decision be deferred indefinitely?

**Yes, and the SDK says so.** From `sdk.d.ts:196-205`, the `CanUseTool` doc
comment, verbatim:

> Return `null` ONLY after the consumer has already sent the control_response
> out-of-band (e.g. a signed HTTP POST echoing `requestId`); the SDK will skip
> its own transport write. Fail-closed: an accidental null means no
> control_response is sent and the tool stays blocked indefinitely — **permission
> prompts have no park deadline.**

`Query.reinitialize()`'s doc (`sdk.d.ts:2436-2450`) says the same thing from the
other side: after a transport gap, the CLI's response "carries any `can_use_tool`
/ `request_user_dialog` control requests **the loop is still blocked on**, and
the SDK redelivers them to `canUseTool`". A held decision is a supported,
recoverable state of the CLI loop, not a leak.

There is no heartbeat, idle timer or abort that the SDK aims at a held permission
prompt. Every `timeout` in `sdk.d.ts` is an MCP tool-call timeout, a hook
timeout, or a session-store load timeout; none of them reach `canUseTool`.

**So a park does not need a suspend-and-resume.** The turn simply stays open and
the promise stays unresolved. Resuming means resolving it, which is exactly what
answering already does. There is no second mechanism to build, and no
reconstruction of SDK state.

### 5.2 What actually stops a park in DorkOS

Three DorkOS-side bounds, each verified:

1. **`hasPendingInteractions()`** bounds a pending entry by the selector's
   budget, on purpose: an entry CAN strand (`markInterrupted` leaves the set
   populated; a runtime stream that throws with an approval outstanding never
   re-drains its queue), and a stranded entry read as "still waiting" would make
   the stall watchdog and the write-lock immortal
   (`session-state-projector.ts:1473-1483`). **A park must therefore have a
   bound, not merely a longer one.** Removing the bound re-opens the exact
   failure DOR-782 closed.
2. **Session-record eviction at 30 minutes** (`session-store.ts:699-721`) deletes
   a parked session's record and clears its timers with no exemption, and
   `lastActivity` is never touched during a wait. This is today's real ceiling
   and it is 30 minutes from **turn start**, not from the prompt.
3. **The warm-process ceiling.** A parked session declines every reap
   (`session-pump.ts:461`), and only WARM pumps are reclaim candidates
   (`session-pump-registry.ts:400-410`). N parked sessions permanently shrink the
   twelve-slot ceiling by N, and at twelve every new launch is refused with
   `PumpRefusedError('warm-ceiling')`. **The person who hits that refusal is not
   the person who walked away**, which is what makes an unbounded park
   unacceptable rather than merely untidy.

A fourth is not a bound: `RING_BUFFER_TTL_MS` (10 minutes) only starts counting
at `turn_end`, so a mid-turn park never touches it.

### 5.3 Potential solutions

**Option A — the prompt stops timing out; the deadline becomes "parked", forever.**
The countdown ends and the card says "waiting for you" with no ceiling.

- _Pro:_ the simplest sentence to say to a person, and the strongest removal of
  the failure.
- _Con:_ re-opens the stranded-entry immortality DOR-782 closed (§5.2 #1); holds
  a warm slot with no end, so twelve abandoned prompts refuse every new agent
  launch on the machine (§5.2 #3); a session record that is never evicted is
  unbounded memory. Three separate "forever" states, each of which this codebase
  has explicitly removed elsewhere.

**Option B — suspend the turn and resume it later.**
Resolve the decision with a deny, close the turn, and re-issue the tool call on a
fresh turn when the person answers.

- _Pro:_ nothing holds a process.
- _Con:_ the model was never told the tool call was deferred, so the resumed turn
  is a different conversation; the SDK offers no re-issue primitive; and the
  transcript would carry a denial the person never gave, which is the bug being
  fixed. Rejected outright.

**Option C — a two-stage park with a hard ceiling. RECOMMENDED.**
For the first ten minutes nothing changes: a live countdown, the urgency bands,
the same card. At ten minutes the prompt **parks** rather than dying — the
countdown ends, the card says the agent is waiting, and the turn stays open. At a
much larger ceiling the current auto-deny path runs verbatim, with copy that says
how long it actually waited.

- _Pro:_ the person at their desk sees exactly today's behaviour; the person who
  walked away comes back to a waiting agent. Every bound in §5.2 stays bounded,
  so nothing becomes immortal. The selector already computes the budget in one
  place, so the ceiling reaches the watchdog and the write-lock for free.
- _Con:_ two numbers instead of one, and a ceiling is still a refusal in the end.
  Both are acceptable: the second number is invisible unless the wait is
  genuinely long, and a refusal after hours is a different claim from a refusal
  after ten minutes.

### 5.4 Recommendation

**Option C**, ceiling **4 hours**, as one specification and one pull request
covering park-on-timeout plus the room, lane and tray copy. Notification actions
and scope options are named follow-ons.

---

## 6) Decisions

Every routine call is resolved here. The two genuinely product-level questions
also carry a chosen default, per the SPECIFY bias.

| #   | Decision                                                                | Choice                                                                                                                                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does the prompt stop timing out, or does the turn suspend and resume?   | **It stops timing out.** The `canUseTool` promise stays unresolved and the turn stays open. No suspend, no resume.                                                 | The SDK documents an indefinite hold as supported and recoverable (`sdk.d.ts:196-205`, `:2436-2450`). A suspend/resume needs a re-issue primitive the SDK does not have, and would put a denial the person never gave into the transcript.                                                                                                                                                                                                                                                                                                                                               |
| 2   | Park forever, or park for N hours then refuse?                          | **Park for N hours, then refuse, with a durable line.**                                                                                                            | Three DorkOS bounds turn "forever" into three immortal states (§5.2): a stranded entry that no watchdog can ever shoot, a session record that is never evicted, and a warm slot that can never be reclaimed. The last one is the decisive one — twelve abandoned prompts would refuse every new agent launch on the machine, and the person who hits that refusal is not the person who walked away.                                                                                                                                                                                     |
| 3   | What is the ceiling?                                                    | **4 hours** (`SESSIONS.INTERACTION_PARK_CEILING_MS`).                                                                                                              | Twenty-four times today's ten minutes. It covers every failure on record (DOR-784's 41 minutes; a lunch, a meeting, a school run) with a wide margin, and it keeps a machine abandoned at six in the evening from holding twelve subprocesses at midnight. A number in days would trade a real resource ceiling for a case nobody has reported.                                                                                                                                                                                                                                          |
| 4   | Is the park a two-stage change, or does the prompt park from the start? | **Two stages: ten minutes of countdown, then park.**                                                                                                               | Parking from the start would delete the urgency bands and draw a four-hour bar nobody can read. Ten minutes of live countdown is what tells the person at their desk to answer now; the park is what protects the person who is not there.                                                                                                                                                                                                                                                                                                                                               |
| 5   | How does a parked entry reach every surface?                            | **One optional field, `parkedAt`, on `PendingInteractionDTO`,** carried through the existing snapshot and re-broadcast as `interaction_pending`.                   | The DTO already gained `timeoutMs` this way. Every surface reads the same object, and the projector's `notifyInteractionChange` seam already exists for exactly this fan-out.                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | How does the ceiling reach the stall watchdog and the write-lock?       | **Through `listPendingInteractions`, unchanged.** The selector picks the budget: the ceiling for a parked entry, `timeoutMs` otherwise.                            | That function's own TSDoc states the rule — the budget the remainder is measured against is the budget that ships, so the two answers to "what is pending" cannot disagree. Doing it anywhere else creates the drift DOR-810 and DOR-1330 both cost.                                                                                                                                                                                                                                                                                                                                     |
| 7   | Does the parked card keep a countdown?                                  | **No.** No draining bar, no seconds. `secondsLeft: null` and `timeoutMs` omitted.                                                                                  | `AskCard` already supports both (`askUrgency(null) === 'neutral'` at `:67-72`; the bar renders only when `timeoutMs !== undefined` at `:272`). A four-hour bar is a siren for a non-event, which the design system forbids.                                                                                                                                                                                                                                                                                                                                                              |
| 8   | Does the session-record eviction get an exemption?                      | **Yes, bounded by the same ceiling.** `checkSessionHealth` skips a session holding a parked interaction inside the ceiling.                                        | Without it the 4-hour park is a lie: the record dies at 30 minutes from turn start. Bounding the exemption by the ceiling means a stranded park still gets evicted, so nothing becomes immortal.                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | Does the room's durable waiting notice change?                          | **One clause, in all three lines.** "it gives up if nobody does" becomes a sentence that is true of a four-hour wait. No new notice, no second line, no countdown. | `notice-copy.ts:193-205` explains why the notice carries no number and that reasoning survives. What does not survive is a promise of impatience the code no longer keeps. Adding a park notice would be the over-participation `meta/agent-etiquette.md` §9 damps.                                                                                                                                                                                                                                                                                                                      |
| 10  | Does OpenCode park too?                                                 | **Yes,** the same two stages in `PendingApprovalStore.register`. The sidecar is answered `reject` only at the ceiling.                                             | Its timer is already a mirror of the claude-code one and cites it as such (`approvals.ts:13-18`). Leaving it at ten minutes would make "your agent waits for you" true of one runtime and false of another, on the same screen.                                                                                                                                                                                                                                                                                                                                                          |
| 11  | Does Codex park?                                                        | **No, and nothing is written for it.**                                                                                                                             | It has no approval channel to park (`NOTES.md` Verdict 1). DOR-803 is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 12  | Can scope options reuse the standing-permission machinery?              | **No, and it is a follow-on either way.**                                                                                                                          | `approval_grants` is keyed `(agentPath, capabilityId)`, lives in SQLite, and has exactly one consumer — the capability tier gate (`tier-enforcement.ts:656-674`). Nothing in `createCanUseTool` reads it. The SDK's own `PermissionUpdate` mechanism DOES ship end to end already (`session-store.ts:499-501`), but DorkOS never inspects the `destination`, so its scope is CLI-decided and invisible to the Settings panel and to the ADR `260801-035912` audit overlay. Choosing between "a new store" and "own the SDK's destination" is a real decision that deserves its own item. |
| 13  | Do notification actions fit in this PR?                                 | **No.**                                                                                                                                                            | Slack and Telegram already have Allow and Deny buttons, but for the OLDER relay `approval_required` envelope, not the fleet-wide Ask; the desktop shell constructs no `Notification` at all and ADR-0009 excludes push on purpose. That is three integration surfaces and one deliberate design exception, none of which park-on-timeout depends on.                                                                                                                                                                                                                                     |
| 14  | One spec or several?                                                    | **One spec, one PR,** with two named follow-on issues.                                                                                                             | The runtime change, the selector change, the eviction exemption and the copy are one coherent behaviour and share one set of tests. Splitting them would ship a parked state nothing renders, or a "waiting" card over a prompt that still dies.                                                                                                                                                                                                                                                                                                                                         |
| 15  | (Product) Should the ceiling be configurable?                           | **(RESOLVED — default chosen: no, a constant.)**                                                                                                                   | Every `SESSIONS.*` sibling is a constant with a reasoned TSDoc, and a setting is a question asked of somebody who has no way to answer it. If a person ever hits the ceiling and minds, that is the evidence a setting needs; today there is none.                                                                                                                                                                                                                                                                                                                                       |
| 16  | (Product) Should a parked agent nudge you?                              | **(RESOLVED — default chosen: no, not in this item.)**                                                                                                             | The Ask is already on five surfaces plus the lane and the header pill (ADR `260818-002803`). Reaching a person who is not looking at any of them is precisely the notification-actions follow-on, and inventing a half of it here would be a surface nobody designed.                                                                                                                                                                                                                                                                                                                    |

---

## 7) Risks

| Risk                                                                          | Likelihood   | Mitigation                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parked sessions exhaust the twelve warm slots and refuse new launches         | Low, bounded | The 4-hour ceiling is chosen for exactly this. The refusal already exists and already names its reason (`PumpRefusedError('warm-ceiling')`). Named in "What is not done" so it is not rediscovered as a bug. |
| A stranded parked entry pauses the stall watchdog for four hours              | Low          | Bounded by the same ceiling through the same selector; a stranded entry is shot at the ceiling exactly as it is shot at ten minutes today. The window widens, it does not open.                              |
| The eviction exemption leaks session records                                  | Low          | Bounded by the ceiling. The predicate reads the interaction's own `startedAt`, so an entry the runtime forgot still ages out.                                                                                |
| A person reads "waiting for you" as "forever" and is surprised by the refusal | Medium       | The ceiling refusal says how long it waited, in hours, in the agent's own voice, and it is the same durable log line plus live notice the ten-minute path writes today.                                      |
| The room notice becomes stale mid-park                                        | Low          | Unchanged by design: it is the log, not the affordance, and it is written once, late, damped (`room-conduct.md`, `notice-copy.ts:193-205`).                                                                  |
| OpenCode's sidecar has its own permission expiry we cannot see                | Unverified   | Flagged in the spec as the one thing to confirm live; if the sidecar expires a permission itself, the OpenCode park is capped by that and the spec says so rather than claiming parity it does not have.     |

---

## 8) Recommendation

Proceed to SPECIFY with **Option C**: a two-stage park at
`INTERACTION_TIMEOUT_MS` with a hard ceiling of
`INTERACTION_PARK_CEILING_MS = 4 hours`, one optional `parkedAt` field on the
Ask's existing DTO, the budget decided once in `listPendingInteractions`, a
bounded eviction exemption, parity in the OpenCode adapter, and the room, lane
and Ask-card copy that makes the new behaviour legible. One pull request.

Two follow-on issues to file, named in the spec's "What is not done":
notification actions for the fleet-wide Ask, and scope options for SDK tool
prompts.
