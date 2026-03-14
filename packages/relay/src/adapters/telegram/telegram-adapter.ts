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
import { BaseRelayAdapter } from '../../base-adapter.js';
import type {
  RelayPublisher, AdapterContext,
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
      visibleByDefault: true,
      helpMarkdown: `1. Open Telegram and search for **@BotFather**
2. Send \`/newbot\` to start creating a bot
3. Choose a display name and username for your bot
4. BotFather will send you the token (format: \`123456789:ABCDefGHijklMNOpqrSTUvwxYZ\`)
5. If you already have a bot, send \`/myBots\` to BotFather to find existing tokens` },
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
      showWhen: { field: 'mode', equals: 'webhook' },
      helpMarkdown: `Your webhook URL must be:
- **HTTPS** (Telegram requires TLS)
- **Publicly accessible** from the internet
- Pointing to: \`https://your-domain.com/relay/webhooks/telegram\`

For local development, use a tunnel service (e.g., ngrok, Cloudflare Tunnel).` },
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
 * Extends {@link BaseRelayAdapter} to bridge Telegram chats into the Relay
 * subject hierarchy. Delegates heavy logic to sub-modules while owning
 * lifecycle, polling reconnection, and state management.
 */
export class TelegramAdapter extends BaseRelayAdapter {
  /** Reconnection delay schedule (ms) -- exponential backoff. */
  private static readonly RECONNECT_DELAYS = [5_000, 10_000, 30_000, 60_000, 60_000];

  private readonly config: TelegramAdapterConfig;
  private bot: Bot | null = null;
  private webhookServer: Server | null = null;
  private signalUnsub: Unsubscribe | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private responseBuffers = new Map<number, string>();

  constructor(id: string, config: TelegramAdapterConfig, displayName = 'Telegram') {
    super(id, SUBJECT_PREFIX, displayName);
    this.config = config;
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

  /** Connect to Telegram and start receiving messages. */
  protected async _start(relay: RelayPublisher): Promise<void> {
    const bot = new Bot(this.config.token);
    bot.api.config.use(autoRetry());
    bot.on('message', (ctx) =>
      handleInboundMessage(ctx, relay, this.makeInboundCallbacks()),
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
  }

  /** Disconnect from Telegram and clean up state. */
  protected async _stop(): Promise<void> {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.signalUnsub) { this.signalUnsub(); this.signalUnsub = null; }

    if (this.bot) {
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
        this.reconnectAttempts = 0;
      }
    }
  }

  /** Deliver a Relay message to Telegram. Delegates to outbound module. */
  async deliver(subject: string, envelope: RelayEnvelope, _context?: AdapterContext): Promise<DeliveryResult> {
    return deliverMessage({
      adapterId: this.id,
      subject,
      envelope,
      bot: this.bot,
      responseBuffers: this.responseBuffers,
      callbacks: this.makeOutboundCallbacks(),
    });
  }

  // --- Private helpers ---

  /** Build callbacks for inbound message handling. */
  private makeInboundCallbacks() {
    return {
      trackInbound: () => this.trackInbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }

  /** Build callbacks for outbound message delivery. */
  private makeOutboundCallbacks() {
    return {
      trackOutbound: () => this.trackOutbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }

  /** Start grammy bot in long-polling mode with eager token validation. */
  private async startPollingMode(bot: Bot): Promise<void> {
    await bot.init();
    bot.start({
      drop_pending_updates: true,
      onStart: () => { this.reconnectAttempts = 0; this.markConnected(); },
    }).catch((err: unknown) => this.handlePollingError(err));
  }

  /** Handle polling failure and schedule reconnection with exponential backoff. */
  private handlePollingError(err: unknown): void {
    this.recordError(err);
    if (this.reconnectAttempts >= TelegramAdapter.RECONNECT_DELAYS.length) {
      this.recordError(new Error('Max reconnection attempts exhausted \u2014 adapter will not retry'));
      return;
    }
    const delay = TelegramAdapter.RECONNECT_DELAYS[this.reconnectAttempts]!;
    this.reconnectAttempts++;
    this.setReconnecting();

    this.reconnectTimer = setTimeout(async () => {
      if (this.isStopped) return;
      try { await this.bot?.stop(); } catch { /* old bot likely dead */ }

      const newBot = new Bot(this.config.token);
      newBot.api.config.use(autoRetry());
      newBot.on('message', (ctx) =>
        handleInboundMessage(ctx, this.relay!, this.makeInboundCallbacks()),
      );
      newBot.catch((e) => this.recordError(e));
      this.bot = newBot;
      this.startPollingMode(newBot).catch((e) => this.handlePollingError(e));
    }, delay);
  }
}
