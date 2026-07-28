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
 * queued, so the message has to be sent again. Written once per agent per
 * cascade like every other refusal, so a burst of messages at a busy agent
 * produces one line rather than a burst of apologies.
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
    text: `${agentName} ran into a problem and could not answer here. Open the ${agentName} session to see what went wrong.`,
    notice: 'turn_failed',
    subjectAuthorId,
  };
}

/**
 * An answer that arrived after the room stopped waiting for it, with the delay
 * said out loud.
 *
 * The alternative was cancelling the turn, and it was rejected: silence is the
 * worse failure, and somebody who waited ten minutes deserves the answer more
 * than the log deserves to be tidy. But an answer that drops into a
 * conversation which has moved on is confusing unless it says which message it
 * belongs to, so it says so.
 *
 * @param text - What the agent finally said.
 * @param waitedMs - How long the answer took, from the trigger to the reply.
 */
export function withLateAnswerNote(text: string, waitedMs: number): string {
  const minutes = Math.max(1, Math.round(waitedMs / 60_000));
  const ago = minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
  return `This answers a message from ${ago}.\n\n${text}`;
}
