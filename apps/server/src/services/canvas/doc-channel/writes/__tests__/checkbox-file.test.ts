import fs, { open } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readBoundedCheckboxFile, readOriginalCheckboxFileCloseFailure } from '../checkbox-file.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true });
});
async function source(bytes: Buffer) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'checkbox-chunks-')));
  directories.push(directory);
  const path = join(directory, 'tasks.md');
  await fs.writeFile(path, bytes);
  const info = await fs.stat(path, { bigint: true });
  return { path, expected: { device: String(info.dev), inode: String(info.ino) } };
}
function observeAcquiredReads() {
  const originalOpen = fs.open.bind(fs);
  let acquired: Awaited<ReturnType<typeof fs.open>> | undefined;
  let sizes: () => number[] = () => [];
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    acquired = handle;
    // Observe the genuine original method without replacing its read behavior.
    const reads = vi.spyOn(handle, 'read');
    sizes = () =>
      reads.mock.calls.map(([buffer]) => {
        if (!Buffer.isBuffer(buffer)) throw new Error('Expected original explicit-buffer read');
        return buffer.byteLength;
      });
    return handle;
  });
  return { sizes: () => sizes(), handle: () => acquired! };
}
function growAfterAcquiredStat(path: string, appended: Buffer) {
  let checks = 0;
  return () => {
    if (++checks === 3) appendFileSync(path, appended);
  };
}
it('reads exact tiny bytes with a tiny acquired-size buffer and closes the actual handle', async () => {
  const bytes = Buffer.from('- [ ] actual\r\n');
  const file = await source(bytes);
  const observed = observeAcquiredReads();
  expect(await readBoundedCheckboxFile(file.path, () => {}, file.expected)).toEqual(bytes);
  expect(observed.sizes().length).toBeGreaterThan(0);
  expect(Math.max(...observed.sizes())).toBe(bytes.length + 1);
  await expect(observed.handle().stat()).rejects.toMatchObject({ code: 'EBADF' });
});
it('retains all fresh bytes when the original inode grows after acquired stat', async () => {
  const file = await source(Buffer.from('a'));
  const appended = Buffer.alloc(128 * 1024 + 7, 120);
  const observed = observeAcquiredReads();
  expect(
    await readBoundedCheckboxFile(
      file.path,
      growAfterAcquiredStat(file.path, appended),
      file.expected
    )
  ).toEqual(Buffer.concat([Buffer.from('a'), appended]));
  expect(observed.sizes()[0]).toBe(2);
  expect(Math.max(...observed.sizes())).toBe(64 * 1024);
  await expect(observed.handle().stat()).rejects.toMatchObject({ code: 'EBADF' });
});
it.each([5 * 1024 * 1024, 5 * 1024 * 1024 + 1])(
  'retains the exact five-MiB ceiling and one-byte growth sentinel: %s',
  async (size) => {
    const file = await source(Buffer.from('a'));
    const appended = Buffer.alloc(size - 1, 120);
    const observed = observeAcquiredReads();
    const result = readBoundedCheckboxFile(
      file.path,
      growAfterAcquiredStat(file.path, appended),
      file.expected
    );
    if (size === 5 * 1024 * 1024) {
      expect((await result).equals(Buffer.concat([Buffer.from('a'), appended]))).toBe(true);
    } else {
      await expect(result).rejects.toThrow('Checkbox source is too large.');
    }
    expect(Math.max(...observed.sizes())).toBeLessThanOrEqual(64 * 1024);
    await expect(observed.handle().stat()).rejects.toMatchObject({ code: 'EBADF' });
  }
);
it('retains raw undefined boundary failure and closes the actual acquired handle', async () => {
  const file = await source(Buffer.from('a'));
  const observed = observeAcquiredReads();
  let checks = 0;
  let failed = false;
  let cause: unknown;
  try {
    await readBoundedCheckboxFile(
      file.path,
      () => {
        if (++checks === 3) throw undefined;
      },
      file.expected
    );
  } catch (error) {
    failed = true;
    cause = error;
  }
  expect(failed).toBe(true);
  expect(cause).toBeUndefined();
  await expect(observed.handle().stat()).rejects.toMatchObject({ code: 'EBADF' });
});

it.each([
  { label: 'raw undefined', cause: undefined },
  { label: 'read error', cause: new Error('original acquired read failure') },
])(
  'retains $label over a reported close failure while preserving separate close custody',
  async ({ cause }) => {
    const file = await source(Buffer.from('original'));
    const originalOpen = fs.open.bind(fs);
    const closeCause = new Error('original acquired close reporting failure');
    const boundary = () => {};
    let acquired: Awaited<ReturnType<typeof fs.open>> | undefined;
    let closes = 0;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      acquired = handle;
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          // Perform the real acquired-handle read before injecting its reported failure.
          await read(buffer, offset, length, position);
          throw cause;
        },
      });
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        closes++;
        await close();
        throw closeCause;
      });
      return handle;
    });
    await expect(readBoundedCheckboxFile(file.path, boundary, file.expected)).rejects.toBe(cause);
    expect(closes).toBe(1);
    expect(acquired).toBeDefined();
    if (!acquired) throw new Error('Original acquired file handle missing.');
    await expect(acquired.stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect(readOriginalCheckboxFileCloseFailure(boundary)).toEqual({ cause: closeCause });
  }
);
it('reports close failure when the original bounded read succeeded', async () => {
  const file = await source(Buffer.from('original'));
  const originalOpen = fs.open.bind(fs);
  const cause = new Error('original acquired close reporting failure');
  const boundary = () => {};
  let acquired: Awaited<ReturnType<typeof fs.open>> | undefined;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    acquired = handle;
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      throw cause;
    });
    return handle;
  });
  await expect(readBoundedCheckboxFile(file.path, boundary, file.expected)).rejects.toBe(cause);
  expect(acquired).toBeDefined();
  if (!acquired) throw new Error('Original acquired file handle missing.');
  await expect(acquired.stat()).rejects.toMatchObject({ code: 'EBADF' });
  expect(readOriginalCheckboxFileCloseFailure(boundary)).toEqual({ cause });
});
