import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownFixtureCustody } from './fixture-custody.js';

afterEach(() => vi.useRealTimers());
it('a post-finish original operation remains pending and HELD until its actual settlement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const custody = ownFixtureCustody(),
    original = deferred<void>();
  expect(await custody.finish(10)).toMatchObject({ observed: true });
  const operation = custody.operation('receipt:write', () => original.promise, 10);
  const refusal = expect(operation).rejects.toThrow('FIXTURE_OPERATION_EXPIRED');
  await vi.advanceTimersByTimeAsync(10);
  await refusal;
  expect(custody.snapshot()).toMatchObject({ observed: false, held: true, pending: true });
  const finishing = custody.finish(10);
  await vi.advanceTimersByTimeAsync(10);
  expect(await finishing).toMatchObject({ observed: false, held: true, pending: true });
  original.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(custody.snapshot()).toMatchObject({ observed: false, held: true, pending: false });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('a late original attachment is closed once after HELD classification, and its unresolved close never authorizes deletion', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const custody = ownFixtureCustody(),
    acquisition = deferred<object>(),
    close = deferred<void>();
  const original = {},
    closeOriginal = vi.fn(() => close.promise);
  const wait = custody.acquire('native-session', () => acquisition.promise, closeOriginal, 10);
  const refused = expect(wait).rejects.toThrow('FIXTURE_ACQUISITION_EXPIRED');
  await vi.advanceTimersByTimeAsync(10);
  await refused;
  const finishing = custody.finish(10);
  await vi.advanceTimersByTimeAsync(10);
  expect(await finishing).toMatchObject({ observed: false, held: true, pending: true });
  acquisition.resolve(original);
  await acquisition.promise;
  await vi.advanceTimersByTimeAsync(0);
  expect(closeOriginal).toHaveBeenCalledExactlyOnceWith(original);
  expect(custody.snapshot()).toMatchObject({ observed: false, held: true, pending: true });
  close.resolve();
  await close.promise;
  await vi.advanceTimersByTimeAsync(0);
  expect(custody.snapshot()).toMatchObject({ observed: false, held: true, pending: false });
  expect(closeOriginal).toHaveBeenCalledTimes(1);
});

it('a rejected original close still attempts its sibling and preserves a real fixture root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fixture-held-')),
    marker = join(directory, 'original');
  await writeFile(marker, 'retained');
  const custody = ownFixtureCustody(),
    sibling = vi.fn(async () => {});
  custody.adopt('rejected-native', {}, async () => {
    throw new Error('ORIGINAL_NATIVE_CLOSE_FAILED');
  });
  custody.adopt('sibling-native', {}, sibling);
  try {
    const cleanup = await custody.finish(10);
    if (cleanup.observed) await rm(directory, { recursive: true, force: true });
    expect(cleanup).toMatchObject({ observed: false, held: true, pending: false });
    expect(cleanup.observations).toContainEqual({ label: 'rejected-native', state: 'failed' });
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(await readFile(marker, 'utf8')).toBe('retained');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('fulfilled uncertain generation shutdown remains HELD and cannot satisfy cleanup', async () => {
  const custody = ownFixtureCustody();
  custody.adopt(
    'engine-generations',
    {},
    async () => [{ browserId: 'actual-generation', cleanup: 'unverified' }],
    (value) =>
      Array.isArray(value) && value.length > 0 && value.every((item) => item.cleanup === 'observed')
  );
  expect(await custody.finish(10)).toMatchObject({ observed: false, held: true, pending: false });
});
