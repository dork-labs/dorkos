/**
 * Telegram inbound message handling.
 *
 * Parses Telegram Bot API updates into Relay-compatible payloads.
 * Handles text messages, photos with captions, and other message types.
 * Normalises all inbound messages into {@link StandardPayload} so agents
 * are decoupled from the Telegram API surface.
 *
 * @module relay/adapters/telegram-inbound
 */
import type { Context as GrammyContext } from 'grammy';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, AdapterInboundCallbacks, RelayLogger } from '../../types.js';
import { noopLogger } from '../../types.js';

// === Constants ===

/** Subject prefix for all Telegram adapter subjects. */
export const SUBJECT_PREFIX = 'relay.human.telegram';

/** Subject prefix segment added for group chats. */
const GROUP_SEGMENT = 'group';

/** Max length for a single Telegram message (Telegram's hard limit is 4096). */
export const MAX_MESSAGE_LENGTH = 4096;

/** Sender name used when publishing inbound messages from unresolvable users. */
const UNKNOWN_SENDER = 'unknown';

/** Maximum inbound message content length (32 KB). */
export const MAX_CONTENT_LENGTH = 32_768;

// === Helpers ===

/**
 * Build the Relay subject for a given Telegram chat.
 *
 * @param chatId - The Telegram chat ID (numeric, may be negative for groups)
 * @param isGroup - Whether the chat is a group or supergroup
 */
export function buildSubject(chatId: number, isGroup: boolean): string {
  if (isGroup) {
    return `${SUBJECT_PREFIX}.${GROUP_SEGMENT}.${chatId}`;
  }
  return `${SUBJECT_PREFIX}.${chatId}`;
}

/**
 * Extract the Telegram chat ID from a Relay subject.
 *
 * Returns null if the subject does not match the expected pattern.
 *
 * @param subject - A Relay subject under the telegram prefix
 */
export function extractChatId(subject: string): number | null {
  if (!subject.startsWith(SUBJECT_PREFIX)) return null;

  const remainder = subject.slice(SUBJECT_PREFIX.length + 1);
  if (!remainder) return null;

  // Group format: group.{chatId}
  if (remainder.startsWith(`${GROUP_SEGMENT}.`)) {
    const idStr = remainder.slice(GROUP_SEGMENT.length + 1);
    if (!idStr) return null; // Guard: Number("") === 0, which is invalid
    const id = Number(idStr);
    return Number.isInteger(id) ? id : null;
  }

  // DM format: {chatId}
  const id = Number(remainder);
  return Number.isInteger(id) ? id : null;
}

/**
 * Determine whether a Telegram chat type indicates a group.
 *
 * @param chatType - The Telegram chat type string
 */
function isGroupChat(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup' || chatType === 'channel';
}

/**
 * Extract the optional channel title from a Telegram chat object.
 *
 * Group and supergroup chats have a `title` field; private chats do not.
 *
 * @param chat - The Telegram chat object from grammy context
 */
function extractChannelName(chat: GrammyContext['chat']): string | undefined {
  if (!chat) return undefined;
  if ('title' in chat && typeof (chat as { title?: string }).title === 'string') {
    return (chat as { title: string }).title;
  }
  return undefined;
}

/**
 * Handle an inbound Telegram message and publish it to the Relay.
 *
 * Builds the subject from the chat ID, constructs a {@link StandardPayload},
 * and publishes it. Errors during publish are caught and recorded to avoid
 * crashing the grammy update loop.
 *
 * @param ctx - The grammy context for the inbound message
 * @param relay - The relay publisher
 * @param callbacks - Callbacks to mutate adapter state
 */
export async function handleInboundMessage(
  ctx: GrammyContext,
  relay: RelayPublisher,
  callbacks: AdapterInboundCallbacks,
  logger: RelayLogger = noopLogger,
): Promise<void> {
  if (!ctx.message) {
    logger.debug('inbound skipped: no message in context');
    return;
  }

  const { chat, from, message } = ctx;
  if (!chat || !message) {
    logger.debug('inbound skipped: missing chat or message');
    return;
  }

  const isGroup = isGroupChat(chat.type);
  const subject = buildSubject(chat.id, isGroup);

  const rawText = message.text ?? message.caption ?? '';
  if (!rawText) {
    logger.debug(`inbound skipped: no text content in chat ${chat.id}`);
    return;
  }

  // Cap inbound content to prevent oversized payloads from reaching the relay
  const text = rawText.slice(0, MAX_CONTENT_LENGTH);

  const senderName = from
    ? [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      from.username ||
      UNKNOWN_SENDER
    : UNKNOWN_SENDER;

  const payload: StandardPayload = {
    content: text,
    senderName,
    channelName: isGroup ? extractChannelName(chat) : undefined,
    channelType: isGroup ? 'group' : 'dm',
    responseContext: {
      platform: 'telegram',
      maxLength: MAX_MESSAGE_LENGTH,
      supportedFormats: ['text', 'markdown'],
      instructions: `Reply to subject ${subject} to respond to this Telegram message.`,
    },
    platformData: {
      chatId: chat.id,
      messageId: message.message_id,
      chatType: chat.type,
      fromId: from?.id,
      username: from?.username,
    },
  };

  try {
    await relay.publish(subject, payload, {
      from: `${SUBJECT_PREFIX}.bot`,
      replyTo: subject,
    });
    callbacks.trackInbound();
    logger.debug(`inbound from ${senderName} in chat ${chat.id}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}" (${text.length} chars) → ${subject}`);
  } catch (err) {
    callbacks.recordError(err);
    logger.warn(`inbound publish failed for chat ${chat.id}:`, err instanceof Error ? err.message : String(err));
  }
}
