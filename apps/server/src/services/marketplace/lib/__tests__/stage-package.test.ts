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

  it("drops the package's own root .npmrc, and says so", async () => {
    // Not a preference file: it lands where npm runs, and `global=true` in it
    // turns the install into a global install of the package itself with bin
    // shims. Nothing a package needs at runtime lives in it (DOR-1341).
    const source = await mkdtemp(path.join(tmpdir(), 'stage-npmrc-src-'));
    const dest = path.join(await mkdtemp(path.join(tmpdir(), 'stage-npmrc-dst-')), 'staged');
    cleanupDirs.push(source, path.dirname(dest));
    await writeFile(path.join(source, '.npmrc'), 'global=true\n', 'utf-8');
    await writeFile(path.join(source, 'README.md'), 'hello', 'utf-8');
    const logger = buildLogger();

    await stagePackageContents(source, dest, logger);

    expect(await exists(path.join(dest, '.npmrc'))).toBe(false);
    expect(await exists(path.join(dest, 'README.md'))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('.npmrc'));
  });

  it('leaves a nested .npmrc alone — only the root one is npm config', async () => {
    // A copy deeper in the tree is inert content: npm reads the project config
    // from the directory it runs in, which is the package root.
    const source = await mkdtemp(path.join(tmpdir(), 'stage-nested-npmrc-src-'));
    const dest = path.join(await mkdtemp(path.join(tmpdir(), 'stage-nested-npmrc-dst-')), 'staged');
    cleanupDirs.push(source, path.dirname(dest));
    await mkdir(path.join(source, 'templates'), { recursive: true });
    await writeFile(path.join(source, 'templates', '.npmrc'), 'registry=https://x.test\n', 'utf-8');

    await stagePackageContents(source, dest, buildLogger());

    expect(await exists(path.join(dest, 'templates', '.npmrc'))).toBe(true);
  });

  // Purpose (DOR-2245): paths DorkOS keeps for the person or the installer never
  // reach the staged tree, so no package can ship over a person's data or the
  // installer's records, whatever validation said.
  it('strips every reserved path, logs each once, and keeps near-misses', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'stage-src-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'stage-dest-'));
    cleanupDirs.push(src, dest);
    await rm(dest, { recursive: true, force: true });

    const reserved = [
      '.dork/data/seed.json',
      '.dork/secrets.json',
      '.dork/install-metadata.json',
      '.dork/installed-files.json',
      '.dork/uninstalled-agent.json',
      'skills/x/SKILL.md.dork-old',
      'config/a.json.dork-new.2',
    ];
    const kept = [
      '.dork/database.json',
      'x.dork-older',
      'skills/x/SKILL.md',
      '.dork/manifest.json',
    ];
    for (const rel of [...reserved, ...kept]) {
      await mkdir(path.dirname(path.join(src, rel)), { recursive: true });
      await writeFile(path.join(src, rel), rel, 'utf-8');
    }
    const logger = buildLogger();

    await stagePackageContents(src, dest, logger);

    for (const rel of reserved) expect(await exists(path.join(dest, rel))).toBe(false);
    expect(await exists(path.join(dest, '.dork', 'data'))).toBe(false);
    for (const rel of kept) expect(await readFile(path.join(dest, rel), 'utf-8')).toBe(rel);
    const warned = vi
      .mocked(logger.warn)
      .mock.calls.map((c) => String(c[0]))
      .filter((m) => m.includes('reserved'));
    // `.dork/data` is dropped as one subtree, so six files plus one directory.
    expect(warned).toHaveLength(reserved.length);
  });

  // Purpose (code review 2): APFS and NTFS ignore case, so `.dork/Secrets.json`
  // IS the person's secrets file there; a case variant must be stripped too.
  it('strips case variants of reserved paths', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'stage-src-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'stage-dest-'));
    cleanupDirs.push(src, dest);
    await rm(dest, { recursive: true, force: true });
    for (const rel of ['.dork/Secrets.json', '.dork/Data/seed.json', 'a.md.DORK-OLD']) {
      await mkdir(path.dirname(path.join(src, rel)), { recursive: true });
      await writeFile(path.join(src, rel), rel, 'utf-8');
    }

    await stagePackageContents(src, dest, buildLogger());

    expect(await exists(path.join(dest, '.dork', 'Secrets.json'))).toBe(false);
    expect(await exists(path.join(dest, '.dork', 'Data'))).toBe(false);
    expect(await exists(path.join(dest, 'a.md.DORK-OLD'))).toBe(false);
  });

  it('drops every .git, folder or file, at any depth, and logs it (DOR-2326)', async () => {
    // Purpose: git obeys the settings and hooks in a .git; a package is its
    // files, so a local agent that is its author's own repository installs
    // without them, and nothing else is lost.
    const src = await mkdtemp(path.join(tmpdir(), 'stage-src-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'stage-dest-'));
    cleanupDirs.push(src, dest);
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.join(src, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(src, '.git', 'config'), '[core]\n\tfsmonitor = x\n');
    await mkdir(path.join(src, 'vendor', 'lib'), { recursive: true });
    await writeFile(path.join(src, 'vendor', 'lib', '.git'), 'gitdir: ../../../x\n');
    await writeFile(path.join(src, 'vendor', 'lib', 'index.js'), 'ok');
    await writeFile(path.join(src, '.gitignore'), 'node_modules\n');
    const logger = buildLogger();

    await stagePackageContents(src, dest, logger);

    expect(await exists(path.join(dest, '.git'))).toBe(false);
    expect(await exists(path.join(dest, 'vendor', 'lib', '.git'))).toBe(false);
    expect(await readFile(path.join(dest, 'vendor', 'lib', 'index.js'), 'utf-8')).toBe('ok');
    expect(await exists(path.join(dest, '.gitignore'))).toBe(true);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes('Stripped .git '))).toBe(true);
    expect(warned.some((m) => m.includes('Stripped vendor/lib/.git '))).toBe(true);
  });

  it('drops .GIT in any case, the same folder on macOS and Windows', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'stage-src-'));
    const dest = await mkdtemp(path.join(tmpdir(), 'stage-dest-'));
    cleanupDirs.push(src, dest);
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.join(src, 'sub', '.GIT'), { recursive: true });
    await writeFile(path.join(src, 'sub', '.GIT', 'config'), 'x');
    await writeFile(path.join(src, 'sub', 'keep.txt'), 'k');
    await stagePackageContents(src, dest, buildLogger());
    expect(await exists(path.join(dest, 'sub', '.GIT'))).toBe(false);
    expect(await exists(path.join(dest, 'sub', 'keep.txt'))).toBe(true);
  });
});
