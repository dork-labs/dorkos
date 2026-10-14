import { afterAll } from 'vitest';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A compiler-cache lease carries no Room, runtime, fixture, or native authority. */
export interface OriginalNativeTransformCacheLease {
  root: string;
  closed(): void;
  failed(cause: unknown): void;
}

// Vitest isolates each whole test file. This module is shared only by that
// file's registration helpers; every case still forks its own original child.
let rootPending: Promise<string> | undefined;
let identity: { dev: number; ino: number } | undefined;
let acquisitions = 0;
let retiring = false;
let failed = false;
let first: unknown;
const active = new Set<object>();

async function assertOwnedRoot(root: string): Promise<void> {
  const current = await lstat(root);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    (current.mode & 0o777) !== 0o700 ||
    (process.getuid && current.uid !== process.getuid()) ||
    !identity ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new Error('Original native compiler cache ownership changed');
  }
}

/** Acquire compiler artifacts only; the caller keeps its private child environment. */
export async function acquireOriginalNativeTransformCache(): Promise<OriginalNativeTransformCacheLease> {
  if (retiring) throw new Error('Original native compiler cache is retiring');
  acquisitions++;
  try {
    const root = await (rootPending ??= (async () => {
      const created = await mkdtemp(path.join(tmpdir(), 'original-room-transform-cache-'));
      const current = await lstat(created);
      identity = { dev: current.dev, ino: current.ino };
      await assertOwnedRoot(created);
      return created;
    })());
    await assertOwnedRoot(root);
    if (retiring) throw new Error('Original native compiler cache acquisition was retired');
    const token = {};
    active.add(token);
    return {
      root,
      closed() {
        if (!active.delete(token)) throw new Error('Original native compiler lease closed twice');
      },
      failed(cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
        // Keep this lease and its cache on every failed or unresolved child.
      },
    };
  } finally {
    acquisitions--;
  }
}

afterAll(async () => {
  retiring = true;
  if (!rootPending) return;
  const root = await rootPending;
  await assertOwnedRoot(root);
  if (failed) throw first;
  if (acquisitions !== 0 || active.size !== 0) {
    throw new Error('Original native compiler cache retained for unresolved children');
  }
  // Original helpers release only after actual exit, both pipe EOFs, the
  // original drain deadline, and successful private fixture-root cleanup.
  await rm(root, { recursive: true, force: false });
});
