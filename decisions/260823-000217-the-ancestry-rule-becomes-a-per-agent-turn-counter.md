---
id: 260823-000217
title: The cascade guard's ancestry rule becomes a per-agent turn counter
status: accepted
created: 2026-08-23
spec: null
superseded-by: null
amends: 260726-170127
---

# 260823-000217. The cascade guard's ancestry rule becomes a per-agent turn counter

## Status

Accepted. Amends ADR 260726-170127, which stands in every other respect. Verified in code: `apps/server/src/services/rooms/cascade-guard.ts` carries `turnsByAuthor`, the `'repeat'` refusal reason, and `maxTurnsPerAgentPerCascade`; `RoomStore.turnsByAuthorInCascade` implements the `dispatch_id`-based turn count from the DOR-1434 amendment.

## Context

ADR 260726-170127 gave the room path two rules. Depth counts the whole chain; ancestry refuses a target that already appears anywhere in the cascade. It called ancestry "the load-bearing one" because a pure depth counter permits N-1 wasted model calls before it fires, and ancestry kills A→B→A at the first repeat.

It is load-bearing, and it is also **one turn per agent per conversation, ever**. That ceiling was chosen before anybody had watched two agents work through a real question in a room. They cannot do it in a sentence each: the first hop is usually agreeing what the question is. So the rule fired constantly on exchanges the person had asked for, and every firing wrote a notice saying the back-and-forth had hit its automatic-reply limit — copy that reads as a fault when what actually happened is that the product refused to let a conversation begin.

That ADR predicted this exactly, in its own Negative consequences: _"the ancestry rule is deliberately conservative and will produce false refusals: a room where A genuinely should answer B twice in one cascade hits the guard on the second pass."_ It was accepted as a trade at the time. It has been paid, and the price is higher than the thing it bought.

The rule's own reasoning contains the fix. Ancestry is a counter with its ceiling hardcoded at 1.

## Decision

**The ancestry rule becomes a counter.** `CascadeProvenance` carries `turnsByAuthor: ReadonlyMap<string, number>` instead of a distinct-author set, and `evaluateCascade` refuses when the target's count is at or above `rooms.maxTurnsPerAgentPerCascade` (new; int 1–100, default 10). The refusal reason `'ancestry'` is renamed `'repeat'`, and with it the observability reason `cascade_ancestry` → `cascade_repeat`.

Everything about the rule's standing is unchanged, and that is the point of writing this down:

- **It is still a mechanism, never a prompt.** `room-participation` I2 forbids moving an item from the mechanism list to the conduct list without arguing it as a downgrade. Nothing moves here. The bound is still arithmetic in `cascade-guard.ts`, still evaluated per trigger, still invisible to the agents it bounds.
- **It still fires below the depth ceiling**, which is what makes it worth having beside depth: at ten turns each, two agents stop at twenty hops in a chain the depth rule would allow thirty of.
- **A person's message still starts the count over.** `deriveCascade` is untouched — a human post mints its own root at depth 0, and an agent posting with nothing behind it is still stamped AT the ceiling so that anything it addresses is refused by depth.
- ~~**The unit is a message, not a turn.**~~ **Superseded — see the amendment below (DOR-1434); the unit is now a turn.** The original text, kept for the record: _The count is `COUNT(*)` over the agent's entries in the cascade, so a turn that posts several times through the rooms tool spends several of its ten. That is the honest reading of what the row count means, it is inherited from the ancestry set this replaces (which had the same scope, at a ceiling of one), and it errs toward stopping a noisy agent sooner. A dispatch-scoped count is a follow-up, not a silent re-interpretation of this number._
- **The query is still one indexed read.** `SELECT DISTINCT author_id … WHERE room_id = ? AND cascade_root = ?` becomes `SELECT author_id, COUNT(*) … GROUP BY author_id` over the same `idx_room_entries_cascade_root`. (The `COUNT(*)` here is superseded by the amendment below; the read is still one, and still over that index.)

The re-ask on held batches (`chooseTrigger`) matters MORE under a counter than it did under ancestry, because the count moves while a batch waits, and a verdict taken when the batch opened would be measured against a cascade that has since grown. It stays, per message, newest first.

`maxTurnsPerAgentPerCascade` is operator-only, like every other room bound: an agent that can raise its own allowance is an agent voting itself more turns in the conversation it is already in.

## Consequences

### Positive

- A room can hold an exchange. Two agents get ten turns each per message instead of one, which is the difference between a conversation and an interjection.
- The mechanism is now legible as what it always was — a counter — and its ceiling is a number a person can move rather than a constant in a branch.
- The false refusals the original ADR accepted mostly disappear, and with them the notices that described normal work as a limit being hit.

### Negative

- **The rule is weaker per hop.** Ping-pong now costs up to N turns per agent before it stops, where it used to cost one. That is spend, deliberately bought, and it lands on the hourly caps — which is why those were raised in the same change and argued separately in ADR 260823-000218.
- A count is a slightly costlier read than a distinct set on a very hot cascade. Same index, same row set, one aggregation; measured as unremarkable beside the model turn it precedes.
- Historical entries stamped at the OLD depth ceiling (3) are below the new one (30), so a cold cascade from before this change is re-triggerable one more hop if somebody posts into it. Harmless, and pinned by the guard tests rather than left to be discovered.

## Amendment, 2026-08-23 — the unit is a turn (DOR-1434)

The Decision bullet above headed "**The unit is a message, not a turn**" is superseded. It named a dispatch-scoped count as a follow-up rather than a silent re-interpretation, and this is that follow-up, taken deliberately and in the open.

The rest of that bullet was right about what `COUNT(*)` meant and wrong about it erring safely. It errs against the agents that behave best. An agent that says "looking at the migration" before it answers spends two of its ten for one model call; an agent that answers in one line spends one. The number a person sets is meant to bound how much of a conversation one agent may take, and under row counting it bounded how legible that agent was willing to be — which is a tax on the exact behaviour `.claude/rules/room-conduct.md` asks for.

**What changes.** `room_entries` gains a nullable `dispatch_id`, stamped with the dispatcher's correlation id on every entry a turn writes **into the room that triggered it**: the answer the dispatcher delivers, and the mid-turn posts the agent makes there through the rooms tool — including an aside turn's `post_to_room` writes, since an aside is unambiguously a turn even though it has no cascade to hand on. `RoomStore.turnsByAuthorInCascade` becomes `COUNT(DISTINCT dispatch_id) + SUM(dispatch_id IS NULL)` over the same `idx_room_entries_cascade_root` read — one turn counts once however many entries it wrote.

Two writes that look like they should be stamped and are not, because no turn is running when they happen. **The welcome-back greeter's own writes** — the status line it posts before `askAside` is called, and the offer it posts after that turn's claim has already been released — carry null. They are the greeter speaking on an agent's behalf, not a turn writing, and each is its own cascade root, so the null costs nothing. **A cross-room `post_to_room`** carries null too: the stamp is found by the claim on the room the entry lands in, and an agent mid-turn in room A that posts a note into room B holds no claim in B. That note therefore counts as one message against its author in B — accepted, and arguably correct: it is not part of any turn B asked for, and B's budget is the one it spends.

**What does not change.** `evaluateCascade` is untouched: it takes counts and refuses at the ceiling, and it never knew what a count was made of. The rule is still a mechanism and never a prompt, still fires below the depth ceiling, still resets on a person's message, and is still operator-only. `chooseTrigger`'s re-ask on held batches matters for exactly the reason written above — the count still moves while a batch waits, it now moves a turn at a time.

**Null counts one, on purpose.** A person's post, an agent post with no trigger behind it (already stamped at the depth ceiling, so its cascade is spent regardless), and every row written before the column existed all carry null and cost one each. That is precisely what they cost under row counting, so an existing install is not re-interpreted by an upgrade — the new unit applies to turns taken from here on.

**The rule is weaker per hop again, and by less than it looks.** A ping-pong still costs at most N turns per agent, and a turn is one model call, which is the thing being bounded. What is no longer counted is the extra rows one call writes, which never cost anything to run.
