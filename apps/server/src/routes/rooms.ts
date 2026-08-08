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
import { Router } from 'express';
import {
  AddRoomMemberRequestSchema,
  CreateRoomRequestSchema,
  ListRoomEntriesQuerySchema,
  ListRoomsQuerySchema,
  ListThreadsQuerySchema,
  PostThreadReplyRequestSchema,
  PostToRoomRequestSchema,
  SetAuthorHandleRequestSchema,
  SetReadCursorRequestSchema,
  ToggleReactionRequestSchema,
  UpdateMembershipRequestSchema,
  UpdateRoomRequestSchema,
} from '@dorkos/shared/room-schemas';
import { getRoomService, RoomError, toAuthorRef } from '../services/rooms/index.js';
import { parseBody } from '../lib/route-utils.js';
import { roomEventsHandler } from './room-events-handler.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';

const router = Router();

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

/**
 * PATCH /:id — title, topic, archive, and — on a bridged room — the
 * `deliverNotices` override (chats-as-channels spec §6.2). `NOT_A_BRIDGED_ROOM`
 * (409) when `deliverNotices` is sent for a room with no bridge.
 */
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

/**
 * PATCH /authors/:authorId/handle — set or clear an author's address.
 *
 * **Human-initiated only, and that is an invariant rather than a convention.**
 * An agent presenting `X-DorkOS-Agent` is refused here, there is no MCP tool for
 * it, and no capability exposes it. That is the instrument chosen over a rate
 * limit: an agent that could rename itself in a loop would grow the tombstone
 * table a row at a time forever, and removing the mechanism beats tuning a
 * throttle around it.
 *
 * Declared before `/:id/…` would be a problem? No — `/authors` cannot be
 * mistaken for a room id, because a room id is a ULID and this path has a second
 * segment Express matches literally.
 */
router.patch('/authors/:authorId/handle', (req, res) => {
  const body = parseBody(SetAuthorHandleRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(res);
    if (caller.kind !== 'human') {
      throw new RoomError('OPERATOR_ONLY', 'Only a person can change a handle.');
    }
    res.json(
      toAuthorRef(getRoomService().authorRegistry.setHandle(req.params.authorId, body.handle))
    );
  } catch (err) {
    sendRoomError(res, err, 'PATCH /authors/:authorId/handle');
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

/**
 * PUT /:id/read-cursor — advance the caller's read cursor in this room.
 *
 * **One write path, two cursors, and this route does not choose between them.**
 * `RoomService.setReadCursor` does: a person's place goes to `read_cursors` and
 * broadcasts `read_cursor`, an agent's stays on its membership row and says
 * nothing (team-room-home spec §D4).
 *
 * **`PUT /api/read-cursors/room/:id` delegates into that same method**, so the
 * two routes are one implementation reached by two URLs rather than two
 * implementations that happen to agree today. They emit the same event with the
 * same unread count, refuse with the same statuses, and leave the same single
 * row behind — which is what makes it safe for the cockpit to use either.
 *
 * **What is left that is only here is the AGENT.** The generic route is
 * people-only by contract — an agent is refused with `PEOPLE_ONLY` — so this is
 * the only HTTP way an agent's own cursor moves. The removal condition is
 * therefore not "the client migrates": it is an agent cursor reachable some
 * other way, or agents no longer needing one at all. Until then, deleting this
 * route silently takes a capability away from agents, while the cockpit may keep
 * using it or move to the generic route without changing anything a person
 * sees.
 */
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
 * GET /:id/events — the durable room stream (snapshot → replay → live).
 *
 * The same path is also served over a WebSocket (`room-events-socket.ts`),
 * which is what the cockpit connects to; this SSE route stays as the public
 * integration contract. Both share their sequencing — see
 * `services/rooms/room-stream-delivery.ts`.
 */
router.get('/:id/events', roomEventsHandler);

export default router;
