/**
 * The HTTP surface of a session's message queue (spec
 * `persistent-session-runtime` §3.3, task 2.4).
 *
 * Four routes over what {@link dispatchMessage} accepted: read the queue, edit
 * a waiting message, remove one, or send another chat's row now. They live here
 * rather than in `routes/sessions.ts` to keep that file under the size rule,
 * mirroring `session-ui-action-handler.ts`.
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
import type { Context, Hono } from 'hono';
import { UpdateQueuedMessageRequestSchema } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { wifiTurnHeld } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import {
  cancelQueuedMessage,
  editQueuedMessage,
  listQueuedMessages,
} from '../services/session/index.js';
import type { MeshCore } from '@dorkos/mesh';
import { errorBody, parseSessionId } from '../lib/route-utils.js';
import { chatPlaceRefusal } from './session-launcher.js';
import {
  noteRemovedByPerson,
  queuedChatRecordsOf,
  steerQueuedChatMessage,
} from '../services/session/chat-messages/queued/queued-chat-actions.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';

const INVALID_SESSION_ID = errorBody('Invalid session ID', 'INVALID_SESSION_ID');
const INVALID_MESSAGE_ID = errorBody('Invalid message ID', 'INVALID_MESSAGE_ID');
const NOT_QUEUED = errorBody('No such queued message', 'QUEUED_MESSAGE_NOT_FOUND');
const SEND_NOW_PERSON_ONLY = errorBody(
  'Only a person in the DorkOS app can send another chat’s message now.',
  'person_only'
);
const NOT_A_CHAT_MESSAGE = errorBody(
  'Only a message from another chat can be sent now. Move your own instead.',
  'NOT_A_CHAT_MESSAGE'
);
const ALREADY_STARTING = errorBody('That message is already starting.', 'QUEUED_MESSAGE_LAUNCHING');

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
 * @param meshCore - Mesh, which lists the registered homes.
 */
export function sessionQueueUpdateHandler(meshCore: MeshCore | undefined) {
  return async (c: Context<ApiEnv>): Promise<Response> => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(INVALID_SESSION_ID, 400);
    const messageId = parseMessageId(c.req.param('messageId'));
    if (!messageId) return c.json(INVALID_MESSAGE_ID, 400);
    // A waiting message runs as its chat's agent, so only a caller who could post
    // into that chat may reword or move it (DOR-3644 S1).
    const refused = await chatPlaceRefusal(honoRequestFacts(c), meshCore, sessionId);
    if (refused) return c.json(errorBody(refused.message, 'DESK_NOT_OWN'), 403);
    // An empty body is answered with the same 400 as a malformed one.
    const parsed = UpdateQueuedMessageRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
    const { content, move } = parsed.data;
    const message = editQueuedMessage(sessionId, messageId, {
      ...(content !== undefined ? { content } : {}),
      ...(move !== undefined ? { move } : {}),
      // Words reworded from Wi-Fi run at the runtime's default at most, unless they
      // are the owner's own (DOR-3037, DOR-3242).
      ...(content !== undefined && wifiTurnHeld(honoRequestFacts(c))
        ? { holdToDefault: true }
        : {}),
    });
    if (message === 'not-yours') {
      return c.json(
        errorBody(
          'Another chat sent this message. It can be moved or removed, not reworded.',
          'QUEUED_MESSAGE_NOT_YOURS'
        ),
        409
      );
    }
    // Covers both "no such message on this queue" and "the move named an anchor
    // that is not on it" — from the caller's side those are one thing: an id
    // this queue does not have.
    if (!message) return c.json(NOT_QUEUED, 404);
    return c.json({ message, queue: listQueuedMessages(sessionId) });
  };
}

/**
 * `DELETE /api/sessions/:id/queue/:messageId` — take a waiting message off the
 * queue. Its pending dispatch goes with it, so a removed message does not run
 * later.
 *
 * @param meshCore - Mesh, which lists the registered homes.
 */
export function sessionQueueRemoveHandler(meshCore: MeshCore | undefined) {
  return async (c: Context<ApiEnv>): Promise<Response> => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(INVALID_SESSION_ID, 400);
    const messageId = parseMessageId(c.req.param('messageId'));
    if (!messageId) return c.json(INVALID_MESSAGE_ID, 400);
    // Removing a person's waiting message from another agent's chat is that chat's
    // business, not a stranger's (DOR-3644 S1).
    const refused = await chatPlaceRefusal(honoRequestFacts(c), meshCore, sessionId);
    if (refused) return c.json(errorBody(refused.message, 'DESK_NOT_OWN'), 403);
    // Another chat's message: read before it goes, so its sender can be told
    // by name who took it off (DOR-3060).
    const fromChats = queuedChatRecordsOf(sessionId, messageId);
    if (!cancelQueuedMessage(sessionId, messageId)) return c.json(NOT_QUEUED, 404);
    noteRemovedByPerson(fromChats);
    return c.json({ queue: listQueuedMessages(sessionId) });
  };
}

/**
 * `POST /api/sessions/:id/queue/:messageId/steer` — send another chat's
 * waiting message now, or put it first when it cannot safely join the live
 * turn.
 *
 * @param meshCore - Mesh, which lists the registered homes.
 */
export function sessionQueueSteerHandler(meshCore: MeshCore | undefined) {
  return async (c: Context<ApiEnv>): Promise<Response> => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(INVALID_SESSION_ID, 400);
    const messageId = parseMessageId(c.req.param('messageId'));
    if (!messageId) return c.json(INVALID_MESSAGE_ID, 400);
    // A person's act: an agent pushing another agent's words into a running
    // turn is the laundering this route must never offer.
    if (!clearsTheAgentBar(honoRequestFacts(c))) return c.json(SEND_NOW_PERSON_ONLY, 403);
    const refused = await chatPlaceRefusal(honoRequestFacts(c), meshCore, sessionId);
    if (refused) return c.json(errorBody(refused.message, 'DESK_NOT_OWN'), 403);
    const result = await steerQueuedChatMessage(sessionId, messageId);
    if (result.outcome === 'not-found') return c.json(NOT_QUEUED, 404);
    if (result.outcome === 'not-chat-row') return c.json(NOT_A_CHAT_MESSAGE, 409);
    if (result.outcome === 'launching') return c.json(ALREADY_STARTING, 409);
    return c.json(result);
  };
}

/**
 * Register every route over a session's durable message queue.
 *
 * @param router - The session router mounted at `/api/sessions`.
 * @param meshCore - Mesh, which lists the registered homes.
 */
export function registerSessionQueueRoutes(
  router: Hono<ApiEnv>,
  meshCore: MeshCore | undefined
): void {
  router.get('/:id/queue', sessionQueueListHandler);
  router.patch('/:id/queue/:messageId', sessionQueueUpdateHandler(meshCore));
  router.delete('/:id/queue/:messageId', sessionQueueRemoveHandler(meshCore));
  router.post('/:id/queue/:messageId/steer', sessionQueueSteerHandler(meshCore));
}
