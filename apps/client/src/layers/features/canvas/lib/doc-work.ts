/**
 * Words for a document's unfinished work, kept apart from the components so
 * every row reads the same and they are tested once.
 *
 * @module features/canvas/lib/doc-work
 */
import type { CanvasDocWorkItem } from '@dorkos/shared/canvas-doc-routes';

/** A piece of work's state as a short status word. */
export function workStatusLabel(status: CanvasDocWorkItem['status']): string {
  return status === 'expired' ? 'Never started' : 'May have run';
}

/** One line saying what happened to the work. */
export function workStatusDetail(status: CanvasDocWorkItem['status']): string {
  return status === 'expired'
    ? 'It waited a day and never started.'
    : 'It reached the agent, but its result is unknown.';
}

/** Why the work can't run again right now, or null when it can. */
export function workReplayBlocked(item: CanvasDocWorkItem): string | null {
  switch (item.replay) {
    case 'ready':
      return null;
    case 'no_grant':
      return 'This route is off. Allow it to run this again.';
    case 'route_changed':
      return 'The route changed, so this can’t run again.';
    case 'inputs_gone':
      return 'Some of its events are no longer kept.';
    case 'still_running':
      return 'It may still be running. Check back once it stops.';
    case 'route_busy':
      return item.status === 'in_doubt'
        ? 'Newer work is waiting behind this. Clear it to continue.'
        : 'Newer work is waiting on this route. Try again after it runs.';
  }
}

/** How many events, in words. */
export function workEventCount(count: number): string {
  return `${count} ${count === 1 ? 'event' : 'events'}`;
}

/** What the trigger says: how many pieces wait on the person. */
export function workSummary(count: number): string {
  return `${count} to review`;
}

const NOT_A_PERSON = 'Only a signed-in person can change this.';
const STALE = 'This work changed. The list is up to date now.';
const REFUSALS: Record<string, string> = {
  WORK_ALREADY_REVIEWED: 'This was already run again or cleared.',
  WORK_STILL_RUNNING: 'It may still be running. Try again once it stops.',
  WORK_NOT_FOUND: STALE,
  WORK_NOT_REVIEWABLE: STALE,
  CONFIRM_REPEAT_REQUIRED: 'Confirm before running this again.',
  GRANT_REQUIRED: 'This route is off. Allow it first.',
  GRANT_REVOKED: 'This route is off. Allow it first.',
  GRANT_EXPIRED: 'This route’s approval ended. Allow it again first.',
  MANIFEST_CHANGED: 'The document’s app changed. Allow the route again.',
  ROUTE_CHANGED: 'The route changed, so this can’t run again.',
  INPUTS_GONE: 'Some of its events are no longer kept.',
  ROUTE_BUSY: 'Newer work is waiting on this route.',
  AGENT_CANNOT_DECIDE: NOT_A_PERSON,
  REQUESTER_CANNOT_DECIDE: NOT_A_PERSON,
  PERSON_REQUIRED: NOT_A_PERSON,
  operator_cookie_required: NOT_A_PERSON,
  AUTH_REQUIRED: 'Sign in to change this.',
};

/**
 * What to tell a person when a replay or clear was refused.
 *
 * @param error - The thrown error, carrying the server's `code` when there is one.
 */
export function workRefusal(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && REFUSALS[code]) return REFUSALS[code];
  if (error instanceof TypeError) return 'Couldn’t reach DorkOS. Check your connection.';
  return 'Couldn’t change this work. Try again.';
}
