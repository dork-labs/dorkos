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
 *   agent presenting `X-DorkOS-Agent` posts as itself; anyone else posts as
 *   this install's owner. `resolveCaller` owns that decision and its three
 *   branches; every handler here just takes the id it hands back.
 *
 * @module routes/rooms
 */
import { Router, type Response } from 'express';
import {
  AddRoomMemberRequestSchema,
  CreateRoomRequestSchema,
  ListRoomEntriesQuerySchema,
  ListRoomsQuerySchema,
  ListThreadsQuerySchema,
  PostThreadReplyRequestSchema,
  PostToRoomRequestSchema,
  SetReadCursorRequestSchema,
  ToggleReactionRequestSchema,
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
  PEOPLE_ONLY: 403,
  BROADCAST_NOT_BRIDGEABLE: 400,
  CHAT_ALREADY_BRIDGED: 409,
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

/**
 * GET /threads — every thread the caller takes part in, across every room,
 * newest activity first.
 *
 * **Declared before `GET /:id`, and it has to be.** Express matches in
 * declaration order, so a `/:id` above this one would answer `/threads` with a
 * 404 for a room called "threads". A literal segment goes above its parameter.
 *
 * The only cross-room read in this file. A thread is a relation between entries
 * inside one room (ADR 260728-022013), so every other thread route is scoped to
 * `/:id` — this one exists because a sidebar cannot ask a question of a room it
 * has not been told about yet.
 */
router.get('/threads', (req, res) => {
  const query = parseBody(ListThreadsQuerySchema, req.query, res);
  if (!query) return;
  try {
    const caller = resolveCaller(res);
    res.json({ threads: getRoomService().listThreads(caller.id, query.limit) });
  } catch (err) {
    sendRoomError(res, err, 'GET /threads');
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

/**
 * POST /:id/entries/:entryId/reactions — put one emoji on an entry, or take it
 * back.
 *
 * **POST rather than PUT, and the verb is the honest one.** The default body is
 * a toggle, and a toggle is not idempotent: sending it twice is not sending it
 * once, which is what PUT promises. `PUT /:id/read-cursor` next door IS
 * idempotent — it sets a cursor to a value — and the two must not be spelled
 * alike. What IS idempotent here whatever the body says is the KEY:
 * `(you, this entry, this emoji)` holds at most one reaction however many times
 * anyone asks.
 *
 * 202 for the same reason posting is 202: the entry's new reaction set reaches
 * every reader — this one included — over `GET /:id/events`, so there is one
 * delivery path rather than two. The body carries only what the caller cannot
 * derive from its own click.
 *
 * **Two notes for the client half (B3), because getting either wrong is a bug a
 * person would see.** First: **do not retry a bare toggle.** A timeout does not
 * tell you whether the write landed, and re-sending the flip undoes it — send
 * `{ on: true | false }` instead, which names the state and is safe to repeat.
 * Second: **the stream is authoritative, not this response.** Draw the pill
 * optimistically by all means, but reconcile against the `reaction` frame rather
 * than against `reacted` here: somebody else may have reacted between your click
 * and your answer, and the frame carries the entry's whole set while this body
 * only says what YOUR click did.
 */
router.post('/:id/entries/:entryId/reactions', (req, res) => {
  const body = parseBody(ToggleReactionRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(res);
    const { reacted, frequents } = getRoomService().toggleReaction(
      req.params.id,
      req.params.entryId,
      caller.id,
      body.emoji,
      body.on
    );
    res.status(202).json({
      accepted: true,
      entryId: req.params.entryId,
      emoji: body.emoji,
      reacted,
      frequents,
    });
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/entries/:entryId/reactions');
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

/**
 * POST /:id/threads — reply inside a thread off an entry in this room.
 *
 * Entry-level, not room-level: a thread is a relation between entries
 * (ADR 260728-022013), so there is nothing to create before replying and this
 * one route writes the first reply and every later one. Trigger-only and 202 for
 * the same reason `POST /:id/entries` is — the reply rides the room's own SSE
 * stream to every reader, this caller included.
 *
 * It stays a separate route rather than an optional field on `/:id/entries` so
 * that writing into a thread is a deliberate act with a required target, never
 * an omitted parameter.
 */
router.post('/:id/threads', (req, res) => {
  const body = parseBody(PostThreadReplyRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(res);
    const entry = getRoomService().post(req.params.id, {
      authorId: caller.id,
      text: body.text,
      sessionId: body.sessionId,
      replyTo: body.rootEntryId,
    });
    res.status(202).json({ accepted: true, entryId: entry.id, seq: entry.seq });
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/threads');
  }
});

/**
 * POST /:id/halt — stop every agent turn running in this room.
 *
 * **The whole point of this route is that it is a route.** Stopping a room is a
 * control action that reaches the runtimes; it is never inferred from a message,
 * in this phase or any later one (room-participation spec §10.4). A person who
 * types "stop" into the composer has sent a message, and the agents answer it
 * like any other — which is exactly why the button has to exist.
 *
 * Takes no body: there is nothing to say, only a thing to do. Express 5 leaves
 * `req.body` undefined on an empty POST, so asking for one would refuse every
 * honest caller.
 */
router.post('/:id/halt', (req, res) => {
  void (async () => {
    try {
      const caller = resolveCaller(res);
      const stopped = await getRoomService().haltRoom(req.params.id, caller.id);
      res.json({ stopped });
    } catch (err) {
      sendRoomError(res, err, 'POST /:id/halt');
    }
  })();
});

/**
 * GET /:id/events — the durable room stream (snapshot → replay → live). The
 * handler lives in `room-events-handler.ts` so this file stays under the
 * file-size rule.
 */
router.get('/:id/events', roomEventsHandler);

export default router;
