import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PACKAGE_SIZE_LIMITS,
  PackageTooLargeError,
  measurePackageTree,
  type PackageSizeLimits,
} from '../package-size.js';

let root: string;
const small: PackageSizeLimits = { maxTotalBytes: 1000, maxEntries: 5, maxFileBytes: 400 };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'package-size-'));
  await mkdir(path.join(root, 'skills', 'a'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('measurePackageTree', () => {
  // Purpose: a tree within every limit is measured, links not counted.
  it('counts files and bytes within the limits, ignoring links', async () => {
    await writeFile(path.join(root, 'skills', 'a', 'SKILL.md'), 'x'.repeat(100));
    await writeFile(path.join(root, 'README.md'), 'x'.repeat(50));
    await symlink(path.join(root, 'README.md'), path.join(root, 'link.md'));
    // skills, skills/a, SKILL.md, README.md: two folders and two files.
    expect(await measurePackageTree(root, small)).toEqual({ entries: 4, bytes: 150 });
  });

  // Purpose: the install drops every .git (DOR-2326), so a local agent that
  // is its author's own repository is measured as its files alone, while a
  // clone's own measure still counts them.
  it('leaves out .git in any case unless asked to count it', async () => {
    for (const dir of ['.git', path.join('skills', '.GIT')]) {
      await mkdir(path.join(root, dir, 'objects'), { recursive: true });
      for (let i = 0; i < 6; i++)
        await writeFile(path.join(root, dir, 'objects', `o${i}`), 'x'.repeat(300));
    }
    await writeFile(path.join(root, '.gitignore'), 'x');
    // skills, skills/a, .gitignore.
    expect(await measurePackageTree(root, small)).toEqual({ entries: 3, bytes: 1 });
    await expect(measurePackageTree(root, small, { countGit: true })).rejects.toBeInstanceOf(
      PackageTooLargeError
    );
  });

  // Purpose: each limit refuses on its own, naming what was too large.
  it('refuses one file over the per-file limit, by name', async () => {
    await writeFile(path.join(root, 'skills', 'a', 'big.bin'), 'x'.repeat(401));
    await expect(measurePackageTree(root, small)).rejects.toThrow(
      'skills/a/big.bin is larger than 1 KB, which is more than DorkOS installs from one file.'
    );
  });

  it('refuses a tree over the total limit', async () => {
    for (let i = 0; i < 3; i++) await writeFile(path.join(root, `f${i}`), 'x'.repeat(400));
    const error = await measurePackageTree(root, small).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PackageTooLargeError);
    expect((error as PackageTooLargeError).limit).toBe('total');
  });

  it('refuses a tree with too many files', async () => {
    for (let i = 0; i < 6; i++) await writeFile(path.join(root, `f${i}`), '');
    await expect(measurePackageTree(root, small)).rejects.toThrow(
      'The package has more than 5 files and folders, which is more than DorkOS installs.'
    );
  });

  // Purpose: folders count, so a tree of empty folders is refused too.
  it('refuses a tree of empty folders', async () => {
    for (let i = 0; i < 6; i++) await mkdir(path.join(root, `d${i}`));
    await expect(measurePackageTree(root, small)).rejects.toThrow(/more than 5 files and folders/);
  });

  // Purpose: a local checkout with its libraries installed is told how much
  // of it is node_modules.
  it('says how much of an oversized tree is node_modules', async () => {
    await rm(path.join(root, 'skills'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'lib'), { recursive: true });
    for (let i = 0; i < 4; i++)
      await writeFile(path.join(root, 'node_modules', 'lib', `f${i}`), '');
    await expect(measurePackageTree(root, small)).rejects.toThrow(
      'The package has more than 5 files and folders, of which 6 are in node_modules (a local source is copied with its node_modules), which is more than DorkOS installs.'
    );
  });

  // Purpose: the real limits are measured by size on record, not by reading,
  // so a huge sparse file is refused at once.
  it('refuses a huge file by its size without reading it', async () => {
    const file = path.join(root, 'huge.bin');
    await writeFile(file, '');
    await truncate(file, PACKAGE_SIZE_LIMITS.maxFileBytes + 1);
    const started = Date.now();
    await expect(measurePackageTree(root)).rejects.toThrow(/huge\.bin is larger than 50 MB/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // Purpose: the limits keep generous headroom over real packages (largest
  // seen: ~12.5 MB total, ~980 files and folders, one 3.4 MB file).
  it('keeps at least 10x headroom over real packages', () => {
    expect(PACKAGE_SIZE_LIMITS.maxTotalBytes).toBeGreaterThanOrEqual(10 * 12.5 * 1024 * 1024);
    expect(PACKAGE_SIZE_LIMITS.maxEntries).toBeGreaterThanOrEqual(10 * 979);
    expect(PACKAGE_SIZE_LIMITS.maxFileBytes).toBeGreaterThanOrEqual(10 * 3.4 * 1024 * 1024);
  });
});
