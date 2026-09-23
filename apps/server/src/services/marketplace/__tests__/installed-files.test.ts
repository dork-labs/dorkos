/**
 * Tests for the installed-files record and the carry-over decision table
 * (DOR-2245, spec `marketplace-package-file-ownership` §2 and §4).
 *
 * Filesystem helpers run against real temp directories, because the bugs this
 * module exists to stop live in real paths (symlinks, special files). The
 * decision table is pure and is driven with plain objects, one test per row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  computeInstalledFiles,
  hashFile,
  isInstallWhole,
  isProvenPackageFile,
  LegacyInstallError,
  lstatChain,
  planCarryOver,
  readInstalledFiles,
  sameSource,
  scanTree,
  writeInstalledFiles,
  type CarryOverInput,
  type InstalledFiles,
  type StagedFacts,
  type TreeScan,
} from '../lib/installed-files.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'installed-files-'));
  dirs.push(d);
  return d;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

/** The record's hash of a string, computed the way the module does. */
async function h(content: string): Promise<string> {
  const root = await tempRoot();
  await put(root, 'f', content);
  return hashFile(path.join(root, 'f'));
}

const identity = { name: 'pkg', type: 'plugin' as const };

describe('computeInstalledFiles', () => {
  // Purpose: the record names exactly the shipped files, and nothing the
  // installer, npm, the person or DorkOS's scaffold writes.
  it('records shipped files only, as sorted POSIX paths', async () => {
    const root = await tempRoot();
    await put(root, 'skills/a/SKILL.md', 'a');
    await put(root, '.claude-plugin/plugin.json', '{}');
    await put(root, 'node_modules/zod/index.js', 'z');
    await put(root, 'package-lock.json', '{}');
    await put(root, '.dork/install-metadata.json', '{}');
    await put(root, '.dork/data/state.json', '{}');
    await symlink('skills', path.join(root, 'link'));

    const record = await computeInstalledFiles(root, { identity, userEditable: [], npmRan: true });

    expect(Object.keys(record.files)).toEqual(['.claude-plugin/plugin.json', 'skills/a/SKILL.md']);
    expect(record.ownedPaths).toEqual(['node_modules', 'package-lock.json']);
    expect(record.files['skills/a/SKILL.md']).toBe(await h('a'));
  });

  // Purpose: without the npm step, a shipped lockfile is an ordinary package file.
  it('records package-lock.json when npm did not run', async () => {
    const root = await tempRoot();
    await put(root, 'package-lock.json', '{}');
    const record = await computeInstalledFiles(root, { identity, userEditable: [], npmRan: false });
    expect(record.ownedPaths).toEqual([]);
    expect(Object.keys(record.files)).toEqual(['package-lock.json']);
  });

  // Purpose: an agent's identity files are the agent's, never recorded (review 9);
  // a plugin shipping the same paths records them.
  it("excludes an agent package's identity files, and only an agent's", async () => {
    const root = await tempRoot();
    await put(root, '.dork/SOUL.md', 'soul');
    await put(root, '.dork/agent.json', '{}');
    const agent = await computeInstalledFiles(root, {
      identity: { name: 'a', type: 'agent' },
      userEditable: [],
      npmRan: false,
    });
    const plugin = await computeInstalledFiles(root, { identity, userEditable: [], npmRan: false });
    expect(Object.keys(agent.files)).toEqual([]);
    expect(Object.keys(plugin.files)).toEqual(['.dork/SOUL.md', '.dork/agent.json']);
  });
});

describe('readInstalledFiles / writeInstalledFiles', () => {
  // Purpose: a written record round-trips.
  it('round-trips', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, '.dork'));
    const record = await computeInstalledFiles(root, {
      identity,
      userEditable: ['a'],
      npmRan: false,
    });
    await writeInstalledFiles(root, record);
    expect(await readInstalledFiles(root)).toEqual(record);
  });

  // Purpose: an untrusted record that could reach outside the root is ignored.
  it.each([
    ['missing', undefined],
    ['bad JSON', '{'],
    ['parent path', { '../x': 'sha256:' + 'a'.repeat(64) }],
    ['absolute path', { '/etc/passwd': 'sha256:' + 'a'.repeat(64) }],
    ['backslash path', { 'a\\b': 'sha256:' + 'a'.repeat(64) }],
    ['bad hash', { a: 'md5:1' }],
  ])('returns null for %s', async (_label, files) => {
    const root = await tempRoot();
    if (files !== undefined) {
      const body =
        typeof files === 'string'
          ? files
          : JSON.stringify({ version: 1, package: identity, ownedPaths: [], files });
      await put(root, '.dork/installed-files.json', body);
    }
    expect(await readInstalledFiles(root)).toBeNull();
  });
});

describe('lstatChain / isProvenPackageFile / isInstallWhole', () => {
  // Purpose: nothing is read through a symlinked directory (review 12).
  it('reports a path behind a symlinked directory as through a symlink, and not proven', async () => {
    const root = await tempRoot();
    const elsewhere = await tempRoot();
    await put(elsewhere, 'SKILL.md', 'x');
    await symlink(elsewhere, path.join(root, 'skills'));
    const record = {
      version: 1 as const,
      package: identity,
      ownedPaths: [],
      files: { 'skills/SKILL.md': await h('x') },
      pendingDefaults: {},
      userEditable: [],
    };
    expect(await lstatChain(root, 'skills/SKILL.md')).toEqual({
      kind: 'symlink',
      throughSymlink: true,
    });
    expect(await isProvenPackageFile(root, 'skills/SKILL.md', record)).toBe(false);
  });

  // Purpose: proof needs matching bytes.
  it('proves an unchanged file and not an edited one', async () => {
    const root = await tempRoot();
    await put(root, 'a', 'shipped');
    const record = await computeInstalledFiles(root, { identity, userEditable: [], npmRan: false });
    expect(await isProvenPackageFile(root, 'a', record)).toBe(true);
    await put(root, 'a', 'edited');
    expect(await isProvenPackageFile(root, 'a', record)).toBe(false);
  });

  // Purpose: "whole" tolerates edits but not a missing recorded file.
  it('is whole with edits, broken when a recorded file is gone, unknown without a record', async () => {
    const root = await tempRoot();
    expect(await isInstallWhole(root)).toBe('unknown');
    await put(root, 'a', 'shipped');
    await put(root, 'b', 'shipped');
    await writeInstalledFiles(
      root,
      await computeInstalledFiles(root, { identity, userEditable: [], npmRan: false })
    );
    await put(root, 'a', 'edited');
    expect(await isInstallWhole(root)).toBe('whole');
    await rm(path.join(root, 'b'));
    expect(await isInstallWhole(root)).toBe('broken');
  });
});

describe('scanTree', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  // Purpose: symlinks are listed, never followed; special files are named, never read.
  it('lists symlinks and sockets without following or reading them', async () => {
    const root = await tempRoot();
    await put(root, 'dir/a', 'a');
    await symlink('/etc', path.join(root, 'etc-link'));
    const sock = path.join(root, 's.sock');
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(sock, resolve));

    const scan = await scanTree(root, { hash: () => true });

    expect(scan.dirs).toEqual(new Set(['dir']));
    expect(scan.entries.get('etc-link')).toEqual({ kind: 'symlink' });
    expect(scan.entries.get('s.sock')).toEqual({ kind: 'special' });
    expect(scan.entries.get('dir/a')?.hash).toBe(await h('a'));
  });
});

describe('sameSource', () => {
  const base = { cloneUrl: 'https://github.com/o/r', subpath: 'plugins/flow', ref: 'main' };
  // Purpose: a ref change is the same package (round-3 N8); anything else is not.
  it('ignores the ref and compares clone URL + subpath', () => {
    expect(sameSource(base, { ...base, ref: 'v0.8.0' })).toBe(true);
    expect(sameSource(base, { ...base, ref: 'a'.repeat(40) })).toBe(true);
    expect(sameSource(base, { ...base, subpath: 'plugins/other' })).toBe(false);
    expect(sameSource(base, { ...base, cloneUrl: 'https://github.com/x/r' })).toBe(false);
    expect(sameSource({ localPath: '/a' }, { localPath: '/a' })).toBe(true);
    expect(sameSource({ localPath: '/a' }, base)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planCarryOver — one test per row of the spec's §4 table
// ---------------------------------------------------------------------------

const H = (c: string): string => `sha256:${c.padEnd(64, '0')}`;

function record(files: Record<string, string>, opts: Partial<InstalledFiles> = {}): InstalledFiles {
  return {
    version: 1,
    package: identity,
    ownedPaths: [],
    files,
    pendingDefaults: {},
    userEditable: [],
    ...opts,
  };
}

function liveScan(
  files: Record<string, string | 'symlink' | 'special'>,
  dirs: string[] = []
): TreeScan {
  const entries = new Map<string, { kind: 'file' | 'symlink' | 'special'; hash?: string }>();
  const allDirs = new Set(dirs);
  for (const [p, v] of Object.entries(files)) {
    entries.set(p, v === 'symlink' || v === 'special' ? { kind: v } : { kind: 'file', hash: v });
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) allDirs.add(parts.slice(0, i).join('/'));
  }
  return { entries, dirs: allDirs };
}

/** Staged facts derived from the new record, plus extra occupied paths. */
function stagedFrom(rNew: InstalledFiles, extra: Record<string, 'file' | 'dir'> = {}): StagedFacts {
  const kinds = new Map<string, 'file' | 'dir'>(Object.entries(extra));
  for (const p of Object.keys(rNew.files)) {
    kinds.set(p, 'file');
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) kinds.set(parts.slice(0, i).join('/'), 'dir');
  }
  return { kindOf: (p) => kinds.get(p) ?? 'missing' };
}

function plan(input: Partial<CarryOverInput> & { rNew: InstalledFiles; live: TreeScan }) {
  return planCarryOver({
    rOld: null,
    oldHasIdentity: false,
    staged: stagedFrom(input.rNew),
    liveRoot: '/live',
    ...input,
  });
}

describe('planCarryOver', () => {
  const U = { userEditable: ['cfg.json'] };

  // Row 0: a new file, nothing live. The new copy stands; nothing to do.
  it('row 0: leaves a newly shipped file alone', () => {
    const p = plan({ rOld: record({}), rNew: record({ 'new.md': H('n') }), live: liveScan({}) });
    expect(p.actions).toEqual([]);
  });

  // Rows 1 and 2: the package's own unchanged files are never carried.
  it('rows 1-2: an unchanged recorded file is not carried, shipped again or not', () => {
    const p = plan({
      rOld: record({ 'a.md': H('a'), 'gone.md': H('g') }),
      rNew: record({ 'a.md': H('a2') }),
      live: liveScan({ 'a.md': H('a'), 'gone.md': H('g') }),
    });
    expect(p.actions).toEqual([]);
    expect(p.notices).toEqual([]);
  });

  // Row 3a: the person deleted an editable default; it stays deleted.
  it('row 3a: drops the new copy of an editable file the person deleted', () => {
    const p = plan({
      rOld: record({ 'cfg.json': H('c') }, U),
      rNew: record({ 'cfg.json': H('c2') }, U),
      live: liveScan({}),
    });
    expect(p.actions).toEqual([{ kind: 'drop', path: 'cfg.json' }]);
  });

  // Row 3b: a deleted non-editable file comes back.
  it('row 3b: restores a deleted non-editable file', () => {
    const p = plan({
      rOld: record({ 'a.md': H('a') }),
      rNew: record({ 'a.md': H('a') }),
      live: liveScan({}),
    });
    expect(p.actions).toEqual([]);
  });

  // Row 4: missing and no longer shipped: nothing.
  it('row 4: a deleted file the package dropped stays gone', () => {
    const p = plan({ rOld: record({ 'a.md': H('a') }), rNew: record({}), live: liveScan({}) });
    expect(p.actions).toEqual([]);
  });

  // Row 5: an edited shipped file: the package wins, the edit is saved.
  it('row 5: replaces an edited shipped file and saves the edit as .dork-old', () => {
    const p = plan({
      rOld: record({ 'a.md': H('a') }),
      rNew: record({ 'a.md': H('a2') }),
      live: liveScan({ 'a.md': H('mine') }),
    });
    expect(p.actions).toEqual([{ kind: 'carry-as', path: 'a.md', savedAs: 'a.md.dork-old' }]);
    expect(p.notices).toEqual([
      { path: 'a.md', outcome: 'replaced-edit', savedAs: 'a.md.dork-old' },
    ]);
  });

  // Row 5 (same bytes): the edit already equals the new version; no copy (nit 18).
  it('row 5: writes no .dork-old when the edit equals the new version', () => {
    const p = plan({
      rOld: record({ 'a.md': H('a') }),
      rNew: record({ 'a.md': H('a2') }),
      live: liveScan({ 'a.md': H('a2') }),
    });
    expect(p.actions).toEqual([]);
  });

  // Row 6: an edited editable file with a changed default: keep the edit, save the default.
  it('row 6: keeps an edited editable file and saves a changed default as .dork-new', () => {
    const p = plan({
      rOld: record({ 'cfg.json': H('c') }, U),
      rNew: record({ 'cfg.json': H('c2') }, U),
      live: liveScan({ 'cfg.json': H('mine') }),
    });
    expect(p.actions).toEqual([
      { kind: 'save-new-as', path: 'cfg.json', savedAs: 'cfg.json.dork-new' },
    ]);
    expect(p.notices).toEqual([
      { path: 'cfg.json', outcome: 'kept-edit', savedAs: 'cfg.json.dork-new' },
    ]);
    expect(p.addedFiles).toEqual({ 'cfg.json.dork-new': H('c2') });
    expect(p.pendingDefaults).toEqual({ 'cfg.json.dork-new': 'cfg.json' });
  });

  // Row 6 (default unchanged): keep the edit, no new copy.
  it('row 6: keeps an edited editable file silently when the default did not change', () => {
    const p = plan({
      rOld: record({ 'cfg.json': H('c') }, U),
      rNew: record({ 'cfg.json': H('c') }, U),
      live: liveScan({ 'cfg.json': H('mine') }),
    });
    expect(p.actions).toEqual([{ kind: 'carry', path: 'cfg.json' }]);
    expect(p.notices).toEqual([]);
  });

  // Row 7: an edited file the package dropped: saved aside, not left projecting.
  it('row 7: saves an edited file the package no longer ships as .dork-old', () => {
    const p = plan({
      rOld: record({ 'a.md': H('a') }),
      rNew: record({}),
      live: liveScan({ 'a.md': H('mine') }),
    });
    expect(p.actions).toEqual([{ kind: 'carry-as', path: 'a.md', savedAs: 'a.md.dork-old' }]);
  });

  // Row 8: an edited editable file the package dropped stays in place.
  it('row 8: keeps an edited editable file the package no longer ships', () => {
    const p = plan({
      rOld: record({ 'cfg.json': H('c') }, U),
      rNew: record({}),
      live: liveScan({ 'cfg.json': H('mine') }),
    });
    expect(p.actions).toEqual([{ kind: 'carry', path: 'cfg.json' }]);
    expect(p.notices).toEqual([{ path: 'cfg.json', outcome: 'kept-no-longer-shipped' }]);
  });

  // Row 9: the person's own file: carried as is. This is flow's config.
  it("row 9: carries the person's own file", () => {
    const p = plan({
      rOld: record({ 'config/config.example.json': H('e') }),
      rNew: record({ 'config/config.example.json': H('e2') }),
      live: liveScan({ 'config/config.example.json': H('e'), 'config/config.json': H('mine') }),
    });
    expect(p.actions).toEqual([{ kind: 'carry', path: 'config/config.json' }]);
  });

  // Row 10: the package now ships a path the person made: the package wins, theirs is saved.
  it('row 10: saves a person file the package now ships, unless the bytes match', () => {
    const differs = plan({
      rOld: record({}),
      rNew: record({ 'a.md': H('n') }),
      live: liveScan({ 'a.md': H('mine') }),
    });
    expect(differs.actions).toEqual([{ kind: 'carry-as', path: 'a.md', savedAs: 'a.md.dork-old' }]);
    const same = plan({
      rOld: record({}),
      rNew: record({ 'a.md': H('n') }),
      live: liveScan({ 'a.md': H('n') }),
    });
    expect(same.actions).toEqual([]);
  });

  // Row 11: the package now ships an editable path the person made: theirs wins.
  it('row 11: keeps a person file at a newly shipped editable path, saving the default', () => {
    const p = plan({
      rOld: record({}),
      rNew: record({ 'cfg.json': H('n') }, U),
      live: liveScan({ 'cfg.json': H('mine') }),
    });
    expect(p.actions).toEqual([
      { kind: 'save-new-as', path: 'cfg.json', savedAs: 'cfg.json.dork-new' },
    ]);
  });

  // pendingDefaults: an unmerged .dork-new survives while it still means something (nit 19).
  it('keeps a pending .dork-new while the edit still differs, and drops it once merged', () => {
    const rOld = record(
      { 'cfg.json': H('c'), 'cfg.json.dork-new': H('c2') },
      {
        ...U,
        pendingDefaults: { 'cfg.json.dork-new': 'cfg.json' },
      }
    );
    const rNew = record({ 'cfg.json': H('c2') }, U);
    const unmerged = plan({
      rOld,
      rNew,
      live: liveScan({ 'cfg.json': H('mine'), 'cfg.json.dork-new': H('c2') }),
    });
    expect(unmerged.actions).toEqual([
      { kind: 'save-new-as', path: 'cfg.json', savedAs: 'cfg.json.dork-new' },
    ]);
    const merged = plan({
      rOld,
      rNew,
      live: liveScan({ 'cfg.json': H('c2'), 'cfg.json.dork-new': H('c2') }),
    });
    expect(merged.actions).toEqual([]);
  });

  // A pending .dork-new survives even when the default did not change again (nit 19).
  it('keeps a pending .dork-new when the default is unchanged and the edit still differs', () => {
    const rOld = record(
      { 'cfg.json': H('c2'), 'cfg.json.dork-new': H('c2') },
      {
        ...U,
        pendingDefaults: { 'cfg.json.dork-new': 'cfg.json' },
      }
    );
    const rNew = record({ 'cfg.json': H('c2') }, U);
    const p = plan({
      rOld,
      rNew,
      live: liveScan({ 'cfg.json': H('mine'), 'cfg.json.dork-new': H('c2') }),
    });
    expect(p.actions).toEqual([
      { kind: 'save-new-as', path: 'cfg.json', savedAs: 'cfg.json.dork-new' },
    ]);
  });

  // A .dork-new the person edited is theirs: saved, not overwritten by the refresh.
  it('saves a pending .dork-new the person edited instead of refreshing over it', () => {
    const rOld = record(
      { 'cfg.json': H('c'), 'cfg.json.dork-new': H('c2') },
      {
        ...U,
        pendingDefaults: { 'cfg.json.dork-new': 'cfg.json' },
      }
    );
    const rNew = record({ 'cfg.json': H('c3') }, U);
    const p = plan({
      rOld,
      rNew,
      live: liveScan({ 'cfg.json': H('mine'), 'cfg.json.dork-new': H('touched') }),
    });
    expect(p.actions).toContainEqual({
      kind: 'carry-as',
      path: 'cfg.json.dork-new',
      savedAs: 'cfg.json.dork-new.dork-old',
    });
    expect(p.actions).toContainEqual({
      kind: 'save-new-as',
      path: 'cfg.json',
      savedAs: 'cfg.json.dork-new',
    });
  });

  // A person file under a directory the new version made a file saves the whole
  // subtree under one renamed directory (review 11).
  it('saves files under a path the new version turned into a file inside one renamed folder', () => {
    const rOld = record({ 'a/b/kept.md': H('k') });
    const rNew = record({ 'a/b': H('f') });
    const p = plan({
      rOld,
      rNew,
      live: liveScan({ 'a/b/kept.md': H('k'), 'a/b/mine.txt': H('m'), 'a/b/two.txt': H('t') }),
    });
    expect(p.actions).toEqual([
      { kind: 'carry-as', path: 'a/b/mine.txt', savedAs: 'a/b.dork-old/mine.txt' },
      { kind: 'carry-as', path: 'a/b/two.txt', savedAs: 'a/b.dork-old/two.txt' },
    ]);
  });

  // A saved name the staged tree already occupies is never used.
  it('skips a saved name the staged tree reports as taken', () => {
    const rNew = record({ 'a.md': H('a2') });
    const staged: StagedFacts = {
      kindOf: (p) => (p === 'a.md' ? 'file' : p === 'a.md.dork-old' ? 'file' : 'missing'),
    };
    const p = plan({
      rOld: record({ 'a.md': H('a') }),
      rNew,
      staged,
      live: liveScan({ 'a.md': H('mine') }),
    });
    expect(p.actions).toEqual([{ kind: 'carry-as', path: 'a.md', savedAs: 'a.md.dork-old.2' }]);
  });

  // Saved names are chosen against the staged tree and every planned write.
  it('picks the next free .dork-old name when one is taken', () => {
    const p = plan({
      rOld: record({ 'a.md': H('a') }),
      rNew: record({ 'a.md': H('a2') }),
      live: liveScan({ 'a.md': H('mine'), 'a.md.dork-old': H('older') }),
    });
    expect(p.actions).toContainEqual({ kind: 'carry', path: 'a.md.dork-old' });
    expect(p.actions).toContainEqual({
      kind: 'carry-as',
      path: 'a.md',
      savedAs: 'a.md.dork-old.2',
    });
  });

  // A file where the new version has a directory (file↔dir) is saved aside (review 11).
  it('saves a person file where the new version put a directory', () => {
    const rNew = record({ 'notes/a.md': H('n') });
    const p = plan({ rOld: record({}), rNew, live: liveScan({ notes: H('mine') }) });
    expect(p.actions).toEqual([{ kind: 'carry-as', path: 'notes', savedAs: 'notes.dork-old' }]);
  });

  // A case-only clash on a case-insensitive volume is a collision (review 11).
  it('treats a case-only clash reported by the staged tree as a collision', () => {
    const rNew = record({ 'README.md': H('n') });
    const staged: StagedFacts = {
      kindOf: (p) => (p.toLowerCase() === 'readme.md' ? 'file' : 'missing'),
    };
    const p = plan({ rOld: record({}), rNew, live: liveScan({ 'readme.md': H('mine') }), staged });
    expect(p.actions).toEqual([
      { kind: 'carry-as', path: 'readme.md', savedAs: 'readme.md.dork-old' },
    ]);
  });

  // A person directory with nothing recorded beneath it moves as one unit.
  it('carries a directory with no recorded file beneath it as one unit', () => {
    const p = plan({
      rOld: record({ 'skills/a/SKILL.md': H('s') }),
      rNew: record({ 'skills/a/SKILL.md': H('s') }),
      live: liveScan({
        'skills/a/SKILL.md': H('s'),
        'work/x.txt': H('x'),
        'work/deep/y.txt': H('y'),
      }),
    });
    expect(p.actions).toEqual([{ kind: 'carry-dir', path: 'work' }]);
  });

  // Special files are named, never copied (review 5).
  it('skips a special file and reports it', () => {
    const p = plan({
      rOld: record({}),
      rNew: record({}),
      live: liveScan({ 'git.ipc': 'special' }),
    });
    expect(p.actions).toEqual([{ kind: 'skip-special', path: 'git.ipc' }]);
    expect(p.notices).toEqual([{ path: 'git.ipc', outcome: 'skipped-special' }]);
  });

  // Nothing behind a live symlink is decided on; the link itself is the person's.
  it('never reads through a symlinked directory in the live root', () => {
    const rOld = record({ 'skills/a/SKILL.md': H('s') }, { userEditable: ['skills/**'] });
    const rNew = record({ 'skills/a/SKILL.md': H('s2') }, { userEditable: ['skills/**'] });
    const p = plan({ rOld, rNew, live: liveScan({ skills: 'symlink' }) });
    expect(p.actions).toEqual([{ kind: 'carry-as', path: 'skills', savedAs: 'skills.dork-old' }]);
  });

  // Installer files and owned paths are never carried.
  it('never carries install-metadata, the record, or owned paths', () => {
    const p = plan({
      rOld: record({}, { ownedPaths: ['node_modules'] }),
      rNew: record({}),
      live: liveScan({
        '.dork/install-metadata.json': H('m'),
        '.dork/installed-files.json': H('r'),
        'node_modules/zod/index.js': H('z'),
      }),
    });
    expect(p.actions).toEqual([]);
  });

  // An agent's identity files are carried as the agent's, even when shipped (seed-only).
  it("carries an agent's identity files over the package's seeds, and its parked identity", () => {
    const agent = { package: { name: 'a', type: 'agent' as const } };
    const p = plan({
      rOld: record({}, agent),
      rNew: record({ '.dork/SOUL.md': H('seed') }, agent),
      live: liveScan({ '.dork/SOUL.md': H('mine'), '.dork/uninstalled-agent.json': H('id') }),
    });
    expect(p.actions).toEqual([
      { kind: 'carry', path: '.dork/SOUL.md' },
      { kind: 'carry', path: '.dork/uninstalled-agent.json' },
    ]);
    expect(p.notices).toEqual([]);
  });

  // A root with no record and no identity (a pre-change uninstall's leftovers): all the person's.
  it('treats every file as the person’s when the root has neither record nor identity', () => {
    const p = plan({
      rOld: null,
      rNew: record({ 'a.md': H('n') }),
      live: liveScan({ 'a.md': H('mine'), b: H('b') }),
    });
    expect(p.actions).toEqual([
      { kind: 'carry-as', path: 'a.md', savedAs: 'a.md.dork-old' },
      { kind: 'carry', path: 'b' },
    ]);
  });

  // A root with an identity but no record must be rebuilt first (§9).
  it('refuses a legacy install without a rebuilt record', () => {
    expect(() =>
      plan({ rOld: null, oldHasIdentity: true, rNew: record({}), live: liveScan({}) })
    ).toThrow(LegacyInstallError);
  });
});
