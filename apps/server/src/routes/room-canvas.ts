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
import { Router, type Request, type Response } from 'express';
import {
  CanvasEditingRequestSchema,
  CanvasViewingRequestSchema,
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

/**
 * Refuse anybody who may not act on this room's canvas, BEFORE a single row is
 * read.
 *
 * **The order is the whole of it.** `resolveCaller` answers for any
 * authenticated caller — that is its job — so a handler that reads first and
 * gates afterwards has already fetched the document by the time it decides
 * whether the reader may have it. `requireMembership` is the gate every other
 * room read uses, and it refuses a non-member with the same `ROOM_NOT_FOUND` a
 * room that does not exist gets, so a room id is never a probe.
 *
 * `forWrite` adds the archived-room refusal. Reads answer for an archived room
 * on purpose — the record survives, the activity stops — and putting that check
 * on a read would take the record away with it.
 *
 * @param req - The request, for its caller and its `:id`.
 * @param res - The response, for `resolveCaller`.
 * @param forWrite - Whether this route changes the canvas.
 * @returns The caller's author id.
 * @throws {RoomError} `ROOM_NOT_FOUND` for a stranger, `ROOM_ARCHIVED` for a
 *   write into a room that has been put away.
 */
function requireCanvasAccess(req: Request<CanvasParams>, res: Response, forWrite: boolean): string {
  const callerId = resolveCaller(req, res).id;
  const room = getRoomService().requireMembership(req.params.id, callerId);
  if (forWrite && room.archived) {
    throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
  }
  return callerId;
}

/** GET / — everything on this room's canvas, pinned first then most recent. */
router.get<CanvasParams>('/', (req, res) => {
  try {
    requireCanvasAccess(req, res, false);
    res.json({ documents: getRoomService().canvas.list(req.params.id) });
  } catch (err) {
    sendRoomError(res, err, 'GET /:id/canvas');
  }
});

/** GET /:documentId — one document, content included. */
router.get<CanvasParams>('/:documentId', (req, res) => {
  try {
    requireCanvasAccess(req, res, false);
    const document = getRoomService().canvas.get(req.params.id, req.params.documentId);
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
    const caller = requireCanvasAccess(req, res, true);
    const document = getRoomService().canvas.open(
      req.params.id,
      caller,
      body.content,
      ...(body.pinned !== undefined ? [{ pinned: body.pinned }] : [])
    );
    res.status(201).json(document);
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/canvas');
  }
});

/**
 * POST /viewing — say which document on this canvas you are looking at, or that
 * you have looked away.
 *
 * **A read's gate, not a write's.** Looking at an archived room's canvas is
 * allowed exactly as reading it is, and nothing here changes the record: the
 * whole effect is one ephemeral `signal` frame that puts a small face on that
 * tab for the room's other readers. It is never written down and never replayed.
 *
 * **People only, and this one is an invariant rather than a convention**
 * (etiquette E16a, `specs/room-presence`: a mechanical presence signal is the
 * system's, never something a model chose to send). An agent's face on a
 * document means a turn that is really running really read it, and the server
 * puts it there from `read_canvas` under a live claim — *not* from a route. A
 * member agent could otherwise paint its own face on any tab with no turn
 * behind it, using the token every spawned agent has in its environment; and
 * because an agent holds no room stream, nothing would ever take that face off
 * again. So a caller presenting `X-DorkOS-Agent` is refused 403 `PEOPLE_ONLY`,
 * the same instrument `GET /:id/sessions` and `PATCH /authors/:authorId/handle`
 * use, and one presenting a token this machine cannot verify is refused 401 by
 * `resolveCaller` before this handler runs.
 *
 * The gate is AFTER the membership check for the reason `GET /:id/sessions`
 * gives: visibility first means an agent probing room ids cannot tell 403 from
 * 404.
 *
 * Declared above `/:documentId` so the literal path is matched before the
 * parameter would swallow it.
 */
router.post<CanvasParams>('/viewing', (req, res) => {
  const body = parseBody(CanvasViewingRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(req, res);
    getRoomService().requireMembership(req.params.id, caller.id);
    if (caller.kind !== 'human') {
      throw new RoomError(
        'PEOPLE_ONLY',
        'Only a person can say what they are looking at. An agent’s face appears on a document ' +
          'because its turn read that document, not because it said so.'
      );
    }
    getRoomService().canvas.setViewing(req.params.id, caller.id, body.documentId);
    res.status(204).end();
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/canvas/viewing');
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
    // Gated FIRST, and this is the route the gap was found on: a body of `{}`
    // asks for nothing, so every branch below was skipped and the handler
    // answered 200 with the document it had already fetched — to a caller who
    // may not be a member, out of a room that may be archived.
    const caller = requireCanvasAccess(req, res, true);
    const service = getRoomService();
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
    const caller = requireCanvasAccess(req, res, true);
    getRoomService().canvas.close(req.params.id, caller, req.params.documentId);
    res.status(204).end();
  } catch (err) {
    sendRoomError(res, err, 'DELETE /:id/canvas/:documentId');
  }
});

/**
 * POST /:documentId/thread — open this document's discussion, or re-open it.
 *
 * The first call posts one system entry naming the document and writes its id
 * onto the row in the same transaction; every call after that hands back the
 * thread that is already there and posts nothing. So pressing "Discuss" twice —
 * or two members pressing it at once — lands everybody in one conversation.
 *
 * It wakes nobody. The entry addresses no one and is never dispatched, exactly
 * as the line a canvas change already writes (ADR `260911-200302`).
 */
router.post<CanvasParams>('/:documentId/thread', (req, res) => {
  try {
    const caller = requireCanvasAccess(req, res, true);
    const thread = getRoomService().canvas.discuss(req.params.id, caller, req.params.documentId);
    res.status(thread.created ? 201 : 200).json(thread);
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/canvas/:documentId/thread');
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
    const caller = requireCanvasAccess(req, res, true);
    res.json(
      getRoomService().canvas.heartbeat(req.params.id, caller, req.params.documentId, body.editing)
    );
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/canvas/:documentId/editing');
  }
});

export default router;
