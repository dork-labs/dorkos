---
slug: presence-verb-glimpse
id: 260819-023726
created: 2026-08-18
status: specified
tracker: DOR-1351
project: Unified Conversation Surfaces
---

# Presence tier 3: the live lane says what the agent is doing

**Status:** Draft
**Author:** Claude (IDEATE+SPECIFY author)
**Date:** 2026-08-18

## Overview

A room's live lane says "Kai is working on it · 42s". The session lane, two panes away, has said
"Reading standup.md…" since BC-37. This closes that gap: the room presence signal starts carrying the
agent's current activity, the client phrases it with the verb table it already owns, and the room lane
reads "Kai is reading standup.md · 1m 04s" while the peek carries a verb per agent.

Three properties make it safe to ship rather than merely nice:

- **The wire carries structure, the client carries words.** The signal gains one optional field typed
  as the existing `SessionActivitySchema`. No prose is minted server-side, which is the rule that
  schema was written around.
- **The target stops at the operator's cockpit.** A verb may travel outward to a bridge or a
  community; the file name, the command excerpt and the search pattern may not.
- **The eye moves, the ear does not.** The screen-reader announcement and the crossfade keep keying on
  the verb-free sentence, so a turn that starts four tools in eight seconds changes the drawn text and
  nothing else.

## Background / Problem Statement

`specs/unified-conversation/04-implementation.md`:748 records this as item 4 of "What was deliberately
not done": _"No verb glimpse in a room. The lane says 'is working on it,' never 'is reading
`standup.md`' — presence tier 3, deferred with tier C."_ :780 names it as one of the two open items
with the clearest next shape.

The cost of the gap is concrete. A room's lane is the surface a person watches while waiting on an
agent, and it can currently distinguish exactly two states: working, and working for a long time.
Everything the product knows about what the agent is actually doing — which the server already derives,
already truncates, and already fans out fleet-wide — stops at the session pane. Two agents in a room,
both eleven minutes in, are indistinguishable; with a glimpse, "Kai is running pnpm test" and "Ana is
reading CHANGELOG.md" tell a person which one to look at first.

## Goals

- A room's lane names the current tool and its one human-relevant argument, in the same words the
  session lane uses for the same tool call.
- One verb table for the whole cockpit. The session's "Reading standup.md…", the room's "Kai is
  reading standup.md" and the peek's "Reading standup.md" are three framings of one entry.
- The glimpse is mechanical: it exists only inside a claim, it is derived from a real `tool_call`, and
  nothing model-facing can set or suppress it (etiquette E16a).
- The target never reaches an audience that is not this operator.
- No regression to the lane's stillness: no extra announcements, no extra crossfades, no extra
  re-renders on the surfaces that hold presence without drawing a verb.

## Non-Goals

- A verb on the sidebar's `room_presence` count (room-presence §6). It stays a number.
- A verb in `room_context.working`, the roster block an agent reads.
- A verb in any durable entry or notice. The waiting notice stays vague on purpose
  (`notice-copy.ts:156-176`).
- Reader-side redaction for an agent subscribing to a room stream (see "What is not done" #1).
- Any change to who runs a turn, to the claim lifecycle, or to arbitration.
- Human typing indicators, read receipts, streaming partial reply text.
- Per-agent Stop.

## Technical Dependencies

None new. Everything rides shipped machinery: `SessionActivitySchema`
(`packages/shared/src/session-stream.ts:142-157`), `deriveSessionActivity`
(`apps/server/src/services/session/activity/derive-activity.ts`), `ACTIVITY_FANOUT_THROTTLE_MS`
(`session-state-projector.ts:130`), the claim map and republish loop (`room-trigger.ts:327, 2044-2245`),
`collectReply`'s existing subscription (`room-turn-runner.ts:557-670`), and `ACTIVITY_PHRASES`
(`apps/client/src/layers/shared/lib/tool-labels.ts:177-192`).

---

## 1. The wire: one optional field, one existing schema

`packages/shared/src/room-schemas.ts`. `RoomSignalEventSchema` gains a fourth optional field beside
`state`, `entryId` and `since`:

```ts
import { SessionActivitySchema } from './session-stream.js';

export const RoomSignalEventSchema = z
  .object({
    type: z.literal('signal'),
    signal: SignalTypeSchema,
    authorId: z.string().min(1),
    at: z.string(),
    state: RoomPresenceStateSchema.optional(),
    entryId: z.string().optional(),
    since: z.string().optional(),
    /**
     * What this agent's turn is doing right now, when the room has heard a tool
     * call for it — the same structured reading `SessionStatus.activity` carries,
     * reused rather than restated.
     *
     * **Structure, never prose.** `SessionActivitySchema`'s own contract is that
     * the client owns the wording, so a reading minted by an older server can
     * never put stale copy on a newer screen, and one turn cannot be described
     * two ways by the session lane and the room lane.
     *
     * Optional on every publish, and absent far more often than the other three:
     * a turn before its first tool has none, a turn that has ended has had it
     * cleared, and a claim held for a turn that never started never had one. An
     * absent reading is not a gap to fill — the room's own sentence ("Kai is
     * working on it") is the honest thing to say instead.
     */
    activity: SessionActivitySchema.optional(),
  })
  .openapi('RoomSignalEvent');
```

`session-stream.ts` imports nothing from `room-schemas.ts`, so this adds no cycle (verified).

`RoomPresencePayload` widens to carry it while keeping the three required fields required:

```ts
/**
 * … existing doc, plus:
 *
 * `activity` is the one field that stays OPTIONAL for the producer, and that is
 * capability-honest rather than a hole: the dispatcher always knows which entry
 * a claim answers and when it was taken, and genuinely does not know what the
 * turn is doing before its first tool call.
 */
export type RoomPresencePayload = Required<Pick<RoomSignalEvent, 'state' | 'entryId' | 'since'>> &
  Pick<RoomSignalEvent, 'activity'>;
```

`RoomService.publishSignal` already spreads a `Partial<RoomPresencePayload>` onto the frame
(`room-service.ts:2892-2908`), so it needs no signature change for the room's own stream. Its bridge
call is changed in §4.

## 2. Server: the room hears its own turn's tool calls

### 2.1 The port gains one callback, beside the one it already has

`apps/server/src/services/rooms/room-turn-port.ts`, on `RoomTurnRequest`:

```ts
  /**
   * Say what this turn is doing right now — the tool it just started, or `null`
   * when it is no longer doing anything nameable.
   *
   * The sibling of {@link RoomTurnRequest.onWaiting}, and reported for the same
   * reason: it is a STATE while it is still true, not an outcome. Everything
   * else the runner reports is settled by the time the room hears it.
   *
   * Called on every tool call inside this turn and once with `null` at the
   * turn's end, however it ends. The dispatcher decides how often any of that
   * reaches the wire — a runner never has to remember what it last said.
   *
   * @param activity - The tool the turn just started, or `null` to clear.
   */
  onActivity(activity: SessionActivity | null): void;
```

### 2.2 The runner reports it off the subscription it already holds

`apps/server/src/services/rooms/room-turn-runner.ts`.

- `collectReply`'s `bounds` gains `onActivity: (activity: SessionActivity | null) => void`.
- Inside the event loop, after the `started` guard (so nothing before this turn's own `turn_start`
  can be reported) and beside the existing `MESSAGE_BOUNDARY` handling:

  ```ts
  if (event.type === 'tool_call') {
    bounds.onActivity(deriveSessionActivity(event.toolName, event.input) ?? null);
  }
  ```

  `deriveSessionActivity` is imported from `../session/index.js`, which re-exports it (added in this
  PR, beside `SessionStateProjector`). **Reused rather than re-derived**: the basename rule, the
  first-line rule, the host rule and the 40-character truncation are the session's, and a second
  derivation is a second answer that can disagree about the same tool call.

- Cleared at the turn's end, in three places that already exist:
  - in the `turn_end` branch, before `break`;
  - in the `catch` (the read failed);
  - in the `finally` (the ceiling aborted, or the collector was cancelled).

  A single `clearActivity()` helper that calls `bounds.onActivity(null)` at most once, so a turn that
  ends and is then aborted does not publish two clears.

- `run` passes `onActivity: request.onActivity` into `collectReply`, beside `onWaiting`.

### 2.3 The claim holds it; the dispatcher publishes it

`apps/server/src/services/rooms/room-claims.ts`, on `ActiveClaim`:

```ts
  /**
   * What this turn is doing right now, as its runner last reported it, or
   * `undefined` before its first tool call and after its last.
   *
   * On the claim rather than beside it because the claim outlives the frame that
   * ran the turn: a late answer and a halt both reach the claim from paths that
   * never saw the runner.
   */
  activity?: SessionActivity;
  /** This client's clock at the last activity publish — the throttle's floor. */
  activityPublishedAt: number;
  /** An armed trailing publish, or `undefined` when none is. */
  activityFlush?: ReturnType<typeof setTimeout>;
```

`ActiveClaimView` (the diagnostic read at `listClaims`) gains **nothing**. It is ids, a timestamp and a
duration by design — "no room text, no prompt, no path" — and a target is a path.

`apps/server/src/services/rooms/room-trigger.ts`:

- Both `run` call sites (the ordinary trigger at `:1315` and the welcome-back aside at `:1854`) pass
  `onActivity: (activity) => this.noteActivity(key, activity)`, where `key` is the same
  `agentKey(room.id, target.authorId)` the claim is stored under. An aside turn holds a real claim in a
  real checkout, so it reports like any other.

- The new method:

  ```ts
  /**
   * Take in what a turn says it is doing, and decide whether the room hears it now.
   *
   * **A new reading is throttled; a CLEAR never is.** Exactly the shape the
   * projector uses for the same fact and for the same reason (its own doc at
   * `ACTIVITY_FANOUT_THROTTLE_MS`): a busy turn starts tools several times a
   * second, and every publish here is a frame on every open reader of this room
   * plus a change to a store four client hooks are watching. Clearing is never
   * delayed because a verb that outlives its turn is the one thing this feature
   * must not do.
   *
   * The trailing flush is what keeps the throttle honest: without it the LAST
   * tool of a burst would wait for the ten-second republish, and the lane would
   * name a tool the agent finished nine seconds ago.
   *
   * A repeat of the reading already published is dropped outright — the same
   * tool on the same target is not a change, and republishing it would restart
   * nothing and cost a frame.
   */
  private noteActivity(key: string, activity: SessionActivity | null): void;
  ```

  Behaviour, in order:
  1. No claim under `key` (released, halted, or never taken) → return. A turn that outlives its claim
     says nothing.
  2. `activity === null` → clear `claim.activity`, cancel any armed flush, publish immediately, stamp
     `activityPublishedAt`. Skipped entirely if `claim.activity` was already `undefined`.
  3. Deep-equal to `claim.activity` (`toolName` and `target` both) → return.
  4. Set `claim.activity`. If `now - claim.activityPublishedAt >= ACTIVITY_FANOUT_THROTTLE_MS`,
     publish and stamp. Otherwise arm a trailing `setTimeout` for the remainder (`unref`'d) that
     publishes whatever `claim.activity` is when it fires and stamps.

- `publishPresence(claim, state)` (`:2239`) carries it:

  ```ts
  this.deps.publishPresence(claim.roomId, claim.authorId, {
    state,
    entryId: claim.entryId,
    since: claim.claimedAt,
    ...(claim.activity ? { activity: claim.activity } : {}),
  });
  ```

  So **every** publish is self-contained, exactly as `since` already is: the claim frame, the
  `working_late` frame, each ten-second republish and the `done` all carry whatever is current. A
  client that connects mid-turn sees the verb on its first frame.

- `releaseClaim` (`:2144`) clears the armed flush before it deletes the claim, in the same block that
  stops the republish timer. A timer holding a released claim is a publish for work that is over.
  `halt` releases through the same seam and inherits this.

- `PRESENCE_REPUBLISH_MS` is unchanged. The republish already reads `claim.pastDeadline`; it now reads
  `claim.activity` from the same place, so "this is still true" and "something happened" keep answering
  from one source.

### 2.4 What the aside and the busy path show

Unchanged in shape. A welcome-back aside reports activity like any other turn (it holds a claim and is
real work). A busy refusal never runs a turn, so it never reports one, and its indicator appears and
resolves into the `agent_busy` notice with no verb — which is correct, because there is nothing it was
doing.

## 3. The client: one table, three framings

### 3.1 `ACTIVITY_PHRASES` becomes clauses

`apps/client/src/layers/shared/lib/tool-labels.ts`. `ActivityPhrase`'s two members become **lowercase
clauses that follow "is"**, and every existing session label is recovered by capitalising the first
character and appending an ellipsis.

```ts
/**
 * How one tool is phrased, with and without its target — as a CLAUSE.
 *
 * Lowercase and un-punctuated because two surfaces need two grammars from one
 * entry: a session's status line says "Reading standup.md…" and a room's lane
 * says "Kai is reading standup.md". Storing the session's framing and stripping
 * it back would be a second, lossier table.
 *
 * Both forms are still written out rather than derived: the honest generic is
 * rarely the specific clause with the noun removed ("editing a file" is not
 * "editing", "searching the web" is not "searching the web for").
 */
interface ActivityPhrase {
  withTarget: (target: string) => string;
  bare: string;
}

const ACTIVITY_PHRASES: Record<string, ActivityPhrase> = {
  bash: { withTarget: (t) => `running ${t}`, bare: 'running a command' },
  shell: { withTarget: (t) => `running ${t}`, bare: 'running a command' },
  read: { withTarget: (t) => `reading ${t}`, bare: 'reading a file' },
  write: { withTarget: (t) => `writing ${t}`, bare: 'writing a file' },
  edit: { withTarget: (t) => `editing ${t}`, bare: 'editing a file' },
  applypatch: { withTarget: (t) => `editing ${t}`, bare: 'editing a file' },
  notebookedit: { withTarget: (t) => `editing ${t}`, bare: 'editing a notebook' },
  glob: { withTarget: (t) => `looking for ${t}`, bare: 'looking through files' },
  grep: { withTarget: (t) => `searching for ${t}`, bare: 'searching the code' },
  websearch: { withTarget: (t) => `searching the web for ${t}`, bare: 'searching the web' },
  webfetch: { withTarget: (t) => `reading ${t}`, bare: 'reading a web page' },
  task: { withTarget: (t) => `running an agent: ${t}`, bare: 'running an agent' },
  skill: { withTarget: (t) => `using the ${t} skill`, bare: 'using a skill' },
  todowrite: { withTarget: () => 'updating its task list', bare: 'updating its task list' },
};
```

One new export, the shared rung:

```ts
/**
 * What a session is doing, as a clause that follows "is" — or `null` when
 * nothing is known.
 *
 * The five-rung ladder `formatActivityLabel` documented, moved down one level so
 * two framings can share it. The bottom rung is `null` rather than "working":
 * "working" is the SESSION's honest floor, and the ROOM's floor is its own
 * sentence ("Kai is working on it"), so the fallback belongs to each caller.
 */
export function activityClause(activity: SessionActivity | null | undefined): string | null;
```

Rungs, unchanged in order: recognised tool with target → recognised tool bare → `Using {serverLabel}`
lowercased for an MCP name → `using {toolName}` for anything unseen → `null`.

`formatActivityLabel` becomes its one in-file caller:

```ts
export function formatActivityLabel(activity: SessionActivity | null | undefined): string {
  const clause = activityClause(activity);
  return clause === null ? 'Working…' : `${clause[0]!.toUpperCase()}${clause.slice(1)}…`;
}
```

**Every shipped session label is byte-identical after this**, with exactly one deliberate exception:
`Task` with a description now reads `Running an agent: review the diff…` where it read
`Running an agent — review the diff…`. The em dash goes because these clauses are now printed as
user-facing sentences in a room, and `writing-for-humans` rules it out. This is named here so the
pinning test in §6 can be exact rather than approximate.

### 3.2 The two room framings

`apps/client/src/layers/shared/lib/activity-verb.ts` gains two exports beside `activityVerb`:

```ts
/**
 * The clause a room's sentence puts after "is" — `reading standup.md`.
 *
 * Re-exported from the rung rather than re-derived, so the room lane and the
 * session lane cannot describe one tool call two ways (BC-37). `null` means the
 * caller should say its own less specific truth, never that it should invent one.
 */
export { activityClause } from './tool-labels';

/**
 * The same reading as a standalone line — `Reading standup.md`.
 *
 * Capitalised and WITHOUT the trailing ellipsis the session's status line
 * carries: the ellipsis says "this line is a status that keeps moving", which is
 * true of a strip that is always on screen and false of a row inside a card
 * somebody opened on purpose.
 */
export function activitySentence(activity: SessionActivity | null | undefined): string | null;
```

`shared/lib/index.ts:249` re-exports both from `./activity-verb`, never from `./tool-labels`.

### 3.3 The one-verb guard is extended, not left behind

`apps/client/src/layers/shared/lib/__tests__/one-verb-source.test.ts` currently guards one name.
`activityClause` is now a second way to reach the rung, so it joins the guarded set:

- The detector's name check becomes a set — `formatActivityLabel` and `activityClause` — and
  `MAY_NAME_THE_RUNG` gains nothing (the same four files may name either).
- `MAY_REACH_TOOL_LABELS` is unchanged: the barrel may still pass `getToolLabel` through, and may not
  pass either rung name.
- The executable escape samples gain the shapes for the new name, so the guard's own proof stays as
  strong for it as for the old one.

This is what stops the intended reuse from silently becoming the drift the test exists to prevent.

## 4. The target stops at the operator's cockpit

Three consumers of a presence publish exist. Exactly one gets the target.

| Consumer                                                                            | Verb | Target | Why                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The room's own stream (`RoomBroadcaster.publish` → `GET /api/rooms/:id/events`)     | yes  | yes    | This is the operator's cockpit, and the same person's session pane already shows them the identical string.                                        |
| The chat-bridge presence forwarder (`RoomService.onSignalPublished`)                | yes  | **no** | A bridged chat is other people's surface. The waiting notice already refused to put "file paths and commands included" in front of everybody else. |
| The `CommunityAdapter` port (`toCommunitySignal` → another community's subscribers) | yes  | **no** | Same audience argument, plus the port's payload is a capability floor for backends DorkOS does not own.                                            |

Implementation, both producer-side:

- `packages/shared/src/room-schemas.ts` gains one pure helper beside the payload type:

  ```ts
  /**
   * The same presence, with the one field that names a person's work removed.
   *
   * The verb survives ("running a command", "reading a file"); the file name, the
   * command excerpt, the search pattern and the host do not. What is left is the
   * shape of the work rather than its content, which is the most any audience
   * beyond this cockpit is owed.
   *
   * A function rather than a comment on each call site because there are two call
   * sites today and the third one somebody adds is the one that would forget.
   */
  export function withoutActivityTarget<T extends { activity?: SessionActivity }>(payload: T): T;
  ```

- `RoomService.publishSignal` (`room-service.ts:2909-2911`) hands the listener
  `presence && withoutActivityTarget(presence)`. The broadcast above it is untouched.

- `local-projection.ts`'s `toCommunitySignal` maps the presence payload field-by-field today and
  simply does not carry `activity`. That is the correct behaviour and it is currently an accident of
  omission, so it gets a comment saying it is a decision and a test that fails if it starts carrying
  one. `toRoomPresence` (inbound, from a remote community) likewise does not read one: a remote
  backend cannot claim a verb DorkOS's claim map did not produce, which is the same claim-gating gap
  `LocalCommunityAdapter.publishSignal` already documents about itself.

- `CommunityPresencePayloadSchema` gains **no field**. A port change is a conformance-suite change and
  a promise to every future adapter; there is nothing a community backend could honestly do with a
  verb today, and adding the field would be the first half of a leak somebody completes later.

`contributing/adding-a-community-adapter.md` gets a short paragraph stating the rule, and
`.claude/rules/room-conduct.md`'s presence bullet gains one sentence, so the next person meets it
before writing the third projection.

## 5. The rendering

### 5.1 The store carries it

`apps/client/src/layers/entities/room/model/use-room-presence.ts`:

- `PresenceRecord` gains `activity?: SessionActivity`, written by `observe` from the frame.
- `RoomPresenceAuthor` and `RoomPresenceClaimRow` carry it (the latter by `Omit<…, 'elapsedMs'>`, so it
  arrives for free).
- `summarize` already picks each author's OLDEST live claim; it carries that claim's `activity`. No new
  choice is made — the claim that speaks for an agent already speaks for it, and reading a second
  claim's verb onto the first claim's row would be exactly the inconsistency the existing doc warns
  about for `entryId`.
- Nothing about the TTL, the pruning, `clearAuthor` or `clearRoom` changes.

Why the churn is bounded, stated where a reader will look: the frames arrive at most once per
`ACTIVITY_FANOUT_THROTTLE_MS` per claim (§2.3), so `useRoomPresenceAuthorIds`,
`useRoomPresenceEverywhere` and `useRoomWorking` — the three readers that do not draw a verb — re-run
their memos at most that often while an agent is working, and none of them re-renders on a clock.

### 5.2 The lane says one thing and announces another

`apps/client/src/layers/features/conversation/model/lane-state.ts`:

- `LanePresenceAuthor` gains `activity: SessionActivity | null`.
- `LaneState`'s `presence` member gains one field:

  ```ts
  | {
      kind: 'presence';
      /**
       * The verb-free sentence. What the live region says and what the crossfade
       * is keyed on — deliberately NOT what is drawn when a glimpse is known.
       * A sentence that changed every two seconds would re-read itself at a
       * screen reader and re-play a fade at everybody else, for a fact nobody
       * asked to be interrupted about.
       */
      sentence: string;
      /**
       * What is DRAWN. Equal to `sentence` unless exactly one agent is working,
       * the room is still waiting for it, and the room has heard what it is
       * doing — in which case it is "Kai is reading standup.md".
       */
      line: string;
      authorIds: readonly string[];
      since: string;
      late: boolean;
    }
  ```

- `presenceRung` gains the composition and nothing else:

  ```ts
  const glimpse =
    presence.length === 1 && oldest.state === 'working' ? activityClause(oldest.activity) : null;
  const line = glimpse === null ? sentence : presenceActivitySentence(oldest.name, glimpse);
  ```

  **One agent only**, because the lane is one line that never wraps and "Kai and Ana are working on
  it" cannot carry two verbs — picking one to speak for both is a lie about the other, and the peek is
  where a per-agent answer belongs. **`working` only**, because `working_late`'s sentence already
  truncates on a 375 px screen and its long-wait clause is the one actionable thing in it; the peek
  still shows a late agent's verb, where there is a second line for it.

`apps/client/src/layers/entities/room/lib/presence-copy.ts` gains the copy, beside its siblings:

```ts
/**
 * What the line says when the room knows what one agent is doing.
 *
 * The plainest true sentence: a name, "is", and the clause the tool table
 * produced. No ellipsis and no "on it" — "Kai is reading standup.md" is already
 * a complete thought, and the elapsed time follows it the way it follows every
 * other form here.
 *
 * @param name - The agent's display name.
 * @param clause - What it is doing, as a clause that follows "is".
 */
export function presenceActivitySentence(name: string, clause: string): string {
  return `${name} is ${clause}`;
}
```

`apps/client/src/layers/features/conversation/ui/LaneContent.tsx`:

- `PresenceLine` draws `state.line`.
- `laneAnnouncement` keeps returning `state.sentence`. Unchanged code, restated in its doc as a
  decision rather than an accident.
- `laneMotionKey` keeps returning `presence:${state.sentence}`. Same.
- The `data-testid={PRESENCE_TESTID[scope]}` node keeps wrapping the words and the elapsed reading and
  nothing else, so the shipped browser suites keep reading one exact string.

### 5.3 The peek gets its own line

`apps/client/src/layers/features/conversation/ui/LivePeek.tsx`:

- `LivePeekRow` gains:

  ```ts
  /**
   * What this agent is doing, already in words — "Reading standup.md" — or
   * `null` when the conversation has not heard a tool call for it.
   *
   * Its own line rather than a fourth segment on the name row: that row is
   * already name · state · elapsed and a fourth part truncates on a phone. The
   * peek is opened on purpose to ask this, so it can afford the line.
   */
  doing: string | null;
  ```

- Rendered between the name row and "Replying to …":

  ```
  [face]  Meeting Notes · working · 1m 04s
          Reading standup.md
          Replying to “can you log today’s decisions?”
          [ Open its session → ]  [ Stop ]
  ```

  Shown for `working` **and** `working_late` — unlike the lane, and for the reason the lane declines
  it: there is room here, and a person who opened the peek on a twelve-minute turn is asking exactly
  this question. Styled as the "Replying to …" line is (`text-xs`, `text-muted-foreground`), truncating,
  and not a button: there is nowhere to go.

`apps/client/src/layers/widgets/room-view/ui/RoomLiveLane.tsx` is the one host that joins them:

- `presence` maps `activity: claim.activity ?? null` onto each `LanePresenceAuthor`.
- `peekRows` maps `doing: activitySentence(claim.activity)`.

The session surface's own lane is untouched: `capabilities.presence` is off there, and its
`turn-streaming` rung has carried a verb since BC-37.

## 6. Testing Strategy

Every test below names what change to the product makes it red.

### Unit — shared (`packages/shared`)

`packages/shared/src/__tests__/room-schemas.test.ts` (existing file):

- **`RoomSignalEventSchema` round-trips a presence frame carrying an activity.** Red if the field is
  dropped from the schema or typed non-optionally.
- **`withoutActivityTarget` keeps `toolName` and drops `target`, and returns the payload unchanged when
  there is no activity at all.** Red if the helper starts stripping the verb, or starts minting an
  empty `activity: {}` for a payload that had none.

### Unit — server

`apps/server/src/services/rooms/__tests__/room-presence-claims.test.ts` (existing file — it is where
the claim map's publishing is already pinned):

- **A tool call inside a room turn publishes a presence frame carrying that tool.** Drive a
  `FakeAgentRuntime` turn through the room dispatcher with a scripted `tool_call`, assert the published
  payload is `{ state: 'working', activity: { toolName: 'Read', target: 'standup.md' } }`. Red if the
  runner stops reporting, or the claim stops carrying, or `publishPresence` stops spreading.
- **A second tool call inside the throttle window does not publish, and the trailing flush does.**
  Fake timers. Two calls 100 ms apart, assert one publish; advance to `ACTIVITY_FANOUT_THROTTLE_MS`,
  assert a second publish carrying the SECOND tool. Red if the throttle is removed (two immediate
  publishes) or if the trailing flush is dropped (the second tool never reaches the wire, which is the
  stale-lane bug this design exists to avoid).
- **A repeat of the same reading publishes nothing.** Red if the deep-equality check goes.
- **The clear is not throttled.** A tool call, then a `turn_end` 100 ms later; assert the clear frame
  is published immediately and carries no `activity`. Red if clearing is routed through the throttle.
- **The ten-second republish carries the current reading.** Advance to `PRESENCE_REPUBLISH_MS`, assert
  the republished frame carries the activity. Red if `publishPresence` reads the claim's activity only
  on the transition path — which is the cold-connect hole.
- **A released claim publishes nothing afterwards.** Arm a trailing flush, release the claim, advance
  time, assert no frame. Red if `releaseClaim` forgets to clear the timer — a publish for work that is
  over, and the one leak a per-claim timer can cause.
- **A halted turn's late tool calls reach nothing.** `halt` releases through the same seam; red if a
  path is added that deletes from the claim map directly.

`apps/server/src/services/rooms/__tests__/room-service.test.ts`:

- **The bridge forwarder receives the verb and never the target.** Register a listener via
  `setSignalListener`, publish presence carrying `{ toolName: 'Read', target: 'standup.md' }`, assert
  the listener saw `toolName` and no `target` — and that the room's own broadcast in the SAME publish
  still carried it. Red if the strip is dropped, and red if somebody "fixes" it by stripping both.

`apps/server/src/services/communities/local/__tests__/local-community-adapter.test.ts` (there is no
`local-projection.test.ts`; the projection is covered from the adapter's own suite, which is also
where the round trip through a real room is already pinned):

- **`toCommunitySignal` carries no activity, target or otherwise.** Publish presence carrying a full
  reading through the room's own producers and assert the frame a port subscriber receives has no
  `activity` on its payload. Red the moment somebody completes the projection out of tidiness. This is
  the test that turns a decision into a guarantee.

`apps/server/src/services/rooms/__tests__/room-turn-runner.test.ts`:

- **Activity is bounded to the turn's own stream.** Feed a `tool_call` BEFORE this turn's `turn_start`
  and assert nothing is reported; feed one inside and assert it is. Red if the `started` guard is
  moved, which would let a neighbouring turn's tool name a different agent's work.

**Seeded defect, run before the tests are trusted:** change `deriveSessionActivity`'s path rule from
`basename` to the raw path and confirm the claims test goes red naming the target. That proves the
assertion reads the derived value rather than a value the test seeded.

### Unit — client

`apps/client/src/layers/shared/lib/__tests__/tool-labels.test.ts`:

- **The label pin.** A table of every entry in `ACTIVITY_PHRASES` plus the MCP, unknown and null rungs,
  asserting `formatActivityLabel` produces the exact string it produced before the refactor —
  thirteen rows unchanged and the one `Task` row carrying its new colon. **Write this test and watch it
  pass against `main` BEFORE the refactor**; that is the only thing that makes it evidence rather than
  a restatement of whatever the new code does.
- **`activityClause` returns `null` for no reading**, where `formatActivityLabel` returns `Working…`.
  Red if the room's fallback is silently changed to the session's.

`apps/client/src/layers/shared/lib/__tests__/one-verb-source.test.ts`:

- **The detector catches `activityClause` in each of the seven escape shapes it already proves for
  `formatActivityLabel`** (named import, wrapped, one-name re-export, namespace import, namespace
  re-export, dynamic import, dynamic namespace). Red if the guard is extended by name in the allowlist
  but not in the detector.

`apps/client/src/layers/features/conversation/model/__tests__/lane-state.test.ts`:

- **One working agent with a known reading draws the verb and announces the sentence.** Assert `line`
  is `Kai is reading standup.md` and `sentence` is `Kai is working on it` in the same object. Red if
  the two collapse into one field, which is the change that would make the announcer chatty.
- **Two agents keep the plain sentence in both fields**, even when the oldest has a reading. Red if the
  one-agent rule is dropped.
- **`working_late` keeps the plain sentence in both fields.** Red if the state rule is dropped.
- **No reading falls back to the plain sentence.** Red if a fallback verb is invented.

`apps/client/src/layers/features/conversation/__tests__/LiveLane.test.tsx` (the existing home for the
lane's rendering and its announcer; there is no `ui/__tests__/` under this slice):

- **`laneAnnouncement` returns the verb-free sentence for a presence state whose `line` carries a
  verb**, and **`laneMotionKey` is unchanged across two states that differ only in `line`.** Both red
  if the drawn string is wired into either. These two are the accessibility contract in executable
  form.

`apps/client/src/layers/entities/room/model/__tests__/use-room-presence.test.tsx`:

- **A frame's activity reaches the summarised row, and the OLDEST claim's is the one that does.** Two
  claims for one author with different tools; assert the older claim's tool is on the row. Red if the
  collapse picks the newer.
- **A frame with no activity clears the row's reading** rather than leaving the previous one standing.
  Red if `observe` merges instead of replacing — the stale-verb bug in its client half.

`apps/client/src/layers/features/conversation/__tests__/LiveLane.test.tsx` (the peek is drawn from the
lane and is covered there):

- **A peek row with `doing` draws it; a row without draws no empty line.** Red if `null` renders an
  empty node, which would shift the card.

### Browser (`apps/e2e`)

One spec, because the composition of "server frame → store → the words on screen, with the live region
staying still" is a thing only a browser can settle.

`apps/e2e/tests/rooms/room-presence.spec.ts` gains a case, and `apps/e2e/tests/rooms/room-signals.ts`'s
`PresenceSignal` gains an optional `activity`:

- Publish `working` with `{ toolName: 'Read', target: 'standup.md' }`; assert the lane reads
  `Ana is reading standup.md` and that the announcer node still reads `Ana is working on it`.
- Publish a second frame with `{ toolName: 'Bash', target: 'pnpm test' }`; assert the lane now reads
  `Ana is running pnpm test` **and that the announcer node's text has not changed** — the assertion
  that could not be made in jsdom, and the whole reason this leg exists.
- Open the peek; assert the row carries `Reading standup.md` under the name.

The suite's existing cases publish signals with no activity and therefore keep passing unmodified,
which is a property of the design rather than luck: an absent reading falls through to today's
sentence.

## 7. User Experience

- A person posts in a room. Within a second the lane reads `Kai is working on it`. As soon as the turn
  reaches its first tool it becomes `Kai is reading standup.md`, then `Kai is running pnpm test`, and
  the elapsed time appears beside it at ten seconds as it does today.
- Two agents pick the message up: the lane goes back to `Kai and Ana are working on it`. Opening the
  peek shows both, each with its own verb, its own elapsed time and its own "Replying to …".
- Twelve minutes in, the lane reads `Kai is still working — this is taking longer than usual · 12m`.
  The peek still says what it is doing.
- A screen-reader user hears "Kai is working on it" once, and hears nothing further until who is
  working changes or the wait goes long. Nothing on this surface reads a tool name aloud.
- A turn that never reaches a tool — a short answer, a refusal, an agent that is thinking — shows
  today's sentence for its whole life. Nothing is missing; there was nothing to say.

## 8. Performance Considerations

- **Wire.** At most one extra presence frame per claim per two seconds while a turn is running,
  delivered to the readers of one room. The frame grows by at most `toolName` plus a target already
  capped at 40 characters.
- **Server.** One deep comparison and at most one armed timer per live claim. Both are freed at
  release, in the same block that already frees the republish timer.
- **Client.** The presence store changes at most once per two seconds per claim, which bounds the
  re-render cost for the three hooks that read it without drawing a verb. The announcer and the
  crossfade are deliberately not driven by the verb, so the two most expensive reactions to a change
  do not fire at all.

## 9. Security Considerations

- **The target is a person's work.** It is a basename, a command's first line, a search pattern or a
  host. §4 keeps it inside the operator's own cockpit by stripping it at both outbound projections,
  and pins both with tests. `CommunityPresencePayloadSchema` gains no field, so a future adapter cannot
  carry it by accident.
- **Nothing new is derived.** The target is the same value `deriveSessionActivity` already produces for
  the session pane, with the same truncation. This adds a consumer, not a disclosure surface.
- **Nothing model-facing changes.** No tool sets or reads presence; `room_context.working` still
  carries `{ authorId, since }` only. Etiquette E16a's exemption stays exactly as wide as the
  mechanism.
- **The diagnostic read is untouched.** `ActiveClaimView` remains ids, a timestamp and a duration.

## 10. Documentation

- `changelog/unreleased/<id>-presence-verb-glimpse.md` — one fragment, in plain words: rooms now say
  what an agent is doing, not just that it is doing something.
- `.claude/rules/room-conduct.md` — one sentence on the presence bullet: the indicator may carry what
  the turn is doing, and the argument it names never leaves this cockpit.
- `contributing/adding-a-community-adapter.md` — one short paragraph in the signals section: presence
  crossing the port carries the verb and never the target, and the port's payload has no field for one.
- `specs/unified-conversation/04-implementation.md` — item 4 of "What Was Deliberately Not Done" is
  updated to point here rather than left reading "Unchanged".

## 11. Implementation Phases

**One PR.** The wire field, the producer, the two strips, the shared table refactor and the two
renderings are one behaviour; any split ships either a field nothing writes or a client reading a field
nobody sends. Suggested order inside it, so the tree is coherent at every commit:

1. The client-side label pin test, run green against the current table. (Evidence first — this is the
   only moment it can be gathered.)
2. `ACTIVITY_PHRASES` → clauses, `activityClause`, `activitySentence`, the barrel, the extended
   one-verb guard.
3. The schema field, `RoomPresencePayload`, `withoutActivityTarget`.
4. The port callback, the runner's report, the claim's fields, the dispatcher's throttle and publish.
5. The two strips and their tests.
6. The store, the lane state, `presenceActivitySentence`, `LaneContent`, `LivePeek`, `RoomLiveLane`.
7. The browser case, the docs, the fragment.

## 12. What is not done

1. **An agent reading a room's event stream still sees whatever the frame carries.** No reader-side
   redaction is built, because no agent subscribes to `GET /api/rooms/:id/events` today — an agent's
   whole hand in a room is four tool verbs and none of them reads presence. If an agent-facing room
   stream is ever added, the glimpse's target is the first thing it has to decide about, and the
   predicate to reuse is `presentsAgentIdentity` (`middleware/agent-identity.ts`), the same one
   `GET /api/rooms/:id/sessions` refuses on.
2. **No verb reaches a bridged chat or a community**, beyond the bare tool name on the forwarder. Both
   would need their own native idiom (Telegram has only `sendChatAction`), which room-presence §7 owns.
3. **The sidebar stays a count.** No per-room verb on the global fan-out.
4. **No verb while a claim is `held`** (DOR-1345's fourth state, not yet in this tree). A held claim is
   not running a turn, so it has nothing to report; when that state lands it falls through to the plain
   sentence with no change here.
5. **No verb in the lane for two or more agents, and none while `working_late`.** Both are §5.2's
   decisions, both are reversible without a wire change, and the peek covers both cases today.
6. **No history.** The glimpse is the current tool and nothing else; "read 12 files, ran 3 commands"
   is a retrospective summary (`research/20260316_subagent_activity_streaming_ui_patterns.md` §4) and a
   different feature on a different surface.
7. **No new setting.** The throttle reuses the projector's constant and is not configurable, on the
   same grounds `WAITING_NOTICE_GRACE_MS` is not: it changes how chatty one indicator is, never what
   the room does, and there is no honest guidance to give somebody tuning it.

## Open Questions

None open. The two product-level calls are resolved with defaults chosen and recorded:

- ~~**Does a room show the target at all, given the waiting notice refuses to?**~~ **(RESOLVED —
  default chosen: yes, in the operator's own cockpit, and nowhere else.)** _Answer:_ the lane and the
  peek carry it; the bridge forwarder and the community port do not. _Rationale:_ the notice's rule is
  about a **shared, durable** record read by people who are not the operator. The room lane today is
  this operator's cockpit, the same person's session pane already shows them the same string, and the
  reading is ephemeral and expires in 30 seconds. Where the audience genuinely widens — a bridge, a
  community — the notice's rule applies unchanged and §4 enforces it at the producer.
- ~~**Is a verb change an announcement?**~~ **(RESOLVED — default chosen: no.)** _Answer:_
  `laneAnnouncement` and `laneMotionKey` keep reading the verb-free sentence. _Rationale:_ the lane's
  own contract, design-system §Zones ("one live region, counts only"), and the arithmetic — a turn that
  starts a tool every two seconds would re-read the region 300 times in ten minutes.

## Related ADRs

- Draft, extracted from this spec: `decisions/260819-022127-presence-glimpse-boundary.md` (proposed) —
  a presence glimpse carries structure, not prose, and its target stops at the operator's cockpit.
- ADR 260726-170125 — no arbitration in rooms (why the verb does not reach `room_context.working`).
- ADR 260726-170127 — a refusal is visible (why an absent reading falls back rather than blanking).
- ADR-0264 — the durable session stream the glimpse is read off.
- ADR-0273 — structured context injection, the same "structure over prose" instinct on the inbound side.

## References

- `specs/room-presence/02-specification.md` §1, §3.2, §3.3, §5.1, §5.4, §6, §7, Non-Goals, §15.
- `specs/unified-conversation/02-specification.md` §5.2, §5.3, §5.4, §5.6;
  `04-implementation.md`:748, :780.
- `meta/agent-etiquette.md` §5 (E16, E16a), §9, §10.
- `.claude/rules/room-conduct.md` — "an indicator releases into something durable", and the known gap
  that room presence reaches the cockpit and stops there.
- `contributing/design-system.md` §Zones, §Motion.
- `research/20260729_buzz-presence-signals.md`:135 — Buzz's unified working signal carries scope and a
  turn anchor, no verb.
- `research/20260316_subagent_activity_streaming_ui_patterns.md` §4 — tool bucketing, considered for a
  retrospective summary and not adopted here.
