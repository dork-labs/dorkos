/**
 * Sending a move's export in parts, when the Community server offers it
 * (`upload.parts` in `@dork-labs/cloud-api`).
 *
 * The staged copy is cut into numbered parts of at most `parts.partBytes`.
 * Before sending, the sender asks the Community server which parts it already
 * holds (`GET …/parts`) and sends only the ones missing or different, each with
 * its own SHA-256; then it asks the server to put them together
 * (`POST …/complete`), which checks the whole file's size and SHA-256. So a
 * broken connection costs at most the part in flight, and sending again picks
 * up where the last attempt stopped.
 *
 * The token rides only in the `Authorization` header of these requests; it is
 * never logged and never part of anything this module returns.
 *
 * @module services/core/cloud/community-move-parts
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  COMMUNITY_ARCHIVE_PART_DIGEST_HEADER,
  COMMUNITY_MOVE_MAX_PARTS,
  CommunityMovePartListSchema,
  type CommunityMovePart,
  type CommunityMoveUpload,
} from '@dork-labs/cloud-api';
import type { CloudCommunityMoveUpload } from '@dorkos/shared/cloud-schemas';
import { logger, logError } from '../../../lib/logger.js';

/** The file being sent: where it is and what it measures. */
export interface PartedFile {
  filePath: string;
  bytes: number;
  sha256: string;
}

/** What the sender needs from the job that owns it. */
export interface PartedJob {
  staged: PartedFile;
  progress: CloudCommunityMoveUpload;
  /** Set while a request is in flight; stops it. */
  abort: (() => void) | null;
  /** Each part's SHA-256 once measured, by part number, so a retry measures nothing twice. */
  partDigests: Map<number, string>;
}

/** How the sender waits when the server asks it to; tests shorten it. */
export interface PartedOptions {
  /** Wait `seconds` (from a `Retry-After`), or stop early when `signal` aborts. */
  wait(seconds: number, signal: AbortSignal): Promise<void>;
  /**
   * How long a request may go without a byte either way before the attempt ends as
   * `interrupted` (so "send again" works). Defaults to {@link REQUEST_IDLE_MS}.
   */
  idleMs?: number;
}

/** How long a request may go without a byte sent or received before it is given up. */
export const REQUEST_IDLE_MS = 2 * 60_000;

/** Waits for real, as long as the server asked. */
export const REAL_WAIT: PartedOptions['wait'] = (seconds, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

/** The longest one wait lasts, whatever `Retry-After` asks: never a timer that overflows. */
export const MAX_WAIT_SECONDS = 60;
/** The most one attempt waits in all before it stops and may be sent again. */
export const MAX_TOTAL_WAIT_SECONDS = 30 * 60;
/** How many conflicts on one part are waited out before the attempt stops. */
const MAX_CONFLICTS = 3;
/**
 * The least one conflict wait lasts. A conflict names no time, and the server can keep a part
 * that broke off marked as arriving until its own idle limit (a minute), so the waits together
 * span at least that long.
 */
export const CONFLICT_WAIT_SECONDS = 20;
/** How long to wait when a busy answer names no time. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;
/** The most of an answer kept: a part list of the most parts the contract allows fits. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** Why an attempt stopped. */
type Failure = NonNullable<CloudCommunityMoveUpload['failure']>;

/**
 * Whether a file of `bytes` can go up in the parts a Community server offers: within its
 * parted limit, and in no more parts than the contract allows at the offered part size.
 *
 * @param bytes - The file's size.
 * @param parts - What the server offers.
 */
export function fitsInParts(
  bytes: number,
  parts: NonNullable<CommunityMoveUpload['parts']>
): boolean {
  return bytes <= parts.maxBytes && Math.ceil(bytes / parts.partBytes) <= COMMUNITY_MOVE_MAX_PARTS;
}

/** A request's answer: status, `Retry-After` in seconds, and its (small) body. */
interface Answer {
  status: number;
  retryAfter: number;
  body: string;
}

class Stopped extends Error {
  constructor() {
    super('The upload was stopped.');
    this.name = 'Stopped';
  }
}

/** The SHA-256 of one byte range of the staged file. */
async function digestRange(filePath: string, start: number, end: number): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { start, end }))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Send the staged export in parts. Sets `job.progress` as it goes and when it
 * ends: `sent` once `complete` succeeds, or `failed` with `rejected` (the
 * server refused these bytes), `expired` (the upload window closed), or
 * `interrupted` (a connection broke or the server stayed busy; sending again
 * resumes from the parts already there).
 *
 * @param job - The upload being run.
 * @param target - Where to send it, with the token and the part limits.
 * @param options - How to wait when asked.
 */
export async function sendParts(
  job: PartedJob,
  target: CommunityMoveUpload & { parts: NonNullable<CommunityMoveUpload['parts']> },
  options: PartedOptions = { wait: REAL_WAIT }
): Promise<void> {
  const base = target.url.replace(/\/+$/, '');
  const total = job.staged.bytes;
  const stop = new AbortController();
  let current: (() => void) | null = null;
  job.abort = () => {
    stop.abort();
    current?.();
  };
  /** Bytes of parts the server has confirmed; a failure reports only these as sent. */
  let confirmed = 0;
  const fail = (failure: Failure) => {
    job.progress = { ...job.progress, sentBytes: confirmed, state: 'failed', failure };
  };
  // Sending from the first moment, so a second "send again" sees this one running.
  job.progress = { state: 'sending', sentBytes: 0, totalBytes: total, failure: null };

  /** One request, with the token as bearer; the body is a buffer or a byte range of the file. */
  const call = (
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer | { start: number; end: number } | null,
    onBytes?: (count: number) => void
  ): Promise<Answer> =>
    new Promise<Answer>((resolve, reject) => {
      if (stop.signal.aborted) return reject(new Stopped());
      const parsed = new URL(url);
      const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
      const length =
        body === null ? 0 : Buffer.isBuffer(body) ? body.length : body.end - body.start + 1;
      let settled = false;
      const req = requestFn(
        parsed,
        {
          method,
          headers: {
            authorization: `Bearer ${target.token}`,
            ...(body === null ? {} : { 'content-length': String(length) }),
            ...headers,
          },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            // Answers here are JSON; a part list of the most parts fits well within the cap.
            size += chunk.length;
            if (size <= MAX_ANSWER_BYTES) chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const header = Number(res.headers['retry-after']);
            resolve({
              status: res.statusCode ?? 0,
              retryAfter:
                Number.isFinite(header) && header >= 0 ? header : DEFAULT_RETRY_AFTER_SECONDS,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      );
      current = () => req.destroy(new Stopped());
      // A server that stops answering (or stops reading) must not hold the attempt for good.
      req.setTimeout(options.idleMs ?? REQUEST_IDLE_MS, () =>
        req.destroy(new Error('The space’s server stopped answering.'))
      );
      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(stop.signal.aborted ? new Stopped() : error);
      });
      if (body === null || Buffer.isBuffer(body)) {
        req.end(body ?? undefined);
        return;
      }
      const file = createReadStream(job.staged.filePath, body);
      file.on('data', (chunk) => onBytes?.(chunk.length));
      file.on('error', (error) => req.destroy(error));
      file.pipe(req);
    });

  try {
    // A file that does not fit in parts is sent as one upload when it fits one (the caller
    // decides, with `fitsInParts`); one that reaches here anyway is refused.
    const partBytes = target.parts.partBytes;
    const partCount = Math.ceil(total / partBytes);
    if (!fitsInParts(total, target.parts)) return fail('rejected');

    /** The parts the server holds now, or a failure that ends this attempt. */
    const heldParts = async (): Promise<Map<number, CommunityMovePart> | Failure> => {
      const listed = await call('GET', `${base}/parts`, {}, null);
      if (listed.status === 401) return 'expired';
      if (listed.status !== 200) return listed.status >= 500 ? 'interrupted' : 'rejected';
      const parsed = CommunityMovePartListSchema.safeParse(JSON.parse(listed.body || 'null'));
      if (!parsed.success) return 'interrupted';
      return new Map(parsed.data.parts.map((part) => [part.partNumber, part]));
    };
    let held = await heldParts();
    if (typeof held === 'string') return fail(held);

    let sent = 0;
    const budget = { waitedSeconds: 0 };
    /** Wait as the server asked, within limits; false once the attempt has waited long enough. */
    const waitAsAsked = async (seconds: number): Promise<boolean> => {
      const capped = Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS);
      if (budget.waitedSeconds + capped > MAX_TOTAL_WAIT_SECONDS) return false;
      budget.waitedSeconds += capped;
      await options.wait(capped, stop.signal);
      if (stop.signal.aborted) throw new Stopped();
      return true;
    };

    // One part at a time, cut as it goes rather than all up front.
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * partBytes;
      const end = Math.min(total, start + partBytes) - 1;
      const size = end - start + 1;
      let digest = job.partDigests.get(partNumber);
      if (!digest) {
        digest = await digestRange(job.staged.filePath, start, end);
        job.partDigests.set(partNumber, digest);
      }
      let conflicts = 0;
      for (;;) {
        const there = held.get(partNumber);
        if (there && there.byteSize === size && there.sha256 === digest) break;
        let inFlight = 0;
        const answer = await call(
          'PUT',
          `${base}/parts/${partNumber}`,
          {
            'content-type': 'application/octet-stream',
            [COMMUNITY_ARCHIVE_PART_DIGEST_HEADER]: digest,
          },
          { start, end },
          (count) => {
            inFlight += count;
            job.progress = { ...job.progress, sentBytes: sent + Math.min(inFlight, size) };
          }
        );
        job.progress = { ...job.progress, sentBytes: sent };
        if (answer.status >= 200 && answer.status < 300) {
          held.set(partNumber, { partNumber, byteSize: size, sha256: digest });
          break;
        }
        if (answer.status === 401) return fail('expired');
        // Too many parts arriving at once: wait as asked and send it again.
        if (answer.status === 429) {
          if (await waitAsAsked(answer.retryAfter)) continue;
          return fail('interrupted');
        }
        // A conflict is either passing (this part, or the parts being put together, is still
        // in hand) or for good (the import takes no file any more), and both carry the same
        // code. Wait a little, then look at what the server holds before sending again; a
        // conflict that does not clear ends this attempt rather than retrying for minutes.
        if (answer.status === 409 && conflicts++ < MAX_CONFLICTS) {
          if (!(await waitAsAsked(Math.max(answer.retryAfter, CONFLICT_WAIT_SECONDS))))
            return fail('interrupted');
          const again = await heldParts();
          if (typeof again === 'string') return fail(again);
          held = again;
          continue;
        }
        return fail(answer.status >= 500 || answer.status === 409 ? 'interrupted' : 'rejected');
      }
      sent += size;
      confirmed = sent;
      job.progress = { ...job.progress, sentBytes: sent };
    }

    // Put the parts together. A large file takes the server a while to check; it
    // says so with 202 and a time to ask again.
    const body = Buffer.from(
      JSON.stringify({ parts: partCount, archiveBytes: total, archiveSha256: job.staged.sha256 })
    );
    for (;;) {
      const answer = await call(
        'POST',
        `${base}/complete`,
        { 'content-type': 'application/json' },
        body
      );
      if (answer.status >= 200 && answer.status < 300 && answer.status !== 202) {
        job.progress = { state: 'sent', sentBytes: total, totalBytes: total, failure: null };
        return;
      }
      if (answer.status === 401) return fail('expired');
      if (answer.status === 202) {
        if (await waitAsAsked(answer.retryAfter)) continue;
        return fail('interrupted');
      }
      // 400: the parts did not make the declared file. These bytes would be
      // refused again. 409: someone else is uploading, or the import takes no
      // file any more; this attempt ends, and a broken one may be sent again.
      return fail(answer.status >= 500 || answer.status === 409 ? 'interrupted' : 'rejected');
    }
  } catch (error) {
    if (!(error instanceof Stopped))
      // The message can name the host; it never carries the token.
      logger.warn('[Cloud] A community export upload in parts was interrupted', logError(error));
    return fail('interrupted');
  } finally {
    job.abort = null;
  }
}
