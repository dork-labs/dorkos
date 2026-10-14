/**
 * Send a long conversation a window at a time (DOR-2889).
 *
 * A session's hydration snapshot used to carry its whole history, so opening a
 * long chat sent every message it ever held: 15 MB of JSON for one real
 * transcript, all of it rendered before the newest line was on screen. The
 * snapshot now carries the newest {@link HISTORY_WINDOW_LIMIT} messages and says
 * how many it left out; the client reads older ones a page at a time with
 * `GET /api/sessions/:id/messages?before=<message id>`.
 *
 * A message id is the cursor, not a position, so a page asked for after new
 * messages arrived still lands right before the message the reader is looking
 * at. History only ever grows at its end, which is what keeps everything before
 * a given message stable.
 *
 * @module services/session/history/history-window
 */
import type { HistoryMessage, HistoryRead } from '@dorkos/shared/types';
import { HISTORY_PAGE_LIMIT, HISTORY_WINDOW_LIMIT } from '@dorkos/shared/schemas';
import { historyRead } from '../chat-messages/history-read.js';
import { errorBody } from '../../../lib/route-utils.js';

/** The answer to a `?before=` naming a message the history does not hold. */
export const UNKNOWN_CURSOR = errorBody('No message has that id.', 'HISTORY_CURSOR_UNKNOWN');

/**
 * The newest `limit` messages, and how many come before them.
 *
 * @param messages - A whole history, oldest first.
 * @param limit - How many of the newest to keep.
 */
export function newestHistoryWindow(
  messages: HistoryMessage[],
  limit: number = HISTORY_WINDOW_LIMIT
): HistoryRead {
  const earlierMessages = Math.max(0, messages.length - limit);
  return earlierMessages === 0
    ? { messages }
    : { messages: messages.slice(earlierMessages), earlierMessages };
}

/**
 * The page of messages directly before the one named `before`.
 *
 * @param messages - A whole history, oldest first.
 * @param before - The id of the oldest message the reader already has.
 * @param limit - The page size.
 * @returns The page, or `null` when no message has that id.
 */
export function historyPageBefore(
  messages: HistoryMessage[],
  before: string,
  limit: number = HISTORY_PAGE_LIMIT
): HistoryRead | null {
  const end = messages.findIndex((message) => message.id === before);
  if (end === -1) return null;
  const start = Math.max(0, end - limit);
  return { messages: messages.slice(start, end), earlierMessages: start };
}

/** The `GET /api/sessions/:id/messages` query values that shape the answer. */
export interface HistoryQuery {
  /** A message id: that message and everything after it (DOR-2890). */
  since?: unknown;
  /** A message id: the page directly older than it. */
  before?: unknown;
  /** `'1'`: only the newest window, as the stream's snapshot carries. */
  newest?: unknown;
}

/** Whether a query asks for less than the whole history, so no ETag may answer it. */
export function isPartialHistoryQuery(query: HistoryQuery): boolean {
  return Boolean(query.since || query.before || query.newest);
}

/**
 * Shape a finished whole-history answer to what the query asked for: a page
 * before a message, the newest window, a tail since a message, or the whole.
 * Applied after every filter and stamp, so each shape is a slice of the same
 * answer.
 *
 * @param messages - The whole history, filtered and stamped.
 * @param query - The request's query values.
 * @returns The answer, or `null` when `before` names no message.
 */
export function answerHistory(messages: HistoryMessage[], query: HistoryQuery): HistoryRead | null {
  if (typeof query.before === 'string' && query.before.length > 0) {
    return historyPageBefore(messages, query.before);
  }
  if (query.newest === '1') return newestHistoryWindow(messages);
  return historyRead(messages, query.since);
}
