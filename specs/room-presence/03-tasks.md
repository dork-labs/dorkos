# Room presence — task breakdown

**Spec:** `specs/room-presence/02-specification.md` (id `260729-145341`)
**Generated:** 2026-07-29 (DECOMPOSE) · **Canonical file:** `03-tasks.json` — this document is a projection of it, for browsing and diffs.

**8 tasks across 3 phases.** Every task is one PR's worth of work, states its dependencies, and names a verification you **run**. Every seeded-defect direction is spelled out — a check whose absence produces the same output as its presence was rejected as not a task.

## The graph

```
1.1  claim survives to the terminal, carries entryId + sessionId
 └─▶ 1.2  signal payload + publisher + republish loop
      ├─▶ 1.3  cockpit presence line ──▶ 1.4  etiquette E16a + conduct rule + docs + changelog
      ├─▶ 2.1  room_presence global event + sidebar dot
      ├─▶ 2.2  Telegram claim-driven typing (at-receipt hook deleted)
      ├─▶ 3.1  Slack :eyes: at claim + assistant status
      └─▶ 3.2  CommunityAdapter publishSignal payload + C15   ◀── blocked by DOR-591, DOR-592
```

**Critical path:** 1.1 → 1.2 → 1.3 (a person sees who is working — the operator's scenario, solved by phase 1 alone).
**Widest parallel front:** after 1.2, tasks **1.3**, **2.1**, **2.2** and **3.1** are mutually independent — different files, different packages.

| #       | Outcome                                                             | Size   | Deps                    |
| ------- | ------------------------------------------------------------------- | ------ | ----------------------- |
| **1.1** | A slow turn never looks idle; the claim knows entry + session       | medium | —                       |
| **1.2** | Rooms publish working / working-late / done, self-healing every 10s | large  | 1.1                     |
| **1.3** | The presence line under the composer, honest through reconnects     | large  | 1.2                     |
| **1.4** | The etiquette standard, conduct rule, docs and changelog catch up   | small  | 1.3                     |
| **2.1** | Sidebar working-dot via the new `room_presence` global event        | medium | 1.2                     |
| **2.2** | Telegram typing driven by the turn, not the receipt                 | medium | 1.2                     |
| **3.1** | Slack: eyes-at-claim reaction, assistant status where it exists     | medium | 1.2                     |
| **3.2** | The community port carries the presence payload; C15 strengthened   | medium | 1.2 + DOR-591 + DOR-592 |

## Tracker placement, and why

Issues live in Linear (team DorkOS), one issue per task, `type/task`, Todo. Placement follows the operator's programme split:

- **Tasks 1.1–1.4, 2.1, 2.2, 3.1 → project "Agents as First-Class Operators"** — the rooms/conduct programme's home (the RP-series and room primitive work live there). Telegram and Slack (2.2, 3.1) are relay-adapter surfaces, not community-port surfaces: they express the same rooms-presence lifecycle on platforms the operator already bridges, carry no dependency on the community programme, and are phased inside this spec — so they ride with the rooms work rather than with the port.
- **Task 3.2 → project "Multi-User Communities"** — it amends the `CommunityAdapter` port and cannot start before DOR-591 (the interface + conformance suite) exists, and its C15 round-trip needs DOR-592 (local rooms as adapter #1) as the `'both'` implementation. Both blocking edges are recorded as real Linear relations, not prose.

Not filed at all, deliberately: the Buzz kind-20002/reaction emission and any future `presence`/reaction capability flag — the spec's scope table (§11) assigns both to the community programme, to be filed with the write-capable Buzz connector when it exists.

## What DECOMPOSE changed against the specification

Nothing was removed and no figure moved; the decomposition re-verified the spec's anchors against `c70de1389` (they were re-cited in the same commit after the review round) and carried three review-round corrections into the task bodies rather than discovering new ones:

1. **The release invariant is wider than first written** — three shipped release-without-fresh-notice paths (the damped repeat at `room-trigger.ts:663`, the archived-room `writeNotice` failure at :716–727, and `deliverLate`'s `.catch` at :634–640). Task 1.1 closes the third (best-effort `reportSilence` in the `.catch`); tasks 1.1/1.2 pin the other two as chosen behavior with seeded-defect tests.
2. **The sidebar dot cannot ride `room_activity`** (entry-committed, `seq`-carrying). Task 2.1 builds the `room_presence` sibling and owes the both-ends allowlist entry in the same PR.
3. **The silent-late-turn refusal is new behavior**, introduced by holding claims longer, and is accepted with a named copy-collision to watch in dogfooding. Task 1.1 carries its test.

## What was checked and held

- The three B1 release paths exist exactly as reviewed (`room-trigger.ts:663`, `:716–727`, `:634–640` at `c70de1389`).
- `publishSignal` has zero production call sites; the one test caller is `apps/server/src/routes/__tests__/rooms-events.test.ts:291` and moves with task 1.2.
- `answersEntryId` has zero hits in the tree — task 1.3's clear-on-post rule keys on the author, not the trigger link.
- The allowlist guard lives at `apps/server/src/services/core/__tests__/sse-event-allowlist.test.ts`; there is no `room-trigger.test.ts` — trigger behavior is tested through `room-silence.test.ts` / `cascade-guard.test.ts` / `room-turn-runner.test.ts`, which is why 1.1 names a new `room-presence-claims.test.ts`.
- Telegram carries **two** typing loops (`outbound.ts:435+` capped, `grammy-platform-client.ts:163–183` uncapped); task 2.2 explicitly retires one rather than leaving a tolerated duplicate.

---

### Task 1.1: The claim survives until the turn is done, and knows what it is answering

Phase 1 · medium · deps: none
See `03-tasks.json` for the full self-contained body. Outcome: `ActiveClaim` gains `entryId`, `sessionId`, `pastDeadline`; claims live to the turn's terminal (late claims are deleted when `afterDeadline` settles, either way); `deliverLate`'s `.catch` writes the damped `turn_failed` notice; `workingIn`/`room_context.working` stop understating during the late window.
Verify: `pnpm vitest run apps/server/src/services/rooms/__tests__/room-presence-claims.test.ts apps/server/src/services/rooms/__tests__/room-silence.test.ts apps/server/src/services/rooms/__tests__/cascade-guard.test.ts`

### Task 1.2: Rooms publish the working signal, and keep publishing while it is true

Phase 1 · large · deps: 1.1
Outcome: `RoomSignalEventSchema` gains optional `state`/`entryId`/`since`; `publishSignal` widens; the dispatcher publishes `working` at claim, `working_late` at the wait deadline, `done` after every terminal's durable write; a 10 s republish loop runs only while claims exist. OpenAPI regenerated.
Verify: `pnpm vitest run apps/server/src/routes/__tests__/rooms-events.test.ts apps/server/src/services/rooms/__tests__/room-presence-claims.test.ts`

### Task 1.3: The room shows who is working on it

Phase 1 · large · deps: 1.2
Outcome: presence store in `entities/room` (keys `(authorId, entryId)`, 30 s TTL, cleared by `done` / author's own post / stalled stream), `RoomPresenceLine` under the composer with the exact copy set, aggregation past three, browser-verified.
Verify: `pnpm vitest run apps/client/src/layers/entities/room/model/__tests__/use-room-presence.test.ts apps/client/src/layers/widgets/room-view/__tests__/RoomPresenceLine.test.tsx` + the new e2e spec.

### Task 1.4: The standard covers the mechanism: etiquette E16a, conduct rule, docs, changelog

Phase 1 · small · deps: 1.3
Outcome: E16a in `meta/agent-etiquette.md` ("while a claim is held"), the widened release invariant in `.claude/rules/room-conduct.md`, the docs concept section, one user-facing changelog fragment.
Verify: `python3 .claude/scripts/changelog_backfill.py --since "$(git merge-base origin/main HEAD)" --validate --changed-only` exits 0 with ≥1 fragment checked; `pnpm --filter @dorkos/site lint`.

### Task 2.1: The sidebar shows which rooms have an agent working

Phase 2 · medium · deps: 1.2
Outcome: new `room_presence` global event `{roomId, working}` (claim transitions + republish tick), the `GENERIC_EVENTS` literal in the same PR, the sidebar dot, and a `working` count on `GET /api/rooms`.
Verify: `pnpm vitest run apps/server/src/services/core/__tests__/sse-event-allowlist.test.ts apps/server/src/routes/__tests__/rooms-events.test.ts` + the client entity tests.

### Task 2.2: Telegram stops faking it: typing driven by the turn, not the receipt

Phase 2 · medium · deps: 1.2
Outcome: the `onPublished` at-receipt hook and the blind 60 s cap are deleted; the 4 s `sendChatAction` refresh runs from turn start to terminal; the duplicate loop in `grammy-platform-client.ts` is retired.
Verify: `pnpm vitest run packages/relay/src/adapters/telegram/__tests__/` — including the red-today test that an untriggering message sends zero chat actions.

### Task 3.1: Slack shows working the way Slack says it: eyes at claim, status where the surface exists

Phase 3 · medium · deps: 1.2
Outcome: `:eyes:` at claim / removed at terminal (FIFO kept, `'none'` untouched), `assistant.threads.setStatus` set/late-update/clear on the one surface it exists on, no completion emoji.
Verify: `pnpm vitest run packages/relay/src/adapters/slack/__tests__/`

### Task 3.2: The community port can say who is working: publishSignal payload + C15

Phase 3 · medium · deps: 1.2, blocked by DOR-591 and DOR-592
Outcome: the Amendment-2 `publishSignal` payload on the port, C15's `'both'` branch round-trips it, no new capability flag, and no pseudo-assertion of the producer-side honesty rule the port cannot check.
Verify: the DOR-591 conformance suite run with both C15 branches executing.
