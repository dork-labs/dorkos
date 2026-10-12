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
import type { Context } from 'hono';
import { DevtoolsRecordingUploadSchema } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import {
  parseUploadForm,
  UploadLimitError,
  type UploadedFile,
  type UploadForm,
} from '../http/uploads.js';
import { devtoolsCaptureStore } from '../services/session/index.js';
import { configManager } from '../services/core/config-manager.js';
import { sniffImageContentType } from '../services/identity/image-sniff.js';
import { pathErrorReply, resolveWithinCwd } from '../lib/file-route-guards.js';
import { errorBody, parseSessionId } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';

/** The lease an upload holds while it writes. */
type RecordingUploadLease = NonNullable<
  ReturnType<typeof devtoolsCaptureStore.claimRecordingUpload>
>;

/** The multipart field the encoded GIF arrives under. */
const RECORDING_FIELD = 'recording';

/** The multipart field the last frame arrives under. */
const KEYFRAME_FIELD = 'keyframe';

/** Where a session's recordings live, under the directory `.gitignore` covers. */
const RECORDINGS_DIR = path.join('.dork', '.temp', 'recordings');

const RETIRED = errorBody('That recording page is no longer available', 'RECORDING_RETIRED');

/**
 * Handler for `POST /api/sessions/:id/devtools/recording`.
 *
 * Answers 204 once the file is on disk and the waiting `browser_record_stop`
 * has been resolved; 404 when nothing is awaiting this `requestId` (the tool
 * already gave up, which is not the client's fault and not an error it can act
 * on); 413 when either part is over the configured upload ceiling.
 *
 * @param c - The request context (`:id` route param + a two-part multipart
 *   body); answers 204 / 400 / 404 / 409 / 413 / 500.
 */
export async function sessionDevtoolsRecordingHandler(c: Context<ApiEnv>): Promise<Response> {
  // Parsed to REFUSE a malformed id, and then deliberately unused — the same
  // requestId-only keying `sessionDevtoolsActionHandler` explains beside it. A
  // brand-new session is rekeyed to its canonical id mid-first-turn, so an
  // upload matched on the id in this URL could arrive under one id for a waiter
  // registered under the other and strand the tool call. The `requestId` below
  // is single-use and server-minted, which is what actually addresses this.
  const sessionId = parseSessionId(c.req.param('id'));
  if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

  // The same ceiling every other upload in the product answers to, read per
  // request so a change in Settings takes effect on the next recording.
  const uploads = configManager.get('uploads');
  let form: UploadForm | undefined;
  try {
    // Memory, not disk: the server decides the filename, so letting the parser
    // name a file on disk would be a second place a destination comes from.
    form = await parseUploadForm(c, {
      fields: [
        { name: RECORDING_FIELD, maxCount: 1 },
        { name: KEYFRAME_FIELD, maxCount: 1 },
      ],
      limits: {
        fileSize: Math.min(uploads.maxFileSize, 8 * 1024 * 1024),
        files: 2,
        fields: 7,
        fieldSize: 2048,
      },
    });
  } catch (err) {
    if (err instanceof UploadLimitError && err.code === 'LIMIT_FILE_SIZE') {
      const megabytes = configManager.get('uploads').maxFileSize / 1024 / 1024;
      return c.json(errorBody(`Recording too large (max ${megabytes}MB)`, err.code), 413);
    }
    const message = err instanceof Error ? err.message : 'Invalid recording upload';
    return c.json(errorBody(message, 'RECORDING_UPLOAD_INVALID'), 400);
  }
  return finish(c, form);
}

/**
 * Write the uploaded recording and resolve the tool call awaiting it.
 *
 * @param c - The request context.
 * @param form - The parsed multipart body, or `undefined` when the body is
 *   not multipart.
 */
async function finish(c: Context<ApiEnv>, form: UploadForm | undefined): Promise<Response> {
  // A body that is not multipart is read as the JSON it was, as it was when
  // the multipart parser stepped aside for it.
  const parsed = DevtoolsRecordingUploadSchema.safeParse(form ? form.fields : readJsonBody(c));
  if (!parsed.success) {
    return c.json(errorBody('Invalid recording upload', 'VALIDATION_ERROR'), 400);
  }
  const { requestId, frames, durationMs, error: reported } = parsed.data;

  // The ONLY source of a destination. An upload nobody is awaiting has nowhere
  // to go, and inventing one would be a write this request chose.
  const pending = devtoolsCaptureStore.pendingRecording(requestId);
  if (!pending) {
    return c.json(
      errorBody('No recording is waiting for that upload', 'RECORDING_NOT_PENDING'),
      404
    );
  }

  const admitted = () =>
    devtoolsCaptureStore.admitsRecording(requestId, {
      clientId: c.req.header('X-Client-Id'),
      documentId: parsed.data.documentId,
      bridgeGeneration: parsed.data.bridgeGeneration,
    });
  if (!admitted()) return c.json(RETIRED, 409);

  const files = form?.files ?? [];
  const gif = files.find((file) => file.fieldname === RECORDING_FIELD);
  const keyframe = files.find((file) => file.fieldname === KEYFRAME_FIELD);
  if (!reported && (!gif || frames === undefined || durationMs === undefined)) {
    return c.json(
      errorBody(
        `Attach the recording as the '${RECORDING_FIELD}' field, with its frame count.`,
        'RECORDING_MISSING'
      ),
      400
    );
  }
  if (keyframe && keyframe.size > 675000) {
    return c.json(errorBody('The last frame is too large', 'RECORDING_KEYFRAME_TOO_LARGE'), 413);
  }

  // Includes error-only results: no competing response may consume an owner's waiter.
  const lease = devtoolsCaptureStore.claimRecordingUpload(requestId, {
    clientId: c.req.header('X-Client-Id'),
    documentId: parsed.data.documentId,
    bridgeGeneration: parsed.data.bridgeGeneration,
  });
  if (!lease) {
    return c.json(
      errorBody('That recording upload is no longer available', 'RECORDING_RETIRED'),
      409
    );
  }
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
      return c.body(null, 204);
    }
    const relative = path.join(RECORDINGS_DIR, `${lease.pending.recordingId}.gif`);
    const { resolved } = await resolveWithinCwd(lease.pending.cwd, relative);
    destination = resolved;
    if (!current()) return c.json(RETIRED, 409);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    if (!current()) return c.json(RETIRED, 409);
    staging = path.join(path.dirname(resolved), `.recording-${randomUUID()}.upload`);
    await fs.writeFile(staging, gif!.buffer!, { flag: 'wx' });
    if (!current()) return c.json(RETIRED, 409);
    // Only the exclusive owner may atomically publish fully written bytes to the server-owned path.
    await fs.rename(staging, resolved);
    published = true;
    staging = undefined;
    if (!current()) return c.json(RETIRED, 409);
    committed = devtoolsCaptureStore.resolveRecordingUpload(lease, {
      ok: true,
      path: relative,
      bytes: gif!.buffer!.byteLength,
      frames: frames!,
      durationMs: durationMs!,
      keyframe: pngKeyframe(keyframe),
    });
    if (!committed) return c.json(RETIRED, 409);
    return c.body(null, 204);
  } catch (writeErr) {
    devtoolsCaptureStore.resolveRecordingUpload(lease, {
      ok: false,
      error: 'The recording couldn’t be saved to this chat’s folder.',
      provenance: 'host',
    });
    const refused = pathErrorReply(writeErr);
    if (refused) return c.json(refused.body, refused.status);
    logger.error('[session-recording] could not save a recording', { err: writeErr });
    return c.json(errorBody('Could not save the recording', 'RECORDING_WRITE_FAILED'), 500);
  } finally {
    // After the answer, as Express ran it: the client hears now, and the lease
    // is held until the cleanup is done, so no replacement publishes over a
    // file still being removed.
    void cleanUpThenRelease(lease, staging, published && !committed ? destination : undefined);
  }
}

/**
 * Remove what this owner left behind, then give the upload's lease back. Only
 * this owner's random stage and successfully renamed destination are ours to
 * remove.
 *
 * @param lease - The upload's lease.
 * @param staging - The stage file, while it still exists.
 * @param destination - The published file, when it was never committed.
 */
async function cleanUpThenRelease(
  lease: RecordingUploadLease,
  staging: string | undefined,
  destination: string | undefined
): Promise<void> {
  try {
    if (staging)
      await fs.unlink(staging).catch((cleanupErr: NodeJS.ErrnoException) => {
        if (cleanupErr.code !== 'ENOENT')
          logger.error('[session-recording] stage cleanup failed', { err: cleanupErr });
      });
    if (destination)
      await fs.unlink(destination).catch((cleanupErr: NodeJS.ErrnoException) => {
        if (cleanupErr.code !== 'ENOENT')
          logger.error('[session-recording] publication cleanup failed', { err: cleanupErr });
      });
  } finally {
    devtoolsCaptureStore.releaseRecordingUpload(lease);
  }
}

/**
 * The last frame as an MCP image block's two fields, or `null`.
 *
 * @param keyframe - The uploaded part, if one came.
 */
function pngKeyframe(
  keyframe: UploadedFile | undefined
): { data: string; mimeType: string } | null {
  if (!keyframe?.buffer) return null;
  const sniffed = sniffImageContentType(keyframe.buffer);
  if (sniffed !== 'image/png') return null;
  return { data: keyframe.buffer.toString('base64'), mimeType: sniffed };
}
