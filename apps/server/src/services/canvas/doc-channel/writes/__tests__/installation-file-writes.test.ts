import { initBoundary } from '../../../../../lib/boundary.js';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CanonicalFileIdentityChangedError } from '../canonical-writer.js';
import { fixture } from './checkbox-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const h = await fixture();
  await initBoundary(h.dir);
  cleanups.push(h.cleanup);
  const owner = h.http.fileWrites;
  cleanups.push(() => owner.stop());
  return { h, owner };
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('refuses a second ordinary save with the old baseline rather than losing the first save', async () => {
  const { h, owner } = await setup();
  const before = await fs.readFile(h.path, 'utf8');
  const atRename = latch(),
    held = latch(),
    secondResolved = latch();
  const rename = fs.rename,
    stat = fs.stat;
  let replacing = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === h.path) {
      replacing = true;
      atRename.release();
      await held.promise;
    }
    return rename(from, to);
  });
  vi.spyOn(fs, 'stat').mockImplementation(((...args: Parameters<typeof fs.stat>) => {
    const result = stat(...args);
    if (replacing && args[0] === h.path) void result.then(() => secondResolved.release());
    return result;
  }) as typeof fs.stat);
  const first = owner.save({ cwd: h.dir, path: h.path, content: 'first', expectedContent: before });
  await atRename.promise;
  const second = owner.save({
    cwd: h.dir,
    path: h.path,
    content: 'second',
    expectedContent: before,
  });
  // Observe the actual second identity probe before releasing the first rename.
  await secondResolved.promise;
  held.release();
  expect((await first).status).toBe(200);
  await expect(second).rejects.toBeInstanceOf(CanonicalFileIdentityChangedError);
  expect(await fs.readFile(h.path, 'utf8')).toBe('first');
});

it('ordinary saves share the checkbox replacement lease through a hardlink alias', async () => {
  const { h, owner } = await setup();
  const replaced = latch(),
    held = latch();
  const checkbox = owner.createCheckboxService(h.store, h.authority, h.delivery, {
    checkpoint: async (point) => {
      if (point === 'replaced') {
        replaced.release();
        await held.promise;
      }
    },
  });
  const before = await fs.readFile(h.path, 'utf8');
  const toggle = checkbox.toggle(await h.request(), h.actor);
  await replaced.promise;
  const alias = join(h.dir, 'ordinary-alias.md');
  await fs.link(h.path, alias);
  const save = owner.save({
    cwd: h.dir,
    path: alias,
    content: 'stale editor',
    expectedContent: before,
  });
  held.release();
  const receipt = await toggle;
  const outcome = await save;
  expect(receipt.status).toBe('changed');
  expect(outcome.status).toBe(409);
  expect(h.row().status).toBe('committed');
  expect((await fs.readFile(h.path, 'utf8')).startsWith('\ufeff- [x]')).toBe(true);
  expect(await fs.readFile(alias, 'utf8')).toBe(await fs.readFile(h.path, 'utf8'));
});

it('ordinary saves preserve an unresolved checkbox fence instead of overwriting its physical effect', async () => {
  const { h, owner } = await setup();
  const checkbox = owner.createCheckboxService(h.store, h.authority, h.delivery, {
    checkpoint: async (point) => {
      if (point === 'replaced') throw new Error('interrupted completion');
    },
  });
  await expect(checkbox.toggle(await h.request(), h.actor)).rejects.toThrow(
    'interrupted completion'
  );
  const preserved = await fs.readFile(h.path, 'utf8');
  await expect(owner.save({ cwd: h.dir, path: h.path, content: 'overwrite' })).rejects.toThrow();
  expect(await fs.readFile(h.path, 'utf8')).toBe(preserved);
  expect(h.row().status).not.toBe('committed');
});

it('stop rejects new saves and drains an admitted ordinary replacement', async () => {
  const { h, owner } = await setup();
  const atRename = latch(),
    held = latch();
  const rename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === h.path) {
      atRename.release();
      await held.promise;
    }
    return rename(from, to);
  });
  const save = owner.save({ cwd: h.dir, path: h.path, content: 'admitted' });
  await atRename.promise;
  let stopped = false;
  const stopping = owner.stop().then(() => {
    stopped = true;
  });
  try {
    await expect(owner.save({ cwd: h.dir, path: h.path, content: 'late' })).rejects.toThrow(
      'stopped'
    );
    expect(stopped).toBe(false);
  } finally {
    held.release();
    await Promise.all([save, stopping]);
  }
  expect(await fs.readFile(h.path, 'utf8')).toBe('admitted');
  expect(stopped).toBe(true);
});

it('refuses a swapped temporary path and preserves the foreign replacement', async () => {
  const { h, owner } = await setup();
  const original = await fs.readFile(h.path, 'utf8');
  const sentinel = join(h.dir, 'foreign.md');
  await fs.writeFile(sentinel, 'foreign bytes');
  const realpath = fs.realpath;
  let temporary: string | undefined;
  vi.spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
    const candidate = args[0];
    if (
      !temporary &&
      typeof candidate === 'string' &&
      candidate.startsWith(`${h.path}.`) &&
      candidate.endsWith('.tmp')
    ) {
      temporary = candidate;
      await fs.unlink(candidate);
      await fs.symlink(sentinel, candidate);
    }
    return realpath(...args);
  }) as typeof fs.realpath);
  await expect(
    owner.save({ cwd: h.dir, path: h.path, content: 'new bytes' })
  ).rejects.toBeInstanceOf(CanonicalFileIdentityChangedError);
  expect(temporary).toBeDefined();
  expect(await fs.readFile(h.path, 'utf8')).toBe(original);
  expect(await fs.readFile(sentinel, 'utf8')).toBe('foreign bytes');
  expect(await fs.readlink(temporary!)).toBe(sentinel);
});
