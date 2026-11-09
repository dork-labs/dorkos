import { createTaggedLogger, logError } from '../../../lib/logger.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';

const logger = createTaggedLogger('Tasks');

/**
 * Record a run's runtime and verified agent before either dispatch path starts.
 *
 * `agentPath` comes from the schedule's Mesh link, never its working directory.
 * File-capped runs omit it so their changed content gets no connected apps.
 * The registry's first authoritative write wins, so a sticky run cannot replace
 * a recorded owner. A failed write leaves connected apps unavailable: their
 * authority resolver still requires the exact durable runtime and agent path.
 * Recording remains best-effort, as it was for attended runs, so a storage
 * failure does not prevent work that needs no connected apps.
 */
export async function recordRunSession(
  sessionId: string,
  runtimeType: string,
  agentPath?: string
): Promise<void> {
  // A schedule seeds no permission mode. Its power still comes from the task
  // row through ensureSession/sendMessage, including the unattended ask rules.
  await runtimeRegistry
    .persistSessionRuntime(sessionId, runtimeType, { kind: 'schedule' }, agentPath)
    .catch((err: unknown) => {
      logger.warn('could not record a task session binding', logError(err));
    });
}
