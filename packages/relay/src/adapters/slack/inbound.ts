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
import type { PendingReactions } from './stream.js';
import { SlackThreadIdCodec } from '../../lib/thread-id.js';
import type { ThreadParticipationTracker } from './thread-tracker.js';

// === Constants ===

/** Subject prefix for all Slack adapter subjects. */
export const SUBJECT_PREFIX = 'relay.human.slack';

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

// === Event deduplication ===

/** Maximum entries in the event dedup cache before eviction. */
const EVENT_DEDUP_MAX_SIZE = 500;

/** Event dedup entry TTL — 5 minutes. */
const EVENT_DEDUP_TTL_MS = 5 * 60 * 1_000;

interface DedupEntry {
  expiresAt: number;
}

/** Module-level cache of recently-seen event IDs to prevent duplicate processing. */
const seenEvents = new Map<string, DedupEntry>();

// === Types ===

/** How the bot decides whether to respond in channels. */
export type RespondMode = 'always' | 'mention-only' | 'thread-aware';

/** Per-channel override settings. */
export interface ChannelOverride {
  enabled?: boolean;
  respondMode?: RespondMode;
}

/** Resolved channel configuration after merging global defaults with per-channel overrides. */
export interface EffectiveChannelConfig {
  enabled: boolean;
  respondMode: RespondMode;
}

/**
 * Resolve the effective channel configuration by merging per-channel overrides
 * with the global respond mode default.
 *
 * @param channelId - The Slack channel ID
 * @param globalRespondMode - The adapter-level respond mode default
 * @param overrides - Per-channel overrides keyed by channel ID
 */
export function getEffectiveChannelConfig(
  channelId: string,
  globalRespondMode: RespondMode,
  overrides: Record<string, ChannelOverride>
): EffectiveChannelConfig {
  const override = overrides[channelId];
  return {
    enabled: override?.enabled ?? true,
    respondMode: override?.respondMode ?? globalRespondMode,
  };
}

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

/** Options for inbound message handling, including deduplication and routing policy. */
export interface InboundOptions {
  /** Slack event ID for deduplication. */
  eventId?: string;
  /** How the bot decides whether to respond in channels. */
  respondMode?: RespondMode;
  /** DM access policy. */
  dmPolicy?: 'open' | 'allowlist';
  /** Slack user IDs allowed to DM the bot (when dmPolicy is 'allowlist'). */
  dmAllowlist?: string[];
  /** Per-channel overrides for enabled state and respond mode. */
  channelOverrides?: Record<string, ChannelOverride>;
  /** Thread participation tracker instance for thread-aware routing. */
  threadTracker?: ThreadParticipationTracker;
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
 * Check whether a message text contains an @mention of the bot.
 *
 * @param text - The message text to search
 * @param botUserId - The bot's Slack user ID
 */
function hasBotMention(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}>`);
}

/**
 * Determine whether a message should be processed based on the respond mode.
 *
 * @param mode - The effective respond mode for this channel
 * @param event - The Slack message event
 * @param botUserId - The bot's own user ID for @mention detection
 * @param threadTracker - Optional thread participation tracker for thread-aware mode
 */
function shouldProcessMessage(
  mode: RespondMode,
  event: SlackMessageEvent,
  botUserId: string,
  threadTracker?: ThreadParticipationTracker
): boolean {
  if (mode === 'always') return true;

  const mentioned = hasBotMention(event.text ?? '', botUserId);

  if (mode === 'mention-only') return mentioned;

  // thread-aware mode
  if (event.thread_ts) {
    // In a thread: process if bot is participating OR if @mentioned
    return mentioned || (threadTracker?.isParticipating(event.channel, event.thread_ts) ?? false);
  }
  // Main channel: only process if @mentioned
  return mentioned;
}

/**
 * Build the Relay subject for a given Slack channel.
 *
 * @param codec - The thread ID codec to use for encoding
 * @param channelId - The Slack channel ID
 * @param isGroup - Whether the channel is a group (C/G prefix) vs DM (D prefix)
 */
export function buildSubject(
  codec: SlackThreadIdCodec,
  channelId: string,
  isGroup: boolean
): string {
  return codec.encode(channelId, isGroup ? 'group' : 'dm');
}

/**
 * Extract the Slack channel ID from a Relay subject.
 *
 * Returns null if the subject does not match the expected pattern.
 *
 * @param codec - The thread ID codec to use for decoding
 * @param subject - A Relay subject under the slack prefix
 */
export function extractChannelId(codec: SlackThreadIdCodec, subject: string): string | null {
  const decoded = codec.decode(subject);
  return decoded?.platformId ?? null;
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
export function isGroupChannel(channelId: string): boolean {
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
  seenEvents.clear();
}

/**
 * Remove an eagerly-queued reaction when publish fails or is rejected.
 *
 * Removes the entry from the pending queue and issues a fire-and-forget
 * reactions.remove call so the hourglass doesn't linger on a message
 * that will never be processed.
 */
function removeQueuedReaction(
  client: WebClient,
  channelId: string,
  messageTs: string,
  pendingReactions: PendingReactions | undefined,
  wasQueued: boolean,
  logger: RelayLogger
): void {
  if (!wasQueued) return;
  if (pendingReactions) {
    const queue = pendingReactions.get(channelId);
    if (queue) {
      const idx = queue.indexOf(messageTs);
      if (idx !== -1) queue.splice(idx, 1);
      if (queue.length === 0) pendingReactions.delete(channelId);
    }
  }
  void client.reactions
    .remove({ channel: channelId, name: 'hourglass_flowing_sand', timestamp: messageTs })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('no_reaction')) {
        logger.warn(
          `inbound: failed to remove queued typing reaction from ${channelId}:${messageTs}: ${msg}`
        );
      }
    });
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
  typingIndicator: 'none' | 'reaction' = 'none',
  pendingReactions?: PendingReactions,
  codec?: SlackThreadIdCodec,
  options?: InboundOptions
): Promise<void> {
  // Event deduplication — skip if we've already processed this event_id
  if (options?.eventId) {
    const existing = seenEvents.get(options.eventId);
    if (existing && Date.now() < existing.expiresAt) {
      logger.debug(`inbound skipped: duplicate event_id ${options.eventId}`);
      return;
    }

    // Evict expired entries when at capacity
    if (seenEvents.size >= EVENT_DEDUP_MAX_SIZE) {
      const now = Date.now();
      for (const [key, entry] of seenEvents) {
        if (now >= entry.expiresAt) seenEvents.delete(key);
      }
      // If still at capacity after expired eviction, remove oldest
      if (seenEvents.size >= EVENT_DEDUP_MAX_SIZE) {
        const firstKey = seenEvents.keys().next().value;
        if (firstKey !== undefined) seenEvents.delete(firstKey);
      }
    }

    seenEvents.set(options.eventId, { expiresAt: Date.now() + EVENT_DEDUP_TTL_MS });
  }

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

  // === Gating: channel overrides, DM policy, respond mode ===

  const channelId = event.channel;
  const isDm = channelId.startsWith('D');

  // Channel override — check if channel is disabled
  if (options?.channelOverrides) {
    const config = getEffectiveChannelConfig(
      channelId,
      options.respondMode ?? 'always',
      options.channelOverrides
    );
    if (!config.enabled) {
      logger.debug(`inbound skipped: channel ${channelId} disabled by override`);
      return;
    }
  }

  // DM policy — allowlist check
  if (isDm && options?.dmPolicy === 'allowlist') {
    const allowlist = options.dmAllowlist ?? [];
    if (!allowlist.includes(event.user ?? '')) {
      return;
    }
  }

  // Respond mode gating (non-DM channels only)
  if (!isDm) {
    const effectiveMode = options?.channelOverrides
      ? getEffectiveChannelConfig(
          channelId,
          options?.respondMode ?? 'always',
          options.channelOverrides
        ).respondMode
      : (options?.respondMode ?? 'always');

    if (!shouldProcessMessage(effectiveMode, event, botUserId, options?.threadTracker)) {
      logger.debug(`inbound skipped: respond mode '${effectiveMode}' filtered ${channelId}`);
      return;
    }
  }

  const resolvedCodec = codec ?? new SlackThreadIdCodec();
  const isGroup = isGroupChannel(event.channel);
  const subject = buildSubject(resolvedCodec, event.channel, isGroup);

  // Cap inbound content to prevent oversized payloads
  const content = event.text.slice(0, MAX_CONTENT_LENGTH);

  // Add hourglass reaction immediately — before name resolution and publish
  // so the user sees feedback within milliseconds of sending their message.
  // Queue is populated synchronously so the outbound handler can find it
  // when done/error arrives — even if the Slack API call is still in-flight.
  let reactionQueued = false;
  if (typingIndicator === 'reaction') {
    if (pendingReactions) {
      const queue = pendingReactions.get(event.channel) ?? [];
      queue.push(event.ts);
      pendingReactions.set(event.channel, queue);
      reactionQueued = true;
    }

    client.reactions
      .add({ channel: event.channel, name: 'hourglass_flowing_sand', timestamp: event.ts })
      .then(() => {
        logger.debug(`inbound: added typing reaction to ${event.channel}:${event.ts}`);
      })
      .catch((err) => {
        // Remove from queue since the reaction was never actually added.
        if (pendingReactions) {
          const queue = pendingReactions.get(event.channel);
          if (queue) {
            const idx = queue.indexOf(event.ts);
            if (idx !== -1) queue.splice(idx, 1);
            if (queue.length === 0) pendingReactions.delete(event.channel);
          }
        }
        logger.warn(
          `inbound: failed to add typing reaction to ${event.channel}:${event.ts}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  const senderName = event.user ? await resolveUserName(client, event.user) : 'unknown';

  const channelName = isGroup ? await resolveChannelName(client, event.channel) : undefined;

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
    const result = await relay.publish(subject, payload, {
      from: `${resolvedCodec.prefix}.bot`,
      replyTo: subject,
    });

    // Check for rejected publishes (e.g. rate-limited) before tracking or reacting
    if (result.deliveredTo === 0 && result.rejected?.length) {
      const reason = result.rejected[0]?.reason ?? 'unknown';
      callbacks.recordError(new Error(`Publish rejected: ${reason}`));
      logger.warn(`inbound publish rejected for ${event.channel}: ${reason}`);
      // Clean up the eagerly-added reaction since nothing will process this message
      removeQueuedReaction(
        client,
        event.channel,
        event.ts,
        pendingReactions,
        reactionQueued,
        logger
      );
      return;
    }

    callbacks.trackInbound();
    logger.debug(
      `inbound from ${senderName} in ${event.channel}: "${content.slice(0, 80)}${content.length > 80 ? '\u2026' : ''}" (${content.length} chars) \u2192 ${subject}`
    );
  } catch (err) {
    callbacks.recordError(err);
    logger.warn(
      `inbound publish failed for ${event.channel}:`,
      err instanceof Error ? err.message : String(err)
    );
    // Clean up the eagerly-added reaction since nothing will process this message
    removeQueuedReaction(client, event.channel, event.ts, pendingReactions, reactionQueued, logger);
  }
}
