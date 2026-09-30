/**
 * Sending a move's export in parts, against a fake Community server that
 * speaks the parted upload the contract describes (`upload.parts` in
 * `@dork-labs/cloud-api`): numbered parts with their own digests, a list of
 * what arrived, and `complete`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFLICT_WAIT_SECONDS, fitsInParts, MAX_WAIT_SECONDS } from '../community-move-parts.js';
import { CommunityMoveUploads, type StagedArchive } from '../community-move-upload.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const TOKEN = 'upl_secret_parts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  servers.length = 0;
});

/** One part the fake holds: its size and digest (the bytes are not kept, so 3 GiB fits). */
interface Held {
  byteSize: number;
  sha256: string;
}

/** What the fake Community server does, set per test. */
interface Fake {
  url: string;
  held: Map<number, Held>;
  /** Every request, in order: method and path. */
  log: string[];
  /** Break the connection after this many bytes of this part number, once. */
  breakPart: { partNumber: number; afterBytes: number } | null;
  /** Answers the next part uploads give before accepting (`429` = busy). */
  partStatus: number[];
  /** Answers `complete` gives in order before it checks (`202` = still checking). */
  completeStatus: number[];
  /** The whole file's digest `complete` must be told. */
  expectedSha256: string;
  /** Authorization headers that were not the token. */
  badAuth: number;
  /** The Retry-After a busy part answer names; empty for none. */
  retryAfter: string;
  /** When true, `GET …/parts` is read and never answered. */
  silent: boolean;
}

async function fakeServer(): Promise<Fake> {
  const fake: Fake = {
    url: '',
    held: new Map(),
    log: [],
    breakPart: null,
    partStatus: [],
    completeStatus: [],
    expectedSha256: '',
    badAuth: 0,
    retryAfter: '5',
    silent: false,
  };
  const server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    fake.log.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) fake.badAuth++;
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const part = /^\/imp\/parts\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/imp/parts') {
      req.resume();
      if (fake.silent) return;
      return answer(200, {
        parts: [...fake.held].map(([partNumber, held]) => ({ partNumber, ...held })),
        maxPartBytes: 256 * MIB,
        maxArchiveBytes: 4 * GIB,
      });
    }
    if (req.method === 'PUT' && part) {
      const partNumber = Number(part[1]);
      const busy = fake.partStatus.shift();
      if (busy) {
        req.resume();
        return answer(
          busy,
          { code: busy === 429 ? 'RATE_LIMITED' : 'STATE_CONFLICT' },
          fake.retryAfter ? { 'retry-after': fake.retryAfter } : {}
        );
      }
      const hash = createHash('sha256');
      let size = 0;
      const cut = fake.breakPart?.partNumber === partNumber ? fake.breakPart.afterBytes : Infinity;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
        if (size >= cut) {
          fake.breakPart = null;
          req.socket.destroy();
        }
      });
      req.on('end', () => {
        if (res.destroyed) return;
        const sha256 = hash.digest('hex');
        if (
          sha256 !== req.headers['x-part-sha256'] ||
          size !== Number(req.headers['content-length'])
        )
          return answer(400, { code: 'IMPORT_ARCHIVE_INVALID' });
        fake.held.set(partNumber, { byteSize: size, sha256 });
        answer(200, { partNumber, byteSize: size, sha256 });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/imp/complete') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const next = fake.completeStatus.shift();
        if (next) return answer(next, {}, { 'retry-after': '7' });
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          parts: number;
          archiveBytes: number;
          archiveSha256: string;
        };
        const numbers = [...fake.held.keys()].sort((a, b) => a - b);
        const exact =
          numbers.length === body.parts && numbers.every((number, index) => number === index + 1);
        const bytes = [...fake.held.values()].reduce((sum, held) => sum + held.byteSize, 0);
        if (!exact || bytes !== body.archiveBytes || body.archiveSha256 !== fake.expectedSha256) {
          fake.held.clear();
          return answer(400, { code: 'IMPORT_ARCHIVE_INVALID' });
        }
        answer(200, { state: 'validating' });
      });
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/imp') {
      req.resume();
      req.on('end', () => answer(200, {}));
      return;
    }
    req.resume();
    answer(404, {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/imp`;
  return fake;
}

/** A staged copy of `bytes` (a sparse file of zeros, or the given content), in its own folder. */
async function staged(content: number | Buffer): Promise<StagedArchive> {
  const dir = mkdtempSync(path.join(tmpdir(), 'dorkos-move-parts-test-'));
  const filePath = path.join(dir, 'export.zip');
  if (typeof content === 'number') {
    writeFileSync(filePath, '');
    truncateSync(filePath, content);
  } else writeFileSync(filePath, content);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  const bytes = typeof content === 'number' ? content : content.length;
  return { filePath, bytes, sha256: hash.digest('hex') };
}

function target(fake: Fake, partBytes: number) {
  return {
    url: fake.url,
    token: TOKEN,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    maxBytes: GIB,
    parts: { partBytes, maxBytes: 4 * GIB },
  };
}

/** Waits the registry did, in seconds, without waiting for real. */
function recordingWaits() {
  const waits: number[] = [];
  const uploads = new CommunityMoveUploads({
    wait: async (seconds) => {
      waits.push(seconds);
    },
  });
  return { uploads, waits };
}

describe('fitsInParts', () => {
  // Purpose: a file goes up in parts only within the host's parted limit and in no more parts
  // than the contract allows. Fails if either bound is ignored.
  it('bounds a parted upload by the host limit and the part count', () => {
    expect(fitsInParts(20, { partBytes: 8, maxBytes: 20 })).toBe(true);
    expect(fitsInParts(21, { partBytes: 8, maxBytes: 20 })).toBe(false);
    expect(fitsInParts(10_000, { partBytes: 1, maxBytes: GIB })).toBe(true);
    expect(fitsInParts(10_001, { partBytes: 1, maxBytes: GIB })).toBe(false);
  });
});

describe('an upload in parts', () => {
  // Purpose (AC-15): a 3 GiB export goes up in parts; the connection breaks part-way through
  // part five, and sending again asks what arrived and sends only parts five on, then
  // completes. Fails if a part that arrived is sent twice, a part is lost, or a byte is counted
  // twice in the progress.
  it('sends 3 GiB in parts and resumes after a break with only the parts missing', async () => {
    const fake = await fakeServer();
    const file = await staged(3 * GIB);
    fake.expectedSha256 = file.sha256;
    fake.breakPart = { partNumber: 5, afterBytes: 64 * MIB };
    const { uploads } = recordingWaits();
    await uploads.begin('move_big', file, target(fake, 256 * MIB));
    const broken = uploads.progress('move_big')!;
    expect(broken).toMatchObject({ state: 'failed', failure: 'interrupted', totalBytes: 3 * GIB });
    // Only the parts the server confirmed count as sent, never the part that broke.
    expect(broken.sentBytes).toBe(4 * 256 * MIB);
    expect([...fake.held.keys()]).toEqual([1, 2, 3, 4]);
    expect(existsSync(file.filePath)).toBe(true);

    fake.log.length = 0;
    expect(uploads.retry('move_big')).toBe(true);
    await vi.waitFor(() => expect(uploads.progress('move_big')?.state).toBe('sent'), {
      timeout: 120_000,
    });
    expect(uploads.progress('move_big')).toEqual({
      state: 'sent',
      sentBytes: 3 * GIB,
      totalBytes: 3 * GIB,
      failure: null,
    });
    expect(fake.log).toEqual([
      'GET /imp/parts',
      ...[5, 6, 7, 8, 9, 10, 11, 12].map((n) => `PUT /imp/parts/${n}`),
      'POST /imp/complete',
    ]);
    expect(fake.badAuth).toBe(0);
    await vi.waitFor(() => expect(existsSync(file.filePath)).toBe(false));
  }, 300_000);

  // Purpose: a part the server holds with other bytes (or a different size) is sent again, and
  // one that matches is not. Fails if the resume trusts a part by its number alone.
  it('sends again a part the server holds with different bytes', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('0123456789abcdefghij'));
    fake.expectedSha256 = file.sha256;
    fake.held.set(1, {
      byteSize: 8,
      sha256: createHash('sha256').update('01234567').digest('hex'),
    });
    fake.held.set(2, { byteSize: 8, sha256: 'f'.repeat(64) });
    const { uploads } = recordingWaits();
    await uploads.begin('move_mixed', file, target(fake, 8));
    expect(uploads.progress('move_mixed')).toMatchObject({ state: 'sent' });
    expect(fake.log).toEqual([
      'GET /imp/parts',
      'PUT /imp/parts/2',
      'PUT /imp/parts/3',
      'POST /imp/complete',
    ]);
  });

  // Purpose: a busy server (too many parts at once) and a `complete` still checking a large
  // file each say when to ask again; the upload waits that long and carries on. Fails if a
  // busy answer ends the upload or the wait ignores Retry-After.
  it('waits when the server is busy or still checking, then carries on', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('0123456789abcdefghij'));
    fake.expectedSha256 = file.sha256;
    fake.partStatus = [429];
    fake.completeStatus = [202, 202];
    const { uploads, waits } = recordingWaits();
    await uploads.begin('move_busy', file, target(fake, 8));
    expect(uploads.progress('move_busy')).toMatchObject({ state: 'sent', sentBytes: 20 });
    expect(waits).toEqual([5, 7, 7]);
  });

  // Purpose: a whole-file mismatch at `complete` means these bytes would be refused again;
  // the upload ends as rejected and lets go of the copy. A closed window ends it as expired.
  it('ends as rejected on a mismatch at complete, and as expired on a closed window', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('0123456789abcdefghij'));
    fake.expectedSha256 = 'e'.repeat(64);
    const { uploads } = recordingWaits();
    await uploads.begin('move_bad', file, target(fake, 8));
    expect(uploads.progress('move_bad')).toMatchObject({ state: 'failed', failure: 'rejected' });
    expect(uploads.retry('move_bad')).toBe(false);
    await vi.waitFor(() => expect(existsSync(file.filePath)).toBe(false));

    const other = await staged(Buffer.from('abc'));
    fake.completeStatus = [401];
    fake.expectedSha256 = other.sha256;
    await uploads.begin('move_late', other, target(fake, 8));
    expect(uploads.progress('move_late')).toMatchObject({ state: 'failed', failure: 'expired' });
  });

  // Purpose (review): pressing "send again" twice (a double click, a second tab) must not start
  // two uploads of one copy: the second would find the copy gone when the first finishes and
  // report a failure for a move that succeeded. Fails if the second press is accepted.
  it('runs one attempt at a time, however often send again is pressed', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('0123456789abcdefghij'));
    fake.expectedSha256 = file.sha256;
    fake.partStatus = [500];
    const { uploads } = recordingWaits();
    await uploads.begin('move_twice', file, target(fake, 8));
    expect(uploads.progress('move_twice')).toMatchObject({ failure: 'interrupted', sentBytes: 0 });
    expect(uploads.retry('move_twice')).toBe(true);
    expect(uploads.progress('move_twice')).toMatchObject({ state: 'sending' });
    expect(uploads.retry('move_twice')).toBe(false);
    await vi.waitFor(() => expect(uploads.progress('move_twice')?.state).toBe('sent'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploads.progress('move_twice')).toMatchObject({ state: 'sent', failure: null });
    expect(fake.log.filter((line) => line === 'POST /imp/complete')).toHaveLength(1);
  });

  // Purpose (review): a conflict that does not clear (the import takes no file any more) ends
  // the attempt after a few short waits, looking again at what the server holds each time,
  // instead of retrying for minutes; a Retry-After of weeks waits at most a minute. Fails if a
  // lasting conflict is retried on and on, or a wait is taken as asked.
  it('stops on a lasting conflict, and waits a minute at most', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('0123456789abcdefghij'));
    fake.expectedSha256 = file.sha256;
    fake.partStatus = [409, 409, 409, 409, 409];
    fake.retryAfter = String(40 * 86_400);
    const { uploads, waits } = recordingWaits();
    await uploads.begin('move_stuck', file, target(fake, 8));
    expect(uploads.progress('move_stuck')).toMatchObject({
      state: 'failed',
      failure: 'interrupted',
    });
    expect(waits).toEqual([MAX_WAIT_SECONDS, MAX_WAIT_SECONDS, MAX_WAIT_SECONDS]);
    expect(fake.log.filter((line) => line === 'GET /imp/parts')).toHaveLength(4);
    expect(fake.log.filter((line) => line.startsWith('PUT'))).toHaveLength(4);
  });

  // Purpose (review): a conflict names no time, and the server may keep a part that broke off
  // marked as arriving for up to a minute; the three waits span at least that. Fails if a
  // conflict with no Retry-After is waited out in a few seconds.
  it('spaces conflict waits over at least a minute', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('0123456789abcdefghij'));
    fake.expectedSha256 = file.sha256;
    fake.partStatus = [409, 409, 409];
    fake.retryAfter = '';
    const { uploads, waits } = recordingWaits();
    await uploads.begin('move_conflict', file, target(fake, 8));
    expect(uploads.progress('move_conflict')).toMatchObject({ state: 'sent' });
    expect(waits).toEqual([CONFLICT_WAIT_SECONDS, CONFLICT_WAIT_SECONDS, CONFLICT_WAIT_SECONDS]);
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeGreaterThanOrEqual(60);
  });

  // Purpose (review): a Community server that never answers must not hold the upload for good:
  // the request is given up after its idle limit, the attempt ends as interrupted, and send
  // again works. Fails if the attempt hangs or ends any other way.
  it('gives up on a server that stops answering, so send again works', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('0123456789abcdefghij'));
    fake.expectedSha256 = file.sha256;
    fake.silent = true;
    const uploads = new CommunityMoveUploads({ wait: async () => undefined, idleMs: 200 });
    await uploads.begin('move_silent', file, target(fake, 8));
    expect(uploads.progress('move_silent')).toMatchObject({
      state: 'failed',
      failure: 'interrupted',
    });
    fake.silent = false;
    expect(uploads.retry('move_silent')).toBe(true);
    await vi.waitFor(() => expect(uploads.progress('move_silent')?.state).toBe('sent'));
  });

  // Purpose (review): a part size that would cut the file into more parts than the contract
  // allows, or a file past the host's parted limit, goes as one upload when it fits one. Fails
  // if such a file is sent in parts.
  it('sends one upload when the file does not fit the parts offered', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('x'.repeat(10_001)));
    fake.expectedSha256 = file.sha256;
    const { uploads } = recordingWaits();
    await uploads.begin('move_single', file, { ...target(fake, 1), maxBytes: GIB });
    expect(fake.log).toEqual(['PUT /imp']);
  });

  // Purpose (review): when the upload window closes, the outcome says so (`expired`), so the
  // app tells the person the time ran out rather than that DorkOS restarted. Fails if the
  // closing window drops the record.
  it('keeps an expired record when the window closes mid-upload', async () => {
    const fake = await fakeServer();
    const file = await staged(Buffer.from('0123456789abcdefghij'));
    fake.expectedSha256 = file.sha256;
    fake.completeStatus = [202];
    // A `complete` still checking when the window closes: the wait ends only when stopped.
    const uploads = new CommunityMoveUploads({
      wait: (_seconds, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    });
    const soon = { ...target(fake, 8), expiresAt: new Date(Date.now() + 500).toISOString() };
    await uploads.begin('move_late_window', file, soon);
    expect(uploads.progress('move_late_window')).toMatchObject({
      state: 'failed',
      failure: 'expired',
    });
    expect(uploads.retry('move_late_window')).toBe(false);
    await vi.waitFor(() => expect(existsSync(file.filePath)).toBe(false));
  });

  // Purpose: cancelling a move stops the upload in parts at once. Fails if it keeps sending.
  it('stops when the move is let go of', async () => {
    const fake = await fakeServer();
    const file = await staged(64 * MIB);
    fake.expectedSha256 = file.sha256;
    const { uploads } = recordingWaits();
    const running = uploads.begin('move_stop', file, target(fake, 4 * MIB));
    await vi.waitFor(() => expect(fake.held.size).toBeGreaterThan(0));
    uploads.discard('move_stop');
    await running;
    const heldThen = fake.held.size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.held.size).toBeLessThanOrEqual(heldThen + 1);
    expect(fake.log).not.toContain('POST /imp/complete');
    expect(uploads.progress('move_stop')).toBeNull();
  });
});
