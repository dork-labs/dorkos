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
import type { AdapterManifest, RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { SlackAdapterConfig } from '@dorkos/shared/relay-schemas';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  PublishOptions,
} from '../../types.js';
import { SUBJECT_PREFIX, handleInboundMessage, clearCaches } from './inbound.js';
import {
  deliverMessage,
  clearApprovalTimeout,
  createSlackOutboundState,
  clearAllApprovalTimeouts,
} from './outbound.js';
import type { ActiveStream, SlackOutboundState } from './outbound.js';

/**
 * Slack App Manifest YAML for one-click app creation.
 *
 * Pre-fills Socket Mode, bot events, and OAuth scopes so users
 * don't need to manually configure each setting.
 *
 * CRITICAL: Do NOT include `user` scopes. The "Agents & AI Apps" feature
 * in Slack silently adds user-level scopes that cause `invalid_scope`
 * errors on most workspace plans.
 */
const SLACK_APP_MANIFEST_YAML = `display_information:
  name: DorkOS Relay
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: DorkOS Relay
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false`;

/** Slack's app creation URL with pre-filled manifest for one-click setup. */
const SLACK_CREATE_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(SLACK_APP_MANIFEST_YAML)}`;

/** Static adapter manifest for the Slack built-in adapter. */
export const SLACK_MANIFEST: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Send and receive messages in Slack channels and DMs.',
  iconEmoji: '#',
  category: 'messaging',
  docsUrl: 'https://api.slack.com/start',
  builtin: true,
  multiInstance: true,
  actionButton: {
    label: 'Create Slack App',
    url: SLACK_CREATE_APP_URL,
  },
  setupSteps: [
    {
      stepId: 'create-app',
      title: 'Create & Configure a Slack App',
      description:
        'Go to api.slack.com/apps \u2192 Create New App \u2192 From Scratch.\n\n' +
        '1. **Socket Mode** \u2014 Enable it (Settings \u2192 Socket Mode).\n' +
        '2. **Event Subscriptions** \u2014 Turn on Enable Events, then subscribe to bot events: app_mention, message.channels, message.groups, message.im, message.mpim.\n' +
        '3. **OAuth & Permissions** \u2014 Add bot token scopes: app_mentions:read, channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, im:write, mpim:history, reactions:read, reactions:write, users:read. Then install the app to your workspace.\n' +
        '4. **App-Level Token** \u2014 In Basic Information \u2192 App-Level Tokens, generate a token with the connections:write scope.\n\n' +
        '\u26a0\ufe0f Do NOT enable "Agents & AI Apps" \u2014 it adds user scopes that cause install failures on most workspaces.',
      fields: [
        'botToken',
        'appToken',
        'signingSecret',
        'streaming',
        'nativeStreaming',
        'typingIndicator',
      ],
    },
  ],
  configFields: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: 'xoxb-...',
      description: 'Bot User OAuth Token from OAuth & Permissions page.',
      pattern: '^xoxb-',
      patternMessage: 'Bot tokens start with xoxb-',
      visibleByDefault: true,
      helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **OAuth & Permissions** in the sidebar
4. Copy the **Bot User OAuth Token** (starts with \`xoxb-\`)`,
    },
    {
      key: 'appToken',
      label: 'App-Level Token',
      type: 'password',
      required: true,
      placeholder: 'xapp-...',
      description:
        'App-Level Token with connections:write scope. Generate in Basic Information \u2192 App-Level Tokens.',
      pattern: '^xapp-',
      patternMessage: 'App tokens start with xapp-',
      visibleByDefault: true,
      helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **Basic Information** in the sidebar
4. Scroll to **App-Level Tokens**
5. Click **Generate Token and Scopes**
6. Add the \`connections:write\` scope
7. Click **Generate** and copy the token (starts with \`xapp-\`)`,
    },
    {
      key: 'signingSecret',
      label: 'Signing Secret',
      type: 'password',
      required: true,
      placeholder: 'abc123...',
      description: 'Signing Secret from Basic Information page. Used to verify requests.',
      helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **Basic Information** in the sidebar
4. Scroll to **App Credentials**
5. Click **Show** next to **Signing Secret** and copy it`,
    },
    {
      key: 'streaming',
      label: 'Stream Responses',
      type: 'boolean',
      required: false,
      description:
        'Show responses as they arrive (live editing). Disable to send a single message when complete.',
      visibleByDefault: true,
      helpMarkdown:
        'When enabled, agent responses appear token-by-token in Slack via message editing. ' +
        'When disabled, the full response is sent as a single message after the agent finishes.',
    },
    {
      key: 'nativeStreaming',
      label: 'Native Streaming',
      type: 'boolean',
      required: false,
      description:
        "Use Slack's native streaming API (chat.startStream/appendStream/stopStream). Requires messages in threads.",
      visibleByDefault: true,
      helpMarkdown:
        "When enabled, uses Slack's purpose-built streaming API for smoother, flicker-free responses. " +
        'When disabled, uses the legacy chat.update approach. Only applies when Stream Responses is enabled.',
    },
    {
      key: 'typingIndicator',
      label: 'Typing Indicator',
      type: 'select',
      required: false,
      description: 'Show a visual indicator while the agent is working.',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Emoji reaction', value: 'reaction' },
      ],
      visibleByDefault: true,
      helpMarkdown:
        'When set to "Emoji reaction", adds an :hourglass_flowing_sand: reaction to your message ' +
        'while the agent is processing. Requires the `reactions:write` and `reactions:read` scopes.',
    },
  ],
  setupInstructions:
    '1. Create a Slack app at api.slack.com/apps (From Scratch, not From Manifest).\n' +
    '2. Enable Socket Mode (Settings \u2192 Socket Mode).\n' +
    '3. Enable Event Subscriptions and subscribe to bot events: app_mention, message.channels, message.groups, message.im, message.mpim.\n' +
    '4. Add bot token scopes under OAuth & Permissions: app_mentions:read, channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, im:write, mpim:history, reactions:read, reactions:write, users:read.\n' +
    '5. Install the app to your workspace (OAuth & Permissions \u2192 Install).\n' +
    '6. Copy the Bot User OAuth Token (starts with xoxb-).\n' +
    '7. Generate an App-Level Token with connections:write scope (Basic Information \u2192 App-Level Tokens).\n' +
    '8. Copy the Signing Secret from Basic Information.\n\n' +
    '\u26a0\ufe0f Do NOT enable "Agents & AI Apps" \u2014 it adds user-level scopes that cause invalid_scope errors on most workspace plans.',
};

/**
 * Slack adapter for the Relay message bus.
 *
 * Extends {@link BaseRelayAdapter} to bridge Slack channels and DMs
 * into the Relay subject hierarchy via Socket Mode. Delegates heavy
 * logic to inbound.ts and outbound.ts sub-modules.
 */
export class SlackAdapter extends BaseRelayAdapter {
  private readonly config: SlackAdapterConfig;
  private app: App | null = null;
  /** Bot's own user ID — cached after auth.test for echo prevention. */
  private botUserId = '';
  private streamState = new Map<string, ActiveStream>();
  /** FIFO queue of message timestamps with pending hourglass reactions, keyed by channelId. */
  private pendingReactions: import('./stream.js').PendingReactions = new Map();
  private readonly outboundState: SlackOutboundState = createSlackOutboundState();

  constructor(id: string, config: SlackAdapterConfig, displayName = 'Slack') {
    super(id, SUBJECT_PREFIX, displayName);
    this.config = config;
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
      const result = await tempClient.auth.test();
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
    const authResult = await app.client.auth.test();
    this.botUserId = (authResult.user_id as string) ?? '';

    // Register event listeners before starting
    app.message(async ({ event, client }) => {
      await handleInboundMessage(
        event as Parameters<typeof handleInboundMessage>[0],
        client,
        relay,
        this.botUserId,
        this.makeInboundCallbacks(),
        this.logger,
        this.config.typingIndicator ?? 'none',
        this.pendingReactions
      );
    });

    app.event('app_mention', async ({ event, client }) => {
      await handleInboundMessage(
        event as Parameters<typeof handleInboundMessage>[0],
        client,
        relay,
        this.botUserId,
        this.makeInboundCallbacks(),
        this.logger,
        this.config.typingIndicator ?? 'none',
        this.pendingReactions
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

    // Surface unhandled listener errors through adapter status
    app.error(async (error) => {
      this.recordError(error);
    });

    // Start the Bolt app (Socket Mode connects automatically)
    await app.start();
    this.app = app;
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
    this.botUserId = '';
    this.streamState.clear();
    this.pendingReactions.clear();
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
      logger: this.logger,
    });
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
