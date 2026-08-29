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

The operator's call (Dorian, 2026-08-13) was to allow it with one condition: **the human is always in the room.**

**"In the room" means on the roster, and that is a stronger thing than being able to see it.** The owner can already see every room on her install whether or not she is a member — `RoomService.seesEveryRoom` short-circuits `canSee`, and `listRooms` hands her the unfiltered list — so "a conversation nobody can see" was never the risk, and an earlier draft of this ADR was wrong to say so. What only a MEMBERSHIP carries is a read cursor, and therefore an unread count: `cursorsFor` keys on `room_members`, and a room the viewer is not in comes back with `unreadCount: null`, which the sidebar draws as no badge at all. Two agents talking in a room the owner is not on the roster of would be visible the way a file is visible — findable, never announced, never unread. The rule makes her a participant rather than an auditor.

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

- **It is compositional, not provenance-based.** Nothing records who opened a room — `rooms` has no `created_by` column — and adding one would buy a weaker rule: "an agent-seeded pair needs a witness" leaves a pair the owner seeded and then walked out of just as unattended. Asking the roster needs no column and covers both.
- **It is a property of the three write verbs, not of the table.** A room already in the forbidden shape when this ships keeps running, keeps triggering, and is never retro-refused; nothing sweeps `room_members`. What is closed is every route to that shape from here. A migration would be the wrong instrument — it would silently rewrite rosters somebody arranged — and there is nothing to migrate anyway, because until this ADR the old rule made an agent-seeded pair unbuildable.
- **`removeMember` refuses the owner herself**, which is the point rather than an oversight. A guarantee whose escape hatch is "leave afterwards" is not a guarantee. The way out is not blocked, only reordered: take an agent out first, or archive the room (spec §12.4 — there is no delete).

  > **Amended 2026-08-28 (DOR-1611).** Two claims in this bullet have gone stale; the rule has not. It used to say both membership verbs were operator-only, "so the owner is the only caller they can ever refuse". An agent whose owner has armed it with the `roomsManage` grant may now call `addMember` and `removeMember` in a room it belongs to (ADR `260828-123331`), so the caller here is sometimes an agent. This guard did not have to move, because it never asked who was calling — it asks what the roster will look like afterwards. A second refusal was added ahead of it for the new caller, and it is stronger than this one: **an agent may never take the person out of a room, in any shape**, not only in the two-agent shape this ADR is about. The bullet also said there is "no Leave". DOR-1233 gave a person one, and `leave_room` gives an agent one for channels only — both are `removeMember` with the caller as its own target, so the owner-removal refusal still stands between an agent and the person's membership.

- **Only an AGENT gets the escape.** A second person — a member account with login on — still may not put any agent in any room, owner present or not. An agent seeding a colleague is doing the job it was installed to do; a guest doing it is spending an account that is not theirs, and the owner's membership would make that visible without making it consented. Nothing asked for the second, so nothing grants it.
- **A new error code**, because it is a different fact. `OPERATOR_ONLY` means "you are not the person who may do this"; `OWNER_MUST_BE_PRESENT` means "this is not a shape a room may be in", and its caller is always the right person.

### 2. Outside a channel, implicit addressing belongs to a person's message

**A post an AGENT writes in a DM triggers only the members it names.** A person's post is unchanged: it still reaches every member whose mode answers, no `@` required. Channels are untouched entirely.

This is the same idea `standDownFallbackSeat` already applies to the fallback seat — a post an agent wrote is a conversation already underway, not a question aimed at the room — and it is not arbitration (ADR `260726-170125` stands): it never chooses between two agents that were addressed, and it never silences one that was named. `@bo` reaches Bo in a DM exactly as it does in a channel.

With it, the sequence above costs two turns and writes no notices, and — the property that matters — **adding a member to a DM no longer changes who can trigger the members already in it.**

**And the agent is told so.** `respondsSentence` (`room-context-block.ts`) is now kind-aware, because the sentence it wrote before this — "You answer every message here." — is exactly the belief that makes a handoff fail silently: an agent that thinks it answers everything writes "Bo, can you take the migration?" without the `@`, nothing is triggered, and nobody is told. Outside a channel every mode that fires without a mention now carries one added clause: _a message from another agent reaches you only when it mentions you — so use their @name to reach a colleague here._ This is the "bounds are mechanisms, never prompts" rule read in the other direction: the prompt is not the bound, but it must not contradict it.

### 3. An unrecognized room kind takes the narrower branch

`RoomKindSchema` is a closed `z.enum(['channel', 'dm'])` at every request boundary, so no caller can ask for a third kind. Storage is a different question: `rooms.kind` is a `text` column, and `toRoom` narrows it with an unchecked cast (`room-rows.ts`). The type is a claim about callers, not a guarantee about rows.

So the branches that decide how permissively an agent may answer are written as a **positive test for the looser side**, and every room-kind branch in the server was audited against that rule:

- The new restraint is spelled `roomKind !== 'channel'`, so an unrecognized kind is restrained rather than treated as a channel.
- `seedResponseMode` already reads `kind === 'channel' ? engaged : manifest default`, so an unrecognized kind takes the DM seed. That seed is `always`, which was the looser answer before this ADR and is bounded by the restraint after it.
- `respondsTo`'s `direct-only` case reads `=== 'dm'`, so an unrecognized kind gets mention-only — narrower than a DM, and the reason this is stated per branch rather than as an alias. **The invariant, worded as what the code actually does: an unknown kind never gets more reach than a DM** — and in this one branch, where a DM is the looser side, it gets less.
- The bridged-create path's `chatType` mapping (`private → dm`, else `channel`) is already guarded by an explicit `UNKNOWN_CHAT_TYPE` refusal ahead of the ternary, and pinned by `room-bridged-create.test.ts`.

Every other `kind` branch — `deliverNotices`, the `participants` roll-up, `findDmByMemberSet`, slug and un-archive handling, notice damping, bridged titles — either skips work or damps output for an unrecognized kind. None of them widen.

## Consequences

- An agent can now start a conversation with another agent. It cannot start one you are not in, and it cannot arrange to be left alone in one afterwards.
- A group DM stops doubling its own turn count. One message from a person costs one turn per agent, and an agent's reply costs nothing unless it names somebody.
- An agent that wants a colleague's attention in a DM must name it. That is a real behaviour change for a room somebody had deliberately set to "Everything", and it is the trade this ADR makes knowingly: `always` keeps its unconditional meaning in a channel, where a person picks it from the member menu, and yields inside a DM, where every member is seeded with it by default and nobody picked anything.
- **For an agent-authored post outside a channel, every mode collapses to `mention-only` — not just `always`.** `direct-only` stops firing on the fact that the room is a DM, and `engaged` stops being re-triggered by a colleague's chatter inside its window; both still answer a mention, and both are unchanged for a person's post and in every channel. Said plainly because "we bounded `always`" is the easy half-reading, and the rung table in `apps/client/.../response-mode.ts` shows three of these five modes as a DM behaviour.
- **An agent can now un-archive a group DM the owner had put away.** `createRoom`'s DM branch matches on the exact member set and re-opens an archived match (that is what makes re-opening a conversation work at all), and `updateRoom` has no operator gate — DOR-608's known hole, which cannot be closed without breaking that path. Before this ADR an agent could only reach its own two-party DMs that way; now it can reach a group DM it is a member of. Accepted rather than fixed here: the room comes back with its history, its roster and the owner on it, an un-archive is announced as `room_updated`, and archive is explicitly the reversible "put it away" (spec §12.4). Anything stronger belongs to DOR-608.
- `OWNER_MUST_BE_PRESENT` is a new 403 the cockpit does not render specially yet. Its message is the remedy ("join it first", "take one of them out before you leave it"), so a raw toast is still actionable.
- **The `CommunityAdapter` port has no vocabulary for it, and it escapes untranslated.** `LocalCommunityAdapter.removeMember` translates exactly one `RoomError` (`MEMBER_NOT_FOUND` → `CommunityMemberNotFoundError`) and deliberately lets every other code through, on the documented ground that "a refusal this port has no vocabulary for must not be dressed up as one it does". `OWNER_MUST_BE_PRESENT` therefore reaches a port consumer as an opaque `RoomError`, exactly as `ROOM_ARCHIVED` already does. That is the port's existing contract rather than a regression, and giving the port its own refusal type is a `specs/community-adapter` follow-up — nothing user-facing routes through this adapter yet.

## What was deliberately NOT built

- **No arbitration.** No speaker election, no room-scoped turn lock, no referee. Addressing three agents and getting three answers stays the intended outcome (ADR `260726-170125`, `.claude/rules/room-conduct.md`).
- **No new room kind.** No "agent huddle", no private-to-agents room, no third value in `RoomKindSchema` — the whole point is that there is nowhere for agents to talk that a person is not.
- **No `created_by` column and no migration.** The rule reads the roster it already has.
- **No change to the cascade guard, the turn budget, or the notices.** They still bound a loop that starts; this ADR removes a common way one started.
- **No new capability for a second person.** The `accounts-and-auth` posture is untouched.
- **No prompt-side rule.** "Don't talk to each other where the operator can't see" is not a rule an agent can follow — it is a property of a room, and it is checked in the code that writes the roster.
