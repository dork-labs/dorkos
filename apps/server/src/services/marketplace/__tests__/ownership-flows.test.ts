/**
 * Every package type keeps the person's files across a reinstall (DOR-2245).
 *
 * Drives the real installer, all five real install flows and the real
 * transaction against the shared valid fixtures. This is the bug the item was
 * filed for (flow's `config/config.json` reset by every update), checked for
 * every package type rather than only flow's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initBoundary } from '../../../lib/boundary.js';
import { buildInstallerForTests } from './installer-harness.js';
import { readInstalledFiles } from '../lib/installed-files.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

let dorkHome: string;
beforeEach(async () => {
  dorkHome = await mkdtemp(path.join(tmpdir(), 'ownership-flows-'));
  // Local installs resolve inside the boundary; the fixtures are the root.
  await initBoundary(FIXTURES_DIR);
});
afterEach(async () => {
  await rm(dorkHome, { recursive: true, force: true });
});

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe.each(['valid-plugin', 'valid-agent', 'valid-skill-pack', 'valid-adapter', 'valid-shape'])(
  '%s',
  (fixture) => {
    // Purpose: a person's own file and the package's data dir survive a
    // reinstall of every package type, and neither enters the record.
    it("keeps the person's files across a reinstall", async () => {
      const harness = buildInstallerForTests(dorkHome);
      const first = await harness.installer.install({ name: path.join(FIXTURES_DIR, fixture) });
      const root = first.installPath;

      expect((await stat(path.join(root, '.dork', 'data'))).isDirectory()).toBe(true);
      await put(root, 'config/mine.json', '{"mine":true}');
      await put(root, '.dork/data/state.json', '{"n":1}');

      const second = await harness.installer.install({ name: path.join(FIXTURES_DIR, fixture) });

      expect(second.installPath).toBe(root);
      expect(await readFile(path.join(root, 'config', 'mine.json'), 'utf8')).toBe('{"mine":true}');
      expect(await readFile(path.join(root, '.dork', 'data', 'state.json'), 'utf8')).toBe(
        '{"n":1}'
      );
      const record = await readInstalledFiles(root);
      expect(record).not.toBeNull();
      expect(record!.files['config/mine.json']).toBeUndefined();
      expect(record!.package.source).toEqual({ localPath: path.join(FIXTURES_DIR, fixture) });
      const siblings = await readdir(path.dirname(root));
      expect(siblings.filter((s) => s.startsWith(path.basename(root)))).toEqual([
        path.basename(root),
      ]);
    });
  }
);

describe('notices on the install result', () => {
  // Purpose: an edited shipped file is reported on fileNotices and as a sentence.
  it('reports a replaced edit on fileNotices and warnings', async () => {
    const harness = buildInstallerForTests(dorkHome);
    const first = await harness.installer.install({
      name: path.join(FIXTURES_DIR, 'valid-plugin'),
    });
    const record = await readInstalledFiles(first.installPath);
    const shipped = Object.keys(record!.files).find((p) => !p.startsWith('.dork/'))!;
    await put(first.installPath, shipped, 'my edit');

    const second = await harness.installer.install({
      name: path.join(FIXTURES_DIR, 'valid-plugin'),
    });

    expect(second.fileNotices).toEqual([
      { path: shipped, outcome: 'replaced-edit', savedAs: `${shipped}.dork-old` },
    ]);
    expect(second.warnings).toContain(
      `You had changed ${shipped}. The new version replaced it; your copy is at ${shipped}.dork-old.`
    );
  });
});

describe('update (uninstall then install, DOR-2245 §6)', () => {
  // Purpose: an update keeps the person's files, reports a replaced edit, and
  // uses no scratch directory in os.tmpdir().
  it("keeps the person's files across an update and uses no temp scratch dir", async () => {
    const harness = buildInstallerForTests(dorkHome);
    const name = path.join(FIXTURES_DIR, 'valid-plugin');
    const first = await harness.installer.install({ name });
    const root = first.installPath;
    const record = await readInstalledFiles(root);
    const shipped = '.dork/tasks/sample-task/SKILL.md';
    expect(record!.files[shipped]).toBeDefined();
    await put(root, 'config/mine.json', 'mine');
    await put(root, shipped, 'edited');
    const tmpBefore = (await readdir(tmpdir())).filter((n) =>
      n.startsWith('dorkos-update-preserve-')
    );

    const result = await harness.installer.update({ name });

    expect(await readFile(path.join(root, 'config', 'mine.json'), 'utf8')).toBe('mine');
    expect(await readFile(path.join(root, `${shipped}.dork-old`), 'utf8')).toBe('edited');
    expect(result.fileNotices?.[0]).toMatchObject({ path: shipped, outcome: 'replaced-edit' });
    const tmpAfter = (await readdir(tmpdir())).filter((n) =>
      n.startsWith('dorkos-update-preserve-')
    );
    expect(tmpAfter).toEqual(tmpBefore);
    expect(await readdir(path.dirname(root))).toEqual([path.basename(root)]);
  });

  // Purpose: a failed install half leaves exactly the person's files and the record.
  it("leaves the person's files in place when the install half fails", async () => {
    const harness = buildInstallerForTests(dorkHome);
    const name = path.join(FIXTURES_DIR, 'valid-plugin');
    const { installPath: root } = await harness.installer.install({ name });
    await put(root, 'config/mine.json', 'mine');
    const realInstall = harness.installer.install.bind(harness.installer);
    let calls = 0;
    harness.installer.install = async (req) => {
      calls++;
      if (calls === 1) throw new Error('install half failed');
      return realInstall(req);
    };
    await expect(harness.installer.update({ name })).rejects.toThrow('install half failed');
    expect(await readFile(path.join(root, 'config', 'mine.json'), 'utf8')).toBe('mine');
    expect((await readInstalledFiles(root))?.uninstalledAt).toBeDefined();
  });
});

describe('agent identity across sources (DOR-2245 §8)', () => {
  // Purpose (review N4): a same-named agent package from a different source
  // never inherits the earlier agent; its identity files are set aside.
  it('sets the identity files aside when the source changes, and keeps them when it does not', async () => {
    const harness = buildInstallerForTests(dorkHome);
    const first = await harness.installer.install({ name: path.join(FIXTURES_DIR, 'valid-agent') });
    const root = first.installPath;
    await put(root, '.dork/agent.json', '{"id":"01OLD"}');
    await put(root, '.dork/MEMORY.md', 'old notes');

    const same = await harness.installer.install({ name: path.join(FIXTURES_DIR, 'valid-agent') });
    expect(await readFile(path.join(root, '.dork', 'agent.json'), 'utf8')).toBe('{"id":"01OLD"}');
    expect(same.warnings.join(' ')).not.toMatch(/different source/);

    // A copy of the package at another path: the same name, a different source.
    const otherSource = path.join(dorkHome, 'elsewhere', 'valid-agent');
    await cp(path.join(FIXTURES_DIR, 'valid-agent'), otherSource, { recursive: true });
    await initBoundary(path.dirname(dorkHome));
    try {
      const other = await harness.installer.install({ name: otherSource });
      expect(await readFile(path.join(root, '.dork', 'agent.json.dork-old'), 'utf8')).toBe(
        '{"id":"01OLD"}'
      );
      expect(await readFile(path.join(root, '.dork', 'MEMORY.md.dork-old'), 'utf8')).toBe(
        'old notes'
      );
      expect(other.warnings.join(' ')).toMatch(/came from a different source/);
    } finally {
      await initBoundary(FIXTURES_DIR);
    }
  });
});

describe('an install made before records existed (DOR-2245 §9)', () => {
  // Purpose: the legacy path. With no record and no fetchable commit (a local
  // install), a reinstall keeps the person's file, replaces the package's own
  // unchanged files silently, and names what it kept.
  it("keeps the person's files over a legacy install and says so", async () => {
    const harness = buildInstallerForTests(dorkHome);
    const name = path.join(FIXTURES_DIR, 'valid-plugin');
    const { installPath: root } = await harness.installer.install({ name });
    await rm(path.join(root, '.dork', 'installed-files.json'));
    await put(root, 'config/config.json', '{"team":"DOR"}');

    const result = await harness.installer.install({ name });

    expect(await readFile(path.join(root, 'config', 'config.json'), 'utf8')).toBe('{"team":"DOR"}');
    expect(result.fileNotices ?? []).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/Kept 1 item .*: config\. /);
    expect((await readInstalledFiles(root))?.inferred).toBeUndefined();
  });
});
