/**
 * The HTTP half of a session's own canvas — six thin handlers over the one
 * writer (spec `canvas-agent-seat` §1.6).
 *
 * **Mounted under the sessions router**, so `:id` is the session and every route
 * here inherits the app-wide session gate the rest of that file describes.
 *
 * **A person is the gate, and there is no membership to check.** A session has
 * no members: it is one person's, so each route refuses a caller presenting an
 * agent identity with `PEOPLE_ONLY` — the same 403 the read-cursor routes give,
 * and for the same reason. An agent never reaches these routes at all; its path
 * is `control_ui` and `read_canvas_document`, neither of which can name a
 * session that is not its own.
 *
 * **The id is whatever the window currently knows the session as**, and these
 * routes do not wait for the canonical one. A canvas opened on a brand-new
 * session lands under the request UUID, and the rekey listener in
 * `services/canvas/index.ts` moves the whole scope when the runtime renames the
 * session mid-first-turn — which is the acceptance criterion this phase is
 * written against ("a document opened on a fresh, un-canonical session survives
 * the first-turn rekey"), and the reason the move is the writer's job rather
 * than the caller's.
 *
 * @module routes/session-canvas
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import {
  CanvasEditingRequestSchema,
  OpenCanvasDocumentRequestSchema,
  UpdateCanvasDocumentRequestSchema,
} from '@dorkos/shared/room-schemas';
import {
  SESSION_OWNER_AUTHOR,
  peekCanvasService,
  sessionScope,
  type CanvasService,
} from '../services/canvas/index.js';
import { RoomError } from '../services/rooms/index.js';
import { peekProjector } from '../services/session/session-state-projector.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { resolveCaller } from './room-caller.js';
import { isOwnerCaller, roomErrorReply } from './room-error-response.js';
import { errorBody, parseSessionId, validationFailureBody } from '../lib/route-utils.js';

/** The canvas service plus the scope this request may act on, and who is asking. */
interface CanvasAccess {
  canvas: CanvasService;
  scope: string;
  /** Whether the caller owns this install, for how a refusal is worded. */
  ownerAsking: () => boolean;
}

/**
 * Refuse anybody who may not act on this session's canvas, and resolve the
 * scope, BEFORE a single row is read.
 *
 * Three refusals, each a different fact about the request:
 *
 * - **400** for a session id that is not one.
 * - **401** for an agent token this machine cannot verify, and **403** for an
 *   agent it can. A session belongs to one person, and no agent reaches it
 *   over HTTP at all.
 * - **503** when this process stood no canvas service up. Honest rather than a
 *   fabricated empty table.
 *
 * @param c - The request context, for its caller and its `:id`.
 * @returns The service and scope, or the refusal to return.
 */
function requireCanvasAccess(c: Context<ApiEnv>): CanvasAccess | Response {
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
  let caller;
  try {
    caller = resolveCaller(honoRequestFacts(c));
  } catch (err) {
    return roomRefusal(c, err, 'session-canvas', () => false);
  }
  if (caller.kind !== 'human') {
    return c.json(errorBody('A session’s canvas is the person’s own', 'PEOPLE_ONLY'), 403);
  }
  const canvas = peekCanvasService();
  if (!canvas) {
    return c.json(
      errorBody('The canvas is not available on this server', 'CANVAS_UNAVAILABLE'),
      503
    );
  }
  return { canvas, scope: sessionScope(sessionId), ownerAsking: () => isOwnerCaller(caller) };
}

/** A thrown room refusal, answered. */
function roomRefusal(
  c: Context<ApiEnv>,
  err: unknown,
  context: string,
  ownerAsking: () => boolean
): Response {
  const reply = roomErrorReply(err, context, ownerAsking);
  return c.json(reply.body, reply.status as ContentfulStatusCode);
}

/** The body parsed by `schema`, or the 400 a body it cannot read answers. */
function parseCanvasBody<T>(c: Context<ApiEnv>, schema: ZodType<T>): T | Response {
  const result = schema.safeParse(readJsonBody(c));
  return result.success ? result.data : c.json(validationFailureBody(result.error), 400);
}

/**
 * Whether this server knows the id names a session, cheaply and without a
 * runtime round trip.
 *
 * **Asked on the POST alone**, because a POST is the only verb here that can
 * MINT a scope. Every other route acts on a document that already exists and
 * 404s when it does not, so none of them can leave rows behind; a list of a
 * scope that holds nothing is an empty list, which creates nothing to reclaim.
 * And a canvas written under an id that never was a session would never BE
 * reclaimed: `sweepOrphanedCanvasDocuments` only deletes scopes that
 * `onSessionRemoved` marked, and nothing removes a session that never existed.
 *
 * Two facts, either of which is enough, and both cheap:
 *
 * - **A projector under that id.** Every window that has a session on screen
 *   has its durable stream attached, and attaching one creates the projector —
 *   so this is true before the window can write anything, including for a
 *   brand-new session that has not taken its first turn.
 * - **A runtime binding row.** Any session that has ever taken a turn has one,
 *   and it survives a restart, so a canvas opened on an old session the moment
 *   it is reopened is covered even if the read raced the stream attach.
 *
 * A database this process cannot read makes the question UNANSWERABLE, which is
 * not the same as absent: it says yes, because refusing a real write is worse
 * than an orphaned row a person can close.
 *
 * @param sessionId - The validated session id.
 * @returns Whether a write may mint this scope.
 */
function namesAKnownSession(sessionId: string): boolean {
  if (peekProjector(sessionId) !== undefined) return true;
  try {
    return runtimeRegistry.getSessionBindings([sessionId]).size > 0;
  } catch {
    return true;
  }
}

const NO_SUCH_DOCUMENT = errorBody('No such document on this canvas', 'CANVAS_DOCUMENT_NOT_FOUND');

/**
 * The six canvas routes, mounted by `routes/sessions.ts` at `/:id/canvas`, so
 * `:id` is the session.
 *
 * @returns The routes.
 */
export function createSessionCanvasRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /** GET / — everything on this session's canvas, pinned first then most recent. */
  router.get('/', (c) => {
    const access = requireCanvasAccess(c);
    if (access instanceof Response) return access;
    return c.json({ documents: access.canvas.list(access.scope) });
  });

  /** GET /:documentId — one document, content included. */
  router.get('/:documentId', (c) => {
    const access = requireCanvasAccess(c);
    if (access instanceof Response) return access;
    const document = access.canvas.get(access.scope, c.req.param('documentId'));
    if (!document) return c.json(NO_SUCH_DOCUMENT, 404);
    return c.json(document);
  });

  /** POST / — put something on this session's canvas. */
  router.post('/', (c) => {
    const body = parseCanvasBody(c, OpenCanvasDocumentRequestSchema);
    if (body instanceof Response) return body;
    const access = requireCanvasAccess(c);
    if (access instanceof Response) return access;
    if (!namesAKnownSession(c.req.param('id')!)) {
      return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);
    }
    try {
      const document = access.canvas.open(access.scope, SESSION_OWNER_AUTHOR, body.content, {
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
        ...(body.channel ? { channel: body.channel } : {}),
      });
      return c.json(document, 201);
    } catch (err) {
      return roomRefusal(c, err, 'POST /:id/canvas', access.ownerAsking);
    }
  });

  /**
   * PATCH /:documentId — change one document: its content, its pin, its place in
   * the order.
   *
   * Applied in that order, and each part is optional, so a caller that only wants
   * to pin something does not have to re-send its content.
   */
  router.patch('/:documentId', (c) => {
    const body = parseCanvasBody(c, UpdateCanvasDocumentRequestSchema);
    if (body instanceof Response) return body;
    const access = requireCanvasAccess(c);
    if (access instanceof Response) return access;
    try {
      const { canvas, scope } = access;
      const documentId = c.req.param('documentId');
      let document = canvas.get(scope, documentId);
      if (body.content !== undefined) {
        document = canvas.update(scope, SESSION_OWNER_AUTHOR, documentId, body.content);
      }
      if (body.pinned !== undefined) {
        document = canvas.pin(scope, documentId, body.pinned);
      }
      if (body.activate === true) {
        document = canvas.activate(scope, documentId);
      }
      if (!document) {
        // Reached only when the body asked for nothing AND the document is gone.
        throw new RoomError('CANVAS_DOCUMENT_NOT_FOUND', 'No such document on this canvas');
      }
      return c.json(document);
    } catch (err) {
      return roomRefusal(c, err, 'PATCH /:id/canvas/:documentId', access.ownerAsking);
    }
  });

  /** DELETE /:documentId — take a document off the canvas, in every window. */
  router.delete('/:documentId', (c) => {
    const access = requireCanvasAccess(c);
    if (access instanceof Response) return access;
    try {
      access.canvas.close(access.scope, c.req.param('documentId'));
      return c.body(null, 204);
    } catch (err) {
      return roomRefusal(c, err, 'DELETE /:id/canvas/:documentId', access.ownerAsking);
    }
  });

  /**
   * POST /:documentId/editing — say you are editing this document, or that you
   * have stopped.
   *
   * While the lock stands, the agent's update to the same document is HELD and
   * the agent is told so rather than reporting success. It earns its keep on a
   * session for the reason the canvas moved to the server at all: two devices on
   * one session is the point.
   */
  router.post('/:documentId/editing', (c) => {
    const body = parseCanvasBody(c, CanvasEditingRequestSchema);
    if (body instanceof Response) return body;
    const access = requireCanvasAccess(c);
    if (access instanceof Response) return access;
    try {
      return c.json(
        access.canvas.heartbeat(
          access.scope,
          SESSION_OWNER_AUTHOR,
          c.req.param('documentId'),
          body.editing
        )
      );
    } catch (err) {
      return roomRefusal(c, err, 'POST /:id/canvas/:documentId/editing', access.ownerAsking);
    }
  });

  return router;
}
