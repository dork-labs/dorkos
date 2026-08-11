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
import type { Request, Response } from 'express';
import { UpdateQueuedMessageRequestSchema } from '@dorkos/shared/schemas';
import {
  cancelQueuedMessage,
  editQueuedMessage,
  listQueuedMessages,
} from '../services/session/index.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';

/**
 * Read the `messageId` path param.
 *
 * Express 5 widens route params to `string | string[]`; more than one value can
 * only come from a malformed path, so it is rejected rather than guessed at.
 */
function parseMessageId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * `GET /api/sessions/:id/queue` — the messages waiting on this session, head
 * first.
 *
 * @param req - Express request; `:id` is the session
 * @param res - Express response
 */
export function sessionQueueListHandler(req: Request, res: Response): void {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) {
    sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
    return;
  }
  res.json({ queue: listQueuedMessages(sessionId) });
}

/**
 * `PATCH /api/sessions/:id/queue/:messageId` — change a waiting message's words,
 * its place in the queue, or both.
 *
 * A move names another message to land before or after rather than an index:
 * indices mean different things to two windows editing one queue, which is
 * exactly the situation this surface is for.
 *
 * @param req - Express request; `:messageId` is the queued message
 * @param res - Express response
 */
export function sessionQueueUpdateHandler(req: Request, res: Response): void {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) {
    sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
    return;
  }
  const messageId = parseMessageId(req.params.messageId);
  if (!messageId) {
    sendError(res, 400, 'Invalid message ID', 'INVALID_MESSAGE_ID');
    return;
  }
  // Express 5 leaves `req.body` undefined for an empty POST/PATCH body; Zod
  // answers that with the same 400 as a malformed one rather than throwing.
  const parsed = UpdateQueuedMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
    return;
  }
  const { content, move } = parsed.data;
  const message = editQueuedMessage(sessionId, messageId, {
    ...(content !== undefined ? { content } : {}),
    ...(move !== undefined ? { move } : {}),
  });
  if (!message) {
    // Covers both "no such message on this queue" and "the move named an anchor
    // that is not on it" — from the caller's side those are one thing: an id
    // this queue does not have.
    sendError(res, 404, 'No such queued message', 'QUEUED_MESSAGE_NOT_FOUND');
    return;
  }
  res.json({ message, queue: listQueuedMessages(sessionId) });
}

/**
 * `DELETE /api/sessions/:id/queue/:messageId` — take a waiting message off the
 * queue. Its pending dispatch goes with it, so a removed message does not run
 * later.
 *
 * @param req - Express request; `:messageId` is the queued message
 * @param res - Express response
 */
export function sessionQueueRemoveHandler(req: Request, res: Response): void {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) {
    sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
    return;
  }
  const messageId = parseMessageId(req.params.messageId);
  if (!messageId) {
    sendError(res, 400, 'Invalid message ID', 'INVALID_MESSAGE_ID');
    return;
  }
  const removed = cancelQueuedMessage(sessionId, messageId);
  if (!removed) {
    sendError(res, 404, 'No such queued message', 'QUEUED_MESSAGE_NOT_FOUND');
    return;
  }
  res.json({ queue: listQueuedMessages(sessionId) });
}
