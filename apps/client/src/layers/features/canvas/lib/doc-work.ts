/**
 * Words for a document's unfinished work, kept apart from the components so
 * every row reads the same and they are tested once.
 *
 * @module features/canvas/lib/doc-work
 */
import type { CanvasDocWorkItem } from '@dorkos/shared/canvas-doc-routes';
import { docRefusalSentence } from './doc-refusal';

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

/**
 * What to tell a person when a replay or clear was refused.
 *
 * @param error - The thrown error, carrying the server's sentence when there is one.
 */
export function workRefusal(error: unknown): string {
  return docRefusalSentence(error, 'Couldn’t change this work. Try again.');
}
