/** Reconcile missing-path observations without treating them as file ownership. */
import { logger } from '../../../../lib/logger.js';
import { readMountTargets } from './mount-target-ledger.js';

/**
 * A path observed missing and a native "synthetic" marker do not identify the
 * inode Codex created. A person may have replaced it with an empty file, even
 * inside a recorded run's time window. Preserve every such ambiguous file.
 * No automatic removal is authorized until native creation identity is proven.
 * This read-only pass runs at startup and before each load; the renderer keeps
 * the file protected or gives the blocking-file refusal.
 */
export function reconcileMountTargets(data: string): Promise<string[]> {
  try {
    if (readMountTargets(data).length > 0)
      logger.debug('[Codex] preserving mount targets without creation identity');
  } catch {
    // An unreadable ledger cannot grant deletion authority or block other
    // turns. A renderer needing its records still validates them independently.
    logger.debug('[Codex] mount cleanup records unavailable; preserving files');
  }
  return Promise.resolve([]);
}
