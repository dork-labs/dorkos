---
slug: room-per-agent-stop
id: 260819-023727
tracker: DOR-1352
project: Unified Conversation Surfaces
created: 2026-08-19
status: ideation
---

# Stop one agent without stopping the room

**Slug:** room-per-agent-stop
**Author:** Claude (IDEATE)
**Date:** 2026-08-19

---

## 1) Intent & Assumptions

- **Task brief:** The live peek draws one row per working agent. Today a row only gets a
  **Stop** button when exactly one agent is working, because the only stop that exists is
  `POST /api/rooms/:id/halt` and that stops everybody. Three agents working means no per-row
  Stop at all and one footer action, `Stop everything in this room · Stops all 3`. Build the
  per-agent halt the peek was drawn for, and put a Stop on every row.
  Filed by `specs/unified-conversation/02-specification.md` §5.3.4 as the follow-up that section
  names in its last line.

- **Assumptions:**
  - The operator is the person watching the room. Only a person may stop anything
    (`RoomService.requirePersonAuthor`, `room-service.ts:3259`); nothing here changes that.
  - Stopping one agent is a control action with exactly the same properties as stopping the
    room. It is never inferred from message text, it is visible in the room log, and it drops a
    working indicator only into something durable.
  - `RoomTurnRunner.interrupt` (`room-turn-runner.ts:398`) already resolves the runtime from the
    agent and calls `AgentRuntime.interruptQuery`. Cross-runtime coverage for claude-code, codex
    and opencode is therefore already whatever `halt` has. **No runtime work is in scope.**
  - DOR-1345 (`specs/room-hold-when-busy/`, status `specified`) lands first. See §5, Decision 7,
    for exactly what changes if it does not.

- **Out of scope:**
  - The room masthead's Stop (`room-header-halt`, `widgets/room-view/ui/RoomHeader.tsx`). It is
    the room-wide verb and stays exactly as it is.
  - Pausing, muting, or removing an agent. This adds no new verb; it scopes one that exists.
  - Any change to `AgentRuntime`, to any runtime adapter, or to how an interrupt reaches a
    process.
  - Stopping a turn from the session surface. `specs/unified-conversation` §5.3.4 already
    settled that the session peek has no Stop, because the session composer has one.
  - Anything a stopped turn has already spent. A turn that ran a model has spent, and
    `tryReserve` still has no counterpart.

## 2) Pre-reading Log

Every line number below was opened and read at `main` @ `d7e4768e6`.

| File                                                                                          | Takeaway                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/services/rooms/room-trigger.ts:109-114`                                      | Module rule 7. Stopping is a control action, the one thing in the file that is not a reaction to a message.                                                                                                                                      |
| `room-trigger.ts:350-372`                                                                     | `haltedTurns: Set<dispatchId>`. Keyed by dispatch, not by `(room, agent)`, because the claim is gone by the time a stopped answer lands and the next turn for the pair is a different dispatch.                                                  |
| `room-trigger.ts:2386-2444`                                                                   | The whole `halt` body. Order: mark every dispatch **before the first `await`** → write the notice → drop the gather buffers → interrupt → `releaseClaim(key, 'halted')`.                                                                         |
| `room-trigger.ts:2388-2394`                                                                   | The race, named: "a turn whose stream closes while this method is still delivering interrupts must find the mark already there, or it posts the answer Stop was pressed to prevent — the two-second race measured on 2026-08-15."                |
| `room-trigger.ts:2410-2416`                                                                   | Buffers are dropped **before** claims because releasing a claim is what resumes a held collection. The other order answers, one macrotask later, the very messages the person pressed Stop over.                                                 |
| `room-trigger.ts:1354-1360, 1420-1423, 1474-1500, 1638-1643, 1865-1889`                       | Every delivery path asks `wasHalted(dispatchId)` and throws the answer away, notices included. `forgetHalt` runs at each real terminal.                                                                                                          |
| `room-trigger.ts:2044-2057`                                                                   | `holdClaim` calls `this.notices.workStarted(claim.roomId)` — the halt notice's re-arm.                                                                                                                                                           |
| `room-trigger.ts:2103-2132`                                                                   | `releaseOwnClaim` vs `releaseClaim`. Only `halt` releases by key, because it stops whoever holds it rather than finishing a turn.                                                                                                                |
| `room-service.ts:515-543`                                                                     | `haltRoom(roomId, viewerAuthorId)` = `requireVisibleRoom` + `requirePersonAuthor('stop a room')` + `triggers.halt(room)`. An archived room is deliberately **not** refused.                                                                      |
| `room-service.ts:3243-3262`                                                                   | `requirePersonAuthor` throws `PEOPLE_ONLY` (403). Agents do not stop each other; that would be the arbitration ADR 260726-170125 declined.                                                                                                       |
| `routes/rooms.ts:732-753`                                                                     | `POST /:id/halt`. Takes no body, on purpose: Express 5 leaves `req.body` undefined on an empty POST, so asking for one would refuse every honest caller.                                                                                         |
| `notices/notice-copy.ts:215-240`                                                              | `buildHaltedNotice(stopped)`. Three sentences by count, `notice: 'halted'`, **no `subjectAuthorId`**.                                                                                                                                            |
| `notices/notice-log.ts:558-597`                                                               | `reportHalted` damps on `noticedHalt: Set<roomId>`; `workStarted(roomId)` is the re-arm. `write()` is the single writer and degrades on an archived room.                                                                                        |
| `packages/shared/src/room-schemas.ts:117-120`                                                 | The `halted` docstring says it is "About the room rather than one member, so it carries no `subjectAuthorId`." That sentence is what this work amends.                                                                                           |
| `room-schemas.ts:600-621`                                                                     | `RoomEntryBodySchema` already has optional `subjectAuthorId`, "who the notice is about when that is not the entry's own author".                                                                                                                 |
| `room-schemas.ts:1290-1306`                                                                   | `HaltRoomResponseSchema` = `{ stopped: number ≥ 0 }`.                                                                                                                                                                                            |
| `room-turn-runner.ts:398-407`                                                                 | `interrupt` resolves the runtime **from the agent path**, not the session registry row, then calls `runtime.interruptQuery(sessionId)`.                                                                                                          |
| `packages/shared/src/agent-runtime.ts:955-961`                                                | `interruptQuery(sessionId): Promise<boolean>`. One method, every runtime.                                                                                                                                                                        |
| `room-collect.ts:324-347`                                                                     | `RoomCollector.drop(roomId)` returns the dropped collections so the caller can settle each. There is **no** per-agent drop today.                                                                                                                |
| `features/conversation/ui/LivePeek.tsx:73-101`                                                | The current rule in code: `perRowStop = rows.length === 1 && onStopAll !== undefined`, `footerStop = rows.length > 1 && …`. The docstring says why, and names this work as the missing piece.                                                    |
| `widgets/room-view/ui/RoomLiveLane.tsx:300-301`                                               | `onStopAll={() => halt.mutate({ roomId: room.id })}`, `stopping={halt.isPending}`.                                                                                                                                                               |
| `entities/room/model/use-halt-room.ts`                                                        | One mutation, no cache writes: the `halted` notice and the dropped indicators both arrive on the room stream. `meta.errorLabel` drives the shared toast.                                                                                         |
| `shared/lib/transport/room-methods.ts:185-193` + `packages/shared/src/transport-rooms.ts:182` | `haltRoom(id)` on the room transport.                                                                                                                                                                                                            |
| `shared/lib/embedded-mode-stubs.ts:824+` (`roomStubs`)                                        | Obsidian's `DirectTransport` satisfies the room half of `Transport` entirely with stubs. Parity is one more stub, not an implementation.                                                                                                         |
| `services/relay/chat-bridge/deliver.ts:74-78, 600-623`                                        | `DELIVERABLE_NOTICES = {'turn_failed', 'halted'}`. `turn_failed` gets a bridge-specific rewrite; `halted` deliberately does not, because its own line already works for an outside reader.                                                       |
| `routes/room-error-response.ts:18-42`                                                         | `ROOM_NOT_FOUND: 404`, `MEMBER_NOT_FOUND: 404`, `PEOPLE_ONLY: 403`.                                                                                                                                                                              |
| `services/core/openapi-registry.ts:3798-3820`                                                 | The halt path's registration, and the wording a sibling should match.                                                                                                                                                                            |
| `.claude/rules/room-conduct.md`                                                               | Five invariants bind here: stopping is never inferred; a stopped turn posts nothing and the room guarantees it; a turn releases its own claim; an indicator releases into something durable; a refusal is visible and lives in `notice-copy.ts`. |
| `specs/unified-conversation/02-specification.md:985-1002`                                     | §5.3.4, the source of the brief, and the table this work replaces.                                                                                                                                                                               |
| `specs/room-hold-when-busy/02-specification.md:143-254, 450-478, 521-530`                     | DOR-1345: the `held` map, `HoldEnd = 'started' \| 'halted' \| 'expired' \| 'refused'`, `RoomCollector.dropOne`, and §5.3's rule that a held row gets no Stop.                                                                                    |
| `apps/e2e/tests/rooms/room-autonomy.spec.ts:397-470`                                          | The existing halt browser case, and the `long-turn` / `finish-turn` scenario levers it needs.                                                                                                                                                    |
| `apps/e2e/playwright.config.ts:479-484, 621-626`                                              | `room-autonomy.spec.ts` runs **only** in `chromium-rooms-agents`, against the test-mode leg.                                                                                                                                                     |
| `.claude/commands/chat/rooms-test.md:342-369, 522`                                            | Check 3a/3b, and the self-test's own summary of the halt ordering.                                                                                                                                                                               |

## 3) Codebase Map

- **Primary modules:**
  - `apps/server/src/services/rooms/room-trigger.ts` — the dispatcher, the claim map, the halt
    mark, and the halt itself.
  - `apps/server/src/services/rooms/room-service.ts` — the only entry point to the halt, and
    where the two refusals live.
  - `apps/server/src/routes/rooms.ts` — the HTTP verb.
  - `apps/server/src/services/rooms/notices/notice-copy.ts` + `notice-log.ts` — the room's own
    voice and its damping memory.
  - `apps/client/src/layers/features/conversation/ui/LivePeek.tsx` — the rows and the footer.
  - `apps/client/src/layers/widgets/room-view/ui/RoomLiveLane.tsx` — the one host that wires
    them to a room.
- **Shared dependencies:** `packages/shared/src/room-schemas.ts` (`RoomNoticeCode`,
  `RoomEntryBody`, `HaltRoomResponse`), `packages/shared/src/transport-rooms.ts`,
  `apps/server/src/services/core/openapi-registry.ts`.
- **Data flow:** peek row Stop → `useHaltAgent` → `transport.haltRoomAgent` →
  `POST /api/rooms/:id/halt/:authorId` → `RoomService.haltAgent` →
  `RoomTriggerDispatcher.haltAgent` → mark dispatch, write notice, drop that agent's collection,
  `runner.interrupt`, `releaseClaim`. Everything the reader sees comes back on the room's own SSE
  stream: the notice as an entry, the indicator dropping as a presence `done`.
- **Feature flags/config:** none. `rooms.collectDebounceMs` and `rooms.lateReplyCeilingMinutes`
  are read by code this touches but are not changed.
- **Blast radius:** one new route, one new dispatcher method, one new notice builder, one changed
  damping signature (`workStarted`), one new transport method plus its stub, one changed peek
  component, one changed lane host. Nothing in any runtime adapter. Nothing in the session
  surface.

## 4) Research

### The three things a room-wide halt does that a per-agent halt must also do

Read out of `halt` (`room-trigger.ts:2386-2444`) rather than inferred:

1. **Mark the dispatch before the first `await`.** This is the whole of DOR-1232. An interrupt is
   a request, not a guarantee: `interruptQuery` resolving says the signal was delivered, and the
   turn's own stream still closes the ordinary way. On 2026-08-15 a live install wrote its
   `halted` notice and then posted the stopped turn's complete answer two seconds later. Every
   delivery path checks `wasHalted(dispatchId)`; a per-agent halt that marked late, or that
   called `POST /api/sessions/:id/interrupt` directly and never marked at all, re-opens exactly
   that race.
2. **Write the durable line before releasing the claim.** Releasing publishes `done`, so the
   other order drops the working indicator a beat ahead of the entry explaining it: a room going
   quiet for no visible reason, which `.claude/rules/room-conduct.md` forbids by name.
3. **Drop the gather buffer before releasing the claim.** `releaseClaim` is what resumes a held
   collection (`RoomCollector.resume` is hung off it so no terminal can forget it). Dropping
   second would start, one macrotask later, the very turn the person pressed Stop to prevent.
   This is also the mechanism behind room-conduct's rule that halt is a control action and not a
   reaction: without the drop, the messages that triggered the stopped turn immediately trigger
   it again, and Stop reads as a stutter.

A fourth follows from the first: because the stopped turn's answer is thrown away, it never posts,
so it never triggers anybody. That is how a halt stops a cascade. Nothing extra is needed for the
per-agent case — the other agents' turns still post and may still re-trigger the stopped agent,
which is correct, because the person stopped one turn and not the room.

### Potential solutions

1. **Call `POST /api/sessions/:id/interrupt` from the peek.** Rejected outright, and
   `specs/unified-conversation` §5.3.4 already rejected it: it bypasses the mark, the notice, the
   buffer drop and the claim release. It would look like it worked and would post the answer two
   seconds later.
2. **A `authorId` field on the existing halt's body.** Rejected. `POST /:id/halt` takes no body
   on purpose, and the failure mode of an optional target is the wrong one: a client bug that
   drops the field silently stops everybody. See Decision 1.
3. **A sibling route, `POST /:id/halt/:authorId`, and a `haltAgent` on the dispatcher that is the
   same five steps scoped to one key.** Recommended.
4. **A generalized `halt(room, authorId?)` with the room-wide call passing `undefined`.**
   Tempting, and rejected on the strength of the difference in step 3: the room-wide halt drops
   every collection in the room, the per-agent one drops exactly one, and the room-wide notice
   counts while the per-agent one names. Two bodies of ten lines each read better than one body
   of twenty with three branches in it. They share the marking helper and nothing else needs to
   be shared.

### Recommendation

Solution 3. One new route, one new dispatcher method that follows `halt`'s ordering step for step,
one new notice line that reuses the `halted` code and carries `subjectAuthorId`, and a peek where
**every** working row has a Stop and the footer keeps the room-wide one whenever there is more
than one row.

## 5) Decisions

Every routine call is resolved here. The two product-level calls (Decisions 2 and 3) carry a
chosen default and a note saying it is reversible.

| #   | Decision                                                 | Choice                                                                                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Route shape: sub-path or body field?                     | **`POST /api/rooms/:id/halt/:authorId`**, keeping `POST /:id/halt` unchanged.                                                                   | The existing route takes no body deliberately (Express 5 leaves `req.body` undefined on an empty POST). An optional target field fails open: a client that forgets it stops the whole room. A path segment cannot be forgotten. DOR-1345's `POST /:id/holds/:authorId/promote` is the sibling precedent for author-scoped room sub-paths. No Express 5 routing ambiguity: `/:id/halt` and `/:id/halt/:authorId` are different paths.                                                                                                                                                                                                         |
| 2   | Does a **held** row get a Stop? (DOR-1345 §5.3 says no.) | **Yes — every row in the peek gets a Stop.** This amends `specs/room-hold-when-busy` §5.3. **(RESOLVED — default chosen: Stop on every row.)**  | DOR-1345 excluded held rows for a reason that only held while the row's Stop was secretly the room-wide halt: pressing it on a held row would have stopped other agents' live turns. With a genuinely scoped `haltAgent`, that objection is gone. Under the definition "this room stops working with this agent now", both row kinds are the same verb with different amounts to do: a working row has a turn to interrupt and a buffer to drop, a held row has only a buffer. A person should never have to know which internal state a row is in to know what a button does. Reversible: dropping the held half is deleting one condition. |
| 3   | Does the notice name the person who pressed it?          | **Yes.** `Dorian stopped Ana.` **(RESOLVED — default chosen: name both.)**                                                                      | The room-wide line is passive (`Everything here was stopped.`) because it applies to everyone including the presser. A per-agent stop singles out one member of a shared room, so "who did this" is the first question a room-mate asks. The caller is already resolved by `requirePersonAuthor`, so it costs nothing. Reversible: the builder drops one argument.                                                                                                                                                                                                                                                                           |
| 4   | A new `RoomNoticeCode`, or reuse `halted`?               | **Reuse `halted`**, add `subjectAuthorId`.                                                                                                      | `RoomNoticeCodeSchema` widening is explicitly non-additive: `room-schemas.ts:150-157` records that a client pinned to the old enum fails to parse **any** room containing a new code. A per-agent stop is the same fact about a smaller scope, and `RoomEntryBody.subjectAuthorId` exists precisely to say who a notice is about. The docstring at `room-schemas.ts:117-120` that says `halted` carries no subject is amended by this work. `NoticeRow.tsx` already maps `halted` to its icon and renders `data-notice="halted"`, so nothing on the client has to learn a code.                                                              |
| 5   | Damping key.                                             | `noticedHalt` holds the room key **and** `haltKey(roomId, authorId)`. `workStarted(roomId, authorId)` clears both.                              | Same shape as the room key, same reason: what makes a second line a repeat is that nothing happened in between, and a claim being taken is something happening. Two presses on Ana in a quiet room is one line; Ana then Bo is two lines, because they are two different statements. A room-wide press after a per-agent one still writes, because it says something bigger that everybody else in the room needs.                                                                                                                                                                                                                           |
| 6   | Refusing an unknown or non-agent target.                 | `MEMBER_NOT_FOUND` (404), message `No such agent in this room.`                                                                                 | Silently answering `{stopped: 0}` hides a client bug behind a success. No information leaks: the caller can already see the room and its roster, which is what `requireVisibleRoom` established one line earlier. A human author on the roster is refused by the same code because from the route's view the sentence is literally true, and a second code nobody's UI would treat differently is a second thing to keep true.                                                                                                                                                                                                               |
| 7   | Ordering against DOR-1345.                               | **DOR-1345 first.** If this lands first instead, cut the held-row half and add `RoomCollector.dropOne` here, to DOR-1345's published signature. | `dropOne`, the `held` map and `releaseHold(key, 'halted')` are all DOR-1345's. Both halves of this work are independent: the working-row Stop needs none of them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8   | Response shape.                                          | Reuse `HaltRoomResponseSchema` — `{ stopped: number }`, always 0 or 1.                                                                          | Same question, same answer shape. A second schema differing only in cardinality is a second thing to keep true, and the peek does not read the number at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9   | Does the archived-room carve-out apply?                  | **Yes**, same as `haltRoom`.                                                                                                                    | Archiving stops a room gaining messages. A turn that was already running is still running, and refusing to stop it would put the only way to stop it behind a door that just shut.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | Does the footer's Stop stay?                             | Yes, unchanged, gated on `rows.length > 1`. Its count now includes held rows.                                                                   | With one row, the row's Stop already is everything. With more than one, the room-wide verb is still the fastest way to stop everything, and the count stays honest because the room-wide halt really does drop held collections too.                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | Does an agent halting another agent become possible?     | **No.** `requirePersonAuthor` runs on this route exactly as on `halt`.                                                                          | An agent stopping a room-mate mid-sentence is the arbitration ADR 260726-170125 declined twice. Scoping the verb makes it more tempting, not less, which is why the gate is asserted in the route test table rather than assumed.                                                                                                                                                                                                                                                                                                                                                                                                            |
| 12  | Does the stopped agent get muted?                        | **No.** Later messages collect and are answered normally.                                                                                       | Stop ends a turn. A person who wants an agent to stop answering changes its response mode or removes it, and conflating the two would make a control action into a setting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | Bridged rooms.                                           | The per-agent line rides the existing `halted` entry in `DELIVERABLE_NOTICES` with **no** bridge-specific rewrite.                              | `deliver.ts:600` already reasons that `halted` needs no rewrite because its own words work for an outside reader. `Dorian stopped Ana.` reads the same way in Telegram as in the cockpit. `turn_failed` needed a rewrite only because it says "open the session", which a bridged reader cannot do.                                                                                                                                                                                                                                                                                                                                          |
| 14  | Client mutation shape.                                   | A new `useHaltAgent` beside `useHaltRoom`, not a widened input.                                                                                 | Different `meta.errorLabel` ("Couldn't stop this agent"), different call site, no shared cache writes to coordinate. Widening `HaltRoomInput` with an optional `authorId` reintroduces Decision 1's failure mode on the client.                                                                                                                                                                                                                                                                                                                                                                                                              |

## 6) Risks

| Risk                                                                                     | Mitigation                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The 2026-08-15 interrupt race is re-opened by a `haltAgent` that marks after an `await`. | The mark is the first statement in the method, before the notice and before any `await`, and a unit test drives a runtime that ignores the interrupt and then finishes normally — the same runtime `room-stopped-turns.test.ts` already uses, for the same reason. |
| The stopped agent immediately re-claims from the messages that triggered it.             | The scoped buffer drop runs before `releaseClaim`, mirroring `halt`. A unit test halts an agent mid-gather and asserts no turn runs for the dropped messages.                                                                                                      |
| Stopping one agent silently stops another.                                               | The dispatcher touches exactly one `agentKey`. A unit test with two agents working asserts the other one still finishes and still posts.                                                                                                                           |
| Two halt notices for one press, or none.                                                 | The per-agent damping key is asserted in both directions: twice on Ana is one line, Ana then Bo is two.                                                                                                                                                            |
| `workStarted`'s signature change misses a caller.                                        | It has exactly one caller (`room-trigger.ts:2057`) and it already holds `claim.authorId`. TypeScript catches the rest.                                                                                                                                             |
| DOR-1345 lands after this and the held-row code references a map that does not exist.    | Decision 7 states the split and the fallback. The working-row half compiles and ships with neither.                                                                                                                                                                |

## 7) Recommendation

Move to SPECIFY and build it as one PR. The design is a scoped copy of a function whose every
ordering constraint is already written down beside it, plus one route, one notice line, and one
condition in the peek. The only genuinely new judgment is Decision 2, and it makes the peek
simpler rather than more complicated: every row has a Stop, and the footer means "and everything
else".
