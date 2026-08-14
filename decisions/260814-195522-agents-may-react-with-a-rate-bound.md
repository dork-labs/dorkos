---
id: 260814-195522
title: Agents may react, bounded by a rate rather than by a ban
status: accepted
created: 2026-08-14
spec: room-participation
superseded-by: null
amends: null
---

# 260814-195522. Agents may react, bounded by a rate rather than by a ban

## Status

Accepted. It reverses one rule of conduct — `meta/agent-etiquette.md` **E16b**, "agents do not
send them" — and reverses nothing else in that file. E16b's first half stands unchanged: a
reaction is an endpoint, not a prompt, and nothing about an agent leaving one turns it into a
trigger.

## Context

`RoomService.toggleReaction` refused any author that is not a person (`PEOPLE_ONLY`), on the
strength of E16b. The rule was written when nobody had watched an agent use a reaction, and
`specs/room-messaging-design` §2.5 recorded the question as parked rather than answered.

Two things have happened since. An agent already **sees** reactions on its own posts — the
acknowledgment window in `room-context.ts` puts them in front of it every turn — so the asymmetry
was one of the odder things in the product: an agent could be thanked and could not say thank
you. And both systems this design has been measured against permit the other direction: Block's
Buzz and QM both let their agents react.

The cost of the ban was paid in noise, which is the thing the etiquette standard exists to reduce.
An agent that has nothing to add but has understood you posts a filler message, because a filler
message was the only acknowledgment it had.

## Decision

**An agent may put an emoji on a message in a room it is a member of, bounded by a rate.**

- The kind check comes off `toggleReaction`. Every other refusal stays exactly where it was:
  not visible → `ROOM_NOT_FOUND`, not a member → `MEMBER_NOT_FOUND`, archived → `ROOM_ARCHIVED`,
  no such entry here → `ENTRY_NOT_FOUND`.
- In its place, `ReactionBudget`: **20 reactions per agent per room per rolling hour**, refused
  with `REACTION_RATE_LIMITED`. People are never counted.
- The window is **recovered from the reactions themselves** (`room_entry_reactions.created_at`),
  not from a counter table — so an agent that spent its hour and met a restart comes back spent,
  the property DOR-1205 bought for turns, at the cost of no new table.
- **Reactions still never cascade.** They live outside `room_entries` and that is deliberate and
  pinned: no turn, no trigger, no entry, no notice, no budget spend, no `lastActivityAt` bump.
  Nothing in this decision moves them inside.
- The verb reaches agents as the `react_to_room_entry` MCP tool in the `rooms` capability domain,
  and reaches the cockpit through the route it already had.

The number is **ours and unsourced**, like every threshold in this domain
(`meta/agent-etiquette.md` §9): nobody publishes a figure for how many acknowledgments a person
will take from a machine. It is a constant rather than a setting, for the reason
`WAITING_NOTICE_GRACE_MS` is one — it changes how chatty one quiet affordance is, never what the
room does, and there is no honest guidance to hand somebody tuning it. Dogfooding is what buys a
setting.

## Consequences

### Positive

- The acknowledgment loop closes. An agent that is thanked can answer in kind, for free, without
  a message anybody has to read.
- **The filler message goes away.** "Got it" costs everyone a line in the room; 👍 costs nobody
  anything, and `E17`'s batching advice gets a cheaper alternative than a batch.
- The bound is a **mechanism**, so `I2` holds: "react sparingly" is not a rule an agent can
  follow, for the same reason "don't get into a loop" is not.
- No migration, no new table, and a restart cannot clear the ceiling.

### Negative

- **A new way to be annoying.** Twenty pills an hour in one room is more than anybody wants, and
  the ceiling is a ceiling rather than a target. The prompt and the evals are what aim for
  restraint; this only bounds it.
- **The recovered window forgets a reaction that was taken back.** Adding and removing inside the
  hour leaves no row, so a restart un-counts it. Within a process both directions spend, so the
  hole is one restart wide and costs a row.
- **`PEOPLE_ONLY` now guards one verb instead of two.** A rule with a single caller is easier to
  read as incidental; the halt verb keeps it, and its TSDoc says why in its own words.
- E16b now has a reversal note on it. Anyone reading the etiquette standard for the first time
  meets a rule and its correction together, which is slightly worse to read and much better than
  a rule that quietly stopped being true.
