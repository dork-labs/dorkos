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
const small: PackageSizeLimits = { maxTotalBytes: 1000, maxFiles: 5, maxFileBytes: 400 };

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
    expect(await measurePackageTree(root, small)).toEqual({ files: 2, bytes: 150 });
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
      'The package has more than 5 files, which is more than DorkOS installs.'
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
  // seen: ~12.5 MB total, ~700 files, one 3.4 MB file).
  it('keeps at least 10x headroom over real packages', () => {
    expect(PACKAGE_SIZE_LIMITS.maxTotalBytes).toBeGreaterThanOrEqual(10 * 12.5 * 1024 * 1024);
    expect(PACKAGE_SIZE_LIMITS.maxFiles).toBeGreaterThanOrEqual(10 * 707);
    expect(PACKAGE_SIZE_LIMITS.maxFileBytes).toBeGreaterThanOrEqual(10 * 3.4 * 1024 * 1024);
  });
});
