/**
 * Messages one chat sends another (spec `spin-off-chats`, ADR 261009-171114):
 * the wire shapes the app draws "From <agent> · <chat>" and the Sent card
 * from, the tool names that render as conversation rather than tool calls, and
 * the fence the receiving agent reads the words in.
 *
 * ## Who sent a message is the server's answer, never the text's
 *
 * The receiving agent reads the words inside a nonce fence
 * ({@link CHAT_MESSAGE_FENCE_LABEL}). The fence is for the MODEL: it tells it
 * the words came from another chat and not the person. The app never trusts
 * it. A sender is shown only from a {@link ChatMessageStamp} the server
 * attached after matching the fence's nonce to its own record of the send, so
 * somebody who types a fence by hand gets plain text, not a forged sender.
 *
 * @module shared/chat-messages
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** The tool a chat sends another chat a message with. */
export const CHAT_SEND_TOOL = 'chat_send';
/** The tool a chat reads another chat with. */
export const CHAT_READ_TOOL = 'chat_read';
/** The tool a chat stops another chat's running turn with. */
export const CHAT_STOP_TOOL = 'chat_stop';
/** The tool a chat starts a spin-off chat with. */
export const SESSION_START_TOOL = 'session_start';

/**
 * The tools whose calls are conversation, not tool use: the app renders them
 * as a Sent card, never hides them with tool calls, and never folds them into a
 * tool group (spec `spin-off-chats` §6).
 */
export const MESSAGING_TOOL_NAMES: ReadonlySet<string> = new Set([
  CHAT_SEND_TOOL,
  CHAT_STOP_TOOL,
  SESSION_START_TOOL,
]);

/**
 * Whether a tool call is one of {@link MESSAGING_TOOL_NAMES}, under any MCP
 * server prefix a runtime puts on it (`mcp__dorkos__chat_send`,
 * `dorkos_chat_send`, `dorkos.chat_send`).
 *
 * @param toolName - The tool name as the runtime reported it.
 */
export function isMessagingToolName(toolName: string): boolean {
  return messagingToolOf(toolName) !== null;
}

/**
 * The bare messaging tool a call names, or null when it names none.
 *
 * @param toolName - The tool name as the runtime reported it.
 */
export function messagingToolOf(toolName: string): string | null {
  for (const name of MESSAGING_TOOL_NAMES) {
    if (toolName === name) return name;
    if (toolName.endsWith(`__${name}`) || toolName.endsWith(`.${name}`)) return name;
    if (toolName.endsWith(`dorkos_${name}`)) return name;
  }
  return null;
}

/** What a chat message is. */
export const ChatMessageKindSchema = z
  .enum(['message', 'report', 'start', 'stop'])
  .openapi('ChatMessageKind');

/** One of {@link ChatMessageKindSchema}. */
export type ChatMessageKind = z.infer<typeof ChatMessageKindSchema>;

/** How a sender asked for a message to arrive. */
export const ChatDeliverySchema = z.enum(['queue', 'steer', 'interrupt']).openapi('ChatDelivery');

/** One of {@link ChatDeliverySchema}. */
export type ChatDelivery = z.infer<typeof ChatDeliverySchema>;

/** Where a chat message is now. */
export const ChatMessageStatusSchema = z
  .enum(['queued', 'delivered', 'steered', 'working', 'replied', 'failed'])
  .openapi('ChatMessageStatus');

/** One of {@link ChatMessageStatusSchema}. */
export type ChatMessageStatus = z.infer<typeof ChatMessageStatusSchema>;

/** The chat and agent a message came from, as the server recorded them. */
export const ChatMessageSenderSchema = z
  .object({
    /** The sending chat's id. */
    chatId: z.string(),
    /** The sending chat's title when it sent, when it had one. */
    chatTitle: z.string().optional(),
    /** The sending agent's Mesh id, when Mesh knew it. */
    agentId: z.string().optional(),
    /** The sending agent's name when it sent. */
    agentName: z.string(),
  })
  .openapi('ChatMessageSender');

/** One of {@link ChatMessageSenderSchema}. */
export type ChatMessageSender = z.infer<typeof ChatMessageSenderSchema>;

/**
 * One message another chat sent, stamped by the server onto the user message
 * that carried it. A user message can carry several when agent messages that
 * waited together ran as one turn.
 */
export const ChatMessageStampSchema = z
  .object({
    /** The chat message's id (the sender's receipt id). */
    id: z.string(),
    /** What it is. */
    kind: ChatMessageKindSchema,
    /** Who sent it. */
    from: ChatMessageSenderSchema,
    /** The words, as the sender wrote them (markdown). */
    text: z.string(),
    /** How it was asked to arrive. */
    delivery: ChatDeliverySchema,
    /** Where it is now. */
    status: ChatMessageStatusSchema,
    /** The chat message it answers, when it answers one. */
    replyToId: z.string().optional(),
    /** When it was sent (ISO 8601). */
    sentAt: z.string(),
  })
  .openapi('ChatMessageStamp');

/** One of {@link ChatMessageStampSchema}. */
export type ChatMessageStamp = z.infer<typeof ChatMessageStampSchema>;

/**
 * A chat message as its SENDER sees it: what the Sent card in the sending chat
 * draws, read by the receipt id a tool call returned.
 */
export const SentChatMessageSchema = z
  .object({
    /** The receipt id. */
    id: z.string(),
    /** What it is. */
    kind: ChatMessageKindSchema,
    /** The receiving chat. */
    to: z.object({
      /** Its id. */
      chatId: z.string(),
      /** Its title, when it has one. */
      chatTitle: z.string().optional(),
      /** Its agent's name, when known. */
      agentName: z.string().optional(),
      /** Its agent's Mesh id, when known. */
      agentId: z.string().optional(),
    }),
    /** The words. */
    text: z.string(),
    /** The one-line label the sender wrote, when it wrote one. */
    summary: z.string().optional(),
    /** How it was asked to arrive. */
    delivery: ChatDeliverySchema,
    /** Where it is now. */
    status: ChatMessageStatusSchema,
    /** Its place in the receiving chat's queue while it waits (1 is next). */
    position: z.number().int().positive().optional(),
    /** Why it failed, in plain words. */
    failureReason: z.string().optional(),
    /** The receiving chat's reply to it, when one came back. */
    replyId: z.string().optional(),
    /** When it was sent (ISO 8601). */
    sentAt: z.string(),
  })
  .openapi('SentChatMessage');

/** One of {@link SentChatMessageSchema}. */
export type SentChatMessage = z.infer<typeof SentChatMessageSchema>;

/**
 * Who stopped a chat, when another chat's agent did: the line the stopped chat
 * shows, "Stopped by <agent> · <chat>: <reason>".
 */
export const ChatStopNoticeSchema = z
  .object({
    /** The chat message id of the stop. */
    id: z.string(),
    /** Who stopped it. */
    by: ChatMessageSenderSchema,
    /** Why, when a reason was given. */
    reason: z.string().optional(),
    /** When (ISO 8601). */
    at: z.string(),
  })
  .openapi('ChatStopNotice');

/** One of {@link ChatStopNoticeSchema}. */
export type ChatStopNotice = z.infer<typeof ChatStopNoticeSchema>;

/** The label on both markers of the fence a chat message is read in. */
export const CHAT_MESSAGE_FENCE_LABEL = 'CHAT MESSAGE';

/** The fence markers, with the nonce captured. Hex, as `mintFenceNonce` makes it. */
const FENCE_PATTERN = new RegExp(
  `--- BEGIN ${CHAT_MESSAGE_FENCE_LABEL} ([0-9a-f]{8}) ---[\\s\\S]*?--- END ${CHAT_MESSAGE_FENCE_LABEL} \\1 ---`,
  'g'
);

/**
 * The nonces of every complete chat-message fence in a message, in order.
 *
 * Only a shape: a nonce found here means nothing until the server matches it
 * to its own record for the receiving chat (see the module doc).
 *
 * @param content - A user message's raw text.
 */
export function chatMessageFenceNonces(content: string): string[] {
  const nonces: string[] = [];
  for (const match of content.matchAll(FENCE_PATTERN)) {
    if (match[1]) nonces.push(match[1]);
  }
  return nonces;
}

/**
 * A chat's messaging, as its windows draw it (`GET /api/sessions/:id/chat-messages`):
 * the Sent cards for what it sent, and the "Stopped by" lines for the times
 * another chat stopped it. Replaced whole on every `chat_activity` nudge.
 */
export const ChatActivityResponseSchema = z
  .object({
    /** What this chat sent, oldest first. */
    sent: z.array(SentChatMessageSchema),
    /** Times another chat stopped this one, oldest first. */
    stops: z.array(ChatStopNoticeSchema),
  })
  .openapi('ChatActivityResponse');

/** One of {@link ChatActivityResponseSchema}. */
export type ChatActivityResponse = z.infer<typeof ChatActivityResponseSchema>;

/**
 * The words of the first chat-message fence in a message, without the fence,
 * its preamble or its header — what a title is derived from, so a spin-off is
 * named after its first message rather than the constant line before it.
 * Null when the message carries no chat-message fence.
 *
 * Like {@link chatMessageFenceNonces}, a shape only: it says nothing about who
 * sent the words.
 *
 * @param content - A user message's raw text.
 */
export function chatMessageWords(content: string): string | null {
  FENCE_PATTERN.lastIndex = 0;
  const match = FENCE_PATTERN.exec(content);
  FENCE_PATTERN.lastIndex = 0;
  if (!match) return null;
  const lines = match[0].split('\n').slice(1, -1);
  const kind = lines.findIndex((line) => line.startsWith('Kind: '));
  if (kind === -1) return null;
  return lines
    .slice(kind + 1)
    .join('\n')
    .trim();
}
