/**
 * Telegram Bot API adapter for the Relay message bus.
 *
 * Thin facade composing inbound parsing, outbound delivery, and webhook
 * management sub-modules into a single cohesive adapter class.
 * Supports both polling and webhook modes.
 *
 * @module relay/adapters/telegram-adapter
 */
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { Server } from 'node:http';
import type { Signal, AdapterManifest, RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type {
  RelayAdapter, RelayPublisher, AdapterStatus, AdapterContext,
  DeliveryResult, TelegramAdapterConfig, Unsubscribe,
} from '../../types.js';
import { SUBJECT_PREFIX, handleInboundMessage } from './inbound.js';
import { deliverMessage, handleTypingSignal } from './outbound.js';
import { startWebhookMode, stopWebhookServer } from './webhook.js';

/** Static adapter manifest for the Telegram built-in adapter. */
export const TELEGRAM_MANIFEST: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via a Telegram bot.',
  iconEmoji: '\u2708\uFE0F',
  category: 'messaging',
  docsUrl: 'https://core.telegram.org/bots',
  builtin: true,
  multiInstance: true,
  actionButton: {
    label: 'Open @BotFather in Telegram',
    url: 'tg://resolve?domain=botfather',
  },
  setupSteps: [
    {
      stepId: 'get-token',
      title: 'Get your Bot Token',
      description: 'Create a bot with @BotFather on Telegram.',
      fields: ['token'],
    },
    {
      stepId: 'configure-mode',
      title: 'Choose connection mode',
      fields: ['mode', 'webhookUrl', 'webhookPort', 'webhookSecret'],
    },
  ],
  configFields: [
    { key: 'token', label: 'Bot Token', type: 'password', required: true,
      placeholder: '123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      description: 'Paste the token from @BotFather. Message @BotFather on Telegram → /newbot → copy the token.',
      pattern: '^\\d+:[\\w-]{35,}$',
      patternMessage: 'Expected format: 123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      visibleByDefault: true },
    { key: 'mode', label: 'Receiving Mode', type: 'select', displayAs: 'radio-cards', required: true, default: 'polling',
      options: [
        { label: 'Long Polling', value: 'polling',
          description: 'Works everywhere. Recommended for getting started.' },
        { label: 'Webhook', value: 'webhook',
          description: 'Requires a public HTTPS URL. Best for production.' },
      ] },
    { key: 'webhookUrl', label: 'Webhook URL', type: 'url', required: true,
      placeholder: 'https://your-domain.com/relay/webhooks/telegram',
      description: 'Public HTTPS URL where Telegram sends updates.',
      showWhen: { field: 'mode', equals: 'webhook' } },
    { key: 'webhookPort', label: 'Webhook Port', type: 'number', required: false, default: 8443,
      description: 'Port for the webhook HTTP server.',
      showWhen: { field: 'mode', equals: 'webhook' } },
    { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', required: false,
      placeholder: 'Auto-generated if empty',
      description: 'Secret token for validating incoming webhook requests from Telegram.',
      showWhen: { field: 'mode', equals: 'webhook' } },
  ],
  setupInstructions:
    'Open Telegram and search for @BotFather. Send /newbot, choose a name and username. Copy the token provided.',
};

/**
 * Telegram Bot API adapter for the Relay message bus.
 *
 * Implements {@link RelayAdapter} to bridge Telegram chats into the Relay
 * subject hierarchy. Delegates heavy logic to sub-modules while owning
 * lifecycle, polling reconnection, and state management.
 */
export class TelegramAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix = SUBJECT_PREFIX;
  readonly displayName: string;

  /** Reconnection delay schedule (ms) -- exponential backoff. */
  private static readonly RECONNECT_DELAYS = [5_000, 10_000, 30_000, 60_000, 60_000];

  private readonly config: TelegramAdapterConfig;
  private bot: Bot | null = null;
  private webhookServer: Server | null = null;
  private relay: RelayPublisher | null = null;
  private signalUnsub: Unsubscribe | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private responseBuffers = new Map<number, string>();
  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  constructor(id: string, config: TelegramAdapterConfig, displayName = 'Telegram') {
    this.id = id;
    this.config = config;
    this.displayName = displayName;
  }

  /** Validate the bot token without starting polling or webhook. */
  async testConnection(): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
    try {
      const bot = new Bot(this.config.token);
      await bot.init();
      return { ok: true, botUsername: bot.botInfo.username };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Start the adapter. Idempotent. */
  async start(relay: RelayPublisher): Promise<void> {
    if (this.bot !== null) return;
    this.relay = relay;
    this.status = { ...this.status, state: 'starting', startedAt: new Date().toISOString() };

    const bot = new Bot(this.config.token);
    bot.api.config.use(autoRetry());
    bot.on('message', (ctx) =>
      handleInboundMessage(ctx, this.relay!, this.status, this.makeCallbacks()),
    );
    bot.catch((err) => this.recordError(err));
    this.bot = bot;

    this.signalUnsub = relay.onSignal(`${SUBJECT_PREFIX}.>`, (subject: string, signal: Signal) => {
      if (signal.type === 'typing') void handleTypingSignal(this.bot, subject, signal.state);
    });

    if (this.config.mode === 'webhook') {
      this.webhookServer = await startWebhookMode(
        bot, this.id, this.config.webhookUrl, this.config.webhookPort, this.config.webhookSecret,
      );
    } else {
      await this.startPollingMode(bot);
    }
    this.status = { ...this.status, state: 'connected' };
  }

  /** Stop the adapter. Idempotent. */
  async stop(): Promise<void> {
    if (this.bot === null) return;
    this.status = { ...this.status, state: 'stopping' };

    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.signalUnsub) { this.signalUnsub(); this.signalUnsub = null; }

    if (this.config.mode === 'webhook') {
      try { await this.bot.api.deleteWebhook(); } catch { /* best-effort */ }
    }
    try {
      if (this.config.mode === 'polling') await this.bot.stop();
      await stopWebhookServer(this.webhookServer);
      this.webhookServer = null;
    } catch (err) {
      this.recordError(err);
    } finally {
      this.bot = null;
      this.relay = null;
      this.reconnectAttempts = 0;
      this.status = {
        state: 'disconnected',
        messageCount: this.status.messageCount,
        errorCount: this.status.errorCount,
      };
    }
  }

  /** Deliver a Relay message to Telegram. Delegates to outbound module. */
  async deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult> {
    return deliverMessage(
      this.id, subject, envelope, context,
      this.bot, this.responseBuffers, this.status, this.makeCallbacks(),
    );
  }

  /** Return the current adapter status snapshot. */
  getStatus(): AdapterStatus {
    return { ...this.status };
  }

  // --- Private helpers ---

  /** Build the callbacks object that sub-modules use to mutate adapter state. */
  private makeCallbacks() {
    return {
      updateStatus: (patch: Partial<AdapterStatus>) => { this.status = { ...this.status, ...patch }; },
      recordError: (err: unknown) => this.recordError(err),
    };
  }

  /** Start grammy bot in long-polling mode with eager token validation. */
  private async startPollingMode(bot: Bot): Promise<void> {
    await bot.init();
    bot.start({
      drop_pending_updates: true,
      onStart: () => { this.reconnectAttempts = 0; this.status = { ...this.status, state: 'connected' }; },
    }).catch((err: unknown) => this.handlePollingError(err));
  }

  /** Handle polling failure and schedule reconnection with exponential backoff. */
  private handlePollingError(err: unknown): void {
    this.recordError(err);
    if (this.reconnectAttempts >= TelegramAdapter.RECONNECT_DELAYS.length) {
      this.status = { ...this.status, lastError: 'Max reconnection attempts exhausted \u2014 adapter will not retry' };
      return;
    }
    const delay = TelegramAdapter.RECONNECT_DELAYS[this.reconnectAttempts]!;
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      if (this.status.state === 'disconnected' || this.status.state === 'stopping') return;
      try { await this.bot?.stop(); } catch { /* old bot likely dead */ }

      const newBot = new Bot(this.config.token);
      newBot.api.config.use(autoRetry());
      newBot.on('message', (ctx) =>
        handleInboundMessage(ctx, this.relay!, this.status, this.makeCallbacks()),
      );
      newBot.catch((e) => this.recordError(e));
      this.bot = newBot;
      this.startPollingMode(newBot).catch((e) => this.handlePollingError(e));
    }, delay);
  }

  /** Record an error in the adapter status without throwing. */
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
