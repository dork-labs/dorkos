---
slug: runtime-interrupt-receipts
id: 260807-231651
tracker: DOR-1303
created: 2026-08-07
specified: 2026-08-23
status: specified
---

# Interrupt receipts — tell "the CLI stopped" from "DorkOS killed it"

**Status:** Specified
**Author:** Claude (SPECIFY)
**Date:** 2026-08-23

## Overview

Every stop-shaped verb in DorkOS — the composer's Stop, a room's halt, a task run's stop,
the stall watchdog — ends in `AgentRuntime.interruptQuery`, which answers with a boolean.
That boolean is `true` for two endings that are not the same ending: **the agent heard the
stop and stopped**, and **DorkOS gave up waiting and killed the process**. It is `false`
for three more that are not the same as each other: the turn had already finished, the
runtime declined and the turn is still running, and the call blew up.

This spec replaces the boolean with a five-value typed **receipt**, carries it on the POST
response _and_ on a new durable session event (`turn_stopped`) so a second window and a
cold reload agree with the window that pressed the button, and uses the durable record to
give a stopped turn a **stop marker in the transcript on reload** — the marker the CLI
never wrote because it never received the interrupt (the named DOR-1244 limit). Per
ADR-0310 transcripts stay runtime-owned: nothing here writes synthetic JSONL.

One shape serves all three stop-shaped verbs. One vocabulary is mapped by every runtime and
gated by `runtimeConformance`. The client's rule falls out of it: **"stopped" is only ever
said about an ending DorkOS observed; everything else says "stop requested".**

## Background / Problem statement

### What `ok: true` is hiding

`POST /api/sessions/:id/interrupt` answers `{ ok, cancelledQueued }`
(`apps/server/src/routes/sessions.ts`). `ok` comes straight from
`runtime.interruptQuery`. Inside claude-code that call already knows more than it says
(`sessions/session-store.ts`, `sessions/bounded-control.ts`):

- `awaitControlAck` produces a tri-state — `acked` (the CLI answered), `refused` (it
  answered with a failure), `unacked` (nothing answered inside `STOP_ACK_TIMEOUT_MS`, 3 s).
- `acked` returns `true`. `refused` and `unacked` escalate to `query.close()`, which kills
  the subprocess — and also returns `true`.
- A query whose stdin DorkOS itself ended is closed with no graceful attempt at all.
- No session or no live query returns `false`, the same `false` a genuine failure returns.

Every one of those distinctions is discarded at the route. The client then discards what
is left: `stop()` in `use-session-submit.ts` keeps `ok` only to decide whether to re-offer
the button (DOR-1300, #1195), and its own TSDoc has to spend a paragraph explaining that
`ok: false` "covers two different server-side cases the client cannot tell apart from
here". The room halt discards the boolean outright (`room-trigger.ts` logs it and moves
on — DOR-1425). `routes/sessions.ts` still carries the placeholder comment written against
this spec: _"until it lands `interruptQuery` stays a bare boolean and the client says 'stop
requested' rather than 'stopped'."_

The cost is not abstract. The four differences the boolean erases are exactly the four
things a person needs after pressing Stop:

| Ending                                   | What the person needs to know                                                    | What they are told today |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------ |
| The CLI acked                            | Nothing — it worked                                                              | "stop requested"         |
| DorkOS killed the process                | It worked, and the agent lost its wind-down; a fresh process starts next message | "stop requested"         |
| The turn had already ended               | Nothing happened because nothing was running                                     | Same as a failure        |
| The runtime declined, turn still running | **Press it again — it may still be going**                                       | Same as a success        |

### The reload hole

An escalated close means the CLI never received the interrupt, so it never wrote
`[Request interrupted by user]` into its own JSONL. The FACT survives on the durable
`turn_end{terminalReason}`, and the projector settles a cold hydrate to `interrupted` from
it — but the transcript TEXT reads as an ordinary reply. Come back tomorrow and a stopped
turn looks finished (`meta/chat-capabilities.md` §1, wind-down row, named limit).

### The named per-runtime gaps

- **OpenCode (DOR-1299).** `session.abort` returning `false` is reported as `false`, the
  turn keeps running, and nothing anywhere says a stop was attempted. The review that
  landed #1197 named the open trade and did not settle it: fail the DorkOS-side turn
  anyway, or leave it running and accept that the person is not told.
- **The pump (DOR-1302).** A `query.close()` on the persistent path is settled by the
  windower as a process death — `turn_end{terminalReason:'error'}`, session `crashed`. The
  resume path settles the same close as `interrupted`, because `message-sender` supplies
  the reason. The windower has no way to tell a deliberate close from a crash, because
  nobody hands it one.
- **The pump, again (DOR-1320).** Every observed Stop on the pump settled
  `aborted_streaming` preceded by a durable `error{code:'error_during_execution'}` frame.
  A turn the operator stopped is not an error, and the durable record says it is.

## Goals

1. One typed receipt, produced by every runtime, that names which of five endings happened.
2. The receipt reaches every window that is looking at the session, and survives a reload.
3. A stopped turn shows, in its transcript, that it was stopped — on any runtime, on any
   ending, after any reload.
4. The client never says "stopped" about an ending DorkOS did not observe.
5. Every runtime's mapping is contract-tested, and a new runtime cannot omit one.

## Non-goals

- **Making Stop more likely to succeed.** Re-tuning `STOP_ACK_TIMEOUT_MS`, or the 7.6 s
  Stop seen under load, is DOR-1319 and stays there. Receipts make that latency
  _measurable_ (the `turn_stopped` event is timestamped and seq'd against `turn_end`);
  they do not change it.
- **`cancel_queued`.** Flushing the CLI's own queued messages (SDK 0.3.219) needs the SDK
  upgrade this spec's ideation is blocked on (`claude-agent-sdk-upgrade-0.3.224`). The
  receipt shape leaves room for it (§3.1) and nothing here depends on it. DorkOS's own
  queue is already emptied and already reported as `cancelledQueued`; that behavior is
  unchanged.
- **A new Stop affordance anywhere.** The blocked-on-a-prompt phase still has no Stop in
  the UI (`chat-capabilities` §1) and still does not get one here.
- **The permission-mode PATCH receipt (DOR-1435).** Same family, different verb — see §7.
- **Log noise.** The `[ede_diagnostic]` lines the CLI writes on every Stop are a logging
  cleanup, not a receipt (see §7, DOR-1320).

## Design

### 1. The receipt

One type in `@dorkos/shared`, Zod-first, used by every stop-shaped verb:

```ts
/** Which of the five endings a stop request reached. */
type InterruptOutcome =
  | 'acked' // the agent itself confirmed the stop
  | 'closed' // DorkOS ended the process/turn after the graceful path failed
  | 'not-running' // there was no turn to stop
  | 'unconfirmed' // the request went out; the runtime cannot say whether it landed
  | 'failed'; // the stop could not be delivered and nothing ended the turn

/** Why, when the outcome alone does not say it. */
type InterruptReason =
  | 'no-open-turn' // not-running: nothing was in flight
  | 'ack-timeout' // closed | unconfirmed: nothing answered inside the bound
  | 'refused' // closed: the runtime answered with a failure
  | 'stdin-ended' // closed: the graceful path was known-undeliverable, skipped
  | 'runtime-declined' // unconfirmed: the runtime answered "no" with the turn still open
  | 'delivery-failed'; // failed: the call threw

interface InterruptReceipt {
  outcome: InterruptOutcome;
  /** Present whenever it adds information the outcome does not carry. */
  reason?: InterruptReason;
  /** Which runtime answered — the receipt travels across runtimes (ADR-0310). */
  runtime: RuntimeType;
}
```

**Why these five and not the three that already exist.** `ControlAck`
(`acked | refused | unacked`) is a fact about one control round-trip; a receipt is a fact
about a turn. The mapping is not one-to-one in either direction: `refused` and `unacked`
both end at the same place once DorkOS escalates (`closed`), while `acked` at the control
layer can still mean `unconfirmed` at the turn layer on a runtime that acknowledges the
request without ending anything. `not-running` and `failed` have no `ControlAck` at all.
So `ControlAck` stays exactly what it is — the claude-code adapter's internal tri-state —
and the receipt is derived from it, never aliased to it.

**Why `closed` is a success and not a failure.** The turn is over and the person got what
they asked for. What they lost is the CLI's own wind-down: its interrupt sentinel on each
pending call, its `result.terminal_reason`, its transcript marker, and a warm process. That
is worth one sentence of UI (§5) and is not worth an error state.

**Two derived predicates ship with the type**, so no caller re-derives them:
`turnEnded(receipt)` (`acked | closed | not-running`) and `worthRetrying(receipt)`
(`unconfirmed | failed`). Every `if` in the client and the room is written against these,
not against string equality.

### 2. Where it rides

**The runtime interface.** `AgentRuntime.interruptQuery(sessionId): Promise<InterruptReceipt>`
and `AgentRuntime.stopTask(sessionId, taskId): Promise<InterruptReceipt>` replace the
booleans. No parallel method, no deprecation window: the boolean is removed in the same
change, and every internal caller (`trigger-turn.ts`, `trigger-command-intent.ts`,
`stall-guard.ts`, `run-stream.ts`, `message-dispatcher.ts`, `room-turn-runner.ts`,
`session-methods.ts`) is migrated with it. Adapters MUST NOT throw for an ordinary
refusal — `failed` is the receipt for that — matching the rule ADR `260816-143752` set for
`deliverIntoTurn`.

**The route.** `POST /api/sessions/:id/interrupt` answers
`{ receipt: InterruptReceipt, cancelledQueued: QueuedMessage[] }`. `ok` is **removed**:
it is the exact collapse this spec exists to undo, and it is wrong today on
`not-running` (nothing failed, yet `ok` is `false`). Callers derive it with `turnEnded()`.
The route's stale placeholder comment goes with it. The queue is still emptied
synchronously before the runtime is awaited, and still returned even when the interrupt
`failed` — "nothing typed is destroyed by a Stop" is untouched.

`POST /api/sessions/:id/tasks/:taskId/stop` answers the same receipt.
`not-running` maps to the existing `409 TASK_NOT_RUNNING` only when the session exists;
otherwise `404`. `POST /api/rooms/:id/halt[/:authorId]` answers per-agent receipts (§5.2).

**The durable event.** A new per-session stream event, sibling to `turn_start` /
`turn_end` / `turn_input`:

```ts
{ type: 'turn_stopped', ...receipt, requestedBy?: string, at: number }
```

It is written by the server the moment the receipt is produced — **before** the turn's own
`turn_end`, and independently of whether one ever arrives. That ordering is the point: on
`unconfirmed` and `failed` there may be no `turn_end` at all, and those are precisely the
endings a second window must be told about. It rides the durable stream, so it replays via
`Last-Event-ID`, appears in the snapshot, and reaches every window and the WebSocket alike.
`not-running` is written too — a second window that thinks a turn is open needs to learn
it is not.

### 3. The reload story

**The rule: the durable record is the authority, the transcript is the runtime's.** At
snapshot build the projector attaches, to the turn it belongs to, a **stop marker** derived
from the durable `turn_stopped` plus that turn's `turn_end{terminalReason}` — exactly the
mechanism `session-state-projector.ts` already uses to re-attach sign-in cards to a
hydrated turn. Nothing is written into any runtime's transcript store (ADR-0310).

What a reload shows, per ending:

| Ending                    | Transcript on reload                                                                                                                  | Where it comes from                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `acked`, claude-code      | The CLI's own `[Request interrupted by user]` in the reply text, plus one stop marker                                                 | JSONL + durable `turn_stopped`                 |
| `closed`                  | Reply text reads as ordinary; one stop marker saying DorkOS ended it                                                                  | durable `turn_stopped` (the CLI wrote nothing) |
| `acked`, codex / opencode | Whatever the runtime's own store kept; one stop marker                                                                                | runtime store + durable `turn_stopped`         |
| `not-running`             | Nothing. The turn was already over on its own terms                                                                                   | —                                              |
| `unconfirmed`             | One marker: stop requested, not confirmed. If the turn later produced more text, that text is there too and the marker sits before it | durable `turn_stopped`                         |
| `failed`                  | One marker: the stop did not go through                                                                                               | durable `turn_stopped`                         |

**Exactly one stop notice per turn.** Where the CLI wrote its own sentinel, the client
renders the sentinel's line as part of the reply and the marker once beneath it — it does
not render a second notice, and the marker is never duplicated by replay (it is derived at
snapshot build and from the live event, keyed by the turn).

### 4. Per-runtime mapping

Every cell is what the adapter returns; none of it is new behavior beyond the receipt.

| Runtime         | Situation                                                         | Receipt                            |
| --------------- | ----------------------------------------------------------------- | ---------------------------------- |
| **claude-code** | no session, or no live query                                      | `not-running` / `no-open-turn`     |
|                 | `query.interrupt()` acked                                         | `acked`                            |
|                 | acked-with-failure, then `close()` succeeded                      | `closed` / `refused`               |
|                 | unanswered inside `STOP_ACK_TIMEOUT_MS`, then `close()` succeeded | `closed` / `ack-timeout`           |
|                 | stdin already ended — closed with no graceful attempt             | `closed` / `stdin-ended`           |
|                 | `close()` itself threw                                            | `failed` / `delivery-failed`       |
| **codex**       | no `AbortController` for the session                              | `not-running` / `no-open-turn`     |
|                 | `controller.abort()` — SIGTERMs the per-turn `codex exec`         | `closed`                           |
| **opencode**    | no tracked turn                                                   | `not-running` / `no-open-turn`     |
|                 | `session.abort` returned `true`                                   | `acked`                            |
|                 | `session.abort` returned `false`                                  | `unconfirmed` / `runtime-declined` |
|                 | the abort call threw (sidecar down, network)                      | `failed` / `delivery-failed`       |
| **test-mode**   | a scripted turn was open                                          | `acked`                            |
|                 | none                                                              | `not-running` / `no-open-turn`     |

**Codex is `closed`, never `acked`, and that is deliberate.** Its only interrupt primitive
is aborting the controller, which SIGTERMs the subprocess. Nothing in codex acknowledges a
stop; the turn ends because the process died. Reporting that as `acked` would tell the
person the agent wound down when it did not, and would hide the same cost `closed` exists
to name.

#### The OpenCode position (DOR-1299)

**DorkOS does not settle a turn it did not observe end.** A `session.abort` that answers
`false` returns `unconfirmed`, the DorkOS-side turn stays open, the Stop button stays
pressable, and the UI says the stop was requested but not confirmed (§5.1).

The rejected alternative — settling our side as `interrupted` anyway — trades a small,
honest gap for a large, silent one. OpenCode's session store is the runtime's own truth
(ADR-0310) and DorkOS hydrates from it. Fabricating an end means: the cockpit shows a
stopped turn that goes on producing text; the next hydrate reads the runtime's store and
disagrees with what the person was shown; and a "stopped" turn later grows a complete
answer — the DOR-1313 shape, which is the single most-reported Stop failure in this repo.
An honest `unconfirmed` costs one sentence and one extra press; a fabricated end costs the
operator's trust in every Stop they have ever pressed.

Also rejected: **escalating by killing the sidecar.** The OpenCode sidecar is DorkOS-managed
(ADR-0308) and shared by every OpenCode session on the machine, so the claude-code
escalation has no analogue here — killing it to stop one turn would stop every other one
too. If OpenCode later exposes a per-session force-abort, this cell becomes `closed` and
nothing else in the spec changes.

### 5. Client surfaces

#### 5.1 The session composer

The pressed→settled sequence is unchanged: the button shows "Stopping…" while the request
is in flight, and `isStreaming` remains the primary signal for whether the turn is open.
The receipt decides what is _said_:

| Receipt       | Button after       | What is shown                                                                       |
| ------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `acked`       | gone               | Stop marker in the transcript: **"You stopped this reply."** Nothing else.          |
| `closed`      | gone               | **"You stopped this reply. The agent didn't answer, so DorkOS ended it."**          |
| `not-running` | gone               | Nothing. It had already finished.                                                   |
| `unconfirmed` | **stays, enabled** | **"Stop requested. {Runtime} didn't confirm it — the agent may still be working."** |
| `failed`      | stays, enabled     | **"Couldn't stop it. Try again."** — the one ending that reads as an error.         |

Copy follows `writing-for-humans`; the marker is a quiet notice row, not a red card, for
every ending except `failed`. **"Stopped" is only ever said about `acked` and `closed`;
`unconfirmed` and `failed` say "stop requested".** That is the D7 distinction, and it is a
lint-able rule: those two words appear in exactly one module.

`StopConfirmDialog`'s "put N back" promise and the returned `cancelledQueued` are untouched.

#### 5.2 The room halt

`RoomTriggerDispatcher.halt` / `haltAgent` collect a receipt per agent instead of dropping
the boolean (DOR-1425), and the halted notice reports what actually happened:

- all `acked`/`closed`/`not-running` → today's copy, unchanged: **"Stopped 3 agents."**
- any `unconfirmed`/`failed` → **"Stopped 2 agents. 1 didn't confirm — it may still be
  working."**

Claims are dropped exactly as they are today whatever the receipt says: a claim held for a
turn nobody can interrupt is an indicator with nothing behind it. The receipt changes the
_telling_, not the claim lifecycle.

#### 5.3 Task runs

`interruptRun` (`services/tasks/run-stream.ts`) logs the receipt instead of the boolean;
its own `STALL_INTERRUPT_TIMEOUT_MS` race, when it wins, produces
`unconfirmed / ack-timeout` rather than today's sentinel. The run is still finalized either
way. The run-history panel shows "Stopping the run" until the receipt lands, then the same
per-outcome copy as §5.1.

### 6. Conformance

`runtimeConformance` (`@dorkos/test-utils`) replaces its "resolves to a boolean" case with,
for every runtime:

- **I1** — with no turn open, `interruptQuery` resolves `not-running`, never `failed`.
- **I2** — with a turn open, the receipt's outcome is one of the five, `runtime` matches the
  adapter under test, and `reason` is present whenever the table in §4 says it is.
- **I3** — `turnEnded(receipt) === true` implies the session reaches exactly one `turn_end`
  within the runtime's own bound, and the session settles `interrupted` — never `crashed`,
  never `error`.
- **I4** — `turnEnded(receipt) === false` implies DorkOS emitted no `turn_end` of its own.
- **I5** — an adapter whose stop path throws internally still resolves (`failed`), never
  rejects.
- **I6** — a `turn_stopped` event is on the durable stream for every receipt, including
  `not-running`, and exactly one per stop request.

## Decisions

**D1 — Five outcomes, not a boolean-plus-flags.** _Resolved: the union._ A
`{stopped, forced?, confirmed?}` record makes illegal states representable (`stopped:false,
forced:true`) and pushes every consumer into re-deriving the five cases. The union is
exhaustive at the type level and matches the `MessageDeliveryOutcome` precedent.

**D2 — The receipt is derived from `ControlAck`, not an alias of it.** _Resolved._ See §1.
`ControlAck` stays private to the claude-code adapter.

**D3 — `ok` is removed from the interrupt response rather than kept for compatibility.**
_Resolved: removed._ Pre-launch alpha, three internal callers, and keeping it would keep
the exact ambiguity this spec exists to remove. `docs/integrations/sse-protocol.mdx` and
the OpenAPI schema are regenerated in the same change.

**D4 — A new durable event rather than a field on `turn_end`.** _Resolved: `turn_stopped`._
The two endings that most need announcing (`unconfirmed`, `failed`) may never produce a
`turn_end`. A field on an event that may not arrive is not a receipt.

**D5 — The reload marker is projector-attached, never written into a transcript.**
_Resolved._ ADR-0310: transcripts are runtime-owned. Synthetic JSONL would corrupt the
CLI's own resume, and would be invisible to codex and opencode anyway.

**D6 — OpenCode `false` → `unconfirmed`, turn stays open.** _Resolved._ Rationale and
rejected alternatives in §4.

**D7 — Codex maps to `closed`, not `acked`.** _Resolved._ Rationale in §4.

**D8 — `interruptQuery` returns a receipt rather than gaining a second method.**
_Resolved._ A parallel `interruptQueryWithReceipt` would leave the lying boolean in the
interface for every future adapter to implement, which is the legacy pattern AGENTS.md
forbids tolerating.

## What happens to the open tickets

| Ticket                                                                   | Under this spec                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DOR-1299** — OpenCode expiry returns `false`, no receipt               | **Closed by this spec.** §4 gives it `unconfirmed / runtime-declined` and takes the position the review left open.                                                                                                                                                                                                            |
| **DOR-1302** — the pump settles `crashed` on the unacked shape           | **Subsumed.** `closed` is the input the windower lacks: a deliberate close settles `turn_end{terminalReason:'interrupted'}` and the session settles `interrupted` on the pump exactly as on the resume path. Conformance case **I3** is the check.                                                                            |
| **DOR-1320** — spurious `error_during_execution` frame on a stopped turn | **Subsumed in part.** "A stopped turn writes no durable error frame and shows no red card" is an acceptance criterion here (AC-7). The `[ede_diagnostic]` log noise is a separate logging cleanup and **stays on DOR-1320**.                                                                                                  |
| **DOR-1425** — the room halt discards the boolean                        | **Subsumed.** §5.2 — the room is one of the three call sites of the one shape.                                                                                                                                                                                                                                                |
| **DOR-1319** — a Stop took 7.6 s under load                              | **Stays separate.** This spec makes the latency measurable (`turn_stopped` is timestamped and seq'd) and does not change the bound.                                                                                                                                                                                           |
| **DOR-1435** — `applied:false` on the permission PATCH                   | **Stays separate, conformed.** Same family, different verb: a permission change has no "closed" and no "not-running", so it takes the `ControlAck` tri-state and an `applied` field, not `InterruptReceipt`. What it inherits is the principle — never report a control request as done when DorkOS did not observe it apply. |
| DOR-1244, DOR-1300, DOR-1301                                             | Already landed. This spec builds on the bound, the settle, and the client's `stop()` return; none of them is reopened.                                                                                                                                                                                                        |

## Acceptance criteria

- **AC-1** — `AgentRuntime.interruptQuery` and `stopTask` return `InterruptReceipt` on all
  four runtimes; the boolean does not exist anywhere in the repo (grep-checkable).
- **AC-2** — `POST /api/sessions/:id/interrupt` returns `{ receipt, cancelledQueued }` and
  no `ok`; the OpenAPI schema and `sse-protocol.mdx` match.
- **AC-3** — every stop request writes exactly one durable `turn_stopped`, including
  `not-running`; a second window connected to the same session receives it, and a client
  reconnecting with `Last-Event-ID` replays it.
- **AC-4** — conformance cases I1–I6 pass for claude-code, codex, opencode and test-mode.
- **AC-5** — after a Stop and a full page reload, the stopped turn shows exactly one stop
  marker, on each of: a claude-code ack, a claude-code escalated close, and a codex abort.
- **AC-6** — the words "stopped"/"Stopped" reach the UI only for `acked`, `closed` (and the
  room's all-stopped notice); `unconfirmed` and `failed` render the "stop requested" copy of
  §5.1, and the Stop button stays enabled on both.
- **AC-7** — a Stop on the persistent path settles `turn_end{terminalReason:'interrupted'}`
  and the session settles `interrupted`, with no durable `error` frame and no red failure
  card (DOR-1302, DOR-1320-in-part).
- **AC-8** — a room halt where one agent answers `unconfirmed` posts the mixed notice of
  §5.2, and every claim is still released.
- **AC-9** — `cancelledQueued` is returned unchanged on every outcome, `failed` included.
- **AC-10** — a browser test on test-mode drives Stop through `acked` and through a scripted
  `unconfirmed`, and asserts the two different copies and the two different button states.

## Risks

- **A new durable event type is a stream-contract change.** Older clients ignore unknown
  event types by construction, and the snapshot path is additive; the risk is an
  exhaustive-switch typecheck fanning out across the client. Mitigated by keeping
  `turn_stopped` out of the transcript reducer's message path — it feeds the marker only.
- **`unconfirmed` leaves a Stop button on a turn that may already be over.** That is the
  honest state, and `isStreaming` still governs the streaming indicator; the button
  disappears when the turn's own settle arrives.
- **Five outcomes is a vocabulary future runtimes must fit.** §4 shows two runtimes already
  needing four of the five; a sixth ending would be a new spec, not a `detail` string.

## References

- `specs/runtime-interrupt-receipts/01-ideation.md`
- `apps/server/src/services/runtimes/claude-code/sessions/bounded-control.ts` (the bound,
  `ControlAck`), `sessions/session-store.ts` (`interruptGivenQuery`, the escalation)
- `apps/server/src/routes/sessions.ts` (the interrupt route and its placeholder comment)
- `apps/server/src/services/rooms/room-trigger.ts`, `services/rooms/room-turn-runner.ts`
- `apps/server/src/services/tasks/run-stream.ts` (`interruptRun`)
- `apps/client/src/layers/features/chat/model/use-session-submit.ts` (`stop()`)
- `meta/chat-capabilities.md` §1 (C-10, the five-phase Stop matrix and its named limits)
- ADR-0310 (runtime-owned session storage), ADR-0308 (managed OpenCode sidecar),
  ADR `260816-143752` (receipts at the runtime boundary — `MessageDeliveryOutcome`)
- DOR-1244, DOR-1299, DOR-1300, DOR-1301, DOR-1302, DOR-1319, DOR-1320, DOR-1425, DOR-1435
