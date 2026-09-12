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
import { Router, type Request, type Response } from 'express';
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
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';
import { parseBody, parseSessionId, sendError } from '../lib/route-utils.js';

/**
 * `mergeParams` so `:id` — the SESSION, owned by the router this one is mounted
 * under — is readable here.
 */
const router = Router({ mergeParams: true });

/** What a handler here reads off the path. */
interface SessionCanvasParams {
  /** The session. Owned by the sessions router. */
  id: string;
  /** The document, on the routes that name one. */
  documentId: string;
}

/** The canvas service plus the scope and caller this request may act as. */
interface CanvasAccess {
  canvas: CanvasService;
  scope: string;
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
 * @param req - The request, for its caller and its `:id`.
 * @param res - The response, for `resolveCaller` and the refusal.
 * @returns The service and scope, or `null` after answering the refusal.
 */
function requireCanvasAccess(
  req: Request<SessionCanvasParams>,
  res: Response
): CanvasAccess | null {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) {
    sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
    return null;
  }
  let caller;
  try {
    caller = resolveCaller(req, res);
  } catch (err) {
    sendRoomError(res, err, 'session-canvas');
    return null;
  }
  if (caller.kind !== 'human') {
    sendError(res, 403, 'A session’s canvas is the person’s own', 'PEOPLE_ONLY');
    return null;
  }
  const canvas = peekCanvasService();
  if (!canvas) {
    sendError(res, 503, 'The canvas is not available on this server', 'CANVAS_UNAVAILABLE');
    return null;
  }
  return { canvas, scope: sessionScope(sessionId) };
}

/** GET / — everything on this session's canvas, pinned first then most recent. */
router.get<SessionCanvasParams>('/', (req, res) => {
  const access = requireCanvasAccess(req, res);
  if (!access) return;
  res.json({ documents: access.canvas.list(access.scope) });
});

/** GET /:documentId — one document, content included. */
router.get<SessionCanvasParams>('/:documentId', (req, res) => {
  const access = requireCanvasAccess(req, res);
  if (!access) return;
  const document = access.canvas.get(access.scope, req.params.documentId);
  if (!document) {
    return sendError(res, 404, 'No such document on this canvas', 'CANVAS_DOCUMENT_NOT_FOUND');
  }
  res.json(document);
});

/** POST / — put something on this session's canvas. */
router.post<SessionCanvasParams>('/', (req, res) => {
  const body = parseBody(OpenCanvasDocumentRequestSchema, req.body, res);
  if (!body) return;
  const access = requireCanvasAccess(req, res);
  if (!access) return;
  try {
    const document = access.canvas.open(access.scope, SESSION_OWNER_AUTHOR, body.content, {
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
    });
    res.status(201).json(document);
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/canvas');
  }
});

/**
 * PATCH /:documentId — change one document: its content, its pin, its place in
 * the order.
 *
 * Applied in that order, and each part is optional, so a caller that only wants
 * to pin something does not have to re-send its content.
 */
router.patch<SessionCanvasParams>('/:documentId', (req, res) => {
  const body = parseBody(UpdateCanvasDocumentRequestSchema, req.body, res);
  if (!body) return;
  const access = requireCanvasAccess(req, res);
  if (!access) return;
  try {
    const { canvas, scope } = access;
    const documentId = req.params.documentId;
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
    res.json(document);
  } catch (err) {
    sendRoomError(res, err, 'PATCH /:id/canvas/:documentId');
  }
});

/** DELETE /:documentId — take a document off the canvas, in every window. */
router.delete<SessionCanvasParams>('/:documentId', (req, res) => {
  const access = requireCanvasAccess(req, res);
  if (!access) return;
  try {
    access.canvas.close(access.scope, req.params.documentId);
    res.status(204).end();
  } catch (err) {
    sendRoomError(res, err, 'DELETE /:id/canvas/:documentId');
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
router.post<SessionCanvasParams>('/:documentId/editing', (req, res) => {
  const body = parseBody(CanvasEditingRequestSchema, req.body, res);
  if (!body) return;
  const access = requireCanvasAccess(req, res);
  if (!access) return;
  try {
    res.json(
      access.canvas.heartbeat(
        access.scope,
        SESSION_OWNER_AUTHOR,
        req.params.documentId,
        body.editing
      )
    );
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/canvas/:documentId/editing');
  }
});

export default router;
