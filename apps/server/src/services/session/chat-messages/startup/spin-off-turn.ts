/** First-turn evidence rides the existing runtime output watcher, never synthetic turn_start. */
import type { StreamEvent } from '@dorkos/shared/types';
import { isWaitingToStart } from '@dorkos/shared/run-time-limit';
import type { SessionStateProjector } from '../../session-state-projector.js';
import { watchNotStarted, type WatchedTurn } from '../../launch/turn-not-started.js';
import { getSpinOffStartup } from './spin-off-startup.js';

/**
 * Keep refusal detection and startup proof on the same runtime stream, following its current id.
 * Each slot-wait beat holds the first-turn clock, and the first event that is not one restarts
 * it (DOR-4985): the turn's own stream says when it is in line and when it is out.
 */
export function watchSpinOffTurn(
  source: AsyncIterable<StreamEvent>,
  projector: Pick<SessionStateProjector, 'sessionId'>
): WatchedTurn {
  async function* tapped(): AsyncIterable<StreamEvent> {
    let waiting = false;
    try {
      for await (const event of source) {
        const startup = getSpinOffStartup();
        if (isWaitingToStart(event)) {
          startup?.waitingToStart(projector.sessionId);
          waiting = true;
        } else if (waiting) {
          waiting = false;
          startup?.doneWaiting(projector.sessionId);
        }
        yield event;
      }
    } finally {
      // A turn that ends, throws or is dropped mid-wait is out of line too: the
      // clock runs again, so a launch that never got a slot is still reported.
      if (waiting) getSpinOffStartup()?.doneWaiting(projector.sessionId);
    }
  }
  return watchNotStarted(tapped(), () => getSpinOffStartup()?.started(projector.sessionId));
}
