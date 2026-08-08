/**
 * Derive the message list's row model — messages, day dividers, and the unread
 * rule — from a transcript.
 *
 * The layout rules themselves (author grouping, the 5-minute gap, day
 * boundaries, where the unread rule goes) live in `shared/lib/group-timeline`,
 * shared with the room view: both render the same rows for the same reasons, and
 * a second copy of those rules would drift the first time one was tuned. This
 * module owns only what is specific to session chat — resolving each message's
 * author and carrying the `ChatMessage` onto its row.
 *
 * @module features/chat/lib/build-list-rows
 */
import { buildTimelineRows, GROUP_GAP_MS } from '@/layers/shared/lib';
import type { DayDividerRow, UnreadDividerRow } from '@/layers/shared/lib';
import type { ChatMessage, MessageAuthor, MessageGrouping } from '@/layers/shared/model';

export { GROUP_GAP_MS };

/** A rendered message, with the author and grouping the row needs. */
export interface MessageListRow {
  kind: 'message';
  /** React key. Stable across renders for the same message. */
  key: string;
  /**
   * Index into the ORIGINAL messages array — NOT the row index.
   *
   * Load-bearing: the widget-fence supersede rule (DOR-302) and the `isNew`
   * entry-animation gate both compare message positions, so they must read this
   * and never the virtual row index, which dividers shift.
   */
  messageIndex: number;
  message: ChatMessage;
  grouping: MessageGrouping;
  author: MessageAuthor;
}

// The two divider rows are the shared ones, re-exported rather than re-declared:
// they are produced by `buildTimelineRows` and identical for chat and rooms, and
// a second copy of the interfaces would be the drift the extraction exists to
// prevent.
export type { DayDividerRow, UnreadDividerRow };

/** A row in the virtualized message list. */
export type ListRow = MessageListRow | DayDividerRow | UnreadDividerRow;

/** Inputs {@link buildListRows} needs from its caller. */
export interface BuildListRowsOptions {
  /**
   * Resolves a message's author. Injected (rather than imported) so this
   * function stays pure and the caller can memoize identity resolution per
   * session instead of per message.
   */
  resolveAuthor: (message: ChatMessage, index: number) => MessageAuthor;
  /**
   * "Now" as epoch ms, used only to phrase day labels as Today/Yesterday. Taken
   * as input so the function never reads the clock and tests stay deterministic.
   */
  now: number;
  /**
   * Id of the newest message the reader has already seen. The unread rule goes
   * immediately before the next message after it. No cursor — or a cursor whose
   * message is no longer in the transcript — renders no rule.
   */
  lastSeenMessageId?: string | null;
  /**
   * Everything in the transcript is unread, so the rule goes above the first
   * message. Distinct from an absent `lastSeenMessageId` ("draw nothing"), and
   * the same distinction a room draws — see `unreadPlacement`.
   */
  unreadFromStart?: boolean;
}

/**
 * Build the virtualized row list for a transcript.
 *
 * @param messages - The rendered transcript, oldest first.
 * @param options - Author resolution, the current time, and the unread cursor.
 */
export function buildListRows(
  messages: readonly ChatMessage[],
  options: BuildListRowsOptions
): ListRow[] {
  const { resolveAuthor, now, lastSeenMessageId, unreadFromStart } = options;
  // Authors are resolved once, up front: the layout pass needs an author id to
  // group on and the rows need the full view model, so resolving twice would
  // both cost more and risk the two passes disagreeing.
  const authors = messages.map((message, index) => resolveAuthor(message, index));

  return buildTimelineRows(
    messages.map((message, index) => ({
      id: message.id,
      authorId: authors[index]!.id,
      timestamp: message.timestamp,
    })),
    { now, lastSeenId: lastSeenMessageId, unreadFromStart }
  ).map((row): ListRow => {
    if (row.kind !== 'item') return row;
    return {
      kind: 'message',
      key: `msg-${messages[row.index]!.id}`,
      messageIndex: row.index,
      message: messages[row.index]!,
      grouping: row.grouping,
      author: authors[row.index]!,
    };
  });
}
