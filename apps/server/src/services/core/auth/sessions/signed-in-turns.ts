/**
 * Signing out stops the chat work that sign-in started (DOR-3172).
 *
 * A sign-out already closes every stream and terminal the sign-in held open
 * (`./live-connections.ts`). A chat turn is not one of those: it runs on in
 * the agent after the person's page is gone. So when a person signed in with a
 * browser session sends a chat message, the message and the window that sent
 * it are remembered under that sign-in, and ending the sign-in (signing out,
 * signing a device out from the desk, a password reset, the sweep that notices
 * an expiry) takes back exactly that sign-in's work:
 *
 * - **Its messages still waiting in the queue are removed.** Nobody else's.
 * - **The running turn is stopped only when one of its windows holds it**
 *   (the turn's lock names the window, `X-Client-Id`). A turn started from the
 *   desk, a schedule, a room or the relay is never stopped by a phone's sign-out.
 *
 * Only a browser session names a sign-in: a message sent with an API key, or
 * from this computer while it asks for no password, records nothing.
 *
 * Bounded per sign-in ({@link MAX_CHATS_PER_SIGN_IN} chats, the oldest
 * forgotten first) and in memory: a restart ends every turn anyway.
 *
 * @module services/core/auth/sessions/signed-in-turns
 */
import { onSessionEnded } from './live-connections.js';

/** Most chats remembered per sign-in; past it the oldest is forgotten. */
export const MAX_CHATS_PER_SIGN_IN = 256;

/** Most messages remembered per chat per sign-in; past it the oldest is forgotten. */
const MAX_MESSAGES_PER_CHAT = 64;

/** The sign-in that sent a chat message, as the session gate proved it. */
export interface TurnSender {
  /** Which credential proved it. Only a `cookie` names a sign-in. */
  readonly credential: 'cookie' | 'api-key';
  /** The Better Auth session id (never the token). */
  readonly sessionId?: string;
  /** The signed-in person. */
  readonly userId: string;
}

/** One sign-in's work in one chat. */
export interface SignedInChatWork {
  /** The windows (`X-Client-Id`) that sent to the chat under this sign-in. */
  readonly clientIds: ReadonlySet<string>;
  /** The messages it sent there, oldest first. */
  readonly messageIds: readonly string[];
}

/** Takes back one sign-in's work in one chat. Must not throw. */
export type StopSignedInWork = (chatId: string, work: SignedInChatWork) => void;

interface MutableWork {
  clientIds: Set<string>;
  messageIds: string[];
}

/** Chats by sign-in, each oldest first. */
const bySignIn = new Map<string, Map<string, MutableWork>>();

let stopWork: StopSignedInWork | undefined;
let unlisten: (() => void) | undefined;

/**
 * Say how a sign-in's chat work is taken back, and start listening for
 * sign-outs. Called once by the chat routes; a second call replaces the first.
 *
 * @param stop - Removes the queued messages and stops a turn its window holds.
 */
export function setSignedInWorkStopper(stop: StopSignedInWork): void {
  stopWork = stop;
  unlisten ??= onSessionEnded(endSignedInWork);
}

/**
 * Remember an accepted chat message under the sign-in that sent it.
 *
 * @param chatId - The chat's canonical id.
 * @param sender - The gate's user for the request, if any.
 * @param clientId - The sending window's `X-Client-Id`.
 * @param messageId - The accepted message's id.
 */
export function noteChatTurnSender(
  chatId: string,
  sender: TurnSender | undefined,
  clientId: string,
  messageId: string
): void {
  if (sender?.credential !== 'cookie' || !sender.sessionId) return;
  let chats = bySignIn.get(sender.sessionId);
  if (!chats) {
    chats = new Map();
    bySignIn.set(sender.sessionId, chats);
  }
  const work = chats.get(chatId) ?? { clientIds: new Set<string>(), messageIds: [] };
  chats.delete(chatId);
  chats.set(chatId, work);
  work.clientIds.add(clientId);
  work.messageIds.push(messageId);
  if (work.messageIds.length > MAX_MESSAGES_PER_CHAT) work.messageIds.shift();
  if (chats.size > MAX_CHATS_PER_SIGN_IN) chats.delete(chats.keys().next().value!);
}

/** A sign-in ended: take back its work in every chat, then forget it. */
function endSignedInWork(sessionId: string): void {
  const chats = bySignIn.get(sessionId);
  if (!chats) return;
  bySignIn.delete(sessionId);
  for (const [chatId, work] of chats) stopWork?.(chatId, work);
}

/**
 * Forget everything, and stop listening.
 *
 * @internal Tests only.
 */
export function resetSignedInTurnsForTests(): void {
  bySignIn.clear();
  unlisten?.();
  unlisten = undefined;
  stopWork = undefined;
}
