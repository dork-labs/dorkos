import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnWindow } from '../session-turn-windows.js';
import { logger } from '../../../../../lib/logger.js';

/**
 * Read a window nothing will project, so its buffer empties and its close can
 * settle. Never yields the messages anywhere: see the module doc.
 */
export async function drainUnprojected(sessionId: string, window: TurnWindow): Promise<void> {
  const census: Record<string, number> = {};
  let dropped = 0;
  let content = 0;
  try {
    for await (const message of window.messages) {
      dropped += 1;
      census[message.type] = (census[message.type] ?? 0) + 1;
      if (carriesContent(message)) content += 1;
    }
  } catch (err) {
    logger.debug('[persistent-dispatch] a runtime window failed while draining', {
      sessionId,
      err,
    });
  }
  // The two cases are genuinely different and must not read alike. A window
  // holding only a `result` and a `system` line is bookkeeping the CLI
  // volunteered — routine, and a warning about it is noise that trains people
  // to ignore the log. A window holding model speech is words a person was owed
  // and never saw, which is the DOR-1314 loss, and it says so at the level that
  // gets read.
  if (content === 0) {
    logger.debug('[persistent-dispatch] drained a content-free turn nobody asked for', {
      sessionId,
      dropped,
      census,
    });
    return;
  }
  logger.error('[persistent-dispatch] dropped model output nobody could project', {
    sessionId,
    dropped,
    content,
    census,
  });
}

/**
 * Whether an SDK message carries something a person would have read — model
 * speech or tool traffic — as opposed to the process's own bookkeeping.
 *
 * Deliberately generous: anything that is not a `result` or a `system` line
 * counts. An over-count costs one log line at the wrong level; an under-count
 * would report data loss as routine, which is the failure this exists to
 * prevent.
 *
 * @param message - One message drained from a window nothing will project
 */
function carriesContent(message: SDKMessage): boolean {
  return message.type !== 'result' && message.type !== 'system';
}
