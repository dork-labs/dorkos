/**
 * Derive the session transcript's row model — messages, day dividers, and the unread
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
import { buildTimelineRows, relayTimelineRows, GROUP_GAP_MS } from '@/layers/shared/lib';
import type {
  DayDividerRow,
  TimelineItem,
  TimelineRow,
  UnreadDividerRow,
} from '@/layers/shared/lib';
import type { ChatMessage, MessageAuthor, MessageGrouping } from '@/layers/shared/model';

export { GROUP_GAP_MS };

/**
 * The row id a message is drawn under.
 *
 * Exported because two places have to agree on it and only one of them builds
 * rows: a landing addresses a row by id (`useTimelineLanding`), so a deep link
 * asking for a message has to spell the same string this does. Spelled once
 * here rather than as a prefix repeated at both ends, where it would fail
 * silently — a row id nothing matches just opens the conversation at the
 * bottom, which looks exactly like a link that was never followed.
 *
 * @param messageId - The message's own id.
 */
export function messageRowKey(messageId: string): string {
  return `msg-${messageId}`;
}

/** A rendered message, with the author and grouping the row needs. */
export interface TranscriptMessageRow {
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

/** A row in the session's transcript. */
export type ListRow = TranscriptMessageRow | DayDividerRow | UnreadDividerRow;

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
  /**
   * Where this transcript keeps its last layout, so the next one can reuse the
   * rows nothing changed (DOR-2912). One per transcript; see
   * {@link createListRowsCache}. Omitted, every call lays out from scratch.
   */
  cache?: ListRowsCache;
}

/** A transcript's last layout and what it was built from. */
interface LastLayout {
  messages: readonly ChatMessage[];
  authors: MessageAuthor[];
  items: TimelineItem[];
  resolveAuthor: BuildListRowsOptions['resolveAuthor'];
  now: number;
  lastSeenMessageId: string | null;
  unreadFromStart: boolean;
  timeline: TimelineRow[];
  rows: ListRow[];
}

/** One transcript's layout memory, held by the caller across renders. */
export interface ListRowsCache {
  /** The last layout, or null before the first. */
  last: LastLayout | null;
}

/** A fresh, empty layout memory for one transcript. */
export function createListRowsCache(): ListRowsCache {
  return { last: null };
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
  const { resolveAuthor, now, cache } = options;
  const lastSeenMessageId = options.lastSeenMessageId ?? null;
  const unreadFromStart = options.unreadFromStart ?? false;
  // While a reply streams, only the last message changes from one word to the
  // next. A layout built from the same inputs over the same leading messages
  // (the same objects) keeps its rows for them, and only the tail is laid out
  // again: it was over a millisecond a word on a 3,000-message chat (DOR-2912).
  const last = cache?.last;
  const reusable =
    last &&
    last.resolveAuthor === resolveAuthor &&
    last.now === now &&
    last.lastSeenMessageId === lastSeenMessageId &&
    last.unreadFromStart === unreadFromStart
      ? last
      : null;
  let from = 0;
  if (reusable) {
    const shared = Math.min(messages.length, reusable.messages.length);
    while (from < shared && messages[from] === reusable.messages[from]) from++;
  }
  // Authors are resolved once, up front: the layout pass needs an author id to
  // group on and the rows need the full view model, so resolving twice would
  // both cost more and risk the two passes disagreeing.
  const authors = reusable ? reusable.authors.slice(0, from) : [];
  const items = reusable ? reusable.items.slice(0, from) : [];
  for (let index = authors.length; index < messages.length; index++) {
    const message = messages[index]!;
    const author = resolveAuthor(message, index);
    authors.push(author);
    items.push({ id: message.id, authorId: author.id, timestamp: message.timestamp });
  }
  const timelineOptions = { now, lastSeenId: lastSeenMessageId, unreadFromStart };
  const { rows: timeline, kept } = reusable
    ? relayTimelineRows(items, timelineOptions, reusable.timeline, from)
    : { rows: buildTimelineRows(items, timelineOptions), kept: 0 };

  const rows = reusable ? reusable.rows.slice(0, kept) : [];
  for (let r = kept; r < timeline.length; r++) {
    const row = timeline[r]!;
    rows.push(
      row.kind !== 'item'
        ? row
        : {
            kind: 'message',
            key: messageRowKey(messages[row.index]!.id),
            messageIndex: row.index,
            message: messages[row.index]!,
            grouping: row.grouping,
            author: authors[row.index]!,
          }
    );
  }
  if (cache) {
    cache.last = {
      messages,
      authors,
      items,
      resolveAuthor,
      now,
      lastSeenMessageId,
      unreadFromStart,
      timeline,
      rows,
    };
  }
  return rows;
}
