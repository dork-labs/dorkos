---
slug: runtime-interrupt-receipts
id: 260807-231651
tracker: DOR-1303
created: 2026-08-07
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
gated by `runtimeConformance` — which forces one deliberate behavior change beyond the
receipt: codex's and opencode's abort paths must name their terminal reason, or a receipt
saying the turn ended would sit over a turn that settled `idle` (§4.1). The client's rule falls out of it — call it the
**stop-requested rule**: _"stopped" is only ever said about an ending DorkOS observed;
everything else says "stop requested"._

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
change. Adapters MUST NOT throw for an ordinary refusal — `failed` is the receipt for
that — matching the rule ADR `260816-143752` set for `deliverIntoTurn`.

**The full migration inventory**, because a partial one leaves the lie somewhere:

| Seam                        | File                                                                                                                                                    | What changes                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime interface           | `packages/shared/src/agent-runtime.ts`                                                                                                                  | `interruptQuery`, `stopTask` return types + TSDoc                                                                                                                                       |
| The client port             | `packages/shared/src/transport.ts` (`interruptSession`)                                                                                                 | returns `{ receipt, cancelledQueued }`; the TSDoc paragraph about `ok` being "best-effort" is replaced by the vocabulary                                                                |
| HTTP transport              | `apps/client/src/layers/shared/lib/transport/session-methods.ts`                                                                                        | parses the receipt                                                                                                                                                                      |
| Direct transport (Obsidian) | `apps/client/src/layers/shared/lib/direct/session-methods.ts`                                                                                           | stops **synthesising** an `ok` from the runtime boolean; passes the runtime's receipt straight through, and reports `failed` when the in-process runtime has no `interruptQuery` at all |
| The client's stop hook      | `apps/client/src/layers/features/chat/model/use-session-submit.ts`                                                                                      | `StopOutcome` becomes `{ receipt, cancelled }`; a thrown request becomes `failed / delivery-failed`                                                                                     |
| The exported type           | `apps/client/src/layers/features/chat/index.ts` (barrel) + `widgets/session/ui/SessionComposer.tsx`                                                     | consume the new `StopOutcome`                                                                                                                                                           |
| Room seam                   | `apps/server/src/services/rooms/room-turn-port.ts` — `RoomTurnPort.interrupt` returns `Promise<void>` today                                             | returns `Promise<InterruptReceipt>`; `room-turn-runner.ts` implements it, `room-trigger.ts` collects them                                                                               |
| Server callers              | `trigger-turn.ts`, `trigger-command-intent.ts`, `stall-guard.ts`, `run-stream.ts`, `message-dispatcher.ts`                                              | their local `interruptQuery` structural types and the `!outcome` branches                                                                                                               |
| Test doubles                | `packages/test-utils/src/fake-agent-runtime.ts`, `packages/test-utils/src/mock-factories.ts` (its `stopTask` mock resolves `{ success, taskId }` today) | default to `not-running / no-open-turn`                                                                                                                                                 |

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

It is ingested by the server the moment the receipt is produced — **before** the turn's own
`turn_end`, and independently of whether one ever arrives. That ordering is the point: on
`unconfirmed` and `failed` there may be no `turn_end` at all, and those are precisely the
endings a second window must be told about. It rides the per-session stream, so it replays
via `Last-Event-ID`, appears in the snapshot, and reaches every window and the WebSocket
alike. `not-running` is emitted too — a second window that thinks a turn is open needs to
learn it is not — but it is deliberately not persisted (D9).

**How it becomes durable, and where it does not.** `SessionEventStore.appendTurn` flushes
only at a `turn_end` with an open turn; anything ingested outside a turn consumes a `seq`
and is never written, and that hazard is named verbatim in the store's own doc. So
`turn_stopped` is designed to **ride the turn** rather than to need a new flush path:

- It is **not** added to the projector's `EVENTS_OUTSIDE_THE_TURN`, so it is pushed into
  `inProgressTurn` and flushed with that turn by the existing `appendTurn`.
- It **is** added to `RECORDED_EVENT_TYPES` (`projector-persistence.ts`), or claude-code —
  which persists in `'record'` mode, its history coming from JSONL — would silently drop it
  at flush. This is the same reasoning that put `interaction_resolved` there: a fact created
  entirely inside DorkOS is durable here or it is nowhere.
- `not-running` has no open turn, so it is never persisted. That is correct rather than a
  gap: there is no turn for a reload to mark, and nothing was stopped (D9).
- `unconfirmed` and `failed` leave the turn open, so their event is flushed whenever that
  turn eventually ends, by whatever ends it. If the process dies first, the whole turn's
  events die with it — the durability every other event in that turn has, not a new hole.

No out-of-turn flush path is introduced, and the seq space stays exactly as sparse as it is
today.

**Registration points — every one of them, because the DOR-1215 lesson is that missing one
fails silently.** A compaction boundary shipped with its projection and its row and reached
neither, for one missing line in a runtime allowlist. A new event type here must hit all of:

| #   | Where                                                                                                                      | Why it fails silently without it                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `packages/shared/src/session-stream.ts` — the `SessionEvent` union                                                         | nothing can construct or parse it                                                                                                                                                                      |
| 2   | `session-event-normalizer.ts` — the raw shape + case, as `RawContextStaged` does for `context_staged`                      | the server-side emit helper has nothing to ingest                                                                                                                                                      |
| 3   | `session-state-projector.ts` — deliberately **absent** from `EVENTS_OUTSIDE_THE_TURN`, plus the snapshot marker attachment | it would stream live and never persist                                                                                                                                                                 |
| 4   | `projector-persistence.ts` — `RECORDED_EVENT_TYPES`                                                                        | dropped at flush for claude-code (`'record'` mode) — the default runtime                                                                                                                               |
| 5   | `event-log-history.ts` — the `reconstructHistoryFromEvents` fold                                                           | log-backed runtimes (codex, opencode, test-mode) hydrate a cold transcript with no marker. **claude-code does not use this fold**, which is why the marker also needs the JSONL-independent path in §3 |
| 6   | `session-stream-store.ts` — `TURN_EVENT_TYPES` (client)                                                                    | the live marker never reaches the projection, exactly the DOR-1215 shape                                                                                                                               |
| 7   | the client bubble projection + its row component                                                                           | the part exists and renders nothing                                                                                                                                                                    |
| 8   | `docs/integrations/sse-protocol.mdx` + the OpenAPI schema                                                                  | the public contract lies                                                                                                                                                                               |

### 3. The reload story

**The rule: the durable record is the authority, the transcript is the runtime's.** At
snapshot build the projector attaches, to the turn it belongs to, a **stop marker** derived
from the durable `turn_stopped` plus that turn's `turn_end{terminalReason}`. Nothing is
written into any runtime's transcript store (ADR-0310).

Two paths, because the two persistence modes hydrate differently:

- **Log-backed runtimes** (codex, opencode, test-mode — `'history'` mode) get the marker
  from the existing fold: `reconstructHistoryFromEvents` gains a `turn_stopped` case
  (`event-log-history.ts`), exactly as `compact_boundary` has one.
- **claude-code** (`'record'` mode) has no fold — its completed history is read from JSONL —
  so `buildSnapshot` reads the markers from the durable store it is already holding
  (`persistence.store`, filtered to `turn_stopped`) and attaches them to the hydrated turns
  by turn boundary. This is the JSONL-independent path, and it is the one that matters most:
  claude-code is the default runtime and the one whose CLI writes no marker of its own.

`session-state-projector.ts` already re-attaches non-transcript facts at `buildSnapshot`
(`openSigninCards`), and that precedent is worth stating precisely: it demonstrates the
**attachment mechanism**, not the lifetime. Sign-in cards are in-memory and deliberately
short-lived — one turn of grace, then retired. A stop marker is the opposite: durable, and
permanent for the life of the turn's rows. The durability comes from the store, not from
the precedent.

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

Every cell is what the adapter returns. **The mapping of an existing stop path to a receipt
adds no behavior; two rows marked "mapper change" do, and they are specified in §4.1.**

| Runtime         | Situation                                                                                              | Receipt                                          |
| --------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **claude-code** | no session, or no live query                                                                           | `not-running` / `no-open-turn`                   |
|                 | `query.interrupt()` acked                                                                              | `acked`                                          |
|                 | acked-with-failure, then `close()` succeeded                                                           | `closed` / `refused`                             |
|                 | unanswered inside `STOP_ACK_TIMEOUT_MS`, then `close()` succeeded                                      | `closed` / `ack-timeout`                         |
|                 | stdin already ended — closed with no graceful attempt                                                  | `closed` / `stdin-ended`                         |
|                 | `close()` itself threw                                                                                 | `failed` / `delivery-failed`                     |
|                 | `stopTask` — the SDK's background-task stop                                                            | today's boolean, mapped: `acked` / `not-running` |
| **codex**       | no `AbortController` for the session                                                                   | `not-running` / `no-open-turn`                   |
|                 | `controller.abort()` — the adapter's own TSDoc says this SIGTERMs the per-turn `codex exec` subprocess | `closed` — **requires mapper change** (§4.1)     |
|                 | `stopTask` — codex has no addressable background tasks at all                                          | `not-running` / `no-open-turn`                   |
| **opencode**    | no tracked turn                                                                                        | `not-running` / `no-open-turn`                   |
|                 | `session.abort` returned `true`                                                                        | `acked` — **requires mapper change** (§4.1)      |
|                 | `session.abort` returned `false`                                                                       | `unconfirmed` / `runtime-declined`               |
|                 | the abort call threw (sidecar down, network)                                                           | `failed` / `delivery-failed`                     |
|                 | `stopTask` — opencode exposes no addressable background tasks at all                                   | `not-running` / `no-open-turn`                   |
| **test-mode**   | a scripted turn was open, default                                                                      | `closed`                                         |
|                 | a scenario declares the receipt it should answer                                                       | as scripted (any of the five)                    |
|                 | none                                                                                                   | `not-running` / `no-open-turn`                   |

**Codex is `closed`, never `acked`, and that is deliberate.** Its only interrupt primitive
is aborting the controller, which — by the adapter's own account — SIGTERMs the per-turn
subprocess. Nothing in codex acknowledges a stop; the turn ends because the process died.
Reporting that as `acked` would tell the person the agent wound down when it did not, and
would hide the same cost `closed` exists to name.

**Test-mode's default is `closed` for exactly that reason (D10).** Its stop is
`interactionGate.abort` — DorkOS ending the scenario from the outside. Nothing in the
scripted turn acknowledges anything, so `acked` would make the one runtime the browser tests
trust the one runtime that lies. Because test-mode exists to stage shapes on demand, a
scenario may instead **declare** the receipt its abort answers, which is how the browser leg
reaches `acked`, `unconfirmed` and `failed` deterministically (AC-10).

#### 4.1 The two abort paths must name their terminal reason

`turnEnded(receipt) === true` promises the turn settles `interrupted` (conformance I3), and
today neither non-claude runtime keeps that promise:

- **codex** — `mapCodexThread` catches the `AbortError` and yields a plain `done` carrying
  no `terminalReason`, so `feedProjector` closes the turn with a bare `turn_end` and the
  session settles `idle`. Indistinguishable from a reply that finished by itself.
- **opencode** — `mapSessionError` suppresses the `MessageAbortedError` shape entirely and
  the turn terminates on the `session.idle` that follows, again with no terminal reason.

Both are the right call for "an abort is not an error" and the wrong call for "an abort is
not a completion". **Each mapper's abort path stamps `terminalReason: 'interrupted'` on the
`done` it yields** — a value already in the projector's `INTERRUPTED_TERMINAL_REASONS`, so
the lifecycle derivation and the cold-hydrate settle both work with nothing further to
change. The suppression itself is untouched: still no typed `error` event, still no red card.

This is the one deliberate behavior change outside the receipt itself, and it is what the
vocabulary means. A receipt that says the turn ended, over a turn that settles `idle`, is
the same lie in a new place.

#### 4.2 The OpenCode position (DOR-1299)

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
`unconfirmed` and `failed` say "stop requested".** That is the stop-requested rule, and it
is checkable rather than aspirational: both phrasings live in one copy module, so a test
asserts the mapping instead of grepping the UI.

**The re-enable predicate (DOR-1300, made explicit).** The button re-enables when

```
!turnEnded(receipt) || (receipt.outcome === 'not-running' && stillStreaming)
```

Each half earns its place. `unconfirmed` and `failed` re-enable because the turn may well
still be running and pressing again is the only move the person has. `acked` and `closed`
do not, because DorkOS observed the end and the turn's own settle takes the button away.
`not-running` is the interesting one and it is today's `ok: false` shape: the runtime found
no turn while the client still believes it is streaming, so the two disagree — and the
person must be able to press again rather than watch "Stopping…" for ever. When the client
agrees there is nothing running, `not-running` needs no button at all. `isStreaming` stays
the primary signal throughout; the receipt only resolves the disagreement.

`StopConfirmDialog`'s "put N back" promise and the returned `cancelledQueued` are untouched.

#### 5.2 The room halt

The seam that changes is `RoomTurnPort.interrupt`, which returns `Promise<void>` today —
its own TSDoc already admits it reports "only that the interrupt was delivered". It returns
an `InterruptReceipt`; `room-turn-runner.ts` produces it and `RoomTriggerDispatcher.halt` /
`haltAgent` collect one per agent instead of dropping the boolean (DOR-1425). The halted
notice then reports what actually happened:

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
  within the runtime's own bound, carrying a terminal reason in
  `INTERRUPTED_TERMINAL_REASONS`, and the session settles `interrupted` — never `idle`,
  never `crashed`, never `error`. (This is what §4.1's mapper change exists to satisfy.)
- **I4** — `turnEnded(receipt) === false` implies DorkOS emitted no `turn_end` of its own.
- **I5** — an adapter whose stop path throws internally still resolves (`failed`), never
  rejects.
- **I6** — exactly one `turn_stopped` is emitted per stop request, `not-running` included,
  and every one of them with an open turn is on the durable stream after that turn ends.

## Decisions

**D1 — Five outcomes, not a boolean-plus-flags.** _Resolved: the union._ A
`{stopped, forced?, confirmed?}` record makes illegal states representable (`stopped:false,
forced:true`) and pushes every consumer into re-deriving the five cases. The union is
exhaustive at the type level and matches the `MessageDeliveryOutcome` precedent.

**D2 — The receipt is derived from `ControlAck`, not an alias of it.** _Resolved._ See §1.
`ControlAck` stays private to the claude-code adapter.

**D3 — `ok` is removed from the interrupt response rather than kept for compatibility.**
_Resolved: removed._ Pre-launch alpha, a closed set of callers (all of them inventoried in
§2), and keeping it would keep the exact ambiguity this spec exists to remove. `docs/integrations/sse-protocol.mdx` and
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

**D9 — `turn_stopped` rides the turn; no out-of-turn flush path is built; `not-running` is
never persisted.** _Resolved — see the 2026-08-23 amendment at the end of this item, which
is why the second clause no longer describes the codebase._ This is the decision the
durability story turns on, so the alternatives are on the record.

`SessionEventStore.appendTurn` flushes a turn's events at its `turn_end`, and its own doc
names the hazard: an event ingested outside a turn consumes a `seq` and is never written.
Three options were on the table.

- **(a) A new out-of-turn flush path** for an allowlist of events. Rejected as the general
  answer. It adds a second way for rows to reach the store, makes the already-sparse seq
  space sparser in a new pattern, and buys nothing for four of the five outcomes — those all
  happen with a turn open, so riding the turn already persists them.
- **(b) Attach the receipt to the session snapshot only**, `pendingInteractions`-style.
  Rejected: it survives within the process and dies with a restart, which is exactly the
  reload story this spec exists to deliver.
- **(c) Downgrade the reload story to in-memory replay.** Rejected for the same reason —
  it is the feature.

**Chosen: ride the turn, plus one deliberate non-persistence.** `turn_stopped` stays out of
`EVENTS_OUTSIDE_THE_TURN` so it is flushed with its turn, and joins `RECORDED_EVENT_TYPES`
so claude-code's `'record'` mode keeps it — the `interaction_resolved` precedent exactly: a
fact created entirely inside DorkOS is durable here or nowhere. `not-running` alone has no
open turn, so it is emitted live and never written, and **a reload after a `not-running`
shows nothing at all** — which is right, because nothing was stopped and there is no turn to
mark. The cost of the choice is the honest one: `unconfirmed` and `failed` are durable only
once their turn ends, so a server that dies mid-turn loses the receipt along with the rest
of that turn's events. That is the durability every other event in the turn has, not a new
hole, and buying more would mean building (a) for one row.

**Amended 2026-08-23 (DOR-1439): (a) now exists, and D9's rejection of it still stands for
`turn_stopped`.** A parked Ask needed the same path and had a reason `turn_stopped` does
not have: an ask parks precisely because its turn CANNOT end — nobody has answered, the
promise is unresolved, and a flush that waits for `turn_end` waits forever. So the eager
path was built, narrowly, for the interaction events
(`EAGERLY_RECORDED_EVENT_TYPES` in `projector-persistence.ts`). The reasoning above is
unaffected where it matters: all five stop outcomes happen WITH a turn open, so riding the
turn still persists four of them and `not-running` still has no turn to ride. What changes
is only the cost line — the mechanism is no longer hypothetical, so whoever executes this
spec may reconsider whether `unconfirmed` and `failed` are worth mid-turn durability, as a
decision on its own merits rather than one foreclosed by "no such path exists".

**D10 — Test-mode's abort maps to `closed` by default, and a scenario may declare any
receipt.** _Resolved._ `interactionGate.abort` is DorkOS ending the scenario from outside;
by D7's own logic that is a `closed`, and mapping it to `acked` would make the runtime the
browser tests trust the runtime that lies. Scenario-declared receipts are what keep the
browser leg able to stage all five endings deterministically.

## What happens to the open tickets

| Ticket                                                                   | Under this spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DOR-1299** — OpenCode expiry returns `false`, no receipt               | **Closed by this spec.** §4 gives it `unconfirmed / runtime-declined` and takes the position the review left open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **DOR-1302** — the pump settles `crashed` on the unacked shape           | **Subsumed.** The windower is handed the WHOLE receipt (not merely a "was closed" flag), recorded against the query on the record `stoppedQueries` already keeps. `session-turn-windows.ts` consults it at `crashResult`, which is where an escalated `close()` reaching `onCrash` synthesises the `error_during_execution` result today, and yields a stopped terminal — `terminal_reason: 'interrupted'`, not an error subtype — instead. The session then settles `interrupted` on the pump exactly as on the resume path. Conformance case **I3** is the check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **DOR-1320** — spurious `error_during_execution` frame on a stopped turn | **Subsumed in part**, at two named sites. A frame DorkOS synthesises is suppressed at `crashResult` (above). A frame the CLI itself produces — a `result` whose subtype is non-success on an ACKED stop, which is what the flag-ON runs saw — is suppressed where that subtype becomes a typed error (`sdk/sdk-error-mapping.ts`), gated on the same per-query stop record, and settles the turn on its interrupt reason instead. Both are AC-7. The `[ede_diagnostic]` log noise is a logging cleanup with no user-facing surface and **stays on DOR-1320**.<br><br>**Shipped 2026-08-23 (DOR-1320), the CLI-frame half only.** The gate is implemented exactly as specified — `isStoppedTurnResult` (`sdk/sdk-error-mapping.ts`) ANDs the result's abort terminal reason with the per-query stop record, threaded to the mapper by whichever loop owns the turn. The conjunct is not optional: the CLI collapses nine abort causes into `aborted_streaming`/`aborted_tools`, only one of them an operator interrupt, so a shape-only gate would drop a `refusal-fallback-edit` failure's error frame. The pump additionally clears its query out of the record at every dispatch, because one warm process serves many turns under one `Query`. The `crashResult` half is untouched and still belongs to DOR-1302 — it carries no `terminal_reason`, so the shipped suppression provably cannot reach it. **AC-7 is therefore half-satisfied**; the receipt vocabulary is still what closes it. |
| **DOR-1425** — the room halt discards the boolean                        | **Subsumed.** §5.2 — the room is one of the three call sites of the one shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **DOR-1319** — a Stop took 7.6 s under load                              | **Stays separate.** This spec makes the latency measurable (`turn_stopped` is timestamped and seq'd) and does not change the bound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **DOR-1435** — `applied:false` on the permission PATCH                   | **Stays separate, conformed.** Same family, different verb: a permission change has no "closed" and no "not-running", so it takes the `ControlAck` tri-state and an `applied` field, not `InterruptReceipt`. What it inherits is the principle — never report a control request as done when DorkOS did not observe it apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| DOR-1244, DOR-1300, DOR-1301                                             | Already landed. This spec builds on the bound, the settle, and the client's `stop()` return; none of them is reopened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Acceptance criteria

- **AC-1** — `AgentRuntime.interruptQuery` and `stopTask` return `InterruptReceipt` on all
  four runtimes; the boolean does not exist anywhere in the repo (grep-checkable).
- **AC-2** — the whole `ok` inventory of §2 is migrated: the route returns
  `{ receipt, cancelledQueued }`; `Transport.interruptSession` declares it; the HTTP
  transport parses it; the direct (Obsidian) transport passes the runtime's receipt through
  and synthesises no `ok`; `StopOutcome` carries the receipt; the OpenAPI schema and
  `sse-protocol.mdx` match. No `ok` remains on any stop path.
- **AC-3** — every stop request emits exactly one `turn_stopped` and a second window
  receives it. For every outcome with an open turn it is on the durable stream once that
  turn ends — verified after a server restart on claude-code (`'record'` mode) and on one
  log-backed runtime — and a client reconnecting with `Last-Event-ID` replays it.
  `not-running` emits live and is deliberately absent from the store (D9).
- **AC-4** — conformance cases I1–I6 pass for claude-code, codex, opencode and test-mode.
- **AC-5** — after a Stop and a full page reload, the stopped turn shows exactly one stop
  marker, on each of: a claude-code ack, a claude-code escalated close, and a codex abort.
  A reload after a `not-running` shows no marker.
- **AC-6** — the words "stopped"/"Stopped" reach the UI only for `acked`, `closed` (and the
  room's all-stopped notice); `unconfirmed` and `failed` render the "stop requested" copy of
  §5.1. The re-enable predicate of §5.1 is unit-tested over all five outcomes crossed with
  `stillStreaming` true/false.
- **AC-7** — a Stop on the persistent path settles `turn_end{terminalReason:'interrupted'}`
  and the session settles `interrupted`, with no durable `error` frame and no red failure
  card — covering both suppression sites: a DorkOS-synthesised `crashResult` and an acked
  stop whose CLI `result` carried a non-success subtype (DOR-1302, DOR-1320-in-part).
- **AC-8** — a room halt where one agent answers `unconfirmed` posts the mixed notice of
  §5.2, and every claim is still released.
- **AC-9** — `cancelledQueued` is returned unchanged on every outcome, `failed` included.
- **AC-10** — a browser test on test-mode drives Stop through a scripted `acked`, a scripted
  `unconfirmed` and the default `closed`, asserting the copy and the button state for each.
- **AC-11** — a codex abort and an opencode abort each settle
  `turn_end{terminalReason:'interrupted'}` and the `interrupted` lifecycle, live and after a
  cold hydrate (§4.1), with no typed `error` event on either.

## Risks

- **The real hazard of a new event type is the allowlists, not the types.** A typecheck
  failure is loud and cheap; a missing line in one of the eight registration points of §2 is
  silent — the DOR-1215 shape, where a compaction boundary's projection and row both shipped
  and nothing live ever reached them. Two of the eight are easy to miss for opposite
  reasons: `RECORDED_EVENT_TYPES`, whose absence drops the row for the DEFAULT runtime only,
  and the client's `TURN_EVENT_TYPES`, whose absence breaks the LIVE marker while the reload
  marker keeps working. `turn_stopped` belongs in both — it rides the turn on the server and
  must reach the projection on the client — and a test pins each membership by name.
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
- `apps/server/src/services/rooms/room-turn-port.ts` (`RoomTurnPort.interrupt`, the seam),
  `services/rooms/room-trigger.ts`, `services/rooms/room-turn-runner.ts`
- `apps/server/src/services/session/session-event-store.ts` (the turn-scoped flush and its
  named out-of-turn hazard), `session/projector-persistence.ts` (`RECORDED_EVENT_TYPES`,
  the two modes), `session/event-log-history.ts` (the history fold),
  `session/session-state-projector.ts` (`EVENTS_OUTSIDE_THE_TURN`,
  `INTERRUPTED_TERMINAL_REASONS`, snapshot attachment)
- `apps/server/src/services/runtimes/codex/event-mapper.ts` (`mapCodexThread`'s abort arm),
  `runtimes/opencode/session-event-mapper.ts` (`mapSessionError`'s abort suppression),
  `runtimes/claude-code/sessions/session-turn-windows.ts` (`crashResult`)
- `apps/client/src/layers/entities/session/model/session-stream-store.ts`
  (`TURN_EVENT_TYPES`), `packages/shared/src/transport.ts` (`interruptSession`)
- `apps/server/src/services/tasks/run-stream.ts` (`interruptRun`)
- `apps/client/src/layers/features/chat/model/use-session-submit.ts` (`stop()`)
- `meta/chat-capabilities.md` §1 (C-10, the five-phase Stop matrix and its named limits)
- ADR-0310 (runtime-owned session storage), ADR-0308 (managed OpenCode sidecar),
  ADR `260816-143752` (receipts at the runtime boundary — `MessageDeliveryOutcome`)
- DOR-1244, DOR-1299, DOR-1300, DOR-1301, DOR-1302, DOR-1319, DOR-1320, DOR-1425, DOR-1435
