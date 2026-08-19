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

The cascade guard (depth + ancestry), the two-ceiling turn budget, the hourly
reaction ceiling (`reaction-budget.ts`), and the halt path are **mechanisms**. Do not replace any of them with an instruction in a
prompt, and do not weaken one because a prompt "already says" not to do the
thing. Block's Buzz learned this from a real 21-reply agent storm and wrote down
why:

> "'Don't get into a loop' is not a rule an agent can follow. A loop is a global
> property of a conversation; each agent sees only its own turn."

Their prompt-only fix was verified once and then observed to fail on a different
model. See ADR `260726-170127` and `research/20260727_buzz-conversational-behavior.md`.

## Invariants

- **A room that holds two or more agents holds the person too** — the three-way
  rule (ADR `260814-025326`). An agent may open a room of any kind with a
  colleague, and the owner's membership is the price. **The thing being protected
  is MEMBERSHIP, not visibility**: `seesEveryRoom` already shows the owner every
  room on the install, so nothing here is hidden from her either way. What only a
  membership carries is a read cursor — and therefore an unread count at all
  (`cursorsFor` keys on `room_members`; a non-member's count is `null`, drawn as
  no badge). Two agents in a room she is not on the roster of would talk in a row
  that never lights up. State it that way; "a conversation nobody sees" is false
  as written and will be corrected by the next reader who checks.
  It is a property of the ROSTER, checked at every verb that can change one:
  `createRoom` refuses a non-owner seeding somebody else's agent into a room the
  owner is not in, `addMember` refuses the second agent in such a room, and
  `removeMember` refuses to take the OWNER out of a room two agents share — a
  guarantee whose escape hatch is "leave afterwards" is not a guarantee. It is a
  property of those three WRITE VERBS and not of the data: a room that reached
  the forbidden shape before the rule existed keeps running and is never
  retro-refused, and nothing sweeps the table. Do not re-express it as a prompt,
  and do not add a `created_by` column to weaken it into "an AGENT-seeded pair
  needs a witness": a pair the owner seeded and then walked out of is just as
  unattended. Taking an AGENT out is never refused, so nothing is ever wedged.
- **Outside a channel, implicit addressing belongs to a PERSON's message.** A DM
  needs no `@`, which is why `direct-only` answers everything in one and why the
  DM seed is the agent's `always` default — and that is a claim about a person
  talking to their agents. A post an AGENT writes in a DM therefore addresses
  only the members it NAMES (`selectTriggerTargets`) — **every mode, not just
  `always`**: `direct-only` and `engaged` collapse to mention-only for that
  entry too. Measured before the rule existed: one "hello" in a two-agent DM cost
  four turns and two apology notices, with nobody's setting changed. This is not
  arbitration — it never chooses between two agents that were addressed, and
  never silences one that was named — and it changes nothing about a channel.
  Whatever tells an agent how it is reached must say this too
  (`room-context-block.ts`); a mechanism an agent is told the opposite of is a
  handoff that silently no-ops.
  The test is spelled `!== 'channel'`, never `=== 'dm'`: `rooms.kind` is a `text`
  column narrowed by an unchecked cast (`room-rows.ts`), so an unrecognized kind
  must take the narrower branch. That is the standing rule for every room-kind
  branch — **an unknown kind never gets more reach than a DM**, and in the one
  branch where a DM is the LOOSER side (`respondsTo`'s `direct-only`, which fires
  on everything in a real DM) it gets less: mention-only. It is also why the
  bridged-create path refuses `UNKNOWN_CHAT_TYPE` rather than falling through to
  `channel`.
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
- **A turn answers a MOMENT, not a message** (RP8, `room-collect.ts`). Messages
  for one `(room, agent)` pair gather for `rooms.collectDebounceMs`, capped at
  `rooms.collectMaxEntries`, and become ONE turn: the newest reaches the model
  as the turn's own content and the ones behind it ride `room_context.gathered`.
  One budget reservation, one claim, one cursor advance over the whole batch.
  **Gathered is not ambient, and the difference is the whole point.** They ride
  their own nonced heading, numbered, under a note saying the one reply owes
  every one of them an answer — because when they rode `pending` under "you have
  not read these yet" a live room measured exactly what that heading invites: one
  turn, three questions, an answer to the last (DOR-1231). Anything that moves
  them back into the background, or that tells the model the only message it is
  answering is the one outside the fence, restores the bug. The window
  **opens once and does not slide** — a resetting timer starves the answer for
  as long as the chatter lasts, which is the opposite of gathering it — and the
  cap closes it early rather than letting a busy room never be answered.
  A message that lands while that agent is already mid-turn HERE is **held, not
  refused**: it becomes the agent's next turn the instant the claim releases
  (`RoomCollector.resume`, hung off `releaseClaim` so no terminal can forget
  it), and it renders with `arrivedDuringPrevTurn` so the model can tell "they
  carried on talking" from "they are repeating themselves". Do not add an
  `agent_busy` line back for that case: the message IS picked up, so the line
  would be false, and `working-here` was deleted from `BusyContext` rather than
  left as dead copy.
  **The OTHER ceiling holds too, since `room-hold-when-busy`** (ADR
  `260818-234541`). An agent working in a DIFFERENT room is in a different
  checkout, so no second turn starts — but the message is kept rather than
  refused: the blocking claim's release re-arms every room waiting on that
  `agentPath` (`RoomCollector.resumeAgent`, hung off the same `releaseClaim`),
  and the first to reach `claimCollected` takes the claim while the rest park
  again. One agent's own waiting rooms run oldest-first, promotable by a person
  (`POST /:id/holds/:authorId/promote`), which orders somebody's own unanswered
  messages and never two agents. `working-elsewhere` is gone from `BusyContext`
  for the reason `working-here` went: the message IS picked up. **Do not write a
  durable line when a hold opens.** The promise lives only on the ephemeral lane
  (`state: 'held'` + `heldBehind`), which dies with the process that could keep
  it — a durable "it will pick this up" that a restart silently breaks is worse
  than the refusal it replaced. The two bounds are `rooms.collectMaxEntries` per
  batch and `rooms.lateReplyCeilingMinutes` per wait; crossing the second drops
  the wait and writes ONE past-tense `agent_busy` line, which is the only busy
  line a room ceiling still produces. Holding is not the scheduler this domain
  declined twice (ADR 260726-170125): what is stored is what the agent has not
  read yet, one turn per agent per room is still enforced, and nothing orders two
  agents against each other.
  **The claim is the only thing that may answer "is this agent busy HERE".**
  The room claim is not the only lock a room turn meets — the session it runs on
  has its own write-lock, and the dispatcher mirrors it in `inFlight`
  (`message-dispatcher.ts`) — and a second lock answering the same question is a
  second answer that can disagree. It did: the held batch is dispatched the
  instant the claim releases, which is a beat BEFORE the finished turn hands its
  in-flight slot back, so a blanket `whenBusy: 'refuse'` refused the room's own
  tail and the room posted the very apology this bullet forbids, seconds ahead of
  the answer (DOR-1230). The room asks with `whenBusy: 'refuse-foreign'` instead:
  refuse a turn ANOTHER client opened, wait out one of its own. When you add a
  lock in front of a room turn, decide which of the two questions it answers —
  "is somebody else writing to this session" is the only one that is not already
  answered here.
  **A room trigger is never a queue row, and its wait is bounded** (DOR-1242).
  Two things follow from a room trigger not being a person's words. It is not
  persisted: the durable message queue is what somebody typed and is waiting to
  say, and a row standing for a room's trigger would show up in that person's
  composer as a prompt they never wrote — and, because rows outlive the process,
  would still be there to fire days later into a conversation that ended. So a
  refusing caller gets no row at all and a restart simply forgets the trigger,
  which is the honest amount of memory for one. And when such a trigger IS
  accepted — a `refuse-foreign` waiting out its own tail — and a stranger then
  takes the session anyway, it goes back in line for what is LEFT of its original
  wait and no more. Re-arming a fresh budget each time is what made it retry once
  per lock TTL for the life of the process; when the wait is spent the plan is
  dropped once and `onSettled('failed')` fires.
  **A dropped trigger must be ACTED on, not merely reported.** The runner passes
  `onSettled` and cancels its reply collector when a dispatch settles `failed`
  having never stamped a `turn_start` — no turn ran, so there is nothing left to
  hear. Reporting alone was worse than the retry it replaced: the room would sit
  on a turn nothing would start, post "the answer will post late" at `waitMs`,
  and reach "something went wrong" at its ceiling an hour later. A turn that DID
  start and then failed carries a seq and keeps its existing path — do not cut
  that one short.
  **The guard is re-asked when a held batch finally runs**, and it has to be:
  the ancestry rule is a durable query that could not see the in-flight turn the
  batch was waiting for, and by then it can. That is what still terminates a
  two-agent ping-pong now that the claim no longer refuses outright.
- **Stopping is a control action and is never inferred.** It also drops the
  gathered messages, before it drops the claims — releasing a claim is what runs
  a held batch, so the other order would answer, one macrotask later, the very
  messages the person pressed Stop over. The halt route
  (`POST /api/rooms/:id/halt`) and the header button reach the runtimes; nothing
  pattern-matches a message for "stop", in this phase or any later one. An
  operator typing "you are in a loop, stop" is a message a looping agent answers
  like any other (spec §10.4), which is exactly why the mechanism cannot live in
  the conversation. `room-stopped-turns.test.ts` pins the guard: a message whose
  text is "stop" runs a normal turn.
  **A stopped turn posts nothing, and the room is what guarantees that, not the
  runtime.** `RoomTurnRunner.interrupt` resolving means the interrupt was
  DELIVERED; the turn's own stream still closes the ordinary way, and a model
  that had all but finished comes back with the whole answer in it. Measured on
  a live install (DOR-1232): the room wrote its one `halted` notice and posted
  that answer two seconds later, so Stop looked like it had done nothing. So the
  halt marks every dispatch it drops (`RoomTriggerDispatcher.haltedTurns`,
  synchronously, before its first `await`), and every delivery path — the
  in-frame one, the late one, the aside — throws that turn's answer away when it
  lands. It throws the NOTICES away too — both the writes and the RE-ARM:
  the `halted` line is the whole story, a `turn_failed` under it is the room
  apologising for obeying, and `notices.recovered` must not fire either, because
  that means "this agent answered, so whatever was blocking it is over" and a
  turn nobody let finish is evidence of nothing. The mark is keyed by dispatch
  and not by `(room, agent)`, because the claim is already gone by then and the
  next turn for that pair is a different dispatch that Stop said nothing about.
  What is NOT discarded is the spend — a turn that ran a model has spent, and
  `tryReserve` still has no counterpart — nor the turn's own session transcript,
  where a person can still read what it was saying.
  **A turn releases its OWN claim, never whatever holds the key.** The claim map
  is keyed `(room, agent)` and a turn is a dispatch, and a halt is the one thing
  that pulls the two apart: Stop drops the claim, the next message claims the
  same key, and the stopped turn's runtime comes back minutes later still
  believing the claim is its to release. So both turn terminals go through
  `releaseOwnClaim`, which releases only while the holder's `dispatchId` is
  still theirs; only `halt` itself releases by key, because it is stopping
  whoever holds it rather than finishing a turn. Unguarded, a halt plus one
  follow-up left the room showing nobody working while an agent was mid-answer,
  dropped the one-transcript-per-`(room, agent)` ceiling, and let the next
  message start a second concurrent turn in the same working tree — the
  contention DOR-500 measured — while the dispatch log closed out the live turn
  under the dead turn's outcome.
- **A refusal is visible, and so is a turn that has stopped.** A dropped trigger
  that writes no room entry is indistinguishable from a broken agent, and the
  person who notices is not the person who configured it. If you add a path that
  can decline to run a turn — or one where a turn stops producing anything and
  waits — it writes a durable room notice in the room's own voice. All eight
  live in `notices/notice-copy.ts` (`cascade_stopped`, `budget_reached`, `agent_busy`,
  `turn_failed`, `agent_gone`, `agent_unavailable`, `awaiting_approval`,
  `halted`), and every one of them is written through `notices/notice-log.ts` —
  its `write` is the single writer, and each damping key sits beside the write
  it damps. Nothing outside that module reaches `postNotice` in production; a
  second call site hand-rolling its own `try` is how a halt in an archived room
  came to throw where every other notice degraded. A new way to go quiet earns
  a new code there, never a free-text line. `RoomNoticeCodeSchema` carries one
  more, `addressing_changed`, and it is deliberately not in that module:
  migration 0039 wrote it once, into every channel whose members it moved to
  `engaged`, and nothing at runtime writes it. `halted` is damped per room and
  re-armed by the next claim, so pressing Stop twice in a quiet room is one
  line. Two silences are deliberate and pinned by tests: an agent that ran a
  turn and chose to say nothing (conduct, not a fault), and the depth refusal
  against an agent's own un-provenanced post (nothing was triggered, and no
  damping key exists that would keep a notice from spraying).
- **An ASIDE turn is the one refusal nobody is told about, and here is the whole
  exception.** A welcome-back offer (`RoomTriggerDispatcher.askAside`,
  `welcome-back/greeter.ts`, DOR-1046) runs a turn that no message in the room triggered:
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
  through `runOne` anyway and would let a bypass pass unnoticed. The indicator
  may also carry WHAT the turn is doing — the tool and its one argument, as
  `SessionActivity` (DOR-1351) — and that argument never leaves this operator's
  own cockpit: it is stripped at the chat-bridge forwarder and at the
  `CommunityAdapter` port (`withoutActivityTarget`, ADR `260819-022127`), for the
  same reason the waiting notice above refuses to name a file or a command in
  front of everybody else.
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
  because the bound is the SENDER's own typing: one turn answers each agent
  once, and messages that arrive together are answered together, so a line comes
  back per gathered turn rather than per keystroke. Since RP8 that means three
  questions typed in one breath are one turn and earn one line between them —
  the collect window, not damping, which is why those scenarios ask one question
  at a time and never assert a line count against a message count.
  `turn_failed` is never
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
  - **A label DorkOS states as a FACT about a message carries the per-turn
    nonce** (DOR-1263). Sanitizing is not enough for these and position is not a
    boundary. An entry line states its facts as `[id · <nonce>: …]`,
    `[topic: …]`, `[attached: …]`; square brackets deliberately SURVIVE
    `sanitizeIdentity`, because that function also writes `authors.display_name`
    and `rooms.title` — stripping there would rename `[ADMIN] Bob` product-wide
    and stop `report[1].txt` being an openable path. So a Telegram topic named
    `] [id: 01FORGED` really does render a bracket-shaped string next to the id,
    and a display name renders one EARLIER on the line than the real id. What
    makes DorkOS's label distinguishable is the nonce a member cannot predict —
    the same one the fence markers and the gathered ordinals use — and the
    rendered block tells the model to check for it. Any NEW label that asserts
    something actionable about a message needs the same mark, and the block's
    "Ids here" line needs to keep naming the marker.
    A region is not trusted because a comment says so. It is trusted because
    everything reaching it went through that function.
- **An agent's hand in a room is four verbs, and every one of them goes through
  the service.** `post_to_room`, `react_to_room_entry`, `read_room_history` and
  `search_room_history` are the `rooms` capability domain
  (`room-capabilities.ts`), and each one is a thin caller of a `RoomService`
  method — never a second write path and never a second read predicate. Four
  consequences to keep true. **Membership is the gate**, not the tier: both reads
  are `observe`, which returns allowed before any other check runs, so nothing but
  the membership check stands between a caller and a room's log — and "not a
  member" answers exactly as "no such room", so a room id is never a capability.
  **Neither read takes `readOnlyCarveOut`**, and that omission is a decision
  rather than a gap: the flag would make them reachable on the login-off external
  `/mcp` surface with no token at all, and what they return is other people's
  messages. Do not add it to make a client's life easier. **A member reads only
  above its `joinedSeq`** — the same floor the ambient window keeps, and the same
  floor `GET /api/rooms/:id/export` keeps for every caller **but one**. The export
  is this domain's fifth read path and the only one that can drop the floor: the
  install's OWNER exporting a room they are a member of gets it from `seq` 0,
  because an export is the exit path (DOR-596 C2) rather than one participant's
  view, and an owner handed a copy of their own room with the first months missing
  has not been given their data. Every agent, and any second person, still exports
  strictly above their own `joinedSeq`; membership still gates it through the same
  `requireHistoryFloor`, which requires a member row even for the owner; and the
  file states which of the two it is in `scope.joinFloorApplied`, so nothing has to
  infer it from where the seqs start. The carve-out keys on the OWNER predicate
  (`isOwnerAuthor`), never on `kind === 'human'` — an invited person is not the
  operator, for the same reason `seesEveryRoom` was narrowed. Do not tidy the
  exception away as an oversight: ADR `260815-205935` is why it is there. And
  **posting is
  channels and threads only** (spec §2.6): in a DM the reply IS the message, so
  the tool refuses there, spelled `kind !== 'channel'` like every other room-kind
  branch. An agent that posts through the tool mid-turn does not ALSO get its
  turn narration posted (`ActiveClaim.spokeViaTool`); provenance still follows the
  turn, so speaking on purpose is not a way to reset the cascade guard — and the
  mark is CONSUMED by the delivery it was set for (`takeSpokeViaTool`), because a
  claim outlives its answer under RP8's park-and-resume and a standing mark would
  swallow the next one.
  **Who is calling is resolved, never assumed.** An agent token names an agent; a
  verified `userId` names a person; neither present means the surface could name
  nobody, and on a login-on install that is a refusal (`UNIDENTIFIED_CALLER`),
  never a fallback to the owner. Falling back is how an invited person's API key
  read the owner's direct messages.
- **Agents may react, bounded by a rate** (ADR `260814-195522`, reversing
  etiquette E16b's second half). The bound is `ReactionBudget` — 20 per agent per
  room per rolling hour, recovered from the reaction rows themselves so a restart
  cannot clear it — and it is a mechanism, not a line in a prompt. **Reactions
  still never cascade**: they live outside `room_entries` and take no turn, write
  no entry, send no notice and do not move a room in the activity order. Keep it
  that way; a reaction that became an entry would be a message wearing a pill.
- **A room is not a session.** N agents in a room are N sessions on one stream.
  Nothing here may assume one runtime owns the room.

## The known gaps, so you do not re-discover them

Current as of 2026-07-31; fix them rather than working around them.

- **A restart forgets the turns a room owed but had not started.** The collect
  buffers (`room-collect.ts`) are process memory, exactly like the claim map
  beside them, and nothing persists them. A server that goes down while a
  message is gathered — or held behind a working agent — comes back with that
  message still UNREAD and no turn owed for it: it reaches the agent on the next
  turn something else triggers, rather than on its own. Nothing is lost from the
  log and nothing is shown twice; what is lost is the promptness. Making it
  durable is the scheduler this domain has declined twice
  (ADR `260726-170125`), so it needs arguing as one rather than adding a table.
  **A cross-room hold costs one thing more, and it is why the promise is
  ephemeral.** A message waiting on an agent busy elsewhere had a LINE saying an
  answer was coming; a restart forgets the hold, and the line goes with it
  because it only ever lived on the room's ephemeral stream. So the promise is
  never left standing after the machinery that could keep it is gone — which is
  the whole reason nothing durable is written when a hold opens. What the person
  is left with is an unread message and a room that no longer owes it a turn,
  and nothing on the log claiming otherwise.
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
(`entities/room/model/use-room-presence.ts`, `features/conversation/ui/LiveLane.tsx`),
and Telegram's typing indicator is driven by the turn — it starts on the turn's
first event and stops at the terminal (including a question or an approval,
where the agent is waiting on a person). The blind 60s cap that ran from message
receipt is gone; what remains is an inactivity bound, restated by every event,
so only a stream that has gone dark is cut.
