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
import type { StandardPayload, RespondMode } from '@dorkos/shared/relay-schemas';
import { DEFAULT_RESPOND_MODE } from '@dorkos/shared/relay-schemas';
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
  // Teach only the Markdown the HTML converter actually supports. Underscores
  // are intentionally NOT taught: the converter maps `*italic*` (asterisks) to
  // <i>, and adding underscore handling would mangle snake_case identifiers.
  '- Use **bold**, *italic*, `code`, ```code blocks```, and [links](url).',
  '- Telegram supports HTML subset: headings are not supported, use bold instead.',
  `- Keep responses concise. Messages over ${MAX_MESSAGE_LENGTH} characters are split.`,
].join('\n');

// === Types ===

/** The inbound message carried by a grammy context. */
type TelegramMessage = NonNullable<GrammyContext['message']>;

/** Telegram's own identity, as grammy exposes it on `ctx.me`. */
type BotIdentity = GrammyContext['me'];

/** Options for inbound Telegram message handling. */
export interface TelegramInboundOptions {
  /**
   * When the bot answers in a group or supergroup. Private chats always get an
   * answer regardless of this.
   */
  respondMode?: RespondMode;
}

// === Loop prevention ===

/**
 * Whether an inbound message was written by a bot rather than a person.
 *
 * The guard this feeds is a **mechanism, not a preference**: it has no config
 * field, it runs before anything a person can configure, and it is not
 * expressible as a prompt instruction. Two DorkOS-driven bots in one Telegram
 * group otherwise answer each other without end, because a reply loop is a
 * property of the whole conversation while each agent only ever sees its own
 * turn — so "do not get into a loop" is not a rule an agent is able to follow
 * (`.claude/rules/room-conduct.md`, ADR `260726-170127`). Slack has had the
 * equivalent guard since it shipped; Telegram had none (DOR-619).
 *
 * This covers the adapter's own messages too — the account it authenticates as
 * is itself a bot — so it is both the other-bot guard and the self-echo guard.
 * The single exception is {@link isAnonymousGroupAdmin}, who is a person.
 *
 * @param from - The `from` field of the inbound message, if present.
 */
function isBotSender(from: GrammyContext['from']): boolean {
  return from?.is_bot === true;
}

/**
 * Whether a message came from an anonymous administrator of *this* group.
 *
 * Telegram sends an anonymous admin's message through a service bot account, so
 * `from.is_bot` is `true` and the guard above would drop a human being. An
 * anonymous admin is a person, so they are carved out and then gated like any
 * other person: they still have to name the bot or reply to it.
 *
 * Keyed on `sender_chat`, which the Bot API documents as "the supergroup itself
 * for messages sent by its anonymous administrators", alongside `from` being
 * "a fake sender user" in exactly that case. Deliberately **not** keyed on the
 * service account's numeric id (1087968824): that value is widely repeated but
 * appears nowhere in the Bot API reference or in `@grammyjs/types`, so pinning
 * a loop-prevention branch to it would be pinning it to folklore.
 *
 * Comparing against `chat.id` also keeps the carve-out narrow. A message posted
 * on behalf of a *channel* comes from Telegram's `Channel_Bot` service account
 * with `sender_chat` set to that channel, not to this chat, so it stays dropped.
 * That covers a linked channel's auto-forwarded posts (automation, correctly
 * ignored) and a person posting under a channel identity (a knowing cost — see
 * `contributing/relay-adapters.md`; they can still speak as themselves).
 *
 * Neither field can be forged: `from` and `sender_chat` are both set by Telegram
 * server-side, so no bot can spoof its way into this branch.
 *
 * ## Known residual, deliberately not closed by guessing
 *
 * Telegram sets `sender_chat` for *any* anonymous administrator. If a **bot**
 * can be an anonymous admin, its messages would carry the same signal, be
 * exempted below, and put the DOR-619 loop shape back. `promoteChatMember`
 * documents `is_anonymous` without excluding bots, but nothing states whether
 * Telegram honours it for a bot's outgoing messages, and that question needs an
 * answer from Telegram rather than a code change — so it is filed, not fixed.
 *
 * The residual is real but bounded, and bounded by a mechanism rather than a
 * hope:
 *
 * - This exempts from the **bot guard only**. An anonymous admin still has to
 *   pass the respond gate, so a loop needs both bots to actively name each other
 *   or reply to each other, not merely to be present.
 * - Telegram, unlike Discord, does **not** auto-mention the author of a
 *   replied-to message. That auto-mention is exactly why Hermes declares
 *   bot-to-bot conversation unsupported: there, two mention-gated bots satisfy
 *   each other's gate indefinitely and for free. We do not inherit that, so the
 *   mutual-addressing condition has to be met deliberately rather than by
 *   accident.
 *
 * Do not "fix" this by widening the guard or by keying on account ids; if it
 * turns out bots can be anonymous admins, the answer is to drop the carve-out
 * for senders that are bots by some *verified* signal.
 *
 * @param message - The inbound Telegram message.
 * @param chat - The chat the message arrived in.
 */
function isAnonymousGroupAdmin(
  message: TelegramMessage,
  chat: NonNullable<GrammyContext['chat']>
): boolean {
  return message.sender_chat?.id === chat.id;
}

// === Group respond gating ===

/**
 * Whether a message addresses the bot.
 *
 * Reads Telegram's own entity offsets rather than scanning the raw text, so a
 * handle appearing inside a quoted URL or a code span does not count. Three
 * shapes address a bot:
 *
 * - a `@botname` mention anywhere in the message;
 * - a `text_mention` entity carrying the bot's user id, which is how Telegram
 *   represents a mention of a user with no public handle;
 * - a command that opens the message. `/status@botname` names the bot outright.
 *   A bare `/status` names no bot at all, and Telegram's own convention is that
 *   it is meant for whichever bots are listening, so it counts too. A command
 *   naming a *different* bot deliberately does not.
 *
 * @param message - The inbound Telegram message.
 * @param me - The bot's own identity from `ctx.me`.
 */
function addressesBot(message: TelegramMessage, me: BotIdentity): boolean {
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = `@${me.username.toLowerCase()}`;

  for (const entity of entities) {
    if (entity.type === 'text_mention') {
      if (entity.user.id === me.id) return true;
      continue;
    }

    // Offsets are UTF-16 code units, which is what a JS string slice uses.
    const token = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();

    if (entity.type === 'mention') {
      // The leading `@` anchors this, so `@dorkbotanic` cannot match `@dorkbot`.
      if (token === handle) return true;
      continue;
    }

    if (entity.type === 'bot_command') {
      if (token.endsWith(handle)) return true;
      // Only a command that opens the message is an invocation. Telegram emits
      // the entity for a `/word` appearing mid-sentence too, and "ask it to run
      // /deploy later" is talk about a command, not a use of one.
      if (!token.includes('@') && entity.offset === 0) return true;
    }
  }
  return false;
}

/**
 * Whether a message replies to something the bot itself said.
 *
 * A Telegram reply is the closest thing the platform has to a Slack thread, so
 * this is what `'thread-aware'` means here: the person is continuing a
 * conversation the bot already joined and should not have to name it again.
 *
 * @param message - The inbound Telegram message.
 * @param me - The bot's own identity from `ctx.me`.
 */
function repliesToBot(message: TelegramMessage, me: BotIdentity): boolean {
  return message.reply_to_message?.from?.id === me.id;
}

/**
 * Decide whether to answer a message in a group under the configured mode.
 *
 * Only groups reach this. A private chat is addressed to the bot by
 * construction and is always answered.
 *
 * @param mode - The configured respond mode.
 * @param message - The inbound Telegram message.
 * @param me - The bot's own identity from `ctx.me`.
 */
function shouldProcessGroupMessage(
  mode: RespondMode,
  message: TelegramMessage,
  me: BotIdentity
): boolean {
  if (mode === 'always') return true;
  if (addressesBot(message, me)) return true;
  if (mode === 'mention-only') return false;
  return repliesToBot(message, me);
}

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
 * Two gates run before anything is published, and they are different kinds of
 * thing. {@link isBotSender} is a mechanism — unconditional, unconfigurable,
 * and the reason two bots in one group cannot answer each other forever.
 * {@link shouldProcessGroupMessage} is a preference the operator sets, and it
 * only ever narrows behavior in groups.
 *
 * Past both gates, builds the subject from the chat ID, constructs a
 * {@link StandardPayload}, and publishes it. Errors during publish are caught
 * and recorded to avoid crashing the grammy update loop.
 *
 * @param ctx - The grammy context for the inbound message
 * @param relay - The relay publisher
 * @param callbacks - Callbacks to mutate adapter state
 * @param logger - Optional relay logger for debug/warn output (defaults to silent)
 * @param codec - Optional thread ID codec (defaults to an unscoped one)
 * @param options - Respond-mode policy; omitted resolves to the schema default
 */
export async function handleInboundMessage(
  ctx: GrammyContext,
  relay: RelayPublisher,
  callbacks: AdapterInboundCallbacks,
  logger: RelayLogger = noopLogger,
  codec?: TelegramThreadIdCodec,
  options?: TelegramInboundOptions
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

  // Bot-loop guard — deliberately first, and deliberately not configurable. The
  // one carve-out is an anonymous admin, who is a person wearing the group's
  // name; they fall through to the respond gate rather than past it.
  if (isBotSender(from) && !isAnonymousGroupAdmin(message, chat)) {
    logger.debug(
      `inbound skipped: sender ${from?.username ?? from?.id ?? 'unknown'} is a bot ` +
        `(chat ${chat.id})`
    );
    return;
  }

  const isGroup = isGroupChat(chat.type);
  const subject = buildSubject(resolvedCodec, chat.id, isGroup);

  const rawText = message.text ?? message.caption ?? '';
  if (!rawText) {
    logger.debug(`inbound skipped: no text content in chat ${chat.id}`);
    return;
  }

  // Group respond gating. A private chat is addressed to the bot by
  // construction, so it never reaches this.
  if (isGroup) {
    const respondMode = options?.respondMode ?? DEFAULT_RESPOND_MODE;
    if (!shouldProcessGroupMessage(respondMode, message, ctx.me)) {
      logger.debug(`inbound skipped: respond mode '${respondMode}' filtered chat ${chat.id}`);
      return;
    }
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
