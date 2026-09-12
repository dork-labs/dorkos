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
export const RECORDINGS_DIR = path.join('.dork', '.temp', 'recordings');

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
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  // The same ceiling every other upload in the product answers to, read per
  // request so a change in Settings takes effect on the next recording.
  const uploads = configManager.get('uploads');
  const parse = multer({
    // Memory, not disk: the server decides the filename, so letting multer name
    // a file on disk would be a second place a destination comes from.
    storage: multer.memoryStorage(),
    limits: { fileSize: uploads.maxFileSize, files: 2 },
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

  // The window could not produce a file and says why. Told to the waiting tool
  // now, in a sentence, rather than left to time out into a vaguer one.
  if (reported) {
    devtoolsCaptureStore.resolveRecording(requestId, { ok: false, error: reported });
    res.status(204).end();
    return;
  }

  const fields = req.files as Record<string, Express.Multer.File[]> | undefined;
  const gif = fields?.[RECORDING_FIELD]?.[0];
  const keyframe = fields?.[KEYFRAME_FIELD]?.[0];
  if (!gif || frames === undefined || durationMs === undefined) {
    return sendError(
      res,
      400,
      `Attach the recording as the '${RECORDING_FIELD}' field, with its frame count.`,
      'RECORDING_MISSING'
    );
  }

  const relative = path.join(RECORDINGS_DIR, `${pending.recordingId}.gif`);
  try {
    const { resolved } = await resolveWithinCwd(pending.cwd, relative);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, gif.buffer);
    devtoolsCaptureStore.resolveRecording(requestId, {
      ok: true,
      path: relative,
      bytes: gif.buffer.byteLength,
      frames,
      durationMs,
      // Sniffed, never trusted: the part crossed an untrusted page, and a
      // malformed image block fails the agent's whole turn rather than merely
      // showing it the wrong picture.
      keyframe: pngKeyframe(keyframe),
    });
    res.status(204).end();
  } catch (writeErr) {
    // The tool is holding a thirty-second wait. Telling it now, in a sentence,
    // beats letting it time out and blame the window.
    devtoolsCaptureStore.resolveRecording(requestId, {
      ok: false,
      error: 'The recording could not be saved to this session working directory.',
    });
    if (sendPathError(res, writeErr)) return;
    logger.error('[session-recording] could not save a recording', { err: writeErr });
    return sendError(res, 500, 'Could not save the recording', 'RECORDING_WRITE_FAILED');
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
