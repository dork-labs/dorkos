/**
 * Rebuilding the record of an install made before records existed (DOR-2245
 * §9): from the installed commit when it can be fetched and trusted, else by
 * matching bytes against trees DorkOS can obtain. Real temp dirs; the fetcher
 * is a fake at its seam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { rebuildInstalledFiles } from '../legacy-record.js';
import { readInstalledFiles } from '../installed-files.js';

const SHA = 'a'.repeat(40);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'legacy-record-'));
  dirs.push(d);
  return d;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function tree(files: Record<string, string>): Promise<string> {
  const root = await tmp();
  for (const [p, c] of Object.entries(files)) await put(root, p, c);
  return root;
}

/** A legacy install: shipped files, a sidecar naming its commit, no record. */
async function legacyInstall(files: Record<string, string>, withSource = true): Promise<string> {
  const root = await tree(files);
  await put(
    root,
    '.dork/install-metadata.json',
    JSON.stringify({
      name: 'flow',
      version: '0.7.3',
      type: 'plugin',
      installedAt: '2026-09-23T00:00:00.000Z',
      ...(withSource && {
        commitSha: SHA,
        sourceKey: {
          cloneUrl: 'https://github.com/dork-labs/marketplace',
          subpath: 'plugins/flow',
          ref: 'main',
        },
      }),
    })
  );
  return root;
}

function fetcherFor(treePath: string) {
  return {
    fetchAtCommit: vi.fn(async () => ({ path: treePath, commitSha: SHA, fromCache: false })),
  };
}

describe('rebuildInstalledFiles', () => {
  // Purpose: the flow case. A rebuilt record lists the shipped files, not the
  // config the person added, and is written into the root.
  it('rebuilds the record from the installed commit, fetched by the install-time name', async () => {
    const shipped = {
      '.dork/manifest.json': '{}',
      'skills/a/SKILL.md': 'a',
      'config/config.example.json': '{}',
    };
    const root = await legacyInstall(shipped);
    await put(root, 'config/config.json', '{"team":"DOR"}');
    const fetcher = fetcherFor(await tree(shipped));

    const record = await rebuildInstalledFiles(root, { fetcher, logger: noopLogger });

    expect(fetcher.fetchAtCommit).toHaveBeenCalledWith({
      packageName: 'flow',
      sourceKey: {
        cloneUrl: 'https://github.com/dork-labs/marketplace',
        subpath: 'plugins/flow',
        ref: 'main',
      },
      commitSha: SHA,
    });
    expect(Object.keys(record.files).sort()).toEqual(Object.keys(shipped).sort());
    expect(record.inferred).toBeUndefined();
    expect(record.package.source).toMatchObject({ subpath: 'plugins/flow' });
    expect((await readInstalledFiles(root))?.files).toEqual(record.files);
  });

  // Purpose (N5): a fetched tree that is not what was installed is rejected at
  // 11% / 3+ mismatches and accepted at 10%.
  it('rejects a rebuild that differs in more than 10% (and at least 3) of files', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.md`] = `v${i}`;
    const root = await legacyInstall(files);
    const twoDiffer = { ...files, 'f0.md': 'x', 'f1.md': 'x' }; // 2 of 20: accepted
    const threeDiffer = { ...files, 'f0.md': 'x', 'f1.md': 'x', 'f2.md': 'x' }; // 3 of 20 = 15%: rejected
    const accepted = await rebuildInstalledFiles(root, {
      fetcher: fetcherFor(await tree(twoDiffer)),
      logger: noopLogger,
    });
    expect(accepted.inferred).toBeUndefined();
    const rejected = await rebuildInstalledFiles(root, {
      fetcher: fetcherFor(await tree(threeDiffer)),
      logger: noopLogger,
    });
    expect(rejected.inferred).toBe(true);
  });

  // Purpose (code review 3): the trust check runs under the install lock, so it
  // must never open a FIFO (blocks forever) or follow a symlink (to /dev/zero,
  // or to a huge file outside the root). Those count as differing files.
  it(
    'counts a FIFO and symlinks as differing without reading them',
    { timeout: 10_000 },
    async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 20; i++) files[`f${i}.md`] = `v${i}`;
      const root = await legacyInstall(files);
      const outside = await tree({ 'big.bin': 'v2' });
      await rm(path.join(root, 'f0.md'));
      execFileSync('mkfifo', [path.join(root, 'f0.md')]);
      await rm(path.join(root, 'f1.md'));
      await symlink('/dev/zero', path.join(root, 'f1.md'));
      await rm(path.join(root, 'f2.md'));
      await symlink(path.join(outside, 'big.bin'), path.join(root, 'f2.md'));

      const record = await rebuildInstalledFiles(root, {
        fetcher: fetcherFor(await tree(files)),
        logger: noopLogger,
      });

      // 3 of 20 differ (15%, at least 3): the rebuild is rejected, and the
      // fallback lists none of the three.
      expect(record.inferred).toBe(true);
      expect(Object.keys(record.files)).not.toEqual(expect.arrayContaining(['f0.md']));
      expect(Object.keys(record.files)).not.toContain('f1.md');
      expect(Object.keys(record.files)).not.toContain('f2.md');
    }
  );

  // Purpose (DOR-2318): a legacy install's scheduled SKILL.md carries the block
  // its install wrote in. The rebuilt record must hold that file as installed,
  // or the first update calls it the person's edit.
  it('rebuilds a skillRef-scheduled SKILL.md as installed, block included', async () => {
    const manifest = JSON.stringify({
      schemaVersion: 1,
      name: 'flow',
      version: '0.7.3',
      type: 'skill-pack',
      description: 'A skill pack with a scheduled skill',
      schedules: [{ skillRef: 'tick', cron: '0 3 * * *' }],
    });
    const raw = '---\nname: tick\ndescription: Tick.\n---\n\nTick.\n';
    const shipped = { '.dork/manifest.json': manifest, 'skills/tick/SKILL.md': raw };
    const root = await legacyInstall(shipped);
    // What the old install left: the same skill, with the schedule written in.
    const installedTree = await tree(shipped);
    const { materializePackageSchedules } = await import('../materialize-schedules.js');
    const { MarketplacePackageManifestSchema } = await import('@dorkos/marketplace');
    await materializePackageSchedules({
      manifest: MarketplacePackageManifestSchema.parse(JSON.parse(manifest)),
      installPath: installedTree,
      forms: 'skillRef',
      dorkHome: installedTree,
      logger: noopLogger,
    });
    const injected = await readFile(path.join(installedTree, 'skills', 'tick', 'SKILL.md'), 'utf8');
    expect(injected).toMatch(/schedule:/);
    await put(root, 'skills/tick/SKILL.md', injected);

    const record = await rebuildInstalledFiles(root, {
      fetcher: fetcherFor(await tree(shipped)),
      logger: noopLogger,
    });

    expect(record.inferred).toBeUndefined();
    expect(record.files['skills/tick/SKILL.md']).toBe(
      `sha256:${createHash('sha256').update(injected).digest('hex')}`
    );
  });

  // Purpose: exactly 10% is still trusted (the rule is "more than 10%").
  it('accepts a rebuild at exactly 10% mismatches', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.md`] = `v${i}`;
    const root = await legacyInstall(files);
    const differ = { ...files, 'f0.md': 'x', 'f1.md': 'x', 'f2.md': 'x' }; // 3 of 30 = 10%
    const record = await rebuildInstalledFiles(root, {
      fetcher: fetcherFor(await tree(differ)),
      logger: noopLogger,
    });
    expect(record.inferred).toBeUndefined();
  });

  // Purpose: a small package edited in two places is not "a different tree":
  // 2 of 5 differ (40%) but fewer than 3, so the rebuild is trusted.
  it('trusts a rebuild with fewer than 3 differing files, whatever the share', async () => {
    const files = { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c', 'd.md': 'd', 'e.md': 'e' };
    const root = await legacyInstall(files);
    const record = await rebuildInstalledFiles(root, {
      fetcher: fetcherFor(await tree({ ...files, 'a.md': 'x', 'b.md': 'x' })),
      logger: noopLogger,
    });
    expect(record.inferred).toBeUndefined();
  });

  // Purpose: with no fetchable tree, only files some obtainable tree vouches
  // for are the package's; everything else is kept.
  it('infers by matching bytes against the new version when nothing can be fetched', async () => {
    const root = await legacyInstall(
      { 'same.md': 's', 'changed.md': 'old', 'mine.txt': 'mine' },
      false
    );
    const newTree = await tree({ 'same.md': 's', 'changed.md': 'new' });
    const record = await rebuildInstalledFiles(root, { logger: noopLogger }, newTree);
    expect(record.inferred).toBe(true);
    expect(Object.keys(record.files)).toEqual(['same.md']);
  });

  // Purpose: a failed fetch falls back rather than failing the install.
  it('falls back when the fetch throws', async () => {
    const root = await legacyInstall({ 'a.md': 'a' });
    const fetcher = { fetchAtCommit: vi.fn(async () => Promise.reject(new Error('offline'))) };
    const record = await rebuildInstalledFiles(
      root,
      { fetcher, logger: noopLogger },
      await tree({ 'a.md': 'a' })
    );
    expect(record.inferred).toBe(true);
    expect(Object.keys(record.files)).toEqual(['a.md']);
  });
});

describe('what the fallback could not prove (DOR-2322)', () => {
  // Purpose: offline, a file the package changed between versions matches
  // nothing. It must be listed as unproven (kept as the person's, but named),
  // with the commit to compare against later, never silently counted as theirs.
  // Fails if `unproven` is missing, lists a matched file, or loses `from`.
  it('lists every live file it could not tie to the package, and the commit to check later', async () => {
    const root = await legacyInstall({
      '.dork/manifest.json': '{}',
      'same.md': 's',
      'changed.md': 'old',
      'mine.txt': 'mine',
    });
    const fetcher = { fetchAtCommit: vi.fn(async () => Promise.reject(new Error('offline'))) };
    const newTree = await tree({
      '.dork/manifest.json': '{}',
      'same.md': 's',
      'changed.md': 'new',
    });

    const record = await rebuildInstalledFiles(root, { fetcher, logger: noopLogger }, newTree);

    expect(record.unproven).toEqual({
      why: 'fetch-failed',
      from: {
        name: 'flow',
        commitSha: SHA,
        sourceKey: {
          cloneUrl: 'https://github.com/dork-labs/marketplace',
          subpath: 'plugins/flow',
          ref: 'main',
        },
      },
      files: { 'changed.md': 'changed.md', 'mine.txt': 'mine.txt' },
    });
    // Written as it was returned, so a later Check files can read it.
    expect((await readInstalledFiles(root))?.unproven).toEqual(record.unproven);
  });

  // Purpose: the reason travels with the list, because what the person can do
  // differs. A local-folder install has nothing to fetch later (no `from`); a
  // fetched tree rejected by the tolerance keeps `from`.
  it('says why nothing could be proven: no source, or a rejected tree', async () => {
    const local = await legacyInstall({ 'a.md': 'a', 'b.md': 'b' }, false);
    const noSource = await rebuildInstalledFiles(
      local,
      { logger: noopLogger },
      await tree({ 'a.md': 'a' })
    );
    expect(noSource.unproven).toEqual({ why: 'no-source', files: { 'b.md': 'b.md' } });

    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.md`] = `v${i}`;
    const root = await legacyInstall(files);
    const wrongTree = await tree({ ...files, 'f0.md': 'x', 'f1.md': 'x', 'f2.md': 'x' });
    const rejected = await rebuildInstalledFiles(root, {
      fetcher: fetcherFor(wrongTree),
      logger: noopLogger,
    });
    expect(rejected.unproven?.why).toBe('mismatch');
    expect(rejected.unproven?.from?.commitSha).toBe(SHA);
    expect(Object.keys(rejected.unproven?.files ?? {}).sort()).toEqual(['f0.md', 'f1.md', 'f2.md']);
  });

  // Purpose: nothing is unproven when the exact commit proved the record, even
  // with edits inside the tolerance: those files are the package's by path, so
  // an update saves the person's edit beside the new copy.
  it('lists nothing when the installed commit proved the record', async () => {
    const files = { 'a.md': 'a', 'b.md': 'b' };
    const root = await legacyInstall(files);
    await put(root, 'a.md', 'edited');
    await put(root, 'mine.txt', 'mine');
    const record = await rebuildInstalledFiles(root, {
      fetcher: fetcherFor(await tree(files)),
      logger: noopLogger,
    });
    expect(record.inferred).toBeUndefined();
    expect(record.unproven).toBeUndefined();
  });

  // Purpose: the strict rule is tried first and shared with Check files, so the
  // two cannot drift. An exact match logs that it held; a tolerated one says so.
  it('tries the strict rebuild first and logs which proof held', async () => {
    const files = { 'a.md': 'a', 'b.md': 'b' };
    const exactRoot = await legacyInstall(files);
    const info = vi.fn();
    const logger = { ...noopLogger, info };
    await rebuildInstalledFiles(exactRoot, { fetcher: fetcherFor(await tree(files)), logger });
    expect(info).toHaveBeenCalledWith(
      '[marketplace/legacy-record] rebuilt a record from the installed commit',
      expect.objectContaining({ proof: 'exact' })
    );

    info.mockClear();
    const editedRoot = await legacyInstall(files);
    await put(editedRoot, 'a.md', 'edited');
    await rebuildInstalledFiles(editedRoot, { fetcher: fetcherFor(await tree(files)), logger });
    expect(info).toHaveBeenCalledWith(
      '[marketplace/legacy-record] rebuilt a record from the installed commit',
      expect.objectContaining({ proof: 'tolerant', differing: 1 })
    );
  });
});
