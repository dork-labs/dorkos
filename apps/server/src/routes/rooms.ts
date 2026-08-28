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
 *   agent presenting a VALID `X-DorkOS-Agent` posts as itself; a caller
 *   presenting one this machine cannot verify is refused 401 outright; anyone
 *   else posts as this install's owner. `resolveCaller` owns that decision and
 *   all of it — every handler here just takes the id it hands back, and a route
 *   added below inherits the refusal without asking for it.
 *
 * @module routes/rooms
 */
import path from 'path';
import { pipeline, Readable } from 'node:stream';
import { Router } from 'express';
import multer from 'multer';
import { ulid } from 'ulidx';
import {
  ROOM_EXPORT_CONTENT_TYPE,
  roomExportFilename,
  type RoomExportHeader,
} from '@dorkos/shared/room-export-schemas';
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
  MergeRoomRepoRequestSchema,
  ToggleReactionRequestSchema,
  UpdateMembershipRequestSchema,
  UpdateRoomRequestSchema,
  type PostToRoomResponse,
  type RoomAttachment,
} from '@dorkos/shared/room-schemas';
import { RoomFileContentQuerySchema, RoomFilesQuerySchema } from '@dorkos/shared/room-files';
import {
  getAttachmentRowStore,
  getRoomAttachmentStore,
  getRoomFilesService,
  getRoomMergeService,
  getRoomRepoService,
  getRoomService,
  RoomError,
  toAuthorRef,
  type PostedEntry,
} from '../services/rooms/index.js';
import { readRoomRepoConfig, ROOM_REPO_EXISTS_CODE } from '../services/rooms/repo/index.js';
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
    const caller = resolveCaller(req, res);
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
    const caller = resolveCaller(req, res);
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
    const caller = resolveCaller(req, res);
    res.json({ threads: getRoomService().listThreads(caller.id, query.limit) });
  } catch (err) {
    sendRoomError(res, err, 'GET /threads');
  }
});

/** GET /:id — one room with its roster. 404s unless the caller is a member. */
router.get('/:id', (req, res) => {
  try {
    const room = getRoomService().getRoom(req.params.id, resolveCaller(req, res).id);
    if (!room) return res.status(404).json({ error: 'No such room', code: 'ROOM_NOT_FOUND' });
    res.json(room);
  } catch (err) {
    sendRoomError(res, err, 'GET /:id');
  }
});

/**
 * PATCH /:id — title, topic, archive, this room's four automatic-reply limits,
 * and — on a bridged room — the `deliverNotices` override (chats-as-channels
 * spec §6.2). `NOT_A_BRIDGED_ROOM` (409) when `deliverNotices` is sent for a
 * room with no bridge.
 *
 * **The four limit fields are operator-only** (DOR-1429): anyone but the person
 * who owns this install is refused 403 `OPERATOR_ONLY`, an unverifiable agent
 * token is refused 401 by `resolveCaller` before this handler runs, and no room
 * capability tool offers them at all. Not merely person-only — these fields are
 * spend authority, and a second human author (an invited member, a cached
 * remote one) must not be able to uncap a room on the owner's account. The gate
 * lives in `RoomService.updateRoom` rather than here, one line after the
 * visibility check, so a caller probing a room it cannot see gets the same 404
 * reading it would. Sending one of these fields as `null` clears the room's
 * override; omitting it leaves whatever is stored alone.
 */
router.patch('/:id', (req, res) => {
  const body = parseBody(UpdateRoomRequestSchema, req.body, res);
  if (!body) return;
  try {
    res.json(getRoomService().updateRoom(req.params.id, resolveCaller(req, res).id, body));
  } catch (err) {
    sendRoomError(res, err, 'PATCH /:id');
  }
});

/**
 * GET /:id/sessions — which session each of this room's agents answers in.
 *
 * The mapping `specs/room-presence` §15 deliberately kept off the presence
 * signal, "waiting for a design that checks the caller's right to it". This is
 * that design, and it is two sentences long:
 *
 * - **A room you cannot see answers 404**, exactly as `GET /:id` does, so this
 *   route discloses nothing about a room that reading it would not.
 * - **Only a person may ask.** A caller that presented `X-DorkOS-Agent` is
 *   refused 403 (`PEOPLE_ONLY`). An agent enumerating its room-mates' sessions
 *   is arbitration this domain has declined; a person asking "where is that work
 *   running" is the reason the route exists.
 *
 * **A header that did not resolve is refused too — by `resolveCaller`, before
 * this handler runs.** DOR-1357 closed that hole here alone, by asking the wider
 * `presentsAgentIdentity` question in this route instead of `caller.kind`.
 * DOR-1361 moved the same question into `resolveCaller`, where every room route
 * gets it, so an unverifiable token answers 401 `AGENT_IDENTITY_UNVERIFIED`
 * before any room is looked up and this gate is back to the simple question it
 * was always asking: is the caller a person. The two spellings would be
 * indistinguishable from here now, and the simple one is the one that can still
 * fail on its own — deleting it turns the resolved-agent case red, which is what
 * a gate is for.
 *
 * **Visibility is checked first, and the order is deliberate.** `POST
 * /:id/attachments` asks the other way round, for a reason that does not apply
 * here — it refuses an agent before multer reads a byte. With the person gate
 * first, an agent probing a room it is not in learns 403 (this room exists) or
 * 404 (it does not) from the SAME request a person gets 404 for, which is a
 * difference in answers where there should be none. Visibility first collapses
 * both to 404 and leaves 403 for the one case that is honestly about the
 * caller: a member that is not a person.
 *
 * The body is ids and nothing else — no session content, no cwd, no status. It
 * is the minimum that makes a link, and the narrowness is the security claim.
 *
 * Declared beside `GET /:id` and BELOW it, which is safe: Express 5 matches
 * `/:id` against a single segment, so `/:id/sessions` cannot be swallowed by it
 * and no existing route needed reordering.
 */
router.get('/:id/sessions', (req, res) => {
  try {
    const caller = resolveCaller(req, res);
    // Throws `ROOM_NOT_FOUND` for a room this caller may not see, whoever they
    // are — see the note above on why that comes first.
    const bindings = getRoomService().listRoomSessions(req.params.id, caller.id);
    if (caller.kind !== 'human') {
      // A 403 rather than a 404: the visibility check above already passed for
      // whoever this resolved to, so there is nothing left to hide, and telling
      // an agent "this is not yours to read" is more useful than pretending the
      // route does not exist.
      throw new RoomError('PEOPLE_ONLY', "Only a person can see where a room's work runs.");
    }
    res.json({ bindings });
  } catch (err) {
    sendRoomError(res, err, 'GET /:id/sessions');
  }
});

/** GET /:id/entries — a page of history, oldest-first. */
router.get('/:id/entries', (req, res) => {
  const query = parseBody(ListRoomEntriesQuerySchema, req.query, res);
  if (!query) return;
  try {
    res.json({
      entries: getRoomService().listEntries(req.params.id, resolveCaller(req, res).id, query),
    });
  } catch (err) {
    sendRoomError(res, err, 'GET /:id/entries');
  }
});

/**
 * GET /:id/export — this room's whole history as a JSONL file (DOR-1225).
 *
 * **A GET, not a POST that writes a path**, and the alternative is worth naming
 * because it is the one somebody will suggest. A room export exists to be
 * portable, and the thing that already lives on the operator's own machine — the
 * `dorkos` CLI — is what should decide where a file lands. A POST taking a
 * destination would give any HTTP caller a filesystem write through the cockpit,
 * which is a capability no room route has and none should grow for a read. So
 * this route stays what it is: a read, gated exactly as every other room read,
 * answering bytes. `dorkos room export` writes them down.
 *
 * **Streamed, one line at a time.** A room's log is never trimmed, so the body
 * is piped from the service's generator rather than assembled first — and the
 * header line is pulled BEFORE any HTTP header is set, because a generator's
 * body does not run until its first `next()` and that is where a refusal
 * surfaces. Pulling it here is what keeps a non-member's answer a clean 404
 * instead of a truncated download.
 *
 * `Content-Disposition: attachment` plus `nosniff` for the same reason the
 * attachment route carries them: this is a file of other people's words, and
 * nothing about it should ever render as a document on the cockpit's own origin.
 */
router.get('/:id/export', (req, res) => {
  try {
    const caller = resolveCaller(req, res);
    const lines = getRoomService().exportRoom(req.params.id, caller.id);
    const first = lines.next();
    // Checked rather than cast. The generator's contract is that its first line
    // is the header, and this route depends on it for the filename — so a future
    // change that stops honouring it has to fail here, loudly and before a byte
    // is sent, rather than serve a file named after `undefined`.
    if (first.done || first.value.type !== 'room-export') {
      throw new Error('room export did not begin with its header');
    }
    const header: RoomExportHeader = first.value;

    res.setHeader('Content-Type', `${ROOM_EXPORT_CONTENT_TYPE}; charset=utf-8`);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${roomExportFilename(header.room, header.exportedAt)}"`
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    const body = Readable.from(
      (function* serialize() {
        yield `${JSON.stringify(header)}\n`;
        for (const line of lines) yield `${JSON.stringify(line)}\n`;
      })()
    );
    // `pipeline` rather than `pipe`, because the reader here is a generator over
    // a live database cursor: a client that closes the tab mid-download must
    // tear the source down with it, and `pipe` would leave it producing pages
    // nobody is reading.
    pipeline(body, res, (streamErr) => {
      if (!streamErr) return;
      logger.error('[rooms] export stream failed', { err: streamErr });
      // Headers are already out, so there is no status left to send. The
      // truncated file is the message, and the missing trailing `summary` line
      // is how a reader tells it apart from a whole one.
    });
  } catch (err) {
    sendRoomError(res, err, 'GET /:id/export');
  }
});

/**
 * The 202 body for a write: the entry's identity, plus who the write reached.
 *
 * Shared by both posting routes, because a thread reply asks a room exactly what
 * a top-level message asks it. `triggered` and `skipped` are omitted — not
 * emptied — when dispatch threw, which is the one case where nothing knows who
 * the message reached; `PostToRoomResponse` reads an absent field as "this source
 * cannot say" precisely so that case is not reported as "nobody".
 *
 * @param entry - The committed entry, as `RoomService.post` handed it back.
 * @returns The response body, exactly `PostToRoomResponseSchema`.
 */
function accepted(entry: PostedEntry): PostToRoomResponse {
  return {
    accepted: true,
    entryId: entry.id,
    seq: entry.seq,
    ...(entry.dispatch
      ? { triggered: entry.dispatch.triggered, skipped: entry.dispatch.skipped }
      : {}),
  };
}

/**
 * POST /:id/entries — post. Trigger-only: 202 with the entry's identity, while
 * the entry itself rides the SSE stream to every reader including this one. The
 * body also says who it reached — see {@link accepted}.
 */
router.post('/:id/entries', (req, res) => {
  const body = parseBody(PostToRoomRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(req, res);
    const entry = getRoomService().post(req.params.id, {
      authorId: caller.id,
      text: body.text,
      sessionId: body.sessionId,
      attachmentIds: body.attachmentIds,
    });
    res.status(202).json(accepted(entry));
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
    caller = resolveCaller(req, res);
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
    const caller = resolveCaller(req, res);
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
    const caller = resolveCaller(req, res);
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
    res
      .status(201)
      .json(getRoomService().addMember(req.params.id, resolveCaller(req, res).id, body));
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
        resolveCaller(req, res).id,
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
 * Any caller presenting `X-DorkOS-Agent` is refused here — 403 when the token
 * resolves to a live agent, 401 from `resolveCaller` when it does not — there is
 * no MCP tool for it, and no capability exposes it. That is the instrument
 * chosen over a rate limit: an agent that could rename itself in a loop would
 * grow the tombstone table a row at a time forever, and removing the mechanism
 * beats tuning a throttle around it.
 *
 * **The 401 half is DOR-1361, and until it landed this paragraph was not true.**
 * `resolveCaller` used to read an unverifiable token as "no agent presented", so
 * an agent whose token had been revoked or had expired resolved to the install
 * owner and renamed as the person — in a loop, at whatever rate it liked, which
 * is precisely the mechanism this route claims not to have.
 *
 * Declared before `/:id/…` would be a problem? No — `/authors` cannot be
 * mistaken for a room id, because a room id is a ULID and this path has a second
 * segment Express matches literally.
 */
router.patch('/authors/:authorId/handle', (req, res) => {
  const body = parseBody(SetAuthorHandleRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = resolveCaller(req, res);
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
    getRoomService().removeMember(req.params.id, resolveCaller(req, res).id, req.params.authorId);
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
    const caller = resolveCaller(req, res);
    const entry = getRoomService().post(req.params.id, {
      authorId: caller.id,
      text: body.text,
      sessionId: body.sessionId,
      replyTo: body.rootEntryId,
      attachmentIds: body.attachmentIds,
    });
    res.status(202).json(accepted(entry));
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
      const caller = resolveCaller(req, res);
      const stopped = await getRoomService().haltRoom(req.params.id, caller.id);
      res.json({ stopped });
    } catch (err) {
      sendRoomError(res, err, 'POST /:id/halt');
    }
  })();
});

/**
 * POST /:id/halt/:authorId — stop one agent's turn in this room.
 *
 * A sibling of `POST /:id/halt` rather than a field on it, and the difference is
 * the failure mode. That route takes no body on purpose (Express 5 leaves
 * `req.body` undefined on an empty POST), and an optional `authorId` in one
 * would fail OPEN: a client that forgot to send it would stop the whole room. A
 * path segment cannot be forgotten. `PATCH` and `DELETE /:id/members/:authorId`
 * are the precedent for an author-scoped room sub-path.
 *
 * Same gate as the room-wide stop: only a person, and only in a room they can
 * see. Allowed on an archived room for the same reason.
 */
router.post('/:id/halt/:authorId', (req, res) => {
  void (async () => {
    try {
      const caller = resolveCaller(req, res);
      const stopped = await getRoomService().haltAgent(
        req.params.id,
        req.params.authorId,
        caller.id
      );
      res.json({ stopped });
    } catch (err) {
      sendRoomError(res, err, 'POST /:id/halt/:authorId');
    }
  })();
});

/**
 * POST /:id/holds/:authorId/promote — ask for this room to be answered first.
 *
 * The one control a person has over a message that is waiting on an agent busy
 * in another conversation. It REORDERS: the blocking turn is untouched, nothing
 * is interrupted, and the promoted message still waits for the agent to be free.
 * Gated exactly as `POST /:id/halt` is, because it is the same kind of act — a
 * person steering their own room — and for the same reason only a person may
 * call it.
 *
 * `{ promoted: false }` is a normal answer, not an error: it means there was
 * nothing waiting, which is what a button left over from a wait that already
 * ended looks like. Takes no body.
 */
router.post('/:id/holds/:authorId/promote', (req, res) => {
  try {
    const caller = resolveCaller(req, res);
    const promoted = getRoomService().promoteHold(req.params.id, req.params.authorId, caller.id);
    res.json({ promoted });
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/holds/:authorId/promote');
  }
});

/**
 * POST /:id/repo — give this room files of its own (spec `project-rooms` §3.2).
 *
 * Creates the room's home directory, an empty git repo whose branch is `main`,
 * and a first `ROOM.md` committed as the person who asked. Takes no body:
 * there is nothing to configure, only a thing to do — and Express 5 leaves
 * `req.body` undefined on an empty POST, so asking for one would refuse every
 * honest caller (the same reasoning `POST /:id/halt` writes down).
 *
 * **Operator-only, and never an agent capability.** An agent that could give
 * its own room a repo could hand itself a writable working directory that no
 * person chose — the confused-deputy shape the membership verbs already refuse
 * (spec §3.2, channel-workspace §3.6). A caller presenting an agent token that
 * verifies is refused 403 `OPERATOR_ONLY`; one presenting a token this machine
 * cannot verify is refused 401 by `resolveCaller` before this handler runs; and
 * no capability tool offers this at all.
 *
 * **A room the caller cannot see answers 404 first**, before the operator gate,
 * so an agent probing room ids cannot tell "exists, not yours" from "no such
 * room" (DOR-1429's order, argued on `PATCH /:id`).
 *
 * **Idempotent.** A room that already has files answers 409
 * `ROOM_REPO_EXISTS` carrying the binding it already had, so a client that lost
 * the answer to its first call can carry on with the second. That is the one
 * refusal here with a payload, which is why it is not a `RoomError`.
 *
 * With `config.rooms.repo.enabled` off, 409 `ROOM_REPOS_DISABLED` — the
 * install-level fact, checked before the room is looked up.
 */
router.post('/:id/repo', (req, res) => {
  void (async () => {
    try {
      const caller = resolveCaller(req, res);
      const result = await getRoomRepoService().enable(req.params.id, caller.id);
      if (!result.created) {
        return res.status(409).json({
          error: 'This room already has files of its own.',
          code: ROOM_REPO_EXISTS_CODE,
          repo: result.repo,
        });
      }
      res.status(201).json({ repo: result.repo });
    } catch (err) {
      sendRoomError(res, err, 'POST /:id/repo');
    }
  })();
});

/**
 * GET /:id/files — one directory of this room's own files (spec
 * `project-rooms` §3.9).
 *
 * **Gated exactly as reading the room's history is.** The membership check is
 * `RoomService.assertCanReadFiles`, which is `read_room_history`'s own gate, so
 * a caller who is not on the roster gets the `ROOM_NOT_FOUND` a room that does
 * not exist gets — a room id is never a capability. **A member AGENT may read**,
 * for the same reason it may read history: a room's files are what its members
 * are working on together. A caller presenting a token this machine cannot
 * verify is refused 401 by `resolveCaller` before this handler runs.
 *
 * **The order of the two refusals is the disclosure control.** Membership is
 * asked first and answers 404; only then is "does this room have files" asked,
 * which answers 409 `ROOM_HAS_NO_REPO`. Asking the second one first would let
 * somebody holding a room id learn which rooms are project rooms.
 *
 * Serves `main`'s COMMIT, never the checkout on disk, so a half-written edit or
 * a dirty tree is not something a reader can see; `commit` says which snapshot
 * this is. A symlink is listed as a link and never followed.
 */
router.get('/:id/files', (req, res) => {
  void (async () => {
    try {
      // **Who is asking comes before what they asked for**, and the order is
      // load-bearing rather than tidy: the TSDoc above promises that an
      // unverifiable agent token is refused 401 before anything else happens,
      // and with `parseBody` first a malformed query answered 400 to a caller
      // this machine had already decided it could not identify. Measured, and
      // the doc was the thing that was wrong.
      const caller = resolveCaller(req, res);
      const query = parseBody(RoomFilesQuerySchema, req.query, res);
      if (!query) return;
      getRoomService().assertCanReadFiles(req.params.id, caller.id);
      res.json(await getRoomFilesService().list(req.params.id, query.path));
    } catch (err) {
      sendRoomError(res, err, 'GET /:id/files');
    }
  })();
});

/**
 * GET /:id/repo/status — what this room's files hold right now (spec §3.6).
 *
 * **Membership-gated exactly like a history read**, and answering "not a member"
 * as "no such room" for the same reason: what it reports is who in this room has
 * unmerged work, which is a fact about the room's members. The owner sees every
 * room on the install and is still not a member of all of them — the membership
 * check is the gate, not the visibility (`RoomService.requireMembership`).
 *
 * It reports SLUGS and display names, never the workspace path an agent lives
 * at: an agent reads its own rooms' status, and `/Users/…` is not something to
 * hand every member.
 *
 * The same answer the `room_repo_status` tool gives, from the same service — the
 * client needs it for the explorer's pending-work badges, and a second
 * computation of "how far behind is Ana" is a second answer that can disagree.
 */
router.get('/:id/repo/status', (req, res) => {
  void (async () => {
    try {
      const caller = resolveCaller(req, res);
      res.json(await getRoomMergeService().status(req.params.id, caller.id));
    } catch (err) {
      sendRoomError(res, err, 'GET /:id/repo/status');
    }
  })();
});

/**
 * GET /:id/files/content — one file out of this room's `main`.
 *
 * **A query parameter rather than a path suffix**, which is the shape
 * `GET /api/files/content?cwd=&path=` already uses for a session's files. A
 * repo path holds slashes, and a path SEGMENT would mean encoding them on the
 * way out and decoding them on the way in — one more place for the two ends to
 * disagree about what a filename is. A query value carries them literally.
 * (Spec §3.10 sketches the P3 write as `PUT /:id/files/<path>`; it should take
 * this shape instead, so read and write name a file the same way.)
 *
 * Gated identically to `GET /:id/files`. Three honest answers rather than one:
 * the text, `binary` for a file with a `NUL` in it — whose bytes are never
 * decoded into a string — or `too-large` against
 * `config.rooms.repo.maxFileBytes`, checked against the size git already knows
 * so an enormous file costs nothing to refuse. A directory, a symlink and a
 * submodule are each refused 400 `ROOM_FILE_NOT_READABLE`.
 *
 * Declared after `GET /:id/files`, which is safe: Express 5 matches `/:id` and
 * the literal `files` a segment at a time, so the two paths cannot collide.
 */
router.get('/:id/files/content', (req, res) => {
  void (async () => {
    try {
      // Caller first, for the reason `GET /:id/files` above writes down.
      const caller = resolveCaller(req, res);
      const query = parseBody(RoomFileContentQuerySchema, req.query, res);
      if (!query) return;
      getRoomService().assertCanReadFiles(req.params.id, caller.id);
      res.json(await getRoomFilesService().read(req.params.id, query.path));
    } catch (err) {
      sendRoomError(res, err, 'GET /:id/files/content');
    }
  })();
});

/**
 * POST /:id/repo/merge — bring an agent's work into the room's `main`
 * (spec §3.6).
 *
 * The HTTP half of `merge_to_room_main`, over the same service and therefore the
 * same queue, the same refusals and the same one merge entry. It exists because
 * the tool cannot serve the person: spec §5 Q2 puts the OWNER on the list of who
 * may merge, and the owner has no branch of their own — so they name one
 * (`worktree`), which is refused `OPERATOR_ONLY` for anybody else.
 *
 * Every refusal is a 409 except `MERGE_IN_FLIGHT`, which is the canonical 429:
 * the caller waited its turn in the room's merge queue and the room is still
 * busy, so asking again is genuinely the remedy.
 */
router.post('/:id/repo/merge', (req, res) => {
  void (async () => {
    try {
      const caller = resolveCaller(req, res);
      const body = parseBody(MergeRoomRepoRequestSchema, req.body, res);
      if (!body) return;
      const result = await getRoomMergeService().merge(req.params.id, caller.id, {
        summary: body.summary,
        ...(body.worktree !== undefined ? { worktree: body.worktree } : {}),
      });
      res.status(200).json(result);
    } catch (err) {
      // A 429 that says "come back" without saying when is a client's own guess
      // about a backoff. The room's merge queue has a real number for it, so it
      // is sent: the wait the NEXT caller would get, rounded up to the second
      // the header is allowed to carry.
      if (err instanceof RoomError && err.code === 'MERGE_IN_FLIGHT') {
        res.set('Retry-After', String(Math.ceil(readRoomRepoConfig().mergeQueueWaitMs / 1000)));
      }
      sendRoomError(res, err, 'POST /:id/repo/merge');
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
