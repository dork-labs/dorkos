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
 * @module server/services/rooms/room-notices
 */
import type { RoomEntryBody } from '@dorkos/shared/room-schemas';
import type { BudgetRefusalScope } from './turn-budget.js';

/**
 * The durable `notice` a cascade refusal writes into the room.
 *
 * @param agentName - Display name of the agent that did not reply.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 */
export function buildCascadeNotice(agentName: string, subjectAuthorId: string): RoomEntryBody {
  return {
    text: `${agentName} stopped replying here — this back-and-forth hit its automatic-reply limit. Send a message to pick it back up.`,
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
        ? 'DorkOS has used up its automatic replies for the hour, across all your rooms. They will pick up again shortly — or raise the limit in Settings.'
        : 'This room has used up its automatic replies for the hour. It will pick up again shortly — or raise the limit in Settings if this room is meant to be this busy.',
    notice: 'budget_reached',
  };
}

/**
 * The durable `notice` for a trigger that was skipped because somebody else was
 * already writing to that agent's session.
 *
 * Says the agent is occupied, not broken, and says what to do: nothing is
 * queued, so the message has to be sent again. Written once per `(room, agent)`
 * until that agent takes a turn there again, so somebody typing four messages
 * at a busy agent gets one line rather than four. The damping key deliberately
 * has no cascade in it — every message a person sends mints its own cascade
 * root, so a cascade-keyed memory would never collide and this doc would be a
 * promise the code does not keep.
 *
 * @param agentName - Display name of the agent that did not take the turn.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 */
export function buildBusyNotice(agentName: string, subjectAuthorId: string): RoomEntryBody {
  return {
    text: `${agentName} was busy with something else and did not pick this up. Send it again when ${agentName} is free.`,
    notice: 'agent_busy',
    subjectAuthorId,
  };
}

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
 * One line of somebody else's message, short enough to sit inside a sentence.
 *
 * Newlines and stray quote marks are flattened rather than escaped: this lands
 * inside a quoted clause in a markdown post, and a message containing a line
 * break or a `"` would otherwise break the line it is quoted on.
 *
 * @param message - The original text.
 */
function excerpt(message: string): string {
  const flat = message.replace(/\s+/g, ' ').replace(/"/g, '').trim();
  return flat.length <= QUOTE_LIMIT ? flat : `${flat.slice(0, QUOTE_LIMIT).trimEnd()}…`;
}
