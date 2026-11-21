/** A failed optional context-preparation step must not cost the accepted turn its answer. */
import { logger } from '../../../lib/logger.js';
import type { TriggerTurnOpts } from '../trigger-turn.js';

/**
 * Run launch-time context preparation, retaining the accepted turn when it fails.
 *
 * @param prepare - The caller's launch-time step.
 * @param sessionId - For the log line.
 */
export async function runPrepareLaunch(
  prepare: NonNullable<TriggerTurnOpts['prepareLaunch']>,
  sessionId: string
): Promise<Partial<Pick<TriggerTurnOpts, 'roomContext'>>> {
  try {
    return await prepare();
  } catch (err) {
    logger.warn('[turn] launch preparation failed; starting the turn as it was accepted', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
