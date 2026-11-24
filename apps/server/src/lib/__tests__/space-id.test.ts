/**
 * The local space id (ADR 261122-124821, decision 6): minted once on the first
 * read, the same value on every later read and after a restart, and never
 * written over. Runs against a real temporary directory, so the atomic create
 * and the race between two first reads are the real filesystem's.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateSpaceId, SPACE_ID_FILENAME } from '../identity/space-id.js';
import { INSTANCE_ID_FILENAME } from '../instance-id.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let dorkHome: string;

beforeEach(async () => {
  dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'space-id-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dorkHome, { recursive: true, force: true });
});

describe('getOrCreateSpaceId', () => {
  it('mints a ULID on the first read and saves it as the whole file', async () => {
    const id = await getOrCreateSpaceId(dorkHome);
    expect(id).toMatch(ULID);
    expect(await fs.readFile(path.join(dorkHome, SPACE_ID_FILENAME), 'utf8')).toBe(id);
    // The temporary file it was written through is gone.
    expect(await fs.readdir(dorkHome)).toEqual([SPACE_ID_FILENAME]);
  });

  it('creates the data directory when it does not exist yet', async () => {
    const nested = path.join(dorkHome, 'fresh', '.dork');
    expect(await getOrCreateSpaceId(nested)).toMatch(ULID);
  });

  it('returns the same id on a second read, as after a restart', async () => {
    const first = await getOrCreateSpaceId(dorkHome);
    const stat = await fs.stat(path.join(dorkHome, SPACE_ID_FILENAME));
    const second = await getOrCreateSpaceId(dorkHome);
    expect(second).toBe(first);
    // Read, not rewritten.
    const after = await fs.stat(path.join(dorkHome, SPACE_ID_FILENAME));
    expect(after.ino).toBe(stat.ino);
    expect(after.mtimeMs).toBe(stat.mtimeMs);
  });

  it('agrees on one id when many first reads race', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => getOrCreateSpaceId(dorkHome)));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(ULID);
    expect(await fs.readdir(dorkHome)).toEqual([SPACE_ID_FILENAME]);
  });

  it('reads an existing id with surrounding whitespace', async () => {
    const existing = '01JSPACE0000000000000000AB';
    await fs.writeFile(path.join(dorkHome, SPACE_ID_FILENAME), `${existing}\n`);
    expect(await getOrCreateSpaceId(dorkHome)).toBe(existing);
  });

  it.each([
    ['not a ULID', 'not-a-ulid'],
    ['an install-id-shaped UUID', '11111111-2222-3333-4444-555555555555'],
    ['empty', ''],
  ])('reads %s as absent and never writes over it', async (_label, contents) => {
    const file = path.join(dorkHome, SPACE_ID_FILENAME);
    await fs.writeFile(file, contents);
    expect(await getOrCreateSpaceId(dorkHome)).toBeUndefined();
    expect(await fs.readFile(file, 'utf8')).toBe(contents);
  });

  it('reads an unreadable file as absent and never writes over it', async () => {
    // A directory where the file should be: every read fails with EISDIR.
    await fs.mkdir(path.join(dorkHome, SPACE_ID_FILENAME));
    expect(await getOrCreateSpaceId(dorkHome)).toBeUndefined();
    expect((await fs.stat(path.join(dorkHome, SPACE_ID_FILENAME))).isDirectory()).toBe(true);
  });

  it('reads as absent, without throwing, when the id cannot be saved', async () => {
    const blocked = path.join(dorkHome, 'a-file');
    await fs.writeFile(blocked, 'x');
    // dorkHome is a file, so neither mkdir nor the write can succeed.
    expect(await getOrCreateSpaceId(blocked)).toBeUndefined();
  });

  it('falls back to an exclusive create on a filesystem with no hard links', async () => {
    const link = vi
      .spyOn(fs, 'link')
      .mockRejectedValue(Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }));
    const id = await getOrCreateSpaceId(dorkHome);
    expect(link).toHaveBeenCalled();
    expect(id).toMatch(ULID);
    expect(await getOrCreateSpaceId(dorkHome)).toBe(id);
    expect(await fs.readdir(dorkHome)).toEqual([SPACE_ID_FILENAME]);
  });

  it('never reads or reuses the install id', async () => {
    const installId = '11111111-2222-3333-4444-555555555555';
    await fs.writeFile(path.join(dorkHome, INSTANCE_ID_FILENAME), installId);
    const id = await getOrCreateSpaceId(dorkHome);
    expect(id).toMatch(ULID);
    expect(id).not.toBe(installId);
    expect(await fs.readFile(path.join(dorkHome, INSTANCE_ID_FILENAME), 'utf8')).toBe(installId);
  });
});
