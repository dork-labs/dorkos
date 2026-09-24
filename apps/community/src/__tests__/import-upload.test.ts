import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureServerTimeouts, REQUEST_TIMEOUT_MS } from '../http.js';
import { UploadSlots, assertTempSpace, sweepImportTempDirs } from '../imports/upload.js';

let scratch = '';
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = '';
});

describe('server timeouts', () => {
  // Purpose: Node cuts a request off after five minutes by default, which kills a 1 GiB
  // export upload part-way; the server must allow hours.
  it('lets a request take hours to arrive', () => {
    const server = createServer();
    expect(server.requestTimeout).toBe(300_000);
    configureServerTimeouts(server);
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });
});

describe('upload slots and space', () => {
  // Purpose: the replica-wide cap refuses one more upload and frees a slot exactly once.
  it('refuses past the limit and frees each slot once', () => {
    const slots = new UploadSlots(1);
    const release = slots.take();
    expect(() => slots.take()).toThrow(/Too many exports/);
    release();
    release();
    const again = slots.take();
    expect(() => slots.take()).toThrow();
    again();
  });

  // Purpose: an upload needs room for twice its size (its received copy and storage's copy).
  it('needs twice the declared size free', async () => {
    await expect(assertTempSpace(100, async () => 199)).rejects.toThrow(/no room/);
    await expect(assertTempSpace(100, async () => 200)).resolves.toBeUndefined();
  });
});

describe('sweepImportTempDirs', () => {
  // Purpose: a crash leaves a received export on disk; the startup sweep removes only import
  // folders nobody has written to recently, and leaves every other folder alone.
  it('removes stale import folders and keeps fresh and foreign ones', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'sweep-test-'));
    const old = new Date(Date.now() - 60 * 60_000);
    for (const name of ['community-import-stale', 'community-import-file-stale', 'other-old']) {
      await mkdir(join(scratch, name));
      await writeFile(join(scratch, name, 'f'), 'x');
      await utimes(join(scratch, name, 'f'), old, old);
      await utimes(join(scratch, name), old, old);
    }
    await mkdir(join(scratch, 'community-import-live'));
    await writeFile(join(scratch, 'community-import-live', 'f'), 'x');
    expect(await sweepImportTempDirs(10 * 60_000, scratch)).toBe(2);
    expect((await readdir(scratch)).sort()).toEqual(['community-import-live', 'other-old']);
  });
});
