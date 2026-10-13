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
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { HistoryMessage, HistoryPage } from '@dorkos/shared/types';
import { HISTORY_PAGE_LIMIT, HISTORY_WINDOW_LIMIT } from '@dorkos/shared/schemas';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import { stampHistory } from '../chat-messages/chat-message-stamps.js';

/**
 * The newest `limit` messages, and how many come before them.
 *
 * @param messages - A whole history, oldest first.
 * @param limit - How many of the newest to keep.
 */
export function newestHistoryWindow(
  messages: HistoryMessage[],
  limit: number = HISTORY_WINDOW_LIMIT
): HistoryPage {
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
): HistoryPage | null {
  const end = messages.findIndex((message) => message.id === before);
  if (end === -1) return null;
  const start = Math.max(0, end - limit);
  return { messages: messages.slice(start, end), earlierMessages: start };
}

/**
 * What `GET /api/sessions/:id/messages` answers: the whole history, or with
 * `before` the page directly older than that message.
 *
 * Both answers pass the same wire seams the stream's snapshot does. The
 * auto-first-turn kickoff (M4) never leaves the server as a user message,
 * whichever runtime stored it (`@dorkos/shared/kickoff`), and it is dropped
 * BEFORE paging so a page boundary never lands on it. A message another chat
 * sent carries its sender, stamped from the server's own record of the send
 * (spec `spin-off-chats` §2), never read from the text.
 *
 * @param runtime - The session's runtime.
 * @param cwd - The session's boundary-checked directory.
 * @param sessionId - The client-facing id the request named.
 * @param internalSessionId - The runtime's own id for it.
 * @param before - The oldest message the reader has, for a page of older ones.
 * @returns The history or page, or `null` when `before` names no message.
 */
export async function readHistoryPage(
  runtime: AgentRuntime,
  cwd: string,
  sessionId: string,
  internalSessionId: string,
  before: string | undefined
): Promise<HistoryPage | null> {
  const history = filterKickoffHistory(await runtime.getMessageHistory(cwd, internalSessionId));
  const page = before ? historyPageBefore(history, before) : { messages: history };
  if (!page) return null;
  return {
    ...page,
    messages: stampHistory([...new Set([sessionId, internalSessionId])], page.messages),
  };
}
