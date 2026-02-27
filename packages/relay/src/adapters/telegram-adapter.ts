/**
 * Telegram Bot API adapter for the Relay message bus.
 *
 * Bridges Telegram chats into the Relay subject hierarchy:
 * - Inbound: Telegram messages → published to relay.human.telegram.{chatId}
 * - Outbound: Relay envelopes → sent as Telegram messages
 * - Typing signals: emits typing action when relay signals typing state
 *
 * Subject conventions:
 * - DMs:    relay.human.telegram.{chatId}
 * - Groups: relay.human.telegram.group.{chatId}
 *
 * Supports both polling and webhook modes. The adapter normalises all
 * inbound messages into {@link StandardPayload} so agents are decoupled
 * from the Telegram API surface.
 *
 * Webhook mode uses grammy's `webhookCallback` with a node:http server.
 * Polling mode uses grammy's built-in long-polling loop (non-blocking).
 *
 * @module relay/adapters/telegram-adapter
 */
import { createServer, type Server } from 'node:http';
import { Bot, webhookCallback } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { Context as GrammyContext } from 'grammy';
import type { Signal, StandardPayload, RelayEnvelope, AdapterManifest } from '@dorkos/shared/relay-schemas';
import type {
  RelayAdapter,
  RelayPublisher,
  AdapterStatus,
  AdapterContext,
  DeliveryResult,
  TelegramAdapterConfig,
  Unsubscribe,
} from '../types.js';

// === Constants ===

/** Subject prefix for all Telegram adapter subjects. */
const SUBJECT_PREFIX = 'relay.human.telegram';

/** Subject prefix segment added for group chats. */
const GROUP_SEGMENT = 'group';

/** Telegram sendChatAction type for typing indicator. */
const TELEGRAM_TYPING_ACTION = 'typing' as const;

/** Max length for a single Telegram message (Telegram's hard limit is 4096). */
const MAX_MESSAGE_LENGTH = 4096;

/** Default webhook port when not specified in config. */
const DEFAULT_WEBHOOK_PORT = 8443;

/** Sender name used when publishing inbound messages from unresolvable users. */
const UNKNOWN_SENDER = 'unknown';

// === Helpers ===

/**
 * Build the Relay subject for a given Telegram chat.
 *
 * @param chatId - The Telegram chat ID (numeric, may be negative for groups)
 * @param isGroup - Whether the chat is a group or supergroup
 */
function buildSubject(chatId: number, isGroup: boolean): string {
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
function extractChatId(subject: string): number | null {
  if (!subject.startsWith(SUBJECT_PREFIX)) return null;

  const remainder = subject.slice(SUBJECT_PREFIX.length + 1);
  if (!remainder) return null;

  // Group format: group.{chatId}
  if (remainder.startsWith(`${GROUP_SEGMENT}.`)) {
    const idStr = remainder.slice(GROUP_SEGMENT.length + 1);
    const id = Number(idStr);
    return Number.isFinite(id) ? id : null;
  }

  // DM format: {chatId}
  const id = Number(remainder);
  return Number.isFinite(id) ? id : null;
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
 * Extract text content from a Relay envelope payload.
 *
 * Attempts to read `content` from a StandardPayload-shaped object.
 * Falls back to JSON serialising the entire payload.
 *
 * @param payload - The unknown payload from the Relay envelope
 */
function extractOutboundContent(payload: unknown): string {
  if (typeof payload === 'string') return payload;

  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return '[unserializable payload]';
  }
}

/**
 * Truncate a string to a maximum length, appending an ellipsis if cut.
 *
 * @param text - The text to truncate
 * @param maxLen - Maximum character length
 */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
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

// === Manifest ===

/** Static adapter manifest for the Telegram built-in adapter. */
export const TELEGRAM_MANIFEST: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via a Telegram bot.',
  iconEmoji: '✈️',
  category: 'messaging',
  docsUrl: 'https://core.telegram.org/bots',
  builtin: true,
  multiInstance: false,
  configFields: [
    {
      key: 'token',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: '123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      description: 'Token from @BotFather on Telegram.',
    },
    {
      key: 'mode',
      label: 'Receiving Mode',
      type: 'select',
      required: true,
      default: 'polling',
      options: [
        { label: 'Long Polling', value: 'polling' },
        { label: 'Webhook', value: 'webhook' },
      ],
      description: 'Polling requires no public URL. Webhook is recommended for production.',
    },
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://your-domain.com/relay/webhooks/telegram',
      description: 'Public HTTPS URL where Telegram sends updates.',
      showWhen: { field: 'mode', equals: 'webhook' },
    },
    {
      key: 'webhookPort',
      label: 'Webhook Port',
      type: 'number',
      required: false,
      default: 8443,
      description: 'Port for the webhook HTTP server.',
      showWhen: { field: 'mode', equals: 'webhook' },
    },
  ],
  setupInstructions:
    'Open Telegram and search for **@BotFather**. Send `/newbot`, choose a name and username. Copy the token provided.',
};

// === TelegramAdapter ===

/**
 * Telegram Bot API adapter for the Relay message bus.
 *
 * Implements the {@link RelayAdapter} plugin interface to bridge Telegram
 * chats into the Relay subject hierarchy. Handles both polling and webhook
 * modes through grammy, and normalises inbound Telegram messages into the
 * {@link StandardPayload} format.
 *
 * @example
 * ```ts
 * const adapter = new TelegramAdapter('my-telegram', {
 *   token: process.env.TELEGRAM_TOKEN!,
 *   mode: 'polling',
 * });
 *
 * const registry = new AdapterRegistry();
 * registry.setRelay(relay);
 * await registry.register(adapter);
 * ```
 */
export class TelegramAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix = SUBJECT_PREFIX;
  readonly displayName: string;

  private readonly config: TelegramAdapterConfig;
  private bot: Bot | null = null;
  private webhookServer: Server | null = null;
  private relay: RelayPublisher | null = null;
  private signalUnsub: Unsubscribe | null = null;

  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  /**
   * @param id - Unique adapter ID (e.g. 'telegram' or 'telegram-work')
   * @param config - Telegram adapter configuration (token, mode, webhook settings)
   * @param displayName - Human-readable name shown in the adapter status UI
   */
  constructor(id: string, config: TelegramAdapterConfig, displayName = 'Telegram') {
    this.id = id;
    this.config = config;
    this.displayName = displayName;
  }

  /**
   * Start the adapter: connect the Telegram bot and register signal handlers.
   *
   * Idempotent — if the adapter is already started, returns immediately.
   *
   * @param relay - The RelayPublisher used to publish inbound Telegram messages
   */
  async start(relay: RelayPublisher): Promise<void> {
    if (this.bot !== null) return; // Already started

    this.relay = relay;
    this.status = {
      ...this.status,
      state: 'starting',
      startedAt: new Date().toISOString(),
    };

    const bot = new Bot(this.config.token);

    // Apply auto-retry transformer to handle Telegram rate limit (429) responses
    bot.api.config.use(autoRetry());

    // Register inbound message handler
    bot.on('message', (ctx) => this.handleInboundMessage(ctx));

    bot.catch((err) => {
      this.recordError(err);
    });

    this.bot = bot;

    // Subscribe to typing signals from the relay
    this.signalUnsub = relay.onSignal(`${SUBJECT_PREFIX}.>`, (subject: string, signal: Signal) => {
      if (signal.type === 'typing') {
        void this.handleTypingSignal(subject, signal.state);
      }
    });

    await this.startPollingOrWebhook(bot);

    this.status = { ...this.status, state: 'connected' };
  }

  /**
   * Stop the adapter: disconnect the bot, shut down the webhook server if
   * running, and unregister signal handlers.
   *
   * Idempotent — if the adapter is already stopped, returns immediately.
   */
  async stop(): Promise<void> {
    if (this.bot === null) return; // Already stopped

    this.status = { ...this.status, state: 'stopping' };

    // Unsubscribe from relay signals before stopping the bot
    if (this.signalUnsub) {
      this.signalUnsub();
      this.signalUnsub = null;
    }

    try {
      if (this.config.mode === 'polling') {
        await this.bot.stop();
      }
      await this.stopWebhookServer();
    } catch (err) {
      this.recordError(err);
    } finally {
      this.bot = null;
      this.relay = null;
      this.status = { ...this.status, state: 'disconnected' };
    }
  }

  /**
   * Deliver a Relay message to the Telegram chat identified by the subject.
   *
   * Extracts the chat ID from the subject, reads the payload content, and
   * sends it via the Telegram Bot API. Outbound content is truncated to
   * Telegram's 4096-character message limit.
   *
   * @param subject - The Relay subject (e.g. relay.human.telegram.123456)
   * @param envelope - The relay envelope to deliver
   * @param _context - Optional adapter context (unused by this adapter)
   */
  async deliver(subject: string, envelope: RelayEnvelope, _context?: AdapterContext): Promise<DeliveryResult> {
    const startTime = Date.now();

    if (!this.bot) {
      return {
        success: false,
        error: `TelegramAdapter(${this.id}): not started`,
        durationMs: Date.now() - startTime,
      };
    }

    const chatId = extractChatId(subject);
    if (chatId === null) {
      return {
        success: false,
        error: `TelegramAdapter(${this.id}): cannot extract chat ID from subject '${subject}'`,
        durationMs: Date.now() - startTime,
      };
    }

    const content = extractOutboundContent(envelope.payload);
    const text = truncateText(content, MAX_MESSAGE_LENGTH);

    try {
      await this.bot.api.sendMessage(chatId, text);
      this.status = {
        ...this.status,
        messageCount: {
          ...this.status.messageCount,
          outbound: this.status.messageCount.outbound + 1,
        },
      };
      return {
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      this.recordError(err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Return the current adapter status snapshot.
   */
  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  // --- Private ---

  /**
   * Start the bot in polling or webhook mode depending on config.
   *
   * @param bot - The grammy Bot instance to start
   */
  private async startPollingOrWebhook(bot: Bot): Promise<void> {
    if (this.config.mode === 'webhook') {
      await this.startWebhookMode(bot);
    } else {
      this.startPollingMode(bot);
    }
  }

  /**
   * Start grammy bot in long-polling mode (non-blocking).
   *
   * `bot.start()` is intentionally not awaited — grammy's polling loop
   * runs in the background and rejects its returned promise only on fatal
   * errors. The `onStart` callback transitions state to 'connected' once
   * the bot has confirmed its identity with the Telegram API.
   *
   * @param bot - The grammy Bot instance
   */
  private startPollingMode(bot: Bot): void {
    // Non-blocking: polling runs in background
    void bot.start({
      drop_pending_updates: true,
      onStart: () => {
        this.status = { ...this.status, state: 'connected' };
      },
    });
  }

  /**
   * Start grammy bot in webhook mode using a node:http server.
   *
   * Registers the webhook URL with Telegram, creates an HTTP server using
   * grammy's `webhookCallback`, and starts listening on the configured port.
   * The server is stored in `webhookServer` for graceful shutdown in `stop()`.
   *
   * @param bot - The grammy Bot instance
   */
  private async startWebhookMode(bot: Bot): Promise<void> {
    const { webhookUrl, webhookPort } = this.config;

    if (!webhookUrl) {
      throw new Error(
        `TelegramAdapter(${this.id}): webhookUrl is required when mode is 'webhook'`,
      );
    }

    await bot.api.setWebhook(webhookUrl);

    const port = webhookPort ?? DEFAULT_WEBHOOK_PORT;
    const handler = webhookCallback(bot, 'http');
    const server = createServer(handler);
    this.webhookServer = server;

    await new Promise<void>((resolve, reject) => {
      server.listen(port, resolve);
      server.on('error', reject);
    });
  }

  /**
   * Shut down the webhook HTTP server if one is running.
   */
  private async stopWebhookServer(): Promise<void> {
    if (!this.webhookServer) return;
    const server = this.webhookServer;
    this.webhookServer = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Handle an inbound Telegram message and publish it to the Relay.
   *
   * Builds the subject from the chat ID, constructs a {@link StandardPayload},
   * and publishes it. Errors during publish are caught and recorded to avoid
   * crashing the grammy update loop.
   *
   * @param ctx - The grammy context for the inbound message
   */
  private async handleInboundMessage(ctx: GrammyContext): Promise<void> {
    if (!this.relay || !ctx.message) return;

    const { chat, from, message } = ctx;
    if (!chat || !message) return;

    const isGroup = isGroupChat(chat.type);
    const subject = buildSubject(chat.id, isGroup);

    const text = message.text ?? message.caption ?? '';
    if (!text) return; // Skip non-text messages (photos, stickers, etc.) without caption

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
      await this.relay.publish(subject, payload, {
        from: `${SUBJECT_PREFIX}.bot`,
      });
      this.status = {
        ...this.status,
        messageCount: {
          ...this.status.messageCount,
          inbound: this.status.messageCount.inbound + 1,
        },
      };
    } catch (err) {
      this.recordError(err);
    }
  }

  /**
   * Handle a typing signal from the Relay and forward it to Telegram.
   *
   * Extracts the chat ID from the subject and sends a `typing` chat action
   * via the Telegram Bot API. Errors are silently swallowed — typing signals
   * are best-effort and non-critical.
   *
   * @param subject - The Relay subject the typing signal was emitted on
   * @param state - The signal state ('active' | 'stopped' or other values)
   */
  private async handleTypingSignal(subject: string, state: string): Promise<void> {
    if (!this.bot || state !== 'active') return;

    const chatId = extractChatId(subject);
    if (chatId === null) return;

    try {
      await this.bot.api.sendChatAction(chatId, TELEGRAM_TYPING_ACTION);
    } catch {
      // Typing signals are best-effort — never throw on failure
    }
  }

  /**
   * Record an error in the adapter status.
   *
   * Updates `state` to 'error', increments `errorCount`, and stores the
   * error message and timestamp. Does not throw.
   *
   * @param err - The error to record (any type accepted)
   */
  private recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.status = {
      ...this.status,
      state: 'error',
      errorCount: this.status.errorCount + 1,
      lastError: message,
      lastErrorAt: new Date().toISOString(),
    };
  }
}
