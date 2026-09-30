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
import { partRanges } from '../community-move-parts.js';
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
        return answer(busy, { code: 'RATE_LIMITED' }, { 'retry-after': '5' });
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

describe('partRanges', () => {
  it('cuts a file into numbered parts, the last one shorter', () => {
    expect(partRanges(20, 8)).toEqual([
      { partNumber: 1, start: 0, end: 7 },
      { partNumber: 2, start: 8, end: 15 },
      { partNumber: 3, start: 16, end: 19 },
    ]);
    expect(partRanges(16, 8)).toHaveLength(2);
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
    expect(broken.sentBytes).toBeGreaterThanOrEqual(4 * 256 * MIB);
    expect(broken.sentBytes).toBeLessThan(5 * 256 * MIB);
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
