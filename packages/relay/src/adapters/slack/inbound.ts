/**
 * Slack inbound message handling.
 *
 * Parses Slack message events into Relay-compatible payloads.
 * Handles messages from DMs, channels, and group DMs.
 * Normalises all inbound messages into StandardPayload so agents
 * are decoupled from the Slack API surface.
 *
 * @module relay/adapters/slack-inbound
 */
import type { WebClient } from '@slack/web-api';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, AdapterStatus } from '../../types.js';

// === Constants ===

/** Subject prefix for all Slack adapter subjects. */
export const SUBJECT_PREFIX = 'relay.human.slack';

/** Subject prefix segment added for group channels. */
const GROUP_SEGMENT = 'group';

/** Max length for a single Slack message (Slack's hard limit is 4000). */
export const MAX_MESSAGE_LENGTH = 4000;

/** Maximum inbound message content length (32 KB). */
export const MAX_CONTENT_LENGTH = 32_768;

/** Message subtypes to skip (non-user-generated events). */
const SKIP_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'bot_message',
  'me_message',
  'file_share',
  'file_comment',
  'file_mention',
  'pinned_item',
  'unpinned_item',
]);

// === Types ===

/** Slack message event shape (subset of Bolt's MessageEvent). */
export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  user?: string;
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  team?: string;
  bot_id?: string;
}

/**
 * Callback interface for reporting status changes from inbound handling.
 *
 * The facade passes a thin callback so inbound logic can update adapter state
 * without owning the full class instance.
 */
export interface InboundCallbacks {
  /** Update the adapter status (partial merge). */
  updateStatus: (patch: Partial<AdapterStatus>) => void;
  /** Record an error without throwing. */
  recordError: (err: unknown) => void;
}

// === Caches ===

/** In-memory cache for user display names (user ID to display name). */
const userNameCache = new Map<string, string>();

/** In-memory cache for channel names (channel ID to channel name). */
const channelNameCache = new Map<string, string>();

// === Helpers ===

/**
 * Build the Relay subject for a given Slack channel.
 *
 * @param channelId - The Slack channel ID
 * @param isGroup - Whether the channel is a group (C/G prefix) vs DM (D prefix)
 */
export function buildSubject(channelId: string, isGroup: boolean): string {
  if (isGroup) {
    return `${SUBJECT_PREFIX}.${GROUP_SEGMENT}.${channelId}`;
  }
  return `${SUBJECT_PREFIX}.${channelId}`;
}

/**
 * Extract the Slack channel ID from a Relay subject.
 *
 * Returns null if the subject does not match the expected pattern.
 *
 * @param subject - A Relay subject under the slack prefix
 */
export function extractChannelId(subject: string): string | null {
  if (!subject.startsWith(SUBJECT_PREFIX)) return null;

  const remainder = subject.slice(SUBJECT_PREFIX.length + 1);
  if (!remainder) return null;

  // Group format: group.{channelId}
  if (remainder.startsWith(`${GROUP_SEGMENT}.`)) {
    const id = remainder.slice(GROUP_SEGMENT.length + 1);
    return id || null;
  }

  // DM format: {channelId}
  return remainder;
}

/**
 * Determine whether a Slack channel ID indicates a group channel.
 *
 * Slack channel IDs:
 * - 'D' prefix: DM channel
 * - 'C' prefix: public channel
 * - 'G' prefix: private channel or group DM
 *
 * @param channelId - The Slack channel ID
 */
function isGroupChannel(channelId: string): boolean {
  return channelId.startsWith('C') || channelId.startsWith('G');
}

/**
 * Resolve a Slack user ID to a display name.
 *
 * Calls users.info API and caches the result. Falls back to the user ID
 * if the API call fails.
 *
 * @param client - Slack WebClient instance
 * @param userId - The Slack user ID to resolve
 */
async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const user = result.user;
    const name =
      (user?.profile as Record<string, string> | undefined)?.display_name ||
      (user?.profile as Record<string, string> | undefined)?.real_name ||
      user?.real_name ||
      user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/**
 * Resolve a Slack channel ID to a channel name.
 *
 * Calls conversations.info API and caches the result. Falls back to the
 * channel ID if the API call fails.
 *
 * @param client - Slack WebClient instance
 * @param channelId - The Slack channel ID to resolve
 */
async function resolveChannelName(client: WebClient, channelId: string): Promise<string> {
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;

  try {
    const result = await client.conversations.info({ channel: channelId });
    const name = (result.channel as Record<string, string> | undefined)?.name ?? channelId;
    channelNameCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}

/**
 * Clear all cached user names and channel names.
 *
 * Called on adapter stop to prevent stale data across restarts.
 */
export function clearCaches(): void {
  userNameCache.clear();
  channelNameCache.clear();
}

/**
 * Handle an inbound Slack message and publish it to the Relay.
 *
 * Builds the subject from the channel ID, constructs a StandardPayload,
 * and publishes it. Errors during publish are caught and recorded to avoid
 * crashing the Bolt event loop.
 *
 * @param event - The Slack message event
 * @param client - Slack WebClient for API calls (user/channel resolution)
 * @param relay - The relay publisher
 * @param botUserId - The bot's own user ID for echo prevention
 * @param callbacks - Callbacks to mutate adapter state
 */
export async function handleInboundMessage(
  event: SlackMessageEvent,
  client: WebClient,
  relay: RelayPublisher,
  botUserId: string,
  callbacks: InboundCallbacks,
): Promise<void> {
  // Skip bot's own messages (echo prevention)
  if (event.user === botUserId) return;

  // Skip bot messages and non-user subtypes
  if (event.bot_id) return;
  if (event.subtype && SKIP_SUBTYPES.has(event.subtype)) return;

  // Skip messages without text content
  if (!event.text) return;

  const isGroup = isGroupChannel(event.channel);
  const subject = buildSubject(event.channel, isGroup);

  // Cap inbound content to prevent oversized payloads
  const content = event.text.slice(0, MAX_CONTENT_LENGTH);

  const senderName = event.user
    ? await resolveUserName(client, event.user)
    : 'unknown';

  const channelName = isGroup
    ? await resolveChannelName(client, event.channel)
    : undefined;

  const payload: StandardPayload = {
    content,
    senderName,
    channelName,
    channelType: isGroup ? 'group' : 'dm',
    responseContext: {
      platform: 'slack',
      maxLength: MAX_MESSAGE_LENGTH,
      supportedFormats: ['text', 'mrkdwn'],
      instructions: `Reply to subject ${subject} to respond to this Slack message.`,
    },
    platformData: {
      channelId: event.channel,
      userId: event.user,
      ts: event.ts,
      threadTs: event.thread_ts,
      teamId: event.team,
    },
  };

  try {
    await relay.publish(subject, payload, {
      from: `${SUBJECT_PREFIX}.bot`,
      replyTo: subject,
    });
    callbacks.updateStatus({});
  } catch (err) {
    callbacks.recordError(err);
  }
}
