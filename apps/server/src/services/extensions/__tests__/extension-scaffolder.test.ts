/**
 * Real-filesystem tests for {@link scaffoldExtension}.
 *
 * The extension name becomes a directory name, so these tests drive the real
 * scaffolder against a real temp tree and assert that nothing is ever written
 * outside the extensions folder (DOR-507).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { scaffoldExtension } from '../extension-scaffolder.js';

let tmpRoot: string;
let dorkHome: string;
let projectDir: string;
let outsideDir: string;

/** Every path in `dir`, relative and sorted, walked recursively. */
async function listTree(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-ext-scaffold-'));
  dorkHome = path.join(tmpRoot, 'home');
  projectDir = path.join(tmpRoot, 'project');
  outsideDir = path.join(tmpRoot, 'outside');
  await fs.mkdir(dorkHome);
  await fs.mkdir(projectDir);
  await fs.mkdir(outsideDir);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('scaffoldExtension', () => {
  it('scaffolds a global extension into the extensions folder', async () => {
    const result = await scaffoldExtension({
      name: 'my-widget',
      template: 'dashboard-card',
      scope: 'global',
      dorkHome,
      currentCwd: null,
    });

    expect(result.targetDir).toBe(path.join(dorkHome, 'extensions', 'my-widget'));
    expect(result.files).toEqual(['extension.json', 'index.ts']);
    expect(await listTree(result.targetDir)).toEqual(['extension.json', 'index.ts']);
  });

  it('scaffolds a local extension under the working directory', async () => {
    const result = await scaffoldExtension({
      name: 'local-ext',
      template: 'command',
      scope: 'local',
      dorkHome,
      currentCwd: projectDir,
    });

    expect(result.targetDir).toBe(path.join(projectDir, '.dork', 'extensions', 'local-ext'));
  });

  // ── Traversal (DOR-507 part 2) ───────────────────────────────────────────
  //
  // Each name is a different way to try to leave the extensions folder. The
  // assertion is not just "it threw" but "the temp tree is untouched": a check
  // that only rejects the name string would pass the first and fail the second.

  const escapes: Array<[label: string, name: string]> = [
    ['parent traversal', '../escape'],
    ['double parent traversal', '../../escape'],
    ['traversal with trailing slash', '../escape/'],
    ['absolute path', path.join(os.tmpdir(), 'dorkos-absolute-escape')],
    ['absolute posix path', '/etc/dorkos-escape'],
    ['url-encoded traversal', '..%2fescape'],
    ['name that normalizes into an escape', 'ok/../../escape'],
    ['nested path', 'nested/child'],
    ['backslash traversal', '..\\escape'],
    ['dot', '.'],
    ['dot dot', '..'],
    ['empty string', ''],
    ['whitespace', '   '],
    ['dot file', '.hidden'],
    ['tilde home', '~/escape'],
    ['null byte', 'evil\0name'],
    ['unicode one-dot leaders', '․․/escape'],
    ['unicode fullwidth stops', '．．/escape'],
    ['unicode fullwidth solidus', '..／escape'],
    ['non-ascii name', 'ｅｖｉｌ'],
    ['uppercase', 'MyWidget'],
  ];

  for (const scope of ['global', 'local'] as const) {
    for (const [label, name] of escapes) {
      it(`refuses a ${scope} extension named by ${label} and writes nothing`, async () => {
        const before = await listTree(tmpRoot);

        await expect(
          scaffoldExtension({
            name,
            template: 'dashboard-card',
            scope,
            dorkHome,
            currentCwd: projectDir,
          })
        ).rejects.toThrow(/Invalid extension name/);

        expect(await listTree(tmpRoot)).toEqual(before);
        expect(await listTree(outsideDir)).toEqual([]);
      });
    }
  }

  it('refuses to overwrite an extension that already exists', async () => {
    await scaffoldExtension({
      name: 'twice',
      template: 'dashboard-card',
      scope: 'global',
      dorkHome,
      currentCwd: null,
    });

    await expect(
      scaffoldExtension({
        name: 'twice',
        template: 'dashboard-card',
        scope: 'global',
        dorkHome,
        currentCwd: null,
      })
    ).rejects.toThrow("Extension 'twice' already exists");
  });
});
