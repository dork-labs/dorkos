/**
 * The background sweep that gives legacy installs a record after boot
 * (DOR-2197 §6): it rebuilds only installs with a package identity and no
 * record, one at a time, and one failure never stops the rest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { rebuildLegacyRecords, legacySweepDirs } from '../legacy-record-sweep.js';
import * as strict from '../strict-record.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'legacy-sweep-'));
  dirs.push(d);
  return d;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe('rebuildLegacyRecords', () => {
  // Purpose: only a legacy install (identity, no record) is handed to the
  // strict rebuild; recorded installs, plain folders, install siblings and
  // symlinked installs are never touched.
  it('rebuilds only legacy installs', async () => {
    const plugins = path.join(await tmp(), 'plugins');
    await put(plugins, 'legacy/.dork/manifest.json', '{}');
    await put(plugins, 'recorded/.dork/manifest.json', '{}');
    await put(plugins, 'recorded/.dork/installed-files.json', '{}');
    await put(plugins, 'leftovers/config/mine.json', 'mine');
    await put(plugins, 'legacy.dorkos-bak-1-2-3/.dork/manifest.json', '{}');
    const elsewhere = await tmp();
    await put(elsewhere, '.dork/manifest.json', '{}');
    await symlink(elsewhere, path.join(plugins, 'linked'));
    const spy = vi
      .spyOn(strict, 'rebuildRecordStrict')
      .mockResolvedValue({ outcome: 'rebuilt', files: 1 });

    const summary = await rebuildLegacyRecords([plugins, path.join(plugins, 'missing-dir')], {
      fetcher: { fetchAtCommit: vi.fn() },
      logger: noopLogger,
    });

    expect(spy.mock.calls.map(([root]) => path.basename(root))).toEqual(['legacy']);
    expect(summary).toEqual({
      rebuilt: [path.join(plugins, 'legacy')],
      mismatch: [],
      noSource: [],
      fetchFailed: [],
    });
  });

  // Purpose: one install that cannot be rebuilt, or whose rebuild throws, never
  // stops the sweep; each outcome is counted where it belongs.
  it('carries on past failures and sorts each outcome', async () => {
    const plugins = path.join(await tmp(), 'plugins');
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      await put(plugins, `${name}/.dork/manifest.json`, '{}');
    vi.spyOn(strict, 'rebuildRecordStrict').mockImplementation(async (root) => {
      switch (path.basename(root)) {
        case 'a':
          return { outcome: 'mismatch', differing: ['x'] };
        case 'b':
          throw new Error('disk on fire');
        case 'c':
          return { outcome: 'no-source' };
        case 'd':
          return { outcome: 'fetch-failed', message: 'offline' };
        default:
          return { outcome: 'rebuilt', files: 2 };
      }
    });

    const summary = await rebuildLegacyRecords([plugins], {
      fetcher: { fetchAtCommit: vi.fn() },
      logger: noopLogger,
    });

    expect(summary).toEqual({
      rebuilt: [path.join(plugins, 'e')],
      mismatch: [path.join(plugins, 'a')],
      noSource: [path.join(plugins, 'c')],
      fetchFailed: [path.join(plugins, 'b'), path.join(plugins, 'd')],
    });
  });

  // Purpose: installs are rebuilt one after another (one fetch at a time),
  // never in parallel.
  it('rebuilds one install at a time', async () => {
    const plugins = path.join(await tmp(), 'plugins');
    for (const name of ['a', 'b', 'c']) await put(plugins, `${name}/.dork/manifest.json`, '{}');
    let running = 0;
    let most = 0;
    vi.spyOn(strict, 'rebuildRecordStrict').mockImplementation(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { outcome: 'rebuilt', files: 1 };
    });
    await rebuildLegacyRecords([plugins], {
      fetcher: { fetchAtCommit: vi.fn() },
      logger: noopLogger,
    });
    expect(most).toBe(1);
  });
});

describe('legacySweepDirs', () => {
  // Purpose: the sweep reads install roots only (plugins, agents, shapes), for
  // the global scope and every project, never a skills root.
  it('lists install roots for the global scope and each project', async () => {
    const home = await tmp();
    const project = await tmp();
    const listed = legacySweepDirs(home, [project]);
    expect(listed).toContain(path.join(home, 'plugins'));
    expect(listed).toContain(path.join(home, 'agents'));
    expect(listed).toContain(path.join(project, '.dork', 'plugins'));
    expect(listed.some((d) => d.endsWith('skills'))).toBe(false);
    expect(await readdir(home)).toEqual([]);
  });
});
