---
slug: tool-only-room-replies
number: 260828-010140
created: 2026-08-28
status: specified
---

# Room replies go through tool calls only — silence, reactions and DMs become real choices

**Status:** Draft
**Author:** ideator-1613 (DOR-1613)
**Date:** 2026-08-28

## Overview

Behind a config flag, a room turn's text stops being the room message. The agent answers by calling `post_to_room`, or reacts, or deliberately says nothing — in channels **and** in DMs, on **all three runtimes**. Its reasoning stays in its own session.

This delivers the flip `specs/room-participation/02-specification.md` §10.2 designed on 2026-07-28 and DOR-1202 deferred as **DOR-1212**, and goes past it in two places: reversing §2.6's DM refusal, and auto-wiring codex and opencode to this server's own `/mcp` so the flip is not claude-code-only. **DOR-1613 formally absorbs DOR-1212** (orchestrator ruling, 2026-08-28); the tracker side is handled outside this spec.

## Background / Problem Statement

`deliver` (`room-trigger.ts:1778-1897`) posts whatever the turn narrated. Three consequences, each a thing a competent colleague does and a DorkOS agent cannot:

- **It cannot decline.** `meta/agent-etiquette.md` E4 says speak only when the contribution clears a bar; today every triggered turn clears it by construction.
- **It cannot think privately.** Deliberation lands in front of everybody, which is the over-participation E1–E18 exist to damp.
- **It cannot let a reaction be the answer.** `chat-capabilities.md` A-06 records the measured failure: _"having reacted, the agent still wrote 'Done — release notes acknowledged.', and a room turn's text is posted."_ Three rounds of prompt fixes did not close it, and the row concludes it is _"model-tuning territory, not a missing instruction."_ **It is neither. It is a mechanism gap, and this is the mechanism.**

`room-conduct.md` states the governing principle: _"Bounds are mechanisms, never prompts."_ "Only speak when it matters" is a prompt. An unmade tool call is a mechanism.

## Goals

- A turn's text is never auto-posted when the flip is on; `post_to_room` is the only voice.
- Silence and a reaction are both first-class, legible outcomes.
- A person who **asked** always gets something visible — an answer, a reaction, or a notice (E1).
- All three runtimes, so the flip is not a claude-code privilege.
- Default OFF, graduating on evidence.

## Non-Goals

- The per-agent hard tool filter (DOR-1611). Consumed, not built.
- A cheap should-respond gate (**DOR-1203**). Its value rises once silence is common; noted, not built here (orchestrator ruling).
- **Splitting `room-service.ts`.** Explicitly out of scope (orchestrator ruling); filed separately.
- Any change to _"do I run a turn?"_ — addressing, cascade guard and turn budget are untouched in both flag states.
- Bridging room presence to chat platforms.

## Technical Dependencies

- **DOR-1611 PR1** — `registry.invoke` as the single choke point both MCP servers converge on (`mcp-projection.ts:247`), specified at `specs/rooms-management-tools/02-specification.md` D1. Not a hard blocker; this feature needs the choke point to keep holding, not the grant.
- `@openai/codex-sdk` — `CodexOptions.config.mcp_servers`, HTTP transport with `http_headers`.
- `@opencode-ai/sdk` — `client.mcp.add`, remote config with `headers`.
- `conf` v15.1.0 + Zod (`UserConfigSchema`), per `contributing/configuration.md`.

## Detailed Design

### D1. The two `deliver` edits, with exact ordering

`deliver` is the single delivery function for in-frame **and** late answers (`deliverLate:1922-1974` calls back into it at `:1934`), so both inherit the change for free. Verified guard order today:

| #   | Line         | Guard                                                |
| --- | ------------ | ---------------------------------------------------- |
| 1   | `:1802-1814` | halted → drop, skip the recovery re-arm              |
| 2   | `:1815-1818` | `reply.unanswered` → `reportSilence`                 |
| 3   | `:1824`      | `notices.recovered(...)`                             |
| 4   | `:1826`      | `const said = reply.text?.trim();`                   |
| 5   | `:1838`      | `if (!said) return 'quiet';`                         |
| 6   | `:1848`      | `if (this.takeSpokeViaTool(...)) return 'answered';` |
| 7   | `:1857-1860` | late prefix                                          |
| 8   | `:1871`      | the post                                             |

**Edit 1 — consume the tool mark before deciding quiet.** Today step 6 sits _after_ step 5. That is harmless now because a tool-posting agent almost always also narrates, so `said` is truthy and control reaches the mark. Under the flip the well-behaved case is exactly _"posted via the tool, narrated nothing"_ — which the current order classifies as `'quiet'`, leaves the mark standing on a claim about to be deleted, and punishes with the very notice the agent earned its way out of.

**Edit 2 — never post the text.** Steps 7 and 8 do not run.

```
flag OFF (byte-identical to today)      flag ON
1 halted            → drop              1 halted            → drop
2 unanswered        → notice            2 unanswered        → notice
3 recovered()                           3 recovered()
4 said = text?.trim()                   4 takeSpokeViaTool? → 'answered'
5 !said             → 'quiet'           5 takeReactedViaTool? → 'answered'
6 takeSpokeViaTool? → 'answered'        6 reportDeclined()  → 'quiet'
7 late prefix
8 POST the text
```

**Both marks are TAKEN, not read** (`takeSpokeViaTool:1521-1526`): a claim outlives its answer under RP8's park-and-resume, and a standing mark would swallow the next delivery.

**The flag-OFF path must remain byte-identical.** The branch is on the resolved reply mode (D2), taken once at the top of `deliver`, not sprinkled through the guards.

### D2. Reply mode resolves per turn, and fails OPEN

The flag must **not** be read as "suppress the text". It is read as: _suppress the text only where this session is known to be able to post._

```
replyMode(turn) =
  'tool-only'  when rooms.toolOnlyReplies AND this session is known to carry the rooms tools
  'text'       otherwise                              ← including "we do not know"
```

| Runtime     | Known tool-capable when                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| claude-code | always — in-process; all four room verbs are in `ALWAYS_LOADED_TOOLS` (`tool-exposure.ts:106-115`)             |
| codex       | the `dorkos` entry was built into this turn's `CodexOptions.config.mcp_servers`                                |
| opencode    | `ensureManaged` reported the `dorkos` add as applied for this cwd (`mcp-manager.ts:41-47` already tracks this) |
| test-mode   | `false` unless the active scenario opts in (D14)                                                               |

**Why fail open, and why the polarity is the opposite of DOR-1611's.** DOR-1611's grant is a security boundary asking a positive question, where dropping a credential must strictly narrow. This asks a **delivery** question, and its two errors are not symmetric:

- Fail closed → the agent is silently mute. `room-conduct.md` Constraint 6: **silence is the worse failure**.
- Fail open → a turn's text posts that the agent might not have chosen to post. Untidy, visible, recoverable.

Two reachable states make this load-bearing rather than theoretical. `/mcp` sits behind `requireMcpEnabled` (`index.ts:2206`), which `/codex-ui-mcp` deliberately omits (`:2232-2235`) — so `config.mcp.enabled = false` plus the flip would mute every codex and opencode agent in every room. And agent tokens expire on a 7-day-idle / 30-day-absolute fuse (`agent-identity-service.ts:69,75`), reaching the same state on a timer.

Nothing about permission is decided here. The agent could always post; this decides only whether DorkOS also posts for it.

**Transport.** `replyMode` is resolved by `RoomTurnRunner` (which knows both the flag and the runtime's injection outcome) and carried on the turn result to `deliver`, alongside the existing `text` / `unanswered` fields. `deliver` does not re-derive it.

### D3. The DM reversal — the complete diff surface

**The branch** (`room-service.ts:2433-2438`), verbatim today:

```ts
if (room.kind !== 'channel') {
  throw new RoomError(
    'TOOL_POST_NOT_IN_DM',
    'This is a direct message — your reply is posted for you, so there is nothing to post here.'
  );
}
```

Under `replyMode === 'tool-only'` the branch does not fire. Under `'text'` it fires exactly as today — the refusal remains correct there, because in text mode the reply genuinely _is_ the message.

**Keep the `!== 'channel'` spelling.** `rooms.kind` is a text column narrowed by an unchecked cast (`room-rows.ts`), and `room-conduct.md`'s standing rule is that an unknown kind never gets more reach than a DM. The condition becomes `replyMode === 'text' && room.kind !== 'channel'`, never `=== 'dm'`.

**Four restatements that must change with it:**

| #   | Location                                                                              | Change                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `room-service.ts:2436` — the `TOOL_POST_NOT_IN_DM` **message string**                 | Flag-ON it is not merely stale but **false**, and it reaches the model as a `CapabilityToolError`. Must state the mode-conditional truth |
| 2   | `room-errors.ts:96-107` — the error code's TSDoc                                      | Record that the refusal is now mode-conditional                                                                                          |
| 3   | `room-capabilities.ts:327` — the tool description                                     | Mode-**neutral** rewrite (D11)                                                                                                           |
| 4   | `room-service.ts:2393-2396` + `room-capabilities.ts:72` — the code-comment invariants | Restate                                                                                                                                  |

Plus `.claude/rules/room-conduct.md`'s _"posting is channels and threads only"_ clause, and inline amendments to spec §2.6 / §10.2 / §10.2.1 / §10.2.2 in the DOR-1202 house style.

**What the reversal keeps, unchanged and for free.** The loop protection already exists and was built for another reason (ADR `260814-025326`, after one "hello" in a two-agent DM cost four turns and two apology notices). `selectTriggerTargets` (`addressing.ts:117-136`):

```ts
const impliesEveryone = opts.roomKind === 'channel' || opts.authorKind === 'human';
```

- Agent → DM with a **human**: `impliesEveryone` false, and the human is filtered by `member.kind === 'agent'`. Selects `[]`. **A reply-to-a-human-DM loop is structurally impossible.**
- Agent → DM with an **agent**: triggers only on a stored `mentions` hit. Identical to today's behaviour when the turn's text posts. No new reach.

**Cascade provenance is already right.** A tool post passes no `trigger`, so `writePost` substitutes `activeTurnFor(authorId)` (`room-service.ts:3161`) — the deepest live claim's `{root, depth}`, the same stamp the turn's own answer would carry. With no claim it falls to `deriveCascade`'s agent branch and is stamped at the ceiling (`cascade-guard.ts:173-174`): spent on arrival, triggering nobody. `spokeViaTool`'s sentence — _"speaking on purpose is not a way to reset the cascade guard"_ — survives untouched.

**One genuine consequence.** `spokeViaTool` is `(room, agent)`-scoped and, because the tool refuses DMs today, **the suppression is structurally unreachable in a DM**. The reversal makes it reachable. Every DM test that assumed "the turn produced text" and "the room got a message" are the same event must be re-read.

### D4. The wiring — codex and opencode reach `/mcp`

**One injected entry, named `dorkos`, streamable HTTP, at this server's own `/mcp`, with two headers:**

| Header           | Value                                            | Why                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Authorization`  | `Bearer <getMcpLocalToken() \| env.MCP_API_KEY>` | Rooms tools carry no `readOnlyCarveOut` (`tool-security.ts:31-35`), so every room write 401s without it (`mcp-auth.ts:119-123`)                                                                                                                                                |
| `X-DorkOS-Agent` | freshly minted agent token                       | Without it `callerAuthor` falls through to the **install owner** (`room-capabilities.ts:216`) and the agent posts **in the operator's name**. DOR-1611 spec D1 corroborates: dropping the header yields "unidentified", and `post_to_room` carries no `toolGroup` to refuse it |

Neither runtime's MCP client sends `Origin`, so `validateMcpOrigin`'s non-browser early return (`mcp-origin.ts:19-22`) admits it — the same route `dorkos_ui` already takes.

**Codex.** Build the entry in `buildMcpServersConfig` (`codex-runtime.ts:187-194`) beside `dorkos_ui`, using the HTTP branch's `http_headers` (`codex/mcp-server-config.ts:55-61`). **Add `dorkos` to `reservedNames`** (`codex-runtime.ts:365`, today exactly `{'dorkos_ui'}`) so a user's own server of that name cannot shadow it. Note the drop is **silent** (`mcp-server-config.ts:96`) — a user with their own `dorkos` server would watch tools vanish with no diagnostic, so the drop must log a warning naming the collision.

**OpenCode.** Add it to the desired set `ensureManaged` reconciles (`mcp-manager.ts:177-251`) with `headers` on the remote config. **This is OpenCode's only per-agent identity channel** — its sidecar is one shared process with a fixed env, so there is no `DORKOS_AGENT_TOKEN` seam and never will be. Collisions surface as `failed` roster entries (`:221-232`), which is better than codex's silent drop and stays. The no-op early return keys on `JSON.stringify(servers)` (`:187-193`), so a re-minted token changes the signature and forces a re-add — **true today by accident; a test makes it deliberate.**

**Identity minting.** Reuse `resolveAgentTokenEnv(agentPath, displayName)` (`agent-token-env.ts:42-65`), already called per turn by codex (`codex-runtime.ts:635-639`). Re-mint **per turn** (codex) / **per reconcile** (opencode) so the 30-day fuse cannot arm.

**DOR-723 — the URL.** Mint through `` `http://${localDialHost(env.DORKOS_HOST)}:${PORT}/mcp` ``, never `127.0.0.1`. `localDialHost` (`lib/local-dial-host.ts:33-39`) maps wildcard binds to `localhost` and brackets IPv6 literals; three sibling sites already use it (`index.ts:1920-1926`, `index.ts:2013-2023`, `routes/test-control.ts:727-730`). **Fix `index.ts:1008` in the same PR** — it is the last hardcoded mint site in the server, and shipping a second one beside it is the bug arriving twice.

**Scope: every session bound to an agent identity, not room turns only.** A DM turn is a session; a room-turn-only rule would make the runtime ask why it was called, which it cannot know. The runtime already resolves "is this agent-bound?" per turn from the session cwd (`meshCore.getByPath(cwd)`), so this reuses an answer rather than adding a concept — and the tools are worth having outside rooms, which is what makes PR1 shippable alone.

**Codex event mapper: no interception.** `mcp_tool_call` special-cases exactly `dorkos_ui`/`control_ui` (`event-mapper.ts:259-266`) because their results are stubs and the real effect happens elsewhere. `post_to_room` is the opposite — a genuine server-side effect whose result the person sees in the room — so it renders as an ordinary `mcp__dorkos__post_to_room` call (`event-mapper.ts:473`). Verified.

**Absent on the external surface:** `sessionId` and `cwd` (`registry.ts:124-129`, `:186-190`). No rooms capability needs them; any future one must be told.

### D5. Config: three leaves, two Experiments entries, three migration keys

**Three new leaves in `packages/shared/src/config-schema.ts`:**

| Leaf                    | Type               | Default | Ships in |
| ----------------------- | ------------------ | ------- | -------- |
| `runtimes.dorkosTools`  | boolean            | `false` | PR1      |
| `rooms.toolOnlyReplies` | boolean            | `false` | PR2      |
| `rooms.maxPostsPerTurn` | int, min 1, max 10 | `3`     | PR2      |

Each is declared **twice** — on the nested object and in the enclosing `.default(() => ({...}))` factory. `config-schema.ts` states the trap in the `rooms` block itself: _"Every declaration of these values has to agree, here and in the section literal below, because `conf` merges top-level defaults shallowly."_ Omitting the factory entry crashes fresh installs at import time, because `USER_CONFIG_DEFAULTS` is `UserConfigSchema.parse({ version: 1 })` evaluated at import.

**Each leaf needs a `CONFIG_MIGRATIONS` body, and this is not optional.** Per `adding-config-fields`: conf's pre-write covers a whole **top-level section**, but **a nested leaf inside a section the file already has is NOT covered** — the merge is shallow, a stored `rooms` object wins wholesale and never gains a member. All three land in existing sections (`rooms`, `runtimes`), so each body is the only thing that writes its leaf. Model them on `seedRoomRepoDefaults` (key `'0.70.0'`), which seeds a nested `rooms` leaf for exactly this reason.

**Keys, and why they are separate.** The highest merged key is `'0.70.0'` (`rooms.repo`), so `'0.71.0'` is next. A merged body is **frozen from merge, not from release** — the append-only rule (DOR-1222), because the dogfood machine is stamped with the unreleased version and never runs the key again. So each PR claims its own key rather than extending one:

| PR  | Key        | Body                                                                  |
| --- | ---------- | --------------------------------------------------------------------- |
| PR1 | `'0.71.0'` | seed `runtimes.dorkosTools = false`                                   |
| PR2 | `'0.72.0'` | seed `rooms.toolOnlyReplies = false`, `rooms.maxPostsPerTurn = 3`     |
| PR4 | `'0.73.0'` | graduation — flip defaults, moving **only** the exact shipped `false` |

Each key is pinned in the same PR by one line in `__tests__/merged-migration-hashes.ts`; a guard fails until it is, and prints the line to paste. Each also carries the disjointness note the neighbouring keys carry.

**Two Experiments-registry entries.** `experiments-registry.ts` states a contract its test enforces: every `path` resolves to a real `UserConfigSchema` boolean leaf, that leaf **defaults to `false`**, and it carries a non-empty `graduationIssue`. Both flags satisfy it exactly, which buys the whole UI free — `ExperimentsTab.tsx` holds zero per-experiment knowledge and draws a `SwitchSettingRow` per entry. `rooms.maxPostsPerTurn` is **not** an experiment (it is a number, and the contract requires a boolean); it is an ordinary tunable, documented in the settings reference.

Copy, in the registry's register (_"say what happens for them, benefit before cost, no mechanism"_) and following `a2a.enabled`'s habit of naming its prerequisite:

> **Agents decide when to speak** — `rooms.toolOnlyReplies`, graduationIssue `DOR-1613`
> Right now, whatever your agent writes during a room turn gets posted. With this on, it chooses: it can answer, it can just react with an emoji, or it can decide nothing needs saying and stay quiet — and its thinking stays in its own session instead of landing in the room.
> _Cost note:_ An agent that forgets to answer says nothing. The room tells you when that happens, but it is a new way for a reply to go missing, so watch a few conversations after you turn it on. For Codex and OpenCode agents, turn on **DorkOS tools in every runtime** first.

> **DorkOS tools in every runtime** — `runtimes.dorkosTools`, graduationIssue `DOR-1613`
> Codex and OpenCode agents get the same DorkOS tools your Claude Code agents already have — posting in rooms, reacting, reading room history, and remembering things between sessions. Takes effect on their next turn.

Both keys also gain a row in `contributing/configuration.md`'s settings table and its `docs/getting-started/configuration.mdx` mirror.

### D6. `agent_declined` — the durable half of silence

**The split is §10.2.2's and is not re-derived.** The obligation attaches to being **addressed**, not to running a turn.

| Trigger                                                     | Turn ends with no post and no reaction | Outcome                        |
| ----------------------------------------------------------- | -------------------------------------- | ------------------------------ |
| **Addressed** — a person named this agent, or wrote in a DM | E1: being asked creates an obligation  | **One durable notice**, damped |
| **Ambient** — `always` / `engaged` / fallback seat          | E7: silence must be free               | **Nothing durable, ever**      |

**Use the predicate that already ships.** `directlyAsked` (`notice-log.ts:763-772`) asks exactly this question and has been tuned twice by measured incidents — once too wide (apologies about agents nobody addressed), once too narrow (`@ana are you there?` answered with silence):

```ts
if (entry.cascadeDepth !== 0) return false;
if (this.deps.authors.getById(entry.authorId)?.kind !== 'human') return false;
return room.kind === 'dm' || entry.mentions.includes(agentAuthorId) || namedDirectly;
```

It is currently **private** and decides _damping_; here it also decides _whether to write at all_. **Promote it to a named export** rather than copying — two copies of this predicate is how both incidents return, one at a time.

It is deliberately **narrower** than §10.2.2's "addressed", which reads the dispatcher's trigger reason and would include an agent naming an agent. Orchestrator ruling: the narrow one stands (Q2).

**The notice.** A ninth code `agent_declined` — the name §10.2.2 already chose — in `notices/notice-copy.ts` beside the other eight, written through `notice-log.ts`'s single `write` seam. `room-conduct.md` permits no other shape: _"A new way to go quiet earns a new code there, never a free-text line."_ Copy states the fact without apologising:

> **Ana read this and did not reply.**

`RoomNoticeCodeSchema` gains the member; the client's notice renderer picks it up from the shared copy map.

**Amended 2026-08-29 (adversarial review, before merge) — the damping is per CASCADE, in its own memory.** The text above originally said "damped on the existing `noticedSilence` memory under a new `dampReason`, re-armed by `recovered` like its siblings". Both halves were wrong and the second is what makes the first unsalvageable:

- **`recovered` cannot be the re-arm.** `deliver` calls it at guard 3 and `reportDeclined` at guard 6 of the SAME call, so a key it could clear would be cleared by the very turn that armed it. The damping would suppress nothing.
- **A `(room, agent)` key never expires.** Nothing else clears it, so a person who asked once, got one line, and asked something else entirely the next day would get SILENCE — the dead air E1 and this notice exist to prevent, and the inverse of `reportSilence`'s own rule that a direct question is never damped. It violated this spec's Goal 3 outright.

So it is keyed `(room, agent, cascadeRoot)` — the shape `cascadeNoticeKey` already uses, for the reason it uses it: a later exchange may legitimately say this again. It lives in its own `noticedDeclines` set rather than as a fourth reason inside `noticedSilence`, because the two key SHAPES differ and sharing one memory invites exactly the `recovered` mistake above.

It cannot become a flood: `directlyAsked` requires depth 0 and a human author, so every message that reaches it starts its own cascade and the bound is the sender's own typing. Messages typed in one breath gather into one turn (RP8) and earn one line between them. And the key damps nothing reachable TODAY — one entry produces one dispatch per agent and `deliver` runs once per turn — so it is a guard against a future re-dispatch spraying, on the same terms `cascadeNoticeKey` is.

### D7. The `done` outcome field — the ephemeral half

Ambient silence writes nothing durable, but a working pill that appears and vanishes with nothing to show reads as a crash — and under the flip that happens many times a day rather than rarely. The fact belongs on the lane that already carries non-durable statements: `RoomSignalEvent` (`room-schemas.ts:1625-1668`), _"delivered live and dropped on replay… never enters the log"_, whose `heldBehind` is the precedent.

**Add an optional field to the `done` signal. Do NOT add a fifth `RoomPresenceState`.**

```
state: 'done', outcome?: 'answered' | 'silent'
```

**The older-client argument, recorded because it is the whole reason for the shape.** `RoomPresenceStateSchema` (`room-schemas.ts:1573-1575`) is a Zod enum parsed by every client and reused by the `CommunityAdapter` presence payload, and `useRoomPresenceStore.observe` **drops** a frame it cannot parse (`:1762-1766`). A new enum member would therefore make an older client — a desktop build one release behind, a community peer — fail to parse the release frame and **leave the working pill spinning forever**. An optional field degrades to exactly today's behaviour. The schema's own doc already blesses the additive direction: _"Adding a member is additive for a remote producer."_

**Published only for a turn that actually ran `'tool-only'` (amended 2026-08-29, orchestrator ruling).** Acceptance criterion 1 wins this: with the flag off, room behaviour is byte-identical to before the feature, and a new field on every release frame is not byte-identical. It buys nothing there either — a text-mode turn that finishes has posted its words or written a notice, so the indicator already releases into something a reader can see. Criterion 15's forward-compat parse is unaffected, because it is about a frame that DOES carry the field.

Rendered as the pill releasing into a brief, fading "finished — nothing to add", gone on reload. E16a is what makes this legal without counting as participation: a mechanical presence signal published while the harness holds a real claim _"is not a turn, not an acknowledgment, and never model-chosen."_ Past-tense, so unlike the held-promise it replaces, a restart forgetting it costs nothing.

### D8. `postFromTool` fills `answersEntryId` and `sessionId`

Verified asymmetry. The turn-text path passes both (`room-trigger.ts:1871-1895`: `sessionId: opts.sessionId`, plus `answersEntryId`). `postFromTool` calls `this.post(roomId, input)` with `input` = `{authorId, text, replyTo?}` (`room-service.ts:2457`) — neither, so `sessionId` falls to `null` (`:3231`) and `answersEntryId` is absent.

Today that affects the rare deliberate post. **Flag-ON it affects every agent reply in the product**: the room stops drawing the "answers this" pointer, and no room entry can be traced back to the session that wrote it. Both facts are in hand at write time — the live claim knows its triggering entry and its session — so `postFromTool` derives them from `activeTurnFor`'s claim. **Ships with the flip, not after it.**

### D9. The per-turn post ceiling — a mechanism, and operator-tunable

There is no per-turn post ceiling anywhere (`grep postsThisTurn|perTurn|postBudget` in `room-service.ts` / `room-capabilities.ts` returns only `TOO_MANY_ATTACHMENTS`). That is deliberate today and even celebrated: DOR-1434 made multiple posts cost **one** turn against the cascade budget, and §10.2 called two posts _"E17 batching expressible rather than accidental"_.

But flag-OFF an agent has no reason to post at all, and flag-ON posting is the only voice it has. `room-conduct.md`: _"Bounds are mechanisms, never prompts… do not weaken one because a prompt 'already says' not to do the thing."_ E8 ("one message, not three") is such a prompt.

**`rooms.maxPostsPerTurn`, default 3** — a config value, not a bare constant (orchestrator ruling Q1): posting is becoming the agent's only voice, and the person who feels a wrong number must be able to move it without waiting for a release. Counted per `(room, agent, dispatchId)` on the live claim, refused at the boundary in `postFromTool` with a typed `TOO_MANY_POSTS_THIS_TURN` naming the remedy ("consolidate into one message"). Asked **before** the write and **after** `stoppedIn`, so a refusal never costs a claim mark. 3 allows "on it" → answer → correction and refuses a serialised essay.

Its TSDoc follows the `rooms.*` house register — plain language, and the `meta/agent-etiquette.md` §9 disclaimer every number in this namespace carries: _"Like every number in this area, this one is a judgement rather than a measurement."_

### D10. A reaction discharges the obligation

_"A thumbs-up reaction can BE the answer"_ (operator). So `agent_declined` must not fire on a turn that reacted. `ActiveClaim` gains `reactedViaTool` beside `spokeViaTool`, set by `toggleReaction` on a **successful** reaction only — one refused by the hourly `ReactionBudget` or by the `stoppedIn` mark put nothing in front of anybody and must not buy silence. Consumed by `takeReactedViaTool` with the same take-not-read semantics as its sibling, for the same park-and-resume reason.

Whether the reaction was a _good_ answer is conduct, measured by evals; whether the room shows something is mechanism. That is `I2` observed exactly.

**`room-conduct.md` gains a fifth permitted release.** Its _"An indicator releases into something durable"_ bullet lists four — a post, a fresh notice, a standing notice under the same damping key, or the named exception for chosen silence. A reaction-only turn is a first-class outcome under the flip, and a reaction is durable (it survives a reload, it is drawn on the entry) but deliberately not an entry. Under the current wording such a release is "a defect". It plainly is not one.

**And the named exception must be re-argued rather than leaned on.** Record that it now carries the common case, and that the ephemeral marker (D7) is what keeps it honest. Its wording does not change and its scope does not widen — what changes is that the addressed half now has a durable sibling it never had, so the exception is exercised _only_ where nobody asked. **In practice it gets narrower, not wider** — the opposite of what a reader assumes from a feature called "silence by default", and worth writing down.

### D11. The nine prompt strings

The worst reachable outcome is an agent told _"whatever you say is posted"_ while the flag drops what it says. Verified, `room-context-block.ts:969-974`:

```ts
lines.push(
  data.thread
    ? `Whatever you say this turn is posted as a reply in that thread, not into the main flow ` +
        `of ${where}. Every member can read it there.`
    : `Whatever you say this turn is posted into ${where}, where every member reads it.`
);
```

| #     | Location                        | Claim                                                                                 | Flag-ON      |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------- | ------------ |
| P1/P2 | `room-context-block.ts:969-974` | "Whatever you say this turn is posted into…" — **runtime-neutral, the dangerous one** | mode-aware   |
| P3    | `context-builder.ts:347`        | "Not for direct messages: there your reply is already the message."                   | delete       |
| P4    | `context-builder.ts:348-350`    | posting suppresses the narration                                                      | restate      |
| P5    | `context-builder.ts:358-361`    | "Every word you write back in a room turn is posted into the room…"                   | invert       |
| P6    | `context-builder.ts:336`        | "you can do four things **besides replying**"                                         | restate      |
| P7    | `room-capabilities.ts:327`      | "It does NOT apply to direct messages…"                                               | mode-neutral |
| P8    | `room-capabilities.ts:328-330`  | the suppression claim on the tool description                                         | mode-neutral |
| P9    | `room-capabilities.ts:381-383`  | the reaction's "say nothing else about it" clause                                     | restate      |

Plus the `TOOL_POST_NOT_IN_DM` message (D3), six code-comment invariants, and thirteen doc/spec/rule statements.

**Three rules resolve this.**

1. **P7/P8 sit on a capability description, minted once at boot and install-wide — it cannot be per-session.** So rewrite them **mode-neutrally** and let the refusal carry the condition: "Say something in a room you are a member of" is true in both modes and both room kinds; "it does NOT apply to direct messages" is true in neither once §2.6 is reversed.
2. **P1/P2 become mode-aware**, which collides with a guard test: `room-context-block.test.ts:457-467` asserts the shared block _"teaches no tool, because this block is shared with runtimes that carry none (DOR-1234)"_. PR1 removes that premise. **Do not delete the guard — re-aim it** at the real invariant: the block never names a tool the session it is being built for does not have.
3. **`ROOM_TOOLS_CONTEXT` (P3–P6) is claude-code-only today**, which is where tool names legitimately live. Under the wiring, codex and opencode need the same detail — so **hoist it to the shared layer**, gated on the session's actual tool-capability rather than the runtime's static `supportsMcp`. A second reason PR1 lands first and alone.

**One instruction added, flag-ON:** in a DM with a person, answering is not optional. This is E1 stated where the agent reads it, and the whole DM reversal rests on it.

**Amended 2026-09-02 (DOR-1643) — the instruction was necessary and not sufficient, and what closed the gap was not a stronger sentence.** Live DM probes on Haiku with this instruction present, and reworded to state the association outright ("the answer you formed is the thing you post"), still produced a complete written answer with zero tool calls. Restating it as the last line of `<room_context>` did not move it. Naming the tool in that line did not move it. **Spelling the CALL, with the room's id already in it — `…post_to_room(roomId: "01M…", text: <your answer>)` — moved it on the first attempt**, and the turn that had taken 41s to narrate posted in 13s. So the gap was never comprehension: a model that has decided its answer is written still has to assemble a call to send it, and every step between deciding and calling is a step at which it stops.

The sentence above is therefore no longer the only instruction the DM reversal rests on. `formatRoomContext` now renders a **closing directive** last, under `'tool-only'` only, as two branches each ending in its own concrete action with the answering one last — a single unconditional imperative answered a bare "thanks!" with a pleasantry, and inverting it so the exception led restored restraint and lost the answer. In a channel the quiet branch is gated on `addressing.addressedNow`: bare silence is offered only when nobody named the agent. Measured record and per-run detail live in `packages/evals/src/suite/rooms-judgment.ts`.

### D12. The aside / welcome-back turn keeps text-as-reply (settled)

The greeter posts an aside turn's answer itself, outside `deliver` (`room-trigger.ts:2005-2018`), un-provenanced so `deriveCascade` stamps it at the ceiling and the fallback seat stands down for it. It is the one path where a turn's text still becomes a room message under the flip.

**Ruling (orchestrator, Q3): it keeps text-as-reply, deliberately.** Three reasons, recorded so it does not read as an oversight: a welcome-back offer is the room asking a closed question on the person's behalf rather than the agent choosing to speak; four of its outcomes are already silent by design (`RoomTriggerDispatcher.askAside`), so it is already the one refusal nobody is told about; and routing it through a tool would give it a fifth way to produce nothing while the person is owed exactly one line. The greeter's own posting comment is amended to say the flip does not reach here and why.

## User Experience

**Turning it on.** Settings → Experiments shows two switches (D5). Both default off. The rooms one names the runtimes one as its prerequisite for codex/opencode agents.

**A channel, flag on.** A person asks a question and mentions Ana. The working pill appears. Ana calls `post_to_room`; the answer lands, with its "answers this" pointer intact (D8). Nothing else is posted — the reasoning stays in Ana's session, readable by opening it.

**A channel, nobody asked.** Ambient chatter reaches an `engaged` agent. It runs a turn, decides nothing needs saying, and stops. The pill releases into a brief fading "finished — nothing to add" and the room is unchanged. Nothing durable. On reload there is no trace, which is correct: nothing happened.

**A channel, asked and silent.** A person mentions Ana; Ana produces nothing. The room writes one line — **"Ana read this and did not reply."** — damped, so three mentions in one cascade still write one. This is the floor, not the goal: an agent with nothing useful to say should post one sentence in its own voice (E21). Prompt and evals push toward the first; the notice guarantees the second.

**A DM.** Answering is not optional and the instruction says so. The reply arrives as a tool post; a bare acknowledgment may arrive as a reaction instead.

**An acknowledgment.** "No reply needed, just ack this" gets ✅ and nothing else — the A-06 case, closed by mechanism.

**Errors the agent sees.** `TOO_MANY_POSTS_THIS_TURN` (consolidate), `TURN_WAS_STOPPED` (unchanged), and in text mode `TOOL_POST_NOT_IN_DM` with a message that is now conditionally true.

**Nothing changes with both flags off** — the byte-identical guarantee in D1.

## Testing Strategy

**Unit — server.** The `deliver` matrix in both modes: tool-post-only → `'answered'` and no text entry; text-only + tool-only mode → `'quiet'`; reaction-only → `'answered'`, no notice; addressed + nothing → exactly one `agent_declined`; ambient + nothing → zero entries and zero notices; late answers inherit both edits through `deliverLate`; halted still drops everything, including the notice. Reply-mode resolution: flag on + not tool-capable → `'text'`; flag on + `mcp.enabled` false → `'text'` (the R2 mute-state guard); flag off → `'text'`. `directlyAsked` as an exported predicate, including the three-condition table and the `namedDirectly` route. `postFromTool` in a DM: allowed in tool-only, refused in text mode, still `!== 'channel'` spelled. `postFromTool` fills `answersEntryId`/`sessionId`. The post ceiling: 3 pass, the 4th refused; asked after `stoppedIn` so a refusal costs no mark; the config value is read, not a constant. `reactedViaTool` set only on a successful reaction — a budget-refused and a `stoppedIn`-refused reaction leave it unset.

**Unit — schema/config.** Each of the three leaves declared in both the nested object and the factory (a test that `USER_CONFIG_DEFAULTS` carries them). Each migration body seeds its leaf into a stored section that lacks it, and is a no-op when present. The migration-safety guard and the `merged-migration-hashes.ts` pin. The experiments-registry contract test picks up both entries (real boolean leaf, defaults false, non-empty `graduationIssue`). `RoomSignalEvent` parses with and without `outcome`; **an older-schema parse of a `done` frame carrying `outcome` still succeeds** — the D7 argument, asserted rather than reasoned.

**Unit — runtimes.** Codex `buildMcpServersConfig` emits the `dorkos` entry with both headers and a `localDialHost`-derived URL, never `127.0.0.1`; a user server named `dorkos` is dropped **and logged**. OpenCode `ensureManaged` adds it with headers; a re-minted token changes the signature and forces a re-add (making today's accident deliberate); a collision surfaces as `failed`. A regression test that `index.ts`'s `dorkos_ui` URL is `localDialHost`-derived (DOR-723).

**Integration.** A room turn end-to-end on `test-mode` in both modes, using a tool-capable scenario. A DM turn that tool-posts and triggers nobody (`selectTriggerTargets` → `[]`). Cascade depth on a mid-turn tool post equals the turn's stamp.

**E2E (`apps/e2e/tests/rooms/`).** New specs, not edits: a tool-only channel reply renders once with its answer pointer; an addressed-and-silent turn renders one notice; an ambient-silent turn renders nothing and the presence pill clears. **The six existing specs across `room-autonomy.spec.ts` / `team-room.spec.ts` and the three free eval cases stay green unedited**, because test-mode reports not-tool-capable by default (D14).

**Mocking.** `FakeAgentRuntime` + `@dorkos/test-utils` scenarios for turn shapes; the tool-capable test-mode scenario joins `BUILT_IN_SCENARIOS`. No network in unit tests — the injected MCP config is asserted as a value, not dialled.

**Evals.** See D13 below.

### D13. Evals

**The suite exists.** `packages/evals` ships `rooms` in two tiers: a **free structural tier** on `test-mode` that gates (five cases, `src/suite/rooms.ts`, nightly in CI), and a **credentialed judgment tier**, all `quarantined: true` (`src/suite/rooms-recall.ts`). Among the quarantined nine is `rooms-ack-only-reacts-not-replies` (DOR-1234) — the A-06 case whose recorded failure is verbatim what this flip removes. **Un-quarantining it is the graduation signal.**

**Free structural cases** (extend `src/suite/rooms.ts`, tool-capable scenario, gates, CI-safe): `rooms-tool-post-is-the-only-reply`; `rooms-addressed-silence-writes-one-notice`; `rooms-ambient-silence-writes-nothing`; `rooms-reaction-discharges-the-answer`; `rooms-dm-tool-post-lands-and-triggers-nobody`; `rooms-text-fallback-when-not-wired`.

**Credentialed cases** (~12, `pnpm evals:local`, **never CI** — turbo strips `ANTHROPIC_API_KEY` from `test`/`verify`/pre-push and `evals.yml` runs credentialed manual-only; keep both): DM answer-rate across three phrasings (direct question, ambiguous request, statement implying one); **DM restraint** on a bare "thanks" — the discriminator, without which the DM suite is a check that cannot fail; channel mentioned-with-a-question → posts; channel ambient with a human already answering → silent (E3/E4); the A-06 ack case.

**Red-before/green-after drills, one per oracle** (README `:515-549`). The DM one is named and mandatory: **strip the flag-ON "in a DM with a person, always answer" line from the room context and re-run — answer-rate must measurably drop.** If it does not, the eval measures the model's disposition rather than this feature and its green means nothing.

**Amended 2026-09-02 (DOR-1643) — the drill's SEED moved, and the rule it is enforcing is why.** The drill has to remove whatever actually carries the behaviour, and that is no longer the DM line named above: that line was present, and reworded to state the association outright, through every one of the failing runs (see §D11's amendment). Seeding it now would red for nothing and prove nothing. **The seed is the closing directive** — the `replyMode === 'tool-only'` push at the end of `formatRoomContext`. Run live on 2026-09-02: removing it took DM answer-rate from 3 of 3 seeds to 1 of 3, with `roomTurnRanFor` green in every red, so each red is the post missing rather than the turn failing to start. The recipe, in the five parts the README requires, is maintained in `packages/evals/src/suite/rooms-judgment.ts` rather than here, so it stays next to the cases it seeds.

**Cost.** Rooms cases report `unmetered` honestly — the cost signal rides the per-**session** stream while a room drive collects the **room** stream, so `--budget` cannot see a room turn (README `:112-120`). The bound is the drive ceiling (5 min credentialed). Stated as a count: ~12 cases at the measured $0.038–$0.057 per core case on Haiku ≈ **$0.50–0.70 per judgment run**, inside `evals:local`'s `--budget 2`. Free-tier cases must **not** be tagged `core`, or every `evals:local` pays for them.

## Performance Considerations

Reply-mode resolution is a boolean read plus a field already computed per turn — no new I/O. The injected MCP entry adds one HTTP MCP server to codex/opencode sessions: their tool lists grow by the DorkOS capability set, which costs tokens per turn and is the main real cost; it is why the wiring is flagged and default-off rather than assumed. Codex's turn-scoped client is already forced whenever an identity token exists (`codex-runtime.ts:337-351`), which for an agent-bound session is always, so the header changes nothing in practice for agent turns and nothing at all for non-agent ones. The post ceiling is an integer compare on a claim already in memory. `agent_declined` reuses the existing damping maps.

## Security Considerations

**The identity header is the security-relevant part.** Without `X-DorkOS-Agent`, `callerAuthor` resolves to the install owner (`room-capabilities.ts:216`) and an agent would post **in the operator's name** — so the header is mandatory, not best-effort, and the wiring must fail loudly rather than inject a headerless server. A present-but-unresolvable token is already a hard `AGENT_IDENTITY_UNVERIFIED` refusal (`:189-196`) rather than a degrade, which is correct and must stay: the alternative is impersonation. That refusal is also why the token is re-minted per turn (D4).

**The bearer token is required, not optional**, because rooms tools carry no `readOnlyCarveOut` (`tool-security.ts:31-35`) — deliberately, since what they return is other people's messages. Do not add the carve-out to simplify the wiring.

**Fail-open is scoped to delivery, never to permission** (D2). It decides whether DorkOS _also_ posts a turn's text, never whether the agent may post. No capability is widened, and dropping a credential still narrows what a caller reaches.

**Untrusted text is unchanged.** The mode-aware instruction lines are DorkOS's own words outside the per-turn nonce fence; no member-authored value moves regions.

## Documentation

- `.claude/rules/room-conduct.md` — the fifth permitted release (D10), the re-argued named exception, the mode-conditional DM clause.
- `specs/room-participation/02-specification.md` — inline amendments to §2.6, §10.2, §10.2.1, §10.2.2 in the DOR-1202 house style, recording what DOR-1613 delivered and that §10.2.1's runtime constraint is dissolved.
- `meta/chat-capabilities.md` — §6 A-06 (verdict rewritten: mechanism gap, not model tuning), A-08 (`not built` → reachable), A-02/A-10/A-12/A-16; §5 M-07 (the DM reversal), M-04 (first mechanism and first coverage); §2 R-09 (ninth notice code), R-08. **§1/§4's `Path` column is untouched** — the flip is orthogonal to resume/pump (`:113`), and no row is added to either section or split. One drive-by correction while in the file: the column's copy still calls the pump "the experiment", which graduated.
- `contributing/configuration.md` + `docs/getting-started/configuration.mdx` — three new settings rows.
- `docs/concepts/rooms.mdx` — how an agent decides to speak, in plain language.
- Changelog fragments in `changelog/unreleased/`, one per PR.

## Implementation Phases

Four PRs, each shippable dark, in this order. The first two are independently valuable; the ordering is a real dependency.

**PR 1 — the wiring. No room behaviour changes.**
Scope: `runtimes.dorkosTools` leaf + factory + migration `'0.71.0'` + hash pin + Experiments entry; the `dorkos` MCP injection for codex (`buildMcpServersConfig`, `reservedNames`, logged collisions) and opencode (`ensureManaged`, headers); per-turn/per-reconcile `X-DorkOS-Agent` mint; the bearer header; **the DOR-723 fix at `index.ts:1008`** plus the new mint site, both through `localDialHost`; hoist `ROOM_TOOLS_CONTEXT` to the shared layer gated on session tool-capability; re-aim the `room-context-block.test.ts:457-467` guard.
Tests: codex config shape + headers + URL + collision log; opencode add + re-mint forces re-add + collision → `failed`; the `index.ts` URL regression test; the config/migration/experiments trio; the re-aimed guard.
Ships value alone: codex and opencode agents gain memory, `relay_notify_user`, room history and marketplace tools.

**PR 2 — the flip.**
Scope: `rooms.toolOnlyReplies` + `rooms.maxPostsPerTurn` leaves + factory + migration `'0.72.0'` + hash pin + Experiments entry; reply-mode resolution (D2) and its transport on the turn result; the two `deliver` edits (D1); the §2.6 reversal and its four restatements (D3); `agent_declined` + exported `directlyAsked` (D6); `reactedViaTool` (D10); the `done` `outcome` field (D7); `postFromTool` answer/session fields (D8); the post ceiling (D9); the nine prompt strings and the error message (D11); the greeter amendment (D12); the two `room-conduct.md` amendments and the four spec amendments; **the ADR**; the tool-capable test-mode scenario; the six free structural eval cases; the three new e2e specs.
Tests: the full `deliver` matrix in both modes; reply-mode incl. the `mcp.enabled`-off mute guard; DM allow/refuse by mode; DM triggers nobody; cascade stamp; ceiling; `reactedViaTool` negative cases; `outcome` forward-compat parse; the six eval cases; the three e2e specs; the six existing e2e specs green **unedited**.

_It does not split._ The DM half alone would leave the agent holding two contradictory models of what silence means — the D11 drift failure.

**PR 3 — the credentialed evals.** The ~12 judgment cases, their oracles, and one red-before/green-after drill each including the named DM mutation. No behaviour change. Separate because it spends money and cannot be gated by CI, so it is an artifact plus a procedure rather than a check.

**PR 4 — graduation.** Only after the five criteria below. Migration `'0.73.0'` moving **only** the exact shipped `false` (the `warmClaudeCodeSessionsByDefault` shape, `config-manager.ts:2822-2839`); both registry rows deleted and the switches re-homed; `chat-capabilities.md` verdicts rewritten; `rooms-ack-only-reacts-not-replies` un-quarantined.

**Graduation criteria — all five.**

1. Every free structural rooms case green **and gating** (a run gating zero cases is a failure).
2. DM answer-rate **100% on direct questions** across three seeds and all three runtimes, with the mutation drill confirming the eval can go red.
3. The DM restraint case passing, so (2) discriminates.
4. `rooms-ack-only-reacts-not-replies` un-quarantined and green.
5. **A dogfood week** on the operator's install with the flag on, counting `agent_declined` notices — each is a measured near-miss, and a rate that does not fall is the signal to stop.

## Acceptance Criteria

A reviewer can check each directly.

1. Both flags off: room behaviour is byte-identical to today, and the `deliver` guard order is unchanged on that path. **This includes the wire**: the `done` presence frame carries no `outcome` for a turn that did not run tool-only (D7, as amended).
2. Flag on, claude-code, channel: a turn that calls `post_to_room` and also narrates produces **one** entry — the tool's text — and the release reports `'answered'`.
3. The same turn narrating **without** calling the tool produces **no** entry.
4. Flag on, agent mentioned by a person, turn produces nothing: exactly **one** `agent_declined`. Three mentions in one cascade still produce one.
5. Flag on, ambient trigger, turn produces nothing: **zero** entries and **zero** notices, and the claim releases.
6. Flag on, a turn that only reacts: **no** `agent_declined`, and the pill is on the entry.
7. A reaction refused by the hourly budget does **not** suppress `agent_declined`.
8. Flag on, DM: `post_to_room` succeeds. Flag off, DM: it refuses with `TOOL_POST_NOT_IN_DM`. The condition is spelled `!== 'channel'`.
9. An agent's tool post into a DM with a person triggers **nobody** (`selectTriggerTargets` → `[]`).
10. A mid-turn tool post carries the same cascade depth the turn's own answer would have.
11. Flag on with `config.mcp.enabled` **false**: a codex/opencode agent still replies (its text posts). It is not mute.
12. An expired agent token produces the same fallback, not a silent mute and not a post authored by the owner.
13. Every flag-on reply carries `answersEntryId` and a non-null `sessionId`.
14. The 4th `post_to_room` in one turn is refused with `TOO_MANY_POSTS_THIS_TURN`; changing `rooms.maxPostsPerTurn` to 5 makes it succeed **without a restart of the test**.
15. A `done` frame carrying `outcome` parses under a schema build that predates the field.
16. No codex/opencode MCP URL contains `127.0.0.1`, including `dorkos_ui`'s.
17. A codex user server named `dorkos` is dropped **and logged**; an opencode one surfaces as `failed`.
18. No prompt string, tool description, or error message tells the agent its text will be posted when the resolved mode is `tool-only`.
19. The six existing rooms e2e specs and three free eval cases pass **unedited** with the flag on.
20. `pnpm verify` clean; both migration guards green with the new keys pinned.

## Decisions Register

Every decision is settled. No open questions remain.

| #   | Decision                                                                                                              | Settled by                                    |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| S1  | Turn text is never auto-posted; post, react, or stay silent — channels and DMs                                        | Operator                                      |
| S2  | §2.6's DM refusal reversed under the flag, with an ADR                                                                | Operator                                      |
| S3  | All three runtimes, via `/mcp` injection with per-agent identity                                                      | Operator                                      |
| S4  | DOR-723 fixed in the wiring PR                                                                                        | Operator                                      |
| S5  | Config flag, default OFF, experiment pattern                                                                          | Operator                                      |
| S6  | Text-as-reply remains the fallback                                                                                    | Operator                                      |
| S7  | Reuse the silence terminal; add a damped "finished without replying" indicator                                        | Operator                                      |
| S8  | Evals for DM answer-rate + channel judgment, `evals:local` only                                                       | Operator                                      |
| S9  | Per-identity gating consumed from DOR-1611 PR1, not redesigned                                                        | Orchestrator                                  |
| D1  | DOR-1613 **absorbs** DOR-1212                                                                                         | **Orchestrator** (2026-08-28)                 |
| D2  | The gated/automatic fact moves from per-membership to per-session; `ROOM_AGENT_CANNOT_POST` dropped rather than built | Ideation                                      |
| D3  | Reply mode resolves per turn and fails **open**                                                                       | Ideation                                      |
| D4  | `deliver` consumes the tool mark before the quiet branch; flag-OFF byte-identical                                     | Ideation                                      |
| D5  | `postFromTool` fills `answersEntryId`/`sessionId`, shipped with the flip                                              | Ideation                                      |
| D6  | Per-turn post ceiling as **operator-tunable config** `rooms.maxPostsPerTurn`, default **3**                           | **Orchestrator** (Q1, 2026-08-28)             |
| D7  | Silence obligation uses the narrow `directlyAsked`, promoted to an export                                             | **Orchestrator** (Q2 — recommendation stands) |
| D8  | Ephemeral outcome is an optional field on `done`, never a fifth `RoomPresenceState`                                   | Ideation                                      |
| D9  | A successful reaction discharges the obligation (`reactedViaTool`)                                                    | Ideation                                      |
| D10 | Injection targets every agent-bound session, not room turns only                                                      | Ideation                                      |
| D11 | Two flags, both Experiments entries defaulting false                                                                  | Ideation                                      |
| D12 | Codex event mapper gets no interception                                                                               | Ideation                                      |
| D13 | Tool descriptions become mode-neutral, not mode-branched                                                              | Ideation                                      |
| D14 | test-mode reports not-tool-capable by default                                                                         | Ideation                                      |
| D15 | The aside/greeter path keeps text-as-reply, deliberately                                                              | **Orchestrator** (Q3 — recommendation stands) |
| D16 | `room-service.ts` split is **out of scope**                                                                           | **Orchestrator** (2026-08-28)                 |
| D17 | DOR-1203 interplay noted, not built                                                                                   | **Orchestrator** (2026-08-28)                 |
| D18 | Each PR claims its own migration key (`'0.71.0'`, `'0.72.0'`, `'0.73.0'`); a merged body is frozen                    | Specify (from `adding-config-fields`)         |
| D19 | All three leaves need migration bodies — nested leaves in existing sections are not covered by conf                   | Specify                                       |
| D20 | One ADR, not two: the DM reversal is incoherent apart from the flip                                                   | Specify                                       |

## Open Questions

None. The three flagged in `01-ideation.md` §9 were ruled on by the orchestrator on 2026-08-28 and are recorded above as D6, D7 and D15.

## ADR argument (for `/adr:from-spec` extraction)

**One ADR, not two (D20).** The DM reversal is not a separable decision: in text mode the §2.6 refusal remains exactly right, because the reply genuinely is the message. It is only under tool-only replies that the refusal becomes false. Two ADRs would state half an argument each.

**Proposed title.** _"A room turn speaks by calling a tool, in every room kind — including DMs."_

**Context.** §10.2 designed silence-by-default in 2026-07 and §2.6 carved DMs out of it, on two claims that were true then: the DM case was already correct, and a second path would add a way to fail while buying nothing. DOR-1202 shipped the tool and deferred the flip (DOR-1212). Meanwhile the measured A-06 failure — an agent reacting _and_ posting "Done — release notes acknowledged." — resisted three rounds of prompt fixes, because the turn's text posts unconditionally.

**Decision.** Under `rooms.toolOnlyReplies`, a turn's text is never posted; the agent posts, reacts, or is silent, in channels **and** DMs. `post_to_room`'s DM refusal is conditioned on the resolved reply mode rather than removed.

**Why §2.6's argument no longer holds.** _"The DM case is already correct"_ was correct for **answering**, the only outcome that then existed; it was never correct for declining or reacting, neither of which was reachable. _"Two behaviours is the honest cost"_ understates it: the cost is now two behaviours that **disagree about what silence means** — silence is a choice in a channel and a bug in a DM — which the agent must hold simultaneously from one prompt. That is a worse failure than the one §2.6 avoided, and it is the drift risk D11 enumerates. _"Adds a way to fail"_ remains true and is the honest price; the answer is not two paths but E1 stated in the prompt, the `agent_declined` floor, and an eval that measures DM answer-rate with a mutation drill proving it can go red.

**Why this does not weaken the bounds.** The flip strictly **reduces** entries and therefore cascade fuel. Provenance is unchanged: a mid-turn tool post inherits the turn's stamp through `activeTurnFor`; an un-provenanced one is stamped at the ceiling. The one new volume vector — a turn posting N times — is answered by a mechanism (D9), not a prompt, per `room-conduct.md`.

**Why the DM reversal is safe.** The loop protection already exists, built for another reason (ADR `260814-025326`): an agent's post outside a channel addresses only whom it names, so a reply into a human DM triggers nobody.

**Consequences.** §2.6 is reversed under the flag and stands under text mode; §10.2.1's runtime constraint dissolves once codex/opencode reach `/mcp`; `room-conduct.md` gains a fifth permitted indicator release and re-argues its named silence exception; the obligation to be visible moves from "the turn always speaks" to "the turn speaks, reacts, or the room says it did not".

**Alternatives rejected.** A `NO_REPLY` sentinel token — a thing a model can rationalise past, where an unmade tool call is not (§10.2). Keeping DMs on text-as-reply — the two-models-of-silence problem above. Making the flip claude-code-only — it would make judgment a runtime privilege and leave A-06 open for two of three runtimes. Failing closed on unknown tool-capability — it converts a wiring gap into a mute agent, and silence is the worse failure.

## Related ADRs

- `260814-195522` — Agents may react, bounded by a rate rather than a ban. **The model for this ADR's shape**: it reversed etiquette E16b's second half and kept the superseded reasoning struck through, because the reasoning is what the reversal had to answer.
- `260814-025326` — The three-way rule / agent posts outside a channel address only whom they name. **Held unchanged, and it is what makes the DM reversal safe.**
- `260726-170127` — The room path carries its own cascade guard. Constrains D9 (a bound is a mechanism).
- `260726-170125` — No arbitration in rooms. Untouched; nothing here elects a speaker.
- `260818-234541` — Room hold when busy. Interacts with the re-asked guard on a held batch.
- ADR-0310 — Runtime-owned session storage. Why reply mode is per session, not per membership.
- ADR-0273 — Structured context injection. Governs D11's instruction lines.
- `260726-171347` — Tool-group toggles gate context, not access. Amended by DOR-1611, not by this.

## References

- `DOR-1613` (this work); **`DOR-1212`** (absorbed); `DOR-1202` (shipped the tool, deferred the flip); `DOR-1234` (the A-06 case); `DOR-723` (the `127.0.0.1` mint); `DOR-892`/`DOR-893` (codex/opencode MCP injection); `DOR-1611` (the choke point); `DOR-1203` (noted, not built); `DOR-1434` (multiple posts cost one turn); `DOR-1313`/`DOR-1424`/`DOR-1425` (the stop path); `DOR-1222` (append-only migrations); `DOR-1267` (nested `rooms` leaves reappearing).
- `specs/tool-only-room-replies/01-ideation.md` — the evidence trail behind every decision here.
- `specs/room-participation/02-specification.md` §2.6, §10.2, §10.2.1, §10.2.2; `specs/rooms-management-tools/02-specification.md` D1.
- `.claude/rules/room-conduct.md`; `meta/agent-etiquette.md` E1/E4/E7/E8/E16a/E16b/E21; `meta/chat-capabilities.md`.
- `contributing/configuration.md`; `.claude/skills/adding-config-fields/SKILL.md`; `packages/evals/README.md`.
