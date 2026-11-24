/**
 * The one-time note owed to a session's next turn when DorkOS ended the Claude
 * Code process its timers lived in (DOR-3755).
 *
 * ## Why this exists
 *
 * A session timer an agent sets (CronCreate, ScheduleWakeup, /loop) lives in
 * its Claude Code process. When DorkOS ends that process while one is pending,
 * to make room for another chat, at the four-hour ceiling or on a record
 * sweep, nothing runs the chat again until its next turn, and a timer due in
 * between never fires. Claude Code's own resume notice covers a past-due
 * ScheduleWakeup but not a one-shot CronCreate. No wake follows on purpose: a
 * chat holding a `/loop` would be relaunched for ever. The next turn carries
 * this note instead.
 *
 * ## Its own slot, beside the cutoff note
 *
 * Held in memory and keyed by the primary session id, on the same terms as the
 * cutoff note (`turn-cutoff.ts`), but in a slot of its own and rendered as a
 * block of its own. Both can be owed at once: the stall guard interrupts a
 * quiet turn, a Stop hook does not run after an interrupt, so the timer count
 * from the turn before stays, and a reclaim then takes the process. Sharing
 * one slot let the later note replace the earlier, and the agent heard only
 * one of the two.
 *
 * @module services/session/turn-cutoff/timers-stopped
 */
import type { AdditionalContext, TimersStoppedData } from '@dorkos/shared/additional-context';
import { primaryOf } from '../resolution/session-key-registry.js';

/** Notes owed to each session's next turn, keyed by primary session id. */
const owed = new Map<string, TimersStoppedData>();

/**
 * The note the agent's next turn carries, rendered by every runtime.
 *
 * Says only what is certain: nothing ran in the chat between the process
 * ending and this turn, so a timer due in that gap did not fire. The count is
 * what the CLI named pending at the last turn end, which is not always now.
 * Claude Code may set a timer that is not due yet up again when it resumes,
 * so the note never says every one of them is gone.
 *
 * @param data - How many timers were named pending, and when the process ended.
 */
export function formatTimersStopped(data: TimersStoppedData): string {
  const timers = data.timers === 1 ? 'A session timer' : `${data.timers} session timers`;
  return (
    `${timers} you set (CronCreate, ScheduleWakeup or /loop) ` +
    `${data.timers === 1 ? 'was' : 'were'} pending at your last turn end. DorkOS ended ` +
    `this chat's Claude Code process at ${new Date(data.at).toISOString()}, and nothing ran ` +
    'here after that, so a timer due before this message did not fire. Check what you were ' +
    'waiting on, and set it again if you still need it.'
  );
}

/**
 * Record that DorkOS ended a process with session timers pending, so the
 * session's next turn is told. A second note before that turn replaces the
 * first: it carries the later count and time.
 *
 * @param sessionId - Any id the session is known by.
 * @param data - How many timers were named pending, and when the process ended.
 */
export function noteTimersStopped(sessionId: string, data: TimersStoppedData): void {
  owed.set(primaryOf(sessionId), data);
}

/**
 * Take the note owed to this session's next turn, if any. Taken, not peeked,
 * so it rides exactly one dispatch.
 *
 * @param sessionId - Any id the session is known by.
 */
export function takeTimersStopped(sessionId: string): TimersStoppedData | null {
  const key = primaryOf(sessionId);
  const data = owed.get(key);
  if (data === undefined) return null;
  owed.delete(key);
  return data;
}

/**
 * Take the note owed to this session's next turn into that turn's context, as
 * a `timers_stopped` block of its own. Returns what it took, so a dispatch that
 * never starts can hand it back with {@link restoreTimersStopped}.
 *
 * @param bag - The turn's context.
 * @param sessionId - Any id the session is known by.
 */
export function takeTimersStoppedForTurn(
  bag: AdditionalContext,
  sessionId: string
): TimersStoppedData | null {
  const data = takeTimersStopped(sessionId);
  if (data !== null) bag.push({ kind: 'timers_stopped', scope: 'per-turn', data });
  return data;
}

/**
 * Hand back a note a dispatch took but never delivered, unless a newer one has
 * been noted since.
 *
 * @param sessionId - Any id the session is known by.
 * @param data - The note that was taken.
 */
export function restoreTimersStopped(sessionId: string, data: TimersStoppedData): void {
  const key = primaryOf(sessionId);
  if (!owed.has(key)) owed.set(key, data);
}

/**
 * Drop a session's owed note, for a session that is going away.
 *
 * @param sessionId - Any id the session is known by.
 */
export function forgetTimersStopped(sessionId: string): void {
  owed.delete(primaryOf(sessionId));
}

/** Clear every owed note. For tests. */
export function resetTimersStopped(): void {
  owed.clear();
}
