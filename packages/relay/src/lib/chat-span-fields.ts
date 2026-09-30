/**
 * What a trace span records about a message a chat connection brought in.
 *
 * The observed-chats list (DOR-2590) reads spans to show which chats have
 * messaged a connection. The subject names the chat; these fields add the one
 * thing it cannot: a name a person recognises instead of an id like
 * `-1001234567890`, and whether the message said anything at all.
 *
 * **Never the message body.** Only the payload's top-level `channelName` /
 * `senderName` display strings and a content-empty flag are read, and only for
 * a message published by a chat connection (`relay.human.*` sender). An
 * agent's reply to the same chat subject records nothing here.
 *
 * @module relay/lib/chat-span-fields
 */

/**
 * Longest display name a span keeps, in code points. The name is set by whoever is on the
 * other end of the chat, so it is bounded before it reaches a durable row, the
 * same bound the unclaimed-chat store uses.
 */
const MAX_CHAT_NAME_LENGTH = 200;

/** Chat fields recorded on a span's metadata. */
export interface ChatSpanFields {
  /** The group title, or for a direct message the other person's name. */
  chatName?: string;
  /** True when the message carried no text, e.g. "the bot was added to a group". */
  emptyContent?: true;
}

/** Read a trimmed, bounded, non-empty string field off an object payload. */
function displayString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Cut by code point, not UTF-16 unit, so an emoji or other astral character
  // at the boundary is dropped whole instead of split into a lone surrogate.
  const codePoints = Array.from(trimmed);
  return codePoints.length > MAX_CHAT_NAME_LENGTH
    ? codePoints.slice(0, MAX_CHAT_NAME_LENGTH).join('')
    : trimmed;
}

/**
 * Derive the chat fields for one published message's span.
 *
 * @param from - The envelope's sender. Only a `relay.human.*` sender, a chat
 *   connection publishing what a chat sent, yields any fields.
 * @param payload - The published payload.
 * @returns The fields to merge into the span metadata; empty when none apply.
 */
export function chatSpanFields(from: string, payload: unknown): ChatSpanFields {
  if (!from.startsWith('relay.human.')) return {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  // A group is named by its title only. Its sender changes from message to
  // message, so falling back to it would rename the group after whoever spoke
  // last; a direct message has one other person, whose name is the chat's.
  const isGroup = record.channelType === 'group';
  const chatName =
    displayString(record, 'channelName') ??
    (isGroup ? undefined : displayString(record, 'senderName'));
  // A captionless photo or voice note also has empty `content`, but carries a
  // `platformData.media` descriptor and is a real message; only a publish with
  // neither (the bot being added to a group) said nothing.
  const platformData = record.platformData as Record<string, unknown> | undefined;
  const hasMedia = !!platformData && typeof platformData === 'object' && !!platformData.media;
  const emptyContent =
    typeof record.content === 'string' && record.content.trim() === '' && !hasMedia;
  return {
    ...(chatName ? { chatName } : {}),
    ...(emptyContent ? { emptyContent: true as const } : {}),
  };
}
