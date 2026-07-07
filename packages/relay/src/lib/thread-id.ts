/**
 * Thread ID codec utilities for Relay adapters.
 *
 * Provides a shared `ThreadIdCodec` interface and platform-specific
 * implementations for encoding and decoding Relay subject strings that
 * represent human-facing communication channels (DMs and group chats).
 *
 * Each codec owns a unique subject prefix and handles the encode/decode
 * round-trip for its platform. Codecs accept an optional `instanceId` to
 * disambiguate multiple instances of the same adapter type.
 *
 * @module relay/lib/thread-id
 */

/**
 * Encodes and decodes Relay subject strings for a specific messaging platform.
 *
 * A subject string uniquely identifies a conversation channel within the Relay
 * bus. Each platform uses a prefix to namespace its subjects (e.g.
 * `relay.human.telegram`) followed by an optional `group.` segment and the
 * platform-native chat ID.
 */
export interface ThreadIdCodec {
  /** The platform-specific subject prefix, e.g. `relay.human.telegram`. */
  readonly prefix: string;

  /**
   * Encode a platform-specific chat ID and channel type into a Relay subject.
   *
   * @param platformId - The platform-native identifier for the chat (e.g. a
   *   Telegram chat ID or Slack channel ID)
   * @param channelType - Whether the conversation is a direct message or a
   *   group chat
   * @returns A fully-qualified Relay subject string
   */
  encode(platformId: string, channelType: 'dm' | 'group'): string;

  /**
   * Decode a Relay subject string back into its platform ID and channel type.
   *
   * @param subject - The Relay subject string to decode
   * @returns The extracted `platformId` and `channelType`, or `null` if the
   *   subject does not match this codec's prefix or is malformed
   */
  decode(subject: string): { platformId: string; channelType: 'dm' | 'group' } | null;
}

// === Helpers ===

/**
 * Shared decode implementation used by all codecs in this module.
 *
 * Extracts `platformId` and `channelType` from the remainder of a subject
 * string after the codec prefix has been stripped.
 *
 * Requires the character immediately following the prefix to be `.` so that
 * prefixes that share a common start (e.g. the base `relay.human.telegram`
 * vs. an instance-scoped `relay.human.telegram.<instanceId>`) do not
 * accidentally match each other.
 *
 * @param prefix - The codec's subject prefix
 * @param subject - The full subject string to decode
 * @returns The decoded fields, or `null` if the subject is invalid
 */
function decodeSubject(
  prefix: string,
  subject: string
): { platformId: string; channelType: 'dm' | 'group' } | null {
  // Verify the subject starts with exactly `<prefix>.` to avoid false matches
  // against prefixes that share a common leading substring (e.g. the base
  // telegram prefix vs. an instance-scoped one).
  const expectedStart = `${prefix}.`;
  if (!subject.startsWith(expectedStart)) return null;

  // Strip the prefix and its dot separator
  const remainder = subject.slice(expectedStart.length);
  if (!remainder) return null;

  if (remainder.startsWith('group.')) {
    const id = remainder.slice('group.'.length);
    return id ? { platformId: id, channelType: 'group' } : null;
  }

  return { platformId: remainder, channelType: 'dm' };
}

// === Codec implementations ===

/**
 * Thread ID codec for the native Telegram adapter.
 *
 * Subjects follow the format:
 * - DM:    `relay.human.telegram.<chatId>`
 * - Group: `relay.human.telegram.group.<chatId>`
 */
export class TelegramThreadIdCodec implements ThreadIdCodec {
  readonly prefix: string;

  /**
   * Create a thread ID codec for native Telegram adapter threads.
   *
   * @param instanceId - Optional instance identifier for disambiguating multiple
   *   Telegram adapter instances. When provided, the prefix becomes
   *   `relay.human.telegram.<instanceId>`.
   */
  constructor(instanceId?: string) {
    this.prefix = instanceId ? `relay.human.telegram.${instanceId}` : 'relay.human.telegram';
  }

  /**
   * Encode a Telegram chat ID and channel type into a Relay subject.
   *
   * @param platformId - The Telegram chat ID
   * @param channelType - `'dm'` for private chats, `'group'` for group chats
   */
  encode(platformId: string, channelType: 'dm' | 'group'): string {
    if (channelType === 'group') {
      return `${this.prefix}.group.${platformId}`;
    }
    return `${this.prefix}.${platformId}`;
  }

  /**
   * Decode a Relay subject into its Telegram chat ID and channel type.
   *
   * @param subject - The Relay subject string to decode
   * @returns The decoded fields, or `null` if the subject does not match
   */
  decode(subject: string): { platformId: string; channelType: 'dm' | 'group' } | null {
    return decodeSubject(this.prefix, subject);
  }
}

/**
 * Thread ID codec for the Slack adapter.
 *
 * Subjects follow the format:
 * - DM:    `relay.human.slack.<channelId>`
 * - Group: `relay.human.slack.group.<channelId>`
 */
export class SlackThreadIdCodec implements ThreadIdCodec {
  readonly prefix: string;

  /**
   * Create a thread ID codec for Slack adapter threads.
   *
   * @param instanceId - Optional instance identifier for disambiguating multiple
   *   Slack adapter instances. When provided, the prefix becomes
   *   `relay.human.slack.<instanceId>`.
   */
  constructor(instanceId?: string) {
    this.prefix = instanceId ? `relay.human.slack.${instanceId}` : 'relay.human.slack';
  }

  /**
   * Encode a Slack channel ID and channel type into a Relay subject.
   *
   * @param platformId - The Slack channel or DM ID
   * @param channelType - `'dm'` for direct messages, `'group'` for channels
   */
  encode(platformId: string, channelType: 'dm' | 'group'): string {
    if (channelType === 'group') {
      return `${this.prefix}.group.${platformId}`;
    }
    return `${this.prefix}.${platformId}`;
  }

  /**
   * Decode a Relay subject into its Slack channel ID and channel type.
   *
   * @param subject - The Relay subject string to decode
   * @returns The decoded fields, or `null` if the subject does not match
   */
  decode(subject: string): { platformId: string; channelType: 'dm' | 'group' } | null {
    return decodeSubject(this.prefix, subject);
  }
}
