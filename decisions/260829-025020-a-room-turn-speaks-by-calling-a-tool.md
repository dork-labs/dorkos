---
id: 260829-025020
title: A room turn speaks by calling a tool, in every room kind — including DMs
status: accepted
created: 2026-08-29
spec: tool-only-room-replies
superseded-by: null
amends: null
---

# 260829-025020. A room turn speaks by calling a tool, in every room kind — including DMs

## Status

Accepted, behind `rooms.toolOnlyReplies`, which ships OFF and graduates on evidence.

It reverses one section of a frozen spec — `specs/room-participation/02-specification.md` **§2.6**,
"posting is channels and threads only" — and reverses nothing else in it. §10.2 designed this flip
in full on 2026-07-28 and DOR-1202 deferred it; this delivers that design and goes past it in the
one place §2.6 stands in the way.

## Context

Today a room turn's text **is** the room message: whatever the model narrated back to its own
session gets posted, automatically, into the room that triggered it (`room-trigger.ts`'s
`deliver`). Three things a competent colleague does are therefore impossible.

- **It cannot decline.** `meta/agent-etiquette.md` E4 says speak only when the contribution clears
  a bar; today every triggered turn clears it by construction.
- **It cannot think privately.** Deliberation lands in front of everybody, which is the
  over-participation E1–E18 exist to damp.
- **It cannot let a reaction be the answer.** `meta/chat-capabilities.md` A-06 records the
  measured failure: _"having reacted, the agent still wrote 'Done — release notes acknowledged.',
  and a room turn's text is posted."_ Three rounds of prompt fixes did not close it, and the row
  concluded it was _"model-tuning territory, not a missing instruction."_

**It is neither.** `.claude/rules/room-conduct.md` states the governing principle: _"Bounds are
mechanisms, never prompts."_ "Only speak when it matters" is a prompt. An unmade tool call is a
mechanism.

§2.6 carved DMs out of §10.2's design on 2026-07-28, on two claims that were true when written:

> In a DM the reply **is** the message… Two behaviors is the honest cost of the DM case already
> being correct. Making the DM case go through a tool would add a way for it to fail and buy
> nothing.

## Decision

**Under `rooms.toolOnlyReplies`, a turn's text is never posted.** The agent answers by calling
`post_to_room`, puts a reaction on a message, or deliberately says nothing — **in channels and in
direct messages alike**.

`post_to_room`'s DM refusal is **conditioned on the resolved reply mode rather than removed**. In
text mode it fires exactly as it does today; in a tool-only turn it does not. It keeps the
`!== 'channel'` spelling, because `rooms.kind` is a text column narrowed by an unchecked cast and
an unknown kind never gets more reach than a DM.

Four things travel with it, and each is a mechanism rather than an instruction:

- **A durable floor on silence.** A person who ASKED and got nothing gets one `agent_declined`
  line in the room's own voice — "Ana read this and did not reply." Ambient silence writes nothing
  durable, ever. The split is §10.2.2's and the predicate is `directlyAsked`, promoted to an export
  rather than copied.
- **A reaction discharges the obligation.** A landed reaction is an answer; one the hourly budget
  or the stop mark refused is not, because it put nothing in front of anybody.
- **A per-turn post ceiling**, `rooms.maxPostsPerTurn`, default 3. Posting becomes the agent's only
  voice, and nothing else bounds how often it uses it.
- **Reply mode resolves per turn and fails OPEN** — see below.

## Why §2.6's argument no longer holds

_"The DM case is already correct"_ was correct for **answering**, the only outcome that then
existed. It was never correct for declining or reacting, because neither was reachable: an agent in
a DM could not say "seen 👍" and stop, and could not think without broadcasting.

_"Two behaviours is the honest cost"_ understates it. The cost is no longer two behaviours — it is
two behaviours that **disagree about what silence means**. Flag-ON, a channel turn that says
nothing is a choice and a DM turn that says nothing is a bug, and the agent has to hold both models
at once from one prompt that must state them both. That is a worse failure than the one §2.6 was
avoiding, and it is the instruction-drift risk the spec's §D11 enumerates across nine prompt
strings.

_"Adds a way for it to fail"_ remains **true**, and it is the honest price. The answer is not two
paths. It is E1 stated where the agent reads it ("in a direct message with a person, answering is
not optional"), the `agent_declined` floor, and an eval that measures DM answer-rate with a
mutation drill proving it can go red.

## Why fail-open, and why the polarity is the opposite of DOR-1611's

The flag is **not** read as "suppress the text". It is read as: _suppress the text only where this
session is known to be able to post._

DOR-1611's per-identity grant is a security boundary asking a positive question, where dropping a
credential must strictly narrow. This asks a **delivery** question, and its two errors are not
symmetric:

- Fail closed → the agent is silently mute. `room-conduct.md` constraint 6: **silence is the worse
  failure**.
- Fail open → a turn's text posts that the agent might not have chosen to post. Untidy, visible,
  recoverable.

Two reachable states make this load-bearing rather than theoretical. `/mcp` sits behind
`requireMcpEnabled`, so `mcp.enabled = false` plus the flip would mute every codex and opencode
agent in every room; and agent tokens expire on a 7-day-idle / 30-day-absolute fuse, reaching the
same state on a timer. Nothing about permission is decided here — the agent could always post; this
decides only whether DorkOS **also** posts for it.

## Why this does not weaken the bounds

The flip strictly **reduces** entries, and therefore cascade fuel. Provenance is unchanged: a
mid-turn tool post inherits the turn's stamp through `activeTurnFor`, and an un-provenanced one is
stamped at the ceiling — spent on arrival, triggering nobody. The one new volume vector, a turn
posting N times, is answered by a mechanism (`rooms.maxPostsPerTurn`) rather than by a prompt.

## Why the DM reversal is safe

**The loop protection already exists, and was built for another reason** — ADR `260814-025326`,
after one "hello" in a two-agent DM cost four turns and two apology notices. `selectTriggerTargets`
reads `impliesEveryone = roomKind === 'channel' || authorKind === 'human'`:

- Agent → DM with a **person**: `impliesEveryone` is false, and the person is filtered by
  `member.kind === 'agent'`. Selects `[]`. **A reply-to-a-human-DM loop is structurally
  impossible.**
- Agent → DM with an **agent**: triggers only on a stored `mentions` hit — identical to today's
  behaviour when the turn's text posts. No new reach.

## Consequences

### Positive

- A-06 closes by mechanism. An acknowledgment can be a reaction and nothing else.
- An agent can think in a room without the thinking landing in the room.
- Standing down becomes representable, so E4 and E7 stop being prompts nothing can check.
- Every reply gains an answer pointer and a session link, which a tool post never carried.

### Negative

- **A new way for a reply to go missing.** An agent that forgets to call the tool says nothing.
  The `agent_declined` line makes that visible where somebody asked; it is a floor, not a fix.
- §10.2.1's runtime constraint dissolves, which is a good thing and also a wider blast radius:
  three runtimes now carry a behaviour one used to.
- `room-conduct.md` gains a fifth permitted indicator release and re-argues its named silence
  exception. In practice that exception gets **narrower**, not wider — the opposite of what a
  reader assumes from a feature called "silence by default".
- The obligation to be visible moves from "the turn always speaks" to "the turn speaks, reacts, or
  the room says it did not", which is a strictly larger surface to keep correct.

### Neutral

- The welcome-back offer keeps text-as-reply, deliberately: it is the room asking a closed question
  on the person's behalf, four of its outcomes are already silent by design, and routing it through
  a tool would give it a fifth way to produce nothing.

## Alternatives rejected

- **A `NO_REPLY` sentinel token.** A thing a model can rationalise past, where an unmade tool call
  is not (§10.2).
- **Keeping DMs on text-as-reply.** The two-models-of-silence problem above; it is the failure §2.6
  was trying to avoid, arrived at from the other side.
- **Making the flip claude-code-only.** It would make judgment a runtime privilege and leave A-06
  open for two of three runtimes.
- **Failing closed on unknown tool-capability.** It converts a wiring gap into a mute agent, and
  silence is the worse failure.

## Related

- `260814-025326` — an agent's post outside a channel addresses only whom it names. **Held
  unchanged, and it is what makes the DM reversal safe.**
- `260814-195522` — agents may react, bounded by a rate. The model for this ADR's shape, and the
  decision that makes "a reaction is the answer" reachable at all.
- `260726-170127` — the room path carries its own cascade guard. Constrains the post ceiling: a
  bound is a mechanism.
- `260726-170125` — no arbitration in rooms. Untouched; nothing here elects a speaker.
- ADR-0310 — runtime-owned session storage. Why reply mode is per session, not per membership.
- ADR-0273 — structured context injection. Governs the mode-aware instruction lines.
