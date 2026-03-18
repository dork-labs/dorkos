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
import type { RelayPublisher, AdapterInboundCallbacks, RelayLogger } from '../../types.js';
import { noopLogger } from '../../types.js';

// === Constants ===

/** Subject prefix for all Slack adapter subjects. */
export const SUBJECT_PREFIX = 'relay.human.slack';

/** Subject prefix segment added for group channels. */
const GROUP_SEGMENT = 'group';

/** Max length for a single Slack message (Slack's hard limit is 4000). */
export const MAX_MESSAGE_LENGTH = 4000;

/** Maximum inbound message content length (32 KB). */
export const MAX_CONTENT_LENGTH = 32_768;

/** Slack-specific formatting rules injected into agent system prompts via responseContext. */
const SLACK_FORMATTING_RULES = [
  'FORMATTING RULES (you MUST follow these):',
  '- Do NOT use Markdown tables (| col | col |). Slack cannot render them.',
  '- For structured data: use bullet points, numbered lists, or bold key-value pairs.',
  '- Example: instead of a table, write "*Name*: Alice\\n*Role*: Engineer"',
  '- Use *bold* (single asterisk), _italic_ (underscore), `code`, ```code blocks```.',
  '- Do NOT use ## headings — Slack ignores them. Use *bold text* for section titles.',
  `- Keep responses concise. Slack messages over ${MAX_MESSAGE_LENGTH} characters are truncated.`,
].join('\n');

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
  'message_changed',
  'message_deleted',
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

// === Bounded TTL cache ===

/** Maximum entries per cache before oldest-first eviction. */
const CACHE_MAX_SIZE = 500;

/** Cache entry TTL — 1 hour. */
const CACHE_TTL_MS = 60 * 60 * 1_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** Get a cached value, returning undefined if missing or expired. */
function getCached(cache: Map<string, CacheEntry>, key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/** Set a cached value, evicting the oldest entry if at capacity. */
function setCached(cache: Map<string, CacheEntry>, key: string, value: string): void {
  if (cache.size >= CACHE_MAX_SIZE) {
    // Map iterates in insertion order — first key is oldest
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** In-memory cache for user display names (user ID to display name). */
const userNameCache = new Map<string, CacheEntry>();

/** In-memory cache for channel names (channel ID to channel name). */
const channelNameCache = new Map<string, CacheEntry>();

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
  const cached = getCached(userNameCache, userId);
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
    setCached(userNameCache, userId, name);
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
  const cached = getCached(channelNameCache, channelId);
  if (cached) return cached;

  try {
    const result = await client.conversations.info({ channel: channelId });
    const name = (result.channel as Record<string, string> | undefined)?.name ?? channelId;
    setCached(channelNameCache, channelId, name);
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
 * @param logger - Optional relay logger for debug/warn output (defaults to silent)
 */
export async function handleInboundMessage(
  event: SlackMessageEvent,
  client: WebClient,
  relay: RelayPublisher,
  botUserId: string,
  callbacks: AdapterInboundCallbacks,
  logger: RelayLogger = noopLogger,
): Promise<void> {
  // Skip bot's own messages (echo prevention)
  if (event.user === botUserId) {
    logger.debug(`inbound skipped: echo (own user ${botUserId})`);
    return;
  }

  // Skip bot messages and non-user subtypes
  if (event.bot_id) {
    logger.debug(`inbound skipped: bot message (bot_id=${event.bot_id})`);
    return;
  }
  if (event.subtype && SKIP_SUBTYPES.has(event.subtype)) {
    logger.debug(`inbound skipped: subtype '${event.subtype}'`);
    return;
  }

  // Skip messages without text content
  if (!event.text) {
    logger.debug(`inbound skipped: no text content in ${event.channel}`);
    return;
  }

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
      formattingInstructions: SLACK_FORMATTING_RULES,
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
    callbacks.trackInbound();
    logger.debug(`inbound from ${senderName} in ${event.channel}: "${content.slice(0, 80)}${content.length > 80 ? '\u2026' : ''}" (${content.length} chars) \u2192 ${subject}`);
  } catch (err) {
    callbacks.recordError(err);
    logger.warn(`inbound publish failed for ${event.channel}:`, err instanceof Error ? err.message : String(err));
  }
}
