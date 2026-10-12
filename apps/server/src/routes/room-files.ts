import { performRoomRepoHttpOperation, withRoomFileHttpRequest } from './room-file-http-owner.js';
import multer from 'multer';
import { originalDocHonoRequest } from '../http/original-doc-request.js';
import {
  requireRoomFileEditorHttpCurrent,
  executeRoomFileSave,
  executeRoomFilePrepareUpload,
  executeRoomFileUpload,
  executeRoomFileMove,
  executeRoomFileRemove,
  executeRoomFileAttachment,
  createRoomFileEditorUploadStorage,
} from '../services/rooms/repo/room-file-editor.js';
import {
  completeRoomFileUploadStorage,
  issueRoomFileUploadSources,
} from '../services/rooms/repo/room-file-upload-storage.js';
/**
 * A room's own files (spec `project-rooms`, spec `agent-home-desk` §7.1): giving
 * a room files, reading its `main`, a person changing them (a save, an upload,
 * a move, a delete, keeping an attachment), dealing with changes DorkOS did not
 * make, and merging an agent's work.
 *
 * Mounted by `routes/rooms.ts`, so every path here starts at the room. Every
 * route asks who is calling first, through {@link roomRoute}.
 *
 * @module routes/room-files
 */
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono, type Context } from 'hono';
import {
  ROOM_FILE_CHANGED_CODE,
  ROOM_UPLOAD_FILES_FIELD,
  ROOM_UPLOAD_MAX_FILES,
  RoomFileContentQuerySchema,
  RoomFileDeleteRequestSchema,
  RoomFileFromAttachmentRequestSchema,
  RoomFileMoveRequestSchema,
  RoomFileSaveRequestSchema,
  RoomFilesQuerySchema,
  RoomFileUploadFieldsSchema,
  type RoomFileConflict,
} from '@dorkos/shared/room-files';
import { RoomMainRepairRequestSchema } from '@dorkos/shared/room-repo';
import { MergeRoomRepoRequestSchema } from '@dorkos/shared/room-schemas';
import {
  getAttachmentRowStore,
  getRoomAttachmentStore,
  getRoomFileEditor,
  getRoomFilesService,
  getRoomMergeService,
  getRoomService,
  RoomError,
} from '../services/rooms/index.js';
import { readRoomRepoConfig, ROOM_REPO_EXISTS_CODE } from '../services/rooms/repo/index.js';
import { InvalidRoomAttachmentIdError } from '../services/rooms/attachments/room-attachment-store.js';
import { describeBytes } from '../services/rooms/repo/room-file-ops.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { errorBody } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import { parseOrRefuse, resolveRoomCaller, roomErrorResponse, roomRoute } from './room-route.js';

const router = new Hono<ApiEnv>();

/**
 * POST /:id/repo — give this room files of its own (spec `project-rooms` §3.2).
 *
 * Creates the room's home directory, an empty git repo whose branch is `main`,
 * and a first `ROOM.md` committed as the person who asked. Takes no body:
 * there is nothing to configure, only a thing to do — and an empty POST reads
 * as no body at all, so asking for one would refuse every honest caller (the
 * same reasoning `POST /:id/halt` writes down).
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
router.post('/:id/repo', (c) =>
  roomRoute(c, 'POST /:id/repo', async (caller) => {
    caller();
    const result = await performRoomRepoHttpOperation(c, c.req.param('id'), 'enable');
    if (!result.created) {
      return c.json(
        {
          error: 'This room already has files of its own.',
          code: ROOM_REPO_EXISTS_CODE,
          repo: result.repo,
        },
        409
      );
    }
    return c.json({ repo: result.repo }, 201);
  })
);

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
router.get('/:id/files', (c) =>
  roomRoute(c, 'GET /:id/files', async (caller) => {
    // **Who is asking comes before what they asked for**, and the order is
    // load-bearing rather than tidy: the TSDoc above promises that an
    // unverifiable agent token is refused 401 before anything else happens,
    // and with the query parsed first a malformed query answered 400 to a
    // caller this machine had already decided it could not identify.
    // Measured, and the doc was the thing that was wrong.
    const viewer = caller();
    const query = parseOrRefuse(c, RoomFilesQuerySchema, readQuery(c));
    if (query instanceof Response) return query;
    getRoomService().assertCanReadFiles(c.req.param('id'), viewer.id);
    return c.json(await getRoomFilesService().list(c.req.param('id'), query.path));
  })
);

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
router.get('/:id/repo/status', (c) =>
  roomRoute(c, 'GET /:id/repo/status', async (caller) =>
    c.json(await getRoomMergeService().status(c.req.param('id'), caller().id))
  )
);

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
 * Declared after `GET /:id/files`, which is safe: `/:id` and the literal
 * `files` match a segment at a time, so the two paths cannot collide.
 */
router.get('/:id/files/content', (c) =>
  roomRoute(c, 'GET /:id/files/content', async (caller) => {
    // Caller first, for the reason `GET /:id/files` above writes down.
    const viewer = caller();
    const query = parseOrRefuse(c, RoomFileContentQuerySchema, readQuery(c));
    if (query instanceof Response) return query;
    getRoomService().assertCanReadFiles(c.req.param('id'), viewer.id);
    return c.json(await getRoomFilesService().read(c.req.param('id'), query.path));
  })
);

/**
 * PUT /:id/files/content — a person saving one file (spec §3.10).
 *
 * **The write twin of the read above, and it names its file the same way**: the
 * path rides in the body rather than in the URL, so one repo path means one
 * thing on both verbs and neither end has to encode slashes.
 *
 * **People only.** An agent in a project room has a working copy of its own and
 * `merge_to_room_main` to bring work back through; a second write path into the
 * integration tree would be one-writer undone and a way onto `main` that the
 * merge validation never sees. A member agent is refused 403 `PEOPLE_ONLY` —
 * not a 404, because it is a member of a room it can see and there is nothing
 * left to hide. Membership is still asked first, so a non-member learns nothing.
 *
 * **Optimistic locking, on the FILE.** `baseCommit` is the commit the editor
 * read the file at. The save is refused only if THAT PATH changed since — not
 * because `main` moved, which it does every time anybody merges anything. A
 * refusal is 409 `FILE_CHANGED` and carries `conflict`: the commit `main` is at
 * now and who last touched the file, which is what the reload / keep-mine
 * choice is drawn from. Nothing is written on that path.
 *
 * Every other refusal is the same one a merge would give, for the same reason:
 * `MAIN_CHECKOUT_DIRTY` while something outside DorkOS has written in the
 * room's own copy, `FILE_TOO_LARGE` and `REPO_CAP_EXCEEDED` against the room's
 * frozen caps. **Only `FILE_CHANGED` carries a payload** — every other refusal
 * here is the ordinary `{ error, code }`, so a client switches on the code and
 * never on whether a field is there.
 *
 * The 1 MB request body limit is smaller than the default file cap, so a very
 * large save never reaches the room's cap: the JSON body stage refuses it and
 * the error handler answers **413 `REQUEST_TOO_LARGE`**. That used to be a 500 with
 * no code, which told a person nothing about the one thing they could act on.
 */
router.put('/:id/files/content', (c) =>
  roomRoute(c, 'PUT /:id/files/content', async (caller) => {
    // Caller first, for the reason `GET /:id/files` above writes down.
    caller();
    const body = parseOrRefuse(c, RoomFileSaveRequestSchema, readJsonBody(c));
    if (body instanceof Response) return body;
    const outcome = await withRoomFileHttpRequest(c, (editor, handle) =>
      executeRoomFileSave(editor, handle, {
        path: body.path,
        baseCommit: body.baseCommit,
        text: body.text,
      })
    );
    if (outcome.status === 'conflict') {
      return c.json(
        {
          error:
            'Somebody changed this file while you were editing it, so nothing was saved. Open the new version, or save yours over it.',
          code: ROOM_FILE_CHANGED_CODE,
          conflict: outcome.conflict,
        },
        409
      );
    }
    return c.json(outcome.result);
  })
);

/**
 * Answer a file change that lost the race — the same 409 `FILE_CHANGED` body
 * the save answers, so one client handler covers every operation.
 *
 * @param c - The Hono context.
 * @param conflict - What moved.
 */
function fileConflict(c: Context, conflict: RoomFileConflict): Response {
  return c.json(
    {
      error:
        'Somebody changed these files after you opened them, so nothing was changed. Look at the new version, then try again.',
      code: ROOM_FILE_CHANGED_CODE,
      conflict,
    },
    409
  );
}

/**
 * POST /:id/files/upload — a person uploading files into one folder of the
 * room's files (spec `agent-home-desk` §7.1).
 *
 * Multipart: `files` (at most {@link ROOM_UPLOAD_MAX_FILES}), plus `dir`,
 * `baseCommit` and `replace` (a JSON list of the names this upload may
 * overwrite). **One commit for the whole upload**, authored as the person, and
 * one quiet room entry.
 *
 * **Refused before a byte is read** when the caller may not change this room's
 * files — the same gate, in the same order, as a save. Only then is the body
 * read, with **disk storage** into a staging folder of this request's own
 * under `<dorkHome>/.temp/room-uploads/` (memory storage would hold up to twenty
 * times the room's file cap in RAM), each file capped at the room's own frozen
 * `maxFileBytes`. The staging folder is removed when the request settles,
 * whatever happened. Uploads are bytes: binary files are fine, and nothing that
 * arrives this way can be a symlink.
 */
router.post('/:id/files/upload', async (c) => {
  const roomId = c.req.param('id');
  let reply: () => Response;
  let caller: ReturnType<typeof resolveRoomCaller> | undefined;
  try {
    caller = resolveRoomCaller(c);
    reply = await withRoomFileHttpRequest(c, async (editor, handle) => {
      const { req, res } = originalDocHonoRequest(c);
      const prepared = await executeRoomFilePrepareUpload(editor, handle);
      const storage = createRoomFileEditorUploadStorage(editor, handle, prepared.stagingDir);
      const files = await new Promise<Express.Multer.File[]>((resolve, reject) => {
        multer({
          storage,
          defParamCharset: 'utf8',
          limits: {
            fileSize: prepared.maxFileBytes,
            files: ROOM_UPLOAD_MAX_FILES,
            fields: 10,
          },
        }).array(ROOM_UPLOAD_FILES_FIELD, ROOM_UPLOAD_MAX_FILES)(req, res, (error: unknown) => {
          void completeRoomFileUploadStorage(storage, error).then(
            () => resolve((req.files as Express.Multer.File[] | undefined) ?? []),
            (cause: unknown) => reject(uploadError(cause, prepared.maxFileBytes))
          );
        });
      });
      const ownedSources = await issueRoomFileUploadSources(storage, req, files);
      const rawFields = req.body ?? readJsonBody(c) ?? {};
      const fields = RoomFileUploadFieldsSchema.safeParse(rawFields);
      if (!fields.success) {
        const refusal = parseOrRefuse(c, RoomFileUploadFieldsSchema, rawFields) as Response;
        return () => refusal;
      }
      const outcome = await executeRoomFileUpload(editor, handle, {
        dir: fields.data.dir,
        baseCommit: fields.data.baseCommit,
        replace: fields.data.replace,
        files: files.map((file, index) => ({
          name: file.originalname,
          content: ownedSources[index],
        })),
      });
      return outcome.status === 'conflict'
        ? () => fileConflict(c, outcome.conflict)
        : () => c.json(outcome.result);
    });
  } catch (err) {
    if (isAbortedUpload(err)) {
      logger.info('[rooms] an upload was abandoned before it finished', {
        roomId,
        reason: err instanceof Error ? err.message : String(err),
      });
      reply = () => {
        c.env.outgoing.destroy();
        return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
      };
    } else {
      const settled = caller;
      reply = () => roomErrorResponse(c, err, 'POST /:id/files/upload', settled);
    }
  }
  return reply();
});

/**
 * Whether an upload failed because the client went away — the body parser's
 * words for an aborted or closed request (`http/uploads.ts`).
 *
 * @param err - What the upload failed with.
 */
function isAbortedUpload(err: unknown): boolean {
  return (
    err instanceof Error && (err.message === 'Request aborted' || err.message === 'Request closed')
  );
}

/**
 * Turn an upload limit into the room's own refusal.
 *
 * @param err - What the body parser reported.
 * @param maxFileBytes - The room's per-file cap, for the sentence.
 */
function uploadError(err: unknown, maxFileBytes: number): unknown {
  if (!(err instanceof multer.MulterError)) return err;
  if (err.code === 'LIMIT_FILE_SIZE') {
    return new RoomError(
      'FILE_TOO_LARGE',
      `A file in that upload is larger than this room’s limit for one file, ${describeBytes(maxFileBytes)}.`
    );
  }
  if (
    err.code === 'LIMIT_FILE_COUNT' ||
    (err.code === 'LIMIT_UNEXPECTED_FILE' && err.field === ROOM_UPLOAD_FILES_FIELD)
  ) {
    return new RoomError(
      'ROOM_UPLOAD_TOO_MANY_FILES',
      `One upload can carry at most ${ROOM_UPLOAD_MAX_FILES} files.`
    );
  }
  return new RoomError(
    'ROOM_FILE_PATH_INVALID',
    `That upload could not be read: ${err.message}. Send the files as the '${ROOM_UPLOAD_FILES_FIELD}' field.`
  );
}

/**
 * POST /:id/files/move — rename or move one file or folder (spec
 * `agent-home-desk` §7.1).
 *
 * One commit, `Rename <from> to <to>`, authored as the person. Every path under
 * `from` must be unchanged since `baseCommit` (else 409 `FILE_CHANGED` with the
 * conflict), and `to` must not exist (409 `ROOM_FILE_EXISTS`). Missing folders
 * above `to` are created; a folder segment that differs only in capitals from
 * one the room has is refused, naming the real one.
 */
router.post('/:id/files/move', (c) =>
  roomRoute(c, 'POST /:id/files/move', async (caller) => {
    caller();
    const body = parseOrRefuse(c, RoomFileMoveRequestSchema, readJsonBody(c));
    if (body instanceof Response) return body;
    const outcome = await withRoomFileHttpRequest(c, (editor, handle) =>
      executeRoomFileMove(editor, handle, body)
    );
    if (outcome.status === 'conflict') return fileConflict(c, outcome.conflict);
    return c.json(outcome.result);
  })
);

/**
 * POST /:id/files/delete — delete one file or folder (spec `agent-home-desk`
 * §7.1).
 *
 * POST rather than DELETE, because the request carries a body (the lock) and a
 * DELETE body is one proxies are free to drop. One commit, `Delete <path>`; every
 * path under `path` must be unchanged since `baseCommit`. The room's history
 * keeps what was deleted.
 */
router.post('/:id/files/delete', (c) =>
  roomRoute(c, 'POST /:id/files/delete', async (caller) => {
    caller();
    const body = parseOrRefuse(c, RoomFileDeleteRequestSchema, readJsonBody(c));
    if (body instanceof Response) return body;
    const outcome = await withRoomFileHttpRequest(c, (editor, handle) =>
      executeRoomFileRemove(editor, handle, body)
    );
    if (outcome.status === 'conflict') return fileConflict(c, outcome.conflict);
    return c.json(outcome.result);
  })
);

/**
 * POST /:id/files/from-attachment — keep a file somebody attached to a message
 * in this room as one of the room's files (spec `agent-home-desk` §7.1).
 *
 * **The attachment must be on a message in THIS room.** Anything else — another
 * room's id, an unposted upload, an id that never existed — is the attachments
 * route's own answer, 404 `ATTACHMENT_NOT_FOUND`, so this route cannot be used to
 * learn about files elsewhere. The write gate is asked first, so a non-member
 * learns nothing either. One commit, `Add <path> from the chat`; a name the
 * folder already holds is 409 `ROOM_FILE_EXISTS`.
 */
router.post('/:id/files/from-attachment', (c) =>
  roomRoute(c, 'POST /:id/files/from-attachment', async (caller) => {
    const roomId = c.req.param('id');
    const notFound = () => c.json(errorBody('No such file.', 'ATTACHMENT_NOT_FOUND'), 404);
    try {
      const viewer = caller();
      const body = parseOrRefuse(c, RoomFileFromAttachmentRequestSchema, readJsonBody(c));
      if (body instanceof Response) return body;
      return await withRoomFileHttpRequest(c, async (editor, handle) => {
        // The write gate before the attachment is looked up: a caller who may not
        // change this room's files learns nothing about its attachments.
        requireRoomFileEditorHttpCurrent(editor, handle);

        const row = getAttachmentRowStore().get(roomId, body.attachmentId);
        if (
          !row ||
          row.entryId === null ||
          !getRoomService().canReadAttachment(roomId, viewer.id, row)
        ) {
          return notFound();
        }
        const stored = await getRoomAttachmentStore().get(
          roomId,
          row.id,
          row.extension,
          'application/octet-stream'
        );
        if (!stored) return notFound();
        const chunks: Buffer[] = [];
        for await (const chunk of stored.stream) chunks.push(Buffer.from(chunk as Buffer));

        const outcome = await executeRoomFileAttachment(editor, handle, {
          dir: body.dir,
          name: body.name ?? row.name,
          baseCommit: body.baseCommit,
          bytes: Buffer.concat(chunks),
        });
        if (outcome.status === 'conflict') return fileConflict(c, outcome.conflict);
        return c.json(outcome.result);
      });
    } catch (err) {
      if (err instanceof InvalidRoomAttachmentIdError) return notFound();
      throw err;
    }
  })
);

/**
 * POST /:id/repo/main/repair — deal with changes DorkOS did not make (§3.10).
 *
 * The way out of `MAIN_CHECKOUT_DIRTY`. While the room's own copy holds
 * anything uncommitted, every merge and every save in that room refuses; this
 * is how a person ends that — keep those changes as a commit authored by them,
 * or discard exactly the files they name.
 *
 * **Operator-only** (403 `OPERATOR_ONLY`): it is somebody's unsaved work, and
 * deciding its fate is not an agent's call. A room the caller cannot see
 * answers 404 first, before the operator gate, exactly as `POST /:id/repo`
 * does.
 *
 * A discard names its files and they must be files the room is reporting as
 * changed right now — anything else is 404 `ROOM_FILE_NOT_FOUND`, so a screen
 * drawn ten minutes ago cannot delete something that arrived since.
 */
router.post('/:id/repo/main/repair', (c) =>
  roomRoute(c, 'POST /:id/repo/main/repair', async (caller) => {
    caller();
    const body = parseOrRefuse(c, RoomMainRepairRequestSchema, readJsonBody(c));
    if (body instanceof Response) return body;
    return c.json(await performRoomRepoHttpOperation(c, c.req.param('id'), 'repair', body));
  })
);

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
router.post('/:id/repo/merge', (c) =>
  roomRoute(c, 'POST /:id/repo/merge', async (caller) => {
    try {
      caller();
      const body = parseOrRefuse(c, MergeRoomRepoRequestSchema, readJsonBody(c));
      if (body instanceof Response) return body;
      const result = await performRoomRepoHttpOperation(c, c.req.param('id'), 'merge', {
        summary: body.summary,
        ...(body.worktree !== undefined ? { worktree: body.worktree } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      // A 429 that says "come back" without saying when is a client's own guess
      // about a backoff. The room's merge queue has a real number for it, so it
      // is sent: the wait the NEXT caller would get, rounded up to the second
      // the header is allowed to carry.
      if (err instanceof RoomError && err.code === 'MERGE_IN_FLIGHT') {
        c.header('Retry-After', String(Math.ceil(readRoomRepoConfig().mergeQueueWaitMs / 1000)));
      }
      throw err;
    }
  })
);

export default router;
