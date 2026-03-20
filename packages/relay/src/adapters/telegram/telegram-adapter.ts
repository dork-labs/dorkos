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
  RelayPublisher,
  AdapterContext,
  PublishOptions,
  DeliveryResult,
  TelegramAdapterConfig,
  Unsubscribe,
} from '../../types.js';
import { SUBJECT_PREFIX, handleInboundMessage } from './inbound.js';
import {
  deliverMessage,
  handleTypingSignal,
  clearAllTypingIntervals,
  clearApprovalTimeout,
  createTelegramOutboundState,
} from './outbound.js';
import type { ResponseBuffer, TelegramOutboundState } from './outbound.js';
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
    {
      key: 'token',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: '123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      description:
        'Paste the token from @BotFather. Message @BotFather on Telegram → /newbot → copy the token.',
      pattern: '^\\d+:[\\w-]{35,}$',
      patternMessage: 'Expected format: 123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      visibleByDefault: true,
      helpMarkdown: `1. Open Telegram and search for **@BotFather**
2. Send \`/newbot\` to start creating a bot
3. Choose a display name and username for your bot
4. BotFather will send you the token (format: \`123456789:ABCDefGHijklMNOpqrSTUvwxYZ\`)
5. If you already have a bot, send \`/myBots\` to BotFather to find existing tokens`,
    },
    {
      key: 'mode',
      label: 'Receiving Mode',
      type: 'select',
      displayAs: 'radio-cards',
      required: true,
      default: 'polling',
      options: [
        {
          label: 'Long Polling',
          value: 'polling',
          description: 'Works everywhere. Recommended for getting started.',
        },
        {
          label: 'Webhook',
          value: 'webhook',
          description: 'Requires a public HTTPS URL. Best for production.',
        },
      ],
    },
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://your-domain.com/relay/webhooks/telegram',
      description: 'Public HTTPS URL where Telegram sends updates.',
      showWhen: { field: 'mode', equals: 'webhook' },
      helpMarkdown: `Your webhook URL must be:
- **HTTPS** (Telegram requires TLS)
- **Publicly accessible** from the internet
- Pointing to: \`https://your-domain.com/relay/webhooks/telegram\`

For local development, use a tunnel service (e.g., ngrok, Cloudflare Tunnel).`,
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
    {
      key: 'webhookSecret',
      label: 'Webhook Secret',
      type: 'password',
      required: false,
      placeholder: 'Auto-generated if empty',
      description: 'Secret token for validating incoming webhook requests from Telegram.',
      showWhen: { field: 'mode', equals: 'webhook' },
    },
    {
      key: 'streaming',
      label: 'Streaming',
      type: 'boolean',
      required: false,
      description:
        "Stream responses in real-time using Telegram's sendMessageDraft API (DMs only). Groups always use buffer-and-flush.",
      visibleByDefault: true,
      helpMarkdown:
        'When enabled, recipients in DMs see text appearing in real-time (ChatGPT-style). ' +
        'Group chats always use buffer-and-flush regardless of this setting. ' +
        'Requires Telegram Bot API 9.5+.',
    },
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
  private responseBuffers = new Map<number, ResponseBuffer>();
  /** Instance-scoped outbound state — prevents cross-adapter leakage when multiInstance: true. */
  private readonly outboundState: TelegramOutboundState = createTelegramOutboundState();

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
      handleInboundMessage(ctx, relay, this.makeInboundCallbacks(), this.logger)
    );

    // Register callback query handler for tool approval inline keyboard buttons
    bot.on('callback_query:data', async (ctx) => {
      try {
        const data = JSON.parse(ctx.callbackQuery.data) as { k: string; a: number };
        const entry = this.outboundState.callbackIdMap.get(data.k);

        if (!entry) {
          await ctx.answerCallbackQuery({ text: 'This approval has expired.' });
          return;
        }

        const approved = data.a === 1;
        this.outboundState.callbackIdMap.delete(data.k);
        clearApprovalTimeout(this.outboundState, data.k);

        // Publish approval response to relay bus
        const opts: PublishOptions = { from: `telegram:${ctx.from.id}` };
        await relay.publish(
          `relay.system.approval.${entry.agentId}`,
          {
            type: 'approval_response',
            toolCallId: entry.toolCallId,
            sessionId: entry.sessionId,
            approved,
            respondedBy: String(ctx.from.id),
            platform: 'telegram',
          },
          opts
        );

        // Edit message to show decision result
        const decision = approved ? 'Approved' : 'Denied';
        const emoji = approved ? '\u2705' : '\u274C';
        await ctx.editMessageText(`${emoji} *Tool ${decision}*`, { parse_mode: 'Markdown' });
        await ctx.answerCallbackQuery({ text: `Tool ${decision}` });

        this.logger.debug?.(
          `[Telegram] tool ${approved ? 'approved' : 'denied'}: toolCallId=${entry.toolCallId}`
        );
      } catch (err) {
        this.logger.error('[Telegram] callback query handler error:', err);
        this.recordError(err);
        await ctx.answerCallbackQuery({ text: 'Error processing approval.' }).catch(() => {});
      }
    });

    bot.catch((err) => this.recordError(err));
    this.bot = bot;

    this.signalUnsub = relay.onSignal(`${SUBJECT_PREFIX}.>`, (subject: string, signal: Signal) => {
      if (signal.type === 'typing')
        void handleTypingSignal(this.bot, subject, this.outboundState, signal.state);
    });

    if (this.config.mode === 'webhook') {
      this.webhookServer = await startWebhookMode(
        bot,
        this.id,
        this.config.webhookUrl,
        this.config.webhookPort,
        this.config.webhookSecret
      );
    } else {
      await this.startPollingMode(bot);
    }
  }

  /** Disconnect from Telegram and clean up state. */
  protected async _stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.signalUnsub) {
      this.signalUnsub();
      this.signalUnsub = null;
    }
    clearAllTypingIntervals(this.outboundState);

    // Clear all pending approval timeouts to prevent dangling timers
    for (const timer of this.outboundState.pendingApprovalTimeouts.values()) clearTimeout(timer);
    this.outboundState.pendingApprovalTimeouts.clear();
    this.outboundState.callbackIdMap.clear();

    if (this.bot) {
      if (this.config.mode === 'webhook') {
        try {
          await this.bot.api.deleteWebhook();
        } catch {
          /* best-effort */
        }
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
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext
  ): Promise<DeliveryResult> {
    return deliverMessage({
      adapterId: this.id,
      subject,
      envelope,
      bot: this.bot,
      responseBuffers: this.responseBuffers,
      state: this.outboundState,
      callbacks: this.makeOutboundCallbacks(),
      streaming: this.config.streaming ?? true,
      logger: this.logger,
    });
  }

  // --- Private helpers ---

  /** Start grammy bot in long-polling mode with eager token validation. */
  private async startPollingMode(bot: Bot): Promise<void> {
    await bot.init();
    bot
      .start({
        drop_pending_updates: true,
        onStart: () => {
          this.reconnectAttempts = 0;
          this.markConnected();
        },
      })
      .catch((err: unknown) => this.handlePollingError(err));
  }

  /** Handle polling failure and schedule reconnection with exponential backoff. */
  private handlePollingError(err: unknown): void {
    this.recordError(err);
    if (this.reconnectAttempts >= TelegramAdapter.RECONNECT_DELAYS.length) {
      this.recordError(
        new Error('Max reconnection attempts exhausted \u2014 adapter will not retry')
      );
      return;
    }
    const delay = TelegramAdapter.RECONNECT_DELAYS[this.reconnectAttempts]!;
    this.reconnectAttempts++;
    this.setReconnecting();

    this.reconnectTimer = setTimeout(async () => {
      if (this.isStopped) return;
      try {
        await this.bot?.stop();
      } catch {
        /* old bot likely dead */
      }

      const newBot = new Bot(this.config.token);
      newBot.api.config.use(autoRetry());
      newBot.on('message', (ctx) =>
        handleInboundMessage(ctx, this.relay!, this.makeInboundCallbacks(), this.logger)
      );
      newBot.catch((e) => this.recordError(e));
      this.bot = newBot;
      this.startPollingMode(newBot).catch((e) => this.handlePollingError(e));
    }, delay);
  }
}
