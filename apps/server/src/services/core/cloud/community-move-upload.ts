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
 * way forward is the contract's own, cancel and start again. Within a run, a
 * broken upload is sent again from the copy; when the Community server takes
 * the file in parts (`community-move-parts.ts`), that resumes from the parts
 * it already holds. The move's state
 * itself is never cached here; every read goes to the service.
 *
 * **How large a move can be.** Two limits, neither fixed here. This machine's
 * is the free space on the data directory's disk, checked against the declared
 * size before a byte is copied. The new host's is what it offers for the move
 * (`upload.maxBytes`, or `upload.parts.maxBytes` when it takes parts; see
 * {@link hostLimitBytes}). The service refuses a declared size above it when
 * the move starts, and the route checks it again before a byte leaves for the
 * host. The host's limit is only known once the move exists, and a move
 * cannot start until the file is measured, so that check comes after staging.
 * A refusal for room writes nothing, but the browser still sends the whole
 * file before it reads the answer: quick on this machine, slow over the
 * tunnel.
 *
 * @module services/core/cloud/community-move-upload
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  COMMUNITY_ARCHIVE_DIGEST_HEADER,
  COMMUNITY_MOVE_MAX_PARTS,
  type CommunityMoveUpload,
} from '@dork-labs/cloud-api';
import type { CloudCommunityMoveUpload } from '@dorkos/shared/cloud-schemas';
import { logger, logError } from '../../../lib/logger.js';
import { fitsInParts, REAL_WAIT, sendParts, type PartedOptions } from './community-move-parts.js';

/**
 * Space left free on the data directory's disk after an export is staged.
 *
 * The staged copy shares its disk with the database, the logs and the rest of
 * this machine, so staging never takes the last of it. There is no fixed
 * ceiling on the export itself: this machine's limit is its free space
 * ({@link stageArchive}), and the new host names its own
 * ({@link hostLimitBytes}).
 */
export const MOVE_STAGING_HEADROOM_BYTES = 512 * 1024 ** 2;

/**
 * Reads how many bytes are free on the disk holding a directory.
 *
 * @param dir - Any path on the disk.
 */
export type FreeSpaceReader = (dir: string) => Promise<number>;

/**
 * Free bytes on the disk holding `dir`, as an unprivileged process may use them.
 *
 * @param dir - Any path on the disk.
 */
async function freeSpace(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * Bytes promised to exports still arriving, one entry per staging in flight.
 * Free space read at the start of one staging does not yet show the bytes
 * another is about to write, so each counts what the others have yet to write.
 */
const stillArriving = new Set<{ remaining: number }>();

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
export type StagingRefusal =
  /** The request carried no bytes. */
  | 'empty'
  /** The request did not say how large it is, so there is no way to check for room first. */
  | 'size_unknown'
  /** The disk holding the data directory has no room for it. */
  | 'no_room'
  /** The free space could not be read, so there is no way to know the file fits. */
  | 'space_unknown'
  /** The bytes that arrived were not the size the request declared. */
  | 'size_mismatch';

/** Why staging refused a file. */
export class StagingError extends Error {
  /**
   * Builds the error.
   *
   * @param reason - Why the file was refused.
   * @param space - For `no_room`: the bytes staging needed free, and the bytes it found free.
   */
  constructor(
    readonly reason: StagingRefusal,
    readonly space: { neededBytes: number; freeBytes: number } | null = null
  ) {
    super(`The export could not be staged (${reason}).`);
    this.name = 'StagingError';
  }
}

/**
 * Copy an incoming export to a private temp file, measuring it as it arrives.
 *
 * Checks for room first: the declared size plus
 * {@link MOVE_STAGING_HEADROOM_BYTES} must fit in the disk's free space, less
 * what other exports still arriving will take. A file that cannot fit, or
 * whose room cannot be checked, is refused before a byte is read or written.
 *
 * Streams: nothing is buffered beyond one chunk, so the size of the export
 * never becomes the size of this process. A body that ends early, breaks, or
 * runs past its declared size leaves no file behind.
 *
 * @param body - The request body, the export's raw bytes.
 * @param declaredBytes - The size the request declared (its `Content-Length`), or `null` when it declared none.
 * @param readFreeSpace - Reads the disk's free space; tests replace it.
 * @throws {StagingError} When the file is refused.
 */
export async function stageArchive(
  body: Readable,
  declaredBytes: number | null,
  readFreeSpace: FreeSpaceReader = freeSpace
): Promise<StagedArchive> {
  const root = stagingRoot;
  if (root === null) throw new Error('Move staging is not set up yet.');
  if (declaredBytes === null) throw new StagingError('size_unknown');
  if (declaredBytes === 0) throw new StagingError('empty');

  let free: number;
  try {
    free = await readFreeSpace(root);
  } catch (error) {
    logger.warn('[Cloud] Could not read the free space for a community export', logError(error));
    throw new StagingError('space_unknown');
  }
  if (!Number.isFinite(free)) throw new StagingError('space_unknown');
  let promised = 0;
  for (const other of stillArriving) promised += other.remaining;
  const neededBytes = declaredBytes + MOVE_STAGING_HEADROOM_BYTES;
  const freeBytes = Math.max(0, free - promised);
  if (freeBytes < neededBytes) throw new StagingError('no_room', { neededBytes, freeBytes });

  const promise = { remaining: declaredBytes };
  stillArriving.add(promise);
  try {
    const dir = await mkdtemp(path.join(root, 'move-'));
    const filePath = path.join(dir, 'export.zip');
    const hash = createHash('sha256');
    let bytes = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > declaredBytes) {
          callback(new StagingError('size_mismatch'));
          return;
        }
        promise.remaining = declaredBytes - bytes;
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
    if (bytes !== declaredBytes) {
      await rm(dir, { recursive: true, force: true });
      throw new StagingError(bytes === 0 ? 'empty' : 'size_mismatch');
    }
    return { filePath, bytes, sha256: hash.digest('hex') };
  } finally {
    stillArriving.delete(promise);
  }
}

/**
 * The largest export the new host takes, from what it offered for this move.
 *
 * A single upload takes up to `maxBytes`. When the Community server also takes
 * the file in parts, it takes up to `parts.maxBytes`, but never more parts
 * than {@link COMMUNITY_MOVE_MAX_PARTS} of `parts.partBytes` each. A file within
 * either is sent the way it fits ({@link CommunityMoveUploads}).
 *
 * @param upload - Where and how the move's export is to be sent.
 */
export function hostLimitBytes(upload: CommunityMoveUpload): number {
  if (!upload.parts) return upload.maxBytes;
  const parted = Math.min(upload.parts.maxBytes, upload.parts.partBytes * COMMUNITY_MOVE_MAX_PARTS);
  return Math.max(upload.maxBytes, parted);
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
  /** Each part's SHA-256 once measured, for an upload in parts. */
  partDigests: Map<number, string>;
  /** Whether an attempt is running now; there is never more than one. */
  running: boolean;
  /** Set once the upload window has closed; the outcome then stays `expired`. */
  expired: boolean;
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
   * Builds the registry.
   *
   * @param options - How an upload in parts waits when the server asks it to; tests shorten it.
   */
  constructor(private readonly options: PartedOptions = { wait: REAL_WAIT }) {}

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
      partDigests: new Map(),
      running: false,
      expired: false,
    };
    // The token is worthless once the window closes, and so is the copy. A
    // window longer than one timer can hold waits in steps.
    const arm = () => {
      job.expiry = setTimeout(
        () => {
          if (this.jobs.get(moveId) !== job) return;
          if (Date.now() < expiresAt) arm();
          else this.expire(moveId);
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
   * Send a move's export again from the copy this process still holds. An
   * upload in parts carries on from the parts the server already has.
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
    if (!job || job.running || job.target === null || job.progress.failure !== 'interrupted')
      return false;
    void this.run(moveId, job);
    return true;
  }

  /**
   * Close a move's upload when its window has closed: stop what is running, forget the token
   * and remove the copy, but keep the outcome as `expired`, so the app says the time ran out
   * rather than that this DorkOS holds no upload for the move.
   *
   * @param moveId - The move whose window closed.
   */
  expire(moveId: string): void {
    const job = this.jobs.get(moveId);
    if (!job) return;
    clearTimeout(job.expiry);
    job.expired = true;
    job.abort?.();
    job.target = null;
    // A finished outcome (sent, or refused) stays as it was; anything still open expired.
    if (job.progress.state === 'sending' || job.progress.failure === 'interrupted')
      job.progress = { ...job.progress, state: 'failed', failure: 'expired' };
    void discardStagedArchive(job.staged);
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
    if (target === null || job.running) return;
    // One attempt at a time. `running` is the guard of record for that; the `sending` progress
    // set here (and in `sendParts`) and the check in `retry` only make a second "send again"
    // (a double click, another tab) refused sooner. Both are set before the first await.
    job.running = true;
    job.progress = { state: 'sending', sentBytes: 0, totalBytes: job.staged.bytes, failure: null };
    try {
      // In parts whenever the Community server offers them and the file fits them; the
      // single PUT otherwise.
      if (
        target.parts &&
        (fitsInParts(job.staged.bytes, target.parts) || job.staged.bytes > target.maxBytes)
      )
        await sendParts(job, { ...target, parts: target.parts }, this.options);
      else await send(job, target);
    } finally {
      job.running = false;
      // An attempt the closing window stopped reads as expired, not as a broken connection.
      if (
        job.expired &&
        (job.progress.state === 'sending' || job.progress.failure === 'interrupted')
      )
        job.progress = { ...job.progress, state: 'failed', failure: 'expired' };
    }
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
