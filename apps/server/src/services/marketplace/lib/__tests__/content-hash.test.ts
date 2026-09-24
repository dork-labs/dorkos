/**
 * Tests for the package content hash (DOR-2306): what it binds, what it skips,
 * and the cache that re-hashes only when a tree was written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hashTree,
  isRuntimeStatePath,
  shippedContentHash,
  TreeHashCache,
  TreeUnhashableError,
  walkTree,
} from '../content-hash.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'content-hash-'));
  await mkdir(path.join(root, 'hooks'), { recursive: true });
  await writeFile(path.join(root, 'hooks', 'fmt.sh'), 'echo good\n');
  await writeFile(path.join(root, 'README.md'), '# fmt\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('hashTree', () => {
  it('changes when one file changes, even to the same size (the exploit)', async () => {
    // Purpose: approval binds bytes. A hostile script of the same length, or
    // any length, must not hash like the approved one.
    const before = await hashTree(root);
    await writeFile(path.join(root, 'hooks', 'fmt.sh'), 'curl evil\n');

    expect(await hashTree(root)).not.toBe(before);
  });

  it('changes when a file becomes executable, is added, or is removed', async () => {
    const base = await hashTree(root);
    await chmod(path.join(root, 'README.md'), 0o755);
    const executable = await hashTree(root);
    expect(executable).not.toBe(base);
    await writeFile(path.join(root, 'extra'), 'x');
    const added = await hashTree(root);
    expect(added).not.toBe(executable);
    await rm(path.join(root, 'extra'));
    expect(await hashTree(root)).toBe(executable);
  });

  it('is the same for the same bytes in another directory', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'content-hash-copy-'));
    try {
      await mkdir(path.join(other, 'hooks'));
      await writeFile(path.join(other, 'hooks', 'fmt.sh'), 'echo good\n');
      await writeFile(path.join(other, 'README.md'), '# fmt\n');
      expect(await hashTree(other)).toBe(await hashTree(root));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('skips DorkOS runtime state, and nothing else by default', async () => {
    // Purpose: saving settings or secrets must not look like a changed package.
    const base = await hashTree(root, { skip: isRuntimeStatePath });
    await mkdir(path.join(root, '.dork', 'data'), { recursive: true });
    await writeFile(path.join(root, '.dork', 'data', 'settings.json'), '{}');
    await writeFile(path.join(root, '.dork', 'secrets.json'), '{}');
    await writeFile(path.join(root, '.dork', 'install-metadata.json'), '{}');
    expect(await hashTree(root, { skip: isRuntimeStatePath })).toBe(base);

    await writeFile(path.join(root, '.dork', 'manifest.json'), '{}');
    expect(await hashTree(root, { skip: isRuntimeStatePath })).not.toBe(base);
  });

  it('records an in-tree link by its target, and refuses one that leaves the tree', async () => {
    await symlink('fmt.sh', path.join(root, 'hooks', 'alias'));
    await expect(hashTree(root)).resolves.toMatch(/^sha256:/);

    await symlink('/etc/hosts', path.join(root, 'hooks', 'escape'));
    await expect(hashTree(root)).rejects.toBeInstanceOf(TreeUnhashableError);
  });
});

describe('shippedContentHash', () => {
  it('ignores what the install writes itself: node_modules, the lockfile, .npmrc and links', async () => {
    // Purpose: a preview of the staged package and its installed copy must
    // hash the same when the package is the same.
    const staged = await shippedContentHash(root);
    await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'x', 'index.js'), '1');
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    await writeFile(path.join(root, '.npmrc'), 'x');
    await symlink('fmt.sh', path.join(root, 'hooks', 'alias'));

    expect(await shippedContentHash(root)).toBe(staged);
  });
});

describe('TreeHashCache', () => {
  it('re-hashes only when the tree was written, and sees a same-size rewrite with the old mtime', async () => {
    // Purpose: activation checks every turn, cheaply, and a hostile rewrite
    // that restores size and mtime still changes ctime, so it is caught.
    const cache = new TreeHashCache();
    const first = await cache.hash(root, 'k');
    expect(await cache.hash(root, 'k')).toBe(first);

    const file = path.join(root, 'hooks', 'fmt.sh');
    const { stat } = (await walkTree(root)).entries.find((e) => e.path === 'hooks/fmt.sh')!;
    await writeFile(file, 'echo evil\n');
    await utimes(file, stat.mtimeMs / 1000, stat.mtimeMs / 1000);

    expect(await cache.hash(root, 'k')).not.toBe(first);
  });
});
