---
slug: room-per-agent-stop
id: 260819-023727
tracker: DOR-1352
project: Unified Conversation Surfaces
created: 2026-08-19
status: specified
---

# Stop one agent without stopping the room

**Status:** Draft
**Author:** Claude (SPECIFY)
**Date:** 2026-08-19

## Overview

A room can have three agents working at once. Today the only way to stop one of them is to stop
all three. This adds a stop that names its target: `POST /api/rooms/:id/halt/:authorId`, a
`RoomTriggerDispatcher.haltAgent` that is the room-wide halt scoped to one `(room, agent)` key,
a room notice that says who stopped whom, and a **Stop** button on every row of the live peek
instead of only on the single-agent case.

The verb is not new. It is the one the room already has, with a scope. Everything that makes the
room-wide halt correct makes this correct in the same order and for the same reasons: the
dispatch is marked before the first `await`, the durable line is written before the claim is
released, and the gather buffer is dropped before the claim is released.

## Background / Problem Statement

`specs/unified-conversation/02-specification.md` §5.3.4 drew the peek's Stop and then had to
withdraw it:

| Working agents | What the peek offers today                                                        |
| -------------- | --------------------------------------------------------------------------------- |
| exactly one    | a `Stop` on that row. It calls `haltRoom`, and the room is that agent.            |
| two or more    | no per-row stop. One footer action, `Stop everything in this room · Stops all 3`. |

That table is honest, and it is a worse product than the mockup. The case it fails is the common
one: three agents answer a question, one of them goes off down a wrong path, and the only button
that can stop it also stops the two that are doing useful work. The person's choice is to lose
two good turns or to sit and watch a bad one.

§5.3.4 named the three costs of doing it properly, and all three are real:

1. **The interrupt race.** Calling `POST /api/sessions/:id/interrupt` from the peek would skip
   `RoomTriggerDispatcher`'s halt mark. `haltedTurns` is populated before `halt`'s first `await`
   (`room-trigger.ts:2388-2394`) because an interrupt is a request and not a guarantee: on
   2026-08-15 a live install wrote its `halted` notice and posted the stopped turn's complete
   answer two seconds later (DOR-1232). A stop that does not mark is a stop that does nothing
   visible.
2. **Its own notice copy.** `buildHaltedNotice(stopped)` counts agents and speaks for the room.
   A per-agent stop names one member, so it needs its own sentence.
3. **A scoped buffer drop.** `halt` calls `this.collector.drop(room.id)` for every agent in the
   room, and it does so **before** releasing any claim, because releasing a claim is what runs a
   held collection. Scoped to one agent, that drop is what keeps a stopped agent from picking the
   same messages straight back up: without it, Stop reads as a stutter and the "halt is a control
   action, not a reaction" rule in `room-trigger.ts:96-114` is broken in practice while still
   being true in the source.

All three are solvable, and none of them needs anything new. This specification builds them.

## Goals

- A person can stop one agent in a room and leave the others working.
- The stopped agent's turn is interrupted, its answer is thrown away, its claim is released, its
  waiting messages are dropped, and the room says so once, naming who stopped whom.
- The stopped agent does not immediately re-claim from the messages that triggered it.
- Every row in the live peek has a Stop, whatever state it is in, and the labels are honest.
- The room-wide Stop keeps working, from the masthead and from the peek footer, unchanged.

## Non-Goals

- No change to `AgentRuntime`, to any runtime adapter, or to how an interrupt reaches a process.
  `RoomTurnRunner.interrupt` (`room-turn-runner.ts:398-407`) already resolves the runtime from
  the agent path and calls `AgentRuntime.interruptQuery(sessionId)`, so claude-code, codex and
  opencode are covered by whatever covers `halt`.
- No pause, no mute, no "stop and do not answer the next one either". Stop ends a turn. An agent
  that should stop answering has its response mode changed or is removed from the room.
- No stop from an agent. `requirePersonAuthor` gates this route exactly as it gates `halt`.
- No new `RoomNoticeCode`.
- No change to the room masthead's Stop, or to the session surface, which deliberately has no
  peek Stop at all (§5.3.4: the session composer already has one).
- Nothing is refunded. A turn that ran a model has spent, and `tryReserve` still has no
  counterpart.

## Technical Dependencies

None new. Everything rides shipped machinery, plus one specified sibling.

| Thing              | Where                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The halt mark      | `apps/server/src/services/rooms/room-trigger.ts:350-372` (`haltedTurns`), read by every delivery path at `:1354`, `:1423`, `:1489`, `:1643`, `:1867`, `:1888`                       |
| Claim release seam | `room-trigger.ts:2127-2190` (`releaseClaim`), the only place `done` is published and the republish timer cleared                                                                    |
| Runtime interrupt  | `room-turn-runner.ts:398-407` → `packages/shared/src/agent-runtime.ts:961` (`interruptQuery`)                                                                                       |
| The room's voice   | `services/rooms/notices/notice-copy.ts` + `notice-log.ts` (`write` is the single writer)                                                                                            |
| Entry body subject | `packages/shared/src/room-schemas.ts:612-621` (`RoomEntryBodySchema.subjectAuthorId`)                                                                                               |
| Auth gates         | `room-service.ts:3006` (`requireVisibleRoom`), `:3259` (`requirePersonAuthor`)                                                                                                      |
| Error → status     | `apps/server/src/routes/room-error-response.ts:18-42`                                                                                                                               |
| OpenAPI            | `apps/server/src/services/core/openapi-registry.ts:3798-3820`                                                                                                                       |
| Room transport     | `packages/shared/src/transport-rooms.ts:182`, `apps/client/src/layers/shared/lib/transport/room-methods.ts:185-193`, stubs at `shared/lib/embedded-mode-stubs.ts:824` (`roomStubs`) |
| Peek + lane        | `features/conversation/ui/LivePeek.tsx`, `widgets/room-view/ui/RoomLiveLane.tsx:293-303`                                                                                            |

**Sequencing.** `specs/room-hold-when-busy` (DOR-1345, status `specified`) is expected to land
first. It introduces `RoomCollector.dropOne(roomId, authorId)`, the dispatcher's `held` map with
`releaseHold(key, HoldEnd)` where `HoldEnd` already includes `'halted'`, and the peek's
`state: 'held'` rows. §3.5 says exactly what to build if the order reverses.

## Detailed Design

### 1. `RoomTriggerDispatcher.haltAgent`

`apps/server/src/services/rooms/room-trigger.ts`, immediately after `halt`.

```ts
/**
 * Stop one agent in one room: interrupt its turn, drop what it has not read
 * yet here, and say so once. Everybody else in the room keeps working.
 *
 * **It is {@link RoomTriggerDispatcher.halt} scoped to one key, and every
 * ordering constraint that method documents applies here unchanged.** Three of
 * them, in the order they appear in the body:
 *
 * 1. The dispatch is marked BEFORE the first `await`. An interrupt is a request
 *    and not a guarantee, so the turn's own stream still closes the ordinary way
 *    and a model that had all but finished streams its last words either side of
 *    the signal — the two-second race measured on 2026-08-15 (DOR-1232).
 * 2. The notice is written BEFORE the claim is released. Releasing publishes
 *    `done`, and an indicator that vanishes ahead of the entry explaining it is a
 *    room going quiet for no visible reason.
 * 3. The collection is dropped BEFORE the claim is released. Releasing a claim is
 *    what resumes a held collection, so the other order would answer, one
 *    macrotask later, exactly the messages the person pressed Stop over — which
 *    is how a control action turns itself back into a reaction.
 *
 * What it deliberately does NOT do is mute. Messages that arrive after this
 * collect and are answered normally: Stop ends a turn, it does not change a
 * setting.
 *
 * @param room - The room the agent is working in.
 * @param authorId - The agent to stop.
 * @param byAuthorId - The person stopping it, for the room's own line.
 * @returns How many in-flight turns were interrupted: `1`, or `0` when the agent
 *   was not running one here.
 */
async haltAgent(room: Room, authorId: string, byAuthorId: string): Promise<number> {
  const key = agentKey(room.id, authorId);
  const claim = this.claimed.get(key);
  // First statement, before anything that can yield. See point 1 above.
  if (claim !== undefined) this.haltedTurns.add(claim.dispatchId);
  logger.info('[rooms] an agent was stopped in a room', {
    roomId: room.id,
    authorId,
    stopped: claim !== undefined,
  });

  // Dropped before the notice only to KNOW what to say; nothing here can yield,
  // so the durable-write-before-release ordering is untouched.
  const waiting = this.collector.dropOne(room.id, authorId);
  if (waiting !== null) {
    this.releaseHold(key, 'halted');
    this.settleOne();
  }

  this.notices.reportAgentHalted(room, {
    byAuthorId,
    subjectAuthorId: authorId,
    outcome:
      claim !== undefined ? 'interrupted' : waiting !== null ? 'unstarted' : 'idle',
  });

  if (claim === undefined) return 0;

  const sessionId = this.deps.store.getRoomSession(room.id, authorId);
  if (sessionId !== null && sessionId !== undefined) {
    try {
      await this.deps.runner.interrupt({ sessionId, agentPath: claim.agentPath });
    } catch (err) {
      // An agent that will not stop still loses its claim: a claim held for a
      // turn nobody can interrupt is an indicator with nothing behind it.
      logger.warn('[rooms] could not interrupt a turn while stopping an agent', {
        roomId: room.id,
        authorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  this.releaseClaim(key, 'halted');
  return 1;
}
```

Three notes on what is **not** in that body, each of which is a decision:

- **No `forgetHalt`.** The mark is cleared at the stopped turn's own terminal, exactly as
  `halt`'s is (`room-trigger.ts:1447`, `:1643`, `:1933`).
- **`releaseClaim`, not `releaseOwnClaim`.** Room-conduct's rule is that a turn releases its own
  claim and only a halt releases by key, "because it is stopping whoever holds it rather than
  finishing a turn". This is a halt.
- **No touch on any other key.** `this.claimed` is read once, by key. The other agents' claims,
  collections and holds are not enumerated, which is what makes "the others keep working" a
  property of the code rather than of a test.

**What happens to the stopped agent's answer.** Nothing new. Its dispatch id is in `haltedTurns`,
so `deliver`, `deliverLate` and the aside path all throw the text and the notices away when it
lands, and `notices.recovered` does not fire. That is also why no extra work is needed to stop the
cascade: an answer that never posts triggers nobody.

**What happens to everybody else.** The other agents' turns still post, and one of them may
re-trigger the stopped agent. That is correct. The person stopped a turn, not a member, and a new
trigger is a new dispatch that Stop said nothing about (`room-trigger.ts:362-365`).

### 2. `RoomService.haltAgent`

`apps/server/src/services/rooms/room-service.ts`, directly after `haltRoom` (`:539`).

```ts
/**
 * Stop one agent in a room, leaving the others working.
 *
 * The same three refusals as {@link RoomService.haltRoom}, plus one it cannot
 * have: the target has to be an agent on this room's roster. Answering
 * `{ stopped: 0 }` for a name that is not there would hide a client bug behind a
 * success, and nothing leaks by saying so — `requireVisibleRoom` has already
 * established that this caller can see the room and its roster.
 *
 * A person on the roster is refused by the same code, and the sentence is
 * literally true: there is no agent by that id here. A second code that no
 * client would treat differently is a second thing to keep true.
 *
 * Archived rooms are allowed, exactly as they are for the room-wide halt.
 *
 * @param roomId - The room.
 * @param authorId - The agent to stop.
 * @param viewerAuthorId - Who is stopping it.
 * @returns `1` when a turn was interrupted, `0` when the agent was not running
 *   one here. `0` is a success.
 */
async haltAgent(roomId: string, authorId: string, viewerAuthorId: string): Promise<number> {
  const room = this.requireVisibleRoom(roomId, viewerAuthorId);
  this.requirePersonAuthor(viewerAuthorId, 'stop an agent');
  if (
    this.store.getMember(roomId, authorId) === null ||
    this.authors.getById(authorId)?.kind === 'human'
  ) {
    throw new RoomError('MEMBER_NOT_FOUND', 'No such agent in this room.');
  }
  return this.triggers.haltAgent(room, authorId, viewerAuthorId);
}
```

Order is load-bearing and matches every other verb here: **room first, then caller, then target.**
A caller who cannot see the room gets `ROOM_NOT_FOUND` whether or not the agent exists.

### 3. Notices

#### 3.1 The code stays `halted`

No new `RoomNoticeCode`. `packages/shared/src/room-schemas.ts:150-157` records why that matters:
widening `RoomNoticeCodeSchema` is **not additive**, because a client pinned to the old enum fails
to parse any room containing a new value, not just a room that uses the feature.

Two edits in `room-schemas.ts`:

- The `halted` bullet (`:117-120`) currently ends "About the room rather than one member, so it
  carries no `subjectAuthorId`." Replace with:

  > `halted` — somebody stopped work here. A control action, never inferred from anything anybody
  > typed (room-participation spec §10.4). It comes in two scopes and `subjectAuthorId` is the
  > tell: **absent** means the whole room was stopped, **present** names the one agent that was
  > (`specs/room-per-agent-stop`). Both are written by the same log, damped on different keys.

- No schema change. `RoomEntryBodySchema.subjectAuthorId` is already optional and already means
  exactly this.

#### 3.2 `buildAgentHaltedNotice`

`apps/server/src/services/rooms/notices/notice-copy.ts`, beside `buildHaltedNotice`.

```ts
/** What a per-agent stop found when it arrived. */
export type AgentHaltOutcome = 'interrupted' | 'unstarted' | 'idle';

/**
 * The durable `notice` a per-agent stop writes: somebody stopped ONE agent here.
 *
 * Named on both sides, unlike {@link buildHaltedNotice}, and the asymmetry is
 * deliberate. The room-wide line is passive because it applies to everybody
 * including the person who pressed it. This one singles out one member of a
 * shared room, and "who did that" is the first thing a room-mate asks.
 *
 * @param personName - Display name of the person who pressed Stop.
 * @param agentName - Display name of the agent that was stopped.
 * @param subjectAuthorId - That agent's author id, so the feed can draw it.
 * @param outcome - What the stop actually found, which is what the reader needs:
 *   a turn cut short, a turn that had not started, or nothing at all.
 */
export function buildAgentHaltedNotice(
  personName: string,
  agentName: string,
  subjectAuthorId: string,
  outcome: AgentHaltOutcome
): RoomEntryBody {
  return {
    text: `${personName} stopped ${agentName}. ${AGENT_HALT_LINES[outcome](agentName)}`,
    notice: 'halted',
    subjectAuthorId,
  };
}

const AGENT_HALT_LINES: Record<AgentHaltOutcome, (agentName: string) => string> = {
  interrupted: (agentName) =>
    `${agentName} was working here and has been interrupted. Send a message to start it again.`,
  unstarted: (agentName) =>
    `${agentName} had not started yet, so it will not answer what was waiting. Send a message to ask again.`,
  idle: (agentName) => `${agentName} was not working here at the time.`,
};
```

The three sentences, in plain words, are:

| Outcome       | Line                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `interrupted` | `Dorian stopped Ana. Ana was working here and has been interrupted. Send a message to start it again.`              |
| `unstarted`   | `Dorian stopped Ana. Ana had not started yet, so it will not answer what was waiting. Send a message to ask again.` |
| `idle`        | `Dorian stopped Ana. Ana was not working here at the time.`                                                         |

No em dashes. One idea per sentence. The `idle` line speaks rather than staying silent, for the
reason `halt` already gives: pressing Stop is a question, and silence is not an answer to it.

#### 3.3 `reportAgentHalted`

`apps/server/src/services/rooms/notices/notice-log.ts`, beside `reportHalted` (`:575`).

```ts
/**
 * Say that somebody stopped one agent here.
 *
 * Damped on `(room, agent)` and re-armed by that agent's next claim, the same
 * shape and the same reason as the room-wide key beside it: what makes a second
 * line a repeat is that nothing happened in between. Two presses on Ana in a
 * quiet room are one line. Ana and then Bo are two, because they are two
 * different statements about two different members.
 *
 * The room key and the per-agent keys never damp each other. A room-wide stop
 * after a per-agent one is a bigger statement that everybody in the room needs,
 * and a per-agent one after a room-wide one answers a question the person asked
 * about one member.
 *
 * Stamped as its own cascade, like the room-wide halt: a stop answers no
 * message, so inheriting one's provenance would file it inside an exchange it had
 * nothing to do with.
 *
 * @param room - The room.
 * @param about.byAuthorId - The person who pressed Stop.
 * @param about.subjectAuthorId - The agent that was stopped.
 * @param about.outcome - What the stop found.
 */
reportAgentHalted(
  room: Room,
  about: { byAuthorId: string; subjectAuthorId: string; outcome: AgentHaltOutcome }
): void {
  const key = haltKey(room.id, about.subjectAuthorId);
  if (this.noticedHalt.has(key)) return;
  // Both rows exist: the caller passed `requirePersonAuthor` a moment ago, and
  // the subject passed the roster check. The fallbacks cover a row deleted
  // between those checks and this line, and say something true either way.
  const personName = this.deps.authors.getById(about.byAuthorId)?.displayName ?? 'Somebody';
  const agentName = this.deps.authors.getById(about.subjectAuthorId)?.displayName ?? 'An agent';
  if (
    this.write(
      room.id,
      buildAgentHaltedNotice(personName, agentName, about.subjectAuthorId, about.outcome),
      about.subjectAuthorId,
      { cascade: { root: room.id, depth: 0 } }
    )
  ) {
    this.noticedHalt.add(key);
  }
}
```

with, beside the module's other key helpers:

```ts
/** The damping key for a per-agent stop. Room ids are ULIDs, so `\u0000` cannot collide with one. */
function haltKey(roomId: string, authorId: string): string {
  return `${roomId}\u0000${authorId}`;
}
```

#### 3.4 `workStarted` gains the author

`notice-log.ts:595` becomes:

```ts
/**
 * An agent started working in this room, so a stop is worth reporting again.
 *
 * Clears BOTH keys: the room's, because a claim being taken is something
 * happening in the room, and this agent's, because it is something happening to
 * this agent. Another agent's claim re-arms the room line and leaves this
 * agent's alone, which is the honest split — nothing has happened to Ana just
 * because Bo started working.
 *
 * @param roomId - The room a claim was just taken in.
 * @param authorId - The agent that took it.
 */
workStarted(roomId: string, authorId: string): void {
  this.noticedHalt.delete(roomId);
  this.noticedHalt.delete(haltKey(roomId, authorId));
}
```

Its one caller is `room-trigger.ts:2057`, inside `holdClaim`, which already holds `claim.authorId`:

```ts
this.notices.workStarted(claim.roomId, claim.authorId);
```

#### 3.5 What DOR-1345 owns, and what to do if it lands second

`haltAgent` calls two things that `specs/room-hold-when-busy` introduces:

| Call                                        | DOR-1345 reference                                        | If it has not landed                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `this.collector.dropOne(room.id, authorId)` | §2.3, `dropOne(roomId, authorId): RoomCollection \| null` | Add exactly that method to `RoomCollector` here, to that signature, so the two cannot diverge. It is the per-agent twin of `drop(roomId)` (`room-collect.ts:330-347`): remove the collection for the key, cancel or re-arm the sweep timer the same way `drop` does, and hand the collection back. |
| `this.releaseHold(key, 'halted')`           | §2.4, `HoldEnd` already contains `'halted'`               | Delete the line. There is no hold map to release from, and `settleOne()` still settles the dropped collection's credit.                                                                                                                                                                            |

The client's held-row half (§5.2 below) is likewise DOR-1345's and is simply absent until it
lands. Nothing else in this document depends on it.

### 4. The route

`apps/server/src/routes/rooms.ts`, directly after `POST /:id/halt` (`:744`).

```ts
/**
 * POST /:id/halt/:authorId — stop one agent's turn in this room.
 *
 * A sibling of `POST /:id/halt` rather than a field on it, and the difference is
 * the failure mode. That route takes no body on purpose (Express 5 leaves
 * `req.body` undefined on an empty POST), and an optional `authorId` in one would
 * fail OPEN: a client that forgot to send it would stop the whole room. A path
 * segment cannot be forgotten. `POST /:id/holds/:authorId/promote` is the
 * sibling precedent for an author-scoped room sub-path.
 *
 * Same gate as the room-wide stop: only a person, and only in a room they can
 * see. Allowed on an archived room for the same reason.
 */
router.post('/:id/halt/:authorId', (req, res) => {
  void (async () => {
    try {
      const caller = resolveCaller(res);
      const stopped = await getRoomService().haltAgent(
        req.params.id,
        req.params.authorId,
        caller.id
      );
      res.json({ stopped });
    } catch (err) {
      sendRoomError(res, err, 'POST /:id/halt/:authorId');
    }
  })();
});
```

Response reuses `HaltRoomResponseSchema` (`{ stopped: number }`, here always 0 or 1). It is the
same question with the same answer shape, and the peek does not read the number at all.

**OpenAPI** (`services/core/openapi-registry.ts`, after the `/api/rooms/{id}/halt` block at
`:3798`):

```ts
registry.registerPath({
  method: 'post',
  path: '/api/rooms/{id}/halt/{authorId}',
  tags: ['Rooms'],
  summary: 'Stop one agent in a room',
  description:
    'A control action, not a message, scoped to one agent. It interrupts that agent’s in-flight turn here, throws away the answer if the turn streams one anyway, drops the messages it had not read yet in this room, releases its working indicator, and writes one `halted` notice naming who stopped whom. Every other agent in the room keeps working. Takes no body. Only a person may call it. Allowed on an archived room, like the room-wide stop.',
  request: { params: RoomAuthorParams },
  responses: {
    200: {
      description:
        'Whether a turn was interrupted: 1, or 0 when the agent was not running one here',
      content: { 'application/json': { schema: HaltRoomResponseSchema } },
    },
    403: {
      description: 'The caller is not a person; agents do not stop each other',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No such room, not a member of it, or no such agent on its roster',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
```

`RoomAuthorParams` is `RoomIdParams` extended with `authorId`. If the registry already has such a
params object for `DELETE /api/rooms/{id}/members/{authorId}`, reuse it rather than adding a
second.

### 5. Client

#### 5.1 Transport and mutation

| File                                                                 | Change                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/transport-rooms.ts`                             | Add `haltRoomAgent(id: string, authorId: string): Promise<HaltRoomResponse>` beside `haltRoom` (`:182`), with a TSDoc line saying it stops one agent and leaves the others.                                                                                                                                                                             |
| `apps/client/src/layers/shared/lib/transport/room-methods.ts`        | Implement it: `fetchJSON(baseUrl, \`/rooms/${id}/halt/${authorId}\`, { method: 'POST' })`.                                                                                                                                                                                                                                                              |
| `apps/client/src/layers/shared/lib/embedded-mode-stubs.ts`           | Add `haltRoomAgent` to `roomStubs` (`:824`), throwing `'Rooms are not supported in embedded mode'` like its neighbours. This is the whole of Obsidian parity.                                                                                                                                                                                           |
| `apps/client/src/layers/entities/room/model/use-halt-agent.ts` (new) | `useHaltAgent()` — `useMutation({ mutationFn: ({ roomId, authorId }) => transport.haltRoomAgent(roomId, authorId), meta: { errorLabel: "Couldn't stop this agent" } })`. No cache writes, for the same reason `use-halt-room.ts` has none: the notice and the dropped indicator both arrive on the room stream. Exported from `entities/room/index.ts`. |

#### 5.2 `LivePeek`

`apps/client/src/layers/features/conversation/ui/LivePeek.tsx`.

`LivePeekProps` gains one member and keeps `onStopAll`:

```ts
  /**
   * Stop one agent, leaving the rest of the room working.
   *
   * Absent on a surface with no per-agent stop behind it, which draws no row
   * button at all rather than a disabled one.
   */
  onStopAgent?: (authorId: string) => void;
  /** Author ids with a stop in flight, so their row buttons can say so. */
  stoppingAgents?: ReadonlySet<string>;
```

The gate becomes:

```ts
// Every row can be stopped now, whatever state it is in — a person should not
// have to know which one a row is in to know what its button does.
const perRowStop = onStopAgent !== undefined;
// The footer is the "and everything else" action, so it earns its place only
// when there IS something else.
const footerStop = rows.length > 1 && onStopAll !== undefined;
```

The row button keeps `data-testid="live-peek-stop"`, changes its handler to
`onStopAgent(row.authorId)`, and its `disabled` to `stoppingAgents?.has(row.authorId) === true`.
Its accessible name has to name the target now that several can be on screen:
`aria-label={\`Stop ${row.author.displayName}\`}`with the visible text still`Stop`.

The footer is unchanged except that `rows.length` now counts held rows too, which stays honest
because the room-wide halt really does drop held collections.

The component docstring at `:73-88` is replaced. It currently explains why there is no per-agent
stop; the replacement explains the two scopes:

> **Two stops, and the difference is the scope, not the verb.** A row's Stop ends that agent's
> turn here and leaves everybody else working. The footer's ends everything in the room and says
> how many that is. Both reach the runtimes through the room's own halt path, which marks the
> stopped dispatch before it does anything that can yield, so a turn that streams its last words
> after the interrupt has them thrown away.

**Held rows** (after DOR-1345). `specs/room-hold-when-busy` §5.3 says "The row-level `Stop` and
the footer `Stop everything in this room` stay exactly as they are and count **working** rows
only — a held agent is not working here, so it is not something this room can stop." **This
specification amends that sentence.** It was written when a row's Stop was secretly the room-wide
halt, so pressing it on a held row would have stopped other agents' live turns. With
`haltAgent`, that objection is gone, and dropping a held collection is one of the things the
room-wide halt already does. A held row therefore gets the same Stop, and it means what it says:
this room stops waiting for that agent, and the room writes the `unstarted` line. It does **not**
touch the turn in the other room, which is the thing DOR-1345 was right to refuse and which stays
one click away behind `Open where it's working`.

DOR-1345's §5.3 gets a two-line amendment note pointing here.

#### 5.3 `RoomLiveLane`

`apps/client/src/layers/widgets/room-view/ui/RoomLiveLane.tsx:293-303`:

```tsx
const haltAgent = useHaltAgent();
const [stoppingAgents, setStoppingAgents] = useState<ReadonlySet<string>>(EMPTY_SET);
```

`onStopAgent` calls `haltAgent.mutate({ roomId: room.id, authorId })` and tracks the id in
`stoppingAgents` across the mutation's settle, because one shared `isPending` would disable every
row's button when one was pressed. `onStopAll` and `stopping` stay exactly as they are.

The peek's `stopping` prop keeps its current meaning (the room-wide stop is in flight) and now
also disables nothing else; `stoppingAgents` is separate.

### 6. What this does NOT change

Written down because each is a thing a reader will reach for:

- `POST /api/rooms/:id/halt` — unchanged, including its docstring, its notice, its damping key
  and its buffer drop.
- `RoomHeader`'s `room-header-halt` — unchanged. It is the room-wide verb and it renders only
  while something is working.
- `AgentRuntime`, every runtime adapter, `RoomTurnRunner.interrupt` — unchanged.
- `RoomNoticeCodeSchema` — unchanged.
- `NoticeRow.tsx` — unchanged. It already maps `halted` to `CircleStop` and renders
  `data-notice="halted"`.
- `services/relay/chat-bridge/deliver.ts` — unchanged. `halted` is already in
  `DELIVERABLE_NOTICES`, and the per-agent line needs no bridge rewrite for the reason
  `deliver.ts:600` already gives: unlike `turn_failed`, it does not tell the reader to open a
  session they do not have.

## User Experience

**The case this exists for.** Ana, Bo and Cy are all answering in `#launch`. Cy has gone down a
wrong path.

1. Dorian clicks the live lane. The peek opens with three rows, each reading
   `{name} · working · 1m 12s`, each with `Open its session` and `Stop`.
2. Dorian presses **Stop** on Cy's row. Only that button greys out.
3. Cy's row disappears. Ana and Bo keep counting up.
4. One line appears in the room:
   `Dorian stopped Cy. Cy was working here and has been interrupted. Send a message to start it again.`
5. Ana and Bo post their answers a minute later. Cy posts nothing, even though its model streamed
   two more sentences after the interrupt reached it.

**Pressing it twice.** The second press writes nothing, because nothing happened in between. If
Cy starts working again and Dorian stops it again, that is a second line.

**Stopping everybody.** With more than one row, the footer still reads
`Stop everything in this room` with `Stops all 3` underneath, and still writes the room's own
`Everything here was stopped.` line.

**A held row** (after DOR-1345). Mio is busy in another room, so `#deploys` shows
`Mio · waiting to start · 40s`. Pressing Stop on it writes
`Dorian stopped Mio. Mio had not started yet, so it will not answer what was waiting. Send a message to ask again.`
Mio's turn in the other room is untouched, and `Open where it's working` is still the way to
reach it.

**When it fails.** A refusal raises the shared mutation toast, `Couldn't stop this agent`, with
the server's message after it. The button that was pressed may already be gone by then, which is
why the toast is handled at the mutation and not at the call site, exactly as `use-halt-room.ts`
explains.

## Testing Strategy

Each test below names the defect that makes it red. Nothing asserts a shape the code structurally
guarantees.

### Unit — dispatcher

New file `apps/server/src/services/rooms/__tests__/room-per-agent-stop.test.ts`, built on the
harness `room-stopped-turns.test.ts` already uses, **including its runtime that ignores the
interrupt**. That runtime is not incidental: a runtime that stops promptly releases through
`runOne` anyway, so a `haltAgent` that forgot to release the claim would pass against a
well-behaved one.

| #             | Test                                                                                | Purpose / seeded defect                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1             | `stops the named agent and leaves the other one working`                            | Two agents claimed in one room. Stop the first. Red if `haltAgent` enumerates the map instead of reading one key: the second's claim is gone and its answer never posts.                                        |
| 2             | `throws away the stopped turn's answer even when the runtime ignores the interrupt` | Stop, then let the stopped turn's stream close normally with text. Red if the mark is set after the first `await`, or not at all: the answer posts. This is the 2026-08-15 race.                                |
| 3             | `writes exactly one halted line, naming who stopped whom`                           | Assert one `notice: 'halted'` entry, its `subjectAuthorId`, and its full text. Red if the copy loses the person, the agent, or the outcome branch.                                                              |
| 4             | `says nothing the second time, and says it again once the agent works again`        | Stop, stop again (one line), let the agent take a fresh claim, stop again (two lines). Red if the damping key is the room id, or if `workStarted` forgot the author.                                            |
| 5             | `stopping one agent does not silence a line about the other`                        | Stop Ana, then stop Bo. Two lines. Red if `haltKey` is the room id, which would make Bo's stop silent.                                                                                                          |
| 6             | `a room-wide stop after a per-agent one still speaks`                               | Red if the two damping keys are merged.                                                                                                                                                                         |
| 7             | `drops what the agent had not read yet, so it does not answer it a macrotask later` | Messages gathered for the agent, stop mid-gather, `await triggers.idle()`, assert no turn ran and the agent posted nothing. Red if `dropOne` runs after `releaseClaim`, which is the ordering `halt` documents. |
| 8             | `leaves the other agent's gathered messages alone`                                  | Two agents gathering, stop one, the other's batch still becomes a turn. Red if the drop is room-scoped.                                                                                                         |
| 9             | `releases the claim through the seam, so the indicator drops`                       | Assert the presence `done` publish, not the map. Red if `haltAgent` deletes from `this.claimed` directly, which would leave the republish timer running and the room showing work that stopped.                 |
| 10            | `writes the durable line before the indicator drops`                                | Order-of-effects assertion against a recorder, the same shape `room-stopped-turns.test.ts:469` already uses. Red if the notice moves below `releaseClaim`.                                                      |
| 11            | `stopping an idle agent still says so`                                              | `outcome: 'idle'`, one line, `stopped` is 0. Red if the method returns early before the notice.                                                                                                                 |
| 12            | `does not mute: the next message is answered normally`                              | Stop, then post again, assert a turn runs. Red if the stop left any per-agent state that refuses the next trigger.                                                                                              |
| 13 (DOR-1345) | `stopping a held agent drops its hold and writes the unstarted line`                | Red if `releaseHold` is missing: the held indicator stands until the 10s republish tick, with nothing durable under it.                                                                                         |
| 14 (DOR-1345) | `stopping an agent here does not touch its turn in another room`                    | Red if `haltAgent` resolves the claim by `agentPath` instead of by `(room, agent)` key.                                                                                                                         |

### Unit — routes

`apps/server/src/routes/__tests__/rooms.test.ts`, a `describe('POST /:id/halt/:authorId')` beside
the halt block at `:509`. The auth table mirrors halt's and adds the target row:

| Case                                      | Expect                                                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| person, visible room, agent on the roster | `200 { stopped: 0 \| 1 }` and a `halted` entry whose `subjectAuthorId` is that agent                                             |
| agent caller                              | `403 PEOPLE_ONLY` — and assert **no** notice was written, because a refusal that still speaks is a way to make a room say things |
| room the caller cannot see                | `404 ROOM_NOT_FOUND`                                                                                                             |
| unknown room id                           | `404 ROOM_NOT_FOUND`, identical body to the previous case                                                                        |
| author id not on the roster               | `404 MEMBER_NOT_FOUND`                                                                                                           |
| a human author on the roster              | `404 MEMBER_NOT_FOUND`                                                                                                           |
| archived room                             | `200` — the carve-out, red if somebody adds an archive guard by symmetry with `post`                                             |

### Unit — client

- `apps/client/src/layers/features/conversation/__tests__/LivePeek.test.tsx` (extend, or create
  beside `LiveLane.test.tsx` if none exists):
  - three working rows render three `live-peek-stop` buttons, each with its own accessible name.
    Red against today's `rows.length === 1` gate.
  - pressing one calls `onStopAgent` with **that row's** `authorId`. Red if the handler closes
    over the wrong row, which a `.map` makes easy and which no snapshot would catch.
  - `stoppingAgents` disables only the row it names. Red if a single `stopping` flag is reused.
  - one row: a row Stop and **no** `live-peek-stop-all`. Red if the footer gate loosens.
  - no `onStopAgent`: no row Stop at all, and no disabled button either.
- `apps/client/src/layers/widgets/room-view/__tests__/RoomLiveLane.test.tsx` (extend): pressing a
  row's Stop calls the mock transport's `haltRoomAgent` with `(roomId, authorId)`, and pressing
  the footer calls `haltRoom` with the room id. Red if the lane wires both to one mutation, which
  is the single most likely wiring mistake here.

### E2E

One case in `apps/e2e/tests/rooms/room-autonomy.spec.ts`, inside the existing
`Stopping a room @smoke` describe so it inherits the `long-turn` / collect-window `beforeEach` and
the `afterEach` restore. It runs in the `chromium-rooms-agents` project only
(`playwright.config.ts:621-626`), which is the test-mode leg.

`test('stopping one agent leaves the other working, and the room names both')`:

1. Register two agents, seat both to answer everything, open the room.
2. `useScenario(request, 'long-turn')`, post one message, wait for
   `room-header-working` to read `2 agents working`.
3. Open the peek from the lane. Assert **two** `live-peek-stop` buttons — this is the assertion
   that fails against today's build and is therefore the reason this case exists.
4. Press the one whose accessible name is the first agent's.
5. Assert exactly one `[data-testid="room-notice"][data-notice="halted"]` containing
   `stopped {first agent}` and `has been interrupted`.
6. Assert `room-header-working` now reads `1 agent working` and `room-header-halt` is still
   visible. That pair is the whole claim: one stopped, one still going.
7. Cross-check the stored entries through `roomsApi.listEntries`: exactly one `halted` notice, and
   its `body.subjectAuthorId` is the first agent's author id. A browser can be fooled by a
   rendered string; the stored row cannot.
8. `finally`: `POST /api/rooms/:id/halt`, `POST /api/test/finish-turn`, restore `simple-text` —
   the same teardown the existing halt case uses, and for the same reason.

**Sandbox caveat, stated in the test's own comment:** `TestModeRuntime.interruptQuery` returns
`false`, so what this observes is the claim being dropped and the notice being written, not a
killed generation. That is the same caveat `.claude/commands/chat/rooms-test.md:353` already
records for the room-wide halt.

### Mocking strategy

Unchanged from the room's existing tests: `FakeAgentRuntime` and the scenarios in
`@dorkos/test-utils` on the server, a mock `Transport` through `TransportProvider` on the client,
and the test-mode leg with `long-turn` in the browser. Nothing here needs a new double.

## Performance Considerations

None. `haltAgent` does one `Map.get`, one collector lookup, one notice write, at most one
`interruptQuery`, and one claim release. The room-wide halt is O(claims in the room) and this is
O(1). The peek renders one more button per row, on a list bounded by the room's roster.

## Security Considerations

- **The caller gate is the same and is asserted, not assumed.** `requirePersonAuthor` runs before
  anything is stopped. An agent stopping a room-mate would be the arbitration ADR 260726-170125
  declined twice, and scoping the verb makes it more tempting rather than less, which is why the
  `403` case is in the route table.
- **The room gate runs first.** `requireVisibleRoom` before the roster check means a caller who
  cannot see the room learns nothing about who is on its roster: they get `ROOM_NOT_FOUND` either
  way.
- **The notice names a person, and that name is already trusted at this position.** It is written
  into a `RoomEntry` body, which reaches a model inside the per-turn fenced region of
  `room-context-block.ts` exactly like every other message body. It is not a label outside the
  fence, so no new sanitizing is required; `buildTurnFailedNotice` already embeds a display name
  the same way.
- **Nothing new is reachable from the MCP surface.** The four room capability verbs
  (`room-capabilities.ts`) are unchanged, and stopping is not one of them.

## Documentation

- `.claude/rules/room-conduct.md` — the "Stopping is a control action and is never inferred"
  invariant names `POST /api/rooms/:id/halt` and "the header button". Add the scoped sibling and
  its one extra rule: **a per-agent stop drops that agent's collection and nothing else, and it
  still drops it before releasing the claim.** Also amend the "a refusal is visible" bullet, which
  currently says `halted` is damped per room: it is damped per room for the room-wide stop and per
  `(room, agent)` for the per-agent one.
- `specs/unified-conversation/02-specification.md` §5.3.4 — add a note that the follow-up it
  filed is `specs/room-per-agent-stop`, and that the table it publishes is superseded. Do not
  rewrite the section; the reasoning in it is the record of why the phase shipped what it did.
- `specs/room-hold-when-busy/02-specification.md` §5.3 — the two-line amendment note described in
  §5.2.
- `.claude/commands/chat/rooms-test.md` — check 3a currently drives only the masthead Stop. Add
  **3c**: with two agents working, open the peek, stop one, and assert one `halted` notice with a
  `subjectAuthorId` while the other agent is still working. Add the per-agent route to the API
  list at `:516`.
- `changelog/unreleased/<id>-per-agent-stop.md` — one fragment, written to `writing-for-humans`.
  Draft: "Stop one agent without stopping the rest. Open the live view in a channel and every
  agent that is working now has its own Stop button. The others keep going, and the channel says
  who stopped what."
- No `docs/` page. There is no user guide covering the room live lane yet, and adding one for a
  button is not the page to start with.

## Implementation Phases

**One PR.** The server half without the client half is a route nobody calls; the client half
without the server half does not compile. The work is one dispatcher method, one service method,
one route, one notice builder, one damping key, one transport method plus its stub, one mutation,
and two components.

If DOR-1345 has not landed when this starts, the held-row work in §5.2 and tests 13 and 14 are cut
and `RoomCollector.dropOne` is added here to DOR-1345's published signature (§3.5). That is a
subtraction, not a second phase.

## What is not done

Deliberately, and each for a stated reason:

- **No per-agent stop in the session peek.** `specs/unified-conversation` §5.3.4 settled it: the
  session composer already has a stop, and a second is two buttons for one verb.
- **No pause or mute.** Stop ends a turn. Making an agent stop answering is a response-mode
  change, and folding a setting into a control action would make both worse.
- **No "stop it in the other room" from a held row.** DOR-1345 refused it and was right: it would
  reach past this room into a conversation the person cannot see from here. `Open where it's
working` is the honest one-click path.
- **No `stopped-by` field on the entry.** The notice text names the person and
  `subjectAuthorId` names the agent. A third field would be a second copy of a fact the sentence
  already carries.
- **No sweep of `haltedTurns` for per-agent stops.** It stays bounded by construction, exactly as
  it is for the room-wide halt: every marked dispatch belongs to a frame that forgets its mark at
  its terminal.
- **Nothing is refunded.** A stopped turn spent whatever it spent.
- **No bridge-specific rewrite of the per-agent line.** `deliver.ts` already reasons that
  `halted` reads correctly to somebody in a bridged chat.

## Open Questions

None. Every decision is resolved in `01-ideation.md` §5, including the two product-level ones,
each recorded there as `(RESOLVED — default chosen: …)` with the reversal noted:

- **Does a held row get a Stop?** Yes (Decision 2). Reversing it deletes one condition in
  `LivePeek`.
- **Does the notice name the person who pressed it?** Yes (Decision 3). Reversing it drops one
  argument from `buildAgentHaltedNotice`.

## Related ADRs

- `decisions/260726-170125` — no arbitration, no room-scoped scheduler. The constraint a
  per-agent stop has to be read against, and the reason a draft ADR accompanies this spec.
- `decisions/260726-170127` — bounds are mechanisms, never prompts. Stopping reaches the
  transport, never the model.
- ADR-0264 — posting is trigger-only. Why the halt routes answer immediately and everything a
  reader sees arrives on the room stream.
- `decisions/260811-184735` — a busy session answers "it will run next" rather than an error. The
  reasoning DOR-1345 carries into rooms and that this spec inherits for held rows.
- Draft: `decisions/<id>-scoped-control-actions-are-not-arbitration.md`, extracted from this spec.

## References

- `specs/unified-conversation/02-specification.md` §5.3.4 — the section that filed this work.
- `specs/room-hold-when-busy/02-specification.md` §2.3, §2.4, §5.3 — the hold record, `dropOne`,
  and the sentence this spec amends.
- `specs/room-participation/02-specification.md` §10.4 — the halt verb.
- `.claude/rules/room-conduct.md` — the five invariants this work is held to.
- DOR-1232 — the 2026-08-15 interrupt race, and why the mark comes first.
- DOR-784, DOR-1206 — why every silence in a room is visible and damped.
