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
 * **The five writing routes refuse an archived room; the four reads do not.**
 * That asymmetry is the whole point of archiving: the record survives, the
 * activity stops.
 *
 * **Two of the eight are a PERSON's**: saying what you are looking at, and the
 * review of somebody else's working copy. Both refuse an agent 403
 * `PEOPLE_ONLY`, through the same predicate `PUT /:id/files/content` uses.
 *
 * @module routes/room-canvas
 */
import { constants as fsConstants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
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
import { findRoomCanvasMedia } from '../services/rooms/canvas/room-canvas-media.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { parseByteRange, servesInlineHere } from '../lib/file-route-guards.js';
import { logger } from '../lib/logger.js';
import { errorBody } from '../lib/route-utils.js';
import { parseOrRefuse, roomRoute, type RoomCaller } from './room-route.js';

/**
 * Mounted at `/:id/canvas` by the rooms router, so `:id` — the ROOM — is a
 * parameter of every route here.
 */
const router = new Hono<ApiEnv>();

/**
 * The room this request is about: the `:id` the rooms router mounts this group
 * under.
 *
 * @param c - The Hono context.
 */
function roomOf(c: Context<ApiEnv>): string {
  return c.req.param('id')!;
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
 * @param c - The Hono context, for its `:id`.
 * @param caller - The request's caller, resolved here.
 * @param opts.write - Whether this route changes the canvas.
 * @param opts.personOnly - What a non-person was trying to do, when only a
 *   person may; omitted where agents are welcome.
 * @returns The caller's author id.
 * @throws {RoomError} `ROOM_NOT_FOUND` for a stranger, `ROOM_ARCHIVED` for a
 *   write into a room that has been put away, `PEOPLE_ONLY` for an agent on a
 *   route that is a person's.
 */
function requireCanvasAccess(
  c: Context<ApiEnv>,
  caller: RoomCaller,
  opts: { write?: boolean; personOnly?: string } = {}
): string {
  const callerId = caller().id;
  const room = getRoomService().requireMembership(roomOf(c), callerId);
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
router.get('/', (c) =>
  roomRoute(c, 'GET /:id/canvas', (caller) => {
    requireCanvasAccess(c, caller);
    return c.json({ documents: getRoomService().canvas.list(roomOf(c)) });
  })
);

/**
 * GET /media/:file — a picture, PDF or other media file an agent put on this
 * canvas from its own folder, which the server copied into the room
 * (`room-canvas-media.ts`).
 *
 * **Membership is the gate**, the same one every canvas read uses: a member may
 * see what a member put on the table. The name is the SHA-256 of the bytes and
 * is checked against that shape before the disk is touched, so it is never a
 * path. Served the way `GET /api/files/raw` serves media: `nosniff`, a
 * script-neutering sandbox on SVG, inline only where this computer serves that
 * type inline, and a single byte range so sound and video can seek.
 */
router.get('/media/:file', (c) =>
  roomRoute(c, 'GET /:id/canvas/media/:file', async (caller) => {
    requireCanvasAccess(c, caller);
    const media = await findRoomCanvasMedia(
      path.join(resolveDorkHome(), 'rooms'),
      roomOf(c),
      c.req.param('file')
    );
    if (!media) {
      return c.json(errorBody('No such file on this room’s canvas', 'NOT_FOUND'), 404);
    }
    // Opened once, never through a symlink, and every later question asked of
    // that descriptor, so the file served is the file that was checked.
    let file: FileHandle;
    try {
      file = await fs.open(media.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      return c.json(errorBody('No such file on this room’s canvas', 'NOT_FOUND'), 404);
    }
    const { size } = await file.stat();
    const range = parseByteRange(c.req.header('range'), size);
    if (range.kind === 'unsatisfiable') {
      await file.close();
      c.header('Content-Range', `bytes */${size}`);
      return c.json(errorBody('Requested range not satisfiable', 'RANGE_NOT_SATISFIABLE'), 416);
    }
    const headers: Record<string, string> = {
      'Content-Type': media.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': servesInlineHere(media.contentType) ? 'inline' : 'attachment',
      // Named by its content, so a name never changes what it holds.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
    };
    if (media.contentType === 'image/svg+xml') {
      headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }
    const status = range.kind === 'range' ? 206 : 200;
    if (range.kind === 'range') {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
    } else {
      headers['Content-Length'] = String(size);
    }
    if (c.req.method === 'HEAD') {
      await file.close();
      return c.body(null, status, headers);
    }
    const stream = file.createReadStream(
      range.kind === 'range' ? { start: range.start, end: range.end } : {}
    );
    stream.on('error', (err) =>
      logger.error('[rooms] canvas media stream failed', { err, file: media.filePath })
    );
    return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, status, headers);
  })
);

/** GET /:documentId — one document, content included. */
router.get('/:documentId', (c) =>
  roomRoute(c, 'GET /:id/canvas/:documentId', (caller) => {
    requireCanvasAccess(c, caller);
    const document = getRoomService().canvas.get(roomOf(c), c.req.param('documentId'));
    if (!document) {
      return c.json(
        errorBody('No such document on this room’s canvas', 'CANVAS_DOCUMENT_NOT_FOUND'),
        404
      );
    }
    return c.json(document);
  })
);

/** POST / — put something on the canvas as yourself. */
router.post('/', (c) => {
  const body = parseOrRefuse(c, OpenCanvasDocumentRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/canvas', (caller) => {
    const callerId = requireCanvasAccess(c, caller, { write: true });
    const document = getRoomService().canvas.open(roomOf(c), callerId, body.content, {
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(body.channel ? { channel: body.channel } : {}),
    });
    return c.json(document, 201);
  });
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
router.post('/viewing', (c) => {
  const body = parseOrRefuse(c, CanvasViewingRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/canvas/viewing', (caller) => {
    const callerId = requireCanvasAccess(c, caller, { personOnly: VIEWING_IS_A_PERSONS });
    getRoomService().canvas.setViewing(roomOf(c), callerId, body.documentId);
    return c.body(null, 204);
  });
});

/**
 * PATCH /:documentId — change one document: its content, its pin, its place in
 * the order.
 *
 * Applied in that order, and each part is optional, so a caller that only wants
 * to pin something does not have to re-send its content.
 */
router.patch('/:documentId', (c) => {
  const body = parseOrRefuse(c, UpdateCanvasDocumentRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'PATCH /:id/canvas/:documentId', (caller) => {
    // Gated FIRST, and this is the route the gap was found on: a body of `{}`
    // asks for nothing, so every branch below was skipped and the handler
    // answered 200 with the document it had already fetched — to a caller who
    // may not be a member, out of a room that may be archived.
    const callerId = requireCanvasAccess(c, caller, { write: true });
    const service = getRoomService();
    const roomId = roomOf(c);
    const documentId = c.req.param('documentId');
    let document = service.canvas.get(roomId, documentId);
    if (body.content !== undefined) {
      document = service.canvas.update(roomId, callerId, documentId, body.content);
    }
    if (body.pinned !== undefined) {
      document = service.canvas.pin(roomId, callerId, documentId, body.pinned);
    }
    if (body.activate === true) {
      document = service.canvas.activate(roomId, callerId, documentId);
    }
    if (!document) {
      // Reached only when the body asked for nothing AND the document is gone.
      // The service raises this for every other path, so the two answers agree.
      throw new RoomError('CANVAS_DOCUMENT_NOT_FOUND', 'No such document on this room’s canvas');
    }
    return c.json(document);
  });
});

/** DELETE /:documentId — take a document off the table. */
router.delete('/:documentId', (c) =>
  roomRoute(c, 'DELETE /:id/canvas/:documentId', (caller) => {
    const callerId = requireCanvasAccess(c, caller, { write: true });
    getRoomService().canvas.close(roomOf(c), callerId, c.req.param('documentId'));
    return c.body(null, 204);
  })
);

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
router.post('/:documentId/thread', (c) =>
  roomRoute(c, 'POST /:id/canvas/:documentId/thread', (caller) => {
    const callerId = requireCanvasAccess(c, caller, { write: true });
    const thread = getRoomService().canvas.discuss(roomOf(c), callerId, c.req.param('documentId'));
    return c.json(thread, thread.created ? 201 : 200);
  })
);

/**
 * POST /:documentId/editing — say you are editing this document, or that you
 * have stopped.
 *
 * While the lock stands, an agent's update to the same document is HELD and the
 * agent is told so rather than reporting success — the half of ADR `0292` that
 * was deferred and never landed. It lapses on its own once the heartbeats stop,
 * evaluated lazily, so a browser that crashed mid-edit cannot wedge a document.
 */
router.post('/:documentId/editing', (c) => {
  const body = parseOrRefuse(c, CanvasEditingRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/canvas/:documentId/editing', (caller) => {
    const callerId = requireCanvasAccess(c, caller, { write: true });
    return c.json(
      getRoomService().canvas.heartbeat(
        roomOf(c),
        callerId,
        c.req.param('documentId'),
        body.editing
      )
    );
  });
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
router.get('/:documentId/diff', (c) =>
  roomRoute(c, 'GET /:id/canvas/:documentId/diff', async (caller) => {
    requireCanvasAccess(c, caller, { personOnly: REVIEWING_IS_A_PERSONS });
    return c.json(await readCanvasDiffReview(reviewDeps(), roomOf(c), c.req.param('documentId')));
  })
);

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
router.put('/:documentId/diff', (c) => {
  const body = parseOrRefuse(c, RoomCanvasDiffWriteRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'PUT /:id/canvas/:documentId/diff', async (caller) => {
    requireCanvasAccess(c, caller, { write: true, personOnly: REVIEWING_IS_A_PERSONS });
    return c.json(
      await writeCanvasDiffReview(reviewDeps(), roomOf(c), c.req.param('documentId'), body)
    );
  });
});

export default router;
