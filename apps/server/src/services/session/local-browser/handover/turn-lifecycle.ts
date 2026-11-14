import { onProjectorStatusChange } from '../../session-state-projector.js';
import { logger } from '../../../../lib/logger.js';
import type { BrowserHandover } from '../handover.js';

/** Normal idle completion after ask_person stays 1.4; failed/interrupted turns fall to the person. */
export function watchBrowserChatLifecycle(handover: BrowserHandover): () => void {
  return onProjectorStatusChange(({ sessionId, status }) => {
    if (status.lifecycle !== 'error' && status.lifecycle !== 'interrupted') return;
    void handover.chatEnded(sessionId).catch((error: unknown) =>
      logger.warn('[Browser] Couldn’t retain a stopped chat’s tab for the person', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  });
}
