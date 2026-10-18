# Turn marks: one mechanism for outsider, tool-read and teammate marks

Design note for DOR-3036. For @security-auditor to review before any code. Status: draft.

## The problem in one paragraph

A turn is held to the teammate tier and counted against a space's monthly limit only when a message it _answers_ was a teammate's (`rooms/limits/space-teammates.ts` `teammateOf`, read into `roomTurn.teammate` by `rooms/room-trigger/run-turn.ts`). Ana's teammate turn posts `@bo`; Bo answers Ana, so Bo runs unfenced (other rooms, chats, files, cards to the owner, folder grants, his notes) and unmetered. From Bo, `chat_send`, `session_start` and `tasks_create` pass on nothing teammate at all. Reproduced, as `it.fails`, in `rooms/__tests__/room-teammate-hop.test.ts` and `core/turn-power/__tests__/teammate-mark.agent-hops.test.ts`.

The outsider mark already half-solves this shape: a stranger's words ride the turn's recorded level (`TurnPermissionLevel.outsider`, `core/turn-power/turn-levels.ts`) through every hop that carries a level. Bo does inherit Ana's read-only level and outsider mark today. What is missing is a mark that says _whose_ chain this is, and one place that turns a mark into limits.

## Decisions

1. **One mark set, three kinds.** `TurnMarks = { outsider?: OutsiderMark; toolRead?: true; teammate?: TeammateMark[] }`. One set, so a hop that carries one kind carries all of them; three kinds, because each has a different effect.
2. **The set rides the level it already rides.** `TurnPermissionLevel.outsider` becomes `TurnPermissionLevel.marks`. Every carrying path already passes a level or a ceiling (below), so no path needs a new channel, and `stricterLevel` already merges two turns' levels.
3. **Effects are applied at one seam.** A new decorator, `applyTurnMarks`, sits in `core/runtime-seam/decorate-runtime.ts` just outside `recordTurnLevels`. It reads the marks the turn will carry (from `opts.permissionCeiling` and `opts.roomTurn`) and rewrites `opts` before the runtime sees them. Every turn passes that seam (composer, room, chat queue, relay, scheduled run), so a new carrying path cannot forget to apply a mark. Reason: today each dispatcher applies teammate limits itself, which is exactly how one hop skipped them.
4. **Unknown counts as marked.** A ceiling with no record (`'runtime-default'`, an empty list, a level not kept after a restart) carries the outsider mark, as today (`ceilingCarriesOutsider`). In a space's room copy, an entry nobody vouched for stays a teammate's (`isTeammateEntry`).
5. **Marks last the whole turn and are only ever added.** A turn's marks are fixed when it is sent, plus anything a room shows it (`outsiderInView`). A steer may add marks, never remove them (`ChatMessageService.maySteer` already refuses a marked sender into an unmarked turn; it extends to every kind).
6. **Most restrictive wins; teammate origins are a union.** Combining two sets keeps every kind present. `teammate` is a list of distinct `{ communityRef, ownerKey }` pairs, so a turn two spaces' teammates reached is capped by both and counted against both. Reason: double counting errs toward the limit; picking one would let the other space's teammate ride free.

## Where marks start

| Source                                       | Kind                | Today's code                                                      |
| -------------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| Telegram/Slack stranger, unresolvable author | outsider (direct)   | `turn-ceiling.ts` `ceilingForEntry` (`'runtime-default'`)         |
| Relay, A2A, external MCP sender              | outsider (direct)   | `RELAY_TURN_CEILING`, relay `agent-handler.ts`                    |
| A connector event, an outside-sender launch  | outsider (direct)   | `session/origin/outsider-turns.ts` `OUTSIDER_ORIGIN_KINDS`        |
| Stranger's line shown but not answered       | outsider (carried)  | `outsiderInViewOf`                                                |
| Space member who is not the owner            | teammate + outsider | `isTeammateEntry`, ceiling `['runtime-default', READ_ONLY_LEVEL]` |
| Tool or connector result in the turn         | tool-read           | none yet (#3038)                                                  |

`OutsiderMark = { direct: boolean }`. `direct` is set only on the turn a stranger started; every downstream copy has `direct: false`. This keeps the split that exists today between "started by an outsider" (`turnStartedByOutsider`) and "read an outsider's words" (`level.outsider`).

`TeammateMark = { communityRef, ownerKey, teammateAuthorId, roomId }`, taken where the teammate entry is read. `roomId` is the space room the chain began in; the first two are the space connection the monthly limit is keyed on (`TeammateSpend.allows(ref, ownerKey)`), resolved through `RemoteMirrorStore.connectionOf(roomId)` at the start, so a downstream turn outside the space can still be counted.

## What carries them

| Path                              | Carrier today                                                      | Change                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room post or mention              | `noteEntryLevel`/`entryLevelOf`, read by `ceilingForEntry`         | marks ride the level; `teammateOf` also reads `entryLevelOf(id).marks.teammate`                                                                      |
| `chat_send`, chat queue           | `senderCeiling` into `chat_messages.ceiling_json`, `launchCeiling` | `parseCeiling` keeps `marks`                                                                                                                         |
| `session_start`                   | `outsiderBoundOf` as the first-turn ceiling                        | renamed `markedBoundOf`; returns a bound when any mark is present                                                                                    |
| Relay delivery                    | `'runtime-default'` ceiling                                        | unchanged (always outsider)                                                                                                                          |
| Schedule created in a marked turn | nothing                                                            | new `pulse_schedules.origin_marks` column, set by the tasks create capability from the caller's session; the scheduler sends it as the run's ceiling |
| Memory write                      | `MemoryProvenance.outsider` stamp                                  | the stamp names each kind; a marked turn cannot replace or remove a note (today's `outsider-held` rule)                                              |

## What a marked downstream turn gets

- **teammate:** the full teammate tier, the same as a turn a teammate's post started. `applyTurnMarks` sets `unattended`, drops `additionalDirectories`, adds a `read-only` bound, and sets `opts.turnMarks.teammate`. The Claude Code runtime reads the tier scope, `TEAMMATE_TURN_CONTEXT` and note exclusion from `turnMarks` instead of `roomTurn.teammate`. Outside a room the tier scope has no room, so every room tool is refused and the turn can only reply where it was asked. `meterTeammateTurns` counts the turn against each marked connection (the sink takes the connection, not a room id). A marked turn whose space is already at its limit is refused before it starts, as a teammate's post is today (`wake-policy.ts`). A marked turn bound for a runtime that cannot hold the tier (Codex, OpenCode) is refused (`refuseTeammateTurnOn`).
- **outsider:** exactly today's effects; see the next section.
- **tool-read:** a later PR. Intended effect: the same as a carried outsider mark (stamped notes, notes held, the permission gate asks before a destructive action or a permission change), with no power bound of its own.

## Moving the outsider cap with no behaviour change

PR A only renames where the fact is read. Every point keeps its own effect:

| Enforcement today                                                 | Reads                                        | New home                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| Ceiling bound (`powerForTurn`, `turn-permission.ts`)              | `permissionCeiling`                          | unchanged; marks never bound power except the teammate's read-only bound |
| Memory stamp and `outsider-held` (`memory-capabilities.ts`)       | `outsiderBoundOf`                            | `marksOf(session, agent).outsider`                                       |
| Permission gate asks (`permission-enforcement.ts` `strangerTurn`) | `outsiderBoundOf`                            | same, via `marksOf`                                                      |
| Destructive hold window (`destructive-hold-window.ts`)            | `turnStartedByOutsider` or `outsiderBoundOf` | `marksOf(...).outsider`                                                  |
| `session_start` first-turn ceiling (`session-tools.ts`)           | `outsiderBoundOf`                            | `markedBoundOf`                                                          |
| Steer refusal (`ChatMessageService.maySteer`)                     | `level.outsider`                             | subset check on the whole set                                            |
| Agent-less callers (Codex over `/mcp`)                            | `live-outsider-turns.ts`                     | counts per agent and per kind                                            |
| Post and note cap of 3 (`outsider-output.ts`)                     | `turnStartedByOutsider`                      | `marks.outsider.direct`                                                  |
| `commitments_list`, status capability, failure notices            | `turnStartedByOutsider`                      | `marks.outsider.direct`                                                  |
| Unanswered outsider in view (`outsiderInViewOf`)                  | `entryLevelOf(id).outsider`                  | `entryLevelOf(id).marks.outsider`                                        |

`turnStartedByOutsider` stays as the reader of `direct`; its origin bookkeeping (`noteTurnOrigin`, `holdTurnOriginFor`) is how `direct` is decided and does not move. The existing `outsider-protections.agent-hops.test.ts` must pass unchanged.

## Data shape and persistence

- In memory: `turn-levels.ts` keeps `{ level, marks }` per session and per entry, bounded as today.
- Durable, so a restart does not drop a teammate mark: `room_entries.turn_marks` (JSON, nullable), `chat_messages.ceiling_json` (already JSON; now keeps `marks`), `pulse_schedules.origin_marks` (JSON, nullable), and the memory stamp. Each is a Drizzle migration with a nullable column, so old rows read as "no record", which means outsider, the fail-closed answer.
- A turn this process never recorded is read as today: the runtime default, outsider marked.

## Loops, fan-out, performance

Marks only grow along a chain and never come back off, so a loop cannot launder; the existing turn-counting loop guards still stop the loop itself (DOR-2745 owns their replacement). Fan-out copies the set to each receiver. Cost: one small object per recorded turn and per post, and one map read per send at a seam that already reads the same maps. No extra I/O except the column writes, which ride writes that already happen.

## What the agent sees

A teammate-marked turn gets the existing `<teammate_turn>` prompt block, whichever path started it, and refusals keep the existing `TEAMMATE_TIER_DENIAL` text, so the agent explains instead of retrying. Outsider and tool-read marks add nothing to the prompt (today's behaviour); words from outside stay inside the untrusted fence.

## Only a person clears a mark

A mark lasts its turn, so the next turn a person starts is unmarked. A person clears the durable copies:

- **Schedule:** a marked schedule is parked, never armed by `agentSchedulesArmWithoutAsking`. Approving it in the schedule's approval card (`tasks/approvals/task-approvals.ts`) clears `origin_marks`; the run is then the owner's.
- **Memory note:** a person's own edit of the note drops the stamp.
- **Chat queue and posts:** nothing to clear. A queued message runs once; a person's next message starts an unmarked turn.

No agent, tool or request body can clear a mark: only an owner-authenticated action does.

## Tests

One per carrying path, each flipping an existing `it.fails`: room mention (tier + metered), `chat_send`, `session_start`, a schedule's run. Added in PR B: memory write from a marked turn is refused by the tier; a steer cannot unmark; a marked turn on Codex is refused; a marked turn over the space's limit is refused; two spaces' marks count against both; marks survive a restart through each durable column. PR A: the existing outsider suites, unchanged, plus a census test that every reader listed above goes through `marksOf`.

## Migration and PR split

- **PR A (mechanism, no behaviour change):** `TurnMarks` on the level, `marksOf`/`markedBoundOf`, the readers moved as tabled, `applyTurnMarks` wired but applying only today's effects, nullable columns. Opens with `hold` for Security.
- **PR B (teammate kind):** `TeammateMark` minted at `teammateOf`, carried by every path, the tier and meter keyed on it, the schedule park and approval clear. Flips the five `it.fails`. Opens with `hold`.
- **Later (tool-read, #3038):** minted by tool and connector results; its own PR.

## Open questions for Security

1. Should a schedule created in an outsider-marked turn also park? Today it arms on Trusted, and its runs carry nothing. That is a pre-existing outsider gap, out of PR A's no-change scope; flag it or fold it into PR B?
2. Counting a two-space turn against both limits: acceptable over-count, or split the cost?
3. Is refusing a teammate-marked turn on Codex and OpenCode right, or should it run with the read-only bound alone until DOR-2978 lands?
4. Tier scope outside a room: allow the turn to reply in its own chat only, or also to post back into the space room it began in?
5. Does `live-outsider-turns.ts`'s per-agent fallback (callers with no session) need a teammate count too, or is refusing teammate-marked turns on runtimes without in-session tools enough?
