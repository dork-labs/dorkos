/**
 * The HTTP surface of a session's message queue (spec
 * `persistent-session-runtime` §3.3, task 2.4).
 *
 * Three routes over what {@link dispatchMessage} accepted: read the queue, edit
 * a waiting message, remove one. They live here rather than in `routes/sessions.ts`
 * to keep that file under the size rule, mirroring `session-ui-action-handler.ts`.
 *
 * **The queue belongs to the session, not to a window.** Any client may edit or
 * remove any message on it — that is the point of moving the queue off the
 * client (ADR-0104's local FIFO was invisible to a second window). The
 * `enqueuedBy` field is there so a window can SAY which chips are its own, never
 * so the server can refuse the others.
 *
 * `GET` is deliberately redundant with the session snapshot, which carries the
 * same list. It exists for integrations and for debugging, where opening an SSE
 * stream to read one small list is a poor trade.
 *
 * @module routes/session-queue-handler
 */
import type { Context } from 'hono';
import { UpdateQueuedMessageRequestSchema } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { isFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import {
  cancelQueuedMessage,
  editQueuedMessage,
  listQueuedMessages,
} from '../services/session/index.js';
import { errorBody, parseSessionId } from '../lib/route-utils.js';

const INVALID_SESSION_ID = errorBody('Invalid session ID', 'INVALID_SESSION_ID');
const INVALID_MESSAGE_ID = errorBody('Invalid message ID', 'INVALID_MESSAGE_ID');
const NOT_QUEUED = errorBody('No such queued message', 'QUEUED_MESSAGE_NOT_FOUND');

/** Read the `messageId` path param: an empty one is refused rather than guessed at. */
function parseMessageId(raw: string | undefined): string | undefined {
  return raw ? raw : undefined;
}

/**
 * `GET /api/sessions/:id/queue` — the messages waiting on this session, head
 * first.
 *
 * @param c - The request context; `:id` is the session
 */
export function sessionQueueListHandler(c: Context<ApiEnv>): Response {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(INVALID_SESSION_ID, 400);
  return c.json({ queue: listQueuedMessages(sessionId) });
}

/**
 * `PATCH /api/sessions/:id/queue/:messageId` — change a waiting message's words,
 * its place in the queue, or both.
 *
 * A move names another message to land before or after rather than an index:
 * indices mean different things to two windows editing one queue, which is
 * exactly the situation this surface is for.
 *
 * @param c - The request context; `:messageId` is the queued message
 */
export function sessionQueueUpdateHandler(c: Context<ApiEnv>): Response {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(INVALID_SESSION_ID, 400);
  const messageId = parseMessageId(c.req.param('messageId'));
  if (!messageId) return c.json(INVALID_MESSAGE_ID, 400);
  // An empty body is answered with the same 400 as a malformed one.
  const parsed = UpdateQueuedMessageRequestSchema.safeParse(readJsonBody(c));
  if (!parsed.success) return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
  const { content, move } = parsed.data;
  const message = editQueuedMessage(sessionId, messageId, {
    ...(content !== undefined ? { content } : {}),
    ...(move !== undefined ? { move } : {}),
    // Words reworded from Wi-Fi run at the runtime's default at most (DOR-3037).
    ...(content !== undefined && isFromWifi(honoRequestFacts(c)) ? { holdToDefault: true } : {}),
  });
  // Covers both "no such message on this queue" and "the move named an anchor
  // that is not on it" — from the caller's side those are one thing: an id
  // this queue does not have.
  if (!message) return c.json(NOT_QUEUED, 404);
  return c.json({ message, queue: listQueuedMessages(sessionId) });
}

/**
 * `DELETE /api/sessions/:id/queue/:messageId` — take a waiting message off the
 * queue. Its pending dispatch goes with it, so a removed message does not run
 * later.
 *
 * @param c - The request context; `:messageId` is the queued message
 */
export function sessionQueueRemoveHandler(c: Context<ApiEnv>): Response {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(INVALID_SESSION_ID, 400);
  const messageId = parseMessageId(c.req.param('messageId'));
  if (!messageId) return c.json(INVALID_MESSAGE_ID, 400);
  if (!cancelQueuedMessage(sessionId, messageId)) return c.json(NOT_QUEUED, 404);
  return c.json({ queue: listQueuedMessages(sessionId) });
}
