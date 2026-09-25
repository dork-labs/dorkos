/**
 * Copies an earlier version saved aside are made inert once per boot
 * (DOR-2340): a saved folder moves under `.dork/saved`, where nothing loads it,
 * and every saved file loses its execute bits.
 *
 * @vitest-environment node
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateSavedCopies } from '../migrate-saved-copies.js';

let root: string;

async function put(rel: string, content: string, mode = 0o644): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await chmod(abs, mode);
}

const exists = (rel: string) =>
  lstat(path.join(root, ...rel.split('/'))).then(
    () => true,
    () => false
  );
const runnable = async (rel: string) =>
  ((await stat(path.join(root, ...rel.split('/')))).mode & 0o111) !== 0;
const passThrough = <T>(_root: string, fn: () => Promise<T>) => fn();
const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'migrate-saved-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('migrateSavedCopies', () => {
  it('moves a saved skill folder where nothing loads it, and makes saved files inert', async () => {
    await put('skills/mine.dork-old/SKILL.md', 'mine');
    await put('skills/mine.dork-old/run.sh', 'x', 0o755);
    await put('.claude/commands/sub.dork-old/c.md', 'cmd');
    await put('bin/tool.dork-old', '#!/bin/sh\n', 0o755);
    await put('bin/tool', '#!/bin/sh\n', 0o755);
    await put('.dork/saved/a.dork-old/x.sh', 'x', 0o755);

    const result = await migrateSavedCopies([root], passThrough, logger);

    expect(result).toEqual({ moved: 2, failed: 0 });
    expect(await exists('skills/mine.dork-old')).toBe(false);
    expect(
      await readFile(path.join(root, '.dork/saved/skills__mine.dork-old/SKILL.md'), 'utf-8')
    ).toBe('mine');
    expect(await runnable('.dork/saved/skills__mine.dork-old/run.sh')).toBe(false);
    expect(await exists('.dork/saved/.claude__commands__sub.dork-old/c.md')).toBe(true);
    expect(await runnable('bin/tool.dork-old')).toBe(false);
    expect(await runnable('.dork/saved/a.dork-old/x.sh')).toBe(false);
    // The package's own program is left alone.
    expect(await runnable('bin/tool')).toBe(true);
  });

  it('is idempotent and never takes a name already used', async () => {
    await put('skills/x.dork-old/SKILL.md', 'one');
    await put('.dork/saved/skills__x.dork-old/SKILL.md', 'earlier');
    await migrateSavedCopies([root], passThrough, logger);
    expect(
      await readFile(path.join(root, '.dork/saved/skills__x.dork-old/SKILL.md'), 'utf-8')
    ).toBe('earlier');
    expect(
      await readFile(path.join(root, '.dork/saved/skills__x.dork-old.2/SKILL.md'), 'utf-8')
    ).toBe('one');
    expect(await migrateSavedCopies([root], passThrough, logger)).toEqual({ moved: 0, failed: 0 });
  });

  it('leaves dependencies, git and the package data alone', async () => {
    await put('node_modules/p.dork-old/x', 'x', 0o755);
    await put('.dork/data/cache.dork-old/x', 'x', 0o755);
    await migrateSavedCopies([root], passThrough, logger);
    expect(await exists('node_modules/p.dork-old/x')).toBe(true);
    expect(await runnable('.dork/data/cache.dork-old/x')).toBe(true);
  });

  it('runs each root under its install lock, and a failing root does not stop the rest', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'migrate-saved-'));
    try {
      await put('skills/y.dork-old/SKILL.md', 'y');
      const locked: string[] = [];
      const lock = async <T>(r: string, fn: () => Promise<T>): Promise<T> => {
        locked.push(r);
        if (r === other) throw new Error('busy');
        return fn();
      };
      expect(await migrateSavedCopies([other, root], lock, logger)).toEqual({
        moved: 1,
        failed: 1,
      });
      expect(locked).toEqual([other, root]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
