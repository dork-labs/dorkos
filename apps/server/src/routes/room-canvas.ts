/**
 * The HTTP half of a room's shared canvas — six thin handlers over
 * {@link RoomCanvasService} (spec `room-canvas` §4).
 *
 * **Mounted under the rooms router**, so `:id` is the room and every route here
 * inherits the caller resolution the rest of that file describes: an agent
 * presenting a valid `X-DorkOS-Agent` acts as itself, one presenting a token
 * this machine cannot verify is refused, and anyone else acts as the install's
 * owner. A caller never sends an author.
 *
 * **Membership is the gate, and it is the same gate `GET /:id/events` uses.** An
 * unknown room and a room the caller is not in answer identically, so a room id
 * is never a capability — "not a member" must not be distinguishable from "no
 * such room". The service enforces it on every method; these handlers add no
 * rule of their own.
 *
 * **The four writing routes refuse an archived room; the two reads do not.**
 * That asymmetry is the whole point of archiving: the record survives, the
 * activity stops.
 *
 * @module routes/room-canvas
 */
import { Router } from 'express';
import {
  CanvasEditingRequestSchema,
  OpenCanvasDocumentRequestSchema,
  UpdateCanvasDocumentRequestSchema,
} from '@dorkos/shared/room-schemas';
import { getRoomService, RoomError } from '../services/rooms/index.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';
import { parseBody, sendError } from '../lib/route-utils.js';

/**
 * `mergeParams` so `:id` — the ROOM, owned by the router this one is mounted
 * under — is readable here. Without it every handler would answer about a room
 * with an empty id.
 */
const router = Router({ mergeParams: true });

/**
 * What a handler here reads off the path: the ROOM, from the router this one is
 * mounted under, and the document when the route names one.
 *
 * Declared because `mergeParams` merges at RUNTIME and Express's types cannot
 * see the mount point, so `:id` would otherwise type as absent everywhere.
 */
interface CanvasParams {
  /** The room. Owned by the rooms router. */
  id: string;
  /** The document, on the routes that name one. */
  documentId: string;
}

/** GET / — everything on this room's canvas, pinned first then most recent. */
router.get<CanvasParams>('/', (req, res) => {
  try {
    const service = getRoomService();
    const caller = resolveCaller(req, res);
    // The membership check, asked the same way the stream handler asks it:
    // a room this caller may not see answers 404, and so does one that is not
    // there. Asked before the table is read, so nothing leaks from the shape of
    // the answer.
    if (!service.getRoom(req.params.id, caller.id)) {
      return sendError(res, 404, 'No such room', 'ROOM_NOT_FOUND');
    }
    res.json({ documents: service.canvas.list(req.params.id) });
  } catch (err) {
    sendRoomError(res, err, 'GET /:id/canvas');
  }
});

/** GET /:documentId — one document, content included. */
router.get<CanvasParams>('/:documentId', (req, res) => {
  try {
    const service = getRoomService();
    const caller = resolveCaller(req, res);
    if (!service.getRoom(req.params.id, caller.id)) {
      return sendError(res, 404, 'No such room', 'ROOM_NOT_FOUND');
    }
    const document = service.canvas.get(req.params.id, req.params.documentId);
    if (!document) {
      return sendError(
        res,
        404,
        'No such document on this room’s canvas',
        'CANVAS_DOCUMENT_NOT_FOUND'
      );
    }
    res.json(document);
  } catch (err) {
    sendRoomError(res, err, 'GET /:id/canvas/:documentId');
  }
});

/** POST / — put something on the canvas as yourself. */
router.post<CanvasParams>('/', (req, res) => {
  const body = parseBody(OpenCanvasDocumentRequestSchema, req.body, res);
  if (!body) return;
  try {
    const document = getRoomService().canvas.open(
      req.params.id,
      resolveCaller(req, res).id,
      body.content,
      ...(body.pinned !== undefined ? [{ pinned: body.pinned }] : [])
    );
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
router.patch<CanvasParams>('/:documentId', (req, res) => {
  const body = parseBody(UpdateCanvasDocumentRequestSchema, req.body, res);
  if (!body) return;
  try {
    const service = getRoomService();
    const caller = resolveCaller(req, res).id;
    const roomId = req.params.id;
    const documentId = req.params.documentId;
    let document = service.canvas.get(roomId, documentId);
    if (body.content !== undefined) {
      document = service.canvas.update(roomId, caller, documentId, body.content);
    }
    if (body.pinned !== undefined) {
      document = service.canvas.pin(roomId, caller, documentId, body.pinned);
    }
    if (body.activate === true) {
      document = service.canvas.activate(roomId, caller, documentId);
    }
    if (!document) {
      // Reached only when the body asked for nothing AND the document is gone.
      // The service raises this for every other path, so the two answers agree.
      throw new RoomError('CANVAS_DOCUMENT_NOT_FOUND', 'No such document on this room’s canvas');
    }
    res.json(document);
  } catch (err) {
    sendRoomError(res, err, 'PATCH /:id/canvas/:documentId');
  }
});

/** DELETE /:documentId — take a document off the table. */
router.delete<CanvasParams>('/:documentId', (req, res) => {
  try {
    getRoomService().canvas.close(req.params.id, resolveCaller(req, res).id, req.params.documentId);
    res.status(204).end();
  } catch (err) {
    sendRoomError(res, err, 'DELETE /:id/canvas/:documentId');
  }
});

/**
 * POST /:documentId/editing — say you are editing this document, or that you
 * have stopped.
 *
 * While the lock stands, an agent's update to the same document is HELD and the
 * agent is told so rather than reporting success — the half of ADR `0292` that
 * was deferred and never landed. It lapses on its own once the heartbeats stop,
 * evaluated lazily, so a browser that crashed mid-edit cannot wedge a document.
 */
router.post<CanvasParams>('/:documentId/editing', (req, res) => {
  const body = parseBody(CanvasEditingRequestSchema, req.body, res);
  if (!body) return;
  try {
    res.json(
      getRoomService().canvas.heartbeat(
        req.params.id,
        resolveCaller(req, res).id,
        req.params.documentId,
        body.editing
      )
    );
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/canvas/:documentId/editing');
  }
});

export default router;
