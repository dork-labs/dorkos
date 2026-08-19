---
slug: room-hold-when-busy
id: 260818-234135
tracker: DOR-1345
project: Unified Conversation Surfaces
created: 2026-08-18
status: implemented
---

# A room never asks you to resend

**Status:** Implemented — shipped 2026-08-19 on `main` (DOR-1345). See
[04-implementation.md](04-implementation.md) for what landed, the four deviations, and the seeded
defects each test was run against.
**Author:** Claude (SPECIFY)
**Date:** 2026-08-18

## Overview

A message addressed to an agent that is mid-turn in **another room** is currently refused and
dropped, with a durable line asking the person to send it again. This specification replaces that
refusal with a **hold**: the message joins the agent's collection, the agent's next free moment runs
a turn for it in the room that asked, and the answer lands there. While the message waits, the
room's **live lane** says so — in this room's own voice, with an elapsed count and a way to open the
conversation that is in the way. The late answer carries a durable pointer to the message it
answers.

Nothing here is a scheduler. Nothing here orders two agents against each other. Nothing here
persists a turn.

## Background / Problem Statement

The dispatcher holds one claim per `(room, agent)` and checks **two ceilings** before a turn
(`apps/server/src/services/rooms/room-claims.ts:356-367`):

| Ceiling                   | Bounds                             | Today                                   |
| ------------------------- | ---------------------------------- | --------------------------------------- |
| `(room, agent)` claim key | one transcript per room            | **held** — RP8, `room-collect.ts`       |
| `agentPath`               | one checkout, shared by every room | **refused** — `room-trigger.ts:481-493` |

The refusal writes `agent_busy` with `BUSY_LINES['working-elsewhere']`
(`notices/notice-copy.ts:139-144`):

> `${agentName} is working in another conversation right now, so it didn't pick this up. Send it
again in a few minutes.`

Three things are wrong with that outcome, in increasing order of seriousness.

1. **It asks a person to do work the machine could do.** The message is already a committed room
   entry. Refusing only removes the room's obligation to answer it.
2. **The remedy it names is unfollowable.** A room shows no "free" state for another room's agent,
   so "in a few minutes" is a guess the reader has to keep re-testing by hand.
3. **It is the same mistake the session path already corrected.** ADR `260811-184735`: a busy
   session used to answer `409 SESSION_LOCKED`, "an error where the honest answer was 'it will run
   next'". The room path still answers with the room-shaped version of that error.

## Goals

- A message for an agent busy in another room is **never dropped and never asks for a resend**.
- The person is told, **while it is true**, what will happen and roughly when — with a way to reach
  the conversation that is in the way.
- The held message runs when the blocking turn ends, **however it ends** — answered, silent, failed,
  or stopped.
- A late answer says **which message it answers**, durably.
- No new user-facing setting, no new table, no migration, no runtime work.

## Non-Goals

- Holding for an **absent** member (ADR `260727-184933` §50 — accepted property, not reopened).
- **Steering or interrupting** the blocking turn (`research/20260813_room-architecture-vs-buzz-qm.md`
  recommendation 1).
- A **per-author halt** (`specs/unified-conversation` §5.3.4).
- **Durable holds** across a restart (§"What is not done", and `01-ideation.md` D2).
- Changing the **same-room** hold, the cascade guard, the turn budget, or the collect window.
- A queue rung for the composer's own **drafts** — those stay in the composer's queue panel.

## Technical Dependencies

None new. Everything below is Zod (`packages/shared`), the existing room dispatcher, the existing
presence store, and TanStack Query on the client.

## Detailed Design

### 1. The state machine of a held message

```
                    ┌──────────────────────────────────────────────┐
  post ─────────────▶  collecting        (dueAt set, nothing held)  │
                    └───────┬──────────────────────────────────────┘
                            │ busyWith !== null at collect or at sweep
                            ▼
                    ┌────────────────────┐   claim released for that agentPath
                    │  held              │──────────────────────────────┐
                    │  (parked, dueAt=∅) │                              │
                    └───┬──────┬─────────┘                              ▼
       halt / room drop │      │ age > lateReplyCeilingMinutes   ┌──────────────┐
                        │      │                                 │  running     │
                        ▼      ▼                                 │  (claim held)│
                 dropped(halted)  dropped(held-too-long)          └──────┬───────┘
                        │              │                                │
                        │              │                     ┌──────────┴─────────┐
                        │              │                     ▼                    ▼
                        │              │               answered             dropped(refused |
                        │              │            (post + answersEntryId)   budget | gone |
                        │              │                                      unavailable | failed)
                        ▼              ▼
                 `halted` notice   `agent_busy` notice
```

Two invariants govern every edge:

- **`running` is re-entered, not assumed.** When a claim releases, every held collection for that
  `agentPath` is re-armed; the first to reach `claimCollected` takes the claim and the rest go
  straight back to `held` against the new blocking room. The cascade guard is re-asked at that
  moment, exactly as it is for a same-room hold.
- **Every terminal has a durable sibling** except a process restart (§"What is not done").

### 2. Server data model

#### 2.1 `claimBusyWith` returns which claim is blocking

`apps/server/src/services/rooms/room-claims.ts` — the enum becomes a record, because the room now
needs the blocking claim's `roomId` to publish a held indicator.

```ts
/** Which ceiling an agent is up against, and the claim that is in the way. */
export interface ClaimBusy {
  /** `'here'` when the blocking claim is in the room being triggered. */
  where: 'here' | 'elsewhere';
  /** The claim in the way. Its `roomId` is what a held indicator points at. */
  blocking: ActiveClaim;
}

export function claimBusyWith(
  claims: ReadonlyMap<string, ActiveClaim>,
  roomId: string,
  authorId: string,
  agentPath: string
): ClaimBusy | null;
```

Resolution order is unchanged: the `(room, agent)` key first, then the first claim matching
`agentPath`.

#### 2.2 The dispatcher owns the hold record

`RoomTriggerDispatcher` gains a second map beside `claimed`, with the same rule: **it is the only
writer, because a held indicator is that map made visible.**

```ts
/** One room's unanswered message, waiting on a turn in a different room. */
interface HeldRecord {
  roomId: string;
  authorId: string;
  agentPath: string;
  /**
   * The FIRST message this hold covers, fixed for the hold's life. The presence
   * indicator is keyed `(room, author, entryId)`, so a moving id would open a
   * second indicator every time the person typed again.
   */
  entryId: string;
  /** ISO 8601 — when the hold opened, which is what the lane counts up from. */
  since: string;
  /** The room whose claim is in the way. Re-pointed each time the hold re-parks. */
  behindRoomId: string;
}

private readonly held = new Map<string /* agentKey(roomId, authorId) */, HeldRecord>();
```

**Only the `elsewhere` ceiling records a hold.** A same-room hold needs none: the agent already
holds a claim in this room, so the room is already showing it as `working` and the peek already has
a row for it. A second indicator under the same author would draw the agent twice.

#### 2.3 `RoomCollector` gains three methods and no knowledge

The collector still knows nothing about claims (`room-collect.ts` module doc). What it gains is the
ability to be resumed by **agent** rather than by room, to be ordered, and to give one collection
back.

```ts
/** Re-arm every parked collection for this agent, in any room. Oldest hold first. */
resumeAgent(agentPath: string): void;

/** Put one agent's collection at the front of the next sweep. Returns false when there is none. */
promote(roomId: string, authorId: string): boolean;

/** Remove one collection and hand it back, for an expiry the dispatcher decided. */
dropOne(roomId: string, authorId: string): RoomCollection | null;
```

> **Amended (2026-08-19) by `specs/room-per-agent-stop` (DOR-1352), which shipped `dropOne` first.**
> The shipped signature is `dropOne(roomId: string, authorId: string): RoomCollection[]` — a list,
> exactly like `drop(roomId)`. One `(room, agent)` key can hold TWO collections at once: the cap
> takes a full one out of the map and leaves it in `closing` for a macrotask, and a message
> arriving in that window opens a fresh one behind it. Each holds one of the dispatcher's in-flight
> credits, so handing back one while removing both leaks the other's and `idle()` never resolves
> again. Build the expiry path against the list (`dropped.length > 0`, settle per element);
> `room-collect.test.ts` pins the double case.

`RoomCollection` gains one field, `promoted: boolean` (default `false`), and `sweep` sorts the due
batch **promoted first, then by the order the collections were opened**. `park()` clears
`promoted` only when it merges into another collection (the merged batch is the older one and keeps
its own mark).

`CollectInput` splits one flag into two, because the two meanings have come apart:

```ts
/** True when this agent already holds a claim IN THIS ROOM — the `arrivedDuringPrevTurn` mark. */
duringTurnHere: boolean;
/** True when this collection must not be given a deadline: some claim is in the way. */
park: boolean;
```

Today they are the same boolean. After this change an `elsewhere` hold sets `park: true` and
`duringTurnHere: false` — the agent was **not** working here, so telling the model "this arrived
while you were working" would be false.

#### 2.4 The dispatcher's five new/changed seams

| Function                             | Change                                                                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collectOne` (`room-trigger.ts:475`) | The `working-elsewhere` early return and its `reportSilence` call are **deleted**. Every candidate is collected: `park: busy !== null`, `duringTurnHere: busy?.where === 'here'`. When `busy?.where === 'elsewhere'`, call `noteHold`. |
| `claimCollected` (`:908`)            | The `working-elsewhere` branch stops refusing: it parks like the `working-here` branch, then calls `noteHold` for the surviving key.                                                                                                   |
| `holdClaim` (`:2044`)                | Calls `releaseHold(key, 'started')` **before** `publishPresence(claim, 'working')`, so the held indicator resolves into the working one rather than sitting beside it.                                                                 |
| `releaseClaim` (`:2144`)             | After the existing `collector.resume(roomId, authorId)`, calls `resumeElsewhere(claim.agentPath)`.                                                                                                                                     |
| `republishPresence` (`:2192`)        | Re-states every held record as well as every claim, and runs `expireHolds()` first. The tick already runs whenever any claim exists, and a hold cannot exist without one.                                                              |
| `halt` (`:2386`)                     | `collector.drop(room.id)` already returns the dropped collections; each one now also releases its hold record with `done`.                                                                                                             |

New private helpers:

```ts
/** Record a hold and put it on the room's stream. Idempotent: an existing record keeps its
 *  `since` and `entryId` and only re-points `behindRoomId`. */
private noteHold(collection: RoomCollection, busy: ClaimBusy): void;

/** Drop a hold and publish `done` for it. Called from every path that ends a collection
 *  without taking a claim. */
private releaseHold(key: string, reason: HoldEnd): void;

/** Re-arm every held collection for one agent and re-state the ones still blocked. */
private resumeElsewhere(agentPath: string): void;

/** Drop holds older than `rooms.lateReplyCeilingMinutes` and write one notice each. */
private expireHolds(): void;

/** Put one room's hold at the front of that agent's queue. The route's whole body. */
promoteHold(roomId: string, authorId: string): boolean;

/** One row per live hold, for the diagnostic read surface — mirrors `listClaims`. */
listHolds(): HeldView[];
```

`HoldEnd = 'started' | 'halted' | 'expired' | 'refused'`. Only `expired` writes a notice here; the
other three already have durable siblings written by the paths that cause them.

**The seam that makes "no hold is ever forgotten" structural, not remembered.** `claimCollected`
returns `null` from four places and each calls `settleOne()`. All four become
`settleCollection(collection, reason)`:

```ts
private settleCollection(collection: RoomCollection, reason: HoldEnd): void {
  this.releaseHold(agentKey(collection.room.id, collection.authorId), reason);
  this.settleOne();
}
```

This is the same shape `releaseClaim` uses for claims: one function, every terminal.

#### 2.5 The bounds

| Bound                        | Value                                    | Behaviour at the bound                                                                                                                                            |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messages per held collection | `rooms.collectMaxEntries` (20)           | Existing `trim()` — the oldest **marks** are dropped, never the lines. The messages stay in the log behind the read cursor and reach the turn as ambient context. |
| Hold age                     | `rooms.lateReplyCeilingMinutes` (60 min) | `expireHolds()` drops the collection, publishes `done`, and writes one `agent_busy` notice with the `held-too-long` line.                                         |
| Holds per agent              | one per room the agent is in             | Structural — the collection key is `(room, agent)`.                                                                                                               |

No new configuration field. `lateReplyCeilingMinutes` is reused because it already means "when the
room stops listening", which is the same fact at a different grain, and because
`meta/agent-etiquette.md` §9 is explicit that constants here are judgements we must be able to
defend rather than invent.

### 3. The wire

`packages/shared/src/room-schemas.ts`.

```ts
/** Where a working indicator is in its life. `held` is the one state that describes work that has
 *  NOT started: this room's message is waiting on a turn the agent is running somewhere else. */
export const RoomPresenceStateSchema = z
  .enum(['working', 'working_late', 'held', 'done'])
  .openapi('RoomPresenceState');

/** What a `held` indicator is waiting behind. Ids only — see §3.1. */
export const RoomHeldBehindSchema = z
  .object({
    roomId: z
      .string()
      .min(1)
      .describe(
        'The room whose turn is in the way. An id and nothing else: the reader resolves it against the rooms they can already see, and a reader who cannot see it reads "another conversation".'
      ),
    othersWaiting: z
      .boolean()
      .describe(
        'This agent is holding a message in at least one OTHER conversation too. A boolean, never a count or a list — it exists only to decide whether "Answer here first" would do anything.'
      ),
  })
  .openapi('RoomHeldBehind');
```

`RoomSignalEventSchema` gains one optional field:

```ts
    /** Present only on a `state: 'held'` progress signal. */
    heldBehind: RoomHeldBehindSchema.optional(),
```

and the producer payload widens:

```ts
export type RoomPresencePayload = Required<Pick<RoomSignalEvent, 'state' | 'entryId' | 'since'>> &
  Pick<RoomSignalEvent, 'heldBehind'>;
```

`RoomEntryBodySchema` gains the pointer `specs/room-participation` §5.3 specified and never shipped:

```ts
    /** The entry this post answers. Set on every agent-authored post written by
     *  `RoomTriggerWriter.post`. Chat posts in arrival order regardless of what a message
     *  responds to; holding makes that gap common rather than rare. */
    answersEntryId: z.string().optional(),
```

#### 3.1 Why the wire carries a room ID and not a room title

`specs/room-presence`'s Non-goals say _"The presence line never says 'busy elsewhere'"_, on the
grounds that a reader in this room may not be a member of the other one. That property is kept, and
kept more precisely than before:

- the wire carries `roomId` only. No title, no topic, no author, no message text.
- a room id is not a capability in this codebase — `"'not a member' answers exactly as 'no such
room'"` (`.claude/rules/room-conduct.md`).
- the **client** resolves the id against `useRooms()`, which is already scoped to what this reader
  may see. The owner (`seesEveryRoom`) reads `#mio-engagement`; anybody else reads
  _"another conversation"_.

So the disclosure is per reader rather than per wire, and the vagueness the non-goal protected is
enforced by what the reader can see rather than by refusing to say anything at all.

#### 3.2 `CommunityAdapter` compatibility

`RoomPresenceStateSchema` is reused by `packages/shared/src/community-adapter.ts`. Adding an enum
member is additive for producers: a remote backend that cannot produce `held` simply never sends
it, and `heldBehind` is optional. **`communityConformance` must not require either.** The suite
gains one case asserting that a backend which publishes only `working`/`done` still passes.

### 4. Notice copy

`apps/server/src/services/rooms/notices/notice-copy.ts`.

`BUSY_LINES['working-elsewhere']` is **deleted**. `BusyContext` becomes:

```ts
export type BusyContext = 'held-too-long' | 'unknown';

const BUSY_LINES: Record<BusyContext, (agentName: string) => string> = {
  'held-too-long': (agentName) =>
    `${agentName} has been working in another conversation for a long time, so it hasn't got to your message yet. It will read it the next time it picks up work here.`,
  unknown: (agentName) =>
    `${agentName} was busy in its own session, so it didn't answer here. It will read your message the next time it picks up work in this room.`,
};
```

Both are past tense, neither asks for a resend, and both are true: the messages are behind the
agent's read cursor, so the ambient window delivers them on the next turn whatever triggers it.

The notice code stays `agent_busy`, so the `(room, agent, reason)` damping key and every rule in
`specs/room-participation` §5.2 are untouched, and `RoomNoticeCodeSchema` does not change.

The `unknown` line's meaning is now exact rather than a catch-all: it is reached only from the
`refuse-foreign` dispatch path (`room-turn-runner.ts:291`), where a stranger — usually the person
typing into that agent directly — held the session until the trigger's bounded wait ran out
(DOR-1242). That case cannot be held, because nothing publishes an event when a foreign session lock
releases, so there is no seam to hang a resume on.

### 5. The client

#### 5.1 The lane rung

`apps/client/src/layers/features/conversation/model/lane-state.ts`.

```ts
/** One agent whose turn for this room has not started because it is working somewhere else. */
export interface LaneHeldAuthor {
  authorId: string;
  name: string;
  /** ISO 8601 — when the hold opened. */
  since: string;
  /** The room in the way. `title` is null when this reader cannot see that room. */
  behind: { roomId: string; title: string | null };
  othersWaiting: boolean;
}
```

`LaneStateInput` gains `held?: readonly LaneHeldAuthor[]` (defaulting to a shared `NO_HELD`, like
`NO_PRESENCE`). The union gains a tenth member:

```ts
  | {
      kind: 'held';
      sentence: string;
      authorIds: readonly string[];
      /** The OLDEST hold's start — what the lane counts up from. */
      since: string;
    }
```

**Priority.** One new row, gated by `capabilities.presence`, immediately below `presence`:

| #     | State                            | Gate                                           |
| ----- | -------------------------------- | ---------------------------------------------- |
| 1     | `ask`                            | `capabilities.asks`                            |
| 2     | `stalled`                        | `capabilities.streamHealth && stalled`         |
| 3     | `presence`                       | `capabilities.presence && presence.length > 0` |
| **4** | **`held`**                       | **`capabilities.presence && held.length > 0`** |
| 5-9   | `turn-waiting` … `turn-complete` | `capabilities.turnStatus`                      |
| 10    | `empty`                          | —                                              |

Three things about that placement, and they are the argument against
`04-implementation.md:394`'s deletion of the old `queued` rung:

- **It reports a different fact.** `queued` counted the person's own undelivered drafts. `held` is
  about a message already on the room's log that the room owes an answer to.
- **It is reachable.** A room's capabilities are `turnStatus: false`, so rungs 5-9 do not exist
  there; and in the case it describes, the agent is busy _elsewhere_, so nobody is working _here_
  and `presence` is empty. The lane's only line is this one.
- **It hides nothing.** When someone genuinely is working here, `presence` still wins the headline
  and the hold shows as a row in the peek that rung already opens.

#### 5.2 Copy

`apps/client/src/layers/entities/room/lib/presence-copy.ts` gains `heldSentence`, following the
existing `presenceSentence` / `presenceCountSentence` split at `PRESENCE_NAME_LIMIT = 3`.

| Case                         | Sentence                                                                    |
| ---------------------------- | --------------------------------------------------------------------------- |
| one agent, room resolved     | `Mio Clicker PM will pick this up when it finishes in #mio-engagement`      |
| one agent, room not resolved | `Mio Clicker PM will pick this up when it finishes in another conversation` |
| 2-3 agents                   | `Mio Clicker PM and Ana will pick this up when they're free`                |
| more than 3                  | `4 agents will pick this up when they're free`                              |

The elapsed count rides `LaneElapsed`, which already floors at `LANE_TIMER_FLOOR_MS = 10_000` — so
the ordinary sub-ten-second hold shows no number at all, which is right: a hold that clears in eight
seconds is not a story.

`laneAnnouncement` returns `state.sentence` for `held`; `laneMotionKey` returns
`held:${state.sentence}`. `LaneContent` gains a `HeldLine`, `data-testid` `room-held` / `thread-held`
by scope, with a `LaneDot signal="working"` that **does not pulse** — nothing is running.

#### 5.3 The peek

`LivePeekRow` gains three fields:

```ts
  /** `'held'` is a row for work that has not started. */
  state: PresenceCopyState | 'held';
  /** Held rows only. `title` is null when this reader cannot see that room. */
  behind: { roomId: string; title: string | null } | null;
  /** Held rows only. Whether "Answer here first" would change anything. */
  othersWaiting: boolean;
```

`LivePeekProps` gains `onOpenRoom?: (roomId: string) => void`, `onAnswerFirst?: (authorId: string)
=> void` and `promoted?: ReadonlySet<string>`.

A held row reads `{name} · waiting to start · {elapsed}` and offers up to two actions:

| Action                    | `data-testid`            | Shown when               | Does                                                                                                                |
| ------------------------- | ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `Open where it's working` | `live-peek-open-room`    | `behind.title !== null`  | Navigates to that room.                                                                                             |
| `Answer here first`       | `live-peek-answer-first` | `othersWaiting === true` | `POST /api/rooms/:id/holds/:authorId/promote`. On success the button is replaced by the static text `Next up here`. |

Neither action touches the blocking turn. There is deliberately **no** "stop what it's doing over
there": stopping is a control action with a room-wide notice and a gather-buffer drop, and it is
reachable one click away through the first action, in the room where the person can see what they
would be stopping. The row-level `Stop` and the footer `Stop everything in this room` stay exactly
as they are and count **working** rows only — a held agent is not working here, so it is not
something this room can stop.

> **Amended (2026-08-19) by `specs/room-per-agent-stop` (DOR-1352), which shipped first.** The
> last sentence above no longer holds: the row `Stop` is now `haltAgent`, scoped to one
> `(room, agent)` key, so pressing it on a held row stops nothing anybody else is doing. A held
> row therefore gets the same Stop as a working one, and it means what it says — this room stops
> waiting for that agent, its collection is dropped, and the room writes the `unstarted` line. The
> refusal in the paragraph above is unchanged and still right: it does **not** touch the turn in
> the other room, which stays one click away behind `Open where it's working`. What this spec adds
> is `state: 'held'` rows and the hold record; the button on them already exists.

#### 5.4 Where holds come from on the client

One store, two readers. `use-room-presence.ts`:

- `observe` accepts `state: 'held'` like any other progress frame, subject to the same
  three-field guard, and stores `heldBehind` on the record.
- `useRoomPresenceClaims` **excludes** `state === 'held'` — otherwise a held agent would draw a
  working dot and a working peek row.
- a new `useRoomHolds(roomId, scope?)` returns only the held records, summarised the same way
  (one row per author at its oldest `since`, sorted by `since` then `authorId`), through the same
  `PresenceScope` filter — which works for free, because a hold is keyed on the first held entry and
  a thread reply scopes exactly like any other entry.
- `PRESENCE_TTL_MS = 30_000` against the server's 10 s republish is unchanged and now also covers
  holds.

`RoomLiveLane` resolves each hold's `behind.title` against `useRooms()` (`entities/room`), passes
`held` into `deriveLaneState`, and merges held rows into `peekRows` **after** the working rows, so
the peek reads "who is working" then "what is waiting".

**One known flicker, and its bound.** `specs/room-presence` §5.1 clears every `(author, *)`
indicator in a room when that author posts. A held agent that posts into this room through
`post_to_room` mid-hold therefore loses its held line for up to 10 s, until the republish tick
restates it. That is the same bound the rule already accepts for a live claim, and closing it would
mean teaching the clear-on-post rule about a state it was written before.

### 6. The thread pointer

`RoomTriggerWriter.post` sets `answersEntryId` to the triggering entry's id on **every**
agent-authored post — the in-frame reply (`deliver`, `room-trigger.ts:1465`), the late reply
(`deliverLate`, `:1594`) and the aside. It is set unconditionally, because a reader cannot tell from
the outside which turns were held.

The client renders it as a compact reference chip above the post — the same shape
`live-peek-replying-to` uses — **only when the answered entry is not the immediately preceding entry
in the rendered feed.** In the adjacent case the link is obvious and the chip would be furniture on
every reply in the product.

`withLateAnswerNote`'s prose prefix (`notice-copy.ts:542-549`) **stays**. It carries the delay,
which the chip does not, and it is what a bridged chat platform and `GET /api/rooms/:id/export`
render — neither of which has a chip.

### 7. The promote route

```
POST /api/rooms/:id/holds/:authorId/promote  →  200 { "promoted": true | false }
```

Thin, like every route: resolve the caller, check the same capability gate
`POST /api/rooms/:id/halt` uses, call `RoomService` → `RoomTriggerDispatcher.promoteHold`, map errors
through `sendRoomError`. `promoted: false` means there was no hold to promote — a stale button, not
an error. Registered in the OpenAPI document alongside `halt`.

## User Experience

**The case in the bug report.** Dorian types in `#deploys`: _"@Mio Clicker PM can you take the
staging rollout?"_. Mio is mid-turn in `#mio-engagement`.

1. The message posts. **No notice appears.**
2. The lane above the composer reads:
   `Mio Clicker PM will pick this up when it finishes in #mio-engagement · 40s`
3. Clicking the lane opens the peek: one row, `Mio Clicker PM · waiting to start · 40s`, with
   **Open where it's working**.
4. Mio's turn in `#mio-engagement` finishes. The held line resolves into the ordinary working line,
   `Mio Clicker PM is working on it`.
5. Mio's answer posts in `#deploys`, with a chip saying which message it answers.

**When it goes wrong.** The turn in `#mio-engagement` runs for an hour. At sixty minutes the lane
clears and one line appears in `#deploys`:

> Mio Clicker PM has been working in another conversation for a long time, so it hasn't got to your
> message yet. It will read it the next time it picks up work here.

**When somebody presses Stop.** Stopping `#deploys` drops the hold and the room writes its one
`halted` line. Stopping `#mio-engagement` releases Mio's claim there — and `#deploys`'s held message
runs, which is right: the person stopped one conversation, not the other.

## Testing Strategy

### Server units

New — `apps/server/src/services/rooms/__tests__/room-hold-elsewhere.test.ts`:

| #   | Purpose (what a defect would look like)                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A message for an agent claimed in another room opens a collection and writes **no** notice. _Red before the change: today it writes `agent_busy`._                 |
| 2   | Releasing the blocking claim runs one turn **in the room that asked**, and the reply posts there.                                                                  |
| 3   | The blocking turn ending `failed` still runs the hold — the release seam, not the outcome, is what resumes it.                                                     |
| 4   | Two rooms holding one agent run **one at a time, oldest first**; the second re-parks rather than starting beside the first.                                        |
| 5   | `promoteHold` makes the later room run first; the passed-over room still runs next.                                                                                |
| 6   | A hold older than `rooms.lateReplyCeilingMinutes` is dropped and writes exactly one `agent_busy` carrying the `held-too-long` words.                               |
| 7   | Halting the **held** room drops the hold and publishes `done`; halting the **blocking** room resumes it.                                                           |
| 8   | An `elsewhere`-held message does **not** carry `arrivedDuringPrevTurn`; a `here`-held one does. _This is the flag split in §2.3 and the only place it is visible._ |
| 9   | A hold whose collection reaches `collectMaxEntries` trims marks, not lines: the trimmed entry still reaches the turn's ambient window.                             |

Extended:

- `room-presence-claims.test.ts` — a hold publishes `held` with `heldBehind.roomId` and
  `othersWaiting`, is restated on the republish tick, and publishes `done` before the `working` frame
  when it becomes a claim.
- `room-collect.test.ts` — `resumeAgent` arms across rooms; `promote` orders the sweep; `dropOne`
  removes exactly one; `park` merge still returns `true` and does not resurrect a cleared
  `promoted`.
- `notices/__tests__/notice-copy.test.ts` — neither surviving busy line contains "again", and
  `BusyContext` no longer has a `working-elsewhere` member (a compile-level assertion via the total
  `Record`).
- `communityConformance` — a backend that publishes only `working`/`done` still passes.

### Server route-level scenario

`apps/server/src/services/rooms/__tests__/` — one scenario with **two rooms and one agent**, driven
through the real routes with `FakeAgentRuntime` and a scripted long turn:

1. `POST /api/rooms/{A}/entries` addressing the agent → its turn starts and holds a claim.
2. `POST /api/rooms/{B}/entries` addressing the same agent → **202**, and `GET /api/rooms/{B}/entries`
   contains **no** notice.
3. `GET /api/rooms/{B}/events` carries a `signal` frame with `state: 'held'` and
   `heldBehind.roomId === A`.
4. The scripted turn in A completes.
5. Room B's entries gain the agent's answer, with `answersEntryId` equal to the id of the entry
   posted in step 2.

### Client

- `lane-state.test.ts` — `presence` beats `held`; `held` beats `empty`; `held` is dark when
  `capabilities.presence` is false; the rung carries the **oldest** hold's `since`. Add to the file's
  seeded-defect list: _swap rungs 3 and 4_ and _read `held[last]` instead of `held[0]`_.
- `presence-copy.test.ts` — the four `heldSentence` cases, including the unresolved-room fallback.
- `RoomLiveLane.test.tsx` — a held row renders in the peek below the working rows;
  `Open where it's working` is absent when the title is unresolved; `Answer here first` is absent
  when `othersWaiting` is false; the footer Stop count counts working rows only.
- `use-room-presence.test.tsx` — a `held` frame lands in the store, is excluded from
  `useRoomPresenceClaims`, is returned by `useRoomHolds`, is dropped by `clearAuthor` and restored by
  the next republish, and expires at `PRESENCE_TTL_MS` like any other record.

### E2E

One spec, added to `apps/e2e/tests/rooms/room-autonomy.spec.ts` — the only rooms file that lets an
agent take a turn, on the test-mode leg, with the seeded collect window it already writes through
`PATCH /api/config`.

> **Test 5 — a message for a busy agent is held, not refused.** Seed two channels with the same
> agent. Put the `long-turn` scenario in place. Post in channel A to start a turn there. Post in
> channel B. Assert channel B shows `room-held` and **no** notice row. Restore `simple-text`, let
> A's turn finish, and assert B receives the agent's answer.

What a browser cannot see here, said out loud, in the style that file already uses: the FIFO
ordering across three rooms and the promote path are pinned in units, because they need a third
room and a deterministic clock.

### Mocking strategy

`FakeAgentRuntime` plus `@dorkos/test-utils` scenarios server-side; a mock `Transport` through
`TransportProvider` client-side; the existing `tapRoomStream` shim
(`apps/e2e/tests/rooms/room-signals.ts`) for any browser test that needs a synthetic `held` frame
without a real turn. `PresenceSignal` in that helper gains `'held'` and an optional `heldBehind`.

## Performance Considerations

The held map is process memory bounded by (rooms × agents) and read only on the 10 s republish tick,
which already iterates the claim map. `resumeAgent` is a linear scan of the collections map, which is
bounded the same way and runs once per claim release. No new query, no new table, no new stream.

## Security Considerations

The one new fact on the wire is a **room id** the reader may not be a member of, plus a boolean. Room
ids are already non-capabilities in this codebase — membership is the gate and "not a member" answers
exactly as "no such room" — so possession of the id grants nothing. No title, topic, author or
message text crosses a room boundary; the reader's own room list is what turns an id into a name.

`othersWaiting` discloses that the agent is holding a message somewhere else, which the reader has
already learned from `heldBehind.roomId`. It is deliberately a boolean rather than a count, so it
cannot be used to enumerate.

## Documentation

| File                                                   | Change                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/concepts/rooms.mdx`                              | The line near `:145` ("an agent that's busy or runs into trouble stays quiet too") is no longer true for the busy half. Replace with a plain sentence: an agent already working somewhere else keeps your message and answers it when it's free, and the room tells you so while you wait. |
| `.claude/rules/room-conduct.md`                        | Rewrite the RP8 bullet's last paragraph ("The refusal survives for the OTHER ceiling only…") to state the new rule and its bound, and extend the known-gap entry about restarts to say what a lost hold costs now.                                                                         |
| `changelog/unreleased/<id>-room-holds-your-message.md` | One fragment, in the `writing-for-humans` voice: rooms no longer ask you to send a message again.                                                                                                                                                                                          |
| OpenAPI                                                | Regenerated for `RoomHeldBehind`, the widened `RoomPresenceState`, `answersEntryId`, and the promote route.                                                                                                                                                                                |

## Implementation Phases

**One PR.** Not two, and the reason is a regression window rather than a preference: the change that
removes the refusal is one line in `collectOne`, and shipping it without the client half would leave a
person who posts to a busy agent with **nothing at all** — no notice (deleted) and no lane rung (not
yet rendered) — which is strictly worse than the sentence being replaced. The wire is also the join:
`held` is a new enum member, so a client that has not been taught it drops the whole signal frame at
the Zod boundary.

Order of work inside the PR, each step green before the next:

1. `packages/shared` — the wire (`held`, `RoomHeldBehind`, `heldBehind`, `answersEntryId`) and the
   widened `RoomPresencePayload`.
2. `room-claims.ts` — `ClaimBusy` becomes a record; fix the two call sites.
3. `room-collect.ts` — the flag split, `promoted`, `resumeAgent`, `promote`, `dropOne`, sweep order.
4. `room-trigger.ts` — the held map, the six changed seams, `settleCollection`, `expireHolds`,
   `promoteHold`, `listHolds`.
5. `notice-copy.ts` — retire `working-elsewhere`, write the two surviving lines.
6. `RoomTriggerWriter.post` — `answersEntryId`.
7. The promote route + OpenAPI.
8. Client — store readers, `deriveLaneState`, `heldSentence`, `HeldLine`, peek rows and actions,
   `RoomLiveLane` wiring, the reference chip.
9. Tests at every layer, the dev-playground showcase (`LiveLaneShowcases.tsx`), docs and the
   changelog fragment.

## What is not done

- **A hold does not survive a server restart.** The message is not lost — it stays behind the
  agent's read cursor and reaches it on the next turn as ambient context — but the room owes it no
  turn of its own any more, and nothing says so. This is deliberate: `.claude/rules/room-conduct.md`
  forbids a room trigger becoming a durable queue row (it would appear in the person's composer as a
  prompt they never wrote, and could fire days later into a dead conversation), and the claim a hold
  waits behind is itself memory-only. The promise is therefore only ever made on the ephemeral lane,
  which dies with the process that could keep it. Making it durable is the scheduler this domain has
  declined twice and needs arguing as one.
- **Nothing steers the blocking turn.** A message that arrives for an agent working elsewhere waits
  for that turn to end; it is never injected into it. That is
  `research/20260813_room-architecture-vs-buzz-qm.md`'s recommendation 1 and belongs to unifying room
  turns onto the session turn machinery.
- **The `unknown` busy case is still a refusal.** When a stranger holds the agent's session — most
  often the person typing into it directly — the trigger waits out its bounded budget and then fails
  (DOR-1242). It cannot be held because nothing publishes an event when a foreign session lock
  releases. Its copy is honest now; its behaviour is unchanged.
- **No per-author Stop**, and no way to stop another room's turn from this room's peek.
- **`Answer here first` reorders; it never preempts.** A promoted hold still waits for the agent to
  be free.
- **The reference chip is room-only.** Bridged chat platforms and the export still get the prose
  late-answer prefix, which says the delay but carries no link.
- **A hold is not shown in the sidebar.** The room row's working dot counts claims only; a room that
  is merely waiting draws no dot. Adding one would make "something is happening here" mean two
  different things.

## Open Questions

All resolved.

- ~~Should the hold be durable?~~ **(RESOLVED — default chosen: not durable.)** Answer: process
  memory, with the promise confined to the ephemeral lane. Rationale: `.claude/rules/room-conduct.md`
  already forbids the durable form, the claim it waits behind is memory-only, and the message itself
  is protected by `room_members.lastReadSeq` regardless.
- ~~How are holds ordered across rooms?~~ **(RESOLVED — default chosen: FIFO by hold start, with an
  explicit promote.)** Rationale: it orders one agent's own unanswered messages, never two agents,
  so `I1 No arbitration` is untouched.
- ~~What bounds a hold?~~ **(RESOLVED — default chosen: the two settings that already exist.)**
  `collectMaxEntries` per collection, `lateReplyCeilingMinutes` per hold. No new field, no
  safe-defaults classification, no migration.
- ~~How does the lane learn about a hold — a new presence state or a new signal?~~
  **(RESOLVED — default chosen: a new `state` on the existing `progress` signal.)** Rationale:
  presence already has the keying, the republish, the TTL, the partial-payload guard and the scope
  filter; a second signal type would duplicate all of it.
- ~~What does "Answer here first" mean mechanically?~~ **(RESOLVED — default chosen: promotion to the
  front of that agent's hold queue, never an interrupt.)** Shown only when `othersWaiting`, so the
  button is never a no-op.
- ~~Does `specs/room-presence`'s "the presence line never says busy elsewhere" block this?~~
  **(RESOLVED — default chosen: amended, narrowly.)** The wire carries an id; the reader resolves the
  name from rooms they can already see; a reader who cannot reads "another conversation".
- ~~Does the deleted `queued` rung's argument block a `held` rung?~~ **(RESOLVED — default chosen:
  no, and the spec says why in §5.1.)** Different fact, reachable position, hides nothing.
- ~~Cross-runtime behaviour?~~ **(RESOLVED — default chosen: identical, no adapter work.)** The hold
  sits above `RoomTurnRunner`; the ceiling is about a working directory.
- ~~What if the blocked turn is itself parked on an approval?~~ **(RESOLVED — default chosen: the
  hold stands and this room says nothing about why.)** The Ask is already broadcast fleet-wide (ADR
  `260818-002803`); repeating another room's approval state here would put one member's approval
  decision in front of everybody else.
- ~~Interaction with `halt`?~~ **(RESOLVED — default chosen: halting this room drops the hold;
  halting the blocking room runs it.)** Both fall out of the existing ordering; both are tested.

## Related ADRs

| ADR                         | Relation                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `260818-234541` (this spec) | Amends `260726-170125`: a busy agent's message is held, not refused.                                     |
| `260726-170125`             | The parent. Its "never a concurrency primitive" clause is what the code cites at the line being changed. |
| `260811-184735`             | The precedent one layer down — the server owns the queue for a busy session, and the `409` is gone.      |
| `260816-143752`             | Message dispositions at the runtime boundary; "every downgrade is reported".                             |
| `260818-002803`             | An agent's prompt is a fleet-wide Ask — why this room stays quiet about another room's approval.         |
| `260818-002806`             | The reserved live lane; this adds its tenth state.                                                       |
| `260727-184933`             | v1 does not queue for absent members — the boundary this work does not cross.                            |
| `260726-170127`             | The cascade guard; re-asked when a held batch runs.                                                      |

## References

- `specs/room-participation/02-specification.md` §5.3 (`answersEntryId`), §10.4 (RP8)
- `specs/room-presence/02-specification.md` §3.2, §3.4, §5.1, §5.4, Non-goals
- `specs/unified-conversation/02-specification.md` §5.2, §5.3.4;
  `04-implementation.md:372, 392, 394`
- `specs/rooms/02-specification.md` §5, §6
- `.claude/rules/room-conduct.md`; `meta/agent-etiquette.md` §5, §9
- `research/20260610_message_queuing_agent_runtimes.md`,
  `research/20260807_room_context_delivery_buzz_and_patterns.md`,
  `research/20260810_midturn_input_ux_survey.md`,
  `research/20260813_room-architecture-vs-buzz-qm.md`
- DOR-1345 (this work), DOR-1327 (predecessor), DOR-1230 / DOR-1242 (the acceptance protocol a hold
  must compose with)
