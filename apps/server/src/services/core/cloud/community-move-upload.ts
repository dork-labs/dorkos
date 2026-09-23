/**
 * The local half of moving a community in: take the owner export from the
 * browser, then send it on to the new community's server with the upload token
 * only this process holds.
 *
 * **Why the file passes through here at all.** A move's upload token is a
 * one-time credential (`ONE_TIME_CREDENTIAL_META` in `@dork-labs/cloud-api`).
 * Handing it to the browser so the browser could upload directly would put it
 * in page memory, dev tools and any extension that can read requests. So the
 * browser sends the file here, this module measures it (size and SHA-256, which
 * the service needs before it will issue a token), and then streams the same
 * bytes to the Community server itself. The token lives in one object in this
 * module's memory and in the one request that spends it; it is never logged,
 * never written to disk and never part of any response.
 *
 * **What survives what.** The staged copy lives under the data directory
 * (`<dorkHome>/tmp/community-moves/`) until the upload lands, the move is
 * cancelled, or the upload window closes. That directory is emptied at every
 * boot ({@link initMoveStaging}): a copy left by a crash is useless, because
 * the token that could send it lived only in the dead process's memory.
 * The upload's progress lives in memory only: after a restart it is gone, the
 * move reads `awaiting_upload` from the service with no local upload, and the
 * way forward is the contract's own, cancel and start again. The move's state
 * itself is never cached here; every read goes to the service.
 *
 * @module services/core/cloud/community-move-upload
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { COMMUNITY_ARCHIVE_DIGEST_HEADER, type CommunityMoveUpload } from '@dork-labs/cloud-api';
import type { CloudCommunityMoveUpload } from '@dorkos/shared/cloud-schemas';
import { logger, logError } from '../../../lib/logger.js';

/**
 * The largest export this machine will stage.
 *
 * Only a guard for this machine's disk: the service names the real limit
 * (`upload.maxBytes`) and refuses a declared size above it with
 * `import_too_large` before any upload starts. Owner exports are a few hundred
 * megabytes in practice; this leaves generous room above that.
 */
export const MOVE_STAGING_MAX_BYTES = 16 * 1024 ** 3;

/** Where staged exports live, once {@link initMoveStaging} has run. */
let stagingRoot: string | null = null;

/**
 * The directory under the data directory that holds staged exports.
 *
 * @param dorkHome - The resolved data directory.
 */
export function moveStagingRoot(dorkHome: string): string {
  return path.join(dorkHome, 'tmp', 'community-moves');
}

/**
 * Set up the staging directory for this run, emptying whatever a previous run
 * left behind. Called once at boot, after the instance lock, so no other live
 * server shares this data directory.
 *
 * @param dorkHome - The resolved data directory.
 */
export async function initMoveStaging(dorkHome: string): Promise<void> {
  const root = moveStagingRoot(dorkHome);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  stagingRoot = root;
}

/**
 * The longest a timer can wait. `setTimeout` treats anything above 2^31-1 ms
 * (about 24.8 days) as zero and fires at once.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** An export file, copied to this machine and measured. */
export interface StagedArchive {
  /** Where the copy lives. Removed with {@link discardStagedArchive}. */
  filePath: string;
  /** Its exact size in bytes. */
  bytes: number;
  /** Its SHA-256, as lower-case hex. */
  sha256: string;
}

/** Why staging refused a file. */
export class StagingError extends Error {
  /**
   * Builds the error.
   *
   * @param reason - `too_large` when the file passed {@link MOVE_STAGING_MAX_BYTES}, `empty` for no bytes.
   */
  constructor(readonly reason: 'too_large' | 'empty') {
    super(reason === 'too_large' ? 'The export is too large to stage.' : 'The export is empty.');
    this.name = 'StagingError';
  }
}

/**
 * Copy an incoming export to a private temp file, measuring it as it arrives.
 *
 * Streams: nothing is buffered beyond one chunk, so the size of the export
 * never becomes the size of this process. A body that ends early, breaks, or
 * passes `maxBytes` leaves no file behind.
 *
 * @param body - The request body, the export's raw bytes.
 * @param maxBytes - The most bytes to accept.
 * @throws {StagingError} When the file is empty or too large.
 */
export async function stageArchive(
  body: Readable,
  maxBytes: number = MOVE_STAGING_MAX_BYTES
): Promise<StagedArchive> {
  if (stagingRoot === null) throw new Error('Move staging is not set up yet.');
  const dir = await mkdtemp(path.join(stagingRoot, 'move-'));
  const filePath = path.join(dir, 'export.zip');
  const hash = createHash('sha256');
  let bytes = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new StagingError('too_large'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(body, measure, createWriteStream(filePath, { mode: 0o600 }));
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  if (bytes === 0) {
    await rm(dir, { recursive: true, force: true });
    throw new StagingError('empty');
  }
  return { filePath, bytes, sha256: hash.digest('hex') };
}

/**
 * Remove a staged export and its private directory. Safe to call twice.
 *
 * @param staged - The copy to remove.
 */
export async function discardStagedArchive(staged: StagedArchive): Promise<void> {
  await rm(path.dirname(staged.filePath), { recursive: true, force: true });
}

/** One upload this process is responsible for. */
interface UploadJob {
  staged: StagedArchive;
  /**
   * Where to send it and the one-time token that pays for it. Never leaves this
   * module, and is dropped the moment it is spent or can no longer work.
   */
  target: CommunityMoveUpload | null;
  progress: CloudCommunityMoveUpload;
  /** Stops the request in flight, when there is one. */
  abort: (() => void) | null;
  /** Removes the staged copy when the upload window closes. Set once the job is built. */
  expiry: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The answer the Community server gave, reduced to what the move does next.
 *
 * @param status - The HTTP status of the upload response.
 */
function outcomeOf(status: number): 'sent' | CloudCommunityMoveUpload['failure'] {
  if (status >= 200 && status < 300) return 'sent';
  // 401: the window closed; the service will report the move as failed with
  // `upload_expired`, and the token can never work again.
  if (status === 401) return 'expired';
  // 400 IMPORT_ARCHIVE_INVALID (and any other refusal of these bytes): the move
  // stays `awaiting_upload`, but these exact bytes would be refused again, so
  // the way on is a fresh export and a fresh move.
  if (status >= 400 && status < 500) return 'rejected';
  return 'interrupted';
}

/**
 * Send one staged export to its Community server.
 *
 * `node:http(s)` rather than `fetch`, for two reasons: the contract asks for
 * `Content-Length` set to the declared size (undici's `fetch` sends a streamed
 * body chunked), and counting the bytes as they leave is what makes the app's
 * progress bar honest.
 *
 * @param job - The upload to run. Its progress is updated in place.
 * @param target - Where to send it, with the token that pays for it.
 */
function send(job: UploadJob, target: CommunityMoveUpload): Promise<void> {
  const url = new URL(target.url);
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  job.progress = { state: 'sending', sentBytes: 0, totalBytes: job.staged.bytes, failure: null };
  return new Promise<void>((resolve) => {
    let settled = false;
    let stopSending = () => {};
    const settle = (next: CloudCommunityMoveUpload) => {
      if (settled) return;
      settled = true;
      job.progress = next;
      job.abort = null;
      // A refusal can arrive before the whole file has gone; stop reading it.
      stopSending();
      resolve();
    };
    const req = requestFn(
      url,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/zip',
          'content-length': String(job.staged.bytes),
          [COMMUNITY_ARCHIVE_DIGEST_HEADER]: job.staged.sha256,
        },
      },
      (res: IncomingMessage) => {
        // The body is the Community server's own error envelope at most; it is
        // not needed, and reading it only to drop it keeps the socket reusable.
        res.resume();
        const outcome = outcomeOf(res.statusCode ?? 0);
        settle(
          outcome === 'sent'
            ? {
                state: 'sent',
                sentBytes: job.staged.bytes,
                totalBytes: job.staged.bytes,
                failure: null,
              }
            : { ...job.progress, state: 'failed', failure: outcome }
        );
      }
    );
    req.on('error', (error) => {
      // The message can name the host; it never carries the token, which rides
      // in a header this module never prints.
      logger.warn('[Cloud] A community export upload was interrupted', logError(error));
      settle({ ...job.progress, state: 'failed', failure: 'interrupted' });
    });
    const file = createReadStream(job.staged.filePath);
    file.on('data', (chunk) => {
      job.progress = { ...job.progress, sentBytes: job.progress.sentBytes + chunk.length };
    });
    file.on('error', (error) => {
      logger.warn('[Cloud] Could not read a staged community export', logError(error));
      req.destroy();
      settle({ ...job.progress, state: 'failed', failure: 'interrupted' });
    });
    stopSending = () => file.destroy();
    job.abort = () => {
      file.destroy();
      req.destroy();
    };
    file.pipe(req);
  });
}

/**
 * The uploads this process is running or has run, by move.
 *
 * One per process, like the cloud client. Exported as a class so a test can
 * build its own and never share state with another file.
 */
export class CommunityMoveUploads {
  private readonly jobs = new Map<string, UploadJob>();

  /**
   * Take charge of a move's upload and start sending at once.
   *
   * Replaces any earlier job for the same move, discarding its copy.
   *
   * @param moveId - The move the export fills.
   * @param staged - The measured copy to send.
   * @param target - Where to send it, with its one-time token.
   * @returns A promise that settles when this first attempt ends, for tests; callers need not await it.
   */
  begin(moveId: string, staged: StagedArchive, target: CommunityMoveUpload): Promise<void> {
    this.discard(moveId);
    const expiresAt = Date.parse(target.expiresAt);
    const job: UploadJob = {
      staged,
      target,
      progress: { state: 'sending', sentBytes: 0, totalBytes: staged.bytes, failure: null },
      abort: null,
      expiry: undefined,
    };
    // The token is worthless once the window closes, and so is the copy. A
    // window longer than one timer can hold waits in steps.
    const arm = () => {
      job.expiry = setTimeout(
        () => {
          if (this.jobs.get(moveId) !== job) return;
          if (Date.now() < expiresAt) arm();
          else this.discard(moveId);
        },
        Math.min(MAX_TIMER_MS, Math.max(0, expiresAt - Date.now()))
      );
      job.expiry.unref?.();
    };
    arm();
    this.jobs.set(moveId, job);
    return this.run(moveId, job);
  }

  /**
   * Send a move's export again from the copy this process still holds.
   *
   * @param moveId - The move to send again.
   * Only after a broken connection: the Community server never judged those
   * bytes. A file it refused would be refused again, and a closed window never
   * reopens, so both of those end the upload for good.
   *
   * @returns `false` when there is nothing to send again.
   */
  retry(moveId: string): boolean {
    const job = this.jobs.get(moveId);
    if (!job || job.target === null || job.progress.failure !== 'interrupted') return false;
    void this.run(moveId, job);
    return true;
  }

  /**
   * How a move's upload is going here, or `null` when this process has none.
   *
   * @param moveId - The move to report on.
   */
  progress(moveId: string): CloudCommunityMoveUpload | null {
    const job = this.jobs.get(moveId);
    return job ? { ...job.progress } : null;
  }

  /**
   * Stop a move's upload, forget its token and remove its copy.
   *
   * @param moveId - The move to let go of.
   */
  discard(moveId: string): void {
    const job = this.jobs.get(moveId);
    if (!job) return;
    this.jobs.delete(moveId);
    clearTimeout(job.expiry);
    job.abort?.();
    void discardStagedArchive(job.staged);
  }

  /**
   * Run one attempt, and let go of the copy once it can no longer be needed.
   *
   * @param moveId - The move being sent.
   * @param job - Its job.
   */
  private async run(moveId: string, job: UploadJob): Promise<void> {
    const target = job.target;
    if (target === null) return;
    await send(job, target);
    if (this.jobs.get(moveId) !== job) return;
    if (job.progress.state === 'sent' || job.progress.failure !== 'interrupted') {
      // Keep the finished progress so a poll can still say what happened until
      // the window closes, but the token and the copy are of no further use.
      job.target = null;
      void discardStagedArchive(job.staged);
    }
  }
}

/** The process-wide upload registry. */
export const communityMoveUploads = new CommunityMoveUploads();
