/**
 * Tests for {@link stagePackageContents}.
 *
 * The helper is the single symlink-containment chokepoint every install flow
 * routes through (DOR-279). These cases assert that regular files and nested
 * directories copy faithfully, while both absolute (`/etc/...`) and relative
 * (`../../escape`) symlinks are stripped — never surviving into the staged tree
 * as a followable link — and that each stripped link is logged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { stagePackageContents } from '../stage-package.js';

/** Construct a logger whose methods are spies. */
function buildLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Returns true if `target` exists as a symlink (does not follow it). */
async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Returns true if `target` exists on disk (following symlinks). */
async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

describe('stagePackageContents', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('copies regular files and nested directories faithfully', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'stage-src-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'stage-dest-'));
    cleanupDirs.push(src, dest);
    await rm(dest, { recursive: true, force: true }); // let cp create it

    await writeFile(path.join(src, 'top.txt'), 'top', 'utf-8');
    await mkdir(path.join(src, 'nested', 'deep'), { recursive: true });
    await writeFile(path.join(src, 'nested', 'deep', 'leaf.txt'), 'leaf', 'utf-8');

    await stagePackageContents(src, dest, buildLogger());

    expect(await readFile(path.join(dest, 'top.txt'), 'utf-8')).toBe('top');
    expect(await readFile(path.join(dest, 'nested', 'deep', 'leaf.txt'), 'utf-8')).toBe('leaf');
  });

  it('strips an absolute symlink (/etc/passwd) and never leaves a followable escape', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'stage-src-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'stage-dest-'));
    cleanupDirs.push(src, dest);
    await rm(dest, { recursive: true, force: true });

    await writeFile(path.join(src, 'real.txt'), 'ok', 'utf-8');
    await symlink('/etc/passwd', path.join(src, 'data'));
    const logger = buildLogger();

    await stagePackageContents(src, dest, logger);

    // The link was stripped: it exists neither as a symlink nor as any entry.
    expect(await exists(path.join(dest, 'data'))).toBe(false);
    expect(await isSymlink(path.join(dest, 'data'))).toBe(false);
    // Real content still copied.
    expect(await readFile(path.join(dest, 'real.txt'), 'utf-8')).toBe('ok');
    // The strip was logged.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Stripped symlink'));
  });

  it('strips a relative escaping symlink (../../escape) and its subtree', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'stage-src-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'stage-dest-'));
    cleanupDirs.push(src, dest);
    await rm(dest, { recursive: true, force: true });

    await mkdir(path.join(src, 'sub'), { recursive: true });
    await writeFile(path.join(src, 'sub', 'keep.txt'), 'keep', 'utf-8');
    // A symlinked directory pointing outside the package root.
    await symlink('../../other-project', path.join(src, 'sub', 'out'), 'dir');

    await stagePackageContents(src, dest, buildLogger());

    expect(await readFile(path.join(dest, 'sub', 'keep.txt'), 'utf-8')).toBe('keep');
    // The escaping symlinked directory is gone — not copied as a link, and its
    // (external) target is not followed or materialized.
    expect(await exists(path.join(dest, 'sub', 'out'))).toBe(false);
    expect(await isSymlink(path.join(dest, 'sub', 'out'))).toBe(false);
  });

  it('strips an internal (within-root) symlink too — containment is unconditional', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'stage-src-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'stage-dest-'));
    cleanupDirs.push(src, dest);
    await rm(dest, { recursive: true, force: true });

    await writeFile(path.join(src, 'target.txt'), 'target', 'utf-8');
    await symlink('target.txt', path.join(src, 'alias.txt'));

    await stagePackageContents(src, dest, buildLogger());

    expect(await readFile(path.join(dest, 'target.txt'), 'utf-8')).toBe('target');
    expect(await isSymlink(path.join(dest, 'alias.txt'))).toBe(false);
    expect(await exists(path.join(dest, 'alias.txt'))).toBe(false);
  });
});
