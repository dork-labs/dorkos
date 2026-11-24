/**
 * Shared setup for the canonical-writer suites: everything the original file declared or
 * registered outside its tests.
 */
import { mkdtemp, writeFile, realpath, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { CanonicalFileWriteCoordinator } from '../../canonical-writer.js';

export const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function fixture(onResolve?: () => void, assertBoundary?: () => void) {
  const dir = await mkdtemp(join(tmpdir(), 'canonical-writer-'));
  dirs.push(dir);
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  await writeFile(a, 'a');
  await writeFile(b, 'b');
  let transaction = false;
  const coordinator = new CanonicalFileWriteCoordinator({
    assertOutsideTransaction() {
      if (transaction) throw new Error('transaction');
      assertBoundary?.();
    },
    async resolve(path) {
      const canonicalPath = await realpath(path);
      const info = await stat(canonicalPath, { bigint: true });
      if (!info.isFile()) throw new Error('not regular');
      onResolve?.();
      return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
    },
  });
  return {
    dir,
    a,
    b,
    coordinator,
    setTransaction(value: boolean) {
      transaction = value;
    },
  };
}

export function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function actualIdentity(path: string) {
  const canonicalPath = await realpath(path);
  const info = await stat(canonicalPath, { bigint: true });
  return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
}

export const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
