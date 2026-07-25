/**
 * Derive the message list's row model — messages, day dividers, and the unread
 * rule — from a transcript, in one pass.
 *
 * @module features/chat/lib/build-list-rows
 */
import { TIME_UNITS } from '@/layers/shared/lib';
import type { ChatMessage, MessageAuthor, MessageGrouping } from '@/layers/shared/model';

/**
 * Silence longer than this starts a new visual group even when the same author
 * keeps talking (spec `multi-participant-message-list`, D5 — Slack's rule).
 */
export const GROUP_GAP_MS = 5 * TIME_UNITS.MS_PER_MINUTE;

/** One calendar day in ms — used only to count whole days back for a divider label. */
const MS_PER_DAY = 24 * TIME_UNITS.MS_PER_HOUR;

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

/** A full-bleed rule marking the start of a calendar day. */
export interface DayDividerRow {
  kind: 'day-divider';
  key: string;
  /** Label shown in the divider's centered chip, e.g. "Today" or "Monday, July 21". */
  label: string;
}

/** The "New messages" rule. At most one per list. */
export interface UnreadDividerRow {
  kind: 'unread-divider';
  key: string;
}

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
}

/** Epoch ms for a message timestamp, or null when it is missing or unparseable. */
function parseTimestamp(timestamp: string): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** Local calendar day key (`2026-7-25`) — the day-boundary comparison key. */
function dayKeyOf(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Midnight (local) of the day a timestamp falls in. */
function startOfDay(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Day-divider label: Today, Yesterday, then a weekday-qualified date, adding the
 * year once the day is outside the current one. Locale is pinned to `en-US`,
 * matching the rest of the client's date formatting.
 */
function formatDayLabel(time: number, now: number): string {
  // Rounding the whole-day distance keeps DST shifts from reading as ±1 day.
  const daysAgo = Math.round((startOfDay(now) - startOfDay(time)) / MS_PER_DAY);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  const date = new Date(time);
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Seal a group's last row: a lone `first` becomes `only`, a `middle` becomes `last`. */
function closeGroup(row: MessageListRow): void {
  row.grouping = {
    ...row.grouping,
    position: row.grouping.position === 'first' ? 'only' : 'last',
  };
}

/**
 * Build the virtualized row list for a transcript.
 *
 * One O(n) pass computes author-based grouping, day boundaries, and the unread
 * position together. Replaces the old role-based `computeGrouping`: groups now
 * break on author change, a {@link GROUP_GAP_MS} gap, or a day boundary, and
 * dividers are real rows so their heights participate in virtual measurement.
 *
 * @param messages - The rendered transcript, oldest first.
 * @param options - Author resolution, the current time, and the unread cursor.
 */
export function buildListRows(
  messages: readonly ChatMessage[],
  options: BuildListRowsOptions
): ListRow[] {
  const { resolveAuthor, now, lastSeenMessageId } = options;
  const rows: ListRow[] = [];
  let lastMessageRow: MessageListRow | null = null;
  let cursorPassed = false;
  let unreadPlaced = false;
  // Carried from the previous message. The author id starts null, which no
  // author matches, so the first message always opens a group. The day and time
  // survive messages with no usable timestamp, so a later dated message still
  // compares against the last thing actually known.
  let previousAuthorId: string | null = null;
  let previousDayKey: string | null = null;
  let previousTime: number | null = null;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const author = resolveAuthor(message, i);
    const time = parseTimestamp(message.timestamp);
    const dayKey = time === null ? null : dayKeyOf(time);
    const dayChanged = dayKey !== null && dayKey !== previousDayKey;

    if (dayChanged && time !== null) {
      // The message index keeps the key unique even if a transcript ever runs
      // non-monotonic across midnight and revisits a calendar day.
      rows.push({
        kind: 'day-divider',
        key: `day-${dayKey}-${i}`,
        label: formatDayLabel(time, now),
      });
    }
    // The rule sits before the first message the reader has not seen, so it is
    // placed once the cursor message is behind us — never for an absent cursor.
    const unreadHere = cursorPassed && !unreadPlaced;
    if (unreadHere) {
      rows.push({ kind: 'unread-divider', key: `unread-${message.id}` });
      unreadPlaced = true;
    }
    if (lastSeenMessageId && message.id === lastSeenMessageId) cursorPassed = true;

    // A group breaks on a different author, a day boundary, silence longer than
    // GROUP_GAP_MS (spec D5), or the unread rule. The rule re-opens the group
    // for the same reason a day boundary does: a full-bleed separator followed
    // by a nameless, avatar-less continuation orphans that message — the first
    // thing you have not read should say who is talking. Slack does the same.
    const isGroupStart =
      previousAuthorId !== author.id ||
      dayChanged ||
      unreadHere ||
      (previousTime !== null && time !== null && time - previousTime > GROUP_GAP_MS);
    if (isGroupStart && lastMessageRow) closeGroup(lastMessageRow);
    const row: MessageListRow = {
      kind: 'message',
      key: `msg-${message.id}`,
      messageIndex: i,
      message,
      // Provisional — closeGroup upgrades 'first' to 'only' and 'middle' to
      // 'last' once the group turns out to end at this row.
      grouping: { position: isGroupStart ? 'first' : 'middle' },
      author,
    };
    rows.push(row);
    lastMessageRow = row;
    previousAuthorId = author.id;
    previousDayKey = dayKey ?? previousDayKey;
    previousTime = time ?? previousTime;
  }

  if (lastMessageRow) closeGroup(lastMessageRow);
  return rows;
}
