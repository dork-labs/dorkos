/**
 * Slack adapter for the Relay message bus.
 *
 * Thin facade composing inbound parsing and outbound delivery sub-modules
 * into a single cohesive adapter class. Uses Socket Mode via @slack/bolt
 * for receiving events without requiring a public URL.
 *
 * @module relay/adapters/slack-adapter
 */
import { App } from '@slack/bolt';
import type { AdapterManifest, RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { SlackAdapterConfig } from '@dorkos/shared/relay-schemas';
import { BaseRelayAdapter } from '../../base-adapter.js';
import type { RelayPublisher, AdapterContext, DeliveryResult } from '../../types.js';
import {
  SUBJECT_PREFIX,
  handleInboundMessage,
  clearCaches,
} from './inbound.js';
import { deliverMessage } from './outbound.js';
import type { ActiveStream, OutboundCallbacks } from './outbound.js';

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
    url: 'https://api.slack.com/apps',
  },
  setupSteps: [
    {
      stepId: 'create-app',
      title: 'Create a Slack App',
      description:
        'Go to api.slack.com/apps \u2192 Create New App \u2192 From Scratch. Enable Socket Mode in the app settings.',
      fields: ['botToken', 'appToken', 'signingSecret'],
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
    },
    {
      key: 'signingSecret',
      label: 'Signing Secret',
      type: 'password',
      required: true,
      placeholder: 'abc123...',
      description: 'Signing Secret from Basic Information page. Used to verify requests.',
    },
  ],
  setupInstructions:
    'Create a Slack app at api.slack.com/apps. Enable Socket Mode. Add bot token scopes: channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, im:write, mpim:history, app_mentions:read, users:read. Subscribe to events: message.channels, message.groups, message.im, app_mention. Generate an App-Level Token with connections:write scope.',
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
      );
    });

    app.event('app_mention', async ({ event, client }) => {
      await handleInboundMessage(
        event as Parameters<typeof handleInboundMessage>[0],
        client,
        relay,
        this.botUserId,
        this.makeInboundCallbacks(),
      );
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
    clearCaches();
  }

  /**
   * Deliver a Relay message to Slack.
   *
   * Delegates to the outbound module for stream-aware delivery.
   *
   * @param subject - The target Relay subject (e.g. relay.human.slack.D123456)
   * @param envelope - The relay envelope to deliver
   * @param context - Optional adapter context (unused by this adapter)
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext,
  ): Promise<DeliveryResult> {
    return deliverMessage(
      this.id,
      subject,
      envelope,
      context,
      this.app?.client ?? null,
      this.streamState,
      this.botUserId,
      this.makeOutboundCallbacks(),
    );
  }

  /** Build callbacks for inbound message handling. */
  private makeInboundCallbacks() {
    return {
      updateStatus: () => this.trackInbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }

  /** Build callbacks for outbound message delivery. */
  private makeOutboundCallbacks(): OutboundCallbacks {
    return {
      trackOutbound: () => this.trackOutbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }
}
