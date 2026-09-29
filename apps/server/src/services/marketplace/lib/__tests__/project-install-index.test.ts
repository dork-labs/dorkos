import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  describe('forgetting', () => {
    let project: string;

    beforeEach(async () => {
      project = await mkdtemp(join(tmpdir(), 'project-install-index-project-'));
    });

    afterEach(async () => {
      await rm(project, { recursive: true, force: true });
    });

    /** A record for `name` inside the real temp project. */
    const inProject = (name: string, commitSha = 'a'.repeat(40)) => ({
      projectPath: project,
      installRoot: join(project, '.dork', 'plugins', name),
      name,
      commitSha,
    });

    it('forgets a record whose install folder is still gone', async () => {
      const flow = inProject('flow');
      const lint = inProject('lint');
      await recordProjectInstall(dorkHome, flow);
      await recordProjectInstall(dorkHome, lint);

      await forgetProjectInstalls(dorkHome, [flow]);

      expect(await readProjectInstalls(dorkHome)).toEqual([lint]);
    });

    it('keeps a record a reinstall wrote after the sweep read the old one', async () => {
      // Purpose: the review's repro. The sweep saw commit b gone; before it
      // dropped the record, a reinstall recorded commit c. Dropping by folder
      // alone lost c's record, and the next sweep deleted c's tree.
      const stale = inProject('flow', 'b'.repeat(40));
      await recordProjectInstall(dorkHome, stale);
      const fresh = inProject('flow', 'c'.repeat(40));
      await recordProjectInstall(dorkHome, fresh);

      await forgetProjectInstalls(dorkHome, [stale]);

      expect(await readProjectInstalls(dorkHome)).toEqual([fresh]);
    });

    it('keeps a record whose install folder came back', async () => {
      // Purpose: a reinstall of the same commit recreates the folder; the
      // record is live again even though it matches what the sweep read.
      const flow = inProject('flow');
      await recordProjectInstall(dorkHome, flow);
      await mkdir(flow.installRoot, { recursive: true });

      await forgetProjectInstalls(dorkHome, [flow]);

      expect(await readProjectInstalls(dorkHome)).toEqual([flow]);
    });
  });

  it('refuses an index it cannot make sense of, rather than reading it as empty', async () => {
    // Purpose: "empty" would let a sweep delete what every project install records.
    await mkdir(join(dorkHome, 'marketplace'), { recursive: true });
    await writeFile(join(dorkHome, 'marketplace', 'project-installs.json'), '{"version":1,');

    await expect(readProjectInstalls(dorkHome)).rejects.toThrow(/Can't make sense of/);
  });

  it('moves an unparseable index aside at the next record, so recording recovers', async () => {
    // Purpose: a truncated file must not stop every later install from being
    // recorded. The bad copy is kept beside it for a person to look at.
    const dir = join(dorkHome, 'marketplace');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'project-installs.json'), '{"version":1,');

    await recordProjectInstall(dorkHome, record('/work/app/.dork/plugins/flow'));

    expect(await readProjectInstalls(dorkHome)).toEqual([record('/work/app/.dork/plugins/flow')]);
    const aside = (await readdir(dir)).filter((f) =>
      f.startsWith('project-installs.json.corrupt-')
    );
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir, aside[0]!), 'utf-8')).toBe('{"version":1,');
  });

  it('does not move a corrupt index aside when only forgetting', async () => {
    // Purpose: recovery belongs to the install path; a sweep must keep refusing.
    const dir = join(dorkHome, 'marketplace');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'project-installs.json'), 'nope');

    await expect(
      forgetProjectInstalls(dorkHome, [record('/work/app/.dork/plugins/flow')])
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['project-installs.json']);
  });
});
