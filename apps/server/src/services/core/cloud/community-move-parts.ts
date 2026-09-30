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
  CommunityMovePartListSchema,
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
}

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

/** The most times one part, or `complete`, waits on a busy server before the attempt stops. */
const MAX_BUSY_WAITS = 120;
/** How long to wait when a busy answer names no time. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/** The parts a file of `bytes` cuts into: numbered from 1, each `[start, end]` inclusive. */
export function partRanges(
  bytes: number,
  partBytes: number
): { partNumber: number; start: number; end: number }[] {
  const ranges = [];
  for (let start = 0, partNumber = 1; start < bytes; start += partBytes, partNumber++)
    ranges.push({ partNumber, start, end: Math.min(bytes, start + partBytes) - 1 });
  return ranges;
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
  const fail = (failure: NonNullable<CloudCommunityMoveUpload['failure']>) => {
    job.progress = { ...job.progress, state: 'failed', failure };
  };

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
            // Answers here are small JSON; never hold more than a little of one.
            size += chunk.length;
            if (size <= 64 * 1024) chunks.push(chunk);
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
    // What the server already holds, so only the missing parts go.
    const listed = await call('GET', `${base}/parts`, {}, null);
    if (listed.status === 401) return fail('expired');
    if (listed.status !== 200) return fail(listed.status >= 500 ? 'interrupted' : 'rejected');
    const parsed = CommunityMovePartListSchema.safeParse(JSON.parse(listed.body || 'null'));
    if (!parsed.success) return fail('interrupted');
    const held = new Map(parsed.data.parts.map((part) => [part.partNumber, part]));

    const ranges = partRanges(total, target.parts.partBytes);
    let sent = 0;
    job.progress = { state: 'sending', sentBytes: 0, totalBytes: total, failure: null };
    for (const range of ranges) {
      const size = range.end - range.start + 1;
      let digest = job.partDigests.get(range.partNumber);
      if (!digest) {
        digest = await digestRange(job.staged.filePath, range.start, range.end);
        job.partDigests.set(range.partNumber, digest);
      }
      const there = held.get(range.partNumber);
      if (there && there.byteSize === size && there.sha256 === digest) {
        sent += size;
        job.progress = { ...job.progress, sentBytes: sent };
        continue;
      }
      for (let tries = 0; ; tries++) {
        let inFlight = 0;
        const answer = await call(
          'PUT',
          `${base}/parts/${range.partNumber}`,
          {
            'content-type': 'application/octet-stream',
            [COMMUNITY_ARCHIVE_PART_DIGEST_HEADER]: digest,
          },
          { start: range.start, end: range.end },
          (count) => {
            inFlight += count;
            job.progress = { ...job.progress, sentBytes: sent + Math.min(inFlight, size) };
          }
        );
        if (answer.status >= 200 && answer.status < 300) break;
        if (answer.status === 401) return fail('expired');
        // Busy: too many parts arriving at once, or this part is still being taken in.
        if ((answer.status === 429 || answer.status === 409) && tries < MAX_BUSY_WAITS) {
          job.progress = { ...job.progress, sentBytes: sent };
          await options.wait(answer.retryAfter, stop.signal);
          continue;
        }
        return fail(
          answer.status >= 500 || answer.status === 429 || answer.status === 409
            ? 'interrupted'
            : 'rejected'
        );
      }
      sent += size;
      job.progress = { ...job.progress, sentBytes: sent };
    }

    // Put the parts together. A large file takes the server a while to check; it
    // says so with 202 and a time to ask again.
    const body = Buffer.from(
      JSON.stringify({
        parts: ranges.length,
        archiveBytes: total,
        archiveSha256: job.staged.sha256,
      })
    );
    for (let tries = 0; ; tries++) {
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
      if ((answer.status === 202 || answer.status === 409) && tries < MAX_BUSY_WAITS) {
        await options.wait(answer.retryAfter, stop.signal);
        continue;
      }
      // 400: the parts did not make the declared file. The server discarded
      // them; these bytes would be refused again.
      return fail(
        answer.status >= 500 || answer.status === 202 || answer.status === 409
          ? 'interrupted'
          : 'rejected'
      );
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
