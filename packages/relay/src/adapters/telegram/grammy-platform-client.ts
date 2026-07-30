/**
 * Grammy-backed implementation of the PlatformClient interface for Telegram.
 *
 * Wraps a grammy `Bot` instance and provides typed platform operations:
 * posting, editing, and deleting messages.
 *
 * It deliberately owns no typing indicator. Telegram's chat action is driven
 * by the turn's own lifecycle in `outbound.ts`, and a second refresh loop here
 * — with its own private timer map, invisible to the adapter's teardown —
 * could only ever contradict it.
 *
 * This class owns no relay routing or envelope handling — those concerns
 * remain in `TelegramAdapter`. It operates exclusively on thread IDs (chat
 * IDs as strings) and content strings, as required by `PlatformClient`.
 *
 * @module relay/adapters/telegram/grammy-platform-client
 */
import type { Bot } from 'grammy';
import type { PlatformClient, RelayPublisher, RelayLogger } from '../../types.js';
import { noopLogger } from '../../types.js';
import { formatForPlatform, truncateText } from '../../lib/payload-utils.js';
import { MAX_MESSAGE_LENGTH } from './inbound.js';

/**
 * Grammy-backed Telegram platform client implementing {@link PlatformClient}.
 *
 * Instantiate with a grammy `Bot` instance. The bot must be started before
 * any methods are called. Typically owned by `TelegramAdapter` after the bot
 * is connected.
 */
export class GrammyPlatformClient implements PlatformClient {
  /** @inheritdoc */
  readonly platform = 'telegram';

  readonly #bot: Bot;
  readonly #logger: RelayLogger;

  /**
   * Create a Grammy platform client for sending messages via the Telegram Bot API.
   *
   * @param bot - The grammy Bot instance (must be started before API calls)
   * @param logger - Optional logger for diagnostics
   */
  constructor(bot: Bot, logger: RelayLogger = noopLogger) {
    this.#bot = bot;
    this.#logger = logger;
  }

  /**
   * Post a new message to a Telegram chat.
   *
   * Content is truncated to {@link MAX_MESSAGE_LENGTH} and converted from
   * Markdown to Telegram's HTML subset via `formatForPlatform`.
   *
   * @param threadId - Telegram chat ID as a string
   * @param content - Message body text (Markdown)
   * @param _format - Unused; Telegram always uses HTML parse mode
   */
  async postMessage(
    threadId: string,
    content: string,
    _format?: string
  ): Promise<{ messageId: string }> {
    const chatId = parseChatId(threadId);
    const html = formatForPlatform(truncateText(content, MAX_MESSAGE_LENGTH), 'telegram');

    const bot = this.#bot;
    const sent = await bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
    } as Parameters<typeof bot.api.sendMessage>[2]);

    this.#logger.debug(`postMessage: sent to chat ${chatId} (${content.length} chars)`);
    return { messageId: String(sent.message_id) };
  }

  /**
   * Edit an existing Telegram message in place.
   *
   * @param threadId - Telegram chat ID as a string
   * @param messageId - The message ID to edit
   * @param content - Replacement message body text (Markdown)
   */
  async editMessage(threadId: string, messageId: string, content: string): Promise<void> {
    const chatId = parseChatId(threadId);
    const html = formatForPlatform(truncateText(content, MAX_MESSAGE_LENGTH), 'telegram');

    const bot = this.#bot;
    await bot.api.editMessageText(chatId, Number(messageId), html, {
      parse_mode: 'HTML',
    } as Parameters<typeof bot.api.editMessageText>[3]);

    this.#logger.debug(`editMessage: edited message ${messageId} in chat ${chatId}`);
  }

  /**
   * Delete a message from a Telegram chat.
   *
   * @param threadId - Telegram chat ID as a string
   * @param messageId - The message ID to delete
   */
  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const chatId = parseChatId(threadId);
    await this.#bot.api.deleteMessage(chatId, Number(messageId));
    this.#logger.debug(`deleteMessage: deleted message ${messageId} from chat ${chatId}`);
  }

  /**
   * No-op — inbound handling is managed by `TelegramAdapter` directly.
   *
   * `TelegramAdapter` registers the grammy message handler and calls
   * `handleInboundMessage` from `inbound.ts`. `GrammyPlatformClient` does
   * not need to intercept the relay publisher here.
   *
   * @param _relay - Unused
   */
  handleInbound(_relay: RelayPublisher): void {
    // Inbound is wired in TelegramAdapter.start() — no-op here.
  }

  /**
   * Post an interactive action prompt with inline keyboard buttons.
   *
   * Renders the prompt text and each action as an inline keyboard row.
   * Uses Telegram's HTML parse mode for the prompt.
   *
   * @param threadId - Telegram chat ID as a string
   * @param prompt - Prompt text displayed above the action buttons
   * @param actions - Ordered list of label/value pairs for each button
   */
  async postAction(
    threadId: string,
    prompt: string,
    actions: Array<{ label: string; value: string }>
  ): Promise<{ messageId: string }> {
    const chatId = parseChatId(threadId);
    const html = formatForPlatform(truncateText(prompt, MAX_MESSAGE_LENGTH), 'telegram');

    const inlineKeyboard = actions.map((action) => [
      { text: action.label, callback_data: action.value },
    ]);

    const bot = this.#bot;
    const sent = await bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
    } as Parameters<typeof bot.api.sendMessage>[2]);

    this.#logger.debug(
      `postAction: sent ${actions.length} action(s) to chat ${chatId} (message ${sent.message_id})`
    );
    return { messageId: String(sent.message_id) };
  }

  /**
   * Tear down the platform client.
   *
   * Nothing to release: this client holds no timers or connections of its own
   * — the grammy `Bot` it wraps is owned and stopped by `TelegramAdapter`, and
   * the chat's typing loop lives with the turn in `outbound.ts`. Required by
   * {@link PlatformClient}, which every implementation must satisfy.
   */
  async destroy(): Promise<void> {
    this.#logger.debug('destroy: nothing to release');
  }
}

/**
 * Parse a thread ID string into a numeric Telegram chat ID.
 *
 * Throws if the string is not a valid integer — callers are responsible
 * for passing valid thread IDs extracted from subjects via `extractChatId`.
 *
 * @param threadId - Thread ID as a string (e.g., '123456789' or '-1001234567890')
 */
function parseChatId(threadId: string): number {
  const id = Number(threadId);
  if (!Number.isInteger(id)) {
    throw new Error(`GrammyPlatformClient: invalid threadId '${threadId}' — expected integer`);
  }
  return id;
}
