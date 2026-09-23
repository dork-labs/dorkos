import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directorySize } from '../directory-size.js';

describe('directorySize', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'directory-size-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('sums the regular files of the whole tree', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'one'), '123');
    await writeFile(join(root, 'a', 'b', 'two'), '4567');

    expect(await directorySize(root)).toBe(7);
  });

  it('never follows a symlink, so a loop or a link to / cannot hang it', async () => {
    // Purpose: git keeps symlinks in a checkout. Following `a -> .` or
    // `root -> /` walked for ever, and the sweep that measures a removed entry
    // never settled, which hung every later sweep and `dorkos cache prune`.
    await writeFile(join(root, 'file'), '12');
    await symlink('.', join(root, 'a'));
    await symlink('.', join(root, 'b'));
    await symlink('/', join(root, 'root'));
    await symlink('file', join(root, 'file-link'));

    expect(await directorySize(root)).toBe(2);
  });

  it('is 0 for a directory that does not exist', async () => {
    expect(await directorySize(join(root, 'missing'))).toBe(0);
  });
});
