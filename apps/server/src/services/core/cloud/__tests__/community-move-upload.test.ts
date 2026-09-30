/**
 * Staging an owner export and letting go of it.
 *
 * The route tests prove the bytes and headers on the wire; these prove the
 * parts only the file system can see: a measured copy, no copy left behind
 * after a refusal, and no copy (or token) kept once an upload has landed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMUNITY_MOVE_MAX_PARTS } from '@dork-labs/cloud-api';
import {
  CommunityMoveUploads,
  discardStagedArchive,
  hostLimitBytes,
  initMoveStaging,
  MOVE_STAGING_HEADROOM_BYTES,
  moveStagingRoot,
  stageArchive,
  StagingError,
} from '../community-move-upload.js';

const servers: Server[] = [];

/** A throwaway data directory for this file. */
const dorkHome = mkdtempSync(path.join(tmpdir(), 'dorkos-move-staging-test-'));

beforeAll(async () => {
  await initMoveStaging(dorkHome);
});

/** The staging directories on disk right now. */
function stagingDirs(): string[] {
  return readdirSync(moveStagingRoot(dorkHome));
}

/** A disk with `bytes` free. */
const diskWith = (bytes: number) => async () => bytes;

/** Plenty of room: the room check is not what these tests are about. */
const roomy = diskWith(Number.MAX_SAFE_INTEGER);

/** Stage `bytes`, declared at their true size, on a disk with plenty of room. */
function stage(bytes: Buffer) {
  return stageArchive(Readable.from([bytes]), bytes.length, roomy);
}

/** A body that records whether anything read from it. */
function watchedBody(chunks: Buffer[]) {
  const body = Readable.from(chunks);
  const watched = { body, read: false };
  body.once('data', () => (watched.read = true));
  body.pause();
  return watched;
}

/** The staging directories made since `before`. */
function newDirs(before: Set<string>): string[] {
  return stagingDirs().filter((dir) => !before.has(dir));
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  servers.length = 0;
});

/** A loopback upload route that answers `status` after reading the body. */
async function uploadRoute(status: number): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
}

describe('initMoveStaging', () => {
  // Purpose: a copy a crashed run left behind can never be sent (its token
  // died with that process). Fails if boot does not clear it.
  it('empties what a previous run left behind', async () => {
    const leftover = path.join(moveStagingRoot(dorkHome), 'move-crashed');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(path.join(leftover, 'export.zip'), 'bytes');
    await initMoveStaging(dorkHome);
    expect(stagingDirs()).toEqual([]);
  });
});

describe('stageArchive', () => {
  // Purpose: the service is told the size and digest this measures; a wrong
  // one is refused on upload. Fails if either is computed over anything but
  // the exact bytes.
  it('copies the bytes and measures their size and SHA-256', async () => {
    const bytes = Buffer.from('an owner export');
    const staged = await stageArchive(
      Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
      bytes.length,
      roomy
    );
    expect(staged.bytes).toBe(bytes.length);
    expect(staged.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(existsSync(staged.filePath)).toBe(true);
    await discardStagedArchive(staged);
    expect(existsSync(staged.filePath)).toBe(false);
  });

  it('refuses an empty file and keeps no copy', async () => {
    const before = new Set(stagingDirs());
    await expect(stageArchive(Readable.from([]), 0, roomy)).rejects.toMatchObject({
      reason: 'empty',
    });
    expect(newDirs(before)).toEqual([]);
  });

  // Purpose (DOR-2587): without a declared size there is no way to check for
  // room first. Fails if a body of unknown size is copied.
  it('refuses a file that did not declare its size, before reading it', async () => {
    const before = new Set(stagingDirs());
    const watched = watchedBody([Buffer.from('export')]);
    const error = await stageArchive(watched.body, null, roomy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StagingError);
    expect((error as StagingError).reason).toBe('size_unknown');
    expect(watched.read).toBe(false);
    expect(newDirs(before)).toEqual([]);
  });

  // Purpose (DOR-2587): a file that does not fit this machine's disk is
  // refused with both numbers before a byte is copied. The boundary is exact:
  // the declared size plus the headroom. Fails if the check is missing,
  // off by the headroom, or runs after copying starts.
  it('refuses a file the disk has no room for, before copying a byte', async () => {
    const bytes = Buffer.from('an owner export');
    const needed = bytes.length + MOVE_STAGING_HEADROOM_BYTES;
    const before = new Set(stagingDirs());
    const watched = watchedBody([bytes]);
    const error = await stageArchive(watched.body, bytes.length, diskWith(needed - 1)).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(StagingError);
    expect(error).toMatchObject({
      reason: 'no_room',
      space: { neededBytes: needed, freeBytes: needed - 1 },
    });
    expect(watched.read).toBe(false);
    expect(newDirs(before)).toEqual([]);

    const staged = await stageArchive(Readable.from([bytes]), bytes.length, diskWith(needed));
    expect(staged.bytes).toBe(bytes.length);
    await discardStagedArchive(staged);
  });

  // Purpose (DOR-2587): a move larger than the old fixed 16 GiB ceiling is no
  // longer refused up front when the disk has room for it. Fails if a fixed
  // ceiling comes back: the refusal would be a size refusal before reading.
  it('takes a declared size past 16 GiB when the disk has room for it', async () => {
    const declared = 20 * 1024 ** 3;
    const watched = watchedBody([Buffer.from('the first bytes of a very large export')]);
    const error = await stageArchive(watched.body, declared, diskWith(declared * 2)).catch(
      (e: unknown) => e
    );
    // The short body ends the copy, but only after the room check passed and reading began.
    expect(watched.read).toBe(true);
    expect(error).toMatchObject({ reason: 'size_mismatch' });
  });

  // Purpose (DOR-2587): when the free space cannot be read, nobody knows the
  // file fits, so it is refused rather than copied on hope. Fails if a statfs
  // failure lets the copy go ahead.
  it('refuses safely when the free space cannot be read', async () => {
    const before = new Set(stagingDirs());
    const watched = watchedBody([Buffer.from('export')]);
    const failing = async () => {
      throw Object.assign(new Error('statfs failed'), { code: 'EIO' });
    };
    const error = await stageArchive(watched.body, 6, failing).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'space_unknown' });
    expect(watched.read).toBe(false);
    expect(newDirs(before)).toEqual([]);
    await expect(stageArchive(Readable.from([]), 6, diskWith(Number.NaN))).rejects.toMatchObject({
      reason: 'space_unknown',
    });
  });

  // Purpose (DOR-2587): two exports arriving at once cannot both count the same
  // free space. Fails if the room check ignores what another staging has yet
  // to write.
  it('counts the bytes another export has yet to write', async () => {
    const declared = 100;
    const disk = diskWith(declared + MOVE_STAGING_HEADROOM_BYTES + declared / 2);
    const first = new PassThrough();
    const firstStaged = stageArchive(first, declared, disk);
    first.write(Buffer.alloc(10));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const error = await stageArchive(Readable.from([Buffer.alloc(declared)]), declared, disk).catch(
      (e: unknown) => e
    );
    expect(error).toMatchObject({ reason: 'no_room' });
    first.end(Buffer.alloc(declared - 10));
    const staged = await firstStaged;
    // Once the first has landed, its bytes are on the disk (and in the disk's free
    // space), so it no longer holds a promise over the second.
    const second = await stageArchive(Readable.from([Buffer.alloc(declared)]), declared, disk);
    await discardStagedArchive(staged);
    await discardStagedArchive(second);
  });

  // Purpose (DOR-2587): the room was checked for the declared size only, so a
  // body that runs past it must be stopped mid-copy, not when it ends (a body
  // that never ends would otherwise fill the disk). Fails if the in-copy check
  // is removed: this body never ends, so staging would never settle.
  it('stops a body that runs past its declared size before the body ends', async () => {
    const before = new Set(stagingDirs());
    let ended = false;
    const endless = new Readable({
      read() {
        this.push(Buffer.alloc(8));
      },
    });
    endless.on('end', () => (ended = true));
    const outcome = await Promise.race([
      stageArchive(endless, 10, roomy).catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve('still copying'), 2_000)),
    ]);
    expect(outcome).toMatchObject({ reason: 'size_mismatch' });
    expect(ended).toBe(false);
    expect(newDirs(before)).toEqual([]);
    endless.destroy();
  });

  // Purpose: the file must be exactly the size declared (the room was checked
  // for that size, and the service is told it). Fails if a longer or shorter
  // body is kept.
  it('refuses a body that is not the size it declared, and leaves nothing behind', async () => {
    const before = new Set(stagingDirs());
    const longer = await stageArchive(
      Readable.from([Buffer.alloc(8), Buffer.alloc(8)]),
      10,
      roomy
    ).catch((e: unknown) => e);
    expect(longer).toMatchObject({ reason: 'size_mismatch' });
    const shorter = await stageArchive(Readable.from([Buffer.alloc(8)]), 10, roomy).catch(
      (e: unknown) => e
    );
    expect(shorter).toMatchObject({ reason: 'size_mismatch' });
    expect(newDirs(before)).toEqual([]);
  });
});

describe('hostLimitBytes', () => {
  const upload = {
    url: 'https://community.example.invalid/upload',
    token: 'upl_secret',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxBytes: 1_000,
  };

  // Purpose (DOR-2587): with no parts offered, the single upload's limit is the
  // host's limit. Fails if a parted limit is invented.
  it('is the single-upload limit when the host offers no parts', () => {
    expect(hostLimitBytes(upload)).toBe(1_000);
  });

  // Purpose (DOR-2587): the host's parted limit is the ceiling when it is the
  // larger. Fails if the single limit caps a move the host takes in parts.
  it('is the parted limit when the host takes more in parts', () => {
    expect(hostLimitBytes({ ...upload, parts: { partBytes: 100, maxBytes: 5_000 } })).toBe(5_000);
  });

  // Purpose: a parted upload is also bounded by the most parts it may use, and
  // a parted limit below the single one never lowers the ceiling. Fails if
  // either bound is ignored.
  it('never passes the most parts allowed, nor drops below the single limit', () => {
    expect(
      hostLimitBytes({
        ...upload,
        parts: { partBytes: 1, maxBytes: 10 * COMMUNITY_MOVE_MAX_PARTS },
      })
    ).toBe(COMMUNITY_MOVE_MAX_PARTS);
    expect(hostLimitBytes({ ...upload, parts: { partBytes: 10, maxBytes: 500 } })).toBe(1_000);
  });
});

describe('CommunityMoveUploads', () => {
  const target = (url: string) => ({
    url,
    token: 'upl_secret',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxBytes: 1_000_000,
  });

  // Purpose: once the Community server has the file, neither the copy nor the
  // token is needed. Fails if the staged file outlives a successful upload.
  it('removes the staged copy once the upload lands', async () => {
    const staged = await stage(Buffer.from('export'));
    const uploads = new CommunityMoveUploads();
    await uploads.begin('move_1', staged, target(await uploadRoute(200)));
    expect(uploads.progress('move_1')).toMatchObject({ state: 'sent', sentBytes: 6 });
    await vi.waitFor(() => expect(existsSync(staged.filePath)).toBe(false));
    expect(uploads.retry('move_1')).toBe(false);
  });

  // Purpose: refused bytes would be refused again. Fails if the copy lingers
  // or a retry is allowed.
  it('lets go of the copy after a refusal', async () => {
    const staged = await stage(Buffer.from('export'));
    const uploads = new CommunityMoveUploads();
    await uploads.begin('move_1', staged, target(await uploadRoute(400)));
    expect(uploads.progress('move_1')).toMatchObject({ state: 'failed', failure: 'rejected' });
    expect(uploads.retry('move_1')).toBe(false);
    await vi.waitFor(() => expect(existsSync(staged.filePath)).toBe(false));
  });

  // Purpose: a window further out than one timer can wait must not close at once.
  it('keeps the copy for a window longer than a timer can hold', async () => {
    const staged = await stage(Buffer.from('export'));
    const uploads = new CommunityMoveUploads();
    const far = {
      ...target('http://127.0.0.1:1/upload'),
      expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString(),
    };
    await uploads.begin('move_far', staged, far);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(uploads.progress('move_far')).toMatchObject({ failure: 'interrupted' });
    expect(existsSync(staged.filePath)).toBe(true);
    uploads.discard('move_far');
  });

  it('reports a broken connection as interrupted', async () => {
    const staged = await stage(Buffer.from('export'));
    const uploads = new CommunityMoveUploads();
    await uploads.begin('move_1', staged, target('http://127.0.0.1:1/upload'));
    expect(uploads.progress('move_1')).toMatchObject({ state: 'failed', failure: 'interrupted' });
    uploads.discard('move_1');
  });
});
