---
id: 260804-093318
title: A bridged room's identity is its bridge row, never its member set
status: accepted
created: 2026-08-04
spec: chats-as-channels
superseded-by: null
---

# 260804-093318. A bridged room's identity is its bridge row, never its member set

## Status

Accepted. Implemented in the `chats-as-channels` phase 1 series.

**Amendment 1 (DOR-1616, migration 0085): the exclusion moved from the query into the row, and the decision it protects is unchanged.** Member-set dedupe is now a real constraint — `rooms.dm_member_key` carries a DM's canonical roster and `rooms_dm_member_key_unique` refuses a second room for it — because the old read-then-insert could be raced into two rooms for one pair. A bridged room's key is **NULL**, and `findDmByMemberSet` is a lookup on that column, so `WHERE rooms.id NOT IN (SELECT room_id FROM room_bridges)` no longer exists and is no longer needed. Read the third Positive consequence below as "enforced in the SCHEMA, not by convention": the clause it names was a thing every future copy of one query had to remember, whereas a bridged room now has nothing for the lookup to match and cannot be pulled into the constraint by a roster change either. The recorded fallback in the second Negative — `kind: 'channel'`, never a weakening of the exclusion — stands as written.

## Context

`RoomStore.findDmByMemberSet` identifies a DM by its exact member set, and `createRoom` consults it for every `kind: 'dm'` request, returning - and un-archiving - a match. A bridged Telegram private chat whose roster is `{operator, bound agent}` is byte-identical to the operator's own private DM with that agent. Routing a bridge create through member-set matching would silently return the operator's existing private conversation, land strangers' messages in it, and make its private posts delivery candidates for a chat the operator never meant to expose.

## Decision

We will identify a bridged room by its **bridge row**, keyed on `(adapterId, chatId)`, never by its roster. The create path calls a dedicated `createBridgedRoom` that mints a room unconditionally, bypassing member-set dedupe; re-bridging resolves through the bridge store on `(adapterId, chatId)`; and `findDmByMemberSet` gains a `WHERE rooms.id NOT IN (SELECT room_id FROM room_bridges)` clause so it can never return a bridged room. The chat, not the roster, is the natural key that actually identifies this room.

## Consequences

### Positive

- A stranger's message can never land in the operator's private DM: the two are different rooms with different logs even when their rosters match exactly.
- Re-bridging is idempotent on the chat - the natural key - so an archived bridged room is re-used, not duplicated, and its echo-suppression and reply-targeting refs stay continuous.
- The exclusion is enforced in the query, not by convention, so a future caller of `findDmByMemberSet` cannot reintroduce the bug by not knowing to avoid it.

### Negative

- Two conceptually similar "DM with this agent" rooms can now coexist, which a user could find surprising until the origin marks explain it.
- A second dedupe rule (bridge-row identity) sits beside the member-set rule; both must be kept correct, and `kind: 'dm'` for a bridged private chat is safe _only_ because of this exclusion. If it ever proves invasive, the recorded fallback is `kind: 'channel'` - never a weakening of the exclusion.
