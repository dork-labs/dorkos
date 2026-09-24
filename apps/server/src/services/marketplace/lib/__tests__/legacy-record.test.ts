/**
 * Rebuilding the record of an install made before records existed (DOR-2245
 * §9): from the installed commit when it can be fetched and trusted, else by
 * matching bytes against trees DorkOS can obtain. Real temp dirs; the fetcher
 * is a fake at its seam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
