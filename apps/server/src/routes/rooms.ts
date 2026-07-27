/**
 * Room HTTP API (spec `rooms` §4) — thin handlers over the RoomService.
 *
 * Two conventions worth knowing before reading:
 *
 * - **Posting is trigger-only.** `POST /:id/entries` returns 202 and the
 *   entry's identity; the entry itself reaches every reader over
 *   `GET /:id/events`, exactly as `POST /api/sessions/:id/messages` does
 *   (ADR-0264). The poster is a reader too, so it gets its own entry back on
 *   the stream and has one delivery path rather than two.
 * - **The caller is resolved to an author, never trusted from the body.** An
 *   agent presenting `X-DorkOS-Agent` posts as itself; anyone else posts as the
 *   single local human author v1 mints.
 *
 * @module routes/rooms
 */
import { Router, type Response } from 'express';
import {
  AddRoomMemberRequestSchema,
  CreateRoomRequestSchema,
  CreateThreadRequestSchema,
  ListRoomEntriesQuerySchema,
  ListRoomsQuerySchema,
  PostToRoomRequestSchema,
  SetReadCursorRequestSchema,
  UpdateMembershipRequestSchema,
  UpdateRoomRequestSchema,
} from '@dorkos/shared/room-schemas';
import { getRoomService, RoomError, type RoomErrorCode } from '../services/rooms/index.js';
import { parseBody } from '../lib/route-utils.js';
import { resolveCaller } from './room-caller.js';
import { roomEventsHandler } from './room-events-handler.js';
import { logger } from '../lib/logger.js';

const router = Router();

/** HTTP status for each way the room service can refuse. */
const STATUS_BY_CODE: Record<RoomErrorCode, number> = {
  ROOM_NOT_FOUND: 404,
  ENTRY_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  SLUG_TAKEN: 409,
  INVALID_SLUG: 400,
  NESTED_THREAD: 400,
  ROOM_ARCHIVED: 409,
  OPERATOR_ONLY: 403,
};

/**
 * Map a thrown value onto a response. A {@link RoomError} carries its own code;
 * anything else is a bug and gets a generic 500 with the detail in the log, not
 * on the wire.
 *
 * @param res - The response to write to.
 * @param err - The caught value.
 * @param context - Route label for the log line.
 */
function sendRoomError(res: Response, err: unknown, context: string): void {
  if (err instanceof RoomError) {
    res.status(STATUS_BY_CODE[err.code]).json({ error: err.message, code: err.code });
    return;
  }
  logger.error(`[rooms] ${context} failed`, { err });
  res.status(500).json({ error: 'Internal server error' });
}

/** GET / — rooms visible to the caller, each with their unread count. */
router.get('/', (req, res) => {
  const query = parseBody(ListRoomsQuerySchema, req.query, res);
  if (!query) return;
  try {
    const caller = resolveCaller(res);
    res.json({ rooms: getRoomService().listRooms(caller.id, query) });
  } catch (err) {
    sendRoomError(res, err, 'GET /');
  }
});

/**
 * POST / — open a channel or a DM.
 *
 * **201 when a room was created, 200 when one already existed.** A DM is
 * idempotent on its member set, so this can answer with a conversation that has
 * been running for weeks — and nothing in the body would say so. `created` is
 * stripped here rather than serialized, so the response stays exactly
 * `RoomWithRosterSchema` and the distinction rides the status line, where an
 * upsert's does.
 */
router.post('/', (req, res) => {
  const body = parseBody(CreateRoomRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(res);
    const { created, ...room } = getRoomService().createRoom(body, caller.id);
    res.status(created ? 201 : 200).json(room);
  } catch (err) {
    sendRoomError(res, err, 'POST /');
  }
});

/** GET /:id — one room with its roster. 404s unless the caller is a member. */
router.get('/:id', (req, res) => {
  try {
    const room = getRoomService().getRoom(req.params.id, resolveCaller(res).id);
    if (!room) return res.status(404).json({ error: 'No such room', code: 'ROOM_NOT_FOUND' });
    res.json(room);
  } catch (err) {
    sendRoomError(res, err, 'GET /:id');
  }
});

/** PATCH /:id — title, topic, archive. */
router.patch('/:id', (req, res) => {
  const body = parseBody(UpdateRoomRequestSchema, req.body, res);
  if (!body) return;
  try {
    res.json(getRoomService().updateRoom(req.params.id, resolveCaller(res).id, body));
  } catch (err) {
    sendRoomError(res, err, 'PATCH /:id');
  }
});

/** GET /:id/entries — a page of history, oldest-first. */
router.get('/:id/entries', (req, res) => {
  const query = parseBody(ListRoomEntriesQuerySchema, req.query, res);
  if (!query) return;
  try {
    res.json({
      entries: getRoomService().listEntries(req.params.id, resolveCaller(res).id, query),
    });
  } catch (err) {
    sendRoomError(res, err, 'GET /:id/entries');
  }
});

/**
 * POST /:id/entries — post. Trigger-only: 202 with the entry's identity, while
 * the entry itself rides the SSE stream to every reader including this one.
 */
router.post('/:id/entries', (req, res) => {
  const body = parseBody(PostToRoomRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(res);
    const entry = getRoomService().post(req.params.id, {
      authorId: caller.id,
      text: body.text,
      sessionId: body.sessionId,
    });
    res.status(202).json({ accepted: true, entryId: entry.id, seq: entry.seq });
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/entries');
  }
});

/** POST /:id/members — add a member by author id or agent directory. */
router.post('/:id/members', (req, res) => {
  const body = parseBody(AddRoomMemberRequestSchema, req.body, res);
  if (!body) return;
  try {
    res.status(201).json(getRoomService().addMember(req.params.id, resolveCaller(res).id, body));
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/members');
  }
});

/** PATCH /:id/members/:authorId — change a member's response mode. */
router.patch('/:id/members/:authorId', (req, res) => {
  const body = parseBody(UpdateMembershipRequestSchema, req.body, res);
  if (!body) return;
  try {
    res.json(
      getRoomService().updateMembership(
        req.params.id,
        resolveCaller(res).id,
        req.params.authorId,
        body.responseMode
      )
    );
  } catch (err) {
    sendRoomError(res, err, 'PATCH /:id/members/:authorId');
  }
});

/** DELETE /:id/members/:authorId — remove a member. */
router.delete('/:id/members/:authorId', (req, res) => {
  try {
    getRoomService().removeMember(req.params.id, resolveCaller(res).id, req.params.authorId);
    res.status(204).end();
  } catch (err) {
    sendRoomError(res, err, 'DELETE /:id/members/:authorId');
  }
});

/** PUT /:id/read-cursor — advance the caller's `(member, room)` read cursor. */
router.put('/:id/read-cursor', (req, res) => {
  const body = parseBody(SetReadCursorRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(res);
    res.json(getRoomService().setReadCursor(req.params.id, caller.id, body.lastReadSeq));
  } catch (err) {
    sendRoomError(res, err, 'PUT /:id/read-cursor');
  }
});

/** POST /:id/threads — open a thread off an entry. */
router.post('/:id/threads', (req, res) => {
  const body = parseBody(CreateThreadRequestSchema, req.body, res);
  if (!body) return;
  try {
    res
      .status(201)
      .json(
        getRoomService().createThread(
          req.params.id,
          body.rootEntryId,
          resolveCaller(res).id,
          body.title
        )
      );
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/threads');
  }
});

/**
 * GET /:id/events — the durable room stream (snapshot → replay → live). The
 * handler lives in `room-events-handler.ts` so this file stays under the
 * file-size rule.
 */
router.get('/:id/events', roomEventsHandler);

export default router;
