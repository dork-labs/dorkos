/**
 * What an accepted chat message records about who sent it: that a person
 * wrote here (spec `your-activity-first` D4), and which sign-in sent it, so
 * signing that device out stops the chat (DOR-3172). The second is the chat
 * route's half of `services/core/auth/sessions/signed-in-turns.ts`, which
 * holds the registry and the rules; this half knows how to stop a chat.
 *
 * @module routes/session-message-accepted
 */
import type { RequestFacts } from '../http/request-facts.js';
import { noteChatTurnSender } from '../services/core/auth/sessions/signed-in-turns.js';
import { recordWroteIfPerson } from './session-touch-handler.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { clearQueuedMessages } from '../services/session/index.js';
import { logError, logger } from '../lib/logger.js';

/**
 * Stop a chat whose sender signed out: drop its queue, then interrupt its
 * turn, as Stop does. A chat that already finished answers "not running".
 * Never throws: it runs inside a sign-out.
 *
 * @param chatId - The chat's canonical id.
 */
function stopChatForSignOut(chatId: string): void {
  clearQueuedMessages(chatId);
  void runtimeRegistry
    .resolveForSession(chatId)
    .then((runtime) => runtime.interruptQuery(chatId))
    .catch((err: unknown) => {
      logger.warn('[Sessions] Could not stop a signed-out chat', { chatId, ...logError(err) });
    });
}

/**
 * Record an accepted chat message: a person wrote here, and the sign-in that
 * sent it now owns the chat until someone else sends to it.
 *
 * @param facts - The request's facts.
 * @param chatId - The chat's canonical id.
 */
export function recordAccepted(facts: RequestFacts, chatId: string): void {
  recordWroteIfPerson(facts, chatId);
  noteChatTurnSender(chatId, facts.user, () => stopChatForSignOut(chatId));
}
