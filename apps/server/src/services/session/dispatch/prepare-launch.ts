import type { TriggerTurnOpts } from './trigger-turn-types.js';
import { logger } from '../../../lib/logger.js';

/**
 * Run a turn's {@link TriggerTurnOpts.prepareLaunch}, never letting it fail the
 * turn: a rejection is logged and the turn launches as it was accepted.
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
