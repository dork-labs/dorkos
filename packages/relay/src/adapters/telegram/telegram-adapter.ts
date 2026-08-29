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
import type { Context, Filter } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { Server } from 'node:http';
import type { Signal, AdapterManifest, RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { DEFAULT_RESPOND_MODE } from '@dorkos/shared/relay-schemas';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type {
  RelayPublisher,
  AdapterContext,
  PublishOptions,
  DeliveryResult,
  TelegramAdapterConfig,
  Unsubscribe,
} from '../../types.js';
import { handleInboundMessage } from './inbound.js';
import { handleChatMemberUpdate } from './chat-member.js';
import { GrammyPlatformClient } from './grammy-platform-client.js';
import { TelegramThreadIdCodec } from '../../lib/thread-id.js';
import { mayApprove } from '../approver-allowlist.js';
import { createDeniedChatNotices, type DeniedChatNotices } from '../denied-chat-notices.js';
import {
  deliverMessage,
  handleTypingSignal,
  clearAllTypingIntervals,
  clearApprovalTimeout,
  createTelegramOutboundState,
} from './outbound.js';
import type { ResponseBuffer, TelegramOutboundState } from './outbound.js';
import { startWebhookMode, stopWebhookServer } from './webhook.js';
import { describeError } from '../../lib/describe-error.js';

/** Static adapter manifest for the Telegram built-in adapter. */
export const TELEGRAM_MANIFEST: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via a Telegram bot.',
  iconId: 'telegram',
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
    // `respondMode` belongs to a step because group behavior is the thing people
    // are surprised by, so it leads the guided flow rather than sitting under
    // "Advanced". Naming it is no longer what makes it reachable: since DOR-640
    // the wizard shows every declared field, putting the ones no step names on
    // the last step (`setupStepFields` in `@dorkos/shared`).
    {
      stepId: 'configure-mode',
      title: 'Choose how your bot connects and replies',
      description: 'How updates reach your bot, and when it joins in on group chats.',
      fields: ['mode', 'webhookUrl', 'webhookPort', 'webhookSecret', 'respondMode'],
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
    {
      key: 'respondMode',
      label: 'Replies in Groups',
      type: 'select',
      displayAs: 'radio-cards',
      // Required with an explicit default so the form always shows the choice.
      // Group behavior is the thing people are surprised by, so it should not be
      // something they only discover after the bot talks over everyone (DOR-619).
      required: true,
      default: 'thread-aware',
      description: 'When should the bot reply in a group chat?',
      options: [
        {
          label: 'When spoken to',
          value: 'thread-aware',
          description:
            'Reply when someone mentions the bot by name, and keep replying to anyone who replies to it.',
        },
        {
          label: 'Only when mentioned',
          value: 'mention-only',
          description: 'Reply only when someone types the bot name.',
        },
        {
          label: 'Every message',
          value: 'always',
          description: 'Reply to everything anyone says in the group.',
        },
      ],
      helpMarkdown:
        'This only affects group chats. In a one-on-one chat the bot always replies.\n\n' +
        'The bot never replies to another bot, whatever you pick here. That is what ' +
        'stops two bots in one group talking to each other forever.',
    },
    {
      key: 'dmPolicy',
      label: 'DM Access',
      type: 'select',
      // Required with an explicit default so the form always shows a choice —
      // the same reasoning as Slack's identical field: left optional, a person
      // who never touched it silently got the permissive value (DOR-604).
      required: true,
      default: 'allowlist',
      description:
        'Control who can message the bot privately. A private message can start an agent ' +
        'turn on your machine, and your bot handle is public.',
      section: 'Access Control',
      options: [
        {
          label: 'Open (anyone)',
          value: 'open',
          description: 'Anyone who finds the bot on Telegram can message it.',
        },
        {
          label: 'Allowlist only',
          value: 'allowlist',
          description: 'Only users in the allowlist can message the bot privately.',
        },
      ],
      displayAs: 'radio-cards',
    },
    {
      key: 'dmAllowlist',
      label: 'DM Allowlist',
      type: 'textarea',
      valueShape: 'id-list',
      required: false,
      description: 'Telegram user IDs allowed to message the bot privately (one per line).',
      placeholder: '123456789\n987654321',
      section: 'Access Control',
      showWhen: { field: 'dmPolicy', equals: 'allowlist' },
      helpMarkdown:
        'A Telegram user ID is a number, not a @handle. The log line DorkOS writes when it ' +
        'turns someone away names the exact id to paste here.',
    },
    {
      key: 'approverAllowlist',
      label: 'Approvers',
      type: 'textarea',
      valueShape: 'id-list',
      required: false,
      section: 'Access Control',
      description:
        'Telegram user IDs who may approve a tool call from Telegram (one per line). ' +
        'Empty means nobody can — approvals will be declined.',
      placeholder: '123456789\n987654321',
      helpMarkdown:
        'When your agent needs permission to run something, it sends an Approve/Deny card ' +
        'into the chat. Only the people listed here can answer it.\n\n' +
        'Leave it empty and nothing gets approved from Telegram.',
    },
  ],
  setupInstructions:
    'Open Telegram and search for @BotFather. Send /newbot, choose a name and username. Copy the token provided.',
};

/**
 * Telegram's own error code, when the caught error is a grammY `GrammyError`.
 *
 * Duck-typed on `error_code` rather than `instanceof GrammyError`, the same
 * reason `classifyTelegramSendError` in outbound.ts is: this adapter's own
 * tests mock the `grammy` module, so a thrown error is never an instance of
 * the class this file would import.
 *
 * @param err - The error to inspect.
 */
function extractTelegramErrorCode(err: unknown): string | undefined {
  const errorCode = (err as { error_code?: unknown } | null)?.error_code;
  return typeof errorCode === 'number' ? String(errorCode) : undefined;
}

/**
 * Telegram Bot API adapter for the Relay message bus.
 *
 * Extends {@link BaseRelayAdapter} to bridge Telegram chats into the Relay
 * subject hierarchy. Delegates heavy logic to sub-modules while owning
 * lifecycle, polling reconnection, and state management.
 */
export class TelegramAdapter extends BaseRelayAdapter {
  /** Timeout for bot.init() and setWebhook() calls (ms). */
  private static readonly INIT_TIMEOUT_MS = 15_000;

  /** Reconnection delay schedule (ms) -- exponential backoff. */
  private static readonly RECONNECT_DELAYS = [5_000, 10_000, 30_000, 60_000, 60_000];

  /**
   * How many times a single Telegram API call is retried before the error is
   * allowed through.
   *
   * `autoRetry()`'s own defaults are `maxRetryAttempts: Infinity` and
   * `maxDelaySeconds: Infinity`, and it wraps `getUpdates` along with every
   * other call. Unbounded, a bot whose token was revoked — or whose network is
   * gone — retried in silence forever while the adapter still reported
   * `connected`: no error surfaced, no reconnect scheduled, no message
   * delivered. A bounded retry hands the failure back to grammy, which routes
   * it to {@link handlePollingError} (backoff, `setReconnecting`, and a recorded
   * error) or to `bot.catch` for a one-off call. Three attempts and a one-minute
   * cap absorb a rate-limit spike, which is what auto-retry is for.
   */
  private static readonly MAX_API_RETRIES = 3;

  /**
   * Longest single `retry_after` this adapter waits out (seconds).
   *
   * The cap is also what bounds shutdown. `@grammyjs/auto-retry` sleeps on a
   * plain `setTimeout` it never `unref`s (`pause()` in its `mod.js`), so a
   * pending retry holds the Node process open for the whole delay; the library
   * exposes no hook to change that. Uncapped, a server told to stop could sit
   * waiting on a Telegram `retry_after` of an hour. Capped, the worst case is a
   * minute.
   */
  private static readonly MAX_RETRY_DELAY_SECS = 60;

  private readonly config: TelegramAdapterConfig;
  private bot: Bot | null = null;
  private webhookServer: Server | null = null;
  private signalUnsub: Unsubscribe | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private responseBuffers = new Map<number, ResponseBuffer>();
  /** Instance-scoped outbound state — prevents cross-adapter leakage when multiInstance: true. */
  private readonly outboundState: TelegramOutboundState = createTelegramOutboundState();
  /**
   * Which private chats this instance has already explained turning away.
   * Instance-scoped for the same reason the outbound state is: two Telegram
   * integrations must not silence each other's notices.
   */
  private readonly deniedNotices: DeniedChatNotices = createDeniedChatNotices();
  private platformClient: GrammyPlatformClient | null = null;
  private readonly codec: TelegramThreadIdCodec;

  constructor(id: string, config: TelegramAdapterConfig, displayName = 'Telegram') {
    const codec = new TelegramThreadIdCodec(id);
    super(id, codec.prefix, displayName);
    this.codec = codec;
    this.config = config;
  }

  /** Validate the bot token without starting polling or webhook. */
  async testConnection(): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
    try {
      const bot = new Bot(this.config.token);
      await this.initBotWithTimeout(bot);
      return { ok: true, botUsername: bot.botInfo.username };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Telegram's own `getMe`, exposing `can_read_all_group_messages` (renamed
   * here to `canReadAllGroupMessages`) and the bot's `username`.
   *
   * §8's group-visibility badge must be sourced from the platform and never
   * from config: a person can flip Telegram's own privacy-mode switch
   * without touching this integration's settings at all, so a config-derived
   * badge would drift from reality the moment they did. `username` is a
   * second addressing candidate for a bridged room — Telegram addresses a
   * bot as `@botusername`, which is not the agent's DorkOS handle (spec
   * §5.4, §11.2).
   *
   * Returns `null` before the adapter has connected: there is no live bot to
   * ask, and this deliberately does not spin one up the way
   * {@link testConnection} does, because a caller polling this before start
   * should see "not yet known" rather than pay for a throwaway connection.
   *
   * UNCACHED: every call is a live `getMe` round trip to the Bot API, not a
   * read of `this.bot.botInfo` (which grammy fills in once, at `bot.init()`,
   * and never refreshes) — a person can flip Telegram's privacy-mode switch
   * at any time, and the point of this accessor is to answer with what is
   * true right now. It THROWS if that call fails (a network error, a revoked
   * token); it does not swallow the error into a `null` the way the
   * before-start case does, because "the platform refused to answer" and
   * "nobody has asked the platform yet" are different failures and a caller
   * needs to tell them apart. Caching the answer and deciding how to handle a
   * failed refresh — the "stale value on error" fallback that visibility
   * §8's `visibilityCheckedAt` calls for — is the bridge's job (task 1.6/1.13),
   * not this accessor's.
   */
  async getMe(): Promise<{ username: string; canReadAllGroupMessages: boolean } | null> {
    if (!this.bot) return null;
    const me = await this.bot.api.getMe();
    return { username: me.username, canReadAllGroupMessages: me.can_read_all_group_messages };
  }

  /**
   * Leave a chat — the group-add claim flow's "Leave" action (DOR-883, spec
   * §12). A real platform removal, not a DorkOS-side mute: after this call the
   * bot is no longer a member of `chatId`, and nothing further from it can
   * arrive by any path. The caller (the claim route) owns dismissing the
   * card; this method writes nothing of its own.
   *
   * Telegram's `leaveChat` accepts the chat id as a string or a number and
   * treats a numeric string identically to the number it names, so the id is
   * passed through exactly as the claim feed stored it — no coercion, no
   * second parse of a value already validated on the way in.
   *
   * @param chatId - The Telegram chat id to leave.
   * @throws When the adapter is not connected, or Telegram refuses the call
   *   (the bot was already removed, or the id no longer resolves).
   */
  async leaveChat(chatId: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter is not connected');
    await this.bot.api.leaveChat(chatId);
  }

  /** Connect to Telegram and start receiving messages. */
  protected async _start(relay: RelayPublisher): Promise<void> {
    const bot = new Bot(this.config.token);
    this.wireBot(bot, relay);
    this.bot = bot;
    this.platformClient = new GrammyPlatformClient(bot, this.logger);

    this.signalUnsub = relay.onSignal(
      `${this.codec.prefix}.>`,
      (subject: string, signal: Signal) => {
        // 'progress' is the bridge's presence forwarder (spec §6.8):
        // `publishPresence` (`room-trigger.ts`) deliberately emits `progress`,
        // not `typing` — agents work, they do not type. Same indicator,
        // same handler; no new signal type, no second indicator.
        if (signal.type === 'typing' || signal.type === 'progress')
          handleTypingSignal(this.bot, subject, this.outboundState, signal.state, this.codec);
      }
    );

    if (this.config.mode === 'webhook') {
      this.logger.info('starting webhook mode', {
        url: this.config.webhookUrl,
        port: this.config.webhookPort,
      });
      this.webhookServer = await startWebhookMode(
        bot,
        this.id,
        this.config.webhookUrl,
        this.config.webhookPort,
        this.config.webhookSecret,
        TelegramAdapter.INIT_TIMEOUT_MS
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

    if (this.platformClient) {
      await this.platformClient.destroy();
      this.platformClient = null;
    }

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
      codec: this.codec,
      logger: this.logger,
    });
  }

  // --- Private helpers ---

  /**
   * Register all update handlers on a Bot instance.
   *
   * Used by both `_start()` and the polling reconnect path so a rebuilt bot
   * carries the full handler set — a reconnect that re-registered only the
   * message handler would leave approval buttons dead after a network blip.
   */
  private wireBot(bot: Bot, relay: RelayPublisher): void {
    bot.api.config.use(
      autoRetry({
        maxRetryAttempts: TelegramAdapter.MAX_API_RETRIES,
        maxDelaySeconds: TelegramAdapter.MAX_RETRY_DELAY_SECS,
      })
    );
    bot.on('message', (ctx) =>
      handleInboundMessage(ctx, relay, this.makeInboundCallbacks(), this.logger, this.codec, {
        // Fall back to the schema's own default rather than restating one here:
        // a config that reached this point without a `respondMode` went through
        // neither the schema nor the setup form, and nothing about it says the
        // operator wanted the bot answering every message in every group.
        respondMode: this.config.respondMode ?? DEFAULT_RESPOND_MODE,
        // Same reasoning for private chats, and the same default Slack uses.
        // `inbound.ts` resolves an absent policy to `'allowlist'` too, so the
        // closed value is what an unconfigured integration lands on wherever
        // the decision is made.
        dmPolicy: this.config.dmPolicy,
        dmAllowlist: this.config.dmAllowlist,
        deniedNotices: this.deniedNotices,
      })
    );
    // The group-add claim flow's entry point (DOR-883): the bot's own
    // membership changing, never carried by 'message'. See `chat-member.ts`'s
    // module doc for why this is safe to publish unconditionally, including
    // on a chat that already has a binding.
    bot.on('my_chat_member', (ctx) =>
      handleChatMemberUpdate(ctx, relay, this.makeInboundCallbacks(), this.logger, this.codec)
    );
    // Callback query handler for tool approval inline keyboard buttons
    bot.on('callback_query:data', (ctx) => this.handleApprovalCallback(ctx, relay));
    bot.catch((err) => this.recordError(err));
  }

  /**
   * Handle an Approve/Deny inline keyboard press for a tool approval card.
   *
   * Resolves the short callback key to the stored approval IDs, publishes an
   * `approval_response` to the relay bus, and edits the card to show the
   * decision result.
   */
  private async handleApprovalCallback(
    ctx: Filter<Context, 'callback_query:data'>,
    relay: RelayPublisher
  ): Promise<void> {
    try {
      const data = JSON.parse(ctx.callbackQuery.data) as { k: string; a: number };
      const entry = this.outboundState.callbackIdMap.get(data.k);

      if (!entry) {
        await ctx.answerCallbackQuery({ text: 'This approval has expired.' });
        return;
      }

      // Authorization, not identification. `respondedBy` below records who
      // acted; it never decided who may. Without this check the person whose
      // message triggered the tool call could approve it themselves, one tap,
      // from their own device (DOR-609). Left pending rather than consumed, so
      // an authorized approver can still answer the same card.
      if (!mayApprove(this.config.approverAllowlist, String(ctx.from.id))) {
        this.logger.warn(
          `[Telegram] refused tool approval from unauthorized user ${ctx.from.id}` +
            ` for toolCallId=${entry.toolCallId}`
        );
        await ctx.answerCallbackQuery({
          text: 'You are not on this integration’s approver list.',
          show_alert: true,
        });
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

      // Edit message to show decision result. HTML parse mode matches the
      // approval card — legacy Markdown mode hard-fails on unbalanced entities.
      const decision = approved ? 'Approved' : 'Denied';
      const emoji = approved ? '✅' : '❌';
      await ctx.editMessageText(`${emoji} <b>Tool ${decision}</b>`, { parse_mode: 'HTML' });
      await ctx.answerCallbackQuery({ text: `Tool ${decision}` });

      this.logger.debug?.(
        `[Telegram] tool ${approved ? 'approved' : 'denied'}: toolCallId=${entry.toolCallId}`
      );
    } catch (err) {
      this.logger.error(
        '[Telegram] callback query handler error:',
        describeError(err, extractTelegramErrorCode)
      );
      this.recordError(err);
      await ctx.answerCallbackQuery({ text: 'Error processing approval.' }).catch(() => {});
    }
  }

  /**
   * Call bot.init() with a timeout guard.
   *
   * Prevents indefinite hangs when the Telegram API is unreachable or the
   * token is invalid but the connection never closes.
   */
  private async initBotWithTimeout(bot: Bot): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      bot.init(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Telegram bot token validation timed out — check your token and network connectivity'
              )
            ),
          TelegramAdapter.INIT_TIMEOUT_MS
        );
      }),
    ]).finally(() => clearTimeout(timer!));
  }

  /** Start grammy bot in long-polling mode with eager token validation. */
  private async startPollingMode(bot: Bot): Promise<void> {
    await this.initBotWithTimeout(bot);
    this.logger.info('bot validated', { username: bot.botInfo.username, mode: 'polling' });
    this.logger.info('starting polling mode');
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
      this.wireBot(newBot, this.relay!);
      this.bot = newBot;

      // Refresh the platform client so streaming wraps the live Bot instance
      // instead of the dead one.
      const oldClient = this.platformClient;
      this.platformClient = new GrammyPlatformClient(newBot, this.logger);
      if (oldClient) await oldClient.destroy();

      this.startPollingMode(newBot).catch((e) => this.handlePollingError(e));
    }, delay);
  }
}
