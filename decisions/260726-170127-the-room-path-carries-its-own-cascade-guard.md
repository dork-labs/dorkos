---
id: 260726-170127
title: The room path carries its own cascade guard, not the relay's budget envelope
status: accepted
created: 2026-07-26
spec: rooms
superseded-by: null
---

# 260726-170127. The room path carries its own cascade guard, not the relay's budget envelope

## Status

Accepted.

## Context

Once two agents share a room and both can see each other's posts, agent A's reply can trigger agent B, whose reply triggers A. Nothing about the room stops that, and every iteration costs a real model call.

DorkOS already has a guard for this shape. Relay envelopes carry `hopCount`, `maxHops`, `ancestorChain` and `ttl`, and `enforceBudget` applies them. The review exchange initially assigned the room's cascade problem to that machinery on the grounds that it was already shipped. Checking it falsified the assignment:

```
$ git grep -n "enforceBudget" -- packages apps | grep -v __tests__
packages/relay/src/delivery-pipeline.ts:149:    const budgetResult = enforceBudget(envelope, endpoint.subject);
packages/relay/src/relay-publish.ts:305:    const gate = enforceBudget(envelope, subject);

$ git grep -rn "sendMessageRelay\|relayPublish" -- apps/server/src/services/session
(no output)
```

Two call sites, both inside `packages/relay`. Nothing in `services/session` constructs an envelope, and `contributing/architecture.md` states the split directly: `sendMessageRelay` is for external adapter integration, while the web client uses `postMessage` plus the durable session event stream. **The budget envelope is a property of the relay transport, not of the session spine.** A room built on the durable event log (ADR 260726-170125) inherits none of it.

So the guard is absent on the room path. This is a task, not an open question.

## Decision

We will give the room path **its own cascade guard**, carried on the room's trigger records, rather than routing room→agent triggering through the relay to inherit the envelope.

The alternative was live and is rejected on volume. Relay delivery is per-endpoint file writes plus one watcher per endpoint; the multi-user research already rejected that fan-out for community chat on exactly those grounds (decision 4), and this repo has felt the consequence — orphaned watcher trees have produced `EMFILE` across unrelated test suites. Putting the relay on the hot path of every intra-room trigger would re-add the write amplification we decided against, to buy a guard that is thirty lines of arithmetic.

A room trigger carries a provenance chain — a depth, the id of the root turn that started the cascade, and the ordered set of authors already in it. Two rules apply, and the second is the load-bearing one:

1. **Depth.** A turn triggered by a human post starts at depth 0; a turn triggered by another member's post inherits depth + 1. Refuse past a configured ceiling.
2. **Ancestry.** Refuse when the target author already appears in this cascade's chain. This kills A→B→A at the first repeat rather than letting it run to the depth limit, and it is what actually bounds ping-pong — a pure depth counter permits N-1 wasted model calls before it fires.

**A refused trigger lands a durable room-log entry.** A silently dropped trigger is indistinguishable from a broken agent, and in a shared room the person who notices is not the person who configured it. The entry says what happened in the room's own voice — the automatic-reply limit was reached — not a stack trace.

This is knowingly a second implementation of a concept the relay already has. We are not unifying them now because the relay's version is coupled to its endpoint/subject addressing, and hoisting it would mean reshaping a shipped, working delivery pipeline to serve a path that does not exist yet. The condition for revisiting is a third caller: if anything beyond the relay and the room path needs cascade bounding, the shared abstraction has earned itself and should be extracted then.

## Consequences

### Positive

- Runaway agent-to-agent loops are bounded before rooms ship, rather than discovered by a bill.
- The ancestry rule bounds ping-pong at the first repeat, which a depth counter alone does not.
- Room fan-out stays off the relay, so rooms do not inherit per-endpoint file writes or per-endpoint watchers.
- The guard is visible. A member sees why an agent stopped replying instead of watching it appear broken.

### Negative

- **Two implementations of one idea.** Someone will fix a cascade bug in one and not the other. The extraction condition above is written down precisely because that is the predictable failure.
- The ancestry rule is deliberately conservative and will produce false refusals: a room where A genuinely should answer B twice in one cascade hits the guard on the second pass. The ceiling is configurable, but the default will be wrong for somebody.
- Provenance has to be threaded through every path that can trigger a turn from a room post. A path that forgets to carry it is unguarded and looks fine in tests, because the guard's absence is only visible under a cascade.
- The refusal entry is a new durable log entry type that exists to describe an absence, which is a small but permanent widening of the room log's vocabulary.
