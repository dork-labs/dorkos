---
id: 260816-143752
title: Three message dispositions at the ingress, one optional runtime verb, and interrupt on its own
status: accepted
created: 2026-08-16
spec: persistent-session-runtime
supersedes: null
amends: null
superseded-by: null
---

# 260816-143752. Three message dispositions at the ingress, one optional runtime verb, and interrupt on its own

## Status

Accepted — implemented by spec `persistent-session-runtime` phase P4 (PRs #1004, #1026, #1028, #1030, #1038, #1041, #1054).

This is the contract half of the persistent-session work — "ADR-a" in the spec's own numbering, written last of the three because the contract is what the other two made possible. [ADR 260811-184735](260811-184735-server-owned-durable-message-queue.md) ("ADR-c") made a waiting message durable and server-owned; [ADR 260812-134510](260812-134510-persistent-streaming-input-sessions.md) ("ADR-b") made the process it waits for warm. This ADR names what a sender may ask for once both of those are true. ADR-c already sketched the shape — it said native runtime queueing stays an adapter-level optimization behind a capability ladder, and noted that every runtime declared its flags `false` at the time it was written. That sentence was a report of P2's state, not a limit: this ADR is where the flags become real, and claude-code now declares `supportsSteer` and `supportsContextStaging` `true`. Nothing in ADR-c is retired, so there is no `amends` link.

## Context

`sendMessage` was the only way into a session, and `interruptQuery` the only mid-turn control. Between those two there was nothing. A person who thought of something while the agent was working had exactly two moves: wait, or stop the agent and start over. There was no way to say "also do X", no way to hand the agent a file path it plainly needed, and no way for the sender to express which of those they meant — a message was a message, and the only question the system asked was whether it could run right now.

The answer to that question was a refusal. A second message arriving mid-turn got `409 SESSION_LOCKED` at HTTP: an error about the session's state, returned to somebody whose message was perfectly good. What made that answer survivable was a queue in the browser (ADR-0104) — ephemeral React state in one tab, invisible to the server, lost on refresh. So every scrap of intelligence about "what happens to the second message" lived in the client, where it could not be reasoned about, tested at the boundary, or shared with a second window.

The industry had already converged on the shape of the missing vocabulary. Codex's app-server models `turn/steer` as a verb distinct from `turn/interrupt`. Amp expresses steering as an envelope flag on an ordinary message — `{steer: true}` — with interrupt kept separate. Both draw the same line in the same place: changing what a running turn is doing is a different act from cancelling it, and the first one carries content while the second does not. The DOR-82 runtime survey (`research/20260610_message_queuing_agent_runtimes.md`) names the four patterns in use across the field — block, queue-to-end, interrupt-restart, and steer-inject — with Codex and Amp modelling steer as a first-class verb distinct from interrupt. DorkOS's `409` sat at the blocking end of that taxonomy.

## Decision

**A sender states one of three dispositions — `queue`, `steer`, `stage` — once, at the server ingress, as a field on the message envelope. The server resolves it against the resolved runtime's declared capabilities. Interrupt stays a separate verb.**

- **The envelope, not the verb list.** `disposition?: MessageDisposition` rides `POST /api/sessions/:id/messages` and flows through the dispatcher (`MessageDispositionSchema`, `packages/shared/src/schemas.ts`). Absent reads as `queue` at every ingress — the route, the dispatcher, and the queue store all default the same way, so a caller that says nothing gets the behavior that is always supported.
- **Disposition is ignored when the session is idle.** With no turn open there is nothing to wait behind, steer into, or stage onto, so all three mean "run it now". A sender never has to check whether the session is busy before choosing one, which is what keeps the field a preference rather than a precondition.
- **Interrupt is a separate verb because it is a different kind of act.** It carries no content, and it can be issued with nothing to send afterwards. Folding "stop" into a message envelope would require inventing a contentless message, which is a worse lie than an extra endpoint. `POST /api/sessions/:id/interrupt` stays where it is.
- **Three required capability booleans on `RuntimeCapabilities`** — `supportsPersistentSession`, `supportsSteer`, `supportsContextStaging`. First-class boolean fields rather than entries in the `features` bag, which is what ADR-0256 asks for a capability that genuinely is a boolean. Required rather than optional — following the `commandIntents` precedent in the interface itself, not ADR-0256, which does not decide that question — so a new adapter cannot silently omit one and inherit behavior it never declared. On `main` today: claude-code and test-mode declare steer and staging `true`; codex and opencode declare both `false`.
- **There is deliberately no `supportsQueue`.** The server owns the queue for every runtime (ADR-c), so queueing is true by construction. A flag saying so could only ever be wrong — an adapter answering `false` would be describing a refusal the server would not honor anyway.

### The refinement drafting forced: `deliverIntoTurn` returns a receipt

The original shape was "one envelope field, no new runtime verbs" — a steer would ride `sendMessage`'s existing return. **The type system said no, and it was right.** `sendMessage` returns `AsyncGenerator<StreamEvent>`, and `feedProjector` consumes exactly one such generator as exactly one turn. A steer's events belong to a turn whose generator is _already_ being consumed by another `feedProjector` call. Returning a second turn-shaped generator would mean two feeds fighting over one turn — a bug, not a design.

So the runtime interface grows **one optional method**, `deliverIntoTurn(sessionId, content, opts)`, returning a `RuntimeDeliveryResult` receipt rather than a stream (`packages/shared/src/agent-runtime.ts`). This is not a change of mind about the decision; it is the decision surviving contact with the types. The intent of the envelope was "one ingress field instead of three required runtime verbs", and that is preserved exactly: the ingress still takes one field, and the interface gains one _optional_ method rather than three required ones. The return type is a receipt because the events genuinely surface elsewhere — pretending otherwise would have been the dishonest shape.

Three properties hold that method to the contract:

- **It returns a receipt, not a generator** — for the reason above.
- **It is called only when the matching flag is declared** (`supportsSteer` for `'steer'`, `supportsContextStaging` for `'stage'`). It is optional so a runtime that can do neither omits it entirely, and the server's ladder covers the gap.
- **It must not throw for an ordinary refusal.** No open turn, a closed input stream, an unsupported mode — all report `{ delivered: false, reason }`. A throw is reserved for a genuine fault, exactly as for `sendMessage`. Degrading is the server's job; failing a person's message is not.

### The ladder, and the rule that every downgrade is reported

`deliverByDisposition` in `apps/server/src/services/session/message-dispatcher.ts` resolves a requested disposition to what actually happened:

```
steer -> supportsSteer, no pending interaction -> deliverIntoTurn({ mode: 'steer' })
         else -> queue, and say why
stage -> supportsContextStaging AND canStageSession(id) is not false
           -> deliverIntoTurn({ mode: 'stage' })
         else -> fold into the next dispatch as additional context
queue -> always available; it is the floor and never reaches the ladder
```

**The flag is the routing authority; the receipt is the delivery authority.** The flag decides which rung to try, and it is read _first_ — so a runtime that cannot steer reports `unsupported` rather than whatever the session happened to be doing at that moment. The receipt then decides what actually landed. A runtime that declares a capability and then fails to deliver it has an adapter bug: it is logged as one and degraded honestly, never thrown and never lost.

**Every downgrade is reported.** `MessageDeliveryOutcome` carries `requested` and `applied` — both always present, even when they match, so a consumer decides whether to say anything by comparing them rather than by sniffing for a field — plus `degradedBecause` when they differ. The outcome rides the 202 body, and whenever the downgrade landed the message on the queue (or held it for a fold) it also rides the `queue_update` event on the durable stream, so a second window learns of it too. **Silent degradation is the failure this design exists to prevent**: a system that quietly queues a message somebody asked to be steered has told them a lie about their own agent.

**Two reasons are exceptions, and both exceptions are in the telling rather than the reporting.** The server stamps them on the outcome and puts them on the wire exactly like the rest; what differs is what a consumer is expected to do with them, which is nothing. The cockpit maps both to no chip at all (`queue-chips.ts`), while `unsupported`, `not-steerable`, `no-open-turn`, and `pending-interaction` each get a line. The wire stays complete; the UI stays quiet.

- `session-idle` — a steer on an idle session simply ran now, and "it ran immediately" is not a degradation anybody needs told about.
- `not-stageable` — the chip has nowhere to appear and nothing left to say. A folded stage joins no queue, so there is no row for a chip to hang on (`queueDowngradeNotice` is only ever read over the waiting queue), and the person has already been told in the place they are looking: the `context_staged` receipt renders as a `StagedContextNote` reading "Added context for the next reply" above their own words. A second sentence would duplicate that or imply a failure, and nothing failed.

**`not-steerable` was added on 2026-08-16 (DOR-1268) because the quiet reason was swallowing a loud one.** A runtime reports `no-open-turn` both when the turn genuinely ended and when a turn is plainly running that it cannot join, and the ladder read both as `session-idle` — so a claude-code session on the resume path, which is how a default install ships, accepted a steer, said nothing, and ran it as an ordinary follow-up turn. The fork is now made against the session's own projection: a turn open at that moment means the runtime could not JOIN it, which is `not-steerable` and gets a sentence. `session-idle` keeps exactly its old meaning. The same change gives `AgentRuntime` an optional `canSteerSession(id)` so the composer offers Steer only where one could land; `supportsSteer` stays what it always was, a statement about the adapter.

**`not-stageable` was added on 2026-08-17 (DOR-1307) because the flag was doing the same lying for stage, and getting it wrong cost more.** `supportsContextStaging` is a claim about the ADAPTER, and the ladder read it as a claim about the session — so a stage on a default claude-code install took the native path, where the adapter's only way to honour it was to BOOT a process the operator had not turned on and register the session, after which every later message ran on the pump and the composer began offering Steer. Where a mis-declared steer put a dead button in front of somebody, a mis-declared stage silently opted their session into an experiment. The fix is the same seam DOR-1268 built: an optional `canStageSession(id)` that narrows the flag per session, checked after it, and a `false` routes to the fold. The receipt says `not-stageable` rather than `unsupported`, which would have contradicted the runtime's own declared capability on every install. Conformance case C9 mirrors C7 (C8 was already `settleOpenTurn`).

The one asymmetry with `canSteerSession` is what a `false` costs the person: **nothing**. A steer that cannot land is a dead affordance, so the composer hides the Steer row; a stage that cannot land natively still lands, by the fallback below, so Add context stays offered on both paths and `canStageSession` never reaches the client at all. It exists to stop the SERVER asking for a native stage the adapter would have to manufacture.

`pending-interaction` deserves its own line. A turn parked on a permission ask or a question is parked on a _person_, and words arriving at that moment would be read as their reply. So a steer never reaches such a turn; it queues and waits for the resolution, exactly as a queued message does.

### Stage falls back rather than failing

A stage that cannot reach a transcript is still accepted: the text is held and folded into the next dispatch as an additional-context entry (ADR-0273's neutral context bag), and the same `context_staged` receipt is emitted either way. To the person a stage landed; the reason is only _how_. The alternative — refusing a stage wherever the native path is missing — would have made the newest disposition the least reliable one.

**Two absences fold, and they are told apart on the wire.** A RUNTIME that cannot append to its own transcript at all folds as `unsupported` (codex, opencode). A SESSION whose runtime can, but which is not holding the seam open, folds as `not-stageable` — which after DOR-1307 is the default claude-code install, and so the common case rather than the exotic one. Conflating them would have made the receipt contradict `supportsContextStaging: true` on nearly every install.

### Steer and stage are writes, with the same authorization as sending

Both are gated by the runtime's real write-lock (`AgentRuntime.isLocked`), asked under the canonical id and held under the dispatch mutex, so the lock check and the delivery cannot straddle a turn ending or a warm-process reap. It is deliberately not the dispatcher's `inFlight` mirror, which is lossy: a budget-exhausted launch runs its turn holding the real lock without ever claiming `inFlight`, so gating on the mirror would let any client steer that turn. The spec's invariant, stated under its Security Considerations, is that **there is no path where a caller that may not send may steer**. `deliverSteer` and `deliverStage` are the only two server paths to `deliverIntoTurn` — one per disposition, both holding the same gate — and the single-ingress audit (`dispatcher-single-ingress.test.ts`) holds both to it, treating `deliverIntoTurn` as a turn-starter that may only be called from the dispatcher, exactly as it treats `sendMessage`.

### Where interrupt's honesty stops, on purpose

`POST /:id/interrupt` clears the DorkOS queue **synchronously, before** the runtime interrupt, with no await between the two — so the turn ending here cannot let the pump release the head of the queue on its way out. The cleared messages ride back on the response as `cancelledQueued`: nothing a person typed is destroyed by pressing Stop, it returns to their composer. If the interrupt itself throws, the response still reports `ok: false` **and still returns the cleared messages**, because those rows are already gone and dropping them would break exactly the promise the endpoint exists to keep.

The narrower promise — what the _runtime_ cancelled, via the CLI's `cancel_queued` behind the `interrupt_cancel_queued_v1` feature flag — is deliberately **not** made here. It belongs to the not-yet-built `runtime-interrupt-receipts` spec (`260807-231651`, spec §D7: depend, do not absorb). Until that lands, `interruptQuery` stays a bare `Promise<boolean>` and the client says "stop requested" rather than "stopped". Widening the interrupt receipt inside this spec would have meant designing another spec's contract in passing.

## Consequences

### Positive

- A person working with an agent has three answers instead of one, and the honest one is always available. "Also do X" no longer costs a stopped agent.
- The vocabulary is stated once, at the ingress, in a place every client and integration reaches over HTTP — not reimplemented per surface, and not stranded in one browser tab.
- A new runtime author implements **nothing** to be correct. Omit `deliverIntoTurn`, declare two `false` booleans, and every disposition still works through the server's queue with an honest receipt. Capability is opt-in; correctness is not.
- The client can say what happened rather than guess. `requested` plus `applied` plus `degradedBecause` is enough for the composer to explain a downgrade in the sender's own terms.
- Conformance holds every runtime to it. `runtimeConformance` cases C1 (a disposition it does not declare is absent or refused as `unsupported`, never thrown; a declared one reaches the model inside the open turn and mints no second `turn_start`), C2 (one `turn_end` per window however many native results it carried), C3 (queue durability behind a failed turn and never into an open interaction), C6 (the three flags are real booleans), C7 (a runtime that answers per session about STEERING narrows its flag and never widens it), and C9 (the same of STAGING — C8 was already taken by `settleOpenTurn`) make a false declaration a test failure rather than a mystery in production.

### Negative

- **Two-thirds of the vocabulary is unavailable on two of the three production runtimes.** Codex and opencode declare both flags `false`, so a person who learns to steer on claude-code will find the same button degrade to a queue on a codex session. The receipt says so, but the experience is genuinely uneven and stays that way until those adapters gain the capability.
- **The ladder is a second place correctness lives.** The flag routes and the receipt decides, which means a wrong flag and a wrong receipt fail differently and both must be tested. C1 and C6 exist because of this, and they are the cost of allowing adapters to be optimistic.
- **`deliverIntoTurn` is optional, so its absence is indistinguishable from a runtime that simply cannot.** That is the point, but it means a genuinely broken adapter — one that meant to implement steering and wired nothing — degrades quietly to a queue rather than failing loudly. C1's "declares a disposition but wired no driver" assertion is the only thing standing between that and silence.
- **A stage that folded is not the stage that was asked for.** The receipt says `applied: 'stage'` with `degradedBecause: 'unsupported'` or `'not-stageable'`, which is honest, but a folded stage reaches the agent one turn later than a native one. Somebody who staged a correction expecting the current turn to see it will find it arrived for the next. After DOR-1307 this is what a default claude-code install does with every Add context, so the exotic case became the ordinary one.
- **The default install's staged words moved from durable storage to memory, under a durable receipt.** The native path writes to the runtime's own transcript (claude-code's SDK JSONL), which survives a restart; the fold holds the text in a process-local `Map` (`staged-context-store.ts`), which does not. Meanwhile `emitContextStaged` puts the "Added context for the next reply" receipt on the DURABLE session stream the moment the stage lands. So a server restart between a stage and the next reply leaves a permanent receipt over words that no longer exist — a person sees what they added, and the agent never receives it. Before DOR-1307 this exposure was codex's and opencode's only; routing the default claude-code install through the same store inherited it wholesale. Making the hold durable is separate work, deliberately not smuggled into a routing fix.
- **Interrupt's receipt stays thin.** `ok` plus `cancelledQueued` tells the truth about the DorkOS queue and nothing about the runtime's, so the client says "stop requested". That gap is scheduled, not accidental, but it is a real gap for anybody reading the API today.

## Alternatives Considered

**Three explicit required runtime verbs: `enqueueMessage` / `steer(turnId, content)` / `interrupt`** (ideation D1 option b). Rejected for two reasons. It is more required surface for every future runtime author — three methods to implement and get right instead of one optional one — which is exactly the tax that makes adding a runtime expensive. And it puts the common case on the wrong side of the boundary: `enqueueMessage` would be a required adapter method for the one disposition **no adapter implements at all**, because the server owns the queue. A contract that makes the always-available path look like adapter work teaches every reader the wrong model of who owns what. Codex's `expectedTurnId` requirement, the strongest argument for an explicit `steer(turnId, …)`, is served by the server-minted correlation id and stays adapter-internal.

**Building on the SDK's `priority: 'now' | 'next' | 'later'`.** Rejected for the same reason ADR-b gives for not reading `priority` in the pump, and it applies with more force here. Even at `@anthropic-ai/claude-agent-sdk@0.3.224` the field carries **no prose documentation**; its scheduling would have to be inferred from three words and whatever can be read out of a bundled binary. A disposition contract is a promise to the person about where their words go, and inferring that promise from an undocumented enum is not a promise anybody should make. Steering instead rides `streamInput`, whose behavior _is_ documented — a smaller mechanism we can actually explain.

## Non-Goals

**This ADR does not widen `interruptQuery`.** The typed interrupt receipt and `cancel_queued` belong to `runtime-interrupt-receipts` (spec §D7); this decision consumes whatever that spec lands and deliberately does not redefine it.

**It does not make every runtime steerable.** Capability is declared, never assumed, in the same per-runtime-degradation stance as ADR-0310 and ADR-b. A runtime becomes steerable when its adapter can honestly say so, and the ladder is what makes the interval safe.
