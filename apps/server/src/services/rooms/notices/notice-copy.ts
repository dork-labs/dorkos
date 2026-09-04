/**
 * Everything the room says in its own voice.
 *
 * One module for one reason: a `notice` is the room reporting on itself, and
 * every notice has to read the same way whatever mechanism wrote it. The copy
 * lived next to the cascade guard while the guard was the only thing that could
 * decline a turn; it is not any more (a busy session and a failed turn decline
 * one too), and copy that lives inside the mechanism that happens to have been
 * written first is copy that drifts.
 *
 * The rule these all follow, from ADR 260726-170127 and the room-participation
 * spec's constraint 6:
 *
 * > A silently dropped trigger is indistinguishable from a broken agent, and in
 * > a shared room the person who notices is not the person who configured it.
 *
 * So each one says what happened, in words a person who did not configure this
 * room can act on. No reason codes in the prose, no stack traces, no jargon.
 * `room-trigger.ts` is the only writer.
 *
 * @module server/services/rooms/notices/notice-copy
 */
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { RoomEntryBody, RoomWaitingKind } from '@dorkos/shared/room-schemas';
import { MENTION_PATTERN } from '../mentions.js';
import type { BudgetRefusalScope } from '../limits/turn-budget.js';

/**
 * The durable `notice` a cascade refusal writes into the room.
 *
 * @param agentName - Display name of the agent that did not reply.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 */
export function buildCascadeNotice(agentName: string, subjectAuthorId: string): RoomEntryBody {
  return {
    text: `${agentName} stopped replying here. This back-and-forth hit its automatic-reply limit. Send a message to pick it back up.`,
    notice: 'cascade_stopped',
    subjectAuthorId,
  };
}

/**
 * The durable `notice` the room writes when it runs out of hourly budget.
 *
 * Deliberately different words from the cascade notice, because it is a
 * different thing and the person reading it needs to act differently: the
 * cascade one means "this conversation went around enough times", and one
 * message restarts it. This one means "all the automatic replying that may
 * happen for now has happened", and another message will not change that.
 *
 * @param scope - Which cap refused. The two send a reader to different
 *   settings, and saying "this room" when the whole install is out would send
 *   them to the wrong one.
 */
export function buildBudgetNotice(scope: BudgetRefusalScope = 'room'): RoomEntryBody {
  return {
    text:
      scope === 'global'
        ? 'DorkOS has used up its automatic replies for the hour, across all your rooms. They will pick up again shortly, or raise the limit in Settings.'
        : 'This room has used up its automatic replies for the hour. It will pick up again shortly, or raise the limit in Settings if this room is meant to be this busy.',
    notice: 'budget_reached',
  };
}

/**
 * What the room knows about why an agent never picked a message up.
 *
 * Two states, and each one is a different remedy for the reader, which is the
 * only reason to have more than one.
 *
 * **Neither of them asks anybody to send anything again, and there used to be
 * two that did.** `working-here` went when RP8 made a message for an agent
 * mid-turn HERE into that agent's next turn; `working-elsewhere` went the same
 * way when a message for an agent mid-turn in ANOTHER room stopped being refused
 * and started waiting (spec `room-hold-when-busy`). Both were removed for one
 * reason: a line saying "it didn't pick this one up" about a message it IS
 * picking up is the room lying to be reassuring. If a new path ever needs to
 * refuse a busy agent outright, it needs new words, not these.
 *
 * - `held-too-long` — the message DID wait, and waited past
 *   `rooms.lateReplyCeilingMinutes`, so the room stopped owing it a turn of its
 *   own. It is not lost: it sits behind the agent's read cursor and reaches the
 *   next turn as ambient context, which is what the second sentence says.
 * - `unknown` — no claim anywhere, which happens when the turn never started
 *   because another writer held the agent's session (most often the person
 *   typing into that agent directly). It cannot be held, because nothing
 *   publishes an event when a foreign session lock releases, so there is no seam
 *   to hang a resume on.
 *
 * **Neither names the other conversation**, and that is deliberate rather than
 * terse: a reader in this room may not be a member of that one, and a durable
 * line is not a way to learn which conversations somebody else is having. The
 * LIVE lane may say more, because it resolves the room per reader against the
 * rooms that reader can already see.
 */
export type BusyContext = 'held-too-long' | 'unknown';

/**
 * Every busy context there is, so the damping key can enumerate them.
 *
 * A keyed object rather than an array literal, for the reason `SILENCE_REASONS`
 * is one: `Record<BusyContext, true>` is the assertion that runs the completeness
 * way round, so adding a context without listing it here is a type error at this
 * line rather than a notice that survives its own recovery.
 */
export const BUSY_CONTEXTS = Object.keys({
  'held-too-long': true,
  unknown: true,
} satisfies Record<BusyContext, true>) as BusyContext[];

/**
 * The durable `notice` for a message that never became a turn because the agent
 * was working.
 *
 * Says the agent is occupied, not broken, and says what happens to the message
 * next. The old lines were "was busy with something else and did not pick this
 * up. Send it again when X is free" and its successor "Send it again in a few
 * minutes" — the first false in the commonest case, both un-followable, and both
 * asking a person to do work the machine could do over a message the room had
 * already committed to its log. Both variants below are past tense and end with
 * what happens without anybody retyping anything.
 *
 * @param agentName - Display name of the agent that did not take the turn.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 * @param busyWith - What the room knows it was doing, from the live claim.
 */
export function buildBusyNotice(
  agentName: string,
  subjectAuthorId: string,
  busyWith: BusyContext = 'unknown'
): RoomEntryBody {
  return {
    text: BUSY_LINES[busyWith](agentName),
    notice: 'agent_busy',
    subjectAuthorId,
  };
}

/**
 * One sentence per {@link BusyContext}, as a total map rather than a chain of
 * ternaries: a new variant that forgot its words would otherwise fall through to
 * the vaguest line in the set, which is the one it was added to stop saying.
 */
const BUSY_LINES: Record<BusyContext, (agentName: string) => string> = {
  'held-too-long': (agentName) =>
    `${agentName} has been working in another conversation for a long time, so it hasn't got to your message yet. It will read it the next time it picks up work here.`,
  unknown: (agentName) =>
    `${agentName} was busy in its own session, so it didn't answer here. It will read your message the next time it picks up work in this room.`,
};

/**
 * What an agent has stopped to wait for. All three park the turn on a person and
 * produce nothing until that person acts; they differ only in what the person
 * has to do, which is the whole content of the line the room writes.
 *
 * The names are the projector's own (`PendingInteractionDTO['type']`), so the
 * two cannot drift into meaning different things.
 *
 * An alias of the shared schema's enum since the kind became a stored field
 * (`RoomEntryBody.waitingKind`): the name every writer here already used, over
 * the one shape the entry is validated against.
 */
export type WaitingKind = RoomWaitingKind;

/**
 * The durable `notice` for a turn that has stopped and is waiting for a person.
 *
 * **This is the one the 2026-07-31 incident needed and did not have.** Agents
 * addressed in a room sat silent for up to forty-one minutes because their turns
 * had stopped on a tool-approval prompt that only their own session showed —
 * nothing in the room, nothing in the log — and each prompt auto-denied ten
 * minutes later. From inside the room, an agent waiting on a person and an agent
 * that had crashed looked exactly the same.
 *
 * So the line says two things and no more: what it is waiting for, and where to
 * go and answer it. It deliberately does NOT carry the tool name or the
 * question: those live in the session, in front of the person who can act on
 * them, and repeating them into a shared room would put one member's approval
 * decision — file paths and commands included — in front of everybody else.
 *
 * It is also deliberately LATE. The room holds its tongue for
 * `WAITING_NOTICE_GRACE_MS` first, so the approvals somebody answers in seconds
 * — nearly all of them — never leave a line behind at all. Only a real wait
 * gets one.
 *
 * `waitingKind` rides along because all three kinds share the one notice code
 * — the turn runner's damping key depends on that — so the entry could not
 * otherwise say which of them it was. Its one reader is
 * {@link bridgeWaitingText}.
 *
 * @param agentName - Display name of the agent that stopped.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 * @param kind - What sort of answer it stopped for.
 */
export function buildWaitingNotice(
  agentName: string,
  subjectAuthorId: string,
  kind: WaitingKind
): RoomEntryBody {
  return {
    text: WAITING_LINES[kind](agentName),
    notice: 'awaiting_approval',
    subjectAuthorId,
    waitingKind: kind,
  };
}

/**
 * The text a bridged chat hears for an `awaiting_approval` notice, in place of
 * the room's own line (spec `ask-entitlement` §5.4).
 *
 * Deliberately vaguer than {@link WAITING_LINES}, and by one clause: it does
 * not say "open its session", because the reader may not have one. It says
 * where the answer lives and that the wait is bounded, and nothing about what
 * is being asked — the same rule the room's line keeps (DOR-613), for a reader
 * who is further away rather than closer. No tool name, no question, no path,
 * no countdown.
 *
 * @param agentName - Display name of the agent that stopped.
 * @param kind - What sort of answer it stopped for. Absent on entries written
 *   before the field existed, which read as an approval — the commonest kind
 *   and the one whose sentence says least.
 */
export function bridgeWaitingText(agentName: string, kind: WaitingKind = 'approval'): string {
  return BRIDGE_WAITING_LINES[kind](agentName);
}

/**
 * One far-end sentence per {@link WaitingKind}, total for the same reason
 * {@link WAITING_LINES} is.
 */
const BRIDGE_WAITING_LINES: Record<WaitingKind, (agentName: string) => string> = {
  approval: (agentName) =>
    `${agentName} is waiting for someone to approve something before it can carry on. Answer it in DorkOS. It gives up if nobody does.`,
  question: (agentName) =>
    `${agentName} has a question that needs answering before it can carry on. Answer it in DorkOS. It gives up if nobody does.`,
  elicitation: (agentName) =>
    `${agentName} needs something before it can carry on. Answer it in DorkOS. It gives up if nobody does.`,
};

/**
 * One sentence per {@link WaitingKind}, total for the same reason
 * {@link BUSY_LINES} is.
 *
 * **No countdown, deliberately.** An earlier draft ended each line with "it
 * gives up after 10 minutes", read off `SESSIONS.INTERACTION_TIMEOUT_MS`. That
 * number was true of the PROMPT and false of the sentence: the room waits a
 * grace minute before writing anything (`WAITING_NOTICE_GRACE_MS`), the entry
 * then sits in a log somebody reads whenever they next look, and a line that
 * promises ten minutes to a reader who has eight is worse than one that
 * promises nothing. What a person needs is that there IS a deadline and that
 * only they can beat it, which is what these say.
 *
 * **What changed with the park.** The lines used to end "it gives up if nobody
 * does", which stopped being true: an agent now holds an unanswered prompt for
 * four hours (spec `ask-parks-on-timeout` §10). A room log read an hour later
 * must not claim a prompt is gone while the agent is still holding it, so the
 * clause became "it will wait, but not forever" — still a deadline, still only
 * yours to beat, and now true whenever it is read.
 */
const WAITING_LINES: Record<WaitingKind, (agentName: string) => string> = {
  approval: (agentName) =>
    `${agentName} is waiting for you to approve something before it can carry on. Open ${agentName}'s session to answer. It will wait, but not forever.`,
  question: (agentName) =>
    `${agentName} has a question for you before it can carry on. Open ${agentName}'s session to answer. It will wait, but not forever.`,
  elicitation: (agentName) =>
    `${agentName} needs something from you before it can carry on. Open ${agentName}'s session to answer. It will wait, but not forever.`,
};

/**
 * The durable `notice` a halt writes: somebody stopped everything running here.
 *
 * **A halt is a control action, never a message** (room-participation spec
 * §10.4). In the Hermes loop incident an operator typed "you are in a loop,
 * stop" and the bot treated it as one more conversational turn, so the verb has
 * to reach the transport rather than the model — and having reached it, it has
 * to be visible, or a room full of half-finished turns simply goes quiet with no
 * explanation. Everyone in the room sees this line, including the people who did
 * not press the button.
 *
 * @param stopped - How many in-flight turns were actually interrupted. Zero is a
 *   real and useful answer: it says the room was already idle, which is what a
 *   second press means.
 */
export function buildHaltedNotice(stopped: number): RoomEntryBody {
  return {
    text:
      stopped === 0
        ? 'Everything here was stopped. Nothing was running at the time.'
        : stopped === 1
          ? 'Everything here was stopped. One agent was working and has been interrupted; send a message to start again.'
          : `Everything here was stopped. ${stopped} agents were working and have been interrupted; send a message to start again.`,
    notice: 'halted',
  };
}

/** What a per-agent stop found when it arrived. */
export type AgentHaltOutcome = 'interrupted' | 'unstarted' | 'idle';

/**
 * The durable `notice` a per-agent stop writes: somebody stopped ONE agent here.
 *
 * Named on both sides, unlike {@link buildHaltedNotice}, and the asymmetry is
 * deliberate. The room-wide line is passive because it applies to everybody
 * including the person who pressed it. This one singles out one member of a
 * shared room, and "who did that" is the first thing a room-mate asks.
 *
 * It carries the same `halted` code as the room-wide line and is told apart by
 * `subjectAuthorId`: absent means the whole room, present names one agent. A new
 * code would not have been additive — a client pinned to the old enum fails to
 * parse any room containing a new value (`RoomNoticeCodeSchema`).
 *
 * @param personName - Display name of the person who pressed Stop.
 * @param agentName - Display name of the agent that was stopped.
 * @param subjectAuthorId - That agent's author id, so the feed can draw it.
 * @param outcome - What the stop actually found, which is what the reader needs:
 *   a turn cut short, a turn that had not started, or nothing at all.
 */
export function buildAgentHaltedNotice(
  personName: string,
  agentName: string,
  subjectAuthorId: string,
  outcome: AgentHaltOutcome
): RoomEntryBody {
  return {
    text: `${personName} stopped ${agentName}. ${AGENT_HALT_LINES[outcome](agentName)}`,
    notice: 'halted',
    subjectAuthorId,
  };
}

/**
 * The second sentence of a per-agent stop, one per outcome.
 *
 * The `idle` line speaks rather than staying silent, for the reason the
 * room-wide halt already gives: pressing Stop is a question, and silence is not
 * an answer to it.
 */
const AGENT_HALT_LINES: Record<AgentHaltOutcome, (agentName: string) => string> = {
  interrupted: (agentName) =>
    `${agentName} was working here and has been interrupted. Send a message to start it again.`,
  unstarted: (agentName) =>
    `${agentName} had not started yet, so it will not answer what was waiting. Send a message to ask again.`,
  idle: (agentName) => `${agentName} was not working here at the time.`,
};

/**
 * The durable `notice` for a turn that started and then failed, or never
 * finished at all.
 *
 * The error itself stays where it belongs — on that agent's own session stream,
 * which is where the detail is and where a person can do something about it.
 * The room gets the fact, and a pointer.
 *
 * @param agentName - Display name of the agent whose turn failed.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 */
export function buildTurnFailedNotice(agentName: string, subjectAuthorId: string): RoomEntryBody {
  return {
    text: `${agentName} ran into a problem and could not answer here. Open ${agentName}'s session to see what went wrong.`,
    notice: 'turn_failed',
    subjectAuthorId,
  };
}

/**
 * The text a bridged chat hears for a `turn_failed` notice, in place of the
 * room's own line (chats-as-channels spec §6.2).
 *
 * **`buildTurnFailedNotice`'s "Open Ana's session" is written for a cockpit
 * reader who has a session tab to open.** The person on the other end of a
 * bridged chat has no such thing — sending them that sentence points at a
 * door they cannot walk through. `ChatBridgeDelivery` renders THIS text to
 * the platform instead; the room's own entry, and the pointer it gives a
 * cockpit reader, is unchanged.
 *
 * @param agentName - Display name of the agent whose turn failed.
 */
export function bridgeTurnFailedText(agentName: string): string {
  return `${agentName} ran into a problem and couldn't answer. Try sending your message again.`;
}

/**
 * The durable `notice` for a member whose agent is no longer there.
 *
 * Deliberately not `turn_failed`, and the difference is the whole point of the
 * line. A failed turn ran, has a session behind it, and may well work next time;
 * this one never started and never will — the folder the member was added from
 * either holds no registered agent at all, or holds a DIFFERENT one whose
 * history is not this member's (ADR 260801-003051). So it points at the only
 * thing that fixes it rather than at a session that has nothing in it.
 *
 * It does not say WHICH of the two happened. From the room, "gone" and "somebody
 * else lives there now" have the same remedy, and the second would mean telling
 * every member of the room about an agent they are not in a room with.
 *
 * @param agentName - Display name of the agent that is no longer registered.
 * @param subjectAuthorId - Author id of that member, for rendering.
 */
export function buildAgentGoneNotice(agentName: string, subjectAuthorId: string): RoomEntryBody {
  return {
    text: `${agentName} isn't set up on this machine any more, so it can't answer here. Register it again, then add it back to this conversation.`,
    notice: 'agent_gone',
    subjectAuthorId,
  };
}

/**
 * The durable `notice` for a member whose conversation is pinned to a program
 * this server is not running (DOR-1720).
 *
 * **The room said "ran into a problem" for this, forever, and that was three
 * things wrong at once.** A room keeps one session per `(room, agent)` and a
 * session never changes hands (ADR-0255, DOR-764), so a runtime switched off
 * after the conversation started refuses every turn from then on — correctly,
 * because the alternative is resuming somebody's conversation on a program that
 * holds none of it. But as a `turn_failed` the reader was told an agent was
 * broken, pointed at a session with nothing in it (no turn ever started), and
 * told none of it again in words they could act on. The recovery was folklore.
 *
 * So this line names the program and both ways out. Re-enabling is the one that
 * keeps the conversation; removing and re-adding the member is the one that
 * drops the binding (`removeMember` is the only thing that does) and lets the
 * next turn start fresh on whatever the agent's manifest says now — which is
 * also how a deliberate runtime change is applied to a room already running.
 *
 * Deliberately not `agent_gone`: that agent is not installed at all, and it is
 * silent everywhere. This one is fine, is answering in every room whose session
 * runs on a program that IS up, and is stuck only here.
 *
 * @param agentName - Display name of the agent that cannot answer.
 * @param subjectAuthorId - Author id of that member, for rendering.
 * @param runtime - The runtime type the session is bound to, named for the
 *   reader through {@link runtimeDisplayName}. Undefined only if a caller ever
 *   reports this reason without one; the sentence stays grammatical and honest
 *   rather than printing an empty name, but it loses the fact worth having.
 */
export function buildRuntimeGoneNotice(
  agentName: string,
  subjectAuthorId: string,
  runtime: string | undefined
): RoomEntryBody {
  const program = runtime === undefined ? 'the app it runs on' : runtimeDisplayName(runtime);
  return {
    text:
      `${agentName} answers here through ${program}, which isn't running on this machine, so it can't reply. ` +
      `Turn ${program} back on to pick up where you left off, or remove ${agentName} from this conversation and add it back to start fresh.`,
    notice: 'runtime_gone',
    subjectAuthorId,
  };
}

/**
 * The durable `notice` for a member whose session could not be bound before a
 * turn ever started.
 *
 * **This closes the last silent trigger drop (DOR-1206).** Every other refusal
 * in this file writes a visible line; a `bindRoomSession` failure used to write
 * only a log entry, so a dropped trigger and a broken agent looked identical
 * from inside the room. The bind is a `(room, agent)` session row, and the one
 * reachable way to lose the write is database contention — usually gone by the
 * next message, which is why the words point the reader at trying again rather
 * than at a session to go and inspect (there is none yet, unlike `turn_failed`).
 *
 * @param agentName - Display name of the agent that could not be readied.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 */
export function buildAgentUnavailableNotice(
  agentName: string,
  subjectAuthorId: string
): RoomEntryBody {
  return {
    text: `${agentName} couldn't be made ready to answer here just now. Send another message to try again.`,
    notice: 'agent_unavailable',
    subjectAuthorId,
  };
}

/**
 * The durable `notice` for a member that left the room before the turn it was
 * owed ever ran.
 *
 * **This exists because the room now makes a promise it has to be able to
 * withdraw.** `POST /api/rooms/:id/entries` answers with the agents it asked to
 * reply (`PostToRoomResponse.triggered`), and a gathered message can wait the
 * best part of an hour behind an agent's other work. If the member is taken off
 * the roster in that time, the batch is dropped when it finally comes round —
 * and until this line existed that drop wrote a log entry and nothing else, so
 * from inside the room a message the product had accepted simply never got an
 * answer.
 *
 * Deliberately not `agent_gone`, and the difference matters to the reader. That
 * one says the folder holds no agent any more and points at re-registering it.
 * This agent is perfectly fine: it is still registered and still answering in
 * every other room it belongs to. It is only not a member HERE, so the remedy is
 * to add it back.
 *
 * @param agentName - Display name of the member that is no longer in the room.
 * @param subjectAuthorId - Author id of that member, for rendering.
 */
export function buildAgentLeftNotice(agentName: string, subjectAuthorId: string): RoomEntryBody {
  return {
    text: `${agentName} left this conversation before it could answer, so your message is still waiting. Add it back if you want it to pick this up.`,
    notice: 'agent_left',
    subjectAuthorId,
  };
}

/**
 * The durable `notice` for an agent that was asked, ran a turn, and chose not to
 * reply (spec `tool-only-room-replies` §D6; room-participation spec §10.2.2).
 *
 * **The ninth code, and it exists because silence became a real outcome.** Under
 * `rooms.toolOnlyReplies` a turn's words are not posted for it, so an agent that
 * decides nothing needs saying produces nothing at all. That is correct where
 * nobody asked — etiquette E7, silence must be free — and it is not correct
 * where somebody did: E1 says being asked creates an obligation, discharged
 * visibly or not at all. This line is how it is discharged when the agent
 * declines, and it is written only for a message `directlyAsked` recognises.
 *
 * **It states the fact and does not apologise.** The room is not sorry, nothing
 * is broken, and nothing is waiting on the reader — an agent with judgment is
 * the feature. What the reader needs is to know their message was read, so they
 * can ask again, ask somebody else, or let it go. "Did not reply" rather than
 * "had nothing to add", because the room does not know which of those it was and
 * the agent's own session is where the reasoning is.
 *
 * This is the floor rather than the goal: an agent with nothing useful to say
 * should post one sentence in its own voice (etiquette E21). The prompt and the
 * evals push toward that; this line guarantees the reader is never left guessing.
 *
 * @param agentName - Display name of the agent that declined.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 */
export function buildAgentDeclinedNotice(
  agentName: string,
  subjectAuthorId: string
): RoomEntryBody {
  return {
    text: `${agentName} read this and did not reply.`,
    notice: 'agent_declined',
    subjectAuthorId,
  };
}

/**
 * The durable `notice` for a second agent refused on a bridged room
 * (chats-as-channels spec §3.4, D-6 Q3).
 *
 * The one writer NOT `room-trigger.ts`: `RoomService.addMember` posts this
 * itself, before refusing the add — the same shape `addressing_changed` takes
 * for a writer outside this module. The reason is named because it is not
 * obvious: outbound consent (`canReply` / `canInitiate`) is set per BINDING,
 * and a binding names one agent. A second agent's replies would have no
 * consent switch that names them — `checkSender` would correctly deny every
 * one of them — which produces the worst shape of all: a room where one agent
 * answers into the platform chat and the other answers only into the cockpit,
 * with nothing telling either person why.
 *
 * @param agentName - Display name of the agent that was refused.
 */
export function buildBridgeSecondAgentRefusedNotice(agentName: string): RoomEntryBody {
  return {
    text: `${agentName} was not added. A bridged room can hold only one agent. The platform binding's permission to reply is set for one agent at a time, so a second agent here would have no way to answer the chat safely.`,
    notice: 'bridge_second_agent_refused',
  };
}

/**
 * The durable `notice` a room writes when `ingest` refuses an inbound message
 * past the per-chat ingest ceiling (chats-as-channels spec §5.2 step 2, A5.9).
 *
 * **`ingest` refuses; it never trims.** The room log is the audit trail this
 * feature offers in exchange for letting strangers reach a model (§9.4), and
 * dropping the oldest entry to make room for a new one would corrupt the very
 * record the ceiling exists to protect. The bound agent is already protected by
 * the turn budget's two ceilings; this one protects the log and the disk, and it
 * says so in a plain line rather than going silent — a message that vanished with
 * no explanation is the failure `.claude/rules/room-conduct.md` forbids.
 *
 * Damped by the caller per `(room, reason)`, so a sustained burst produces one
 * line, not one per refused message.
 */
export function buildBridgeRateLimitedNotice(): RoomEntryBody {
  return {
    text:
      'Messages are arriving from the chat faster than this channel can record them, ' +
      'so some were skipped here. This protects the channel; the chat itself still has them.',
    notice: 'bridge_rate_limited',
  };
}

/**
 * The durable `notice` a room writes when its bridge is switched off — the chat
 * is no longer connected (chats-as-channels spec §3.5). The room is archived
 * right after this line lands, so it is the last thing the log says: a person
 * scrolling back later reads why the conversation stopped rather than finding a
 * room that simply went quiet.
 *
 * The bridge row and every external ref survive the archive (§3.5), so a
 * re-bridge picks up exactly here; this notice does not claim the history is
 * gone, only that the live connection is.
 *
 * @param reason - The platform's own words for why, when the disconnect was not
 *   the operator's choice — the bot was blocked or removed from the chat (§10.3).
 *   Omitted for a plain operator unbridge, which needs no explanation.
 */
export function buildBridgeDisconnectedNotice(reason?: string): RoomEntryBody {
  const base =
    'This chat is no longer connected to DorkOS. Its history is kept here, and bridging it again picks up where this left off.';
  return {
    text: reason ? `${base} The chat reported: ${reason}` : base,
    notice: 'bridge_disconnected',
  };
}

/**
 * The durable `notice` a room writes when a re-bridge hands its chat to a
 * different agent (chats-as-channels spec §3.5, A3.6b). One line, three facts,
 * because all three change what the reader should expect next:
 *
 * - the new agent reads the whole log from here, including the old agent's part
 *   of it, so nothing has to be repeated for it;
 * - the old agent has left, and its own private working memory of this chat did
 *   not come with it — it was left where it was, not copied;
 * - the conversation itself is unbroken: same channel, same history, and the
 *   chat on the platform keeps talking to the same place.
 *
 * @param oldAgentName - The agent that just left the roster.
 * @param newAgentName - The agent that now answers here.
 */
export function buildBridgeAgentSwappedNotice(
  oldAgentName: string,
  newAgentName: string
): RoomEntryBody {
  return {
    text:
      `${newAgentName} now answers this chat in place of ${oldAgentName}. ` +
      `${newAgentName} can read everything said here so far, including ${oldAgentName}'s replies. ` +
      `${oldAgentName}'s own separate memory of this chat stays where it was and was not carried over. ` +
      `The channel, its history, and the chat keep going without a break.`,
    notice: 'bridge_agent_swapped',
  };
}

/**
 * The durable `notice` a room writes once when a chat is bridged, saying where
 * the conversation's earlier history lives (chats-as-channels spec §7.3).
 *
 * **The room log never gains the old messages, and this notice is where that is
 * said plainly.** The platform gives a bot no way to read past messages, and a
 * session's own transcript is runtime-owned (ADR-0310) — copying it into the
 * room log would be DorkOS asserting a record it did not witness. So the log
 * starts from the bridge, and the notice tells the reader that.
 *
 * Two variants, one code:
 *
 * - **pointer** (`priorSession: true`) — an existing session was adopted, so the
 *   earlier messages are still the agent's working memory even though they are
 *   not shown here. The agent picks the conversation up without repeating it.
 * - **pointer-less** (`priorSession: false`) — the bridge started a fresh
 *   session (there was none to adopt, or its transcript could not be verified),
 *   so this channel is the whole conversation from here on.
 *
 * @param priorSession - Whether an existing session was adopted at bridge time.
 */
export function buildBridgeHistoryNotice(priorSession: boolean): RoomEntryBody {
  const text = priorSession
    ? "This channel picks up a conversation that was already going. The earlier messages stay in the agent's own session and aren't copied here, because the platform doesn't share past messages. The agent still remembers them. This channel's record starts now."
    : "This channel starts a new conversation. The platform doesn't share past messages, so nothing said before is shown here. This channel's record starts now.";
  return { text, notice: 'bridge_history_note' };
}

/**
 * Which switch a blocked bridge delivery ran into, chosen so the notice names
 * the exact thing a person would change (chats-as-channels spec §6.6).
 *
 * - `reply_off` — a reply was refused because the connection's "Reply" switch is
 *   off (`canReply`).
 * - `initiate_off` — a message that started a conversation was refused because
 *   the connection's "Start conversations" switch is off (`canInitiate`).
 * - `lost_provenance` — an agent's answer lost the link back to the message it
 *   was answering (the server restarted mid-turn), so it was treated as a new
 *   conversation and blocked by the same "Start conversations" switch. This one
 *   gets its own words because the cause is a restart, not a setting the person
 *   chose (§6.6's dedicated copy).
 */
export type BridgeBlockedReason = 'reply_off' | 'initiate_off' | 'lost_provenance';

/**
 * The durable `notice` a room writes when a bridge delivery is refused by the
 * reply/initiate consent switches (chats-as-channels spec §6.6, A6.3, A6.4).
 *
 * **A blocked delivery is never silent.** A post that fails to reach the chat
 * with no trace is exactly the invisible failure `.claude/rules/room-conduct.md`
 * forbids, so the room says so, names the switch, and says where it lives. The
 * caller damps this per `(room, reason)`, so a run of blocked posts produces one
 * line per reason, not one per post.
 *
 * @param reason - Which switch the delivery ran into (see {@link BridgeBlockedReason}).
 */
export function buildBridgeBlockedNotice(reason: BridgeBlockedReason): RoomEntryBody {
  const text =
    reason === 'reply_off'
      ? 'This answer was not sent to the chat because replying is turned off for this connection. ' +
        'Turn on "Reply" for it in Connections › Messaging to let answers through.'
      : reason === 'initiate_off'
        ? 'This message was not sent to the chat because starting a message there is turned off for ' +
          'this connection. Turn on "Start conversations" for it in Connections › Messaging to let ' +
          'the agent reach out first.'
        : // lost_provenance — the server restarted mid-turn (§6.6).
          'This answer lost its provenance (the server restarted mid-turn) and was treated as a ' +
          'new conversation. It stayed here.';
  return { text, notice: 'bridge_blocked' };
}

/**
 * The durable `notice` a room writes when a bridge delivery exhausts its retry
 * budget without reaching the chat (chats-as-channels spec §10.1, A10.1).
 *
 * This is the visible half of the write-before-send bargain (§6.3): the safe
 * failure is a message that is missing from the chat but present here, and this
 * notice is what makes "missing" legible rather than silent. It quotes the entry
 * so a person can see which message did not land, and the caller damps it per
 * `(room, reason)` so a platform outage produces one line, not one per attempt.
 *
 * @param message - The text of the entry that could not be delivered, quoted in
 *   brief so the reader can identify it.
 */
export function buildBridgeUndeliveredNotice(message: string): RoomEntryBody {
  return {
    text:
      `This message could not be delivered to the chat after several tries, so it stayed here: ` +
      `"${excerpt(message)}". The chat itself did not receive it.`,
    notice: 'bridge_undelivered',
  };
}

/**
 * An answer that arrived after the room stopped waiting for it, saying which
 * message it belongs to.
 *
 * The alternative was cancelling the turn, and it was rejected: silence is the
 * worse failure, and somebody who waited ten minutes deserves the answer more
 * than the log deserves to be tidy. But an answer that drops into a
 * conversation which has moved on is confusing unless it says what it is
 * answering — and a timestamp alone does not, because the reader has to count
 * backwards through a conversation to find out. So it quotes the question.
 *
 * The asker's name is deliberately NOT in this line. It would have to be
 * possessive to read naturally, and the owner's own author renders as "You",
 * which makes that sentence ungrammatical for the most common case. The quote
 * identifies the message on its own.
 *
 * @param answer - What the agent finally said.
 * @param context.waitedMs - How long the answer took, trigger to reply.
 * @param context.question - The message being answered, quoted in brief.
 */
export function withLateAnswerNote(
  answer: string,
  context: { waitedMs: number; question: string }
): string {
  const minutes = Math.max(1, Math.round(context.waitedMs / 60_000));
  const ago = minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
  return `This answers the message from ${ago}: "${excerpt(context.question)}"\n\n${answer}`;
}

/** How much of the original message the late note quotes back. */
const QUOTE_LIMIT = 60;

/**
 * One line of somebody else's message, short enough to sit inside a sentence
 * and unable to address anybody.
 *
 * Newlines and stray quote marks are flattened rather than escaped: this lands
 * inside a quoted clause in a markdown post, and a message containing a line
 * break or a `"` would otherwise break the line it is quoted on.
 *
 * **The `@` sigils go with them, and that is not cosmetic.** This excerpt is
 * pasted into a real post, so every handle it carried was resolved again at
 * write time and every agent named in the original question was addressed a
 * second time — by a late answer whose whole point is that the question has
 * already been asked. One observed entry mentioned the agent that wrote it,
 * from nothing but the quote in its own prefix. The name is kept because the
 * reader needs it to recognise the message; only the address is dropped.
 *
 * {@link MENTION_PATTERN} is imported rather than restated: a second grammar
 * here could pass while the resolver disagreed, which is exactly the failure
 * being closed. `String.replace` with a global pattern resets `lastIndex` at
 * both ends, so borrowing the shared regex is safe.
 *
 * @param message - The original text.
 */
function excerpt(message: string): string {
  const flat = message.replace(/\s+/g, ' ').replace(/"/g, '').replace(MENTION_PATTERN, '$1').trim();
  return flat.length <= QUOTE_LIMIT ? flat : `${flat.slice(0, QUOTE_LIMIT).trimEnd()}…`;
}
