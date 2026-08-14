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
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { ulid } from 'ulidx';
import {
  AddRoomMemberRequestSchema,
  CreateRoomRequestSchema,
  ListRoomEntriesQuerySchema,
  ListRoomsQuerySchema,
  ListThreadsQuerySchema,
  PostThreadReplyRequestSchema,
  PostToRoomRequestSchema,
  SetAuthorHandleRequestSchema,
  ROOM_ATTACHMENT_NAME_MAX,
  ToggleReactionRequestSchema,
  UpdateMembershipRequestSchema,
  UpdateRoomRequestSchema,
  type RoomAttachment,
} from '@dorkos/shared/room-schemas';
import {
  getAttachmentRowStore,
  getRoomAttachmentStore,
  getRoomService,
  RoomError,
  toAuthorRef,
} from '../services/rooms/index.js';
import { listRoomsAcrossCommunities } from '../services/communities/index.js';
import { InvalidRoomAttachmentIdError } from '../services/rooms/attachments/room-attachment-store.js';
import { sniffImageContentType } from '../services/identity/image-sniff.js';
import { storedExtension } from '../services/rooms/attachments/attachment-paths.js';
import { sweepUnboundAttachments } from '../services/rooms/attachments/unbound-sweep.js';
import { configManager } from '../services/core/config-manager.js';
import { parseBody, sendError } from '../lib/route-utils.js';
import { roomEventsHandler } from './room-events-handler.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * GET / — rooms visible to the caller, each with their unread count, plus every
 * community that could not contribute to the list.
 *
 * `rooms` is this machine's own rooms and is unchanged by the community
 * registry: the port is single-identity and this list is per-caller, so an
 * agent's view has to come from the room service that knows who is asking.
 * `warnings` is the other communities' half — empty on every install today.
 * {@link listRoomsAcrossCommunities} argues the split in full.
 */
router.get('/', async (req, res) => {
  const query = parseBody(ListRoomsQuerySchema, req.query, res);
  if (!query) return;
  try {
    const caller = resolveCaller(res);
    res.json(
      await listRoomsAcrossCommunities({
        service: getRoomService(),
        callerAuthorId: caller.id,
        query,
      })
    );
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
      attachmentIds: body.attachmentIds,
    });
    res.status(202).json({ accepted: true, entryId: entry.id, seq: entry.seq });
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/entries');
  }
});

/**
 * The multipart field name both attachment halves agree on.
 *
 * The same name `POST /api/uploads` uses, because a person dragging files into
 * a room and a person dragging them into a session are doing the same thing.
 */
const ATTACHMENT_FIELD = 'files';

/**
 * Turn an uploaded filename into one a room can store.
 *
 * `path.basename` first, then the same allowlist `upload-handler.ts` applies, so
 * a name can carry no directory and no character that means anything to a shell
 * or a filesystem. Truncated last, because truncating before sanitizing could
 * leave a partial escape at the end.
 *
 * @param original - The filename the client sent.
 */
function sanitizeAttachmentName(original: string): string {
  const base = path.basename(original).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, ROOM_ATTACHMENT_NAME_MAX) || 'file';
}

/**
 * POST /:id/attachments — upload files into a room, before the message that
 * carries them.
 *
 * **Two-step on purpose.** The bytes go up first and the message names them by
 * id, which is what lets the composer show a chip while a large file is still
 * moving, and what keeps every field on the stored record server-derived: a
 * one-step multipart post would have to trust a declared size and type on the
 * way back in.
 *
 * **Nothing here trusts the upload about what a file IS.** The bytes are sniffed
 * ({@link sniffImageContentType}) and only a magic-byte match sets `preview`,
 * which is the single field that decides whether the serve route will ever
 * answer `inline`. A room accepts every type by default, so this is what keeps
 * an uploaded `.html` from rendering as a document under the cockpit's own
 * origin.
 */
router.post('/:id/attachments', (req, res) => {
  let caller;
  try {
    caller = resolveCaller(res);
    // Resolved BEFORE multer runs: an agent's upload is refused without its
    // bytes ever being read. An agent shares files by writing them into its own
    // working directory, which it already has.
    if (caller.kind !== 'human') {
      throw new RoomError('PEOPLE_ONLY', 'Only a person can attach a file.');
    }
    // Also before multer: a non-member gets the same 404 every room read gives,
    // and an archived room refuses, both without reading a byte.
    getRoomService().assertCanAttach(req.params.id, caller.id);
  } catch (err) {
    return sendRoomError(res, err, 'POST /:id/attachments');
  }

  // Built per request from the same config chat uses, so one setting governs
  // every upload in the product.
  const uploadConfig = configManager.get('uploads');
  const upload = multer({
    // Memory, not disk: the bytes must be sniffed before anything decides the
    // extension, the mime type, or whether the file may ever be served inline.
    storage: multer.memoryStorage(),
    // `+ 1` because busboy refuses a file that REACHES `fileSize` rather than
    // one that exceeds it, so the configured limit itself would be rejected.
    limits: { fileSize: uploadConfig.maxFileSize + 1, files: uploadConfig.maxFiles },
    fileFilter: (_req, file, cb) =>
      uploadConfig.allowedTypes.includes('*/*') || uploadConfig.allowedTypes.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error(`File type not allowed: ${file.mimetype}`)),
  }).array(ATTACHMENT_FIELD, uploadConfig.maxFiles);

  upload(req, res, async (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const megabytes = uploadConfig.maxFileSize / 1024 / 1024;
          return sendError(res, 413, `File too large (max ${megabytes}MB)`, err.code);
        }
        return sendError(res, 400, err.message, err.code);
      }
      // The only non-multer refusal this callback sees is the fileFilter's.
      return sendError(res, 415, (err as Error).message, 'ATTACHMENT_TYPE_NOT_ALLOWED');
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      return sendError(
        res,
        400,
        `Attach the files as the '${ATTACHMENT_FIELD}' field.`,
        'ATTACHMENT_MISSING'
      );
    }

    const store = getRoomAttachmentStore();
    const rows = getAttachmentRowStore();
    // Everything this request has committed so far, so a failure part-way can
    // be undone. Without it, a throw on file three left files one and two on
    // disk with rows nobody would ever reference — the same orphan the TTL
    // sweep below exists to catch, minted by the happy path's own error handler.
    const committed: Array<{ id: string; extension: string }> = [];

    try {
      const stored: RoomAttachment[] = [];
      for (const file of files) {
        const name = sanitizeAttachmentName(file.originalname);
        const extension = storedExtension(name);
        // THE safety line. `preview` is set from the BYTES and never from
        // `file.mimetype`, which is whatever the uploader typed.
        const sniffed = sniffImageContentType(file.buffer);
        const id = ulid();
        const { url } = await store.put(req.params.id, id, extension, file.buffer);
        committed.push({ id, extension });
        const row = {
          roomId: req.params.id,
          id,
          authorId: caller.id,
          name,
          extension,
          mimeType: sniffed ?? file.mimetype,
          size: file.buffer.byteLength,
          preview: sniffed ? ('image' as const) : null,
          url,
        };
        rows.create(row, new Date().toISOString());
        stored.push({
          id,
          name,
          mimeType: row.mimeType,
          size: row.size,
          preview: row.preview,
          url,
        });
      }

      // Housekeeping on the path that creates the mess: whatever this room
      // staged a day ago and never sent. Awaited but never fatal — it swallows
      // its own errors — so an upload cannot fail because a sweep did.
      void (await sweepUnboundAttachments({ rows, store, roomId: req.params.id }));

      // In request order, so the composer's chips and the message's files agree.
      return res.json({ attachments: stored });
    } catch (storeErr) {
      // All-or-nothing: the caller got no ids, so nothing here may survive to be
      // referenced later. Best-effort by necessity — a cleanup failure must not
      // replace the error the caller actually needs to see — and anything that
      // does survive is unbound, so the TTL sweep collects it within the day.
      for (const orphan of committed) {
        try {
          rows.deleteUnbound(req.params.id, [orphan.id]);
          await store.delete(req.params.id, orphan.id, orphan.extension);
        } catch (cleanupErr) {
          logger.warn('[rooms] could not clean up a half-finished upload', {
            roomId: req.params.id,
            attachmentId: orphan.id,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
      if (storeErr instanceof InvalidRoomAttachmentIdError) {
        return sendError(res, 400, 'That file could not be stored.', 'ATTACHMENT_ID_INVALID');
      }
      return sendRoomError(res, storeErr, 'POST /:id/attachments');
    }
  });
});

/**
 * GET /:id/attachments/:attachmentId — stream one back.
 *
 * **`Content-Type` and `Content-Disposition` are decided by the row's `preview`
 * and by nothing else.** A verified image is served as what the bytes were
 * sniffed to be, inline; everything else is `application/octet-stream` as an
 * attachment, whatever it was uploaded as. Together with `nosniff` that is what
 * keeps a file a person uploaded from executing as a document on the cockpit's
 * own origin.
 *
 * Every refusal is a 404 — wrong room, no such id, somebody else's unposted
 * file. Existence is never leaked by a 403.
 */
router.get('/:id/attachments/:attachmentId', async (req, res) => {
  try {
    const caller = resolveCaller(res);
    const row = getAttachmentRowStore().get(req.params.id, req.params.attachmentId);
    if (!row || !getRoomService().canReadAttachment(req.params.id, caller.id, row)) {
      return sendError(res, 404, 'No such file.', 'ATTACHMENT_NOT_FOUND');
    }

    const inline = row.preview === 'image';
    const stored = await getRoomAttachmentStore().get(
      req.params.id,
      row.id,
      row.extension,
      // Only a VERIFIED image is served as the type it claims to be.
      inline ? row.mimeType : 'application/octet-stream'
    );
    if (!stored) return sendError(res, 404, 'No such file.', 'ATTACHMENT_NOT_FOUND');

    res.setHeader('Content-Type', stored.contentType);
    // A file served from a URL a person can influence is exactly where a
    // sniffing browser turns an upload into a document.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', inline ? 'inline' : `attachment; filename="${row.name}"`);
    res.setHeader('ETag', stored.etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader('Content-Length', String(stored.size));

    if (req.headers['if-none-match'] === stored.etag) {
      // Destroyed rather than piped, so the file handle does not leak.
      stored.stream.destroy();
      return res.status(304).end();
    }

    stored.stream.on('error', (streamErr) => {
      logger.error('[rooms] attachment stream failed', { err: streamErr });
      if (!res.headersSent) {
        sendError(res, 500, 'Could not read that file.', 'ATTACHMENT_READ_FAILED');
      } else res.destroy(streamErr);
    });
    stored.stream.pipe(res);
  } catch (err) {
    if (err instanceof InvalidRoomAttachmentIdError) {
      return sendError(res, 400, 'That is not a usable file id.', 'ATTACHMENT_ID_INVALID');
    }
    return sendRoomError(res, err, 'GET /:id/attachments/:attachmentId');
  }
});

/**
 * POST /:id/entries/:entryId/reactions — put one emoji on an entry, or take it
 * back.
 *
 * **POST rather than PUT, and the verb is the honest one.** The default body is
 * a toggle, and a toggle is not idempotent: sending it twice is not sending it
 * once, which is what PUT promises. `PUT /api/read-cursors/room/:id` IS
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

/*
 * There is deliberately no `PUT /:id/read-cursor` here. A read cursor is not a
 * room concept — the same table answers for rooms, agent sessions and the inbox
 * — so the one write path is `PUT /api/read-cursors/room/:id`, which delegates
 * into `RoomService.setReadCursor` for exactly the checks this route would have
 * made (team-room-home spec §D4, ADR 260808-140956). The room-shaped URL that
 * stood here through the migration is gone now that every client writes through
 * the generic one: a second URL onto one implementation is still a second thing
 * to keep true.
 *
 * It is not missed by AGENTS either, which is the objection worth answering.
 * What an agent has been shown is `room_members.last_read_seq`, and that is
 * advanced by the ambient participation loop as entries are actually delivered
 * to it — never by the agent asking. The route removed here was the one way an
 * agent could have claimed to have read entries it was never handed, so its
 * removal closes that door rather than taking a capability away.
 */

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
      attachmentIds: body.attachmentIds,
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
