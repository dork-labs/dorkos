/** The first message's sender stamp, using the same store as later chat messages. */
import { logError, logger } from '../../../../lib/logger.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import type { ChatCaller } from '../../../session/chat-messages/chat-message-service.js';
import { getChatMessageService } from '../../../session/chat-messages/chat-message-current.js';

/** Stamp before launch, and settle under the accepted canonical id or discard on refusal. */
export async function stampStartMessage(
  caller: ChatCaller | null,
  sessionId: string,
  prompt: string,
  messageId: string
): Promise<{ content: string; settle: (canonical: string | null) => void }> {
  const service = getChatMessageService();
  const stamp =
    caller && service ? await service.beginStart(caller, sessionId, prompt, messageId) : null;
  return {
    content: stamp?.content ?? prompt,
    settle: (canonical) => {
      if (stamp) service?.settleStart(stamp.id, canonical);
    },
  };
}

/**
 * Remove what a launch that never started left under its id. The id was minted
 * by this tool a moment ago, so nothing else can hold it; a failure to delete is
 * logged, never thrown over the refusal the caller is about to get.
 */
export async function discardUnstartedSession(sessionId: string): Promise<void> {
  try {
    await runtimeRegistry.discardSessionSettings(sessionId);
  } catch (err) {
    logger.warn('[session_start] could not remove the settings of a session that never started', {
      sessionId,
      ...logError(err),
    });
  }
}
