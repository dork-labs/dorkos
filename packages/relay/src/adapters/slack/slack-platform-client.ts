/**
 * Slack platform client implementing the PlatformClient interface.
 *
 * Wraps the Bolt `WebClient` to provide a clean, platform-agnostic API for
 * posting, editing, and deleting messages in Slack channels. The working
 * indicator is not here: it is keyed to the turn, needs a channel and a message
 * timestamp rather than one id, and lives in `presence.ts`.
 *
 * This class never touches RelayEnvelopes or subjects — it operates solely on
 * Slack channel IDs (used as `threadId`) and content strings.
 *
 * @module relay/adapters/slack/slack-platform-client
 */
import type { WebClient } from '@slack/web-api';
import type { PlatformClient, RelayPublisher } from '../../types.js';
import { formatForPlatform, truncateText } from '../../lib/payload-utils.js';
import { MAX_MESSAGE_LENGTH } from './inbound.js';

// === Types ===

/** Construction options for SlackPlatformClient. */
export interface SlackPlatformClientConfig {
  /** Reserved for future use — enables Slack's native streaming API when available. */
  nativeStreaming?: boolean;
}

// === Implementation ===

/**
 * Low-level Slack communication client.
 *
 * Implements `PlatformClient` by delegating directly to the Slack `WebClient`.
 * Suitable for ownership by `SlackAdapter` or any orchestrator that requires
 * platform-level send/edit/delete primitives.
 */
export class SlackPlatformClient implements PlatformClient {
  readonly platform = 'slack';

  private readonly client: WebClient;
  private readonly config: SlackPlatformClientConfig;

  constructor(client: WebClient, config: SlackPlatformClientConfig = {}) {
    this.client = client;
    this.config = config;
  }

  /**
   * Post a new message to a Slack channel.
   *
   * @param threadId - Slack channel ID (e.g. `C01234567` or `D01234567` for DMs)
   * @param content - Message body text (Markdown formatted)
   * @param _format - Ignored — Slack always receives mrkdwn-formatted text
   * @returns The Slack message timestamp used as its message ID
   */
  async postMessage(
    threadId: string,
    content: string,
    _format?: string
  ): Promise<{ messageId: string }> {
    const text = truncateText(formatForPlatform(content, 'slack'), MAX_MESSAGE_LENGTH);
    const result = await this.client.chat.postMessage({
      channel: threadId,
      text,
      mrkdwn: true,
    });
    return { messageId: (result as { ts?: string }).ts ?? '' };
  }

  /**
   * Edit an existing Slack message in place.
   *
   * @param threadId - Slack channel ID
   * @param messageId - The `ts` value of the message to update
   * @param content - Replacement message body text
   */
  async editMessage(threadId: string, messageId: string, content: string): Promise<void> {
    const text = truncateText(formatForPlatform(content, 'slack'), MAX_MESSAGE_LENGTH);
    await this.client.chat.update({
      channel: threadId,
      ts: messageId,
      text,
    });
  }

  /**
   * Delete a Slack message.
   *
   * @param threadId - Slack channel ID
   * @param messageId - The `ts` value of the message to delete
   */
  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    await this.client.chat.delete({
      channel: threadId,
      ts: messageId,
    });
  }

  /**
   * Wire up inbound message handling — no-op for Slack.
   *
   * Inbound messages are handled by `SlackAdapter` via the Bolt app event
   * listeners. The platform client only handles outbound operations.
   *
   * @param _relay - Unused — inbound routing is handled by the adapter facade
   */
  handleInbound(_relay: RelayPublisher): void {
    // No-op: inbound is handled by SlackAdapter via Bolt event listeners.
  }

  /**
   * Tear down the platform client.
   *
   * No persistent connections or resources to release — the `WebClient` is
   * stateless and owned by the calling adapter.
   */
  async destroy(): Promise<void> {
    // No persistent state to clean up. The WebClient is owned by the caller.
  }
}
