/**
 * The shared row model behind every multi-participant transcript: author
 * grouping, day boundaries, and the unread rule, in one pass.
 *
 * Extracted from the chat message list when rooms arrived (spec `rooms` §7).
 * Session chat and a room render the same rows for the same reasons — a group
 * breaks when someone else speaks, a day boundary is a full-bleed rule, the
 * unread rule re-opens the group beneath it — and two copies of these rules
 * would drift the first time one of them was tuned. What differs between the two
 * is the shape of the thing being rendered, so that stays with each caller and
 * only `(id, authorId, timestamp)` comes here.
 *
 * @module shared/lib/group-timeline
 */
import { TIME_UNITS } from './constants';
import type { MessageGrouping } from '@/layers/shared/model';

/**
 * Silence longer than this starts a new visual group even when the same author
 * keeps talking (spec `multi-participant-message-list`, D5 — Slack's rule).
 */
export const GROUP_GAP_MS = 5 * TIME_UNITS.MS_PER_MINUTE;

/** One calendar day in ms — used only to count whole days back for a divider label. */
const MS_PER_DAY = 24 * TIME_UNITS.MS_PER_HOUR;

/** The three things this needs to know about anything it lays out. */
export interface TimelineItem {
  /** Stable id. Keys the row and anchors the unread cursor. */
  id: string;
  /** Who said it. A group breaks when this changes. */
  authorId: string;
  /** ISO timestamp. An unparseable or empty value simply skips day/gap logic. */
  timestamp: string;
}

/** One laid-out item, pointing back at its index in the caller's array. */
export interface TimelineItemRow {
  kind: 'item';
  /** React key. Stable across renders for the same item. */
  key: string;
  /**
   * Index into the ORIGINAL items array — NOT the row index.
   *
   * Load-bearing: callers compare item positions (the chat widget-fence
   * supersede rule and its entry-animation gate both do), so they must read this
   * and never the row index, which dividers shift.
   */
  index: number;
  grouping: MessageGrouping;
}

/** What {@link unreadPlacement} needs of an entry: an id and its position. */
export interface PositionedItem {
  /** Stable id. The rule is placed relative to it. */
  id: string;
  /** Monotonic position within the thread, counting up from one. */
  seq: number;
}

/** Where the "New messages" rule goes, if anywhere. */
export interface UnreadPlacement {
  /** Id of the newest entry already read; the rule goes just after it. */
  lastSeenId: string | null;
  /** Everything on screen is unread, so the rule goes above the first entry. */
  fromStart: boolean;
}

/** No rule at all: caught up, or no cursor to place. */
const NO_RULE: UnreadPlacement = { lastSeenId: null, fromStart: false };

/**
 * Translate a read cursor into a rule position — the ONE set of rules, for every
 * kind of thread there is.
 *
 * A cursor stores a position while the rule is placed relative to an id, so this
 * is the translation between the two — and it has to distinguish three things a
 * plain `seq → id` lookup collapses into one `null`: no cursor at all (no rule),
 * caught up (no rule), and a reader who has read NOTHING (rule at the top,
 * because the sidebar is badging that thread and the two must agree).
 *
 * Rooms feed it their entries' own `seq`; a session's transcript feeds it the
 * position of each message, which is what a session cursor counts
 * (`features/chat/model/view/use-unread-cursor`). Same input shape, same rule,
 * so the same read state draws the same line on both surfaces — which is the
 * point of there being one cursor table behind them.
 *
 * A cursor ABOVE everything on screen means the two surfaces want different
 * things — a room has paged past it (everything loaded is unread), a session has
 * been trimmed below it (everything left was seen) — so neither is decided here:
 * the caller says which it is by clamping, or not, before it asks.
 *
 * @param entries - The rendered history, oldest first, in position order.
 * @param lastReadSeq - The reader's cursor, or null when they have none here.
 */
export function unreadPlacement(
  entries: readonly PositionedItem[],
  lastReadSeq: number | null
): UnreadPlacement {
  // No cursor: nothing to place. Whatever badges this thread badges nothing
  // either, so the two agree.
  if (lastReadSeq === null) return NO_RULE;

  const newest = entries[entries.length - 1];
  // Nothing to read, or nothing unread — the newest entry is at or below the cursor.
  if (!newest || newest.seq <= lastReadSeq) return NO_RULE;

  // A reader who has read nothing has a real cursor sitting at zero, and every
  // entry is above it. The rule belongs above the first one — not absent, which
  // is what the sidebar badge would be contradicting.
  if (lastReadSeq <= 0) return { lastSeenId: null, fromStart: true };

  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.seq <= lastReadSeq) return { lastSeenId: entries[i]!.id, fromStart: false };
  }
  // The cursor is above every entry this page holds, so everything on screen is
  // unread.
  return { lastSeenId: null, fromStart: true };
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

/** A row in a laid-out transcript. */
export type TimelineRow = TimelineItemRow | DayDividerRow | UnreadDividerRow;

/** Inputs {@link buildTimelineRows} needs from its caller. */
export interface BuildTimelineRowsOptions {
  /**
   * "Now" as epoch ms, used only to phrase day labels as Today/Yesterday. Taken
   * as input so the function never reads the clock and tests stay deterministic.
   */
  now: number;
  /**
   * Id of the newest item the reader has already seen. The unread rule goes
   * immediately before the next item after it. No cursor — or a cursor whose
   * item is no longer in the transcript — renders no rule.
   */
  lastSeenId?: string | null;
  /**
   * Everything here is unread, so the rule goes above the first item.
   *
   * Distinct from an absent `lastSeenId`, which means "no cursor at all, draw
   * nothing": a room member who has joined but read nothing has a real cursor
   * sitting at zero, and the sidebar badges that room. Without this the badge
   * would say "5" while the room showed no line — a contradiction the reader
   * can see.
   */
  unreadFromStart?: boolean;
}

/** Epoch ms for a timestamp, or null when it is missing or unparseable. */
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
 *
 * @param time - The timestamp being labelled, as epoch ms.
 * @param now - "Now" as epoch ms.
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
function closeGroup(row: TimelineItemRow): void {
  row.grouping = {
    ...row.grouping,
    position: row.grouping.position === 'first' ? 'only' : 'last',
  };
}

/**
 * Lay out a transcript: author-based grouping, day boundaries, and the unread
 * position, computed together in one O(n) pass.
 *
 * Dividers are real rows so their heights participate in virtual measurement.
 *
 * @param items - The transcript, oldest first.
 * @param options - The current time and the unread cursor.
 */
export function buildTimelineRows(
  items: readonly TimelineItem[],
  options: BuildTimelineRowsOptions
): TimelineRow[] {
  const { now, lastSeenId, unreadFromStart = false } = options;
  const rows: TimelineRow[] = [];
  let lastItemRow: TimelineItemRow | null = null;
  // Starting "passed" puts the rule above the first item — the reader has a
  // cursor and it sits before everything here.
  let cursorPassed = unreadFromStart;
  let unreadPlaced = false;
  // Carried from the previous item. The author id starts null, which no author
  // matches, so the first item always opens a group. The day and time survive
  // items with no usable timestamp, so a later dated item still compares against
  // the last thing actually known.
  let previousAuthorId: string | null = null;
  let previousDayKey: string | null = null;
  let previousTime: number | null = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const time = parseTimestamp(item.timestamp);
    const dayKey = time === null ? null : dayKeyOf(time);
    const dayChanged = dayKey !== null && dayKey !== previousDayKey;

    if (dayChanged && time !== null) {
      // The index keeps the key unique even if a transcript ever runs
      // non-monotonic across midnight and revisits a calendar day.
      rows.push({
        kind: 'day-divider',
        key: `day-${dayKey}-${i}`,
        label: formatDayLabel(time, now),
      });
    }
    // The rule sits before the first item the reader has not seen, so it is
    // placed once the cursor item is behind us — never for an absent cursor.
    const unreadHere = cursorPassed && !unreadPlaced;
    if (unreadHere) {
      rows.push({ kind: 'unread-divider', key: `unread-${item.id}` });
      unreadPlaced = true;
    }
    if (lastSeenId && item.id === lastSeenId) cursorPassed = true;

    // A group breaks on a different author, a day boundary, silence longer than
    // GROUP_GAP_MS (spec D5), or the unread rule. The rule re-opens the group
    // for the same reason a day boundary does: a full-bleed separator followed
    // by a nameless, avatar-less continuation orphans that item — the first
    // thing you have not read should say who is talking. Slack does the same.
    const isGroupStart =
      previousAuthorId !== item.authorId ||
      dayChanged ||
      unreadHere ||
      (previousTime !== null && time !== null && time - previousTime > GROUP_GAP_MS);
    if (isGroupStart && lastItemRow) closeGroup(lastItemRow);
    const row: TimelineItemRow = {
      kind: 'item',
      key: `item-${item.id}`,
      index: i,
      // Provisional — closeGroup upgrades 'first' to 'only' and 'middle' to
      // 'last' once the group turns out to end at this row.
      grouping: { position: isGroupStart ? 'first' : 'middle' },
    };
    rows.push(row);
    lastItemRow = row;
    previousAuthorId = item.authorId;
    previousDayKey = dayKey ?? previousDayKey;
    previousTime = time ?? previousTime;
  }

  if (lastItemRow) closeGroup(lastItemRow);
  return rows;
}
