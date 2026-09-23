/**
 * Staging an owner export and letting go of it.
 *
 * The route tests prove the bytes and headers on the wire; these prove the
 * parts only the file system can see: a measured copy, no copy left behind
 * after a refusal, and no copy (or token) kept once an upload has landed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityMoveUploads,
  discardStagedArchive,
  stageArchive,
  StagingError,
} from '../community-move-upload.js';

const servers: Server[] = [];

/** The staging directories currently in the system temp directory. */
function stagingDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('dorkos-community-move-'));
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

describe('stageArchive', () => {
  // Purpose: the service is told the size and digest this measures; a wrong
  // one is refused on upload. Fails if either is computed over anything but
  // the exact bytes.
  it('copies the bytes and measures their size and SHA-256', async () => {
    const bytes = Buffer.from('an owner export');
    const staged = await stageArchive(Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]));
    expect(staged.bytes).toBe(bytes.length);
    expect(staged.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(existsSync(staged.filePath)).toBe(true);
    await discardStagedArchive(staged);
    expect(existsSync(staged.filePath)).toBe(false);
  });

  it('refuses an empty file and keeps no copy', async () => {
    const before = new Set(stagingDirs());
    await expect(stageArchive(Readable.from([]))).rejects.toBeInstanceOf(StagingError);
    expect(stagingDirs().filter((dir) => !before.has(dir))).toEqual([]);
  });

  // Purpose: a file past the ceiling must not fill the disk. Fails if the copy
  // survives the refusal.
  it('stops at the ceiling and leaves nothing behind', async () => {
    const before = new Set(stagingDirs());
    const body = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]);
    const error = await stageArchive(body, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StagingError);
    expect((error as StagingError).reason).toBe('too_large');
    expect(stagingDirs().filter((dir) => !before.has(dir))).toEqual([]);
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
    const staged = await stageArchive(Readable.from([Buffer.from('export')]));
    const uploads = new CommunityMoveUploads();
    await uploads.begin('move_1', staged, target(await uploadRoute(200)));
    expect(uploads.progress('move_1')).toMatchObject({ state: 'sent', sentBytes: 6 });
    await vi.waitFor(() => expect(existsSync(staged.filePath)).toBe(false));
    expect(uploads.retry('move_1')).toBe(false);
  });

  // Purpose: a refused upload can be sent again from the same copy.
  it('keeps the copy after a refusal so it can be sent again', async () => {
    const staged = await stageArchive(Readable.from([Buffer.from('export')]));
    const uploads = new CommunityMoveUploads();
    await uploads.begin('move_1', staged, target(await uploadRoute(400)));
    expect(uploads.progress('move_1')).toMatchObject({ state: 'failed', failure: 'rejected' });
    expect(existsSync(staged.filePath)).toBe(true);
    uploads.discard('move_1');
    await vi.waitFor(() => expect(existsSync(staged.filePath)).toBe(false));
    expect(uploads.progress('move_1')).toBeNull();
  });

  it('reports a broken connection as interrupted', async () => {
    const staged = await stageArchive(Readable.from([Buffer.from('export')]));
    const uploads = new CommunityMoveUploads();
    await uploads.begin('move_1', staged, target('http://127.0.0.1:1/upload'));
    expect(uploads.progress('move_1')).toMatchObject({ state: 'failed', failure: 'interrupted' });
    uploads.discard('move_1');
  });
});
