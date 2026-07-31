---
paths: apps/server/src/services/rooms/**/*.ts, apps/client/src/layers/**/rooms/**, packages/relay/src/adapters/**/*.ts, packages/shared/src/room-schemas.ts, packages/shared/src/additional-context.ts
---

# Room Conduct: how an agent participates in a shared conversation

You are editing code that decides when an agent speaks to other people. Read
[`meta/agent-etiquette.md`](../../meta/agent-etiquette.md) before changing
behavior, and
[`specs/room-participation/02-specification.md`](../../specs/room-participation/02-specification.md)
for the mechanisms, their phasing and their tests.
[`01-ideation.md`](../../specs/room-participation/01-ideation.md) beside it holds
the reasoning and the twelve constraints that are settled; the specification is
the one to trust where they differ, because it corrects four things the ideation
got wrong about this code.

## The split that must not collapse

Two questions, and they are answered in different places by different things:

| Question                | Answered by                                             | Kind                         |
| ----------------------- | ------------------------------------------------------- | ---------------------------- |
| **Do I run a turn?**    | `addressing.ts` + `cascade-guard.ts` + `turn-budget.ts` | deterministic code, no model |
| **Do I say something?** | the model's judgment, bounded by the etiquette standard | conduct                      |

Never answer the first question with a model call, and never let the second
question be the only thing bounding cost or loops.

## Bounds are mechanisms, never prompts

The cascade guard (depth + ancestry), the two-ceiling turn budget, and the halt
path are **mechanisms**. Do not replace any of them with an instruction in a
prompt, and do not weaken one because a prompt "already says" not to do the
thing. Block's Buzz learned this from a real 21-reply agent storm and wrote down
why:

> "'Don't get into a loop' is not a rule an agent can follow. A loop is a global
> property of a conversation; each agent sees only its own turn."

Their prompt-only fix was verified once and then observed to fail on a different
model. See ADR `260726-170127` and `research/20260727_buzz-conversational-behavior.md`.

## Invariants

- **No arbitration.** Addressing three agents and getting three answers is the
  intended outcome. `responseMode` stops an agent answering when it was not
  addressed; it never orders or serializes the ones who were. Do not add a
  referee, a speaker election, or a room-scoped turn lock (ADR `260726-170125`,
  and the rooms spec §5).
- **A refusal is visible.** A dropped trigger that writes no room entry is
  indistinguishable from a broken agent, and the person who notices is not the
  person who configured it. If you add a path that can decline to run a turn, it
  writes a durable room notice in the room's own voice. All four live in
  `room-notices.ts` (`cascade_stopped`, `budget_reached`, `agent_busy`,
  `turn_failed`); a new way to go quiet earns a new code there, never a
  free-text line. `RoomNoticeCodeSchema` carries a fifth, `addressing_changed`,
  and it is deliberately not in that module: migration 0039 wrote it once, into
  every channel whose members it moved to `engaged`, and nothing at runtime
  writes it. Two silences are deliberate and pinned by tests: an agent that
  ran a turn and chose to say nothing (conduct, not a fault), and the depth
  refusal against an agent's own un-provenanced post (nothing was triggered, and
  no damping key exists that would keep a notice from spraying).
- **An indicator releases into something durable.** The working indicator a room
  shows exists only while the dispatcher holds a claim (`room-trigger.ts`'s
  `holdClaim` / `releaseClaim`, etiquette E16a), and when it goes it may only go
  into one of four things: a post, a fresh notice, a notice already standing
  under that `(room, agent)` damping key, or the one named exception — a turn
  that ran and chose to say nothing. A release with no durable sibling, new or
  standing, is a defect. Publish `done` **after** the durable write, never
  before, so the indicator never drops ahead of the entry that explains it. Any
  new path that drops a claim — RP8's halt is the next one — releases through
  the same seam rather than deleting from the map itself.
- **A slow turn is late, never lost.** The room's wait deadline bounds the WAIT,
  never the turn. An answer that outruns it is posted when it lands, saying how
  long it took. Never post a fragment of an unfinished answer as though it were
  the whole thing (DOR-621).
- **Context injection is structured** (ADR-0273). Room framing belongs in an
  `additionalContext` entry with its `CONTEXT_TAG`, never concatenated into
  `content`. `content` stays exactly what the human wrote.
- **Mentions resolve once, at write time**, and the resolved ids are stored. Never
  re-parse an entry's text at render or trigger time: renaming an agent must not
  re-address a message sent yesterday. **Quoted text addresses nobody** —
  blockquote lines, fenced blocks and inline code are removed before matching
  (`mentions.ts`), because a message somebody re-states is a citation, not an
  address. The room's own late-answer prefix quotes the question it answers, and
  without this it re-addressed everyone that question named, including the agent
  writing it (DOR-781).
- **Damping is aimed at repeats nobody asked for, never at a person's question.**
  A busy refusal is damped on `(room, agent, reason)` for triggers that were not
  directed at that agent — an agent's reply re-triggering a colleague, and the
  ordinary chatter that reaches an `engaged` agent inside its window, which is
  the channel default. It is **never** damped when the triggering message asked
  that agent: a human author at `cascadeDepth: 0` whose entry names the agent in
  its stored `mentions`, or any human message in a DM, where naming is implicit.
  A direct question deserves a direct answer, and the count cannot run away
  because the bound is per ADDRESSED message and the sender is the one
  addressing — one dispatch triggers each agent once, so a person gets back
  exactly as many lines as they wrote messages naming it. `turn_failed` is never
  damped at all: each error is a distinct event (room-participation spec §5.2,
  as amended by DOR-781). Both halves are load-bearing and both have shipped
  broken — too wide sprayed apologies about agents nobody had addressed, too
  narrow answered "are you there?" with silence.
- **Other members' text is untrusted input.** Anything another person wrote that
  lands in an agent's context is a prompt-injection surface. Two regions, and
  which one a value belongs in is decided by what the value IS, never by where it
  is convenient to put it:
  - **Somebody's words go inside the fence** (`room-context-block.ts`), whose
    per-turn nonce is the boundary. Message bodies, and a thread's opening
    message — an excerpt of a message is still a message.
  - **Labels may sit outside it** — names, handles, topics — and only after
    `sanitizeIdentity` from `@dorkos/shared/untrusted-text`, which strips every
    angle bracket and control character. Do not write a second sanitizer; the
    second copy is the one that misses NEL.
    A region is not trusted because a comment says so. It is trusted because
    everything reaching it went through that function.
- **A room is not a session.** N agents in a room are N sessions on one stream.
  Nothing here may assume one runtime owns the room.

## The known gaps, so you do not re-discover them

Current as of 2026-07-31; fix them rather than working around them.

- No room is bridged to a chat platform. Room presence reaches the cockpit
  (`RoomService.publishSignal` → the room's event stream) and stops there. The
  Telegram adapter keeps a signal seam for it (`handleTypingSignal`), but
  nothing publishes into it yet, so a Telegram chat cannot show a room's
  working state — build the bridge rather than a second indicator.

Four gaps that were listed here are gone, so nothing should be written around
them any more: Telegram drops messages from other bots
(`isBotSender` in `adapters/telegram/inbound.ts`, with a carve-out for a human
posting as an anonymous group admin), the room composer has a mention picker
(`features/mentions`), a room shows an in-flight working indicator
(`entities/room/model/use-room-presence.ts`, `widgets/room-view/ui/RoomPresenceLine.tsx`),
and Telegram's typing indicator is driven by the turn — it starts on the turn's
first event and stops at the terminal (including a question or an approval,
where the agent is waiting on a person). The blind 60s cap that ran from message
receipt is gone; what remains is an inactivity bound, restated by every event,
so only a stream that has gone dark is cut.
