# Implementation Summary: A room never asks you to resend

**Created:** 2026-08-19
**Last Updated:** 2026-08-19
**Spec:** specs/room-hold-when-busy/02-specification.md
**Tracker:** DOR-1345
**ADR:** `decisions/260818-234541-a-busy-agents-message-is-held-not-refused.md` (accepted)

## Progress

**Status:** Complete — one PR, in the order §Implementation Phases sets out.

## What shipped

### The wire (`packages/shared`)

- `RoomPresenceStateSchema` gains `held`, the one member describing work that has NOT started.
  `RoomHeldBehindSchema` (`roomId` + `othersWaiting`) is new, `RoomSignalEventSchema` carries it as
  `heldBehind`, and `RoomPresencePayload` widens to `Required<Pick<…>> & Pick<…, 'heldBehind'>`.
- `RoomEntryBodySchema` gains `answersEntryId` — specified in `specs/room-participation` §5.3 and
  never built until holding made an out-of-order answer common.
- `PromoteHoldResponseSchema` for the new route.
- `CommunityAdapter` is untouched: it reuses `RoomPresenceStateSchema`, and adding a member is
  additive for a producer. `communityConformance` gained **C15a**, which asserts that a backend
  publishing only `working`/`done` still passes.

### The dispatcher (`apps/server/src/services/rooms`)

- `claimBusyWith` returns `{ where: 'here' | 'elsewhere', blocking: ActiveClaim }` — the claim comes
  back because a held indicator has to point at the room in the way. `HeldRecord`, `HeldView`,
  `HoldEnd` and `describeHolds` live beside `ActiveClaim` in `room-claims.ts`.
- `RoomCollector`: `CollectInput.duringTurn` splits into `duringTurnHere` and `park` (they came
  apart the moment the second ceiling started holding); `RoomCollection` gains `promoted` and
  `openedSeq`; `resumeAgent`, `promote` and `dropOne` are new; `sweep` sorts promoted-first then
  oldest-first, which is what makes "in the order I asked" survive a re-park.
- `RoomTriggerDispatcher` gains a `held` map beside `claimed` and six changed seams — `collectOne`
  (the refusal deleted), `claimCollected` (parks and re-points), `holdClaim` (releases the hold
  before publishing `working`), `releaseClaim` (`resumeElsewhere`), `republishPresence` (expires
  then restates), `halt` (releases each dropped collection's hold). `settleCollection` is the seam
  that makes "no hold is forgotten" structural: all four `claimCollected` give-ups go through it.
- New: `noteHold`, `releaseHold`, `resumeElsewhere`, `expireHolds`, `promoteHold`, `listHolds`,
  `publishHold`, `heldBehind`. `RoomTriggerDeps.holdCeilingMs` reads
  `rooms.lateReplyCeilingMinutes` per tick — no new setting.
- `BUSY_LINES['working-elsewhere']` is deleted. `BusyContext` is `'held-too-long' | 'unknown'`,
  both past tense, neither asking for a resend.
- `RoomTriggerWriter.post` sets `answersEntryId` on every agent-authored post.

### The routes

- `POST /api/rooms/:id/holds/:authorId/promote` → `{ promoted: boolean }`, gated exactly like
  `POST /:id/halt`. Registered in the OpenAPI document; `docs/api` regenerated.
- `GET /api/debug/dispatches` now answers `{ claims, holds, recent }`. "Who is waiting, and behind
  what?" was the question `listClaims` could not answer during an incident.

### The client

- `use-room-presence.ts`: one store, two readers. `observe` stores `heldBehind`; `summarize`
  excludes `held`; `useRoomHolds(roomId, scope?)` is its complement through the same scope filter.
- `presence-copy.ts` gains `heldSentence` / `heldCountSentence`; `lane-state.ts` gains
  `LaneHeldAuthor`, `NO_HELD` and the tenth state at rung 4, gated by `capabilities.presence`.
- `LaneContent` gains `HeldLine` (`room-held` / `thread-held`, a `working` dot that does **not**
  pulse); `LiveLane` lets the held rung open the same peek.
- `LivePeek` rows carry `state: … | 'held'`, `behind` and `othersWaiting`, with **Open where it's
  working** and **Answer here first**; Stop counts working rows only.
- `RoomLiveLane` resolves each wait's room title against `useRooms()` — the disclosure is per
  reader, so a reader who cannot see that room reads "another conversation".
- `usePromoteHold` + `Transport.promoteHold`; the reference chip (`room-entry-answers`) is drawn by
  `RoomFlow` and `RoomThreadPanel` through `answeredReference`, and suppressed when the answered
  entry is the row directly above.

## Tests

- `services/rooms/__tests__/room-hold-elsewhere.test.ts` — 13 cases covering §Testing Strategy's
  nine plus the wire, the re-point and the thread pointer.
- `routes/__tests__/rooms-holds.test.ts` — two rooms and one agent over HTTP, including the `held`
  frame on `GET /:id/events` and the promote route's two answers.
- Extended: `room-presence-claims.test.ts`, `room-silence.test.ts`, `room-stopped-turns.test.ts`
  (each had a case pinning the refusal that is now gone — rewritten, not deleted),
  `lane-state.test.ts`, `presence-copy.test.ts`, `use-room-presence.test.tsx`,
  `RoomLiveLane.test.tsx`, `community-conformance-branched.ts`.
- `apps/e2e/tests/rooms/room-autonomy.spec.ts` — one new test on the test-mode leg: two channels,
  one agent, the `room-held` line, no notice, then the answer landing in the room that asked.

## Seeded defects run

| Defect                                       | What went red                                      |
| -------------------------------------------- | -------------------------------------------------- |
| Delete `resumeElsewhere` from `releaseClaim` | 11 of 13 hold cases                                |
| Drop `promoted` from the sweep's sort        | "lets a person ask to be answered first"           |
| Stop publishing `heldBehind`                 | both wire cases                                    |
| Restore the `collectOne` refusal             | (documented in the rewritten presence-claims case) |

## Deviations from the spec

- **`releaseHold` writes no notice; `expireHolds` does.** The spec put the `held-too-long` line
  behind `releaseHold(key, 'expired')`. Only `expireHolds` holds the dropped collection, and a
  notice has to be about a message somebody actually sent — so the write stayed with the caller
  that has the entry, and `releaseHold` is uniform across all four reasons.
- **`noteHold` takes ids rather than a `RoomCollection`.** `collectOne` never holds a collection
  object (`collect` returns a boolean), so the signature takes the entry id to key a NEW hold with
  and ignores it when one exists.
- **`HeldRecord` / `HeldView` live in `room-claims.ts`**, not `room-trigger.ts`. That module is
  already the vocabulary beside the map the dispatcher owns, which is exactly the split
  `ActiveClaim` / `ActiveClaimView` uses.
- **A held peek row draws no "replying to" quote.** Nothing is being replied to yet, and quoting
  the waiting message would read as an answer in progress.

## What is not done

Unchanged from §"What is not done" in the specification: a hold does not survive a restart,
nothing steers the blocking turn, the `unknown` busy case is still a refusal, there is no
per-author Stop, promotion reorders and never preempts, the reference chip is room-only, and a
wait draws no sidebar dot.
