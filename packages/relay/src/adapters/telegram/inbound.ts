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
import { TelegramThreadIdCodec } from '../../lib/thread-id.js';

// === Constants ===

/** Subject prefix for all Telegram adapter subjects. */
export const SUBJECT_PREFIX = 'relay.human.telegram';

/** Max length for a single Telegram message (Telegram's hard limit is 4096). */
export const MAX_MESSAGE_LENGTH = 4096;

/** Sender name used when publishing inbound messages from unresolvable users. */
const UNKNOWN_SENDER = 'unknown';

/** Maximum inbound message content length (32 KB). */
export const MAX_CONTENT_LENGTH = 32_768;

/** Telegram-specific formatting rules injected into agent system prompts via responseContext. */
const TELEGRAM_FORMATTING_RULES = [
  'FORMATTING RULES (you MUST follow these):',
  '- Do NOT use Markdown tables. Telegram cannot render them.',
  '- For structured data: use bullet points or bold key-value pairs.',
  '- Use **bold**, _italic_, `code`, ```code blocks```, and [links](url).',
  '- Telegram supports HTML subset: headings are not supported, use bold instead.',
  `- Keep responses concise. Messages over ${MAX_MESSAGE_LENGTH} characters are split.`,
].join('\n');

// === Helpers ===

/**
 * Build the Relay subject for a given Telegram chat.
 *
 * @param codec - The thread ID codec to use for encoding
 * @param chatId - The Telegram chat ID (numeric, may be negative for groups)
 * @param isGroup - Whether the chat is a group or supergroup
 */
export function buildSubject(
  codec: TelegramThreadIdCodec,
  chatId: number,
  isGroup: boolean
): string {
  return codec.encode(String(chatId), isGroup ? 'group' : 'dm');
}

/**
 * Extract the Telegram chat ID from a Relay subject.
 *
 * Returns null if the subject does not match the expected pattern.
 *
 * @param codec - The thread ID codec to use for decoding
 * @param subject - A Relay subject under the telegram prefix
 */
export function extractChatId(codec: TelegramThreadIdCodec, subject: string): number | null {
  const decoded = codec.decode(subject);
  if (!decoded) return null;
  const id = Number(decoded.platformId);
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
  codec?: TelegramThreadIdCodec
): Promise<void> {
  const resolvedCodec = codec ?? new TelegramThreadIdCodec();

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
  const subject = buildSubject(resolvedCodec, chat.id, isGroup);

  const rawText = message.text ?? message.caption ?? '';
  if (!rawText) {
    logger.debug(`inbound skipped: no text content in chat ${chat.id}`);
    return;
  }

  // Cap inbound content to prevent oversized payloads from reaching the relay
  const text = rawText.slice(0, MAX_CONTENT_LENGTH);

  const senderName = from
    ? [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || UNKNOWN_SENDER
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
      formattingInstructions: TELEGRAM_FORMATTING_RULES,
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
    const result = await relay.publish(subject, payload, {
      from: `${resolvedCodec.prefix}.bot`,
      replyTo: subject,
    });

    // Check for rejected publishes (e.g. rate-limited) before tracking
    if (result.deliveredTo === 0 && result.rejected?.length) {
      const reason = result.rejected[0]?.reason ?? 'unknown';
      callbacks.recordError(new Error(`Publish rejected: ${reason}`));
      logger.warn(`inbound publish rejected for chat ${chat.id}: ${reason}`);
      return;
    }

    callbacks.trackInbound();
    callbacks.onPublished?.(chat.id);
    logger.debug(
      `inbound from ${senderName} in chat ${chat.id}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}" (${text.length} chars) → ${subject}`
    );
  } catch (err) {
    callbacks.recordError(err);
    logger.warn(
      `inbound publish failed for chat ${chat.id}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
