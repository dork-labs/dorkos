# Turn marks: one mechanism for outsider, tool-read and teammate marks

Design note for DOR-3036. Status: reviewed by @security-auditor on 2026-10-18 (OK for PR A with the additions now written in below, and the open questions answered at the end).

## The problem in one paragraph

A turn is held to the teammate tier and counted against a space's monthly limit only when a message it _answers_ was a teammate's (`rooms/limits/space-teammates.ts` `teammateOf`, read into `roomTurn.teammate` by `rooms/room-trigger/run-turn.ts`). Ana's teammate turn posts `@bo`; Bo answers Ana, so Bo runs unfenced (other rooms, chats, files, cards to the owner, folder grants, his notes) and unmetered. From Bo, `chat_send`, `session_start` and `tasks_create` pass on nothing teammate at all. Reproduced, as `it.fails`, in `rooms/__tests__/room-teammate-hop.test.ts` and `core/turn-power/__tests__/teammate-mark.agent-hops.test.ts`.

The outsider mark already half-solves this shape: a stranger's words ride the turn's recorded level (`TurnPermissionLevel.outsider`, `core/turn-power/turn-levels.ts`) through every hop that carries a level. Bo does inherit Ana's read-only level and outsider mark today. What is missing is a mark that says _whose_ chain this is, and one place that turns a mark into limits.

## Decisions

1. **One mark set, three kinds.** `TurnMarks` holds `outsider?: true` today, `toolRead?: true` and `teammate?: TeammateMark[]` later. One set, so a hop that carries one kind carries all of them; three kinds, because each has a different effect.
2. **The set rides the level it already rides.** The marks are flat fields on `TurnPermissionLevel` (`outsider` is the first, and keeps its name and wire shape), and `TurnMarks` is exactly those fields (`core/turn-power/turn-marks.ts`, `TURN_MARK_KINDS`). Every carrying path already passes a level or a ceiling (below), so no path needs a new channel, `stricterLevel` already merges two turns' levels, and ceilings already stored in `chat_messages.ceiling_json` read back unchanged. Reason for flat fields over a nested `marks` object: no stored row and no existing suite changes shape in PR A.
3. **Effects are applied at one seam.** A decorator, `applyTurnMarks` (`turn-marks.ts`), wraps the level record, and `recordTurnLevels` returns the two together, so marks are applied after the level is recorded on every runtime the registry wraps (`core/runtime-seam/decorate-runtime.ts`). It reads the marks the turn will carry (from `opts.permissionCeiling` and `opts.roomTurn`). In PR A it applies today's only seam effect, counting the agent's running marked turns for callers with no session; in PR B it also rewrites `opts` for a teammate mark before the runtime sees them. Every turn passes that seam (composer, room, chat queue, relay, scheduled run, the agent computer), so a new carrying path cannot forget to apply a mark. Reason: today each dispatcher applies teammate limits itself, which is exactly how one hop skipped them. The readers every enforcement point uses are `marksOf`, `markedBoundOf` (`turn-levels.ts`, which owns the record) and `startedByOutsider` (`turn-marks.ts`).
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

The outsider mark has two readings, kept apart as today. **Direct** (a stranger started this turn) is decided by the origin bookkeeping in `session/origin/outsider-turns.ts` and read through `startedByOutsider`. **Carried** (the turn read an outsider's words) is the `outsider` field and read through `marksOf`. Only the direct reading drives the post and note cap, `commitments_list` and the failure wake, exactly as today.

`TeammateMark = { communityRef, ownerKey, teammateAuthorId, roomId }`, taken where the teammate entry is read. `roomId` is the space room the chain began in; the first two are the space connection the monthly limit is keyed on (`TeammateSpend.allows(ref, ownerKey)`), resolved through `RemoteMirrorStore.connectionOf(roomId)` at the start, so a downstream turn outside the space can still be counted.

## What carries them

| Path                                                                     | Carrier today                                                      | Change                                                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room post or mention                                                     | `noteEntryLevel`/`entryLevelOf`, read by `ceilingForEntry`         | marks ride the level; `teammateOf` also reads `entryLevelOf(id).marks.teammate`                                                                                |
| `chat_send`, chat queue                                                  | `senderCeiling` into `chat_messages.ceiling_json`, `launchCeiling` | `parseCeiling` keeps `marks`                                                                                                                                   |
| `session_start`                                                          | `outsiderBoundOf` as the first-turn ceiling                        | renamed `markedBoundOf`; returns a bound when any mark is present                                                                                              |
| Relay delivery                                                           | `'runtime-default'` ceiling                                        | unchanged (always outsider)                                                                                                                                    |
| Schedule created in a marked turn                                        | nothing                                                            | new `pulse_schedules.origin_marks` column, set by the tasks create capability from the caller's session; the scheduler sends it as the run's ceiling           |
| Memory write                                                             | `MemoryProvenance.outsider` stamp                                  | the stamp names each kind; a marked turn cannot replace or remove a note (today's `outsider-held` rule)                                                        |
| Schedule edited in a marked turn (`tasks_update`)                        | nothing                                                            | worse than create: it can retarget an armed schedule the owner trusts. The edit writes `origin_marks` (union with any already there) and re-parks the schedule |
| Commitment made in a marked turn                                         | nothing                                                            | the commitment row keeps the turn's marks; the later turn its due date wakes runs with them as its ceiling                                                     |
| Persona and settings edits (`update_agent`, `SOUL.md`, heartbeat config) | only the permission gate's ask on a permission change              | every later turn reads these, so a marked turn's edit is held for a person (as a parked schedule is) rather than marking every later turn                      |
| Extension and mini-app APIs that post or start turns (DOR-3017)          | varies                                                             | a call made inside a turn carries that turn's marks; a call from extension code itself carries the outsider mark, since code from strangers is never trusted   |
| Agent computer `turn.start` (part 6)                                     | tier `owner \| teammate` only                                      | its payload carries the whole mark set, and the computer's side refuses a turn whose marks it cannot hold                                                      |

## What a marked downstream turn gets

- **teammate:** the full teammate tier, the same as a turn a teammate's post started. `applyTurnMarks` sets `unattended`, drops `additionalDirectories`, adds a `read-only` bound, and sets `opts.turnMarks.teammate`. The Claude Code runtime reads the tier scope, `TEAMMATE_TURN_CONTEXT` and note exclusion from `turnMarks` instead of `roomTurn.teammate`. Outside a room the tier scope has no room, so every room tool is refused and the turn can only reply where it was asked. `meterTeammateTurns` counts the turn against each marked connection (the sink takes the connection, not a room id). A marked turn whose space is already at its limit is refused before it starts, as a teammate's post is today (`wake-policy.ts`). A marked turn bound for a runtime that cannot hold the tier (Codex, OpenCode) is refused (`refuseTeammateTurnOn`).
- **outsider:** exactly today's effects; see the next section.
- **tool-read:** a later PR. Intended effect: the same as a carried outsider mark (stamped notes, notes held, the permission gate asks before a destructive action or a permission change), with no power bound of its own.

## Tool-read: how the mark is minted (code in a later PR, unblocks #3038)

- A tool result marks the turn unless the tool is on an explicit trusted list in `turn-marks.ts`. The list names DorkOS's own tools whose results come only from this computer's own state and from people on it (a room's history is not one of them: strangers write there).
- An unknown tool, any other MCP server's tool, a connector action, a web fetch and a file read outside the agent's own folder all mark. Unknown counts as marked.
- The mark is set when the result reaches the turn, and lasts the rest of the turn.

## Out of scope

A mark left in a file in a repository (a line a marked turn wrote into `CLAUDE.md` or a skill) is not tracked on the file. It is caught only when a later turn reads it back, by the tool-read mark.

## Moving the outsider cap with no behaviour change

PR A only renames where the fact is read. Every point keeps its own effect:

| #   | Enforcement today                                                                                                                      | Reads                                                   | New home                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| 1   | Memory stamp and `outsider-held` (`memory-capabilities.ts`)                                                                            | `outsiderBoundOf`                                       | `marksOf(session, agent).outsider`             |
| 2   | Permission gate asks (`permission-enforcement.ts` `strangerTurn`)                                                                      | `outsiderBoundOf`                                       | `marksOf(...).outsider`                        |
| 3   | Destructive hold, stranger turn (`destructive-hold-window.ts`)                                                                         | `turnStartedByOutsider` or `outsiderBoundOf`            | `startedByOutsider` or `marksOf(...).outsider` |
| 4   | Destructive hold, never-asks level (same file)                                                                                         | `level.outsider`                                        | `marksOfLevel(level).outsider`                 |
| 5   | `session_start` first-turn ceiling (`session-tools.ts`)                                                                                | `outsiderBoundOf`                                       | `markedBoundOf`                                |
| 6   | Steer refusal (`ChatMessageService.maySteer`)                                                                                          | `level.outsider`                                        | `carriesAllMarks(receiver, sender)`            |
| 7   | Agent-less callers (Codex over `/mcp`)                                                                                                 | `turn-levels.ts` counting into `live-outsider-turns.ts` | `applyTurnMarks` counting each kind            |
| 8   | Post and note cap of 3 (`outsider-output.ts`)                                                                                          | `turnStartedByOutsider`                                 | `startedByOutsider`                            |
| 9   | `commitments_list` and the heartbeat status capability (`capabilities/registry.ts` context), the failure wake (`session-lifecycle.ts`) | `turnStartedByOutsider`                                 | `startedByOutsider`                            |
| 10  | Unanswered outsider in view (`outsiderInViewOf`)                                                                                       | `entryLevelOf(id).outsider`                             | `marksOfLevel(entryLevelOf(id)).outsider`      |

The ceiling bound itself (`powerForTurn`, `turn-permission.ts`) does not move: marks never bound power, except the teammate's read-only bound in PR B. Minting the outsider mark (`levelForTurn`) reads `marksForTurn(opts)`. `outsiderBoundOf` stays exported, now defined through `marksOf`, because the existing agent-hops suite names it. Its origin bookkeeping (`noteTurnOrigin`, `holdTurnOriginFor`) is how the direct reading is decided and does not move. The existing outsider suites must pass unchanged.

## Proving the seam

A census test (`core/runtime-seam/__tests__/turn-marks-seam.census.test.ts`) fails if any runtime can reach a turn without `applyTurnMarks`:

- the registry's map has one writer, `RuntimeRegistry.register`, and it wraps every runtime in `decorateRuntime`; no other module makes a registry;
- every `register` call site in the server goes through the one registry (built-ins, the test runtime, a late or extension-registered runtime, and the agent computer bridge, `startup/computers.ts`);
- behaviourally, a runtime registered under each of those types, at any time, has its marked turns counted while they run, for a sent turn and for a turn the runtime starts on its own.

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

- **Schedule:** a marked schedule, created or edited in a marked turn, is parked, never armed by `agentSchedulesArmWithoutAsking`. Its approval card (`tasks/approvals/task-approvals.ts`) shows the prompt and target, and each mark it carries with its source (which stranger, which teammate and space, which tool). Approving it clears `origin_marks`; the run is then the owner's. Only a person at the computer can approve it: not from a phone over Wi-Fi (DOR-3037), and never with "Always allow".
- **Persona or settings edit:** held the same way, on the same card rules.
- **Memory note:** a person's own edit of the note drops the stamp.
- **Chat queue and posts:** nothing to clear. A queued message runs once; a person's next message starts an unmarked turn.

No agent, tool or request body can clear a mark: only an owner-authenticated action does.

## Tests

One per carrying path, each flipping an existing `it.fails`: room mention (tier + metered), `chat_send`, `session_start`, a schedule's run. Added in PR B: `tasks_update`, a commitment's wake, a held persona edit, memory write refused by the tier, a steer cannot unmark, a marked turn on Codex or OpenCode is refused, a marked turn over the space's limit is refused, two spaces' marks count against both, and marks survive a restart through each durable column. PR A: the existing outsider suites unchanged, the seam census, and unit tests of the mark operations.

## Migration and PR split

- **PR A (mechanism, no behaviour change):** `TurnMarks` on the level, `marksOf`/`markedBoundOf`/`startedByOutsider`, the ten readers moved as tabled, `applyTurnMarks` at the seam applying only today's effects, the seam census. The nullable columns come with the kind that first needs them (PR B). Opens with `hold` for Security.
- **PR B (teammate kind, plus one named behaviour change):** `TeammateMark` minted at `teammateOf`, carried by every path above, the tier and meter keyed on it, the per-agent fallback counting teammate turns too. Named behaviour change: a schedule created or edited in any marked turn, outsider included, parks for a person. Flips the five `it.fails`. Opens with `hold`.
- **Later (tool-read, #3038):** minted by tool and connector results; its own PR.

## Open questions, answered by Security (2026-10-18)

1. A schedule created in an outsider-marked turn parks too, in PR B, as a named behaviour change; edits count as well as creates.
2. Counting a turn against two spaces' limits is fine; over-counting errs the safe way.
3. A teammate-marked turn bound for Codex or OpenCode is refused: fail closed until DOR-2978.
4. Outside a room, a teammate-marked turn may reply in its own chat only.
5. The per-agent fallback for callers with no session counts teammate-marked turns too.
