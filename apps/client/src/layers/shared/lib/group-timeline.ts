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

/** A timestamp's epoch ms and local day key, worked out once. */
interface PlacedTime {
  time: number | null;
  dayKey: string | null;
}

/**
 * Every timestamp already placed, by its text (DOR-2895 follow-up, DOR-2912).
 * A streaming reply lays the whole transcript out again on every word, and
 * parsing every message's date each time was most of that cost on a long chat.
 * A timestamp names one instant, so its answer never changes; the day key
 * follows the local time zone, which is why a zone change starts afresh.
 */
const placedTimes = new Map<string, PlacedTime>();
let placedZone = new Date().getTimezoneOffset();

/** The most timestamps kept before starting afresh, so a long-lived tab stays bounded. */
const PLACED_TIMES_MAX = 50_000;

/**
 * Start the timestamp cache afresh if the time zone moved since it was filled,
 * and say so: rows laid out in the old zone hold the old days.
 * Checked once per layout, not per timestamp: the live message's empty
 * timestamp is always cached, so a per-miss check could go unnoticed.
 */
function checkTimeZone(): boolean {
  const zone = new Date().getTimezoneOffset();
  if (zone === placedZone) return false;
  placedTimes.clear();
  placedZone = zone;
  return true;
}

/** {@link parseTimestamp} and {@link dayKeyOf} for one timestamp, cached. */
function placeInTime(timestamp: string): PlacedTime {
  const cached = placedTimes.get(timestamp);
  if (cached) return cached;
  if (placedTimes.size >= PLACED_TIMES_MAX) placedTimes.clear();
  const time = parseTimestamp(timestamp);
  const placed = { time, dayKey: time === null ? null : dayKeyOf(time) };
  placedTimes.set(timestamp, placed);
  return placed;
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
  checkTimeZone();
  return layOut(items, options, [], 0, INITIAL_STATE);
}

/** What the layout pass carries from one item to the next. */
interface LayoutState {
  cursorPassed: boolean;
  unreadPlaced: boolean;
  previousAuthorId: string | null;
  previousDayKey: string | null;
  previousTime: number | null;
}

const INITIAL_STATE: LayoutState = {
  cursorPassed: false,
  unreadPlaced: false,
  previousAuthorId: null,
  previousDayKey: null,
  previousTime: null,
};

/**
 * Lay out a transcript again after its tail changed, keeping the rows of the
 * unchanged part (DOR-2912).
 *
 * A streaming reply changes only the last item on every word, and laying out
 * every row of a long chat again was the largest cost left on that path. The
 * rows up to the start of the group the first changed item could touch are
 * reused as they are, the very same objects, and only the rest is built again.
 * The answer is identical to {@link buildTimelineRows} on the same input.
 *
 * @param items - The transcript, oldest first.
 * @param options - The same options the previous layout used.
 * @param previous - That layout's rows.
 * @param from - How many leading items are unchanged since then: same id,
 *   author and timestamp at the same index. The caller vouches for this, and
 *   for `options` being the ones `previous` was laid out with; a wrong answer
 *   gives wrong rows, not an error. Clamped to the items there are.
 * @returns The rows, and how many leading rows were reused unchanged.
 */
export function relayTimelineRows(
  items: readonly TimelineItem[],
  options: BuildTimelineRowsOptions,
  previous: readonly TimelineRow[],
  from: number
): { rows: TimelineRow[]; kept: number } {
  // Rows laid out in another time zone carry its days, so none are kept.
  if (checkTimeZone()) return { rows: buildTimelineRows(items, options), kept: 0 };
  from = Math.min(from, items.length);
  // Restart at the group holding the last unchanged item: its closing depends
  // on what follows it, which may have changed. Everything before is final.
  let itemRow = -1;
  for (let r = previous.length - 1; r >= 0 && from > 0; r--) {
    const row = previous[r]!;
    if (row.kind !== 'item' || row.index >= from) continue;
    if (row.grouping.position === 'first' || row.grouping.position === 'only') {
      itemRow = r;
      break;
    }
  }
  // Nothing to keep when the restart is the very first item (dividers may sit
  // above it, so the row index alone does not say so).
  const restart = itemRow === -1 ? 0 : (previous[itemRow] as TimelineItemRow).index;
  if (restart === 0) return { rows: buildTimelineRows(items, options), kept: 0 };
  // The dividers drawn for the restart item belong to it, so they go too.
  let kept = itemRow;
  while (kept > 0 && previous[kept - 1]!.kind !== 'item') kept--;
  const state: LayoutState = {
    cursorPassed: options.unreadFromStart ?? false,
    unreadPlaced: false,
    previousAuthorId: items[restart - 1]!.authorId,
    previousDayKey: null,
    previousTime: null,
  };
  // The day and time carry from the nearest earlier item that has one.
  for (let i = restart - 1; i >= 0 && state.previousTime === null; i--) {
    const { time, dayKey } = placeInTime(items[i]!.timestamp);
    state.previousDayKey = dayKey;
    state.previousTime = time;
  }
  if (options.lastSeenId) {
    for (let i = 0; i < restart && !state.cursorPassed; i++) {
      if (items[i]!.id === options.lastSeenId) state.cursorPassed = true;
    }
  }
  for (let r = 0; r < kept; r++)
    if (previous[r]!.kind === 'unread-divider') state.unreadPlaced = true;
  return { rows: layOut(items, options, previous.slice(0, kept), restart, state), kept };
}

/** The layout pass itself, from item `start` on, after the rows already laid. */
function layOut(
  items: readonly TimelineItem[],
  options: BuildTimelineRowsOptions,
  rows: TimelineRow[],
  start: number,
  state: LayoutState
): TimelineRow[] {
  const { now, lastSeenId, unreadFromStart = false } = options;
  let lastItemRow: TimelineItemRow | null = null;
  // Starting "passed" puts the rule above the first item — the reader has a
  // cursor and it sits before everything here.
  let cursorPassed = start === 0 ? unreadFromStart : state.cursorPassed;
  let unreadPlaced = state.unreadPlaced;
  // Carried from the previous item. The author id starts null, which no author
  // matches, so the first item always opens a group. The day and time survive
  // items with no usable timestamp, so a later dated item still compares against
  // the last thing actually known.
  let previousAuthorId: string | null = state.previousAuthorId;
  let previousDayKey: string | null = state.previousDayKey;
  let previousTime: number | null = state.previousTime;

  for (let i = start; i < items.length; i++) {
    const item = items[i]!;
    const { time, dayKey } = placeInTime(item.timestamp);
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
