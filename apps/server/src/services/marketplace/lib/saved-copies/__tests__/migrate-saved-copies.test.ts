/**
 * Copies an earlier version saved aside are made inert once per install
 * (DOR-2340), without ever moving a person's own folders: a saved folder
 * moves under `.dork/saved` only inside a location the package runs from and
 * only when the folder it was saved from is the package's; a saved `bin/`
 * file moves off the PATH; other saved files there lose their execute bits.
 *
 * @vitest-environment node
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readInstalledFiles,
  writeInstalledFiles,
  type InstalledFiles,
} from '../../records/installed-files.js';
import { migrateSavedCopies } from '../migrate-saved-copies.js';

let root: string;

const H = `sha256:${'0'.repeat(64)}`;

async function put(rel: string, content: string, mode = 0o644): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await chmod(abs, mode);
}

/** Record `files` as the package's, with an optional kept-file list. */
async function recordFiles(files: string[], unproven?: Record<string, string>): Promise<void> {
  const record: InstalledFiles = {
    version: 1,
    package: { name: 'pkg', type: 'plugin' },
    files: Object.fromEntries(files.map((f) => [f, H])),
    pendingDefaults: {},
    userEditable: [],
    ownedPaths: [],
    ...(unproven && { unproven: { why: 'fetch-failed' as const, files: unproven } }),
  };
  await writeInstalledFiles(root, record);
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
  it("moves the package's saved skill folder and bin/ copies, and makes saved files inert", async () => {
    await recordFiles(['skills/mine/SKILL.md', 'commands/sub/c.md', 'bin/tool']);
    await put('skills/mine.dork-old/SKILL.md', 'mine');
    await put('skills/mine.dork-old/run.sh', 'x', 0o755);
    await put('commands/sub.dork-old/c.md', 'cmd');
    await put('bin/tool.dork-old', '#!/bin/sh\n', 0o755);
    await put('bin/tool', '#!/bin/sh\n', 0o755);
    await put('hooks/run.sh.dork-old', 'x', 0o755);

    const result = await migrateSavedCopies([root], passThrough, logger);

    expect(result).toEqual({ moved: 3, migrated: 1, failed: 0 });
    expect(await exists('skills/mine.dork-old')).toBe(false);
    expect(
      await readFile(path.join(root, '.dork/saved/skills__mine.dork-old/SKILL.md'), 'utf-8')
    ).toBe('mine');
    expect(await runnable('.dork/saved/skills__mine.dork-old/run.sh')).toBe(false);
    expect(await exists('.dork/saved/commands__sub.dork-old/c.md')).toBe(true);
    expect(await exists('bin/tool.dork-old')).toBe(false);
    expect(await runnable('.dork/saved/bin__tool.dork-old')).toBe(false);
    expect(await runnable('hooks/run.sh.dork-old')).toBe(false);
    // The package's own program is left alone.
    expect(await runnable('bin/tool')).toBe(true);
  });

  it("moves a saved program out of bin/ only when it was the package's", async () => {
    await recordFiles(['bin/tool']);
    await put('bin/tool.dork-old', '#!/bin/sh\n', 0o755);
    await put('bin/mine.dork-old', '#!/bin/sh\n', 0o755);
    await migrateSavedCopies([root], passThrough, logger);
    expect(await exists('.dork/saved/bin__tool.dork-old')).toBe(true);
    // The person's own stays, made inert.
    expect(await exists('bin/mine.dork-old')).toBe(true);
    expect(await runnable('bin/mine.dork-old')).toBe(false);
  });

  it('leaves a record this version wrote alone', async () => {
    await recordFiles(['skills/x/SKILL.md']);
    await writeInstalledFiles(root, { ...(await readInstalledFiles(root))!, savedCopies: 1 });
    await put('skills/x.dork-old/SKILL.md', 'x');
    expect(await migrateSavedCopies([root], passThrough, logger)).toMatchObject({ migrated: 0 });
    expect(await exists('skills/x.dork-old/SKILL.md')).toBe(true);
  });

  it("never moves a person's own folder: not the package's, or outside where it runs from", async () => {
    await recordFiles(['skills/shipped/SKILL.md', 'notes/a.md']);
    // Named like a saved copy, but no such folder was ever the package's.
    await put('skills/drafts.dork-old/SKILL.md', 'mine');
    // The package's folder, but outside every place it runs from.
    await put('notes.dork-old/a.md', 'mine', 0o755);
    await put('docs/x.dork-old', 'mine', 0o755);
    expect(await migrateSavedCopies([root], passThrough, logger)).toEqual({
      moved: 0,
      migrated: 1,
      failed: 0,
    });
    expect(await exists('skills/drafts.dork-old/SKILL.md')).toBe(true);
    expect(await exists('notes.dork-old/a.md')).toBe(true);
    // Execute bits are only cleared inside the places a package runs from.
    expect(await runnable('notes.dork-old/a.md')).toBe(true);
    expect(await runnable('docs/x.dork-old')).toBe(true);
  });

  it('follows a location the plugin.json declares', async () => {
    await put('.claude-plugin/plugin.json', JSON.stringify({ name: 'pkg', skills: './my-skills' }));
    await recordFiles(['my-skills/s/SKILL.md', '.claude-plugin/plugin.json']);
    await put('my-skills/s.dork-old/SKILL.md', 'old');
    await migrateSavedCopies([root], passThrough, logger);
    expect(await exists('.dork/saved/my-skills__s.dork-old/SKILL.md')).toBe(true);
  });

  it('leaves a root with no record alone', async () => {
    await put('skills/x.dork-old/SKILL.md', 'x');
    expect(await migrateSavedCopies([root], passThrough, logger)).toEqual({
      moved: 0,
      migrated: 0,
      failed: 0,
    });
    expect(await exists('skills/x.dork-old/SKILL.md')).toBe(true);
    expect(await exists('.dork/saved')).toBe(false);
  });

  it('marks a root done in its record, so a later boot does not walk it again', async () => {
    await recordFiles(['skills/x/SKILL.md']);
    await migrateSavedCopies([root], passThrough, logger);
    expect((await readInstalledFiles(root))?.savedCopies).toBe(1);
    // Nothing is written into the folder to say so: an uninstall must be
    // able to remove everything.
    expect(await exists('.dork/saved')).toBe(false);
    // Something that would move is ignored once the root is marked.
    await put('skills/x.dork-old/SKILL.md', 'later');
    expect(await migrateSavedCopies([root], passThrough, logger)).toEqual({
      moved: 0,
      migrated: 0,
      failed: 0,
    });
    expect(await exists('skills/x.dork-old/SKILL.md')).toBe(true);
  });

  it('never takes a name already used', async () => {
    await recordFiles(['skills/x/SKILL.md']);
    await put('skills/x.dork-old/SKILL.md', 'one');
    await put('.dork/saved/skills__x.dork-old/SKILL.md', 'earlier');
    await migrateSavedCopies([root], passThrough, logger);
    expect(
      await readFile(path.join(root, '.dork/saved/skills__x.dork-old/SKILL.md'), 'utf-8')
    ).toBe('earlier');
    expect(
      await readFile(path.join(root, '.dork/saved/skills__x.dork-old.2/SKILL.md'), 'utf-8')
    ).toBe('one');
  });

  it('keeps the kept-file list pointing at where each file now sits (DOR-2322)', async () => {
    await recordFiles(['skills/x/SKILL.md', 'bin/t'], {
      'skills/x.dork-old/SKILL.md': 'skills/x/SKILL.md',
      'bin/t.dork-old': 'bin/t',
      'README.md': 'README.md',
    });
    await put('skills/x.dork-old/SKILL.md', 'k');
    await put('bin/t.dork-old', 't');
    await migrateSavedCopies([root], passThrough, logger);
    expect((await readInstalledFiles(root))?.unproven?.files).toEqual({
      '.dork/saved/skills__x.dork-old/SKILL.md': 'skills/x/SKILL.md',
      '.dork/saved/bin__t.dork-old': 'bin/t',
      'README.md': 'README.md',
    });
  });

  it('runs each root under its install lock, with hooks around it, and a failing root does not stop the rest', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'migrate-saved-'));
    try {
      await recordFiles(['skills/y/SKILL.md']);
      await put('skills/y.dork-old/SKILL.md', 'y');
      const locked: string[] = [];
      const lock = async <T>(r: string, fn: () => Promise<T>): Promise<T> => {
        locked.push(r);
        if (r === other) throw new Error('busy');
        return fn();
      };
      const seen: string[] = [];
      const hooks = {
        before: async (r: string) => {
          seen.push(`before ${r === root}`);
          return 'token';
        },
        after: async (_r: string, t: string) => {
          seen.push(`after ${t}`);
        },
      };
      expect(await migrateSavedCopies([other, root], lock, logger, hooks)).toEqual({
        moved: 1,
        migrated: 1,
        failed: 1,
      });
      expect(locked).toEqual([other, root]);
      expect(seen).toEqual(['before true', 'after token']);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
