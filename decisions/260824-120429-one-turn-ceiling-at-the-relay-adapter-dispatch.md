---
id: 260824-120429
title: One turn ceiling at the relay adapter dispatch, not one per surface
status: accepted
created: 2026-08-24
spec: null
superseded-by: null
amends: null
---

# 260824-120429. One turn ceiling at the relay adapter dispatch, not one per surface

## Status

Accepted. Shipped in the relay turn-ceiling work (DOR-791).

## Context

Rooms have two bounds on what automatic replies can cost: a cascade guard that reads who wrote the triggering message, and a pair of hourly turn ceilings that read nothing at all (ADR 260726-170127, ADR 260823-000218). The message bus has neither.

What Relay has instead is the **budget envelope** — hops, TTL, a call budget — spent at the publish gate. It bounds one chain of messages, honestly and well. It does not bound anything else, because a chain is free to start:

- `relay-publish.ts` mints a **fresh full budget** for any publish that omits one. `relay_send`'s `budget` argument is optional and LLM-supplied, so two agents told to "keep each other posted" reset the hop counter on every lap. The only thing that eventually stopped them was a three-slot concurrency semaphore.
- The webhook adapter echoed its **hop count** back to a service that answers inbound, which closed the hop loop, and left the call budget and the TTL resetting every lap.
- An A2A peer sits behind a 60/min ingress cap with no ceiling behind it: 3,600 model turns an hour, indefinitely.

Four surfaces, no shared route, no shared principal, no shared limiter. The obvious repair — a limit per surface — is four implementations that must each be right, and silently misses the fifth surface somebody adds next year.

## Decision

**The turn ceiling lives at the publish pipeline's adapter-dispatch step, and it counts dispatches rather than callers.**

Three parts.

**1. One choke point, and it asks the adapter rather than the subject.** Every way of making an agent answer over the bus ends at the same line: an envelope is handed to the adapter and a real, paid turn begins. Which subjects those are is the adapter's fact, not the pipeline's — `RelayAdapter.startsAgentTurns` states it, and the Claude Code adapter answers yes for its two agent prefixes and for a task DISPATCH subject — and no for the subjects beneath one, which it skips rather than runs (`isTaskDispatchSubject`, DOR-1567). Answering that truthfully is why the ceiling never charges for a skipped delivery instead of charging and refunding it a moment later.

Deciding this from the subject is how the first cut of this shipped wrong: it matched `relay.agent.*` only, while the same adapter also answers for `relay.system.tasks.*` and routes that to `ensureSession` + `sendMessage`. `relay_send` will publish to that subject (`isReservedSubject` guards endpoint _registration_, not publishing), access control default-allows, and the tasks handler reads prompt, cwd and permission mode straight off the envelope — so the ceiling was bypassable by exactly the party it bounds. Asking the dispatch keeps the two facts in one place, so an adapter that grows another turn-running prefix cannot reopen the door by staying quiet.

**Scheduled runs therefore consume the ceiling.** They are paid turns; counting them is the honest reading, and 5,000 an hour leaves an ordinary schedule far more headroom than it uses.

**Two windows.** `RelayTurnCeiling` reserves at that dispatch against a per-target window and an install-wide window, both rolling one hour, both `null`-able to mean "no limit". It shares the rooms ceiling's shape and its defaults (1,000 per target, 5,000 across the install), because a person reasoning about "how much can my agents spend on their own" should not have to hold two different allowances in their head because the traffic took a different pipe. They are separate wallets, and that is the honest reading of two ceilings.

**A reservation whose dispatch never ran is given back.** The reserve happens before the hand-off, because that is what stops a burst from spending the last unit twice — but a refused capacity slot, a thrown adapter or an adapter lost mid-flight all dead-letter afterwards. Without a refund a busy install drains its whole allowance having run nothing, which is the same shape of bug as charging for an adapter-less subject and worse, because it happens to installs that are merely busy. The refund carries the reserve's own answer down to the settlement rather than re-deriving it: an adapter that declines to run turns is never charged, and a refund that guessed would give back a charge another dispatch made.

**The cap does not ask who is calling.** This is the same argument `rooms/limits/turn-budget.ts` makes at length: in the shipped posture (`auth.enabled` false) DorkOS cannot tell a program on this machine from the person at the keyboard, so a bound that reads identity can be sidestepped by asserting a different one. The ceiling reads the target subject and the clock.

**A refusal is visible on the surfaces relay already refuses on** — the warning log, a dead letter under the target subject (which is what fires the host's `onDeadLetter`, the Pulse badge and the dead-letters inbox), a `turn_ceiling` code on the publish result and its trace span, and the reply-failure notifier that settles a caller blocked in `relay_send_and_wait` or the A2A executor instead of leaving it to time out saying "timed out". No new channel was invented. What is refused is the **turn**, not the message: Maildir copies stand, so it is still in the agent's inbox to be read later.

**2. Inbound budgets thread server-side.** A turn the bus started now knows which envelope it is answering: the dispatching adapter binds it to the session key for the life of the turn (`InboundTurnBudgets`), and the `relay_send*` handlers read it back by the same key. So the outbound send continues the inbound budget, decremented, instead of minting a fresh one — the same reasoning `resolveSenderIdentity` applies to the publish `from`, and for the same reason: a budget the model may omit is one an accidental loop always omits, and a budget the model may write is not a bound.

A declared budget may only **shrink** an inherited one. Scheduled task runs bind the same way, under their run id.

**A turn killed by its own TTL keeps its binding, expired.** The iteration stopping is not proof the query stopped, and a late `relay_send` that inherited nothing would mint a fresh full budget — hop zero, ten calls, another hour — the chain escaping on exactly the deadline meant to end it. Inheriting a dead budget gets it refused at the publish gate as `ttl_expired` instead. Held entries are bounded by the registry's own LRU cap.

**`ancestorChain` is deliberately not inherited.** Carrying it would hand the gate's cycle detector a chain containing the peer that just wrote, so the very first reply back would be refused as a cycle and every agent-to-agent exchange would be exactly two messages long. Two messages is not a conversation, and ADR 260823-000218 already paid for that lesson: a bound "chosen to be obviously safe" stopped the exchanges people had asked for, and a bound that fires during ordinary work teaches people to switch bounds off. Chains are bounded by the hop ceiling, the call budget and the TTL, and above all of them by the turn ceiling, which no chain can restart its way out of.

**3. The webhook republish carries the whole budget.** Call budget and deadline join the hop counter on the wire (`X-Relay-Call-Budget`, `X-Relay-Expires-At`). Each is clamped against the package default — a request may lower its own allowance, never raise it — and the call budget is decremented for the lap that just happened, exactly as the hop counter already was.

## Consequences

### Positive

- The fifth surface is covered before it is written. Anything that makes an agent answer over the bus crosses this line.
- The two loops the 2026-07-31 review named are bounded: agent↔agent by inherited budgets plus the ceiling, webhook self-loop by a budget that now drains.
- A person is told which ceiling refused, so they are sent to the setting that matters rather than to a generic failure.
- The counter costs nothing on the hot path: two array filters and a push, no query, no write.

### Negative

- **The ceiling is not durable.** Rooms writes its window to `room_turn_spend` so an hour means an hour across a restart (DOR-1205). This one is in memory: relay has no spend table, and the table it could borrow (`relayIndex`) is a derived index that `rebuild()` recreates from Maildir, so a counter kept there would be erased by a routine repair. A restart hands the bus a fresh hour. It still bounds the case this exists for — two misconfigured agents inside one long-lived process — and a caller deliberately restarting the server to clear a counter already has a shell on the machine, which is DOR-505's problem. A durable window is the obvious follow-up and wants a table of its own.
- **Bill exposure is stated, not eliminated.** 5,000 turns an hour is real money, and the numbers are raisable. This is the same trade ADR 260823-000218 owns for rooms, made once more here.
- **A dead letter for a message that was also delivered to a mailbox reads oddly.** It is deliberate — the dead letter is the record that the TURN did not run — but somebody reading the DLQ will meet an envelope that is in two places.
- **There is no Settings control yet.** The refusal names the config path and `dorkos config set` is the way to change it; a panel beside the room limits is follow-up work.
- **Headroom is not reported anywhere.** `RelayTurnCeiling.remaining()` exists and answers the question `room_context.budget` answers for rooms, but nothing renders it yet.
- **Scheduled runs now spend an allowance they did not before.** An install with a heavy schedule and a lowered ceiling can find task runs competing with agent messages for the same hourly number. That is the honest accounting — they are the same turns on the same adapter — but it is a behaviour change for anybody who tunes the ceiling down.
- **A cross-runtime gap.** The inbound-budget binding is wired through the Claude Code adapter, which is the adapter that dispatches relay-triggered turns today. A future adapter that dispatches turns must bind too, AND declare `startsAgentTurns`. The declaration is optional in the type so adapters that spend nothing need no stub, and a silent adapter falls back to the two shipped prefixes — so a forgetful adapter on `relay.agent.*` or `relay.system.tasks.*` is still counted. A silent adapter answering for a prefix nobody has invented yet is not, and its turns are free; one that forgets to bind mints fresh chain budgets.
