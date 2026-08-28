---
slug: tool-only-room-replies
number: 260828-010140
created: 2026-08-28
status: ideation
---

# Room replies go through tool calls only — silence, reactions and DMs become real choices

**Slug:** tool-only-room-replies
**Author:** ideator-1613 (DOR-1613)
**Date:** 2026-08-28

---

## 1) Intent & Assumptions

**Task brief.** Today a room turn's final text IS the room message: whatever the model narrated back to its session gets posted, automatically, into the room that triggered it. That makes three things impossible. An agent cannot decide that no answer is the right answer. It cannot think about whether to speak without the thinking landing in front of everybody. And it cannot let a 👍 be the whole reply. This flips the default: **under a config flag, an agent's turn text is never auto-posted. The agent answers with `post_to_room`, or reacts, or deliberately stays silent** — in channels **and** in DMs, on **all three runtimes**.

**The single most important finding of this ideation, and it changes what this work is.** The flip is not a new idea. `specs/room-participation/02-specification.md` §10.2 designed it in full on 2026-07-28 — _"speech becomes an explicit `post_to_room` tool call and the default outcome of a turn is silence"_ (`:574`) — and §10.2.2 designed the silence obligation that goes with it, table and all. DOR-1202 then shipped the tool and **deferred the flip**, recording exactly what was left undone in an inline amendment (`:637-651`) and tracking it as **DOR-1212**, which is sitting in **Triage** today.

So DOR-1613 is the delivery of DOR-1212, plus two things that genuinely go beyond the frozen spec and are therefore where the design work actually is:

1. **DMs go through the tool too**, reversing §2.6 — a settled decision, which needs an ADR.
2. **All three runtimes**, by auto-wiring codex and opencode sessions to this server's own `/mcp` — which dissolves §10.2.1's whole "runtime constraint" and, with it, two of DOR-1212's four deferred items.

Everything §10.2/§10.2.2 already settled is inherited rather than re-derived. What this document owes is the delta, the mechanisms the frozen text did not have to think about, and the evidence for both.

**Assumptions.**

- The flag ships **default OFF** and the flip is a **graduation**, gated on evals plus a dogfood week — not on a code review.
- Text-as-reply is the fallback, and it is the fallback **per session**, not per install: a session that did not actually get the tools must keep posting its text or the agent goes mute.
- Per-identity tool gating on the external `/mcp` surface arrives with **DOR-1611 PR1** (`toolGroup` on `CapabilityDefinition`, the check inside `registry.invoke`, fail-closed on absent identity), now specified and merged to `main` as `specs/rooms-management-tools/02-specification.md` D1. This ideation consumes that design and does not redesign it.
- The operator grants nothing per-agent here. This is an install-wide behavioural dial, like `rooms.collectDebounceMs` beside it — not a permission.
- An agent that holds a room membership can already post. Nothing here adds or removes a capability; it changes **who decides** whether words reach the room.

**Out of scope.**

- The per-agent hard tool filter (DOR-1611). Consumed, not built.
- A cheap should-respond gate that avoids spending a turn to say nothing (**DOR-1203**, in progress). The flip makes that item much more valuable — silence stops being rare — but the two are independent and must not be sequenced against each other.
- Splitting `room-service.ts` (3600+ lines), parked on DOR-1212. Real, and it should not ride a behaviour-flip branch.
- Any change to question one, _"do I run a turn?"_ — addressing, the cascade guard and the turn budget are untouched, in both flag states.

## 2) Pre-reading Log

- `.claude/rules/room-conduct.md` — the constitution for this change, read in full. Four bullets bind directly: **"A refusal is visible"** and its two named silences; **"An indicator releases into something durable"** and its four permitted releases plus the named exception for chosen silence; **"Bounds are mechanisms, never prompts"**; and **"An agent's hand in a room is four verbs"**, which is where the §2.6 refusal is restated as a rule.
- `meta/agent-etiquette.md` — **E1** is the hinge: _"When addressed, answer or explicitly decline. Never leave a direct question hanging… Check: every mention of the agent has a corresponding turn, or a visible reason there was not one."_ **E7** ("silence must be free") is why the ambient case must stay costless. **E16b** governs reactions and names the ✅ 👍 👀 triple used verbatim in two places. **E16a** exempts mechanical presence signals from every speaking rule — which is what makes an ephemeral outcome marker legal.
- `specs/room-participation/02-specification.md` §2.6 (`:71-77`), §10.2 (`:565-651`), §10.2.1 (the runtime constraint), §10.2.2 (`:653-676`, the addressed/ambient split). The frozen design and its 2026-08-14 amendment.
- Linear DOR-1613 (description + three comments) and **DOR-1212** (the deferred RP6 remainder, Triage).
- `specs/rooms-management-tools/` (DOR-1611, merged to `main` via #1350) — the enforcement spine this inherits. The **specification's D1** is the version to trust: `registry.invoke` as the single choke point both MCP servers converge on (`mcp-projection.ts:247`), the fail-closed polarity argument, and the sentence that corroborates §4.3's headline risk — on the external `/mcp` surface, dropping `X-DorkOS-Agent` yields "unidentified", and for a verb with no `toolGroup` that still falls through to the install owner (`room-capabilities.ts:216`).

## 3) Codebase Map

### 3.1 The reply path, as it runs today

| Stage                                     | Location                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A committed post fans out                 | `room-service.ts:3266-3275` (`writePost` → `triggers.dispatch`)                                                            |
| Target selection, cascade, ghosts         | `room-trigger.ts:680-886` (`selectCandidates`)                                                                             |
| Gather window → claim → run               | `room-trigger.ts:1025-1034`, `:1137-1358` (`claimCollected`), `:1543-1762` (`runOne`)                                      |
| Claim constructed, `spokeViaTool: false`  | `room-trigger.ts:1349` (triggered), `:2116` (aside)                                                                        |
| The runtime call                          | `room-trigger.ts:1598-1635` → `room-turn-runner.ts:184-479`                                                                |
| Turn text accumulated                     | `room-turn-runner.ts:661-848` (`collectReply`); `text: paragraphs.length === 0 ? null : paragraphs.join('\n\n')` at `:814` |
| **The turn's text becomes the room post** | `room-trigger.ts:1778-1897` (`deliver`), the write at `:1871-1895`                                                         |

`deliver` is the **single** delivery function for in-frame and late answers alike (`deliverLate` at `:1922-1974` calls straight back into it at `:1934`), so its guard order is the whole behaviour:

| #   | Line         | Guard                                                                                |
| --- | ------------ | ------------------------------------------------------------------------------------ |
| 1   | `:1802-1814` | halted → drop the answer, skip the recovery re-arm                                   |
| 2   | `:1815-1818` | `reply.unanswered` → `reportSilence`, return that reason                             |
| 3   | `:1824`      | `notices.recovered(room, agent)` — damping re-arm                                    |
| 4   | `:1826`      | `const said = reply.text?.trim();`                                                   |
| 5   | `:1838`      | `if (!said) return 'quiet';` ← **the silence terminal**                              |
| 6   | `:1848`      | `if (this.takeSpokeViaTool(...)) return 'answered';` ← **the tool-post suppression** |
| 7   | `:1857-1860` | late prefix (`withLateAnswerNote`)                                                   |
| 8   | `:1871`      | the post                                                                             |

`spokeViaTool` (`room-claims.ts:108-123`) is set by exactly one writer, `noteDeliberatePost` (`room-trigger.ts:1490-1493`), called from exactly one place — `room-service.ts:2458`, immediately after `postFromTool` commits. It is consumed once by `takeSpokeViaTool` (`room-trigger.ts:1521-1526`). It suppresses **only** the automatic post of that turn's text into **that same room**; the release still reports `'answered'`.

### 3.2 `post_to_room`, and the §2.6 refusal

`rooms.post`, tier `act`, `servers: ['in-session','external']` (`room-capabilities.ts:320-373`, tool name at `:349`). The handler resolves the author from the verified identity, never from an argument (`callerAuthor`, `:188-218`).

The refusal, verbatim (`room-service.ts:2429-2438`):

```ts
const room = this.requireVisibleRoom(roomId, input.authorId);
// `!== 'channel'`, never `=== 'dm'`: `rooms.kind` is a text column narrowed by
// an unchecked cast, so an unrecognized kind takes the narrower branch
// (`.claude/rules/room-conduct.md`).
if (room.kind !== 'channel') {
  throw new RoomError(
    'TOOL_POST_NOT_IN_DM',
    'This is a direct message — your reply is posted for you, so there is nothing to post here.'
  );
}
```

`postFromTool` is documented as _"`post` with three things added and nothing removed"_ (`room-service.ts:2380-2424`): the DM refusal, the `TURN_WAS_STOPPED` refusal (`:2447-2456`), and `noteDeliberatePost`.

### 3.3 Silence, notices, and the ephemeral lane

- **The silence terminal.** `text: null` with no `unanswered` reason (`room-turn-port.ts:114-119`, `notice-log.ts:73-79`) → `ClaimOutcome` `'quiet'` (`room-claims.ts:167`). The comment at `room-trigger.ts:1827-1838` pins it as chosen behaviour and names it _"the ONE release with nothing durable beside it"_, pinned by `room-presence-claims.test.ts`.
- **A notice is durable.** `postNotice` (`room-service.ts:3525-3553`) appends a real `kind: 'notice'` entry with a `seq`, authored by the system author — it lands in history, export and search. Eight codes, all copy in `notices/notice-copy.ts`, single writer `notice-log.ts:557-578`.
- **The damping predicate I need already exists.** `directlyAsked` (`notice-log.ts:763-772`):

  ```ts
  if (entry.cascadeDepth !== 0) return false;
  if (this.deps.authors.getById(entry.authorId)?.kind !== 'human') return false;
  return room.kind === 'dm' || entry.mentions.includes(agentAuthorId) || namedDirectly;
  ```

- **The ephemeral lane.** `RoomSignalEvent` (`room-schemas.ts:1625-1668`) — _"Delivered live and dropped on replay, so it carries no `seq` and never enters the log."_ `RoomPresenceStateSchema` is `['working','working_late','held','done']` (`:1573-1575`), and its own doc records that **adding a member is additive for a remote producer**. `heldBehind` is the precedent for a deliberately non-durable fact.

### 3.4 The wiring surfaces

- **Codex.** MCP servers ride `CodexOptions.config.mcp_servers` on the **client**, built per turn (`codex-runtime.ts:160-194`, `:337-351`). HTTP transport supports headers under `http_headers` (`codex/mcp-server-config.ts:55-61`). `reservedNames` currently holds exactly `{'dorkos_ui'}` (`codex-runtime.ts:365`) and drops collisions **silently** (`mcp-server-config.ts:96`). The `dorkos_ui` stub (`codex-ui-mcp-server.ts:33-51`, mounted `index.ts:2236-2242`) is the precedent — and it sends **no headers at all**.
- **OpenCode.** `client.mcp.add({ query: { directory: cwd }, body: { name, config } })` at `mcp-manager.ts:235`, called per turn before the prompt (`opencode-runtime.ts:411-416`). Remote config carries `headers` (`opencode/mcp-server-config.ts:51-59`). Collisions surface as `failed` roster entries (`mcp-manager.ts:221-232`) — the opposite of Codex's silent drop. Cleanup is reconciliation-driven (`:206-212`).
- **Identity.** `AgentIdentityService` (`agent-identity-service.ts`): `mint` (`:185-197`) returns the plaintext exactly once; `resolve` (`:213-244`) enforces expiry — **7-day idle, 30-day absolute** (`:69`, `:75`). The mint seam is `resolveAgentTokenEnv(agentPath, displayName)` (`agent-token-env.ts:42-65`), called per turn by codex (`codex-runtime.ts:635-639`) and per launch by claude-code. **OpenCode has no identity path at all** — zero hits in `runtimes/opencode/` — because its sidecar is one shared process with a fixed env.
- **`/mcp`.** Registered `index.ts:2203-2228` behind `validateMcpOrigin` → `requireMcpEnabled` → `createMcpAuth` → rate limit. `X-DorkOS-Agent` (`middleware/agent-identity.ts:32`) resolves to `res.locals.agentIdentity`, reaches the registry as `context.identity`, and becomes the author in `callerAuthor`. Rooms tools carry **no** `readOnlyCarveOut` (`tool-security.ts:31-35`), so an injected server **must** carry a bearer token or every room write 401s.
- **DOR-723.** `index.ts:1008` mints `` `http://127.0.0.1:${PORT}/codex-ui-mcp` `` while the server binds `env.DORKOS_HOST` (default `localhost`, `env.ts:79`) at `index.ts:3272-3295`. The fix already exists and has three sibling call sites: `localDialHost(env.DORKOS_HOST)` (`lib/local-dial-host.ts:33-39`), used correctly at `index.ts:1920-1926`, `index.ts:2013-2023`, `routes/test-control.ts:727-730`. **`index.ts:1008` is the last hardcoded `127.0.0.1` mint site in the server.**

### 3.5 Blast radius

`room-trigger.ts` (`deliver`, the claim), `room-service.ts` (`postFromTool`), `room-claims.ts` (the claim shape), `notices/` (a new code + copy), `room-schemas.ts` (the presence payload), the room-context/instruction builders, `config-schema.ts` (two flags), the codex and opencode runtimes plus the composition root, `packages/evals`, the rooms e2e specs, and six documents that currently state the DM rule as settled.

---

## 4) Research

### 4.1 The flip: what `deliver` does flag-ON, terminal by terminal

The change is small and it is entirely inside `deliver`. **Flag-OFF, not one line of the guard order moves.** Flag-ON, two things happen: the tool mark is consumed **earlier**, and step 8 never runs.

```
  flag OFF (today)                      flag ON
  1 halted            → drop            1 halted            → drop            (unchanged)
  2 unanswered        → notice          2 unanswered        → notice          (unchanged)
  3 recovered()                         3 recovered()                         (unchanged)
  4 said = text?.trim()                 4 spokeViaTool?     → 'answered'      ← MOVED UP
  5 !said             → 'quiet'         5 reactedViaTool?   → 'answered'      ← NEW
  6 spokeViaTool?     → 'answered'      6 declined          → 'quiet' (+notice, if asked)
  7 late prefix                            — the turn's text is never posted —
  8 POST the text
```

**Why the reorder is not cosmetic.** Today `takeSpokeViaTool` is checked at `:1848`, **after** `if (!said) return 'quiet'` at `:1838`. Today that is harmless: an agent that tool-posts almost always also narrates, so `said` is truthy and control reaches the mark. Flag-ON, the well-behaved case is _precisely_ "posted via the tool, narrated nothing" — so the current order would classify **every correct answer** as `'quiet'`, leave the mark standing on a claim about to be deleted, and fire the very "you did not answer" notice the agent just earned its way out of. The seam is already hedged in the `spokeViaTool` doc at `room-trigger.ts:1495-1520`; the flip is the day it stops being theoretical.

**Every terminal, flag-ON:**

| Terminal                      | Flag-OFF today                                        | Flag-ON                                                                                                                                 | Changed?   |
| ----------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **answered** (turn text)      | posts `said`                                          | **does not exist** — text is never the message                                                                                          | ▲ removed  |
| **answered** (tool post)      | suppressed narration; `'answered'`                    | the only way to answer; `'answered'`                                                                                                    | order only |
| **answered** (reaction)       | not a terminal — a reaction never suppressed anything | **new**: a successful `react_to_room_entry` into this room discharges the turn                                                          | ▲ new      |
| **answered late**             | `deliverLate` → same `deliver`                        | same, and it inherits the flip for free                                                                                                 | ✓ free     |
| **quiet**                     | `!said`; nothing durable; the named exception         | the common case; splits by `directlyAsked` (§4.5)                                                                                       | ▲ split    |
| **busy / gone / unavailable** | `reportSilence`, damped                               | unchanged — these never reach step 4                                                                                                    | ✓          |
| **failed**                    | `turn_failed`, never damped                           | unchanged                                                                                                                               | ✓          |
| **halted**                    | answer dropped, `halted` notice is the story          | unchanged, and strictly simpler: there is less to drop                                                                                  | ✓          |
| **awaiting_approval**         | state, not terminal                                   | unchanged                                                                                                                               | ✓          |
| **aside / welcome-back**      | every refusal silent; answer returned to the greeter  | **needs a decision** — the greeter posts the aside's text un-provenanced, which is a second auto-post path the flip does not reach (D9) | ⚠          |

**Two consequences of the flip that nothing in the frozen spec anticipated, because in 2026-07 a tool post was the exception rather than the rule.**

**(1) Every reply loses its answer pointer and its session link.** A turn-text post carries `answersEntryId: entry.id` and `sessionId` (`room-trigger.ts:1874`, `:1894`). A tool post carries **neither** — `postFromTool` never sets them, so `sessionId` falls to `null` (`room-service.ts:3231`) and `answersEntryId` is simply absent. Today that affects the rare deliberate post. Flag-ON it affects **every agent reply in the product**: the room stops drawing the "answers this" pointer, and no room entry can be traced back to the session that wrote it. Both facts are already in hand at write time — the live claim knows its triggering entry and its session — so the fix is to have `postFromTool` fill them from `activeTurnFor`'s claim rather than leaving them blank. This must land **with** the flip, not after it.

**(2) One turn can now write N messages, and nothing bounds N.** There is no per-turn post ceiling anywhere (`grep` for `postsThisTurn|perTurn|postBudget` in `room-service.ts` / `room-capabilities.ts` returns nothing but `TOO_MANY_ATTACHMENTS`). That is deliberate today and even celebrated — DOR-1434 made multiple posts cost **one** turn against the cascade budget, and §10.2 called two posts _"E17 batching expressible rather than accidental"_. But flag-OFF an agent has no reason to post at all, and flag-ON posting is the only voice it has. `room-conduct.md` is unambiguous about what that asks for: _"Bounds are mechanisms, never prompts… do not weaken one because a prompt 'already says' not to do the thing."_ E8 ("one message, not three") is exactly such a prompt. So the flip owes a per-turn post ceiling as a **mechanism** — generous enough to keep §10.2's intent (a status line then an answer), hard enough that a confused model cannot serialise an essay across nine bubbles.

### 4.2 DMs: what the §2.6 reversal touches, and what it must keep

**What the refusal is.** One branch in `postFromTool` (`room-service.ts:2433-2438`), spelled `kind !== 'channel'`, plus four restatements: the error code's TSDoc (`room-errors.ts:96-107`), the tool description (`room-capabilities.ts:327`), the room-conduct bullet, and §2.6 itself. The reversal is a two-line code change and a six-document correction — **the documents are the work.**

**What §2.6's argument actually was**, and why it no longer holds. Verbatim (`:73-77`): _"In a DM the reply **is** the message… Two behaviors is the honest cost of the DM case already being correct. Making the DM case go through a tool would add a way for it to fail and buy nothing."_ Both clauses were true when written and both are now false:

- _"the DM case is already correct"_ — correct for **answering**, and that was the only outcome that existed. It was never correct for **declining** or for **reacting**, because neither was reachable: an agent in a DM could not say "seen 👍" and stop, and could not think without broadcasting. The operator's ask names all three.
- _"two behaviours is the honest cost"_ — the cost is no longer two behaviours, it is **two behaviours that disagree about what silence means**. Flag-ON, a channel turn that says nothing is a choice and a DM turn that says nothing is a bug, and the agent has to hold both models at once from a prompt that must state them both. That is the instruction-drift failure mode in §4.7, and it is worse than the failure §2.6 was avoiding.
- _"adds a way for it to fail"_ — true, and it is the honest price. The mitigation is not to keep two paths; it is E1, the `agent_declined` floor, and an eval that measures DM answer-rate directly.

**What the reversal must keep, and the good news is that it keeps itself.** The loop protection for an agent posting in a DM **already exists and was built for a different reason** — ADR `260814-025326`, after a measured incident where one "hello" in a two-agent DM cost four turns and two apology notices. `selectTriggerTargets` (`addressing.ts:117-136`):

```ts
const impliesEveryone = opts.roomKind === 'channel' || opts.authorKind === 'human';
```

- **Agent A tool-posts in a DM with human H** → `impliesEveryone` is false, and H is filtered out anyway by `member.kind === 'agent'`. **Result `[]`. Nothing re-triggers.** The reply-to-a-human-DM loop is structurally impossible.
- **Agent A tool-posts in a DM with agent B** → B triggers only if B is in `entry.mentions`, resolved at write time, never re-parsed. Identical to today's behaviour when A's _turn text_ posts. **No new reach.**

**Cascade stamping is already right too.** A tool post passes no `trigger`, so `writePost` substitutes `activeTurnFor(authorId)` (`room-service.ts:3161`) → the deepest live claim's `{root, depth}` — the same depth the turn's own answer would have carried. One hop, not two. With no claim it falls to `deriveCascade`'s agent branch and is stamped **at the ceiling** (`cascade-guard.ts:173-174`): spent on arrival, triggering nobody, writing no refusal notice. So `spokeViaTool`'s doc sentence — _"speaking on purpose is not a way to reset the cascade guard"_ — survives the reversal untouched.

**The one thing that genuinely changes.** `spokeViaTool` is `(room, agent)`-scoped and, because the tool refuses DMs, **the suppression is structurally unreachable in a DM today**. The reversal makes it reachable, which is exactly the point — but it also means the DM path stops being the one place where "the turn produced text" and "the room got a message" are the same event. Every DM test that assumed those are synonymous needs re-reading.

### 4.3 The wiring: giving codex and opencode the DorkOS tools

**The shape.** Inject one MCP server entry named `dorkos`, streamable HTTP, pointed at this server's own `/mcp`, carrying two headers:

| Header           | Value                                            | Why                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`  | `Bearer <getMcpLocalToken() \| env.MCP_API_KEY>` | Rooms tools carry no `readOnlyCarveOut` (`tool-security.ts:31-35`), so every room write 401s without it (`mcp-auth.ts:119-123`)                                                                                                                                                                |
| `X-DorkOS-Agent` | freshly minted agent token                       | Without it `callerAuthor` falls through to the **install owner** (`room-capabilities.ts:216`) — the agent would post **in the operator's name**. Corroborated by DOR-1611 spec D1: dropping the header on `/mcp` yields "unidentified", and `post_to_room` carries no `toolGroup` to refuse it |

No `Origin` header is sent by either runtime's MCP client, which clears `validateMcpOrigin` through the non-browser early return (`mcp-origin.ts:19-22`) — the same route `dorkos_ui` already takes.

**Per runtime:**

- **Codex** — build the entry in `buildMcpServersConfig` (`codex-runtime.ts:187-194`) beside `dorkos_ui`, using the HTTP branch's `http_headers` (`mcp-server-config.ts:55-61`). Add `dorkos` to `reservedNames` (`codex-runtime.ts:365`) so a user's own server of that name cannot shadow it. **Cost:** a per-agent header forces the turn-scoped `Codex` client on every agent turn (`codex-runtime.ts:337-351`) — the shared-client fast path is already lost whenever an identity token exists, which for an agent-bound session is always, so this changes nothing in practice for agent turns and nothing at all for non-agent ones.
- **OpenCode** — add it to the desired set that `ensureManaged` reconciles (`mcp-manager.ts:177-251`), with `headers` on the remote config. **This is the only per-agent identity channel OpenCode has** — its sidecar is one shared process with a fixed env, so there is no `DORKOS_AGENT_TOKEN` seam and never will be. Two care points: the reserved-name story is inverted here (collisions surface as `failed` roster entries, `:221-232`, which is better and should stay), and the no-op early return keys on `JSON.stringify(servers)` (`:187-193`) — a re-minted token changes the signature and forces a re-add, which today is **fortunate rather than intended** and should be made deliberate with a test.
- **Claude-code** — unchanged. It reaches the same capabilities in-process.

**DOR-723, and it must not be reproduced.** Mint from `` `http://${localDialHost(env.DORKOS_HOST)}:${PORT}/mcp` ``, never `127.0.0.1`. `localDialHost` (`lib/local-dial-host.ts:33-39`) maps wildcard binds to `localhost` and brackets IPv6 literals; three sibling mint sites already use it and each carries the reasoning inline. Fix `index.ts:1008` in the same PR — it is the last hardcoded site, and shipping a second one beside it would be the bug arriving twice.

**Which sessions get the injection: every session bound to an agent identity, not room turns only.** Reasoning:

- A DM turn **is** a session, and it is the case the operator most cares about. A room-turn-only rule would have to answer "is this dispatch a room turn?" inside the runtime, which is a layering inversion — the runtime does not know why it was called, and `room-turn-runner` is a caller, not a mode.
- The identity token is already resolved per turn from the session's cwd (`codex-runtime.ts:635-639`, `meshCore.getByPath(cwd)`), so "is this agent-bound?" is a question the runtime **already asks and answers**. Reusing that answer adds no new concept.
- The tools are worth having outside rooms anyway: memory, `relay_notify_user`, room history, marketplace. This is why the wiring PR is valuable on its own and can ship before any flip.

**Four gotchas that must be designed for, not discovered.**

1. **`/mcp` sits behind `requireMcpEnabled`** (`index.ts:2206`), which `/codex-ui-mcp` deliberately omits (`index.ts:2232-2235`). So `config.mcp.enabled = false` **plus** the flip ON would leave every codex and opencode agent unable to speak in any room. This is the single worst reachable state in the design and §4.4's per-session capability check exists to make it unreachable.
2. **Token expiry is a time bomb.** `resolve` enforces 7-day idle / 30-day absolute (`agent-identity-service.ts:69,75`), and `callerAuthor` turns a present-but-unresolvable token into a hard `AGENT_IDENTITY_UNVERIFIED` refusal rather than a degrade (`room-capabilities.ts:189-196`) — correct, since the alternative is posting as the operator. The header must therefore be **re-minted per turn** (codex: natural) or **per reconcile** (opencode: works today by accident, per above).
3. **`sessionId` and `cwd` are absent on the external `/mcp` surface** (`registry.ts:124-129`, `:186-190`). No rooms capability needs them today, but any future one must be told explicitly — the in-session server is not the same context.
4. **Codex's event mapper needs no interception, and should get none.** `mcp_tool_call` special-cases exactly `dorkos_ui`/`control_ui` (`event-mapper.ts:259-266`) because its result is a stub and the real effect happens elsewhere. `post_to_room` is the opposite: a genuine server-side effect whose result (`{posted, entryId, seq}`) is real and whose outcome the person sees in the room. It should render as an ordinary `mcp__dorkos__post_to_room` call (`event-mapper.ts:473`). **Verified against the code; the operator's hypothesis holds.**

### 4.4 The flag: shape, name, and the per-session check that makes it safe

**Two flags, because these are two things and one is a prerequisite that is worth having on its own.**

| Leaf                    | Default | What it does                                                                                                                                                                                                       |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtimes.dorkosTools`  | `false` | Auto-wire codex and opencode agent sessions to this server's `/mcp`, with per-agent identity. Gives those agents **all** DorkOS tools — memory, `relay_notify_user`, room history, marketplace — not just posting. |
| `rooms.toolOnlyReplies` | `false` | The flip. A turn's text is never auto-posted; the agent posts, reacts, or stays silent.                                                                                                                            |

**`rooms.toolOnlyReplies` nests beside the dials it belongs with** — `config-schema.ts` `rooms.*` already holds `collectDebounceMs`, `lateReplyCeilingMinutes`, `engagedWindowMinutes`, `maxAutomaticTurnsPerRoomPerHour`. This is room conduct, not runtime plumbing, and a reader looking for "how do my agents behave in rooms" looks there. `runtimes.dorkosTools` sits beside `runtimes.claudeCode` / `codex` / `opencode` as the cross-runtime setting it is. Mind the shallow-merge warning already in that file: _"Every declaration of these values has to agree, here and in the section literal below, because `conf` merges top-level defaults shallowly."_

**Both are Experiments-registry entries, not bare leaves.** `experiments-registry.ts:27-42` states a contract a new flag must satisfy — the path resolves to a real `UserConfigSchema` boolean leaf, it **defaults to `false`**, and it carries a non-empty `graduationIssue`. That is precisely this feature's shape, and it buys the whole UI for free: `ExperimentsTab.tsx` holds zero per-experiment knowledge and draws a `SwitchSettingRow` per registry entry. The `persistentSession` precedent the brief points at is the **graduation** half of the same story — it was an experiment, it flipped its default in migration `'0.67.0'` (`config-manager.ts:2823-2839`), and its row was then deleted from the registry and re-homed in the Control Center. That is the arc this feature should plan for, and §8's graduation gate is where it goes.

Proposed copy, in the registry's own register (_"say what happens for them, benefit before cost, no mechanism"_, `experiments-registry.ts:36-41`) and following the `a2a.enabled` entry's habit of naming its prerequisite:

> **Agents decide when to speak**
> Right now, whatever your agent writes during a room turn gets posted. With this on, it chooses: it can answer, it can just react with an emoji, or it can decide nothing needs saying and stay quiet — and its thinking stays in its own session instead of landing in the room.
> _Cost note:_ An agent that forgets to answer says nothing. The room tells you when that happens, but it is a new way for a reply to go missing, so watch a few conversations after you turn it on.

> **DorkOS tools in every runtime**
> Codex and OpenCode agents get the same DorkOS tools your Claude Code agents already have — posting in rooms, reacting, reading room history, and remembering things between sessions. Takes effect on their next turn.

**The per-session capability check, which is the load-bearing part of the whole design.** The flag must **not** be read as "suppress the text". It must be read as: _suppress the text only where we positively know this session can post._ The reason is `/mcp`'s kill switch — `requireMcpEnabled` (`index.ts:2206`) 503s the whole surface when `config.mcp.enabled` is false, and `/codex-ui-mcp` deliberately omits that guard, so nothing else in the product behaves this way. Flag-ON plus `mcp.enabled` off would leave every codex and opencode agent **unable to speak in any room**, with no error a person would ever see. Token expiry (§4.3) reaches the same state on a 30-day fuse.

So resolve a **reply mode per turn**, not per install:

```
replyMode(turn) =
  'tool-only'  when rooms.toolOnlyReplies AND this session is known to carry the rooms tools
  'text'       otherwise                                   ← including "we do not know"
```

| Runtime     | Known tool-capable when                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| claude-code | always — in-process, and all four room verbs are in `ALWAYS_LOADED_TOOLS` (`tool-exposure.ts:106-115`)                 |
| codex       | the `dorkos` entry was built into this turn's `CodexOptions.config.mcp_servers`                                        |
| opencode    | `ensureManaged` reported the `dorkos` add as applied for this cwd (`mcp-manager.ts:41-47` already tracks exactly this) |
| test-mode   | **false by default** — see below                                                                                       |

**This fails OPEN, deliberately, and the polarity deserves stating because it is the opposite of DOR-1611's.** DOR-1611's grant is a security boundary asking a positive question, where dropping a credential must strictly narrow. This asks a delivery question, where the two errors are not symmetric: failing closed makes an agent silently mute, and `room-conduct.md` Constraint 6 is unambiguous that **silence is the worse failure**. Failing open posts a turn's text that the agent might not have chosen to post — untidy, visible, recoverable. Choose the recoverable one. Nothing about permission is decided here; the agent could always post.

**Test-mode reports not-capable by default, and that is what keeps the e2e suite green.** Test-mode never calls a room tool — there is no `post_to_room` anywhere under `runtimes/test-mode/`, and its default scenario is a pure echo (`scenario-store.ts:238-287`). Every deterministic room reply in the product's e2e suite and in the free eval tier therefore flows through the auto-post path. If the flag alone drove suppression, turning it on would redden six e2e tests across `room-autonomy.spec.ts` and `team-room.spec.ts` and three free eval cases at once. With the per-session check, **flag-ON changes nothing for any existing scenario**, and coverage of the flip comes from a new scenario that declares itself tool-capable and calls `post_to_room` — added to the test-mode scenario registry the same way `BUILT_IN_SCENARIOS` holds the rest. New specs opt in; old specs are untouched by construction.

### 4.5 The unanswered indicator: exact shape, and an honest reconciliation

**The rule that governs this is `room-conduct.md`'s _"An indicator releases into something durable"_**, whose four permitted releases are a post, a fresh notice, a standing notice under the same damping key, **or the one named exception — a turn that ran and chose to say nothing**. Today that exception is rare. Flag-ON it becomes the common case, and an exception carrying that much weight has to be re-argued rather than leaned on.

**The split is not new and it should not be re-derived: §10.2.2 already settled it.** The obligation attaches to **being addressed**, not to running a turn.

| Trigger                                                          | Turn ends with no post and no reaction                    | Why                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Addressed** — a person named this agent, or wrote in a DM      | **A durable one-line notice**, damped                     | E1: being asked creates an obligation, and silence discharges it visibly or not at all |
| **Ambient** — `always` / `engaged` / fallback seat, nobody asked | **Nothing durable, ever.** The named exception, unchanged | E7: silence must be free. This is the common case and the whole point of the feature   |

**Use the predicate that already ships.** `directlyAsked` (`notice-log.ts:763-772`) asks exactly this question and has already been tuned twice by measured incidents — once too wide (apologies about agents nobody addressed), once too narrow (`@ana are you there?` answered with silence). Its three conditions — depth 0, human author, and (`kind === 'dm'` ∨ named in stored `mentions` ∨ `namedDirectly`) — are the right ones. It is currently a **private** method used to decide _damping_; here it decides _whether to write at all_. That is a second consumer for one predicate, so promote it to a named export rather than copying it: two copies of this predicate is how the two incidents above come back one at a time.

Note it is deliberately **narrower** than §10.2.2's "addressed", which reads off the dispatcher's trigger reason and would include an agent mentioning another agent. Take the narrow one. The flood evidence is measured and agent-to-agent traffic is exactly where notices spray; E1's obligation is about a person's question; and the cascade guard already bounds the agent-to-agent case.

**The durable half.** A ninth notice code, `agent_declined` — the name §10.2.2 already chose — in `notices/notice-copy.ts` beside the other eight, written through `notice-log.ts`'s single `write` seam. `room-conduct.md` is explicit that this is the only legal way to add one: _"A new way to go quiet earns a new code there, never a free-text line."_ Damped on the existing `noticedSilence` memory under a new `dampReason`, re-armed by `recovered` like its siblings. Copy in the room's voice, stating the fact and not apologising for it:

> **Ana read this and did not reply.**

**The ephemeral half, for the ambient case.** Nothing durable — but a working pill that appears and vanishes with nothing to show for it reads as a crash, and flag-ON that happens many times a day instead of rarely. The fix belongs on the lane that already carries non-durable facts: `RoomSignalEvent` (`room-schemas.ts:1625-1668`), _"delivered live and dropped on replay… never enters the log"_, whose `heldBehind` field is the precedent for a deliberately non-durable statement.

**Add an optional field to the `done` signal. Do not add a fifth `RoomPresenceState`.** This is the one mechanical decision in this section and it matters: `RoomPresenceStateSchema` is a Zod enum parsed by every client and reused by the `CommunityAdapter` presence payload, and `useRoomPresenceStore.observe` **drops** a frame it cannot parse (`room-schemas.ts:1762-1766`). A new enum member would therefore make an older client — a desktop build behind by one release, a community peer — fail to parse the release frame and **leave the working pill spinning forever**. An optional field degrades to exactly today's behaviour. The schema's own doc already blesses the additive direction for a remote producer.

```
state: 'done', outcome?: 'answered' | 'silent'
```

Rendered as the pill releasing into a brief, fading "finished — nothing to add", gone on reload. E16a is what makes this legal without it counting as participation: a mechanical presence signal published by the harness while it holds a real claim _"is not a turn, not an acknowledgment, and never model-chosen."_ Past-tense, so unlike the held-promise this replaces nothing is lost when a restart forgets it — the fact was already true and already stale.

**Two amendments `room-conduct.md` needs, and both are honest rather than cosmetic.**

1. **The four permitted releases become five: add a reaction.** A reaction-only turn is a first-class outcome under the flip, and a reaction is durable (it survives a reload, it is drawn on the entry) but is deliberately not an entry. Under the current wording such a release has no durable sibling and is therefore "a defect". It plainly is not one.
2. **Record that the named exception now carries the common case, and that the ephemeral outcome marker is what keeps it honest.** The exception's wording does not change and its scope does not widen — what changes is that the addressed half of it now has a durable sibling it never had, so the exception is exercised _only_ where nobody asked. In practice the exception gets **narrower**, not wider, which is the opposite of what a reader would assume from a feature called "silence by default", and is worth writing down.

**A reaction discharges the obligation.** _"A thumbs-up reaction can BE the answer"_ is the operator's ask, and it means `agent_declined` must not fire on a turn that reacted. That needs a `reactedViaTool` mark on `ActiveClaim` beside `spokeViaTool`, set by `toggleReaction` on a **successful** reaction only — a reaction refused by the hourly `ReactionBudget`, or by the `stoppedIn` mark, put nothing in front of anybody and must not buy silence. Whether the reaction was a _good_ answer is conduct, measured by evals; whether the room shows something is mechanism. That is I2 observed exactly.

### 4.6 What the agent is told, and the drift risk

**The worst reachable outcome of this whole feature is an agent told "whatever you say is posted" while the flag silently drops what it says.** That sentence exists, in the runtime-neutral block, and it is the single highest-risk line in the change:

`room-context-block.ts:969-974`:

```ts
lines.push(
  data.thread
    ? `Whatever you say this turn is posted as a reply in that thread, not into the main flow ` +
        `of ${where}. Every member can read it there.`
    : `Whatever you say this turn is posted into ${where}, where every member reads it.`
);
```

**Nine prompt strings say it or depend on it**, and every one must become mode-aware or be corrected:

| #       | Location                        | The claim                                                                             |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| P1 / P2 | `room-context-block.ts:969-974` | "Whatever you say this turn is posted into…" — **runtime-neutral, the dangerous one** |
| P3      | `context-builder.ts:347`        | "Not for direct messages: there your reply is already the message."                   |
| P4      | `context-builder.ts:348-350`    | posting into the triggering room means the narration is not posted as well            |
| P5      | `context-builder.ts:358-361`    | "Every word you write back in a room turn is posted into the room…"                   |
| P6      | `context-builder.ts:336`        | "you can do four things **besides replying**"                                         |
| P7      | `room-capabilities.ts:327`      | "It does NOT apply to direct messages: there your reply is already the message."      |
| P8      | `room-capabilities.ts:328-330`  | the same suppression claim, on the runtime-neutral tool description                   |
| P9      | `room-capabilities.ts:381-383`  | the reaction's "say nothing else about it" clause                                     |

Plus the `TOOL_POST_NOT_IN_DM` **error message itself** — _"This is a direct message — your reply is posted for you, so there is nothing to post here"_ (`room-service.ts:2436`) — which flag-ON is not merely stale but actively false, and reaches the model as a `CapabilityToolError`. Plus six code-comment invariants (`room-capabilities.ts:72`, `room-service.ts:2393-2396`, `room-errors.ts:98`, `context-builder.ts:331`, …) and thirteen doc/spec/rule statements.

**Three rules for resolving this.**

1. **P7 and P8 are on a capability description, which is minted once at boot and is install-wide — it cannot be per-session.** So the tool descriptions must be rewritten **mode-neutrally** rather than branched: describe what the tool does, and let the refusal carry the condition. "Say something in a room you are a member of" is true in both modes and in both room kinds; "it does NOT apply to direct messages" is true in neither once §2.6 is reversed.
2. **P1/P2 live in the shared block and must become mode-aware.** This collides with a guard test: `room-context-block.test.ts:457-467` asserts the shared block _"teaches no tool, because this block is shared with runtimes that carry none (DOR-1234)"_. That premise is exactly what the wiring PR removes — after it, every runtime can carry them. The guard should not be deleted, though: it should be re-aimed at the real invariant, which is that the block never names a tool the **session it is being built for** does not have. The block already receives per-turn data; the reply mode joins it.
3. **The claude-code-only `ROOM_TOOLS_CONTEXT` (P3–P6) is where the flag-ON instruction gets its detail**, because that is where the tool names legitimately live today. Under the wiring, codex and opencode need the same detail — which is an argument for hoisting `ROOM_TOOLS_CONTEXT` to the shared layer, gated on the session's actual tool-capability rather than on the runtime's static `supportsMcp`. Worth doing, and it is a second reason the wiring PR should land first and alone.

**One instruction to add and one to delete, flag-ON.** Add: in a DM with a person, answering is not optional — this is E1 stated where the agent will read it, and it is the mitigation the whole DM reversal rests on. Delete: every clause promising the turn's text will be posted.

### 4.7 Evals

**The suite already exists, and one of its cases is this feature's acceptance test.** `packages/evals` ships a `rooms` suite in two tiers: a **free structural tier** on `test-mode` that **gates** (five cases in `src/suite/rooms.ts`, run nightly in CI), and a **credentialed judgment tier**, all `quarantined: true`, in `src/suite/rooms-recall.ts`. Among the quarantined nine is `rooms-ack-only-reacts-not-replies` — DOR-1234 — whose recorded failure is verbatim the thing this flip removes: _"having reacted, the agent still wrote 'Done — release notes acknowledged.', and a room turn's text is posted."_ Three runs of prompt fixes did not close it, and `chat-capabilities.md` A-06 concludes it is _"model-tuning territory, not a missing instruction."_ **It is neither: it is a mechanism gap, and this is the mechanism.** Un-quarantining A-06's case is the cleanest graduation signal available.

**Free structural tier — mechanism, gates, runs in CI.** Extend `src/suite/rooms.ts` using a tool-capable test-mode scenario:

| Case                                           | Asserts                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `rooms-tool-post-is-the-only-reply`            | the scenario posts via the tool and narrates; exactly one entry lands, and it is the tool's text              |
| `rooms-addressed-silence-writes-one-notice`    | mentioned, no post, no reaction → exactly one `agent_declined`; three mentions in one cascade still write one |
| `rooms-ambient-silence-writes-nothing`         | ambient trigger, no post → zero entries, zero notices, and the claim released                                 |
| `rooms-reaction-discharges-the-answer`         | mentioned, reaction only → no `agent_declined`, the pill is on the entry                                      |
| `rooms-dm-tool-post-lands-and-triggers-nobody` | the §2.6 reversal, plus `selectTriggerTargets` returning `[]`                                                 |
| `rooms-text-fallback-when-not-wired`           | flag ON, session not tool-capable → the text posts, exactly as today                                          |

**Credentialed judgment tier — `pnpm evals:local`, never CI.** Turbo strips `ANTHROPIC_API_KEY` from `pnpm test` / `verify` / pre-push, and `.github/workflows/evals.yml` runs credentialed cases manual-only; keep both properties.

| Case family                                                                                              | Measures                                                                                           |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **DM answer-rate** (×3 phrasings: a direct question, an ambiguous request, a statement that implies one) | a `post_to_room` landed in that DM. **The floor: a human DM must virtually always get an answer.** |
| **DM restraint** (a bare "thanks" that needs no answer)                                                  | the discriminator — without it the DM suite is a check that cannot fail                            |
| **Channel: mentioned with a real question**                                                              | posts                                                                                              |
| **Channel: ambient, a human is already answering**                                                       | stays silent (E3/E4)                                                                               |
| **Channel: "no reply needed, just ack"**                                                                 | reacts, and writes nothing — the existing A-06 case                                                |

**Every new oracle ships a drill, and the drill is what makes the suite worth its cost.** The README requires red-before/green-after per oracle (`:515-549`). The mutation for the DM suite is specific and must be recorded: **strip the flag-ON "in a DM with a person, always answer" line from the room context and re-run — answer-rate must measurably drop.** If it does not, the eval is measuring the model's disposition rather than this feature, and its green means nothing.

**Cost.** Rooms cases report `unmetered` and honestly so: the cost signal rides the per-**session** stream while a room drive collects the **room** stream, so `--budget` cannot see a room turn (README:112-120). What bounds them is the drive ceiling — 5 min credentialed. So the ceiling must be stated as a case count: ~12 credentialed cases at the measured $0.038–$0.057 per core case on Haiku ≈ **$0.50–0.70 per full judgment run**, well inside `evals:local`'s `--budget 2`. Free-tier cases must **not** be tagged `core`, or every `pnpm evals:local` pays for them.

**Graduation criteria for flipping `rooms.toolOnlyReplies` to default-ON** — all five, and the last is not optional:

1. Every free structural rooms case green, and gating (a run gating zero cases is treated as a failure by the summary).
2. DM answer-rate **100% on direct questions** across three seeds and all three runtimes, with the mutation drill confirming the eval can go red.
3. The DM restraint case passing, so (2) is discriminating.
4. `rooms-ack-only-reacts-not-replies` un-quarantined and green.
5. **A dogfood week** on the operator's own install with the flag on, counting `agent_declined` notices — every one is a measured near-miss, and a rate that does not fall over the week is the signal to stop.

Then the flip is a `CONFIG_MIGRATIONS` entry that moves only the exact shipped `false`, exactly like `warmClaudeCodeSessionsByDefault` (`config-manager.ts:2823-2839`), plus deleting the registry row and re-homing the switch — the arc `persistentSession` already walked.

---

## 5) Decisions

### 5.1 Settled by the operator and the orchestrator — recorded, not re-litigated

| #   | Decision    | Choice                                                                                                                                           | Rationale                                                                                                  |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| S1  | The flip    | A turn's text is never auto-posted. The agent posts, reacts, or is deliberately silent; its reasoning stays in its session. Channels **and** DMs | Operator, 2026-08-27. Sometimes no response is the right response, and a reaction can be the whole answer  |
| S2  | DMs         | `post_to_room`'s §2.6 DM refusal is **reversed** under the flag, and the reversal ships with an ADR                                              | Operator. A settled spec decision cannot be quietly undone                                                 |
| S3  | Runtimes    | All three, via auto-injecting a `dorkos` MCP entry pointing at this server's own `/mcp` with per-agent identity headers                          | The `supportsMcp: false` constraint was a misreading; both runtimes accept HTTP MCP injection with headers |
| S4  | DOR-723     | In scope for the wiring PR — the new injection must not reproduce it                                                                             | A second hardcoded `127.0.0.1` mint site beside the first is the bug arriving twice                        |
| S5  | Gating      | Config flag, default OFF, following the experiment pattern                                                                                       | Behaviour change to every room conversation on the install                                                 |
| S6  | Fallback    | Text-as-reply remains the fallback where the wiring or the flag is off                                                                           | Silence is the worse failure                                                                               |
| S7  | Silence     | Reuse the existing silence terminal; add a quiet, damped "finished without replying" indicator                                                   | The machinery exists; the shape was this ideation's to design (§4.5)                                       |
| S8  | Evals       | DM answer-rate + channel judgment, in `packages/evals`, via `pnpm evals:local`, never CI                                                         | Evals spend real money                                                                                     |
| S9  | Tool gating | Per-identity gating on external `/mcp` arrives with DOR-1611 PR1; consume it, do not redesign                                                    | One choke point, `registry.invoke`, already covers both MCP surfaces                                       |

### 5.2 Settled by this ideation, with reasons

| #   | Decision                                                                                    | Choice                                                                                                                                                                                                              | Rationale                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Relationship to DOR-1212**                                                                | DOR-1613 **absorbs** DOR-1212. Items 1 and 2 (the flip, `agent_declined`) ship here; items 3 and 4 (`ROOM_AGENT_CANNOT_POST`, the gated/automatic membership fact) are **transformed**, not deferred                | §10.2 designed this flip in full and DOR-1202 deferred it. Two open issues for one behaviour is how a spec ends up amended twice in opposite directions. DOR-1212 should be closed into this one at SPECIFY                                                                                                                                                 |
| D2  | **The gated/automatic fact moves from per-membership to per-session**                       | The wiring makes every runtime capable, so "can this agent post?" stops being a property of its runtime and becomes a property of whether **this session** got the tools. That is the reply-mode resolution in §4.4 | §10.2.1's premise — that codex/opencode structurally cannot carry the tool — is what the wiring removes. A per-membership fact would now be a lie stored in a table. `ROOM_AGENT_CANNOT_POST` at `addMember` becomes unbuildable and should be dropped rather than built: no runtime is in the state it guards, and the state it guards can no longer exist |
| D3  | **Reply mode is per turn, and it fails OPEN**                                               | Suppress the text only where the session is **known** tool-capable; "we do not know" posts the text                                                                                                                 | `/mcp` sits behind `requireMcpEnabled`, and tokens expire on a 30-day fuse. Both reach "the agent cannot speak and nobody is told". Constraint 6: silence is the worse failure. Deliberately the opposite polarity to DOR-1611's grant, which is a security boundary where dropping a credential must narrow                                                |
| D4  | **`deliver` consumes the tool mark BEFORE deciding quiet, flag-ON**                         | Move `takeSpokeViaTool` above the `!said` branch in the flag-ON path; leave the flag-OFF order byte-identical                                                                                                       | Today the order is harmless because a tool-posting agent also narrates. Flag-ON the well-behaved case is "posted, narrated nothing", which the current order classifies as `'quiet'` and punishes with the very notice the agent earned its way out of                                                                                                      |
| D5  | **`postFromTool` fills `answersEntryId` and `sessionId` from the live claim**               | Ships **with** the flip, not after                                                                                                                                                                                  | Flag-ON every reply becomes a tool post, so every reply would otherwise lose its answer pointer and its session link. Both facts are in hand at write time                                                                                                                                                                                                  |
| D6  | **A per-turn post ceiling, as a mechanism**                                                 | `rooms.maxPostsPerTurn`, default 3, refused at the boundary with a typed error naming the remedy                                                                                                                    | Flag-ON, posting is the only voice an agent has and nothing bounds how often it uses it. `room-conduct.md`: _"Bounds are mechanisms, never prompts"_ — E8 is a prompt. 3 keeps §10.2's intent (a status line, then an answer) without letting a confused model serialise an essay across nine bubbles                                                       |
| D7  | **The silence obligation uses `directlyAsked`, promoted to an export**                      | Not §10.2.2's broader "addressed" (which includes an agent naming an agent)                                                                                                                                         | It has been tuned twice by measured incidents, in both directions. E1's obligation is a person's question; the agent-to-agent case is bounded by the cascade guard. Two copies of this predicate is how those incidents return                                                                                                                              |
| D8  | **The ephemeral outcome is an optional field on `done`, never a fifth `RoomPresenceState`** | `outcome?: 'answered' \| 'silent'`                                                                                                                                                                                  | A new enum member fails Zod parse on an older client, and `observe` drops unparseable frames — leaving the working pill spinning forever. An optional field degrades to today's behaviour. The schema's own doc blesses the additive direction                                                                                                              |
| D9  | **A reaction discharges the obligation, and needs its own claim mark**                      | `reactedViaTool` on `ActiveClaim`, set only on a **successful** reaction                                                                                                                                            | "A 👍 can BE the answer" is the ask. A reaction refused by the hourly budget or the `stoppedIn` mark put nothing in front of anybody and must not buy silence                                                                                                                                                                                               |
| D10 | **The injection targets every agent-bound session, not room turns only**                    | Keyed on the same `meshCore.getByPath(cwd)` answer the runtime already computes per turn                                                                                                                            | A DM turn is a session. A room-turn-only rule would make the runtime ask why it was called, which it cannot know. And the tools are worth having outside rooms — which is what makes the wiring PR shippable alone                                                                                                                                          |
| D11 | **Two flags, not one**                                                                      | `runtimes.dorkosTools` (wiring) and `rooms.toolOnlyReplies` (the flip), both Experiments entries defaulting `false`                                                                                                 | They are separable, the wiring is independently valuable, and the registry contract requires a boolean leaf defaulting false with a graduation issue — which is exactly this shape                                                                                                                                                                          |
| D12 | **Codex's event mapper gets no interception**                                               | `mcp__dorkos__post_to_room` renders as an ordinary MCP tool call                                                                                                                                                    | `dorkos_ui` is special-cased because its result is a stub and the effect happens elsewhere. This is the opposite: a real server-side effect whose outcome the person sees in the room. Verified at `event-mapper.ts:259-266`                                                                                                                                |
| D13 | **Tool descriptions become mode-neutral rather than mode-branched**                         | Describe the verb; let the refusal carry the condition                                                                                                                                                              | A capability description is minted once at boot and is install-wide. It cannot be per-session, and a description that contradicts the running mode is the drift risk in §4.6                                                                                                                                                                                |
| D14 | **Test-mode reports not-tool-capable by default**                                           | Coverage of the flip comes from a new opt-in scenario                                                                                                                                                               | Keeps all six affected e2e tests and three free eval cases green **by construction** rather than by editing them, so the flip's blast radius on the suite is additive                                                                                                                                                                                       |

---

## 6) Risks

| #   | Risk                                                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                            | How it is measured                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **The forgotten reply** — the agent thinks, ends the turn, and the person sees nothing                                          | Four layers, in order of reliability: the `agent_declined` notice (mechanism, always fires when a person asked); the flag-ON instruction that a DM from a person must be answered; the DM answer-rate eval with its mutation drill; and D3's fail-open so an unwired session never goes quiet at all                                                  | Count `agent_declined` notices over a dogfood week. Every one is a measured near-miss. A rate that does not fall is the signal to stop |
| R2  | **The mute state** — flag ON, `config.mcp.enabled` off or a token aged out, and every codex/opencode agent is silent everywhere | D3: reply mode is per turn and fails open. Plus re-mint the identity header per turn / per reconcile                                                                                                                                                                                                                                                  | A test that flips `mcp.enabled` off with the flag on and asserts the text still posts                                                  |
| R3  | **Instruction drift** — the model is told its text will be posted while the flag drops it                                       | §4.6's nine prompt sites, the false `TOOL_POST_NOT_IN_DM` message, and D13's mode-neutral descriptions. The re-aimed shared-block guard test is the standing defence                                                                                                                                                                                  | The guard test at `room-context-block.test.ts:457-467`, re-aimed at "never names a tool this session does not have"                    |
| R4  | **Loops from DM tool-posts**                                                                                                    | **Already closed, by machinery built for another reason.** An agent's post in a DM addresses only whom it names (`addressing.ts:117-136`, ADR `260814-025326`); a post to a human DM selects `[]`. A mid-turn tool post inherits the turn's cascade depth via `activeTurnFor`; an un-provenanced one is stamped at the ceiling                        | The new `rooms-dm-tool-post-lands-and-triggers-nobody` structural case                                                                 |
| R5  | **The flip makes rooms noisier, not quieter** — one turn writing N posts where it used to write one                             | D6's per-turn ceiling, as a mechanism                                                                                                                                                                                                                                                                                                                 | The ceiling's refusal is countable                                                                                                     |
| R6  | **Every reply loses its answer pointer and session link**                                                                       | D5, shipped with the flip                                                                                                                                                                                                                                                                                                                             | An e2e assertion that a tool-posted reply still renders its "answers this" pointer                                                     |
| R7  | **The e2e and eval suites go red on the flip**                                                                                  | D14: test-mode is not tool-capable by default, so nothing existing changes                                                                                                                                                                                                                                                                            | The suites, unedited, stay green with the flag on                                                                                      |
| R8  | **The aside/welcome-back path is a second auto-post the flip does not reach**                                                   | The greeter posts the aside turn's text un-provenanced (`room-trigger.ts:2010-2018`), outside `deliver`. Flag-ON this would be the one place a turn's text still becomes a message. **Open (Q3)** — either bring it under the same mode, or state deliberately that a welcome-back offer is the room asking a closed question and keeps text-as-reply | —                                                                                                                                      |
| R9  | **Codex loses its shared-client fast path**                                                                                     | Already lost for agent-bound sessions: a turn-scoped `Codex` client is minted whenever an identity token exists (`codex-runtime.ts:337-351`), which for an agent is always. Non-agent sessions are untouched                                                                                                                                          | —                                                                                                                                      |
| R10 | **Reserved-name collision goes unreported on codex**                                                                            | Codex drops a reserved name **silently** (`mcp-server-config.ts:96`) where opencode surfaces it as a `failed` roster entry (`mcp-manager.ts:221-232`). Add `dorkos` to `reservedNames`, and consider making the codex drop reportable — a user with their own `dorkos` server would otherwise see tools vanish with no diagnostic                     | —                                                                                                                                      |
| R11 | **A silent turn re-arms the silence damping keys**                                                                              | `notices.recovered` fires at `room-trigger.ts:1824`, **before** the quiet branch, and flag-ON quiet turns are common. This is still correct — a quiet turn proves the agent is reachable, which is what `busy`/`gone`/`unavailable` damping is about — but it is a behaviour change in volume and should be asserted rather than assumed              | A test that a quiet turn re-arms, and that the next genuine busy refusal is therefore shown                                            |

---

## 7) `meta/chat-capabilities.md` — the rows this touches

The doc re-audit rides the implementation PRs (§12 of that file: _"New chat feature → add its rows here in the same PR"_).

**§6 Agent autonomy — the section this feature is about.**

| Row                                | Line   | What changes                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-06** reactions used well       | `:144` | **The headline.** Its recorded blocker is _"having reacted, the agent still wrote… and a room turn's text is posted"_, concluded as model-tuning. It is a mechanism gap and this closes it. Rewrite the verdict and un-quarantine `rooms-ack-only-reacts-not-replies` (also restated at `:265`) |
| **A-02** intelligent response mode | `:140` | Gains the other half: `engaged` decides whether a turn RUNS; this decides whether it SPEAKS. Note the interaction with DOR-1203 without sequencing against it                                                                                                                                   |
| **A-08** yielding                  | `:146` | `not built` → reachable for the first time. An agent that sees a human already answering can now stand down, because standing down finally has a representation                                                                                                                                 |
| **A-10** thread discipline         | `:148` | `partial` — "the mechanism exists; choosing to is conduct, untested". Becomes testable, since choosing is now the only path                                                                                                                                                                     |
| **A-12** self-correction           | `:150` | `partial` — unchanged in mechanism, but a correction is now the same verb as any other reply                                                                                                                                                                                                    |
| **A-16** human override            | `:154` | Unchanged. Worth re-verifying that halt still drops both voices — `haltedTurns` for delivery and `stoppedHere` for `postFromTool` — when delivery no longer carries text                                                                                                                        |

**§5 Rooms, threads, DMs.**

| Row                                     | Line   | What changes                                                                                                                                         |
| --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M-07** DMs: open, post, agent replies | `:125` | The §2.6 reversal lands here. Coverage `E (open/post)` should gain the tool-post path                                                                |
| **M-04** etiquette / over-participation | `:122` | Coverage `—`, no automated coverage at all. This feature gives it its first mechanism and its first evals; the row should stop reading as unmeasured |
| **A-04** three-way agent DMs            | `:142` | Unchanged and load-bearing: _"agent posts in non-channels reach only members they @mention"_ is the sentence that makes R4 already-closed            |

**§2 Receiving & rendering.**

| Row                                 | Line  | What changes                            |
| ----------------------------------- | ----- | --------------------------------------- |
| **R-09** agent stall/silence notice | `:74` | Gains a ninth code, `agent_declined`    |
| **R-08** reactions on room entries  | `:73` | Gains the agent-reaction-as-answer case |

**§1 and §4 — the `Path` column, answered directly.** The column (`:23`) means `resume` / `pump` / `both`, and _"a row that reads differently on the two paths is two rows."_ **This feature adds no row to either section and splits none**, because the flip is orthogonal to the persistence path: `:113` states that _"nothing in the rooms layer knows which path it is on"_, and the reply-mode resolution in §4.4 keys on tool-capability, never on the pump. Any new row lands in §5 or §6, neither of which carries a `Path` column. One separate correction is owed while in the file: the column's own copy still calls the pump _"the experiment"_, which graduated.

---

## 8) Phasing

Four PRs, each shippable dark, in this order. The first two are independently valuable and the ordering is a real dependency, not a preference.

**PR1 — the wiring.** `runtimes.dorkosTools` (Experiments entry, default off). The `dorkos` MCP injection for codex (`buildMcpServersConfig` + `reservedNames`) and opencode (`ensureManaged`), with `Authorization` and a per-turn-minted `X-DorkOS-Agent`. **The DOR-723 fix**, applied to both the existing `dorkos_ui` mint site (`index.ts:1008`) and the new one, via `localDialHost`. A test that a re-minted token forces an opencode re-add (making today's accident deliberate). No room behaviour changes at all. **Ships value alone:** codex and opencode agents gain memory, `relay_notify_user`, room history and the marketplace tools. Probably also the right PR to hoist `ROOM_TOOLS_CONTEXT` to the shared layer, gated on session tool-capability.

**PR2 — the flip.** `rooms.toolOnlyReplies` (Experiments entry, default off). Reply-mode resolution (D3). The `deliver` reorder (D4). The §2.6 reversal **and its ADR**. `agent_declined` + the promoted `directlyAsked` (D7). `reactedViaTool` (D9). The `done` outcome field (D8). `postFromTool` filling `answersEntryId`/`sessionId` (D5). The per-turn post ceiling (D6). All nine prompt sites plus the error message (§4.6). The two `room-conduct.md` amendments and the inline spec amendments to §2.6/§10.2/§10.2.1/§10.2.2. The tool-capable test-mode scenario, and the free structural eval cases + new e2e coverage riding it.

_Could PR2 split?_ The DM reversal is arguably separable. It should not be: it is one behaviour under one flag, and shipping the channel half first would leave the agent holding two contradictory models of what silence means — the exact drift failure of §4.6.

**PR3 — the credentialed evals.** The judgment-tier cases, their oracles, and the mandatory red-before/green-after drill per oracle. No behaviour change. Separate because it spends money and cannot be gated by CI, so it is an artifact plus a procedure rather than a check.

**PR4 — graduation.** Only after §4.7's five criteria. A `CONFIG_MIGRATIONS` entry moving only the exact shipped `false`, the registry rows deleted, the switches re-homed in the Control Center, and the `chat-capabilities.md` verdicts rewritten. Small, and it is the one PR that changes what a user gets without asking.

**The ADR (PR2).** New id from `.claude/scripts/id.ts`, `specSlug: tool-only-room-replies`. The model to copy is `260814-195522` — _"Agents may react, bounded by a rate rather than by a ban"_ — which reversed etiquette E16b's second half and kept the superseded reasoning struck through rather than deleted, because the reasoning is what the reversal had to answer. §2.6 is carried by no ADR today, so this one amends and supersedes nothing; it reverses a spec section, and the spec gets an inline amendment paragraph in the DOR-1202 house style.

---

## 9) Open questions

**All three were ruled on by the orchestrator on 2026-08-28 and are settled.** The original context is preserved below as an audit trail; each carries its Answer and Rationale. They are recorded in `02-specification.md`'s Decisions Register as D6, D7 and D15.

**Q1 — the per-turn post ceiling's number (D6).** 3 is a judgement, and `meta/agent-etiquette.md` §10 is explicit that every number in this space is unsourced and ours to set by using the product. 3 allows "on it" → answer → correction and refuses a serialised essay. ~~**Recommend 3, tune by dogfooding.**~~ Flagged because it is a mechanism that can refuse an agent mid-sentence, and the operator has set every other number in this namespace.

> **(RESOLVED — orchestrator, 2026-08-28.) Answer:** 3, as recommended — but as an **operator-tunable config value** in the `rooms.*` namespace defaulting to 3, not a bare constant. Follow the `adding-config-fields` conventions (`contributing/configuration.md`).
> **Rationale:** posting is becoming the agent's only voice, and the person who feels a wrong number must be able to move it without waiting for a release. Specified as `rooms.maxPostsPerTurn` (spec D9).

**Q2 — does `agent_declined` fire for an agent that was mentioned by another agent?** D7 says no (narrow `directlyAsked`). The counter-argument is that a person watching agent A ask agent B a question, and B doing nothing visible, is also confusing. ~~Recommend shipping narrow and widening only if a dogfood week produces a real instance~~ — the flood evidence for the wide version is measured and the confusion for the narrow one is hypothetical.

> **(RESOLVED — orchestrator, 2026-08-28.) Answer:** the recommendation stands. Ship the narrow `directlyAsked`; no notice when an agent mentions an agent.
> **Rationale:** the flood evidence is measured and the confusion is hypothetical; widening later is cheap, and the predicate is promoted to an export so the two consumers cannot drift (spec D6).

**Q3 — the aside / welcome-back turn (R8).** It is the one remaining path where a turn's text becomes a room message outside `deliver`. ~~Recommend it keeps text-as-reply~~ and that this is stated deliberately rather than left as an oversight: a welcome-back offer is the room asking a closed question on the person's behalf, four of its outcomes are already silent by design, and routing it through a tool would give it a fifth way to produce nothing.

> **(RESOLVED — orchestrator, 2026-08-28.) Answer:** the recommendation stands, recorded as settled with its reasoning.
> **Rationale:** as argued — the greeter's own posting comment is amended to say the flip does not reach here and why (spec D12).

---

## 10) Recommended next step

**SPECIFY — done, 2026-08-28** (`02-specification.md`). The design was grounded and the decisions resolved; what remained was the shape a spec fixes — the exact `deliver` branch, the `agent_declined` copy, the reply-mode plumbing through `RoomTurnResult`, the eval case list, and the ADR's argument. Two things were carried into SPECIFY:

1. **Close DOR-1212 into this item** (D1), so one behaviour has one issue. **Settled** — the orchestrator ruled DOR-1613 formally absorbs it and handles the tracker side.
2. **Confirm the DOR-1611 PR1 landing order.** DOR-1611 is now `specified` on `main`, so its D1 is fixed rather than proposed. This feature does not need the per-agent grant, but it does need `registry.invoke` to remain the single choke point both MCP surfaces pass through — which PR1 asserts with a registry-derived conformance test. If PR1 lands first, this inherits that assertion for free; if it does not, this feature should not add a second one.

Two follow-ups to file rather than absorb: **DOR-1203** (the cheap should-respond gate) becomes markedly more valuable once silence is the common outcome — **noted, not built here** (orchestrator) — and the `room-service.ts` split parked on DOR-1212 (3600+ lines), ruled **out of scope** and filed separately by the orchestrator.
