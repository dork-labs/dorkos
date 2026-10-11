import { retireDocHttpRoomRepoCaller } from '../services/canvas/doc-channel/http-composition.js';
import {
  captureRoomRepoHttpOperation,
  executeRoomRepoEnable,
  executeRoomRepoRepair,
  type EnableRoomRepoResult,
  type RoomMainRepair,
  type RoomMainRepairResult,
} from '../services/rooms/repo/room-repo-service.js';
import {
  captureRoomMergeHttpOperation,
  executeRoomHttpMerge,
  type RoomMergeResult,
} from '../services/rooms/repo/room-merge-service.js';
import { RoomFileRequestAuthError } from '../services/canvas/doc-channel/http-composition.js';
import {
  captureRoomFileEditorHttpOperation,
  retireRoomFileEditorHttpOperation,
  requireRoomFileEditorHttpCurrent,
  executeRoomFileSave,
  executeRoomFilePrepareUpload,
  executeRoomFileUpload,
  executeRoomFileMove,
  executeRoomFileRemove,
  executeRoomFileAttachment,
} from '../services/rooms/repo/room-file-editor.js';
import { DocChannelNotFoundError } from '../services/canvas/doc-channel/authorization.js';
import path from 'path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { createRoomFileEditorUploadStorage } from '../services/rooms/repo/room-file-editor.js';
import {
  completeRoomFileUploadStorage,
  issueRoomFileUploadSources,
} from '../services/rooms/repo/room-file-upload-storage.js';
import { MergeRoomRepoRequestSchema } from '@dorkos/shared/room-schemas';
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
import {
  getAttachmentRowStore,
  getRoomAttachmentStore,
  getRoomFileEditor,
  getRoomFilesService,
  getRoomMergeService,
  getRoomRepoService,
  getRoomService,
  RoomError,
} from '../services/rooms/index.js';
import { readRoomRepoConfig, ROOM_REPO_EXISTS_CODE } from '../services/rooms/repo/index.js';
import { InvalidRoomAttachmentIdError } from '../services/rooms/attachments/room-attachment-store.js';
import { parseBody, sendError } from '../lib/route-utils.js';
import { describeBytes } from '../services/rooms/repo/room-file-ops.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';
import { logger } from '../lib/logger.js';

/** Register the original installRoomRepositoryRoutes group on the owned router, in its original order. */
export function installRoomRepositoryRoutes(router: Router): void {
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
  function performRoomRepoHttpOperation(
    req: Request,
    res: Response,
    roomId: string,
    operation: 'enable'
  ): Promise<EnableRoomRepoResult>;
  function performRoomRepoHttpOperation(
    req: Request,
    res: Response,
    roomId: string,
    operation: 'repair',
    input: RoomMainRepair
  ): Promise<RoomMainRepairResult>;
  function performRoomRepoHttpOperation(
    req: Request,
    res: Response,
    roomId: string,
    operation: 'merge',
    input: { summary: string; worktree?: string }
  ): Promise<RoomMergeResult>;
  async function performRoomRepoHttpOperation(
    req: Request,
    res: Response,
    roomId: string,
    operation: 'enable' | 'repair' | 'merge',
    input?: RoomMainRepair | { summary: string; worktree?: string }
  ): Promise<EnableRoomRepoResult | RoomMainRepairResult | RoomMergeResult> {
    const repo = operation === 'merge' ? undefined : getRoomRepoService();
    const merge = operation === 'merge' ? getRoomMergeService() : undefined;
    const handle = merge
      ? await captureRoomMergeHttpOperation(merge, req, res, roomId)
      : await captureRoomRepoHttpOperation(
          repo!,
          req,
          res,
          roomId,
          operation as 'enable' | 'repair'
        );
    let retirement: Promise<void> | undefined;
    const retire = (): Promise<void> => (retirement ??= retireDocHttpRoomRepoCaller(handle));
    const retireOnEnd = (): void => {
      void retire().catch(() => {
        /* finally awaits this same retirement */
      });
    };
    req.once('aborted', retireOnEnd);
    res.once('finish', retireOnEnd);
    res.once('close', retireOnEnd);
    // IncomingMessage.close is deliberately not used: parsed body completion is not disconnection.
    let failed = false,
      cause: unknown;
    let result: EnableRoomRepoResult | RoomMainRepairResult | RoomMergeResult | undefined;
    try {
      if (req.aborted || res.destroyed || res.writableEnded) await retire();
      if (operation === 'enable') result = await executeRoomRepoEnable(repo!, handle);
      else if (operation === 'repair')
        result = await executeRoomRepoRepair(repo!, handle, input as RoomMainRepair);
      else
        result = await executeRoomHttpMerge(
          merge!,
          handle,
          input as { summary: string; worktree?: string }
        );
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      req.off('aborted', retireOnEnd);
      res.off('finish', retireOnEnd);
      res.off('close', retireOnEnd);
      try {
        await retire();
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
    if (failed) throw cause;
    return result!;
  }

  router.post('/:id/repo', (req, res) => {
    void (async () => {
      try {
        resolveCaller(req, res);
        const result = await performRoomRepoHttpOperation(req, res, req.params.id, 'enable');
        if (!result.created) {
          return res.status(409).json({
            error: 'This room already has files of its own.',
            code: ROOM_REPO_EXISTS_CODE,
            repo: result.repo,
          });
        }
        res.status(201).json({ repo: result.repo });
      } catch (err) {
        sendRoomFileError(res, err, 'POST /:id/repo');
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
   * large save never reaches the room's cap: `express.json` refuses it and the
   * error handler answers **413 `REQUEST_TOO_LARGE`**. That used to be a 500 with
   * no code, which told a person nothing about the one thing they could act on.
   */
  /** Fixed genuine request lifetime. Send only after all original cleanup/drain attempts. */
  async function withRoomFileHttpRequest<T>(
    req: import('express').Request,
    res: import('express').Response,
    work: (editor: ReturnType<typeof getRoomFileEditor>, handle: object) => Promise<T>
  ): Promise<T> {
    const editor = getRoomFileEditor();
    const roomId = req.params.id;
    if (typeof roomId !== 'string') throw new Error('Original Room route ID is unavailable.');
    const handle = await captureRoomFileEditorHttpOperation(editor, roomId, req, res);
    let failed = false,
      cause: unknown,
      value!: T;
    try {
      value = await work(editor, handle);
    } catch (error) {
      failed = true;
      cause = error;
    }
    try {
      await retireRoomFileEditorHttpOperation(editor, handle);
    } catch (error) {
      if (!failed) {
        failed = true;
        cause = error;
      }
    }
    if (failed) throw cause;
    return value;
  }
  function sendRoomFileError(res: import('express').Response, error: unknown, route: string): void {
    if (error instanceof RoomFileRequestAuthError) {
      sendError(res, 401, 'Unauthorized', 'AUTH_REQUIRED');
      return;
    }
    if (error instanceof DocChannelNotFoundError) {
      sendError(res, 404, 'No such room.', 'ROOM_NOT_FOUND');
      return;
    }
    sendRoomError(res, error, route);
  }

  router.put('/:id/files/content', (req, res) => {
    void (async () => {
      try {
        // Caller first, for the reason `GET /:id/files` above writes down.
        resolveCaller(req, res);
        const body = parseBody(RoomFileSaveRequestSchema, req.body, res);
        if (!body) return;
        const outcome = await withRoomFileHttpRequest(req, res, (editor, handle) =>
          executeRoomFileSave(editor, handle, {
            path: body.path,
            baseCommit: body.baseCommit,
            text: body.text,
          })
        );
        if (outcome.status === 'conflict') {
          return res.status(409).json({
            error:
              'Somebody changed this file while you were editing it, so nothing was saved. Open the new version, or save yours over it.',
            code: ROOM_FILE_CHANGED_CODE,
            conflict: outcome.conflict,
          });
        }
        res.json(outcome.result);
      } catch (err) {
        sendRoomFileError(res, err, 'PUT /:id/files/content');
      }
    })();
  });

  /**
   * Answer a file change that lost the race — the same 409 `FILE_CHANGED` body
   * the save answers, so one client handler covers every operation.
   *
   * @param res - The response.
   * @param conflict - What moved.
   */
  function sendFileConflict(res: import('express').Response, conflict: RoomFileConflict): void {
    res.status(409).json({
      error:
        'Somebody changed these files after you opened them, so nothing was changed. Look at the new version, then try again.',
      code: ROOM_FILE_CHANGED_CODE,
      conflict,
    });
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
   * files — the same gate, in the same order, as a save. Only then is multer
   * started, with **owned descriptor storage** into a staging folder of this request's own
   * under `<dorkHome>/.temp/room-uploads/` (memory storage would hold up to twenty
   * times the room's file cap in RAM), each file capped at the room's own frozen
   * `maxFileBytes`. Fixed retirement drains acquired FDs and removes the original
   * empty staging folder; an identity mismatch retains unsafe paths and refuses. Uploads are bytes: binary files are fine, and nothing that
   * arrives this way can be a symlink.
   */
  router.post('/:id/files/upload', (req, res) => {
    void (async () => {
      // The answer is decided first and SENT last, after the staging folder is
      // gone: a client that sees the response can rely on nothing of its upload
      // being left on disk.
      let reply: () => unknown;
      try {
        resolveCaller(req, res);
        reply = await withRoomFileHttpRequest(req, res, async (editor, handle) => {
          const prepared = await executeRoomFilePrepareUpload(editor, handle);
          const storage = createRoomFileEditorUploadStorage(editor, handle, prepared.stagingDir);

          const files = await new Promise<Express.Multer.File[]>((resolve, reject) => {
            multer({
              storage,
              // UTF-8 names: a person's file called `résumé.pdf` is not latin-1.
              defParamCharset: 'utf8',
              limits: {
                fileSize: prepared.maxFileBytes,
                files: ROOM_UPLOAD_MAX_FILES,
                fields: 10,
              },
            }).array(ROOM_UPLOAD_FILES_FIELD, ROOM_UPLOAD_MAX_FILES)(req, res, (err: unknown) => {
              // Join actual writes/FD closes, then restore a separately captured falsy/undefined cause.
              void completeRoomFileUploadStorage(storage, err).then(
                () => resolve((req.files as Express.Multer.File[] | undefined) ?? []),
                (cause: unknown) => reject(uploadError(cause, prepared.maxFileBytes))
              );
            });
          });
          const ownedSources = await issueRoomFileUploadSources(storage, req, files);
          const fields = RoomFileUploadFieldsSchema.safeParse(req.body ?? {});
          if (!fields.success) {
            reply = () => parseBody(RoomFileUploadFieldsSchema, req.body ?? {}, res);
          } else {
            const outcome = await executeRoomFileUpload(editor, handle, {
              dir: fields.data.dir,
              baseCommit: fields.data.baseCommit,
              replace: fields.data.replace,
              files: files.map((file, index) => ({
                name: file.originalname,
                content: ownedSources[index],
              })),
            });
            reply =
              outcome.status === 'conflict'
                ? () => sendFileConflict(res, outcome.conflict)
                : () => res.json(outcome.result);
          }
          return reply;
        });
      } catch (err) {
        // A person closing the tab mid-upload is not a server fault, and there is
        // nobody left to answer: a note, not an error, and no response.
        if (isAbortedUpload(err)) {
          logger.info('[rooms] an upload was abandoned before it finished', {
            roomId: req.params.id,
            reason: err instanceof Error ? err.message : String(err),
          });
          reply = () => undefined;
        } else {
          reply = () => sendRoomFileError(res, err, 'POST /:id/files/upload');
        }
      }
      reply();
    })();
  });

  /**
   * Whether an upload failed because the client went away — multer's own words
   * for an aborted or closed request.
   *
   * @param err - What the upload failed with.
   */
  function isAbortedUpload(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.message === 'Request aborted' || err.message === 'Request closed')
    );
  }

  /**
   * Turn a multer refusal into the room's own.
   *
   * @param err - What multer reported.
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
  router.post('/:id/files/move', (req, res) => {
    void (async () => {
      try {
        resolveCaller(req, res);
        const body = parseBody(RoomFileMoveRequestSchema, req.body, res);
        if (!body) return;
        const outcome = await withRoomFileHttpRequest(req, res, (editor, handle) =>
          executeRoomFileMove(editor, handle, body)
        );
        if (outcome.status === 'conflict') return sendFileConflict(res, outcome.conflict);
        res.json(outcome.result);
      } catch (err) {
        sendRoomFileError(res, err, 'POST /:id/files/move');
      }
    })();
  });

  /**
   * POST /:id/files/delete — delete one file or folder (spec `agent-home-desk`
   * §7.1).
   *
   * POST rather than DELETE, because the request carries a body (the lock) and a
   * DELETE body is one proxies are free to drop. One commit, `Delete <path>`; every
   * path under `path` must be unchanged since `baseCommit`. The room's history
   * keeps what was deleted.
   */
  router.post('/:id/files/delete', (req, res) => {
    void (async () => {
      try {
        resolveCaller(req, res);
        const body = parseBody(RoomFileDeleteRequestSchema, req.body, res);
        if (!body) return;
        const outcome = await withRoomFileHttpRequest(req, res, (editor, handle) =>
          executeRoomFileRemove(editor, handle, body)
        );
        if (outcome.status === 'conflict') return sendFileConflict(res, outcome.conflict);
        res.json(outcome.result);
      } catch (err) {
        sendRoomFileError(res, err, 'POST /:id/files/delete');
      }
    })();
  });

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
  router.post('/:id/files/from-attachment', (req, res) => {
    void (async () => {
      try {
        const caller = resolveCaller(req, res);
        const body = parseBody(RoomFileFromAttachmentRequestSchema, req.body, res);
        if (!body) return;
        const answer = await withRoomFileHttpRequest(req, res, async (editor, handle) => {
          // The write gate before the attachment is looked up: a caller who may not
          // change this room's files learns nothing about its attachments.
          requireRoomFileEditorHttpCurrent(editor, handle);

          const row = getAttachmentRowStore().get(req.params.id, body.attachmentId);
          if (
            !row ||
            row.entryId === null ||
            !getRoomService().canReadAttachment(req.params.id, caller.id, row)
          ) {
            return () => sendError(res, 404, 'No such file.', 'ATTACHMENT_NOT_FOUND');
          }
          const stored = await getRoomAttachmentStore().get(
            req.params.id,
            row.id,
            row.extension,
            'application/octet-stream'
          );
          if (!stored) return () => sendError(res, 404, 'No such file.', 'ATTACHMENT_NOT_FOUND');
          const chunks: Buffer[] = [];
          for await (const chunk of stored.stream) chunks.push(Buffer.from(chunk as Buffer));

          const outcome = await executeRoomFileAttachment(editor, handle, {
            dir: body.dir,
            name: body.name ?? row.name,
            baseCommit: body.baseCommit,
            bytes: Buffer.concat(chunks),
          });
          return outcome.status === 'conflict'
            ? () => sendFileConflict(res, outcome.conflict)
            : () => res.json(outcome.result);
        });
        answer();
      } catch (err) {
        if (err instanceof InvalidRoomAttachmentIdError) {
          return sendError(res, 404, 'No such file.', 'ATTACHMENT_NOT_FOUND');
        }
        sendRoomFileError(res, err, 'POST /:id/files/from-attachment');
      }
    })();
  });

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
  router.post('/:id/repo/main/repair', (req, res) => {
    void (async () => {
      try {
        resolveCaller(req, res);
        const body = parseBody(RoomMainRepairRequestSchema, req.body, res);
        if (!body) return;
        res.json(await performRoomRepoHttpOperation(req, res, req.params.id, 'repair', body));
      } catch (err) {
        sendRoomFileError(res, err, 'POST /:id/repo/main/repair');
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
        resolveCaller(req, res);
        const body = parseBody(MergeRoomRepoRequestSchema, req.body, res);
        if (!body) return;
        const result = await performRoomRepoHttpOperation(req, res, req.params.id, 'merge', {
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
        sendRoomFileError(res, err, 'POST /:id/repo/merge');
      }
    })();
  });
}
