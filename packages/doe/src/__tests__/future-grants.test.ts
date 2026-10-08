import { expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanonicalPaths, canonicalPath } from '../resources/paths.js';
it('preserves future grants and does not let an unrelated absent root mask a later grant', async () => {
  const raw = await mkdtemp(path.join(tmpdir(), 'doe-future-'));
  const root = await canonicalPath(raw, raw);
  try {
    const future = path.join(root, 'future');
    const paths = new CanonicalPaths(
      { readRoots: [path.join(root, 'absent'), future], writeRoots: [future] },
      root
    );
    expect(await paths.resolve(path.join(future, 'new.txt'), 'write')).toBe(
      path.join(future, 'new.txt')
    );
    expect(await paths.resolve(path.join(future, 'new.txt'), 'read')).toBe(
      path.join(future, 'new.txt')
    );
    await mkdir(path.join(root, 'outside'));
    await symlink(path.join(root, 'outside'), future);
    await expect(paths.resolve(path.join(root, 'other.txt'), 'read')).rejects.toThrow('outside');
  } finally {
    await rm(raw, { recursive: true, force: true });
  }
});
