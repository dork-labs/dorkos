/**
 * A room's attachments: files a person uploads into a room before the message
 * that carries them, and each one served back (spec `rooms`).
 *
 * Mounted by `routes/rooms.ts`, so every path here starts at the room. The
 * upload is read with `parseUploads` (`http/uploads.ts`), in memory, with the
 * limits and type allowlist the upload settings give it.
 *
 * @module routes/room-attachments
 */
import type { ServerResponse } from 'node:http';
import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { ROOM_ATTACHMENT_NAME_MAX, type RoomAttachment } from '@dorkos/shared/room-schemas';
import {
  getAttachmentRowStore,
  getRoomAttachmentStore,
  getRoomService,
  RoomError,
} from '../services/rooms/index.js';
import { InvalidRoomAttachmentIdError } from '../services/rooms/attachments/room-attachment-store.js';
import { sniffImageContentType } from '../services/identity/image-sniff.js';
import {
  sanitizeAttachmentName,
  storedExtension,
} from '../services/rooms/attachments/attachment-paths.js';
import { sweepUnboundAttachments } from '../services/rooms/attachments/unbound-sweep.js';
import { configManager } from '../services/core/config-manager.js';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { parseUploads, UploadLimitError, type UploadedFile } from '../http/uploads.js';
import { discardStream, errorBody } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { roomRoute } from './room-route.js';

const router = new Hono<ApiEnv>();

/**
 * The multipart field name both attachment halves agree on.
 *
 * The same name `POST /api/uploads` uses, because a person dragging files into
 * a room and a person dragging them into a session are doing the same thing.
 */
const ATTACHMENT_FIELD = 'files';

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
 * an uploaded `.html` from rendering as a document under the app's own
 * origin.
 */
router.post('/:id/attachments', (c) =>
  roomRoute(c, 'POST /:id/attachments', async (resolveCaller) => {
    const roomId = c.req.param('id');
    const caller = resolveCaller();
    // Resolved BEFORE the body is read: an agent's upload is refused without
    // its bytes ever being read. An agent shares files by writing them into
    // its own working directory, which it already has.
    if (caller.kind !== 'human') {
      throw new RoomError('PEOPLE_ONLY', 'Only a person can attach a file.');
    }
    // Also before the body: a non-member gets the same 404 every room read
    // gives, and an archived room refuses, both without reading a byte.
    getRoomService().assertCanAttach(roomId, caller.id);

    // Read per request from the same config chat uses, so one setting governs
    // every upload in the product.
    const uploadConfig = configManager.get('uploads');
    let files: UploadedFile[];
    try {
      files = await parseUploads(c, {
        field: ATTACHMENT_FIELD,
        maxCount: uploadConfig.maxFiles,
        // In memory: the bytes must be sniffed before anything decides the
        // extension, the mime type, or whether the file may ever be served
        // inline. A file of exactly `maxFileSize` bytes fits.
        limits: { fileSize: uploadConfig.maxFileSize, files: uploadConfig.maxFiles },
        filter: (file) =>
          uploadConfig.allowedTypes.includes('*/*') ||
          uploadConfig.allowedTypes.includes(file.mimetype)
            ? undefined
            : new Error(`File type not allowed: ${file.mimetype}`),
      });
    } catch (err) {
      if (err instanceof UploadLimitError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          const megabytes = uploadConfig.maxFileSize / 1024 / 1024;
          return c.json(errorBody(`File too large (max ${megabytes}MB)`, err.code), 413);
        }
        return c.json(errorBody(err.message, err.code), 400);
      }
      // Every other refusal: the type filter's, or a body the parser could not read.
      return c.json(errorBody((err as Error).message, 'ATTACHMENT_TYPE_NOT_ALLOWED'), 415);
    }

    if (files.length === 0) {
      return c.json(
        errorBody(`Attach the files as the '${ATTACHMENT_FIELD}' field.`, 'ATTACHMENT_MISSING'),
        400
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
        const bytes = file.buffer!;
        const name = sanitizeAttachmentName(file.originalname, ROOM_ATTACHMENT_NAME_MAX);
        const extension = storedExtension(name);
        // THE safety line. `preview` is set from the BYTES and never from
        // `file.mimetype`, which is whatever the uploader typed.
        const sniffed = sniffImageContentType(bytes);
        const id = ulid();
        const { url } = await store.put(roomId, id, extension, bytes);
        committed.push({ id, extension });
        const row = {
          roomId,
          id,
          authorId: caller.id,
          name,
          extension,
          mimeType: sniffed ?? file.mimetype,
          size: bytes.byteLength,
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
      void (await sweepUnboundAttachments({ rows, store, roomId }));

      // In request order, so the composer's chips and the message's files agree.
      return c.json({ attachments: stored });
    } catch (storeErr) {
      // All-or-nothing: the caller got no ids, so nothing here may survive to be
      // referenced later. Best-effort by necessity — a cleanup failure must not
      // replace the error the caller actually needs to see — and anything that
      // does survive is unbound, so the TTL sweep collects it within the day.
      for (const orphan of committed) {
        try {
          rows.deleteUnbound(roomId, [orphan.id]);
          await store.delete(roomId, orphan.id, orphan.extension);
        } catch (cleanupErr) {
          logger.warn('[rooms] could not clean up a half-finished upload', {
            roomId,
            attachmentId: orphan.id,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
      if (storeErr instanceof InvalidRoomAttachmentIdError) {
        return c.json(errorBody('That file could not be stored.', 'ATTACHMENT_ID_INVALID'), 400);
      }
      throw storeErr;
    }
  })
);

/**
 * GET /:id/attachments/:attachmentId — stream one back.
 *
 * **`Content-Type` and `Content-Disposition` are decided by the row's `preview`
 * and by nothing else.** A verified image is served as what the bytes were
 * sniffed to be, inline; everything else is `application/octet-stream` as an
 * attachment, whatever it was uploaded as. Together with `nosniff` that is what
 * keeps a file a person uploaded from executing as a document on the app's
 * own origin.
 *
 * Every refusal is a 404 — wrong room, no such id, somebody else's unposted
 * file. Existence is never leaked by a 403.
 */
router.get('/:id/attachments/:attachmentId', (c) =>
  roomRoute(c, 'GET /:id/attachments/:attachmentId', async (resolveCaller) => {
    const roomId = c.req.param('id');
    try {
      const caller = resolveCaller();
      const row = getAttachmentRowStore().get(roomId, c.req.param('attachmentId'));
      if (!row || !getRoomService().canReadAttachment(roomId, caller.id, row)) {
        return c.json(errorBody('No such file.', 'ATTACHMENT_NOT_FOUND'), 404);
      }

      const inline = row.preview === 'image';
      const stored = await getRoomAttachmentStore().get(
        roomId,
        row.id,
        row.extension,
        // Only a VERIFIED image is served as the type it claims to be.
        inline ? row.mimeType : 'application/octet-stream'
      );
      if (!stored) return c.json(errorBody('No such file.', 'ATTACHMENT_NOT_FOUND'), 404);
      const notModified = c.req.header('if-none-match') === stored.etag;

      return streamToNodeResponse(c, (res) => {
        res.setHeader('Content-Type', stored.contentType);
        // A file served from a URL a person can influence is exactly where a
        // sniffing browser turns an upload into a document.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Content-Disposition',
          inline ? 'inline' : `attachment; filename="${row.name}"`
        );
        res.setHeader('ETag', stored.etag);
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        res.setHeader('Content-Length', String(stored.size));

        if (notModified) {
          // Discarded rather than piped, so the file handle does not leak — and
          // discarded rather than merely destroyed, because destroying does not
          // defuse the `fs.open` already in flight (see `discardStream`).
          discardStream(stored.stream);
          res.statusCode = 304;
          res.end();
          return;
        }

        return new Promise<void>((resolve) => {
          res.once('close', () => resolve());
          stored.stream.on('error', (streamErr) => {
            logger.error('[rooms] attachment stream failed', { err: streamErr });
            if (!res.headersSent) answerReadFailure(res);
            else res.destroy(streamErr);
            resolve();
          });
          stored.stream.pipe(res);
        });
      });
    } catch (err) {
      if (err instanceof InvalidRoomAttachmentIdError) {
        return c.json(errorBody('That is not a usable file id.', 'ATTACHMENT_ID_INVALID'), 400);
      }
      throw err;
    }
  })
);

/**
 * Answer a file that could not be read, before any of it was sent: a 500 with
 * the room's JSON refusal, over the headers already set for the file.
 *
 * @param res - The raw response, nothing written yet.
 */
function answerReadFailure(res: ServerResponse): void {
  const body = JSON.stringify(errorBody('Could not read that file.', 'ATTACHMENT_READ_FAILED'));
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.removeHeader('Content-Disposition');
  res.removeHeader('ETag');
  res.end(body);
}

export default router;
