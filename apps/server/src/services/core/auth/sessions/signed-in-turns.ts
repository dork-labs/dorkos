/**
 * Signing out stops the chat turns that sign-in started (DOR-3172).
 *
 * A sign-out already closes every stream and terminal the sign-in held open
 * (`./live-connections.ts`). A chat turn is not one of those: it runs on in
 * the agent after the person's page is gone. So when a person signed in with a
 * browser session sends a chat message, the chat is registered under that
 * sign-in, and ending the sign-in (signing out, signing a device out from the
 * desk, a password reset, expiry) stops the chat's turn and drops what that
 * device still had queued.
 *
 * - **One owner per chat: the last sign-in to send.** A message sent from the
 *   desk, or from another device, takes the chat over, so signing a phone out
 *   never stops a turn somebody else started since.
 * - **Only a browser session.** A message sent with an API key, or from this
 *   computer while it asks for no password, names no sign-in to end.
 * - **Stopping a chat that already finished does nothing.** The stop is the
 *   runtime's ordinary interrupt, which answers "not running" then.
 *
 * In memory: a restart ends every turn anyway.
 *
 * @module services/core/auth/sessions/signed-in-turns
 */
import { registerLiveConnection } from './live-connections.js';

/** The sign-in that sent a chat message, as the session gate proved it. */
export interface TurnSender {
  /** Which credential proved it. Only a `cookie` names a sign-in. */
  readonly credential: 'cookie' | 'api-key';
  /** The Better Auth session id (never the token). */
  readonly sessionId?: string;
  /** The signed-in person. */
  readonly userId: string;
}

/** Each chat's current registration, by chat id: its unregister. */
const byChat = new Map<string, () => void>();

/**
 * Record who sent a chat its latest message, so ending that sign-in stops the
 * chat. A sender with no sign-in clears the chat's owner.
 *
 * @param chatId - The chat's canonical id.
 * @param sender - The gate's user for the request, if any.
 * @param stop - Stops the chat's turn and drops its queue. Called at most once.
 */
export function noteChatTurnSender(
  chatId: string,
  sender: TurnSender | undefined,
  stop: () => void
): void {
  byChat.get(chatId)?.();
  byChat.delete(chatId);
  if (sender?.credential !== 'cookie' || !sender.sessionId) return;
  const unregister = registerLiveConnection(
    sender.sessionId,
    sender.userId,
    () => {
      if (byChat.get(chatId) === unregister) byChat.delete(chatId);
      stop();
    },
    'turn'
  );
  byChat.set(chatId, unregister);
}

/**
 * Forget every chat's owner.
 *
 * @internal Tests only.
 */
export function resetSignedInTurnsForTests(): void {
  for (const unregister of byChat.values()) unregister();
  byChat.clear();
}
