---
id: 260819-034718
title: The relay holds a bridged chat message for a busy agent, and holds for nobody else
status: accepted
created: 2026-08-19
supersedes: null
superseded-by: null
amends: null
---

# 260819-034718. The relay holds a bridged chat message for a busy agent, and holds for nobody else

## Status

Proposed. Standalone. It follows the shape of
[260818-234541](260818-234541-a-busy-agents-message-is-held-not-refused.md) (a busy agent's message
is held, not refused) but amends nothing: that decision is about the room dispatcher's `agentPath`
ceiling, this one is about the relay adapter's concurrency semaphore, and neither's mechanism
touches the other.

## Context

The claude-code relay adapter runs at most `maxConcurrent` turns at once (default 3). Messages for
the **same** session were already held — `RuntimeAdapter.enqueueForSession` serializes them — but a
message for a **different** session that arrived with every slot taken was refused outright, and the
chat notice for it ended "Send it again in a moment."

That is the same refusal, in the same product, at a different ceiling: a person in a bridged Telegram
or Slack chat was asked to do scheduling work the machine could do. The room path reached the same
conclusion from the same evidence (`260818-234541`), and the session path before it
(`260811-184735`, "the honest answer was 'it will run next'").

What is genuinely different here is **who is on the other end**. A room trigger has one kind of
caller. `relay.agent.*` has four, and the publish pipeline detaches all of them: a bridged chat, an
agent-to-agent `relay_send`, `relay_send_and_wait` blocked on a reply inbox for 60 s, and the A2A
executor blocked for 120 s. Holding is only kind to the first.

## Decision

**We will hold a message for a busy agent, and only when a person in a bridged chat is the one
waiting.** The ceiling becomes a bounded FIFO waiting line (`capacity-hold.ts`); a delivery that
finds no slot waits, and the next slot to free runs it. The licence is
`requiresInitiateConsent(envelope.replyTo)` — the same predicate the chat notice itself applies —
so a message can never be parked where nobody could be told about it. The delivery pipeline grants
it by setting `AdapterContext.onHeld`, and is the only thing that does.

**Every other caller keeps the immediate refusal.** For a caller blocked on a reply inbox, a hold
longer than its own deadline does not delay its reply, it destroys it: the caller times out saying
"timed out" where the truth was capacity, tears down its inbox, and the turn still runs afterwards
into a reader who has given up — with a retry running the same turn twice. A fast, machine-readable
`at_capacity` is the kind answer for a caller that can act on one.

**We will bound the hold with durations that already exist, and add no setting.** A hold waits at
most `min(defaultTimeoutMs, remaining envelope TTL)`; the line holds ten waiters per slot; a hold is
announced to the chat only after ten seconds (`HOLD_ANNOUNCE_AFTER_MS`, the room lane's own floor —
a hold that clears in eight seconds is not a story). The TTL half is not a nicety: `handleAgentMessage`
falls back to a fresh `defaultTimeoutMs` when nothing is left, so a wait that ate the envelope's
lifetime would start the turn as if it had just arrived.

**We will promise, in the chat, only what the code keeps.** The held line says the message is waiting
and nothing more. It deliberately does not say when the turn will run, because the hold's ceiling is
**not** the ceiling on the turn in its way — that turn runs to its own envelope's TTL, an hour by
default, so a hold can expire while the agent is still legitimately busy. When it does, `agent_busy`
says so and names the resend, which by then is true help rather than the refusal this work removed.

## Consequences

### Positive

- **A person in a chat is never asked to resend before the machine has tried.** The only sentence in
  this path that did is gone.
- **The release seam is total, so the promise is mechanical.** `deliver()` releases its slot in a
  `finally`, so a turn that answered, threw, timed out or was stopped all re-arm the line.
- **The licence and the ability to explain are one decision.** Using the chat notice's own predicate
  means a new caller cannot accidentally inherit a hold it cannot be told about.
- **No new configuration, no migration, no runtime work.** Every bound is a duration the adapter or
  the envelope already carried.

### Negative

- **A hold does not survive the process.** `CapacityHold.drain()` settles every waiter on an adapter
  stop, so an adapter restart reports each held message rather than hanging. A whole-server stop
  tears down the bus and the chat adapters first (`RelayCore.close()` closes subscriptions before
  `adapterRegistry.shutdown()`), so nothing is delivered and the message is dropped in silence. The
  docs guide says so; nothing in the chat does, because by then there is no chat to say it in.
- **A hold can end while the agent is still busy**, because its ceiling is not the blocking turn's.
  The person then reads "not picked up" about an agent that is visibly working. Bounding by the real
  ceiling would mean tracking every running turn's deadline, which the adapter does not do today.
- **The binding's paused / receive-denied state is not re-asked across the park.** A chat paused
  while its message waits still gets that turn. It is the same window an in-flight turn has always
  had, and closing it would give `adapter-delivery.ts` a binding store it has deliberately never had.
- **An agent-to-agent send is still refused at capacity**, so the fleet's own traffic gets no benefit
  from this. That is the cost of the licence being narrow, and it is the right side to err on.

## Alternatives considered

- **Hold every detached delivery.** What the first cut did. Rejected once the awaited-caller analysis
  landed: it converts an actionable refusal into a timeout and burns a model turn.
- **Decide the licence from the subject inside the adapter.** Rejected: it puts the same rule in two
  modules, where a change to one silently breaks the other.
- **Bound the hold by the blocking turn's real ceiling.** Rejected for now as more machinery than the
  problem needs; the honest notice costs nothing and is provably true.

## References

- `packages/relay/src/adapters/claude-code/capacity-hold.ts`, `claude-code-adapter.ts`,
  `adapter-delivery.ts`, `chat-notice.ts`
- ADR `260818-234541` (rooms, the same shape at a different ceiling), `260811-184735` (the session
  path's precedent), `260816-143752` (every downgrade is reported)
- `docs/guides/relay-messaging.mdx`, `contributing/adapter-catalog.md`
- DOR-1362
