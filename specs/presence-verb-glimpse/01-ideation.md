---
slug: presence-verb-glimpse
id: 260819-023726
created: 2026-08-18
status: ideation
tracker: DOR-1351
project: Unified Conversation Surfaces
---

# Presence tier 3: the live lane says what the agent is doing

**Slug:** presence-verb-glimpse
**Author:** Claude (IDEATE+SPECIFY author)
**Date:** 2026-08-18

---

## 1) Intent & Assumptions

- **Task brief:** A room's live lane says "Kai is working on it · 42s" and never what Kai is
  actually doing. The session lane, two panes away, has said "Reading standup.md…" since BC-37.
  Close the gap: carry the agent's current activity on the room presence signal, phrase it with the
  same vocabulary the session uses, draw it in the room lane and in the live peek, and keep the
  screen-reader announcement as still as it is today. This is "presence tier 3", item 4 of
  `specs/unified-conversation`'s "What is not done".

- **Assumptions**
  - Presence stays **mechanical**: published only by `RoomTriggerDispatcher`'s claim lifecycle
    (room-presence §1). Nothing here gives a model a way to say what it is doing.
  - The room stream's audience today is **the operator's own cockpit**. Agents reach rooms through
    four tool verbs (`post_to_room`, `react_to_room_entry`, `read_room_history`,
    `search_room_history`), none of which reads presence, and no bridge forwarder is wired
    (`RoomService.setSignalListener` has no caller in production).
  - `SessionActivity` is genuinely cross-runtime. All three production runtimes feed the projector
    a `tool_call` carrying `toolName` + `input` (verified below), so the glimpse is not a
    claude-code-only feature with a silent hole under codex and opencode.
  - DOR-1345's fourth presence state (`held`) is **not in this tree yet** — `RoomPresenceStateSchema`
    is still `working | working_late | done` and `RoomSignalEvent` has no `heldBehind`. This work is
    additive to that schema and does not block on it.

- **Out of scope**
  - Any change to who runs a turn, to arbitration, or to the claim lifecycle itself.
  - A verb on the sidebar's `room_presence` fan-out. It stays a count (room-presence §6).
  - A verb in `room_context.working`, the roster block an agent reads. Telling agent B what agent A
    is doing is one short step from the arbitration this domain has declined twice
    (ADR 260726-170125).
  - A verb in any durable room entry or notice. The waiting notice's deliberate vagueness stays
    exactly as it is (`notice-copy.ts`, DOR-784).
  - Human typing indicators, read receipts, streaming partial reply text — all still room-presence
    non-goals.
  - Per-agent Stop (already filed separately).

## 2) Pre-reading Log

Everything below was opened at `d7e4768e6`; every line number was read, not inherited.

**The wire and the server**

- `packages/shared/src/session-stream.ts:126-157` — `SessionActivitySchema { toolName, target? }` and,
  more useful than the schema, the paragraph above it: **"No prose rides the wire — the client owns
  the wording, so a reading minted by an older server never puts stale copy on a newer screen."**
  This is the sentence that decides the whole design. `toolName` is verbatim per runtime, on purpose.
- `apps/server/src/services/session/activity/derive-activity.ts` — the one pure function that turns a
  tool call into `{ toolName, target? }`. `TARGET_RULES` is keyed **lowercased** so `Bash`/`bash`/`Shell`
  all land; `path → basename`, `text → first non-empty line`, `host → URL hostname`; codex's
  `ApplyPatch` reads `changes[0].path`; everything truncates at `ACTIVITY_TARGET_MAX_LENGTH = 40`.
  So the target is already the "one human-relevant argument", already reduced, already bounded.
- `apps/server/src/services/session/session-state-projector.ts:855` — `case 'tool_call':
this.status.activity = deriveSessionActivity(event.toolName, event.input)`; `:812/:822/:862/:1347`
  are the clears (turn end, error, and idle). `:117-130` — `ACTIVITY_FANOUT_THROTTLE_MS = 2_000`,
  with the reason written out: a busy turn starts tools several times a second, and **new** activity
  is throttled while **clearing** one is never delayed.
- `packages/shared/src/room-schemas.ts:1352-1503` — `RoomPresenceStateSchema`, `RoomSignalEventSchema`
  (`state`, `entryId`, `since`, all optional), and `RoomPresencePayload =
Required<Pick<RoomSignalEvent, 'state'|'entryId'|'since'>>` with its long note on why the producer
  is held to all three while the port's caller is not.
- `apps/server/src/services/rooms/room-trigger.ts:327` (`PRESENCE_REPUBLISH_MS = 10_000`),
  `:2044-2071` (`holdClaim` publishes `working` and starts the loop), `:2144-2172` (`releaseClaim`
  publishes `done` and stops it), `:2192-2208` (`republishPresence`, one frame per claim plus one
  working-count per room), `:2228-2245` (`publishPresence`, and why `since` is the claim's own start
  on every publish), `:1379-1388` (the wait deadline sets `pastDeadline` and publishes `working_late`
  once).
- `apps/server/src/services/rooms/room-claims.ts:57-131` — `ActiveClaim`. Everything a claim knows.
- `apps/server/src/services/rooms/room-turn-port.ts:69-95` — `RoomTurnRequest.onWaiting`, the exact
  precedent for reporting a **state while it is still true** rather than an outcome. This is the seam
  the glimpse rides.
- `apps/server/src/services/rooms/room-turn-runner.ts:557-670` — `collectReply`. It already reads
  every `tool_call` off the projector (`MESSAGE_BOUNDARY` at `:457` contains it), it is already
  bounded to its own turn at both ends (`:611-617`, `:640-644`), and it already has a callback that
  fires mid-turn. The glimpse costs one more `if` inside a loop that already runs.
- `apps/server/src/services/rooms/room-service.ts:2892-2919` — `publishSignal`. Two consumers:
  `this.broadcaster.publish` (the room's own stream) and `this.onSignalPublished`, the chat bridge's
  presence forwarder, **registered by nobody today** (`:2931-2942`, `setSignalListener`).
- `apps/server/src/services/communities/local/local-projection.ts:136-188` — `toCommunitySignal` and
  `toRoomPresence`, the two directions across the `CommunityAdapter` port.
- `apps/server/src/services/communities/local/local-community-adapter.ts:655-693` — `publishSignal`,
  with its own warning that this adapter is a second, roster-validated but **not claim-gated**,
  producer of presence.
- `apps/server/src/services/rooms/notices/notice-copy.ts:156-213` — the waiting notice, and the
  privacy precedent that governs this whole spec: the line "deliberately does NOT carry the tool name
  or the question: those live in the session, in front of the person who can act on them, and
  repeating them into a shared room would put one member's approval decision — file paths and
  commands included — in front of everybody else."
- `apps/server/src/routes/rooms.ts:175-224` — `GET /:id/sessions` and `presentsAgentIdentity`, the
  repo's current "is this caller a person" predicate.

**The client**

- `apps/client/src/layers/shared/lib/tool-labels.ts:158-225` — `ACTIVITY_PHRASES` and
  `formatActivityLabel`. **The tool→verb table the brief asked me to find already exists**, keyed
  lowercased, with a written-out `withTarget`/`bare` pair per tool and a five-rung honesty ladder.
- `apps/client/src/layers/shared/lib/activity-verb.ts` — `activityVerb(lifecycle, activity)`, the one
  entry point, with overloads that promise non-null for `streaming`/`blocked`.
- `apps/client/src/layers/shared/lib/__tests__/one-verb-source.test.ts` — a **source scan** that fails
  if any file outside a four-name allowlist names `formatActivityLabel` or imports `tool-labels`, in
  any import shape including namespace and dynamic. Adding a second phrasing entry point without
  extending this guard would quietly defeat it.
- `apps/client/src/layers/entities/room/lib/presence-copy.ts` — `presenceSentence`,
  `presenceCountSentence`, `presenceDetail`, `presenceRow`, `presenceElapsed`,
  `PRESENCE_NAME_LIMIT = 3`. "It always says **working**, never **typing**."
- `apps/client/src/layers/entities/room/model/use-room-presence.ts` — `PresenceRecord`, the
  `(authorId, entryId)` key, `PRESENCE_TTL_MS = 30_000`, `summarize` (collapse to one row per agent at
  the **oldest** claim), and four hooks that differ only in how much clock they hold. The doc comments
  on `useRoomPresenceAuthorIds` and `useRoomPresenceEverywhere` are an explicit warning: anything that
  changes on every publish re-renders every reader that holds it.
- `apps/client/src/layers/features/conversation/model/lane-state.ts` — `deriveLaneState`, the nine
  rungs, `presenceRung`, and `LaneState.presence { sentence, authorIds, since, late }`.
- `apps/client/src/layers/features/conversation/ui/LaneContent.tsx:75-126` — `laneAnnouncement`
  (presence announces `state.sentence`) and `laneMotionKey` (`presence:${state.sentence}`), plus the
  rule at the top of the file: everything that ticks is `aria-hidden`.
- `apps/client/src/layers/features/conversation/ui/LivePeek.tsx:25-52, 106-135` — `LivePeekRow` and the
  row layout: name · state · elapsed, then "Replying to …", then the actions.
- `apps/client/src/layers/widgets/room-view/ui/RoomLiveLane.tsx:150-248` — where claims become
  `LanePresenceAuthor[]` and `LivePeekRow[]`. The one host that would carry a new field.

**Tests and specs**

- `apps/e2e/tests/rooms/room-signals.ts` — `PresenceSignal` and the WebSocket shim that puts real
  presence frames on a real stream without a real model. Extending it is how the browser proof gets
  built for free.
- `apps/e2e/tests/rooms/room-presence.spec.ts:73` — asserts the lane reads exactly
  `${ana.name} is working on it`. It publishes signals **with no activity**, so it keeps passing
  unchanged; that is a fact worth stating rather than a coincidence to discover in CI.
- `specs/room-presence/02-specification.md` §3.2, §5.1, §5.4, §6, Non-Goals, §15.
- `specs/unified-conversation/02-specification.md` §5.2-§5.4 (the lane's rungs, the peek, the copy
  table) and `04-implementation.md`:748 ("No verb glimpse in a room. Unchanged.") and :780.
- `meta/agent-etiquette.md` §5 E16a — the exemption that lets this exist at all, and its exact width:
  "as wide as the mechanism and no wider".
- `.claude/rules/room-conduct.md` — "an indicator releases into something durable", and the known gap
  that room presence reaches the cockpit and stops there.
- `research/20260729_buzz-presence-signals.md:135` — Buzz drives one unified working signal from
  observer frames and falls back to bot typing; it carries channel scope and a turn anchor, no verb.
- `research/20260316_subagent_activity_streaming_ui_patterns.md:316-400` — tool-to-category bucketing
  and a two-tier summary. Useful for a _retrospective_ summary, not for a live one-line glimpse; noted
  and not adopted.

## 3) Codebase Map

- **Primary modules**
  - `packages/shared/src/room-schemas.ts` — the wire field.
  - `apps/server/src/services/rooms/room-turn-port.ts` + `room-turn-runner.ts` — where the turn's
    current tool becomes something the room can hear.
  - `apps/server/src/services/rooms/room-claims.ts` + `room-trigger.ts` — where it is held and
    published.
  - `apps/server/src/services/rooms/room-service.ts` + `services/communities/local/local-projection.ts`
    — the two outbound projections that must not carry the target.
  - `apps/client/src/layers/shared/lib/tool-labels.ts` + `activity-verb.ts` — the one verb table.
  - `apps/client/src/layers/entities/room/{model/use-room-presence.ts,lib/presence-copy.ts}` — the
    store and the copy.
  - `apps/client/src/layers/features/conversation/{model/lane-state.ts,ui/LaneContent.tsx,ui/LivePeek.tsx}`
    — the rendering.
  - `apps/client/src/layers/widgets/room-view/ui/RoomLiveLane.tsx` — the host that joins them.

- **Data flow**

  ```
  runtime tool_call ─▶ projector.subscribe (already read by collectReply)
        └─▶ deriveSessionActivity(toolName, input)          [server, reused verbatim]
              └─▶ RoomTurnRequest.onActivity(activity|null)  [new, mirrors onWaiting]
                    └─▶ claim.activity + throttled publishPresence
                          ├─▶ room stream  ─▶ presence store ─▶ lane / peek   [target kept]
                          ├─▶ onSignalPublished (bridge)                       [target stripped]
                          └─▶ toCommunitySignal (port)                         [target stripped]
  ```

- **Shared dependencies:** `SessionActivitySchema` (now on two wires), `deriveSessionActivity`
  (now on two producers), `ACTIVITY_FANOUT_THROTTLE_MS` (now the cadence for two fan-outs),
  `ACTIVITY_PHRASES` (now phrasing three framings).

- **Feature flags/config:** none. No new setting, no new threshold beyond one reused constant.

- **Blast radius:** the room lane, the room peek, the session lane's phrasing (must be byte-identical
  after the refactor), the community port's signal round trip, and one browser suite that gains a case.

## 4) Research

### Potential solutions

**1. Phrase the verb on the server and put the sentence on the wire** (the brief's literal reading:
"a small new field … a verb + target").
_Pros:_ one place decides the words; a non-cockpit consumer gets a ready sentence.
_Cons:_ it contradicts the sentence `SessionActivitySchema` was written around — "no prose rides the
wire, so a reading minted by an older server never puts stale copy on a newer screen". It would give
DorkOS two vocabularies for one fact (the session's structured one and the room's phrased one), and
`one-verb-source.test.ts` exists precisely because two vocabularies for one turn is the failure this
codebase has already been bitten by. Rejected.

**2. Carry the structured `SessionActivity` on the room presence signal and let the client phrase it
with the table it already owns.**
_Pros:_ one schema on two wires; one verb table for the session lane, the room lane and the peek;
the target is already reduced and truncated by `deriveSessionActivity`, so the room inherits the
session's privacy budget rather than inventing one; a client that does not recognise a tool degrades
down the same five-rung ladder it already uses.
_Cons:_ the client has to compose a second grammatical framing ("is reading standup.md" as well as
"Reading standup.md…"), which means refactoring `ACTIVITY_PHRASES` into clauses. That refactor must
not move a single shipped session string.
**Recommended.**

**3. Do not put activity on the presence signal at all; have the lane read the session's own status
by joining `GET /api/rooms/:id/sessions` to the fleet-wide session stream.**
_Pros:_ zero new wire fields.
_Cons:_ the peek's session-binding fetch is deliberately made only when the peek OPENS; making it a
room-mount dependency to feed the lane inverts that decision. It also joins two streams with two
different liveness models to answer one question, and the presence signal is the thing that is
already keyed, aged and cleared correctly. Rejected.

### Recommendation

Solution 2, with three shapes settled up front:

1. **The wire carries structure, the client carries words.** `RoomSignalEventSchema` gains one
   optional `activity`, typed as the existing `SessionActivitySchema`.
2. **The target stops at the operator's cockpit.** The verb may travel outward; the file name, the
   command and the search pattern may not. Enforced at the two producer-side projections, not by
   asking each consumer to behave.
3. **The glimpse changes what is DRAWN, never what is ANNOUNCED.** The live region keeps saying the
   verb-free sentence, and the crossfade keeps keying on it, so a chatty turn cannot turn a room into
   a siren or a strobe.

## 5) Decisions

Every routine call is resolved here. The two that are genuinely product-level are marked and carry a
chosen default.

| #   | Decision                                                     | Choice                                                                                                                                                                               | Rationale                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Phrased verb on the wire, or structured activity?            | **Structured.** `activity?: SessionActivitySchema` on `RoomSignalEventSchema`.                                                                                                       | `SessionActivitySchema`'s own doc forbids prose on the wire. Reusing the schema means one shape, one derivation, one client table, and a room can never disagree with a session about the same tool call.                                                                                                                                                                                       |
| 2   | Where does the tool→verb table live?                         | **It already lives in `shared/lib/tool-labels.ts`.** Refactor `ACTIVITY_PHRASES` from full sentences into lowercase clauses; `formatActivityLabel` composes the session's framing.   | The brief asked me to find it before writing a new one. It is there, it is keyed lowercased so every runtime's spelling lands, and `one-verb-source.test.ts` already guards it. A second table in `packages/shared` would be the exact drift that test exists to stop.                                                                                                                          |
| 3   | Does the server need the table too?                          | **No.** Nothing server-side phrases anything.                                                                                                                                        | Follows from #1. Keeps `packages/shared` free of copy and keeps the words in the layer that can change them without a version skew.                                                                                                                                                                                                                                                             |
| 4   | Publish cadence.                                             | **On change, leading-edge throttled at `ACTIVITY_FANOUT_THROTTLE_MS` (2 s) with a trailing flush; a CLEAR is never throttled; the 10 s republish always carries the current value.** | Exactly the shape and the constant the projector already uses for the same fact, argued in its own doc. The 10 s tick alone would leave the line naming a tool the agent finished nine seconds ago; unthrottled would re-render four presence hooks per tool call.                                                                                                                              |
| 5   | When is the glimpse cleared?                                 | **At `turn_end`, at `error`, and when the collector's ceiling aborts.** Mirrors the projector's clears.                                                                              | A verb that outlives its turn is the lie `activity-verb.ts` opens by naming. The claim is about to release anyway; clearing first means the last frame before `done` is honest.                                                                                                                                                                                                                 |
| 6   | Verb in the lane at more than one agent?                     | **No.** One named agent only; two or more keeps `presenceSentence` unchanged.                                                                                                        | The lane is one line that never wraps. "Kai and Ana are working on it" cannot carry two verbs, and picking one agent's verb to speak for both would be a lie about the other. The peek carries a verb per agent, which is what the peek is for.                                                                                                                                                 |
| 7   | Verb in the lane while `working_late`?                       | **No.** `working_late` keeps "Kai is still working — this is taking longer than usual" verbatim.                                                                                     | That sentence is the one actionable thing a waiting person reads, and it already truncates on a 375 px screen. A verb pushes the actionable half off the end. The peek still shows the verb for a late agent, where there is room for a second line.                                                                                                                                            |
| 8   | Does the announcer reword on a verb change?                  | **No.** `laneAnnouncement` keeps returning the verb-free `sentence`.                                                                                                                 | The lane's own rule (`LaneContent.tsx`, and design-system §Zones "one live region, counts only"). A live region re-read every two seconds is the siren both the sidebar contract and the unified-conversation spec forbid.                                                                                                                                                                      |
| 9   | Does the crossfade play on a verb change?                    | **No.** `laneMotionKey` keeps keying `presence:${sentence}`.                                                                                                                         | Same argument in the visual channel. `verbKey`'s trick was "animate on a real change"; a tool switching every two seconds is not the change the crossfade is for. The text swaps in place.                                                                                                                                                                                                      |
| 10  | Sidebar `room_presence`?                                     | **Unchanged. Stays a count.**                                                                                                                                                        | Room-presence §6 sized that event to a dot. A verb per room on the global fan-out is a per-tool-call broadcast to every client for every room, to feed a dot that has no room to draw it.                                                                                                                                                                                                       |
| 11  | Does the target leave the operator's cockpit?                | **No.** Stripped on the chat-bridge forwarder and absent from the community port projection. The verb (`toolName`) may travel.                                                       | The waiting notice already settled this argument for the durable case in the same product: repeating one member's file paths and commands into a shared room puts them in front of everybody else. Ephemeral does not make a path less of a path.                                                                                                                                               |
| 12  | Does an AGENT reading a room stream see the target?          | **PRODUCT-LEVEL (RESOLVED — default chosen: out of scope, stated).** No reader-side redaction is built.                                                                              | No agent subscribes to `GET /api/rooms/:id/events` today: an agent's whole hand in a room is four tool verbs, none of which reads presence, and `room_context.working` carries only `{authorId, since}`. A guard across two stream handlers with no reachable caller is drift risk without a reader. Recorded in "What is not done" as the first thing an agent-facing room stream must decide. |
| 13  | Does `room_context.working` gain a verb?                     | **No.**                                                                                                                                                                              | Telling agent B exactly what agent A is doing is the input to "don't duplicate it", which is one step from the scheduling this domain has declined twice. Presence for people; ids and starts for agents.                                                                                                                                                                                       |
| 14  | Where does the drawn sentence differ from the announced one? | **`LaneState.presence` carries both: `sentence` (announced, motion key) and `line` (drawn).**                                                                                        | Follows from #8 and #9. Two fields is honest about the fact that the eye and the ear are getting deliberately different amounts here; one field with a flag would make the next reader guess which one the announcer takes.                                                                                                                                                                     |
| 15  | Peek layout for the verb.                                    | **Its own line under the name row, above "Replying to …".** `Reading standup.md`                                                                                                     | The name row is already `name · state · elapsed` and adding a fourth segment truncates on a phone. The peek is a card opened on purpose to ask this exact question, so it can afford a line.                                                                                                                                                                                                    |
| 16  | The `Task` phrase contains an em dash.                       | **Changed to `running an agent: {t}`.** One shipped session string moves.                                                                                                            | The room now prints these clauses as user-facing sentences, and `writing-for-humans` rules out the em dash. Named explicitly so the "no shipped string moves" test can pin the other twelve honestly rather than being quietly weakened.                                                                                                                                                        |
| 17  | Cross-runtime fallback.                                      | **None needed, and none invented.** All three runtimes emit `tool_call` with `input`; an absent activity falls through to today's sentence.                                          | Verified: `opencode/session-mapper.ts:184-190` and `codex/event-mapper.ts:320-323, 339, 390, 480, 505` both push tool starts with a JSON `input`, and the projector's `case 'tool_call'` is runtime-neutral. So the fallback is the honest one already shipped, not a runtime carve-out.                                                                                                        |
| 18  | Two PRs or one?                                              | **One.**                                                                                                                                                                             | The wire field, the producer, the guard and the two renderings are one behaviour; splitting them ships a field nothing writes or a client that reads a field nobody sends.                                                                                                                                                                                                                      |

## 6) Risks

- **The refactor moves a session string.** `formatActivityLabel` is read by the sidebar, ⌘K, the
  session lane and `SessionVerbLine`. Mitigation: a table-driven test that pins every shipped label
  byte-for-byte, written before the refactor, with decision 16's single deliberate exception named in
  it.
- **`one-verb-source.test.ts` is defeated by the new entry point.** The scan guards one function name.
  Mitigation: the new clause builder joins the guarded set, with its own executable escape samples,
  in the same PR.
- **Render churn.** Four hooks read the presence store and three of them are held by surfaces that
  must not re-render on a tick. Mitigation: decision 4's server-side throttle is the primary control
  (the store simply does not change more than once every two seconds per claim), and decisions 8 and 9
  keep the announcer and the crossfade off the verb entirely.
- **The target escapes through a projection somebody adds later.** Mitigation: both existing outbound
  projections get a test that fails if the target appears, and `.claude/rules/room-conduct.md` gains
  the rule so the next reader meets it before writing the third projection.
- **The brief describes a tree slightly ahead of this one** (`held`, `heldBehind`). Mitigation: the
  new field is optional and orthogonal to the state enum; DOR-1345 landing after this changes nothing
  here, and landing before it adds one state that simply has no activity.
