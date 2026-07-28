---
paths: apps/server/src/services/rooms/**/*.ts, apps/client/src/layers/**/rooms/**, packages/relay/src/adapters/**/*.ts, packages/shared/src/room-schemas.ts, packages/shared/src/additional-context.ts
---

# Room Conduct: how an agent participates in a shared conversation

You are editing code that decides when an agent speaks to other people. Read
[`meta/agent-etiquette.md`](../../meta/agent-etiquette.md) before changing
behavior, and [`specs/room-participation/01-ideation.md`](../../specs/room-participation/01-ideation.md)
for the mechanisms and their rationale.

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
  writes a durable room notice in the room's own voice.
- **Context injection is structured** (ADR-0273). Room framing belongs in an
  `additionalContext` entry with its `CONTEXT_TAG`, never concatenated into
  `content`. `content` stays exactly what the human wrote.
- **Mentions resolve once, at write time**, and the resolved ids are stored. Never
  re-parse an entry's text at render or trigger time: renaming an agent must not
  re-address a message sent yesterday.
- **Other members' text is untrusted input.** Anything another person wrote that
  lands in an agent's context is a prompt-injection surface. Render it as fenced
  untrusted data, never as instructions.
- **A room is not a session.** N agents in a room are N sessions on one stream.
  Nothing here may assume one runtime owns the room.

## The known gaps, so you do not re-discover them

Current as of 2026-07-27; fix them rather than working around them.

- A busy session drops the trigger with a log line and **no room entry**
  (`room-turn-runner.ts`), which violates the visible-refusal invariant above.
- `composeRoomPrompt` gives the agent one message and no roster, no history, and
  no indication of who is a person and who is a machine.
- The room composer has **no mention autocomplete at all**; resolution is a regex
  over whatever was typed.
- Telegram's adapter has no `is_bot` filter and answers every message in every
  group. Two bots in one group is an unbounded loop.
