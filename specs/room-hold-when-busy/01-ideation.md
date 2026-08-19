---
slug: room-hold-when-busy
id: 260818-234135
tracker: DOR-1345
project: Unified Conversation Surfaces
created: 2026-08-18
status: ideation
---

# A room never asks you to resend

**Slug:** room-hold-when-busy
**Author:** Claude (IDEATE)
**Date:** 2026-08-18

---

## 1) Intent & Assumptions

### Task brief

On 2026-08-18 a room told Dorian:

> Mio Clicker PM is working in another conversation right now, so it didn't pick this up. Send it
> again in a few minutes.

Asking a person to type their message a second time is the worst thing a coordination layer can
say. The message was already committed to the room log; the room simply declined to owe an answer
for it and told the person to do the work again.

The dispatcher has **two busy ceilings** and they part company at
`apps/server/src/services/rooms/room-trigger.ts:475-511` (`collectOne`):

- mid-turn **in this room** — the `(room, agent)` claim key bounds one transcript. The message is
  **held**: it joins the agent's collection, and the claim's release runs a turn for it
  (`room-collect.ts:307-316`, `RoomCollector.resume`, hung off `releaseClaim` at
  `room-trigger.ts:2181`).
- mid-turn **elsewhere** — the agent's `agentPath` bounds one checkout, shared by every room it is
  in. The message is **refused** with the line above (`notice-copy.ts:139-144`,
  `BUSY_LINES['working-elsewhere']`), and no collection is opened at all.

This work extends the hold across the second ceiling, and gives the person a live, honest line
saying what will happen instead of a durable line asking them to try again.

### Assumptions

1. **The direction is settled, not up for re-litigation.** Hold instead of refuse; say so in the
   live lane; never lose the message; thread the late answer; retire the resend copy. What is open
   is the mechanism, the bounds and the copy.
2. **One person, one install.** Rooms are single-identity today; an invited second person is
   possible and is the only reader the disclosure rules below have to protect.
3. **No new runtime work.** The hold sits above `RoomTurnRunner`, so claude-code, codex and
   opencode behave identically — the second ceiling is about a working directory, which no runtime
   owns.
4. **`rooms.collectDebounceMs` / `collectMaxEntries` / `lateReplyCeilingMinutes` are the bounds we
   already have.** This work adds no user-facing setting.
5. The `held` state is a **fact about this room's own unanswered message**, not a report on another
   room's contents.

### Out of scope

- **Holding for an ABSENT member.** ADR `260727-184933` states as an accepted property that a
  community "does not queue for absent members and does not promise an agent will answer later".
  Nothing here reopens that: a hold exists only because a live claim exists.
- **Interrupting or steering the blocking turn.** That is arbitration between rooms and it is what
  Stop already is. Steering a room turn is `research/20260813_room-architecture-vs-buzz-qm.md`'s
  recommendation 1 (unify room turns onto the session turn machinery) and belongs to that work.
- **A per-author halt.** `specs/unified-conversation` §5.3.4 already parks it: `halt` writes one
  room-wide notice and drops the whole gather buffer, and a scoped version "is a room-conduct
  decision with its own review".
- **Durable holds across a server restart.** Argued and declined in §6, D2.
- **Any change to the same-room hold**, which shipped with RP8 and works.
- **The composer's own draft queue.** Held drafts stay in the composer's queue panel
  (`specs/unified-conversation/04-implementation.md:394`); a hold here is a committed room entry,
  which is a different fact with a different home.

## 2) Pre-reading Log

| Source                                                                                                                         | Takeaway                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`, `.claude/rules/room-conduct.md`                                                                                   | The invariants this work sits inside. Two are decisive: **"A room trigger is never a queue row, and its wait is bounded"** (DOR-1242) — a room trigger must not be persisted, because a durable row would surface in the person's composer as a prompt they never wrote; and **"A refusal is visible"** plus **"an indicator releases into something durable"**.                                 |
| `meta/agent-etiquette.md` §5 (E16, E16a) and §9                                                                                | E16a exempts a mechanical indicator from every speaking rule, but "exactly as wide as the mechanism and no wider" — an indicator must correspond to a claim the dispatcher held. A `held` indicator has to earn the same standard. §9's rule that every constant here is a judgement, not a measurement, is why this work adds no new one.                                                       |
| `apps/server/src/services/rooms/room-trigger.ts` (whole file)                                                                  | `collectOne:475`, `claimCollected:908`, `holdClaim:2044`, `releaseClaim:2144`, `republishPresence:2192`, `publishPresence:2239`, `busyWith:2346`, `halt:2386`. `releaseClaim` is the single seam every terminal reaches, and `collector.resume` is already hung off it — so "if the other turn ends in error, the held message still runs" is satisfied by construction, not by a new code path. |
| `apps/server/src/services/rooms/room-collect.ts`                                                                               | The hold mechanism already exists: `collect({duringTurn})` → `parked`, `park()` merges rather than overwrites, `resume()` arms at delay 0, `drop()` on halt, `trim()` on overflow. A parked collection has `dueAt: null` and nothing is counting.                                                                                                                                                |
| `apps/server/src/services/rooms/room-claims.ts:356-367`                                                                        | `claimBusyWith` returns `'working-here' \| 'working-elsewhere' \| null` — the second value is a scan of every claim by `agentPath`, so "elsewhere" is earned rather than guessed. It does **not** carry which room.                                                                                                                                                                              |
| `apps/server/src/services/rooms/notices/notice-copy.ts:64-144`                                                                 | `BusyContext`, `buildBusyNotice`, `BUSY_LINES`. `working-here` was already deleted from this type when RP8 shipped, with the reason: "A line saying 'it didn't pick this one up' about a message it is about to pick up would be the room lying to be reassuring." The same sentence now applies to `working-elsewhere`.                                                                         |
| `apps/server/src/services/rooms/notices/notice-log.ts:241-354`                                                                 | `reportSilence` and the damping key `(room, agent, reason)`; a message that ASKED the agent is never damped.                                                                                                                                                                                                                                                                                     |
| `packages/shared/src/room-schemas.ts:154-175, 1363-1503`                                                                       | `RoomNoticeCodeSchema` (16 codes), `RoomPresenceStateSchema` (`working \| working_late \| done`, reused by `community-adapter.ts`), `RoomSignalEventSchema`, `RoomPresencePayload`.                                                                                                                                                                                                              |
| `specs/room-presence/02-specification.md` §3.4, §5.1, §5.4, Non-goals                                                          | **The sharpest constraint.** Non-goal: "There is no queue … **The presence line never says 'busy elsewhere'.**" §5.1: a post by an author clears every `(author, *)` indicator in that room. §5.4: `stalled` clears the whole store. §3.2: the indicator's identity is `(room, author, entryId)`.                                                                                                |
| `specs/unified-conversation/02-specification.md` §5.2, §5.3.4 and `04-implementation.md:372, 392, 394`                         | The nine-rung priority table, and the P4 deletion of `queued` with its recorded argument.                                                                                                                                                                                                                                                                                                        |
| `specs/room-participation/02-specification.md` §5.3                                                                            | `answersEntryId?: string` on `RoomEntryBodySchema`, set by `RoomTriggerWriter.post`, rendered as a quoted-reference chip. Specified in RP1, never shipped — zero hits in `apps/` or `packages/`.                                                                                                                                                                                                 |
| `decisions/260726-170125-*.md`                                                                                                 | The ADR the dispatcher cites for "refusing, not queueing". Its actual clause is **"Rooms carry addressing and atomicity, never a concurrency primitive"** — no room-scoped write lock, no room turn policy, and the DOR-500 evidence that the checkout is where the hazard lives.                                                                                                                |
| `decisions/260811-184735-server-owned-durable-message-queue.md`                                                                | The precedent one layer down, in our favour: a busy session used to answer `409 SESSION_LOCKED`, "an error where the honest answer was 'it will run next'".                                                                                                                                                                                                                                      |
| `decisions/260816-143752-message-dispositions-at-the-runtime-boundary.md`                                                      | "Every downgrade is reported. Silent degradation is the failure this design exists to prevent." Also: a turn parked on a person is parked on a person — a steer never reaches it.                                                                                                                                                                                                                |
| `decisions/260727-184933-*.md:50`                                                                                              | v1 does not queue for absent members. Fences this work off from that.                                                                                                                                                                                                                                                                                                                            |
| `research/20260610_message_queuing_agent_runtimes.md`                                                                          | Four-pattern taxonomy (block / queue-to-end / interrupt / steer). "Pattern (a) — block input until idle — is legacy." Recommends the server owns the queue. Known failure modes worth testing: queued messages dropped on abort, queued prompts firing during a pending permission, premature dequeue.                                                                                           |
| `research/20260807_room_context_delivery_buzz_and_patterns.md`                                                                 | Buzz's default `--multiple-event-handling` is **`Drop`** — new events during an in-flight turn are silently dropped. Its README claims a durable read cursor it does not have. DorkOS's `room_members.lastReadSeq` is "strictly better than what Buzz actually does here" — which is the reason a non-durable hold degrades safely.                                                              |
| `research/20260810_midturn_input_ux_survey.md`                                                                                 | The transferable semantic: Copilot's steering degrades to queue automatically when the turn finishes first. Claude Code's terminology debt — Enter mid-turn is a steer, the UI says "queued".                                                                                                                                                                                                    |
| `research/20260727_agents-in-group-chat-industry-survey.md:293`                                                                | "Interruption via the chat channel itself is genuinely unsolved in these products."                                                                                                                                                                                                                                                                                                              |
| `apps/client/src/layers/features/conversation/model/lane-state.ts`, `ui/LiveLane.tsx`, `ui/LaneContent.tsx`, `ui/LivePeek.tsx` | The nine-rung union, the `presence` rung at 3, the peek's row shape and its four actions. Only `presence` and `ask` are ever clickable.                                                                                                                                                                                                                                                          |
| `apps/client/src/layers/widgets/room-view/ui/RoomLiveLane.tsx`, `model/room-capabilities.ts`                                   | `ROOM_CAPABILITIES = { streamHealth: true, presence: true, turnStatus: false, asks: true }` — **a room can only ever reach rungs 1, 2, 3 and 9.**                                                                                                                                                                                                                                                |
| `apps/client/src/layers/entities/room/model/use-room-presence.ts`                                                              | One Zustand store fed by the room's SSE `signal` frames; `indicatorKey(authorId, entryId)`; `PRESENCE_TTL_MS = 30_000` against a 10 s server republish; `clearAuthor` on any arriving entry by that author; four reader hooks. `useRoomPresenceEverywhere` cannot answer "which room is it busy in" — the global fan-out carries a bare count.                                                   |
| `apps/e2e/tests/rooms/room-autonomy.spec.ts`                                                                                   | The only rooms spec that lets an agent take a turn — test-mode leg, `long-turn` scenario, a seeded `collectDebounceMs` written through `PATCH /api/config`. The home for this work's browser test.                                                                                                                                                                                               |

## 3) Codebase Map

### Primary components

| Path                                                               | Role in this change                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/rooms/room-trigger.ts:475-511`           | `collectOne` — the refusal to delete.                                                                                                     |
| `apps/server/src/services/rooms/room-trigger.ts:908-935`           | `claimCollected` — the second refusal, reached when a window that opened while the agent was free closes after something else claimed it. |
| `apps/server/src/services/rooms/room-trigger.ts:2144-2182`         | `releaseClaim` — the one seam. `collector.resume(roomId, authorId)` at `:2181` gains a cross-room sibling.                                |
| `apps/server/src/services/rooms/room-trigger.ts:2192-2245`         | `republishPresence` / `publishPresence` — holds must be restated on the same 10 s tick, or the client's 30 s TTL drops them.              |
| `apps/server/src/services/rooms/room-trigger.ts:2386-2444`         | `halt` — drops collections before claims; holds go with them.                                                                             |
| `apps/server/src/services/rooms/room-collect.ts`                   | `RoomCollection` gains a reason for being parked and a promotion mark; `park`/`resume`/`sweep` gain the cross-room case.                  |
| `apps/server/src/services/rooms/room-claims.ts:356-367`            | `claimBusyWith` must return **which** claim is blocking, not just that one is.                                                            |
| `apps/server/src/services/rooms/notices/notice-copy.ts:103-144`    | `BusyContext` loses `working-elsewhere`; both surviving lines lose "send it again".                                                       |
| `packages/shared/src/room-schemas.ts:1363-1503`                    | `RoomPresenceStateSchema` gains `held`; `RoomSignalEventSchema` gains `heldBehind`; `RoomEntryBodySchema` gains `answersEntryId`.         |
| `apps/client/src/layers/features/conversation/model/lane-state.ts` | A tenth `LaneState` member and a new rung between `presence` and `empty`.                                                                 |
| `apps/client/src/layers/features/conversation/ui/LivePeek.tsx`     | A held row shape and two actions.                                                                                                         |
| `apps/client/src/layers/entities/room/model/use-room-presence.ts`  | One store, two readers: claims exclude `held`, a new hook returns only `held`.                                                            |
| `apps/client/src/layers/widgets/room-view/ui/RoomLiveLane.tsx`     | Joins holds into the lane input and the peek rows.                                                                                        |

### Shared dependencies

`RoomCollector` ↔ `RoomTriggerDispatcher` (the collector owns buffers and timing, the dispatcher owns every decision); `RoomNoticeLog` (the single notice writer); the room SSE stream (`RoomService.publishSignal`); `useRoomPresenceStore` (one store, four readers); `ResponsivePopover` (the peek's shell).

### Data flow

```
post → RoomService.post → dispatch() → selectCandidates() → collectOne()
   busyWith === null            → collect(duringTurn:false) → sweep → claimCollected → turn
   busyWith === 'working-here'  → collect(duringTurn:true, parked) ──┐
   busyWith === 'working-elsewhere' → TODAY: notice + drop           │
                                     THIS SPEC: collect(parked) ─────┤
                                                                     │
   releaseClaim(key) ─── resume(room, agent)  ───────────────────────┤ (same room)
                    └── resumeAgent(agentPath) ──────────────────────┘ (any room)
                          ↓
                     sweep(promoted first, then oldest first) → claimCollected → turn → post
```

Presence rides a second, ephemeral path: `holdClaim`/`releaseClaim`/`republishPresence` →
`deps.publishPresence(roomId, authorId, payload)` → the room's SSE `signal` frame →
`useRoomPresenceStore.observe` → `deriveLaneState`.

### Feature flags / config

None new. The bounds are `rooms.collectDebounceMs` (500 ms), `rooms.collectMaxEntries` (20) and
`rooms.lateReplyCeilingMinutes` (60), all already in `packages/shared/src/config-schema.ts:1055-1114`.

### Potential blast radius

The room dispatcher (every automatic turn), the room presence store and every surface that reads it
(room lane, thread lane, sidebar dots), the `agent_busy` notice, the `CommunityAdapter` presence
payload (which reuses `RoomPresenceStateSchema`), and the OpenAPI document.

## 4) Research

### The four industry patterns, and where this lands

`research/20260610_message_queuing_agent_runtimes.md` §4.1 names them: **block**, **queue-to-end**,
**interrupt-restart**, **steer**. Today the second ceiling is pattern (a), _block_ — which that
report calls legacy — dressed up as a polite sentence. Buzz's default is worse: `Drop`, silently.
This work moves the second ceiling to **queue-to-end**, which is where the first ceiling already is
and where the session path already is (ADR `260811-184735`). Steer stays out of scope and is
`research/20260813`'s recommendation 1.

The single most useful transferable semantic is Copilot's, from
`research/20260810_midturn_input_ux_survey.md`: **a steer that misses its turn degrades to a queue
entry automatically**. The equivalent here is that a hold whose blocking claim ends in _any_ way —
answer, silence, failure, halt — still runs, because the release seam is one function.

### Options considered

1. **Keep refusing, fix only the words.** Cheapest. Rejected: the message is still dropped, so any
   honest copy still ends with the person doing the work again.
2. **Hold in memory, extend the existing collector (recommended).** The mechanism is already built,
   tested and understood; the change is which of the two ceilings parks rather than refuses, plus a
   cross-room resume. No table, no migration, no scheduler.
3. **Hold durably in a new `room_holds` table.** Survives a restart. Rejected in D2.
4. **Reuse the durable session message queue** (ADR `260811-184735`). Rejected outright:
   `.claude/rules/room-conduct.md` already forbids it — "a row standing for a room's trigger would
   show up in that person's composer as a prompt they never wrote", and rows outlive the process, so
   it would fire days later into a conversation that ended.
5. **Refuse, but auto-retry on a timer.** Rejected: a timer is a scheduler with none of the
   evidence a claim gives you, and it re-runs the guard against a room that has moved on.

### Recommendation

Option 2, plus a `held` presence state so the room can say what will happen while it is still true,
plus `answersEntryId` so the late answer is never ambiguous. The durable side stays exactly what it
is today: **the room log, plus `room_members.lastReadSeq`**, which
`research/20260807_room_context_delivery_buzz_and_patterns.md` measured as strictly better than
Buzz's, and which is why a hold lost to a restart degrades to an unread message rather than a lost
one.

## 5) The two hard arguments this work has to win

Both are recorded refusals in this repo, and neither can be waved past.

### 5a) `specs/room-presence` says the presence line never says "busy elsewhere"

Verbatim, from its Non-goals: _"There is no queue … and the `agent_busy` notice's deliberate
vagueness — no what, no where, no for-whom — is a leak-free property this spec keeps. The presence
line never says 'busy elsewhere'."_

That property is about **a reader who may not be a member of the other room**. This design keeps it
by moving the resolution to the reader:

- the wire carries `heldBehind: { roomId }` — an id and nothing else. No title, no topic, no author,
  no message. Room ids are not capabilities in this codebase: _"'not a member' answers exactly as
  'no such room', so a room id is never a capability"_ (`.claude/rules/room-conduct.md`).
- the **client** resolves that id against the rooms it can already see. The owner sees every room
  (`seesEveryRoom`), so she reads `#mio-engagement`. Anybody else reads _"another conversation"_ —
  which is the vagueness the non-goal protected, now enforced per reader instead of per wire.

So the amendment is narrow and honest: the presence line may say **that** an agent is held and
**that** something else has it, and may name the other room only to a reader who could have opened
it anyway.

### 5b) `specs/unified-conversation` P4 deleted the `queued` rung and argued against reordering it

Verbatim, from `04-implementation.md:394`: _"It sat below every `turn-_` rung while a queue only
ever exists BECAUSE a turn is running, so neither shipped surface could reach it… Reordering it
above the turn would be worse: hiding what the agent is doing in order to report a number. Held
drafts live in the composer's queue panel, which is where they stay."\*

Three reasons the `held` rung is not that rung coming back:

1. **It reports a different fact.** `queued` counted the person's own undelivered drafts. `held`
   is about a message that is already committed to the room log and that the room owes an answer
   to. One is the person's outbox; the other is the room's debt.
2. **It is reachable.** A room's capabilities are `turnStatus: false`, so rungs 4–8 do not exist
   there. The rung sits directly under `presence` and above `empty`, and in the case it describes
   — the agent is busy _somewhere else_, so nobody is working _here_ — `presence` is empty and the
   rung is the only thing on the lane.
3. **It hides nothing.** When both are true (someone else really is working here) `presence` still
   wins the headline, and the hold appears as a row in the peek that rung already opens. Nothing
   is traded away to report a number.

## 6) Decisions

Every one of these is resolved. Nothing below is an open question.

| #       | Decision                                                    | Choice                                                                                                                                                                                                                                                                                                                                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | What happens to a message for an agent busy in another room | **Held**, in the same per-`(room, agent)` collection RP8 built. `collectOne`'s `working-elsewhere` refusal is deleted; `busyWith !== null` now parks.                                                                                                                                                                                                                    | The message is already in the log. Refusing only removes the room's obligation to answer it, and the sentence that admitted so asked the person to do the work twice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **D2**  | Hold durability                                             | **Process memory. Not durable, deliberately.** A restart forgets the hold; the message stays unread behind the agent's cursor and reaches it on the next turn as ambient context.                                                                                                                                                                                        | Three reasons, in order of weight. (a) `.claude/rules/room-conduct.md` already forbids the durable form: a room trigger is not a queue row, because a persisted row shows up in the person's composer as a prompt they never wrote and can fire days later into a dead conversation (DOR-1242). (b) The claim it waits behind is itself memory-only (`specs/room-presence` §3.2), so a durable hold would outlive the only evidence that justified it. (c) The message is never lost either way — `room_members.lastReadSeq` is the durable half and always was. **The honesty rule in D6 exists precisely so a restart cannot break a promise the room made.** |
| **D3**  | Ordering across rooms                                       | **FIFO by when the hold opened**, promotable to the front by the person (D9). The sweep hands due collections back in the order they were opened; the first to reach `claimCollected` claims and the rest re-park.                                                                                                                                                       | Nothing orders two _different agents_ against each other, so `I1 No arbitration` is untouched: this orders one agent's own unanswered messages, which is what a person means by "in the order I asked". Self-serialising by construction — the second collection re-parks against the claim the first just took.                                                                                                                                                                                                                                                                                                                                                |
| **D4**  | Bounds, and what happens when full                          | Two, both existing. **Per room+agent:** `rooms.collectMaxEntries` (20) — a parked collection over the cap drops its oldest _marks_, never the lines (`room-collect.ts:436-440`). **Per hold:** a hold older than `rooms.lateReplyCeilingMinutes` (60 min) is dropped and written up. No new setting.                                                                     | The per-room cap is shipped and tested. The age bound exists to stop a chain — A blocks B, B blocks C — running unbounded across many rooms; reusing "when the room stops listening" is the same fact at a different grain, and `meta/agent-etiquette.md` §9 is explicit that we do not invent constants we cannot defend.                                                                                                                                                                                                                                                                                                                                      |
| **D5**  | How the lane learns about a hold                            | **A new presence state on the existing `progress` signal**: `RoomPresenceStateSchema` gains `'held'`, and `RoomSignalEventSchema` gains `heldBehind?: { roomId: string; othersWaiting: boolean }`. Not a new signal type.                                                                                                                                                | Presence already is "the claim map made visible", published only by the dispatcher, keyed `(room, author, entryId)`, republished at 10 s against a 30 s client TTL, with a partial-payload guard and a scope filter. A second signal type would duplicate all of it. A hold is a claim's shadow and belongs on the same channel.                                                                                                                                                                                                                                                                                                                                |
| **D6**  | What is durable and what is ephemeral                       | **Ephemeral promises live in the ephemeral lane; durable lines state only what already happened.** The hold is announced ONLY on the live lane. No durable notice is written when a hold opens.                                                                                                                                                                          | This is the rule that makes D2 safe. A durable "it will pick this up" that a restart silently breaks is worse than the refusal it replaced. A live lane rung is honest by construction: it exists exactly as long as the machinery that can keep the promise, which is the same mechanical-honesty test `meta/agent-etiquette.md` E16a applies to the working indicator.                                                                                                                                                                                                                                                                                        |
| **D7**  | The notice copy                                             | `BUSY_LINES['working-elsewhere']` is **retired**. `BusyContext` becomes `'held-too-long' \| 'unknown'`, both past-tense, neither asking for a resend, both saying what happens next. `agent_busy` stays the notice code.                                                                                                                                                 | The exact reasoning RP8 used when it deleted `working-here` from this type: a line saying "it didn't pick this up" about a message it _is_ picking up is the room lying to be reassuring. Keeping the code preserves the `(room, agent, reason)` damping key and needs no `RoomNoticeCodeSchema` change.                                                                                                                                                                                                                                                                                                                                                        |
| **D8**  | The genuinely undeliverable cases                           | Two, and only two. **(i) `unknown`** — no claim anywhere, the turn never started because a stranger held the agent's session (most often the person typing into it directly). That path is already accept-then-fail with a bounded wait (DOR-1242) and cannot be held, because there is no release event to hang a resume on. **(ii) `held-too-long`** — D4's age bound. | This is where `agent_busy` survives, exactly as the brief anticipated. Note the brief's framing needs one correction: a person typing into the agent's own session is **not** `working-elsewhere`, which is a scan of room claims only — it is the `unknown` branch.                                                                                                                                                                                                                                                                                                                                                                                            |
| **D9**  | What "Answer here first" does                               | **Promotes this room's hold to the front of that agent's hold queue.** It never interrupts, never stops and never touches the blocking turn. Offered only when `heldBehind.othersWaiting` is true, so the button is never a no-op.                                                                                                                                       | Interrupting is arbitration between rooms and is what Stop already is — reachable from the same peek via "Open where it's working", where the person can also see what they would be stopping. Promotion is ordering among one agent's own unanswered messages, which D3 already permits. `othersWaiting` is a boolean, not a count or a list, so it discloses nothing the reader did not already learn from `heldBehind.roomId`.                                                                                                                                                                                                                               |
| **D10** | Threading the late answer                                   | Ship `answersEntryId?: string` on `RoomEntryBodySchema` (`specs/room-participation` §5.3, specified in RP1 and never built). Set by `RoomTriggerWriter.post` on every agent-authored post. Rendered as a compact reference chip **only when the answered entry is not the immediately preceding entry**.                                                                 | Holding makes out-of-order answers common rather than rare, which is exactly the condition §5.3 was written for. Suppressing the chip in the adjacent case keeps it from becoming furniture on every reply. `withLateAnswerNote`'s prose prefix stays — it carries the _delay_, which the chip does not, and it is what a Telegram/Slack bridge and the export can render.                                                                                                                                                                                                                                                                                      |
| **D11** | Cross-runtime behaviour                                     | **Identical for claude-code, codex and opencode.** No adapter changes, no capability flag.                                                                                                                                                                                                                                                                               | The hold lives in the dispatcher, above `RoomTurnRunner`. The second ceiling is about the agent's working directory, which is a property of the agent, not of the runtime — which is the whole of the DOR-500 evidence in ADR `260726-170125`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **D12** | Interaction with the Ask                                    | The blocking turn may be parked on a person (approval, question, elicitation). It **keeps its claim**, so the hold stands and the lane keeps saying so. The held room says nothing about **why** the other room is stuck; the peek's "Open where it's working" takes the person to where the `awaiting_approval` notice and the Ask are.                                 | ADR `260818-002803` already broadcasts an Ask fleet-wide, so nothing is hidden from the person who can act. Repeating another room's approval state into this room's lane would put one member's approval decision in front of everybody else — the exact thing `buildWaitingNotice` refuses to do.                                                                                                                                                                                                                                                                                                                                                             |
| **D13** | Interaction with `halt`                                     | Halting **this** room drops its holds along with its collections (`collector.drop`), publishing `done` for each held indicator; the room-wide `halted` notice is the durable sibling. Halting the **blocking** room releases its claims, which resumes this room's hold and runs the turn.                                                                               | Both fall out of the existing ordering and neither needs a new rule. The second is the correct outcome and is worth a test: the person stopped room A, not room B, and room B's question still deserves an answer.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **D14** | The indicator invariant                                     | Extended, not weakened: **a `held` indicator releases into a turn, into a `halted` notice, into the `agent_busy` age-bound notice, or into the drop paths the guard and the budget already write up.** The one uncovered exit is a process restart, which is D2's declared cost and the known gap `.claude/rules/room-conduct.md` already records.                       | "An indicator releases into something durable" is the room's honesty rule. A `held` indicator is a promise, so it owes the same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **D15** | ADR treatment                                               | One new ADR (`260818-234541`) that **amends** `260726-170125`, retiring the reading of _"Rooms carry addressing and atomicity, never a concurrency primitive"_ that makes a cross-room hold a concurrency primitive. Everything else in that ADR stands, including the DOR-500 conclusion that the checkout is what a lock must be keyed on.                             | The ADR forbids a room-scoped lock and a room turn policy. A hold is neither: it takes no lock, starts no second turn, orders no two agents, and stores what the agent has not read rather than a plan for a scheduled turn. But the code cites this ADR at the exact line being changed, so the link has to be machine-readable rather than argued in a spec nobody greps.                                                                                                                                                                                                                                                                                     |

## 7) Risks

| Risk                                                                                               | Likelihood | Mitigation                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A restart silently breaks a promise the lane made                                                  | Medium     | D6: the promise is only ever made on the ephemeral lane, which dies with the process that could keep it. The message itself is never lost (`lastReadSeq`).                               |
| The lane says "will pick this up" and it takes an hour                                             | Low–Medium | The rung counts up from the hold's start and the peek offers "Open where it's working". D4's age bound closes it with a durable line rather than letting it stand forever.               |
| `held` on `RoomPresenceStateSchema` leaks into `CommunityAdapter` consumers that cannot produce it | Medium     | Adding an enum member is additive for producers; the port's payload already has every field optional. `communityConformance` must not require it. Called out in the spec's wire section. |
| A held indicator is wiped by §5.1's clear-on-post and does not come back                           | Low        | The 10 s republish restores it, the same way it restores a live claim; the client TTL is 30 s. Pinned by a test.                                                                         |
| Promotion (D9) becomes a way to starve another room                                                | Low        | Promotion reorders, never preempts: the blocking turn is untouched, and a promoted hold still waits for a free agent. A room whose hold was passed over is next by FIFO.                 |
| The peek grows into a control panel nobody asked for                                               | Low        | Two actions, both gated: "Open where it's working" only when the room resolves, "Answer here first" only when `othersWaiting`.                                                           |
| `idle()` now waits for held collections and a shutdown or a test hangs                             | Medium     | Already true of same-room holds since RP8; the new case is bounded by D4's age bound. Tests use the same seeded-window technique `room-autonomy.spec.ts` uses.                           |

## 8) Recommended next step

Move to SPECIFY. Every decision above is resolved, the mechanism is an extension of shipped code
rather than a new subsystem, and the two recorded refusals it crosses (§5a, §5b) have arguments
written down and an ADR amendment to carry them.
