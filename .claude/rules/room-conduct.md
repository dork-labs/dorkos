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
  and the rooms spec §5). The two ceilings in `busyWith` are not arbitration and
  the difference is worth holding: they refuse a SECOND turn for ONE agent — one
  transcript per `(room, agent)`, one working tree per agent path — and they
  never order two different agents with respect to each other.
  `standDownFallbackSeat` is not arbitration either, and the same test tells you
  why: it removes an agent nobody addressed, and never one that was. A room may
  name one member its **fallback seat** — held on `always` so a message a PERSON
  typed without addressing anybody still reaches somebody, which today is
  #team's default agent (`ensure-team-room.ts`) — and the seat steps back for a
  post that named another agent, and for any post an agent wrote, because the
  design record for that room forbids other agents consuming an addressed
  message and because a reply would otherwise put the seat straight back into
  the pile-on one cascade hop later. The two escapes keep the rule honest: the
  seat stays when it was named too, and when it is inside its own engaged
  window. **The seat is the member `rooms.fallback_seat_author_id` names, never
  "whoever holds `always`"** — a person may set any agent to "Everything" from
  the room's member menu, and that choice must keep meaning `always`, fires on
  everything, stands down for nothing. Reading the mode as the marker made
  somebody else's setting behave like this one and let the boot reconcile revert
  it. A future fallback room reuses all of this; nothing here elects a speaker.
- **Stopping is a control action and is never inferred.** The halt route
  (`POST /api/rooms/:id/halt`) and the header button reach the runtimes; nothing
  pattern-matches a message for "stop", in this phase or any later one. An
  operator typing "you are in a loop, stop" is a message a looping agent answers
  like any other (spec §10.4), which is exactly why the mechanism cannot live in
  the conversation. `room-stopped-turns.test.ts` pins the guard: a message whose
  text is "stop" runs a normal turn.
- **A refusal is visible, and so is a turn that has stopped.** A dropped trigger
  that writes no room entry is indistinguishable from a broken agent, and the
  person who notices is not the person who configured it. If you add a path that
  can decline to run a turn — or one where a turn stops producing anything and
  waits — it writes a durable room notice in the room's own voice. All eight live
  in `room-notices.ts` (`cascade_stopped`, `budget_reached`, `agent_busy`,
  `turn_failed`, `agent_gone`, `agent_unavailable`, `awaiting_approval`, `halted`),
  and every one of them is
  written through `room-notice-log.ts` — its `write` is the single writer, and
  each damping key sits beside the write it damps. Nothing outside that module
  reaches `postNotice` in production; a second call site hand-rolling its own `try` is how a
  halt in an archived room came to throw where every other notice degraded. A
  new way to go quiet earns a new code there, never a free-text line.
  `RoomNoticeCodeSchema` carries one more, `addressing_changed`, and it is
  deliberately not in that module: migration 0039 wrote it once, into every
  channel whose members it moved to `engaged`, and nothing at runtime writes it.
  `halted` is damped per room and re-armed by the next claim, so pressing Stop
  twice in a quiet room is one line. Two silences are deliberate and pinned by
  tests: an agent that ran a turn and chose to say nothing (conduct, not a
  fault), and the depth refusal against an agent's own un-provenanced post
  (nothing was triggered, and no damping key exists that would keep a notice
  from spraying).
- **An ASIDE turn is the one refusal nobody is told about, and here is the whole
  exception.** A welcome-back offer (`RoomTriggerDispatcher.askAside`,
  `welcome-back.ts`, DOR-1046) runs a turn that no message in the room triggered:
  a person came back, their agents have already posted what moved, and one of
  them is asked whether it has a next step worth a decision. Four outcomes are
  **silent** — the agent is already working, the room is out of automatic turns,
  the turn failed, the agent had nothing to offer — with no notice, no apology
  and nothing in the log but a `debug`/`warn` line. That is not a hole in "a
  refusal is visible": that rule protects somebody who ASKED and got silence, and
  here nobody asked. The person is owed the status line, and the status line is
  already posted by the time any of this runs; a notice about an extra that did
  not happen is the over-participation the rest of this file damps. It is the
  same reasoning that lets `standDownFallbackSeat` empty the target set without
  writing anything. Three things bound the exception and must stay true:
  - **`awaiting_approval` is NOT silent.** An aside turn holds a claim, so the
    room is showing the agent working; a turn parked on a person would leave that
    indicator standing with nothing to explain it. It writes the ordinary notice.
  - **A slow aside is late, never lost**, like every other turn. The answer is
    waited out to `rooms.lateReplyCeilingMinutes` and posted when it lands, so
    the indicator releases into a post rather than into nothing.
  - **The residual hole is one line wide and is logged, not hidden.** The answer
    comes back to the greeter, which posts it un-provenanced a tick after the
    claim releases — so a post the room then refuses (the agent left the room in
    between) is a release with no durable sibling. It writes
    `[rooms] a welcome-back offer was not made` and nothing else, deliberately:
    the agent is gone, and a notice in its name would be the room speaking for
    somebody who is not there.
- **Only a real wait is a refusal-shaped event.** `awaiting_approval` is the one
  notice that is not an outcome: a turn parked on a person produces nothing
  until they act, so it is reported WHILE it is true, off the turn's own event
  stream, and its damping key is scoped to the turn rather than the
  conversation. It is also **deliberately late**. A prompt must stand unanswered
  for `WAITING_NOTICE_GRACE_MS` (`room-turn-runner.ts`) before the room says
  anything, and the timer is cancelled by the resolution, by the turn ending, or
  by the turn failing. Without that grace, every gated tool call somebody
  answers in three seconds leaves a permanent "waiting for you to approve" line
  above its own answer — one per turn, in every room, forever — which is the
  over-participation the rest of this file exists to damp. The incident this
  notice was built for was twenty to forty-one minutes long; a three-second
  pause is not a story the room needs to tell.
- **An indicator releases into something durable.** The working indicator a room
  shows exists only while the dispatcher holds a claim (`room-trigger.ts`'s
  `holdClaim` / `releaseClaim`, etiquette E16a), and when it goes it may only go
  into one of four things: a post, a fresh notice, a notice already standing
  under that `(room, agent)` damping key, or the one named exception — a turn
  that ran and chose to say nothing. A release with no durable sibling, new or
  standing, is a defect. Publish `done` **after** the durable write, never
  before, so the indicator never drops ahead of the entry that explains it. Any
  path that drops a claim releases through the same seam rather than deleting
  from the map itself — RP8's halt does, and the test pinning it uses a runtime
  that IGNORES the interrupt, because a runtime that stops promptly releases
  through `runOne` anyway and would let a bypass pass unnoticed.
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
  as amended by DOR-781). `agent_gone` follows the same split for the same
  reason: damped when the member was merely SELECTED (an agent that is not
  installed any more is a state, and the most persistent one there is), never
  damped when the message typed its name. That second half needs its own route —
  a ghost claims no names, so `@ana are you there?` stores an EMPTY `mentions`
  list and the most direct question in the room would read as chatter. The
  named-but-unreachable set is resolved once at write time alongside the
  mentions (`resolveAddressing`) and handed to the dispatcher; nothing re-parses
  the text (DOR-790). Both halves are load-bearing and both have shipped
  broken — too wide sprayed apologies about agents nobody had addressed, too
  narrow answered "are you there?" with silence. `agent_unavailable` damps on
  the same `(room, agent, reason)` key as `agent_busy` and `agent_gone`, for a
  narrower reason: the one reachable cause is contention on the
  `(room, agent)` session row, which a retry — the next message — routinely
  clears, so a burst of triggers landing on the same contention gets one line
  (DOR-1206).
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
