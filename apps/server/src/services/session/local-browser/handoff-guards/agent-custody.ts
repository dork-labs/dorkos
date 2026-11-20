import type { LocalBrowserHandoff } from '@dorkos/shared/local-browser';
import { logger } from '../../../../lib/logger.js';
import { LocalBrowserError } from '../errors.js';

/** Agent calls wait while the person answers this chat’s handoff. */
export function refuseAgentDuringHandoff(
  handoff: LocalBrowserHandoff | null,
  preparing: boolean,
  sessionId: string
): void {
  if (!preparing && handoff?.outcome !== null) return;
  logger.info('[Browser] Refused an agent call during a handoff', {
    handoffId: handoff?.id,
    sessionId,
  });
  throw new LocalBrowserError(
    'handed_to_person',
    'A person has the browser. Wait until they hand it back.'
  );
}
