/**
 * Every package type keeps the person's files across a reinstall (DOR-2245).
 *
 * Drives the real installer, all five real install flows and the real
 * transaction against the shared valid fixtures. This is the bug the item was
 * filed for (flow's `config/config.json` reset by every update), checked for
 * every package type rather than only flow's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
