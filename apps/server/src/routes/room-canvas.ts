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
 * **The five writing routes refuse an archived room; the three reads do not.**
 * That asymmetry is the whole point of archiving: the record survives, the
 * activity stops.
 *
 * **Two of the eight are a PERSON's**: saying what you are looking at, and the
 * review of somebody else's working copy. Both refuse an agent 403
 * `PEOPLE_ONLY`, through the same predicate `PUT /:id/files/content` uses.
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
import { RoomCanvasDiffWriteRequestSchema } from '@dorkos/shared/room-files';
import {
  getRoomFilesService,
  getRoomService,
  RoomError,
  tryGetRoomRepoService,
} from '../services/rooms/index.js';
import { canvasSourcePath } from '../services/canvas/index.js';
import {
  readCanvasDiffReview,
  writeCanvasDiffReview,
  type CanvasDiffReviewDeps,
} from '../services/rooms/canvas/canvas-diff-review.js';
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
 * What an agent is told when it says which document it is looking at.
 *
 * A face on a tab means "this member's turn really read this document", and an
 * agent that could simply assert one would be putting itself on somebody's
 * screen — with no room stream of its own, nothing would ever take it off again.
 */
const VIEWING_IS_A_PERSONS =
  'can say what they are looking at. An agent’s face appears on a document because its turn read ' +
  'that document, not because it said so.';

/**
 * What an agent is told when it reaches for the review of a worktree diff.
 *
 * **The review reads and writes somebody ELSE's working copy**, which is the one
 * thing this domain has never let an agent do: `read_canvas` hands an agent the
 * contents of a tree only when it is that agent's own (spec `room-canvas` §8.1),
 * and a reject here would leave a colleague's checkout dirty — the exact state
 * that then refuses that colleague's own merge. So it is the person's, on the
 * same instrument `PUT /:id/files/content` already uses.
 */
const REVIEWING_IS_A_PERSONS =
  'can review somebody else’s working copy. Merge your own work instead, or ask them to change it.';

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
 * `write` adds the archived-room refusal. Reads answer for an archived room
 * on purpose — the record survives, the activity stops — and putting that check
 * on a read would take the record away with it.
 *
 * `personOnly` adds the people-only refusal, and carries the words it is
 * refused with so each route says why in its own sentence. It runs through
 * `RoomService.requirePersonAuthor` — the one predicate `PUT /:id/files/content`
 * already refuses agents with — rather than a second `caller.kind` test, because
 * a second copy of a rule like this is a place for the two to disagree.
 *
 * @param req - The request, for its caller and its `:id`.
 * @param res - The response, for `resolveCaller`.
 * @param opts.write - Whether this route changes the canvas.
 * @param opts.personOnly - What a non-person was trying to do, when only a
 *   person may; omitted where agents are welcome.
 * @returns The caller's author id.
 * @throws {RoomError} `ROOM_NOT_FOUND` for a stranger, `ROOM_ARCHIVED` for a
 *   write into a room that has been put away, `PEOPLE_ONLY` for an agent on a
 *   route that is a person's.
 */
function requireCanvasAccess(
  req: Request<CanvasParams>,
  res: Response,
  opts: { write?: boolean; personOnly?: string } = {}
): string {
  const callerId = resolveCaller(req, res).id;
  const room = getRoomService().requireMembership(req.params.id, callerId);
  if (opts.write === true && room.archived) {
    throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
  }
  // AFTER the membership check, for the reason `GET /:id/sessions` gives:
  // visibility first means an agent probing room ids cannot tell 403 from 404.
  if (opts.personOnly !== undefined) {
    getRoomService().requirePersonAuthor(callerId, opts.personOnly);
  }
  return callerId;
}

/** GET / — everything on this room's canvas, pinned first then most recent. */
router.get<CanvasParams>('/', (req, res) => {
  try {
    requireCanvasAccess(req, res);
    res.json({ documents: getRoomService().canvas.list(req.params.id) });
  } catch (err) {
    sendRoomError(res, err, 'GET /:id/canvas');
  }
});

/** GET /:documentId — one document, content included. */
router.get<CanvasParams>('/:documentId', (req, res) => {
  try {
    requireCanvasAccess(req, res);
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
    const caller = requireCanvasAccess(req, res, { write: true });
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
    const caller = requireCanvasAccess(req, res, { personOnly: VIEWING_IS_A_PERSONS });
    getRoomService().canvas.setViewing(req.params.id, caller, body.documentId);
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
    const caller = requireCanvasAccess(req, res, { write: true });
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
    const caller = requireCanvasAccess(req, res, { write: true });
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
    const caller = requireCanvasAccess(req, res, { write: true });
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
    const caller = requireCanvasAccess(req, res, { write: true });
    res.json(
      getRoomService().canvas.heartbeat(req.params.id, caller, req.params.documentId, body.editing)
    );
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/canvas/:documentId/editing');
  }
});

/**
 * The seams the review reads and writes through, resolved per call.
 *
 * Late rather than captured, for the reason every other late resolution in this
 * domain gives: the repo and files services are registered further into boot
 * than this router is, and an install with no repo machinery answers `null`
 * forever — which is exactly right, because then no room has working copies and
 * there is nothing to review.
 */
function reviewDeps(): CanvasDiffReviewDeps {
  return {
    // **What the table holds, not what the review wants.** The "this is not a
    // review" refusal belongs with the rule, in the module that owns it —
    // filtering here instead made that refusal unreachable and answered a
    // markdown document as a missing one.
    document: (roomId, documentId) => {
      const document = getRoomService().canvas.get(roomId, documentId);
      if (!document) return null;
      return {
        contentType: document.content.type,
        sourcePath: canvasSourcePath(document.content) ?? '',
      };
    },
    resolvedTree: (roomId, documentId) =>
      getRoomService().canvas.resolvedTreeOf(roomId, documentId),
    worktreesPath: (roomId) => tryGetRoomRepoService()?.worktreesPathFor(roomId) ?? null,
    mainCopy: async (roomId, sourcePath) => {
      try {
        const file = await getRoomFilesService().read(roomId, sourcePath);
        return file.body.kind === 'text' ? file.body.text : null;
      } catch {
        // `main` does not have this file, which is the ordinary case for work
        // that ADDS one. The caller draws it against an empty base.
        return null;
      }
    },
  };
}

/**
 * GET /:documentId/diff — the two copies of the file behind a worktree diff
 * (spec `canvas-agent-seat` §8).
 *
 * The room's own copy and the member's, so the review can be drawn. **Not the
 * ordinary file API**, and the module doc of `canvas-diff-review.ts` says why:
 * a working copy lives under the DorkOS data directory, which the raw file
 * surfaces are deliberately confined out of. Nothing here takes a directory or
 * a path — both come off the document's own row.
 *
 * **A person's, both ways.** It hands back the contents of somebody ELSE's
 * working copy, which `read_canvas` refuses an agent by design (spec
 * `room-canvas` §8.1) — so an agent is refused 403 `PEOPLE_ONLY` here too,
 * after the membership check.
 *
 * **The gate is PERSONHOOD, not ownership**, exactly as it is on the file-write
 * route this borrows from: any member who is a person may read the review and
 * send a hunk back, and only the install's owner may MERGE (`POST
 * /:id/repo/merge`, 403 `OPERATOR_ONLY`). Spec §8 frames the flow as the
 * operator's because on a single-person install they are the same caller; on one
 * with login on they are not, and this is the line.
 */
router.get<CanvasParams>('/:documentId/diff', (req, res) => {
  void (async () => {
    try {
      requireCanvasAccess(req, res, { personOnly: REVIEWING_IS_A_PERSONS });
      res.json(await readCanvasDiffReview(reviewDeps(), req.params.id, req.params.documentId));
    } catch (err) {
      sendRoomError(res, err, 'GET /:id/canvas/:documentId/diff');
    }
  })();
});

/**
 * PUT /:documentId/diff — put a reviewed file back in the member's working copy.
 *
 * How turning a hunk down lands: the whole file, conditional on the hash the
 * diff was computed against. A file the agent changed in between comes back
 * `ok: false` with what it holds now — a conflict is control flow, and the
 * screen recomputes rather than clobbering work that carried on.
 *
 * **A person's** (403 `PEOPLE_ONLY`), on the same instrument
 * `PUT /:id/files/content` uses: this writes into a colleague's checkout, and an
 * agent doing that leaves that colleague dirty — the state their own merge then
 * refuses. Any member who is a person may do it, not only the owner — the
 * ownership line is drawn at the MERGE and nowhere else. Archived rooms refuse
 * it too, like every other canvas write.
 */
router.put<CanvasParams>('/:documentId/diff', (req, res) => {
  const body = parseBody(RoomCanvasDiffWriteRequestSchema, req.body, res);
  if (!body) return;
  void (async () => {
    try {
      requireCanvasAccess(req, res, { write: true, personOnly: REVIEWING_IS_A_PERSONS });
      res.json(
        await writeCanvasDiffReview(reviewDeps(), req.params.id, req.params.documentId, body)
      );
    } catch (err) {
      sendRoomError(res, err, 'PUT /:id/canvas/:documentId/diff');
    }
  })();
});

export default router;
