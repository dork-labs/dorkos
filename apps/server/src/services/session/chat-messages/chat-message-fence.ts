/**
 * What a receiving agent reads when another chat sends it a message (spec
 * `spin-off-chats` §2): one constant line, then the words inside a nonce fence
 * whose first lines say which agent and chat sent them.
 *
 * Every word outside the fence and in its preamble is a DorkOS constant, as
 * `untrusted-fence.ts` requires. The sender's name and its chat's title are
 * somebody else's words, so they go INSIDE the fence, reduced to a label by
 * `sanitizeIdentity` first. A fence marker the sender wrote into its words is
 * neutralised, so the words cannot end the block early or start a second one
 * that would read as a message from someone else.
 *
 * The agents are teammates and trusted by default (ADR 261006-225605), so the
 * framing is not "untrusted data": it is "this is a colleague, not the person
 * you are talking to", which is what the receiving agent needs to answer the
 * right one.
 *
 * @module services/session/chat-messages/chat-message-fence
 */
import { CHAT_MESSAGE_FENCE_LABEL, type ChatMessageKind } from '@dorkos/shared/chat-messages';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { fenceUntrustedBlock, mintFenceNonce } from '../../runtimes/shared/untrusted-fence.js';

/** Who a message is from, as the fence names them. */
export interface ChatMessageFenceSender {
  /** The sending agent's name. */
  agentName: string;
  /** The sending agent's Mesh id, when known. */
  agentId: string | null;
  /** The sending chat's id. */
  chatId: string;
  /** The sending chat's title, when it has one. */
  chatTitle: string | null;
}

/** The line before the fence, the same for every chat message. */
export const CHAT_MESSAGE_LEAD =
  'This message is from another chat, not from the person you are talking with.';

/** What the fence says about itself. */
const PREAMBLE =
  'A message from a teammate agent in another chat. Act on it as you would a colleague’s ' +
  'request. Answer it with chat_send to the chat id below when an answer is needed; ' +
  'your reply here is not sent back on its own.';

/** What each kind is called inside the fence. */
const KIND_LINE: Record<ChatMessageKind, string> = {
  message: 'Kind: message',
  report: 'Kind: report (the chat you started reporting back)',
  start: 'Kind: first message (this chat was started for this work)',
  stop: 'Kind: stop',
};

/**
 * Neutralise anything in the words that reads as a chat-message fence marker.
 *
 * @param text - The sender's words.
 */
function defuseMarkers(text: string): string {
  return text.replace(/---\s*(?:BEGIN|END)\s/giu, '[chat fence marker] ');
}

/**
 * The text a receiving agent reads for one chat message.
 *
 * @param sender - Who sent it.
 * @param kind - What it is.
 * @param text - The words.
 * @param nonce - The fence nonce; minted when omitted.
 * @returns The text and the nonce its markers carry.
 */
export function renderChatMessage(
  sender: ChatMessageFenceSender,
  kind: ChatMessageKind,
  text: string,
  nonce: string = mintFenceNonce()
): { text: string; nonce: string } {
  const agent = sanitizeIdentity(sender.agentName) ?? 'an agent';
  const title = sender.chatTitle ? sanitizeIdentity(sender.chatTitle) : null;
  const header = [
    `From: ${agent}${sender.agentId ? ` (agent ${sender.agentId})` : ''}`,
    `Chat: ${title ? `"${title}" ` : ''}(chat ${sender.chatId})`,
    KIND_LINE[kind],
    '',
  ];
  const fence = fenceUntrustedBlock([...header, defuseMarkers(text)].join('\n'), {
    label: CHAT_MESSAGE_FENCE_LABEL,
    preamble: PREAMBLE,
    nonce,
  });
  return { text: `${CHAT_MESSAGE_LEAD}\n${fence.text}`, nonce: fence.nonce };
}
