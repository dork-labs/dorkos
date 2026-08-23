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

## What the guard does not cover, and what does

Two limits, both found by building it (DOR-526) and both worth stating here
rather than in a comment somebody will move.

**The rules read caller-asserted identity, and in the default posture that is
weak.** Rule 1 keys the fresh start on the author being a human, because a
person re-engaging a stopped room is the behaviour we want. `resolveCaller`
answers "is this a human" by looking for an `X-DorkOS-Agent` header, and
`sessionGate` is a pass-through while `auth.enabled` is off — which is the
default. So a program on the machine omits a header and _is_ the human author:
measured at 30 posts, 30 distinct cascade roots, 60 turns, max depth 0, no
refusal notice. This is the documented DOR-505 residual (`lib/caller-authority.ts`
names the same move) and it is not closable from the room path: with login off
there is genuinely nothing left to tell a local program from the person.

Because of that, the room path also carries a **posture-independent budget**
(`turn-budget.ts`), counted without reference to who is calling and refusing with
its own `budget_reached` notice. It has two ceilings, and the distinction is
load-bearing:

- **Per room** bounds what any one room can cost. It is not a spend bound on its
  own, because rooms are free: measured through the real mount, a cap of 2/room
  bought 16 turns across 8 channels, and threads were cheaper still at 12 across
  5 (a thread inherits the parent's whole roster). That is not a defect in the
  cap; it is the difference between bounding a room and bounding a wallet.
- **Global** bounds what the whole install can cost, whatever number of rooms or
  threads exist. This is the one that makes "the ceiling on what this can cost
  you" true. The per-room cap stays because it is what keeps one runaway room
  from eating the entire global allowance and starving every other room.

The division from the cascade guard is equally deliberate — its two rules are
the precise instrument that keeps a healthy room from wasting calls, and the
budget is the blunt one that bounds a dishonest caller. Neither is redundant, and
deleting either on the grounds that the other exists reopens a case the other
never covered.

Both budget windows were in-memory and reset on restart. For an accidental loop
that costs nothing; for a deliberate caller it was a real limit, since
`POST /api/admin/restart` sits behind the same pass-through gate and is
rate-limited to 3 per 5 minutes — roughly 36 clearances an hour. **That residual
is closed; see the amendment at the end of this section.**

### Why that residual was acceptable, and what actually closes it

_Written while the residual was open, and kept because the reasoning still
decides things — the amendment below says what changed and what did not._

The durable counter that would close it is a follow-up, and the reason is
stronger than "the prose is now accurate".

**A caller who can omit the header already has a shell on this machine, and a
shell can spend the model budget directly.** It can run `claude` in a loop
without going near a room. The rooms path therefore adds no capability that
attacker does not already have, and hardening the room's counter against them is
hardening one door in a building whose walls are the actual boundary. Spending
the hot path of every turn on a durable write to slow down an attacker who has
already won is a poor trade.

What the guard genuinely buys — and this is worth having entirely on its own — is
a bound on **accidental** loops between well-behaved agents. Two `always` agents
in one room is a configuration a reasonable person reaches on purpose, and the
cost of it running unbounded is a real bill for no work. That is the common case,
it involves no attacker, and the guard's two rules plus the budget bound it
completely.

So the honest framing is: the budget is defence in depth against an adversary who
is already inside, and a complete answer to the accident it was built for. **The
actual fix for the adversary is login being enabled** — that is what restores the
identity distinction every caller-asserted rule here depends on. A durable
counter is worth adding when it is cheap, not because it closes this.

An earlier draft of this section named DOR-505 as that fix. DOR-505 has since
shipped and **the residual is still open**, so the citation would now mislead
anyone who checked the issue and stopped there. DOR-505 closed the
header-stripping hole on operator-only _config writes_, by way of a cookie that
only exists once login is on; `lib/caller-authority.ts` says so in its own module
doc — `requireOperatorCookieUnderLogin` "with login off it allows, because there
is no cookie for anyone to present." That allow is the same one the room path
inherits. The dependency is the posture, not the ticket.

### Amendment (2026-08-14, DOR-1205): the windows are durable

Both budget windows now survive a restart. Each turn that actually runs is
written to `room_turn_spend` (migration 0067) and the current hour is read back
when `RoomTurnBudget` is constructed, so an hour means an hour of wall clock
rather than an hour of uptime, and the ~36 clearances an hour above are no longer
reachable.

**Everything the section above argues still holds; only its factual claim
changed.** Durability is not what makes the ceiling trustworthy against an
adversary — a caller who can omit the header already has a shell on this machine
and can spend the model budget directly, so this hardens one door in a building
whose walls are elsewhere, and the posture (login on) is still the actual fix.
The reason it was worth doing anyway is the cheapness the section reserved
judgement on: the durable write turned out to cost one INSERT and one indexed
DELETE per turn ACTUALLY RUN, on the path of a turn already about to spend
seconds of model time, and **nothing on the read path at all** — the in-memory
windows remain the whole decision and the table is read exactly once per process.
"A durable counter is worth adding when it is cheap" was the standing condition,
and it was met.

What the durable version buys is for the accident, not the adversary, which is
the case this whole section says the budget is really for: two `always` agents
looping do not stop being misconfigured because the server restarted, and before
this their hour reset every time somebody bounced the process.

Three properties of the implementation are load-bearing and should not be
"simplified" away. Rows are individual timestamps rather than per-hour buckets,
because the window ROLLS and a bucket resets on a boundary. The prune rides the
write (`at <= floor`), so the table holds at most the last hour and is a counter,
never a spend history. And hydration bounds the window at BOTH ends — a row
stamped in the future, which a backwards clock jump can leave behind, is ignored
rather than counted, because only the lower bound is self-healing.

**Cross-room cascades carry their depth but not their per-author count.** An
agent mid-turn in room A that posts into room B inherits A's `cascadeRoot` at
its current depth (the turn's provenance follows the agent, not the room), so
B's members trigger one deeper and A's ceiling still bounds the chain. Rule 2
does not carry: the provenance query is scoped `(room_id, cascade_root)`, so the
same author gets a fresh allowance in each room within one cascade. That is
defensible — depth is doing the bounding, and per-room scoping is what keeps the
query on an index — but it means rule 2 is a within-room guarantee only. (Read
under the amendment below: that query was `authorsInCascade`, a distinct-author
set, and is now `turnsByAuthorInCascade`, a count. The scoping is unchanged and
so is this consequence.)

### Amendment (2026-08-23, DOR-1428): rule 2 is a counter, and the numbers moved

Rule 2 above is now a per-agent turn counter rather than an ancestry set: a
target is refused once it has already taken `rooms.maxTurnsPerAgentPerCascade`
turns in this cascade (default 10), instead of at its first repeat. The refusal
reason is `'repeat'`. Everything this ADR argues about rule 2 still holds — it is
still a mechanism rather than a prompt, still fires below the depth ceiling, and
a person's own message still starts the count over — and the Negative consequence
this ADR predicted ("will produce false refusals") is what forced the change. See
ADR 260823-000217.

The four shipped numbers also moved, in the loosening direction, for new and
existing installs; and a person may now turn every automatic-reply limit off
(`rooms.turnLimitsEnabled`), which is a state with no automatic brake at all.
That trade is argued in ADR 260823-000218, not here.

## Consequences

### Positive

- Runaway agent-to-agent loops are bounded before rooms ship, rather than discovered by a bill.
- Rule 2 bounds ping-pong per agent, which a depth counter alone does not: it fires on the agent that keeps answering, well below a ceiling counting the whole chain. As shipped it fired at the first repeat; since the amendment above it fires at `rooms.maxTurnsPerAgentPerCascade`.
- Room fan-out stays off the relay, so rooms do not inherit per-endpoint file writes or per-endpoint watchers.
- The guard is visible. A member sees why an agent stopped replying instead of watching it appear broken.

### Negative

- **Two implementations of one idea.** Someone will fix a cascade bug in one and not the other. The extraction condition above is written down precisely because that is the predictable failure.
- Rule 2 as shipped was deliberately conservative and produced false refusals: a room where A genuinely should answer B twice in one cascade hit the guard on the second pass. **This is the consequence that came true**, and it is what the amendment above answers — the rule is now a counter with a configurable ceiling. The second half of the sentence survives the fix: the default will still be wrong for somebody.
- Provenance has to be threaded through every path that can trigger a turn from a room post. A path that forgets to carry it is unguarded and looks fine in tests, because the guard's absence is only visible under a cascade.
- The refusal entry is a new durable log entry type that exists to describe an absence, which is a small but permanent widening of the room log's vocabulary.
- **Two bounds, not one.** The budget above is a second mechanism with its own config field, its own notice code and its own tests, and a reader meeting either one alone will reasonably wonder why the other exists. The section above is the answer; keep it accurate if either changes.
