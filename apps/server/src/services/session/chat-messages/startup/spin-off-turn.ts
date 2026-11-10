/** First-turn evidence rides the existing runtime output watcher, never synthetic turn_start. */
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionStateProjector } from '../../session-state-projector.js';
import { watchNotStarted, type WatchedTurn } from '../../launch/turn-not-started.js';
import { getSpinOffStartup } from './spin-off-startup.js';

/** Keep refusal detection and startup proof on the same runtime stream, following its current id. */
export function watchSpinOffTurn(
  source: AsyncIterable<StreamEvent>,
  projector: Pick<SessionStateProjector, 'sessionId'>
): WatchedTurn {
  return watchNotStarted(source, () => getSpinOffStartup()?.started(projector.sessionId));
}
