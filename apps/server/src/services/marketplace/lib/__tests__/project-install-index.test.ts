import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgetProjectInstalls,
  readProjectInstalls,
  recordProjectInstall,
} from '../project-install-index.js';

describe('project install index', () => {
  let dorkHome: string;
  const record = (installRoot: string, commitSha = 'a'.repeat(40)) => ({
    projectPath: '/work/app',
    installRoot,
    name: 'flow',
    commitSha,
    subpath: 'plugins/flow',
  });

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'project-install-index-'));
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('reads as empty before anything was recorded', async () => {
    expect(await readProjectInstalls(dorkHome)).toEqual([]);
  });

  it('records installs, and a reinstall replaces the earlier record', async () => {
    // Purpose: an applied update rewrites the same install root; two records
    // for one root would keep the superseded commit protected for ever.
    await recordProjectInstall(dorkHome, record('/work/app/.dork/plugins/flow'));
    await recordProjectInstall(dorkHome, record('/work/app/.dork/plugins/lint'));
    await recordProjectInstall(dorkHome, record('/work/app/.dork/plugins/flow', 'b'.repeat(40)));

    const installs = await readProjectInstalls(dorkHome);
    expect(installs).toHaveLength(2);
    expect(installs.find((r) => r.installRoot.endsWith('flow'))?.commitSha).toBe('b'.repeat(40));
  });

  it('keeps every record when many installs land at once', async () => {
    // Purpose: writes are read-modify-write; unserialised, concurrent
    // installs would overwrite each other's records.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        recordProjectInstall(dorkHome, record(`/work/app/.dork/plugins/p${i}`))
      )
    );
    expect(await readProjectInstalls(dorkHome)).toHaveLength(12);
  });

  it('forgets only the install roots it is given', async () => {
    await recordProjectInstall(dorkHome, record('/work/app/.dork/plugins/flow'));
    await recordProjectInstall(dorkHome, record('/work/app/.dork/plugins/lint'));

    await forgetProjectInstalls(dorkHome, ['/work/app/.dork/plugins/flow']);

    expect((await readProjectInstalls(dorkHome)).map((r) => r.installRoot)).toEqual([
      '/work/app/.dork/plugins/lint',
    ]);
  });

  it('refuses an index it cannot make sense of, rather than reading it as empty', async () => {
    // Purpose: "empty" would let a sweep delete what every project install records.
    await mkdir(join(dorkHome, 'marketplace'), { recursive: true });
    await writeFile(join(dorkHome, 'marketplace', 'project-installs.json'), '{"version":1,');

    await expect(readProjectInstalls(dorkHome)).rejects.toThrow(/Can't make sense of/);
    await expect(
      recordProjectInstall(dorkHome, record('/work/app/.dork/plugins/flow'))
    ).rejects.toThrow();
    // The unreadable file is left for a person to look at, not overwritten.
    expect(await readFile(join(dorkHome, 'marketplace', 'project-installs.json'), 'utf-8')).toBe(
      '{"version":1,'
    );
  });
});
