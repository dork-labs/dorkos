/**
 * Slack adapter for the Relay message bus.
 *
 * Thin facade composing inbound parsing and outbound delivery sub-modules
 * into a single cohesive adapter class. Uses Socket Mode via @slack/bolt
 * for receiving events without requiring a public URL.
 *
 * @module relay/adapters/slack-adapter
 */
import { App, LogLevel } from '@slack/bolt';
import type { RelayEnvelope, SlackAdapterConfig } from '@dorkos/shared/relay-schemas';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  PublishOptions,
} from '../../types.js';
import { handleInboundMessage, clearCaches } from './inbound.js';
import type { InboundOptions } from './inbound.js';
import { ThreadParticipationTracker } from './thread-tracker.js';
import {
  deliverMessage,
  clearApprovalTimeout,
  createSlackOutboundState,
  clearAllApprovalTimeouts,
} from './outbound.js';
import type { ActiveStream, SlackOutboundState } from './outbound.js';
import { SlackPlatformClient } from './slack-platform-client.js';
import { SlackThreadIdCodec } from '../../lib/thread-id.js';
import { FATAL_SLACK_ERRORS, SLACK_MANIFEST } from './slack-manifest.js';

// Re-export for consumers that import from this module
export { SLACK_MANIFEST };

/**
 * Slack adapter for the Relay message bus.
 *
 * Extends {@link BaseRelayAdapter} to bridge Slack channels and DMs
 * into the Relay subject hierarchy via Socket Mode. Delegates heavy
 * logic to inbound.ts and outbound.ts sub-modules.
 */
export class SlackAdapter extends BaseRelayAdapter {
  /** Timeout for auth.test() calls (ms). */
  private static readonly INIT_TIMEOUT_MS = 15_000;

  private readonly config: SlackAdapterConfig;
  private app: App | null = null;
  /** Bot's own user ID — cached after auth.test for echo prevention. */
  private botUserId = '';
  private streamState = new Map<string, ActiveStream>();
  /** FIFO queue of message timestamps with pending hourglass reactions, keyed by channelId. */
  private pendingReactions: import('./stream.js').PendingReactions = new Map();
  private readonly outboundState: SlackOutboundState = createSlackOutboundState();
  private platformClient: SlackPlatformClient | null = null;
  private readonly codec: SlackThreadIdCodec;
  private readonly threadTracker: ThreadParticipationTracker;

  constructor(id: string, config: SlackAdapterConfig, displayName = 'Slack') {
    const codec = new SlackThreadIdCodec(id);
    super(id, codec.prefix, displayName);
    this.codec = codec;
    this.config = config;
    this.threadTracker = new ThreadParticipationTracker();
  }

  /** Build InboundOptions from adapter config, with an optional event ID. */
  private buildInboundOptions(eventId?: string, respondModeOverride?: 'always'): InboundOptions {
    const allowlist = Array.isArray(this.config.dmAllowlist)
      ? this.config.dmAllowlist
      : typeof this.config.dmAllowlist === 'string'
        ? (this.config.dmAllowlist as string)
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    // channelOverrides may arrive as a JSON string from the UI textarea field
    // when Zod union falls back to the generic record schema. Parse defensively
    // so the feature works regardless of config source.
    let overrides: Record<string, import('./inbound.js').ChannelOverride> = {};
    const rawOverrides: unknown = this.config.channelOverrides;
    if (typeof rawOverrides === 'object' && rawOverrides !== null && !Array.isArray(rawOverrides)) {
      overrides = rawOverrides as typeof overrides;
    } else if (typeof rawOverrides === 'string' && rawOverrides.trim().startsWith('{')) {
      try {
        overrides = JSON.parse(rawOverrides) as typeof overrides;
      } catch {
        this.logger.warn('channelOverrides: invalid JSON, ignoring');
      }
    }

    return {
      eventId,
      respondMode: respondModeOverride ?? this.config.respondMode ?? 'thread-aware',
      dmPolicy: this.config.dmPolicy ?? 'open',
      dmAllowlist: allowlist,
      channelOverrides: overrides,
      threadTracker: this.threadTracker,
    };
  }

  /**
   * Validate credentials without starting Socket Mode.
   *
   * Creates a temporary WebClient, calls auth.test, and returns the result.
   * No side effects (no Socket Mode connection, no event listeners).
   */
  async testConnection(): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
    try {
      // Import WebClient directly to avoid starting a full Bolt app
      const { WebClient } = await import('@slack/web-api');
      const tempClient = new WebClient(this.config.botToken);
      const result = await SlackAdapter.withInitTimeout(tempClient.auth.test());
      return { ok: true, botUsername: result.user as string | undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Connect to Slack via Socket Mode and register event listeners. */
  protected async _start(relay: RelayPublisher): Promise<void> {
    const app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      signingSecret: this.config.signingSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Cache bot's own user ID for echo prevention
    const authResult = await SlackAdapter.withInitTimeout(app.client.auth.test());
    this.botUserId = (authResult.user_id as string) ?? '';
    this.logger.info('authenticated', {
      botUserId: this.botUserId,
      workspace: authResult.team as string | undefined,
    });

    // Register event listeners before starting
    app.message(async ({ event, client, body }) => {
      const eventId = (body as { event_id?: string }).event_id;
      await handleInboundMessage(
        event as Parameters<typeof handleInboundMessage>[0],
        client,
        relay,
        this.botUserId,
        this.makeInboundCallbacks(),
        this.logger,
        this.config.typingIndicator ?? 'none',
        this.pendingReactions,
        this.codec,
        this.buildInboundOptions(eventId)
      );
    });

    // app_mention events are already filtered by Slack to only include @mentions,
    // so bypass respond mode gating by forcing 'always'.
    app.event('app_mention', async ({ event, client, body }) => {
      const eventId = (body as { event_id?: string }).event_id;
      await handleInboundMessage(
        event as Parameters<typeof handleInboundMessage>[0],
        client,
        relay,
        this.botUserId,
        this.makeInboundCallbacks(),
        this.logger,
        this.config.typingIndicator ?? 'none',
        this.pendingReactions,
        this.codec,
        this.buildInboundOptions(eventId, 'always')
      );
    });

    // Register tool approval action handlers (Approve/Deny buttons)
    app.action('tool_approve', async ({ ack, action, body, client }) => {
      await ack();
      await this.handleToolAction(true, action, body, client, relay);
    });
    app.action('tool_deny', async ({ ack, action, body, client }) => {
      await ack();
      await this.handleToolAction(false, action, body, client, relay);
    });

    // Surface unhandled listener errors through adapter status.
    // Fatal auth errors stop the adapter to prevent retry loops.
    app.error(async (error) => {
      const errorCode =
        (error as { code?: string }).code ?? (error as { data?: { error?: string } }).data?.error;

      if (errorCode && FATAL_SLACK_ERRORS.has(errorCode)) {
        this.logger.error('fatal Slack error — stopping adapter', { errorCode });
        this.recordError(
          `Fatal Slack error: ${errorCode}. Re-check your bot token and app configuration.`
        );
        try {
          await app.stop();
        } catch {
          // best-effort — app may already be disconnected
        }
        return;
      }

      this.recordError(error);
    });

    // Start the Bolt app (Socket Mode connects automatically)
    this.logger.info('connecting via Socket Mode');
    await app.start();
    this.app = app;
    this.platformClient = new SlackPlatformClient(
      app.client,
      { nativeStreaming: this.config.nativeStreaming },
      this.logger
    );
  }

  /** Disconnect from Slack and clean up state. */
  protected async _stop(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // best-effort — app may already be disconnected
      }
      this.app = null;
    }
    if (this.platformClient) {
      await this.platformClient.destroy();
      this.platformClient = null;
    }
    this.botUserId = '';
    this.streamState.clear();
    this.pendingReactions.clear();
    this.threadTracker.clear();
    clearAllApprovalTimeouts(this.outboundState);
    clearCaches();
  }

  /**
   * Deliver a Relay message to Slack.
   *
   * Delegates to the outbound module for stream-aware delivery.
   *
   * @param subject - The target Relay subject (e.g. relay.human.slack.D123456)
   * @param envelope - The relay envelope to deliver
   * @param _context - Optional adapter context (unused by this adapter)
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext
  ): Promise<DeliveryResult> {
    return deliverMessage({
      adapterId: this.id,
      subject,
      envelope,
      client: this.app?.client ?? null,
      streamState: this.streamState,
      pendingReactions: this.pendingReactions,
      botUserId: this.botUserId,
      callbacks: this.makeOutboundCallbacks(),
      streaming: this.config.streaming ?? true,
      nativeStreaming: this.config.nativeStreaming ?? true,
      typingIndicator: this.config.typingIndicator ?? 'none',
      approvalState: this.outboundState,
      codec: this.codec,
      threadTracker: this.threadTracker,
      logger: this.logger,
    });
  }

  /**
   * Wrap a promise with a timeout guard.
   *
   * Used for auth.test() calls in both `_start()` and `testConnection()` to
   * prevent indefinite hangs when the Slack API is unreachable.
   */
  private static async withInitTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Slack auth.test() timed out — check your bot token and network connectivity'
              )
            ),
          SlackAdapter.INIT_TIMEOUT_MS
        );
      }),
    ]).finally(() => clearTimeout(timer!));
  }

  /**
   * Handle a tool approval or denial action from Slack interactive buttons.
   *
   * Parses the button value JSON, publishes an `approval_response` to the
   * relay bus, and updates the original Slack message to reflect the decision.
   *
   * @param approved - Whether the user clicked Approve (true) or Deny (false)
   * @param action - The Bolt action payload
   * @param body - The Bolt body payload containing message context
   * @param client - The Slack WebClient for updating messages
   * @param relay - The relay publisher for publishing approval responses
   */
  private async handleToolAction(
    approved: boolean,
    action: unknown,
    body: unknown,
    client: import('@slack/web-api').WebClient,
    relay: RelayPublisher
  ): Promise<void> {
    try {
      const btnAction = action as { value?: string };
      const btnBody = body as {
        user?: { id?: string };
        channel?: { id?: string };
        message?: { ts?: string };
      };

      if (!btnAction.value) {
        this.logger.warn('[Slack] tool action missing button value');
        return;
      }

      const { toolCallId, sessionId, agentId } = JSON.parse(btnAction.value) as {
        toolCallId: string;
        sessionId: string;
        agentId: string;
      };

      // Clear any pending timeout for this approval
      clearApprovalTimeout(this.outboundState, toolCallId);

      // Publish approval response to relay bus
      const opts: PublishOptions = { from: `slack:${btnBody.user?.id ?? 'unknown'}` };
      await relay.publish(
        `relay.system.approval.${agentId}`,
        {
          type: 'approval_response',
          toolCallId,
          sessionId,
          approved,
          respondedBy: btnBody.user?.id,
          platform: 'slack',
        },
        opts
      );

      // Update original message to show decision result
      const channelId = btnBody.channel?.id;
      const messageTs = btnBody.message?.ts;
      if (channelId && messageTs) {
        const decision = approved ? 'Approved' : 'Denied';
        const emoji = approved ? ':white_check_mark:' : ':x:';
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `${emoji} Tool ${decision} by <@${btnBody.user?.id ?? 'unknown'}>`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${emoji} *Tool ${decision}* by <@${btnBody.user?.id ?? 'unknown'}>`,
              },
            },
          ],
        });
      }

      this.logger.debug?.(
        `[Slack] tool ${approved ? 'approved' : 'denied'}: toolCallId=${toolCallId}`
      );
    } catch (err) {
      this.logger.error('[Slack] tool action handler error:', err);
      this.recordError(err);
    }
  }
}
