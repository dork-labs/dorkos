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
import {
  noteChatTurnSender,
  setSignedInWorkStopper,
  type SignedInChatWork,
} from '../services/core/auth/sessions/signed-in-turns.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { cancelQueuedMessage } from '../services/session/index.js';
import { logError, logger } from '../lib/logger.js';
import { recordWroteIfPerson } from './session-touch-handler.js';

/**
 * Take back what a signed-out sign-in sent to a chat: its messages still
 * waiting, and the running turn only when one of its windows holds it. Never
 * throws: it runs inside a sign-out.
 *
 * @param chatId - The chat's canonical id.
 * @param work - What that sign-in sent there.
 */
function stopSignedInWork(chatId: string, work: SignedInChatWork): void {
  try {
    for (const messageId of work.messageIds) cancelQueuedMessage(chatId, messageId);
  } catch (err) {
    logger.warn('[Sessions] Could not remove a signed-out message', { chatId, ...logError(err) });
  }
  void runtimeRegistry
    .resolveForSession(chatId)
    .then((runtime) => {
      const holder = runtime.getLockInfo(chatId)?.clientId;
      if (holder !== undefined && work.clientIds.has(holder)) return runtime.interruptQuery(chatId);
      return undefined;
    })
    .catch((err: unknown) => {
      logger.warn('[Sessions] Could not stop a signed-out chat', { chatId, ...logError(err) });
    });
}

/**
 * Record an accepted chat message: a person wrote here, and signing out the
 * sign-in that sent it takes it back.
 *
 * @param facts - The request's facts.
 * @param accepted - The dispatch's answer: the chat's canonical id and the message's.
 * @param sessionId - The id the request named, when no canonical one came back.
 * @param clientId - The sending window's `X-Client-Id`.
 */
export function recordAccepted(
  facts: RequestFacts,
  accepted: { readonly canonicalId?: string; readonly outcome: { readonly messageId: string } },
  sessionId: string,
  clientId: string
): void {
  const chatId = accepted.canonicalId ?? sessionId;
  recordWroteIfPerson(facts, chatId);
  setSignedInWorkStopper(stopSignedInWork);
  noteChatTurnSender(chatId, facts.user, clientId, accepted.outcome.messageId);
}
