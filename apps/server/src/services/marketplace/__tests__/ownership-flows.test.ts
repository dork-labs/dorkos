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
import { noopLogger } from '@dorkos/shared/logger';
import { buildInstallerForTests } from './installer-harness.js';
import { UninstallFlow } from '../flows/uninstall.js';
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
    // Since DOR-2195 the update installs the version it staged and checked,
    // through the private installStaged, so that is where the failure goes.
    const installer = harness.installer as unknown as {
      installStaged: (...args: unknown[]) => Promise<unknown>;
    };
    installer.installStaged = async () => {
      throw new Error('install half failed');
    };
    await expect(harness.installer.update({ name })).rejects.toThrow('install half failed');
    // What survives a failure the early checks cannot see (npm, the disk): the
    // package is uninstalled, the person's file and the pruned record stay,
    // and nothing is left beside the root.
    expect(await readFile(path.join(root, 'config', 'mine.json'), 'utf8')).toBe('mine');
    const record = await readInstalledFiles(root);
    expect(record?.uninstalledAt).toBeDefined();
    expect(record?.files).toEqual({});
    await expect(stat(path.join(root, '.dork', 'manifest.json'))).rejects.toThrow();
    expect(await readdir(path.dirname(root))).toEqual([path.basename(root)]);

    // A retry installs cleanly over what was left and keeps the person's file.
    delete (installer as { installStaged?: unknown }).installStaged;
    await harness.installer.install({ name });
    expect(await readFile(path.join(root, 'config', 'mine.json'), 'utf8')).toBe('mine');
    expect((await readInstalledFiles(root))?.uninstalledAt).toBeUndefined();
  });
});

describe('an update the new version can never pass (delta review 1)', () => {
  // Purpose: a check that depends only on the new version's content (here a
  // schedule timezone only croner rejects) must refuse the update BEFORE the
  // uninstall half. It used to run after it, leaving the package removed.
  it('refuses before uninstalling, so the old version is still installed', async () => {
    const source = path.join(dorkHome, 'src', 'valid-plugin');
    await cp(path.join(FIXTURES_DIR, 'valid-plugin'), source, { recursive: true });
    await initBoundary(path.dirname(dorkHome));
    try {
      const harness = buildInstallerForTests(dorkHome);
      const { installPath: root } = await harness.installer.install({ name: source });
      const shipped = '.dork/tasks/sample-task/SKILL.md';
      const before = await readFile(path.join(root, shipped), 'utf8');
      const manifestPath = path.join(source, '.dork', 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          schedules: [
            {
              name: 'nightly',
              description: 'd',
              prompt: 'p',
              cron: '0 3 * * *',
              timezone: 'Not/AZone',
            },
          ],
        })
      );

      await expect(harness.installer.update({ name: source })).rejects.toThrow(/Not\/AZone/);

      expect(await readFile(path.join(root, shipped), 'utf8')).toBe(before);
      expect(await stat(path.join(root, '.dork', 'manifest.json'))).toBeDefined();
      const record = await readInstalledFiles(root);
      expect(record?.uninstalledAt).toBeUndefined();
      expect(record?.files[shipped]).toBeDefined();
    } finally {
      await initBoundary(FIXTURES_DIR);
    }
  });
});

describe('a skill pack whose new version has a broken SKILL.md (delta review 1)', () => {
  // Purpose: an unparseable SKILL.md is known from the package's content alone,
  // so the update is refused before the uninstall and the old skills stay.
  it('refuses before uninstalling, so the old skills are still installed', async () => {
    const source = path.join(dorkHome, 'src', 'valid-skill-pack');
    await cp(path.join(FIXTURES_DIR, 'valid-skill-pack'), source, { recursive: true });
    await initBoundary(path.dirname(dorkHome));
    try {
      const harness = buildInstallerForTests(dorkHome);
      const { installPath: root } = await harness.installer.install({ name: source });
      const skill = 'skills/analyzer/SKILL.md';
      const before = await readFile(path.join(root, skill), 'utf8');
      await writeFile(path.join(source, skill), 'no frontmatter at all\n');

      await expect(harness.installer.update({ name: source })).rejects.toThrow(/Invalid SKILL\.md/);

      expect(await readFile(path.join(root, skill), 'utf8')).toBe(before);
      expect((await readInstalledFiles(root))?.uninstalledAt).toBeUndefined();
    } finally {
      await initBoundary(FIXTURES_DIR);
    }
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

describe('an agent from a different source replaces a registered one (code review 5)', () => {
  // Purpose: installing a different package over a still-registered agent must
  // take the old agent off the team with the full cascade (schedules, grants,
  // room seats) BEFORE its identity is set aside; a silent id swap orphans them
  // (DOR-1791 F1). A same-source reinstall keeps the agent registered.
  it('unregisters the earlier agent before setting its identity aside', async () => {
    const harness = buildInstallerForTests(dorkHome);
    const first = await harness.installer.install({ name: path.join(FIXTURES_DIR, 'valid-agent') });
    const root = first.installPath;
    await put(root, '.dork/agent.json', '{"id":"01OLD"}');
    const seenAtCall: string[] = [];
    harness.spies.agentUnregister.mockImplementation(async (at: string) => {
      seenAtCall.push(await readFile(path.join(at, '.dork', 'agent.json'), 'utf8'));
      return { id: '01OLD', directoryDenied: false };
    });

    await harness.installer.install({ name: path.join(FIXTURES_DIR, 'valid-agent') });
    expect(harness.spies.agentUnregister).not.toHaveBeenCalled();

    const otherSource = path.join(dorkHome, 'elsewhere', 'valid-agent');
    await cp(path.join(FIXTURES_DIR, 'valid-agent'), otherSource, { recursive: true });
    await initBoundary(path.dirname(dorkHome));
    try {
      await harness.installer.install({ name: otherSource });
    } finally {
      await initBoundary(FIXTURES_DIR);
    }
    expect(harness.spies.agentUnregister).toHaveBeenCalledTimes(1);
    expect(harness.spies.agentUnregister).toHaveBeenCalledWith(root);
    expect(seenAtCall).toEqual(['{"id":"01OLD"}']);
  });
});

describe('an agent package that ships identity seeds (code review 1)', () => {
  // Purpose: a package shipping SOUL.md, MEMORY.md and agent.json seeds must
  // never overwrite the agent's own copies on update, nor set them aside.
  it("keeps the agent's SOUL.md, MEMORY.md and agent.json across an update", async () => {
    const source = path.join(dorkHome, 'src', 'valid-agent');
    await cp(path.join(FIXTURES_DIR, 'valid-agent'), source, { recursive: true });
    await put(source, '.dork/SOUL.md', 'shipped v1');
    await put(source, '.dork/MEMORY.md', 'shipped memory v1');
    await initBoundary(path.dirname(dorkHome));
    try {
      const harness = buildInstallerForTests(dorkHome);
      const { installPath: root } = await harness.installer.install({ name: source });
      const agentJson = '{"id":"01MINE"}';
      await put(root, '.dork/agent.json', agentJson);
      await put(root, '.dork/SOUL.md', 'mine');
      await put(root, '.dork/MEMORY.md', 'my notes');
      await put(source, '.dork/SOUL.md', 'shipped v2');
      await put(source, '.dork/MEMORY.md', 'shipped memory v2');
      await put(source, '.dork/agent.json', '{"id":"01SHIPPED"}');

      await harness.installer.update({ name: source });

      expect(await readFile(path.join(root, '.dork', 'SOUL.md'), 'utf8')).toBe('mine');
      expect(await readFile(path.join(root, '.dork', 'MEMORY.md'), 'utf8')).toBe('my notes');
      expect(await readFile(path.join(root, '.dork', 'agent.json'), 'utf8')).toBe(agentJson);
      const saved = (await readdir(path.join(root, '.dork'))).filter((n) => n.includes('.dork-'));
      expect(saved).toEqual([]);
    } finally {
      await initBoundary(FIXTURES_DIR);
    }
  });
});

describe('an install made before records existed (DOR-2245 §9)', () => {
  // Purpose: the legacy path. With no record and no fetchable commit (a local
  // install), a reinstall keeps the person's file, replaces the package's own
  // unchanged files silently, and names what it kept and why it could not tell
  // (DOR-2322). The new record remembers the kept file.
  it("keeps the person's files over a legacy install and says so", async () => {
    const harness = buildInstallerForTests(dorkHome);
    const name = path.join(FIXTURES_DIR, 'valid-plugin');
    const { installPath: root } = await harness.installer.install({ name });
    await rm(path.join(root, '.dork', 'installed-files.json'));
    await put(root, 'config/config.json', '{"team":"DOR"}');

    const result = await harness.installer.install({ name });

    expect(await readFile(path.join(root, 'config', 'config.json'), 'utf8')).toBe('{"team":"DOR"}');
    expect(result.fileNotices).toEqual([{ path: 'config/config.json', outcome: 'kept-unproven' }]);
    const said = result.warnings.join(' ');
    expect(said).toMatch(/installed from a folder on this computer/);
    expect(said).toMatch(/It kept it: config\/config\.json\. Delete any you don't need\./);
    const record = await readInstalledFiles(root);
    expect(record?.inferred).toBeUndefined();
    expect(record?.unproven).toEqual({
      why: 'no-source',
      files: { 'config/config.json': 'config/config.json' },
    });
  });
});

describe('a schedule declared by skillRef (DOR-2318)', () => {
  /** A skill pack whose manifest schedules its own `analyzer` skill. */
  async function scheduledSource(): Promise<string> {
    const source = path.join(dorkHome, 'src', 'valid-skill-pack');
    await cp(path.join(FIXTURES_DIR, 'valid-skill-pack'), source, { recursive: true });
    const manifestPath = path.join(source, '.dork', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, schedules: [{ skillRef: 'analyzer', cron: '0 3 * * *' }] })
    );
    await initBoundary(path.dirname(dorkHome));
    return source;
  }
  const skill = 'skills/analyzer/SKILL.md';
  afterEach(async () => {
    await initBoundary(FIXTURES_DIR);
  });

  // Purpose: the schedule is written into the shipped SKILL.md. The record must
  // hold that file as installed, or every update calls it an edit and saves a
  // stray .dork-old.
  it('records the scheduled SKILL.md as installed, so an untouched update reports nothing', async () => {
    const source = await scheduledSource();
    const harness = buildInstallerForTests(dorkHome);
    const { installPath: root } = await harness.installer.install({ name: source });
    expect(await readFile(path.join(root, skill), 'utf8')).toMatch(/schedule:/);

    const result = await harness.installer.update({ name: source });

    expect(result.fileNotices ?? []).toEqual([]);
    expect(await readdir(path.join(root, 'skills', 'analyzer'))).toEqual(['SKILL.md']);
    expect(await readFile(path.join(root, skill), 'utf8')).toMatch(/schedule:/);
  });

  // Purpose: an uninstall removes the scheduled SKILL.md like any package file;
  // left behind, it would keep its schedule block with no package around it.
  it('is removed by an uninstall', async () => {
    const source = await scheduledSource();
    const harness = buildInstallerForTests(dorkHome);
    const { installPath: root } = await harness.installer.install({ name: source });

    const result = await new UninstallFlow({
      dorkHome,
      extensionManager: {
        disable: async () => undefined,
        forgetRunApproval: async () => undefined,
      },
      adapterManager: { removeAdapter: async () => undefined },
      logger: noopLogger,
    }).uninstall({ name: 'valid-skill-pack' });

    await expect(stat(path.join(root, skill))).rejects.toThrow();
    expect(result.preservedData).toEqual([]);
  });

  // Purpose: a schedule the person tuned by hand is still their edit: the update
  // restores the package's schedule and saves their copy beside it.
  it("still reports a person's edit to the schedule", async () => {
    const source = await scheduledSource();
    const harness = buildInstallerForTests(dorkHome);
    const { installPath: root } = await harness.installer.install({ name: source });
    const installed = await readFile(path.join(root, skill), 'utf8');
    const tuned = installed.replace('0 3 * * *', '0 5 * * *');
    expect(tuned).not.toBe(installed);
    await writeFile(path.join(root, skill), tuned);

    const result = await harness.installer.update({ name: source });

    expect(result.fileNotices).toEqual([
      { path: skill, outcome: 'replaced-edit', savedAs: `${skill}.dork-old` },
    ]);
    expect(await readFile(path.join(root, `${skill}.dork-old`), 'utf8')).toBe(tuned);
    expect(await readFile(path.join(root, skill), 'utf8')).toBe(installed);
  });
});
