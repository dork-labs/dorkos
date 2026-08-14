---
id: 260814-025326
title: Agents may open rooms with each other, and the person is always in them
status: accepted
created: 2026-08-13
spec: room-participation
supersedes: null
amends: null
superseded-by: null
---

# 260814-025326. Agents may open rooms with each other, and the person is always in them

## Status

Accepted — implemented for DOR-1208 in `apps/server/src/services/rooms/`.

## Context

`RoomService.requireSeedingAllowed` refused **any** room a non-owner opened that held an agent other than the caller. An agent could open a room for itself and talk to its operator, and nothing more. The reasoning was sound as far as it went: `/api/rooms` is reachable by any member, and a caller able to assemble a roster of somebody else's agents could build a room whose members answer each other — model quota spent, with the server process's filesystem access, without the person ever asking.

The cost of that refusal is the product. **Intelligence doesn't scale; coordination does** — and two agents that cannot be in a room together cannot divide a piece of work between them. Everything the multi-agent story promises starts with one agent being able to say "let me pull Bo into this."

The operator's call (Dorian, 2026-08-13) was to allow it with one condition: **never invisibly. The human is always in the room.**

Two things had to be settled to make that safe.

**The first is that a rule checked only at creation is not a rule.** Membership is mutable. A room that satisfied a create-time gate can be walked into the forbidden shape one call later — add the second agent to a room the owner already left, or leave a room after two agents are in it. Any check that lives only in `createRoom` is theatre.

**The second is what relaxing the rule would actually let loose.** A DM needs no `@`: whatever a person types there is addressed to whoever is on the other side, which is why `direct-only` answers everything in one and why the DM seed is the agent's `always` manifest default. That is a claim about a person talking to their agent, and it does not survive a second agent joining. Measured on the shipped code, in the operator's DM with Ana, adding Bo produced this from one "hello":

```
post    hello                      (the person)
post    Ana's answer               → triggers Bo
notice  "bo is still working on an earlier message here…"
post    Bo's answer                → triggers Ana
notice  "ana stopped replying here — this back-and-forth hit its automatic-reply limit."
```

Four turns and two apologies for one message, with nobody's setting changed. The cascade guard did its job — it stopped the loop — but stopping a loop is not the same as not starting one, and every one of those lines is the over-participation `meta/agent-etiquette.md` exists to damp. This is Buzz's lesson in our own code: **a membership change quietly widened who can trigger an agent, and no policy field moved, so no policy check could have caught it.**

## Decision

### 1. The three-way rule

**A room that holds two or more agents holds the owner too.**

An agent may open a room of any kind with another agent, provided the owner is on its roster. The invariant is then held at every verb that can change a roster:

| Verb           | What it refuses                                               | Code                    |
| -------------- | ------------------------------------------------------------- | ----------------------- |
| `createRoom`   | a non-owner seeding an agent that is not itself, owner absent | `OPERATOR_ONLY` (403)   |
| `addMember`    | an agent that would make two, in a room the owner is not on   | `OWNER_MUST_BE_PRESENT` |
| `removeMember` | taking the OWNER out of a room two agents share               | `OWNER_MUST_BE_PRESENT` |

Four things about the shape of that rule:

- **It is compositional, not provenance-based.** Nothing records who opened a room — `rooms` has no `created_by` column — and adding one would buy a weaker rule: "an agent-seeded pair needs a witness" leaves a pair the owner seeded and then walked out of just as invisible. Asking the roster needs no column and covers both.
- **`removeMember` refuses the owner herself**, which is the point rather than an oversight. Both membership verbs are already operator-only, so the owner is the only caller they can ever refuse. A guarantee whose escape hatch is "leave afterwards" is not a guarantee. The way out is not blocked, only reordered: take an agent out first, or archive the room (spec §12.4 — there is no delete, and no Leave).
- **Only an AGENT gets the escape.** A second person — a member account with login on — still may not put any agent in any room, owner present or not. An agent seeding a colleague is doing the job it was installed to do; a guest doing it is spending an account that is not theirs, and the owner's membership would make that visible without making it consented. Nothing asked for the second, so nothing grants it.
- **A new error code**, because it is a different fact. `OPERATOR_ONLY` means "you are not the person who may do this"; `OWNER_MUST_BE_PRESENT` means "this is not a shape a room may be in", and its caller is always the right person.

### 2. Outside a channel, implicit addressing belongs to a person's message

**A post an AGENT writes in a DM triggers only the members it names.** A person's post is unchanged: it still reaches every member whose mode answers, no `@` required. Channels are untouched entirely.

This is the same idea `standDownFallbackSeat` already applies to the fallback seat — a post an agent wrote is a conversation already underway, not a question aimed at the room — and it is not arbitration (ADR `260726-170125` stands): it never chooses between two agents that were addressed, and it never silences one that was named. `@bo` reaches Bo in a DM exactly as it does in a channel.

With it, the sequence above costs two turns and writes no notices, and — the property that matters — **adding a member to a DM no longer changes who can trigger the members already in it.**

### 3. An unrecognized room kind takes the narrower branch

`RoomKindSchema` is a closed `z.enum(['channel', 'dm'])` at every request boundary, so no caller can ask for a third kind. Storage is a different question: `rooms.kind` is a `text` column, and `toRoom` narrows it with an unchecked cast (`room-rows.ts`). The type is a claim about callers, not a guarantee about rows.

So the branches that decide how permissively an agent may answer are written as a **positive test for the looser side**, and every room-kind branch in the server was audited against that rule:

- The new restraint is spelled `roomKind !== 'channel'`, so an unrecognized kind is restrained rather than treated as a channel.
- `seedResponseMode` already reads `kind === 'channel' ? engaged : manifest default`, so an unrecognized kind takes the DM seed. That seed is `always`, which was the looser answer before this ADR and is bounded by the restraint after it.
- `respondsTo`'s `direct-only` case reads `=== 'dm'`, so an unrecognized kind gets mention-only — narrower than a DM, which is the right direction, and the reason this is stated per branch rather than as "unknown means DM". **The invariant is that an unknown kind never gets more reach than the narrower of the two known kinds**, not that it is mechanically aliased to one of them.
- The bridged-create path's `chatType` mapping (`private → dm`, else `channel`) is already guarded by an explicit `UNKNOWN_CHAT_TYPE` refusal ahead of the ternary, and pinned by `room-bridged-create.test.ts`.

Every other `kind` branch — `deliverNotices`, the `participants` roll-up, `findDmByMemberSet`, slug and un-archive handling, notice damping, bridged titles — either skips work or damps output for an unrecognized kind. None of them widen.

## Consequences

- An agent can now start a conversation with another agent. It cannot start one you are not in, and it cannot arrange to be left alone in one afterwards.
- A group DM stops doubling its own turn count. One message from a person costs one turn per agent, and an agent's reply costs nothing unless it names somebody.
- An agent that wants a colleague's attention in a DM must name it. That is a real behaviour change for a room somebody had deliberately set to "Everything", and it is the trade this ADR makes knowingly: `always` keeps its unconditional meaning in a channel, where a person picks it from the member menu, and yields inside a DM, where every member is seeded with it by default and nobody picked anything.
- `OWNER_MUST_BE_PRESENT` is a new 403 the cockpit does not render specially yet. Its message is the remedy ("join it first", "take one of its agents out first"), so a raw toast is still actionable.

## What was deliberately NOT built

- **No arbitration.** No speaker election, no room-scoped turn lock, no referee. Addressing three agents and getting three answers stays the intended outcome (ADR `260726-170125`, `.claude/rules/room-conduct.md`).
- **No new room kind.** No "agent huddle", no private-to-agents room, no third value in `RoomKindSchema` — the whole point is that there is nowhere for agents to talk that a person is not.
- **No `created_by` column and no migration.** The rule reads the roster it already has.
- **No change to the cascade guard, the turn budget, or the notices.** They still bound a loop that starts; this ADR removes a common way one started.
- **No new capability for a second person.** The `accounts-and-auth` posture is untouched.
- **No prompt-side rule.** "Don't talk to each other where the operator can't see" is not a rule an agent can follow — it is a property of a room, and it is checked in the code that writes the roster.
