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
import { WebAPIPlatformError, WebClient } from '@slack/web-api';
import type { RelayEnvelope, SlackAdapterConfig } from '@dorkos/shared/relay-schemas';
import { DEFAULT_RESPOND_MODE } from '@dorkos/shared/relay-schemas';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  PublishOptions,
} from '../../types.js';
import { handleInboundMessage, clearCaches, createSlackInboundState } from './inbound.js';
import type { InboundOptions, SlackInboundState } from './inbound.js';
import { ThreadParticipationTracker } from './thread-tracker.js';
import {
  deliverMessage,
  clearApprovalTimeout,
  createSlackOutboundState,
  clearAllApprovalTimeouts,
} from './outbound.js';
import type { ActiveStream, SlackOutboundState } from './outbound.js';
import { SlackPlatformClient } from './slack-platform-client.js';
import { createSlackPresenceState, clearAllPresence, markAssistantThread } from './presence.js';
import type { SlackPresenceState } from './presence.js';
import { SlackThreadIdCodec } from '../../lib/thread-id.js';
import { mayApprove } from '../approver-allowlist.js';
import { FATAL_SLACK_ERRORS, SLACK_MANIFEST } from './slack-manifest.js';

// Re-export for consumers that import from this module
export { SLACK_MANIFEST };

/** How far to walk a wrapped error chain before giving up (also breaks cycles). */
const MAX_ERROR_UNWRAP_DEPTH = 5;

/**
 * Find the Slack platform error inside whatever Bolt hands its error handler.
 *
 * Bolt rarely delivers a {@link WebAPIPlatformError} directly, and the wrapped
 * path is the one that matters most: an `authorize()` failure arrives as an
 * `AuthorizationError` carrying the real error on `.original`. Because Bolt
 * authorizes every incoming event, a revoked or de-scoped token funnels EVERY
 * event through that wrapper — so a check that only tests the top-level error
 * never sees the platform error, never matches a fatal code, and leaves the
 * adapter retrying forever against a token that will never work again.
 *
 * Listener failures nest too: `UnknownError` wraps on `.original`,
 * `MultipleListenerError` on `.originals` (an array), and a non-Error throw is
 * re-thrown with the value on `.cause`. All three are walked here.
 *
 * @param error - The error Bolt passed to `app.error`.
 * @param depth - Internal recursion counter; callers should omit it.
 * @returns The platform error if one is nested anywhere, else `null`.
 */
function findPlatformError(error: unknown, depth = 0): WebAPIPlatformError | null {
  if (error instanceof WebAPIPlatformError) return error;
  if (depth >= MAX_ERROR_UNWRAP_DEPTH || typeof error !== 'object' || error === null) return null;

  const { original, originals, cause } = error as {
    original?: unknown;
    originals?: unknown;
    cause?: unknown;
  };

  for (const nested of [original, cause, ...(Array.isArray(originals) ? originals : [])]) {
    if (nested === undefined) continue;
    const found = findPlatformError(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

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
  /** Working-presence state: held claims, queued trigger messages, assistant threads. */
  private readonly presence: SlackPresenceState = createSlackPresenceState();
  private readonly outboundState: SlackOutboundState = createSlackOutboundState();
  /** Instance-scoped inbound caches (dedup + name resolution). */
  private readonly inboundState: SlackInboundState = createSlackInboundState();
  private platformClient: SlackPlatformClient | null = null;
  /** Set once a fatal Slack error has queued a teardown, so only one runs. */
  private fatalStopScheduled = false;
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
      respondMode: respondModeOverride ?? this.config.respondMode ?? DEFAULT_RESPOND_MODE,
      // Fall back to the restrictive policy, not the permissive one: a config
      // that reached here without a `dmPolicy` went through neither the schema
      // default nor the legacy carry-forward, so nothing about it says the
      // operator wanted the whole workspace to be able to DM (DOR-604).
      dmPolicy: this.config.dmPolicy ?? 'allowlist',
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
      // A bare WebClient, so validating credentials never starts a Bolt app.
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
        this.inboundState,
        this.logger,
        this.config.typingIndicator ?? 'none',
        this.presence,
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
        this.inboundState,
        this.logger,
        this.config.typingIndicator ?? 'none',
        this.presence,
        this.codec,
        this.buildInboundOptions(eventId, 'always')
      );
    });

    // The assistant split panel is the only Slack surface with a status line,
    // and this event is the only thing that identifies it. Remember the thread
    // so a claim in it sets a status instead of reacting with an emoji.
    //
    // The default app manifest deliberately subscribes to neither this event nor
    // the `assistant:write` scope: it also tells operators NOT to enable
    // "Agents & AI Apps", which adds user scopes that break installs on most
    // workspaces. So this listener never fires on a stock install and every
    // thread falls back to the reaction — the mapping is real but UNVERIFIED
    // end to end (`docs/setup.md`). Do not add the scope here to "fix" it.
    app.event('assistant_thread_started', async ({ event }) => {
      const thread = (event as { assistant_thread?: { channel_id?: string; thread_ts?: string } })
        .assistant_thread;
      if (thread?.channel_id && thread.thread_ts) {
        markAssistantThread(this.presence, thread.channel_id, thread.thread_ts);
      }
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
      // The string that names a fatal install problem ('invalid_auth',
      // 'token_revoked', …) is Slack's *platform* error, which lives in
      // `data.error` — usually nested inside a Bolt wrapper, hence the walk in
      // `findPlatformError`. A platform error also carries a `code`, but it is
      // always the SDK-level constant 'slack_webapi_platform_error', so it can
      // never be the fatal string and must not be consulted first (it used to
      // be, which is why no fatal error ever matched — DOR-1528). Only when no
      // platform error is nested anywhere do we fall back to a duck-typed
      // `data.error` and then to Bolt's own `code`.
      const platformError = findPlatformError(error);
      const errorCode =
        platformError?.data.error ??
        (error as { data?: { error?: string } }).data?.error ??
        (error as { code?: string }).code;

      if (errorCode && FATAL_SLACK_ERRORS.has(errorCode)) {
        this.logger.error('fatal Slack error — stopping adapter', { errorCode });
        // One fatal error is enough: with a dead token every subsequent event
        // fails the same way, and each would otherwise queue its own teardown.
        if (this.fatalStopScheduled) return;
        this.fatalStopScheduled = true;

        // Tear down on a later tick rather than inline. We are inside Bolt's
        // own error handler, which it awaits while still processing the event,
        // and stopping disconnects the very socket that delivered it — so
        // deferring lets Bolt finish (ack included) before the transport goes
        // away, and avoids re-entering the adapter from within its own handler.
        setImmediate(() => {
          void (async () => {
            try {
              // The full stop path, not `app.stop()` alone: it also clears the
              // approval timers and presence timers, which would otherwise keep
              // firing against a token that is already dead.
              await this.stop();
            } catch {
              // best-effort — the socket may already be gone
            }
            // Recorded AFTER stopping: `stop()` rebuilds status as
            // 'disconnected' and drops `lastError`, so recording first would
            // erase the one message the operator needs to see.
            this.recordError(
              `Fatal Slack error: ${errorCode}. Re-check your bot token and app configuration.`
            );
          })();
        });
        return;
      }

      this.recordError(error);
    });

    // Start the Bolt app (Socket Mode connects automatically)
    this.logger.info('connecting via Socket Mode');
    await app.start();
    this.app = app;
    this.platformClient = new SlackPlatformClient(app.client, {
      nativeStreaming: this.config.nativeStreaming,
    });
  }

  /** Disconnect from Slack and clean up state. */
  protected async _stop(): Promise<void> {
    // Take down anything still on screen with the client that put it there,
    // before the app goes away. Best-effort: a disconnected adapter simply
    // fails these, and nothing waits on them.
    clearAllPresence(this.presence, this.app?.client ?? null, this.logger);
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
    this.threadTracker.clear();
    clearAllApprovalTimeouts(this.outboundState);
    clearCaches(this.inboundState);
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
      presence: this.presence,
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

      // Authorization, not identification. `respondedBy` below records who
      // acted; it never decided who may. Without this check the person whose
      // message triggered the tool call could approve it themselves, one tap,
      // from their own device (DOR-609).
      if (!mayApprove(this.config.approverAllowlist, btnBody.user?.id)) {
        this.logger.warn(
          `[Slack] refused tool approval from unauthorized user ${btnBody.user?.id ?? 'unknown'}` +
            ` for toolCallId=${toolCallId}`
        );
        await client.chat.postEphemeral({
          channel: btnBody.channel?.id ?? '',
          user: btnBody.user?.id ?? '',
          text:
            'You are not on this integration’s approver list, so this tool call was not ' +
            'authorized. Whoever runs this DorkOS can add you under the integration’s ' +
            '“Approvers” setting.',
        });
        return;
      }

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
