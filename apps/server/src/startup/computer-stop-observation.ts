import type { ComputerStatus } from '@dorkos/shared/computer-schemas';
import { logger } from '../lib/logger.js';

/** A stopped UI projection must not conceal unconfirmed physical cleanup. */
export function reportComputerStop(status: ComputerStatus, reason: 'disable' | 'shutdown'): void {
  if (status.phase === 'uncertain' || status.error?.code === 'cleanup-uncertain') {
    logger.warn('[Computer] physical stop unconfirmed', {
      reason,
      phase: status.phase,
      generation: status.generation,
      code: status.error?.code ?? 'cleanup-uncertain',
    });
  }
}
