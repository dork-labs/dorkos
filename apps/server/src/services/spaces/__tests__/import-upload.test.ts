import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureServerTimeouts, REQUEST_TIMEOUT_MS } from '../http.js';
import { UploadSlots, assertTempSpace, sweepImportTempDirs } from '../imports/upload.js';
import { isRetryableProviderError } from '../storage/blob-store.js';

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
  // Purpose: the replica-wide cap refuses one more upload and frees each slot exactly once,
  // along with the temporary space it reserved.
  it('refuses past the limit and frees each slot and its space once', () => {
    const slots = new UploadSlots(1);
    const release = slots.take(100);
    expect(slots.reservedBytes).toBe(200);
    expect(() => slots.take(1)).toThrow(/Too many exports/);
    release();
    release();
    expect(slots.reservedBytes).toBe(0);
    const again = slots.take(5);
    expect(() => slots.take(5)).toThrow();
    again();
  });

  // Purpose: an upload needs room for twice its size beyond what uploads already in flight
  // may still write.
  it('needs twice the declared size free, after other uploads', async () => {
    await expect(assertTempSpace(100, async () => 199)).rejects.toThrow(/no room/);
    await expect(assertTempSpace(100, async () => 200)).resolves.toBeUndefined();
    await expect(assertTempSpace(100, async () => 300, 101)).rejects.toThrow(/no room/);
    await expect(assertTempSpace(100, async () => 300, 100)).resolves.toBeUndefined();
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

describe('isRetryableProviderError', () => {
  // Purpose: S3 failures arrive without a Node error code; a server fault, throttling, or a
  // timeout must read as "try again", and a client error must not.
  it('reads the AWS SDK marks for a retryable failure', () => {
    const aws = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);
    expect(isRetryableProviderError(aws({ $fault: 'server' }))).toBe(true);
    expect(isRetryableProviderError(aws({ $metadata: { httpStatusCode: 503 } }))).toBe(true);
    expect(isRetryableProviderError(aws({ $metadata: { httpStatusCode: 429 } }))).toBe(true);
    expect(isRetryableProviderError(aws({ $retryable: {} }))).toBe(true);
    expect(isRetryableProviderError(aws({ name: 'SlowDown' }))).toBe(true);
    expect(isRetryableProviderError(aws({ name: 'TimeoutError' }))).toBe(true);
    expect(
      isRetryableProviderError(aws({ $fault: 'client', $metadata: { httpStatusCode: 403 } }))
    ).toBe(false);
    expect(isRetryableProviderError(new Error('plain'))).toBe(false);
  });
});
