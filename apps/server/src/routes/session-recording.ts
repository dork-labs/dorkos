/**
 * Handler for `POST /api/sessions/:id/devtools/recording` — where a finished
 * browser recording lands (spec `canvas-agent-seat` §3.4).
 *
 * ## Two file parts, and one of them is not the film
 *
 * `recording` is the encoded GIF and `keyframe` is its last frame as a PNG. The
 * second part exists because the tool result returns a picture, and a GIF in a
 * tool result would be megabytes of base64 no model can watch animate — the last
 * frame is the state the page ended in, which is the frame an agent reasons
 * about.
 *
 * ## Nothing here trusts the caller about where bytes go
 *
 * The filename comes from the server's own recording state, looked up by the
 * `requestId` the awaiting tool call minted, and the directory comes from the
 * session's working directory the same state recorded. There is no path on this
 * request, so there is no path to validate — and the one it computes still goes
 * through the boundary check, because a working directory that moved under the
 * server is the case a guard is for.
 *
 * @module routes/session-recording
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Request, Response } from 'express';
import multer from 'multer';
import { DevtoolsRecordingUploadSchema } from '@dorkos/shared/schemas';
import { devtoolsCaptureStore } from '../services/session/index.js';
import { configManager } from '../services/core/config-manager.js';
import { sniffImageContentType } from '../services/identity/image-sniff.js';
import { resolveWithinCwd, sendPathError } from '../lib/file-route-guards.js';
import { parseSessionId, sendError } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';

/** The multipart field the encoded GIF arrives under. */
const RECORDING_FIELD = 'recording';

/** The multipart field the last frame arrives under. */
const KEYFRAME_FIELD = 'keyframe';

/** Where a session's recordings live, under the directory `.gitignore` covers. */
const RECORDINGS_DIR = path.join('.dork', '.temp', 'recordings');

/**
 * Express handler for `POST /api/sessions/:id/devtools/recording`.
 *
 * Answers 204 once the file is on disk and the waiting `browser_record_stop`
 * has been resolved; 404 when nothing is awaiting this `requestId` (the tool
 * already gave up, which is not the client's fault and not an error it can act
 * on); 413 when either part is over the configured upload ceiling.
 *
 * @param req - The Express request (`:id` route param + a two-part multipart body).
 * @param res - The Express response (204 / 400 / 404 / 413 / 500).
 */
export async function sessionDevtoolsRecordingHandler(req: Request, res: Response): Promise<void> {
  // Parsed to REFUSE a malformed id, and then deliberately unused — the same
  // requestId-only keying `sessionDevtoolsActionHandler` explains beside it. A
  // brand-new session is rekeyed to its canonical id mid-first-turn, so an
  // upload matched on the id in this URL could arrive under one id for a waiter
  // registered under the other and strand the tool call. The `requestId` below
  // is single-use and server-minted, which is what actually addresses this.
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  // The same ceiling every other upload in the product answers to, read per
  // request so a change in Settings takes effect on the next recording.
  const uploads = configManager.get('uploads');
  const parse = multer({
    // Memory, not disk: the server decides the filename, so letting multer name
    // a file on disk would be a second place a destination comes from.
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.min(uploads.maxFileSize, 8 * 1024 * 1024),
      files: 2,
      fields: 7,
      fieldSize: 2048,
    },
  }).fields([
    { name: RECORDING_FIELD, maxCount: 1 },
    { name: KEYFRAME_FIELD, maxCount: 1 },
  ]);

  parse(req, res, (err: unknown) => {
    void finish(req, res, err);
  });
}

/**
 * Write the uploaded recording and resolve the tool call awaiting it.
 *
 * @param req - The parsed multipart request.
 * @param res - The response to answer on.
 * @param err - Whatever multer refused the body with, if anything.
 */
async function finish(req: Request, res: Response, err: unknown): Promise<void> {
  if (err) {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      const megabytes = configManager.get('uploads').maxFileSize / 1024 / 1024;
      return sendError(res, 413, `Recording too large (max ${megabytes}MB)`, err.code);
    }
    const message = err instanceof Error ? err.message : 'Invalid recording upload';
    return sendError(res, 400, message, 'RECORDING_UPLOAD_INVALID');
  }

  const parsed = DevtoolsRecordingUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid recording upload', 'VALIDATION_ERROR');
  }
  const { requestId, frames, durationMs, error: reported } = parsed.data;

  // The ONLY source of a destination. An upload nobody is awaiting has nowhere
  // to go, and inventing one would be a write this request chose.
  const pending = devtoolsCaptureStore.pendingRecording(requestId);
  if (!pending) {
    return sendError(res, 404, 'No recording is waiting for that upload', 'RECORDING_NOT_PENDING');
  }

  const admitted = () =>
    devtoolsCaptureStore.admitsRecording(requestId, {
      clientId: req.header('X-Client-Id'),
      documentId: parsed.data.documentId,
      bridgeGeneration: parsed.data.bridgeGeneration,
    });
  if (!admitted())
    return sendError(res, 409, 'That recording page is no longer available', 'RECORDING_RETIRED');

  const fields = req.files as Record<string, Express.Multer.File[]> | undefined;
  const gif = fields?.[RECORDING_FIELD]?.[0];
  const keyframe = fields?.[KEYFRAME_FIELD]?.[0];
  if (!reported && (!gif || frames === undefined || durationMs === undefined)) {
    return sendError(
      res,
      400,
      `Attach the recording as the '${RECORDING_FIELD}' field, with its frame count.`,
      'RECORDING_MISSING'
    );
  }
  if (keyframe && keyframe.size > 675000)
    return sendError(res, 413, 'The last frame is too large', 'RECORDING_KEYFRAME_TOO_LARGE');

  // Includes error-only results: no competing response may consume an owner's waiter.
  const lease = devtoolsCaptureStore.claimRecordingUpload(requestId, {
    clientId: req.header('X-Client-Id'),
    documentId: parsed.data.documentId,
    bridgeGeneration: parsed.data.bridgeGeneration,
  });
  if (!lease)
    return sendError(res, 409, 'That recording upload is no longer available', 'RECORDING_RETIRED');
  const current = () => devtoolsCaptureStore.isRecordingUploadCurrent(lease);
  let staging: string | undefined;
  let destination: string | undefined;
  let published = false;
  let committed = false;
  try {
    if (reported) {
      devtoolsCaptureStore.resolveRecordingUpload(lease, {
        ok: false,
        error: reported,
        ...(parsed.data.hostOutcome ? { provenance: parsed.data.hostOutcome } : {}),
      });
      res.status(204).end();
      return;
    }
    const relative = path.join(RECORDINGS_DIR, `${lease.pending.recordingId}.gif`);
    const { resolved } = await resolveWithinCwd(lease.pending.cwd, relative);
    destination = resolved;
    if (!current())
      return sendError(res, 409, 'That recording page is no longer available', 'RECORDING_RETIRED');
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    if (!current())
      return sendError(res, 409, 'That recording page is no longer available', 'RECORDING_RETIRED');
    staging = path.join(path.dirname(resolved), `.recording-${randomUUID()}.upload`);
    await fs.writeFile(staging, gif!.buffer, { flag: 'wx' });
    if (!current())
      return sendError(res, 409, 'That recording page is no longer available', 'RECORDING_RETIRED');
    // Only the exclusive owner may atomically publish fully written bytes to the server-owned path.
    await fs.rename(staging, resolved);
    published = true;
    staging = undefined;
    if (!current())
      return sendError(res, 409, 'That recording page is no longer available', 'RECORDING_RETIRED');
    committed = devtoolsCaptureStore.resolveRecordingUpload(lease, {
      ok: true,
      path: relative,
      bytes: gif!.buffer.byteLength,
      frames: frames!,
      durationMs: durationMs!,
      keyframe: pngKeyframe(keyframe),
    });
    if (!committed)
      return sendError(res, 409, 'That recording page is no longer available', 'RECORDING_RETIRED');
    res.status(204).end();
  } catch (writeErr) {
    devtoolsCaptureStore.resolveRecordingUpload(lease, {
      ok: false,
      error: 'The recording could not be saved to this session working directory.',
      provenance: 'host',
    });
    if (sendPathError(res, writeErr)) return;
    logger.error('[session-recording] could not save a recording', { err: writeErr });
    return sendError(res, 500, 'Could not save the recording', 'RECORDING_WRITE_FAILED');
  } finally {
    // Only this owner's random stage and successfully renamed destination are ours to remove.
    try {
      if (staging)
        await fs.unlink(staging).catch((cleanupErr: NodeJS.ErrnoException) => {
          if (cleanupErr.code !== 'ENOENT')
            logger.error('[session-recording] stage cleanup failed', { err: cleanupErr });
        });
      if (published && !committed && destination)
        await fs.unlink(destination).catch((cleanupErr: NodeJS.ErrnoException) => {
          if (cleanupErr.code !== 'ENOENT')
            logger.error('[session-recording] publication cleanup failed', { err: cleanupErr });
        });
    } finally {
      devtoolsCaptureStore.releaseRecordingUpload(lease);
    }
  }
}

/**
 * The last frame as an MCP image block's two fields, or `null`.
 *
 * @param keyframe - The uploaded part, if one came.
 */
function pngKeyframe(
  keyframe: Express.Multer.File | undefined
): { data: string; mimeType: string } | null {
  if (!keyframe) return null;
  const sniffed = sniffImageContentType(keyframe.buffer);
  if (sniffed !== 'image/png') return null;
  return { data: keyframe.buffer.toString('base64'), mimeType: sniffed };
}
