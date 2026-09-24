/**
 * Verifying an install against its installed-files record (DOR-2197): clean,
 * modified (changed, missing, added under an effect-bearing path), customized
 * editable files, and unknown for installs the record cannot speak for. Real
 * temp trees; the record is computed the way an install computes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeInstalledFiles, writeInstalledFiles } from '../../installed-files.js';
import { cachedHashFile, _internal, _resetHashCacheForTests } from '../file-hash-cache.js';
import { verifyInstall, INTEGRITY_LIST_LIMIT } from '../verify-install.js';
import { rebuildRecordStrict } from '../strict-record.js';
import { _resetCheckResultsForTests } from '../check-results.js';
import { noopLogger } from '@dorkos/shared/logger';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  _resetHashCacheForTests();
  _resetCheckResultsForTests();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'verify-install-'));
  dirs.push(d);
  return d;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

/** An install of `files` with its record, as an install writes it. */
async function installed(
  files: Record<string, string>,
  opts: { userEditable?: string[]; type?: 'plugin' | 'agent' } = {}
): Promise<string> {
  const root = path.join(await tmp(), 'pkg');
  await put(root, '.dork/manifest.json', '{"name":"pkg"}');
  for (const [p, c] of Object.entries(files)) await put(root, p, c);
  await writeInstalledFiles(
    root,
    await computeInstalledFiles(root, {
      identity: { name: 'pkg', type: opts.type ?? 'plugin' },
      userEditable: opts.userEditable ?? [],
      npmRan: false,
    })
  );
  return root;
}

describe('verifyInstall', () => {
  // Purpose: an untouched install is clean; the person's own files elsewhere
  // (config/) and the installer's files never make it modified.
  it('reports an untouched install as clean', async () => {
    const root = await installed({ 'skills/a/SKILL.md': 'a', 'README.md': 'r' });
    await put(root, 'config/mine.json', 'mine');
    await put(root, '.dork/data/state.json', '{}');
    await put(root, 'node_modules/dep/index.js', 'x');
    expect(await verifyInstall(root)).toEqual({ status: 'clean', customized: [] });
  });

  // Purpose: a changed shipped file and a deleted one are both named.
  it('names changed and missing shipped files', async () => {
    const root = await installed({ 'skills/a/SKILL.md': 'a', 'README.md': 'r', 'b.md': 'b' });
    await put(root, 'README.md', 'edited');
    await rm(path.join(root, 'b.md'));
    expect(await verifyInstall(root)).toEqual({
      status: 'modified',
      changed: ['README.md'],
      missing: ['b.md'],
      added: [],
      customized: [],
    });
  });

  // Purpose: a new file under an effect-bearing path changes what runs (Harness
  // Sync projects it), so it is `added`; one elsewhere is the person's own.
  it('names files added under a path that decides what runs, and only there', async () => {
    const root = await installed({ 'skills/a/SKILL.md': 'a' });
    await put(root, 'skills/b/SKILL.md', 'new skill');
    await put(root, 'hooks/hooks.json', '{}');
    await put(root, 'notes/todo.md', 'mine');
    await put(root, 'skills/a/SKILL.md.dork-old', 'saved copy');
    const result = await verifyInstall(root);
    expect(result).toMatchObject({
      status: 'modified',
      added: ['hooks/hooks.json', 'skills/b/SKILL.md'],
    });
  });

  // Purpose (review 9): plugin.json can put skills or hooks anywhere; a file
  // added under a location it declares changes what runs just the same.
  it('names files added under a location plugin.json declares', async () => {
    const root = await installed({
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'pkg', skills: './my-skills' }),
      'my-skills/a/SKILL.md': 'a',
    });
    await put(root, 'my-skills/b/SKILL.md', 'new');
    expect(await verifyInstall(root)).toMatchObject({
      status: 'modified',
      added: ['my-skills/b/SKILL.md'],
    });
  });

  // Purpose (review 2): a record's userEditable is only trusted where the
  // schema accepts it. A record naming `skills/**` (written before the rule, or
  // by hand) must not turn an edited skill into a "customized" file.
  it("ignores a record's userEditable entry the schema refuses", async () => {
    const root = await installed({ 'skills/a/SKILL.md': 'a' });
    const recordPath = path.join(root, '.dork', 'installed-files.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, JSON.stringify({ ...record, userEditable: ['skills/**'] }));
    await put(root, 'skills/a/SKILL.md', 'EVIL');
    expect(await verifyInstall(root)).toMatchObject({
      status: 'modified',
      changed: ['skills/a/SKILL.md'],
    });
  });

  // Purpose (review 8): an editable file replaced by a folder or a symlink is
  // still the person's change to it, reported as customized, never ignored.
  it('reports an editable path that became a symlink or folder as customized', async () => {
    const root = await installed(
      { 'config/defaults.json': '{}', 'prompts/a.md': 'a' },
      { userEditable: ['config/defaults.json', 'prompts/**'] }
    );
    await rm(path.join(root, 'config', 'defaults.json'));
    await symlink('/etc/hosts', path.join(root, 'config', 'defaults.json'));
    await rm(path.join(root, 'prompts', 'a.md'));
    await mkdir(path.join(root, 'prompts', 'a.md'));
    expect(await verifyInstall(root)).toEqual({
      status: 'clean',
      customized: ['config/defaults.json', 'prompts/a.md'],
    });
  });

  // Purpose: an agent package's identity files are the agent's, never "added".
  it("does not count an agent's identity files as added", async () => {
    const root = await installed({ 'skills/a/SKILL.md': 'a' }, { type: 'agent' });
    await put(root, '.dork/agent.json', '{}');
    await put(root, '.dork/SOUL.md', 'soul');
    expect((await verifyInstall(root)).status).toBe('clean');
  });

  // Purpose: editing a userEditable file is expected: it is `customized`, not
  // a modification, and deleting one is not a change either (row 3a).
  it('reports edited editable files as customized, and a deleted one as nothing', async () => {
    const root = await installed(
      { 'config/defaults.json': '{}', 'prompts/a.md': 'a', 'README.md': 'r' },
      { userEditable: ['config/defaults.json', 'prompts/**'] }
    );
    await put(root, 'config/defaults.json', '{"mine":true}');
    await rm(path.join(root, 'prompts', 'a.md'));
    expect(await verifyInstall(root)).toEqual({
      status: 'clean',
      customized: ['config/defaults.json'],
    });
  });

  // Purpose: a recorded path reached through a symlinked directory is not the
  // recorded file, so it is missing; it is never read through the link.
  it('treats a recorded file behind a symlinked directory as missing', async () => {
    const root = await installed({ 'skills/a/SKILL.md': 'a' });
    const elsewhere = await tmp();
    await put(elsewhere, 'a/SKILL.md', 'a');
    await rm(path.join(root, 'skills'), { recursive: true });
    await symlink(elsewhere, path.join(root, 'skills'));
    expect(await verifyInstall(root)).toMatchObject({
      status: 'modified',
      missing: ['skills/a/SKILL.md'],
    });
  });

  // Purpose: installs the record cannot speak for are unknown, with why.
  it('reports no-record, unreadable-record and linked installs as unknown', async () => {
    const legacy = path.join(await tmp(), 'legacy');
    await put(legacy, '.dork/manifest.json', '{}');
    expect(await verifyInstall(legacy)).toEqual({
      status: 'unknown',
      reason: 'no-record',
      check: { source: 'local' },
    });

    const broken = await installed({ 'a.md': 'a' });
    await put(broken, '.dork/installed-files.json', '{not json');
    expect(await verifyInstall(broken)).toEqual({ status: 'unknown', reason: 'unreadable-record' });

    const target = await installed({ 'a.md': 'a' });
    const link = path.join(await tmp(), 'linked');
    await symlink(target, link);
    expect(await verifyInstall(link)).toEqual({ status: 'unknown', reason: 'linked' });
  });

  // Purpose (review 5): an older install says whether "Check files" can help
  // (an exact commit to fetch, or a local folder), and the last attempt's
  // reason, so the app shows that instead of a button that cannot succeed.
  it('says whether an older install can be checked, and what the last check said', async () => {
    const legacy = path.join(await tmp(), 'flow');
    await put(legacy, '.dork/manifest.json', '{}');
    await put(
      legacy,
      '.dork/install-metadata.json',
      JSON.stringify({
        name: 'flow',
        version: '1.0.0',
        type: 'plugin',
        installedAt: 'x',
        commitSha: 'c'.repeat(40),
        sourceKey: { cloneUrl: 'https://github.com/acme/p', subpath: 'flow', ref: 'main' },
      })
    );
    expect(await verifyInstall(legacy)).toEqual({
      status: 'unknown',
      reason: 'no-record',
      check: { source: 'fetchable' },
    });

    await rebuildRecordStrict(legacy, {
      fetcher: { fetchAtCommit: async () => Promise.reject(new Error('offline')) },
      logger: noopLogger,
    });

    expect(await verifyInstall(legacy)).toEqual({
      status: 'unknown',
      reason: 'no-record',
      check: {
        source: 'fetchable',
        last: {
          outcome: 'fetch-failed',
          message:
            "Couldn't fetch the version of flow you installed (offline). Try again when you're online.",
        },
      },
    });
  });

  // Purpose: a very edited install names at most the limit per list, and says
  // there were more.
  it('caps each list and flags truncation', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < INTEGRITY_LIST_LIMIT + 5; i++)
      files[`f${String(i).padStart(3, '0')}.md`] = 'x';
    const root = await installed(files);
    for (const p of Object.keys(files)) await put(root, p, 'edited');
    const result = await verifyInstall(root);
    expect(result).toMatchObject({ status: 'modified', truncated: true });
    if (result.status !== 'modified') throw new Error('unreachable');
    expect(result.changed).toHaveLength(INTEGRITY_LIST_LIMIT);
  });
});

describe('cachedHashFile', () => {
  // Purpose: the cache must miss when a file is replaced by a same-size rename
  // with its mtime restored, or edited in place with its mtime restored; a hit
  // there would report a changed file as clean.
  it('misses on a same-size rename-over and on a restored mtime', async () => {
    const root = await tmp();
    const file = path.join(root, 'a.md');
    await writeFile(file, 'AAAA');
    const when = new Date('2021-05-06T07:08:09Z');
    await utimes(file, when, when);
    const first = await cachedHashFile(file);

    await writeFile(`${file}.tmp`, 'BBBB');
    await utimes(`${file}.tmp`, when, when);
    await rename(`${file}.tmp`, file);
    const second = await cachedHashFile(file);
    expect(second).not.toBe(first);

    await writeFile(file, 'CCCC');
    await utimes(file, when, when);
    expect(await cachedHashFile(file)).not.toBe(second);
  });

  // Purpose: the inode is part of the key. A platform whose ctime is coarse can
  // report the same size, mtime and ctime for a different file that replaced
  // the original; the inode still tells them apart.
  it('misses when only the inode differs', async () => {
    const root = await tmp();
    const file = path.join(root, 'a.md');
    await writeFile(file, 'AAAA');
    const real = _internal.lstat;
    const base = await real(file);
    const lstatSpy = vi.spyOn(_internal, 'lstat');
    const hashSpy = vi.spyOn(_internal, 'hashFile');
    lstatSpy.mockResolvedValueOnce(base);
    await cachedHashFile(file);
    lstatSpy.mockResolvedValueOnce(Object.assign(Object.create(base), { ino: base.ino + 1 }));
    await cachedHashFile(file);
    expect(hashSpy).toHaveBeenCalledTimes(2);
  });

  // Purpose: an unchanged file is served from the cache, not read again (the
  // point of the cache: a list call re-verifies without re-hashing).
  it('reads an unchanged file once', async () => {
    const root = await tmp();
    const file = path.join(root, 'a.md');
    await writeFile(file, 'AAAA');
    const spy = vi.spyOn(_internal, 'hashFile');
    const a = await cachedHashFile(file);
    const b = await cachedHashFile(file);
    expect(b).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
