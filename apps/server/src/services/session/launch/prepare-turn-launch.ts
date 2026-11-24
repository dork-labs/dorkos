/** A failed optional context-preparation step must not cost the accepted turn its answer. */
import { logger } from '../../../lib/logger.js';
import { SessionBirthWriteError } from '../../core/runtime-seam/session-birth-write.js';
import type { TriggerTurnOpts } from '../trigger-turn.js';

/**
 * Prepare launch context best-effort. A refused required birth write stops launch.
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
    if (err instanceof SessionBirthWriteError) throw err;
    logger.warn('[turn] launch preparation failed; starting the turn as it was accepted', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
