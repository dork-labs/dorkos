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

  /**
   * An id must be free in BOTH scopes, because `scope` is an argument of the
   * `create_extension` MCP tool (tier `act`, no approval card) — so a per-scope
   * check is one the caller picks the outcome of by naming the scope the id
   * happens to be free in (DOR-1507).
   *
   * Both cases below were reproduced against the per-scope check before it was
   * widened, and each is the setup half of a distinct attack that the widened
   * refusal denies at the root:
   *
   * - **Re-arm** — the person's `foo` is approved and switched OFF.
   *   `createExtension` enables whatever id it scaffolds, so planting `foo` in
   *   the other scope turns the person's own approved server half back on. The
   *   planted copy never has to win discovery; the config write is the effect.
   * - **Squat** — the discovery merge ignores a project copy whose id is core or
   *   currently approved, but that guard is conditional on the approval it
   *   protects. After a REVOKE the planted copy wins the id, so re-approving the
   *   familiar name approves the agent's code.
   *
   * Both are refused by the same sentence, which is why they are asserted here
   * rather than at the manager: no directory is created, so neither attack has a
   * setup step at all.
   */
  describe('an id already taken in the other scope', () => {
    it('refuses a local extension when the name exists globally, and writes nothing', async () => {
      await scaffoldExtension({
        name: 'foo',
        template: 'dashboard-card',
        scope: 'global',
        dorkHome,
        currentCwd: projectDir,
      });
      const before = await listTree(tmpRoot);

      await expect(
        scaffoldExtension({
          name: 'foo',
          template: 'dashboard-card',
          scope: 'local',
          dorkHome,
          currentCwd: projectDir,
        })
      ).rejects.toThrow("Extension 'foo' already exists");

      // The decisive half: no project copy on disk means no squat waiting for a
      // revoke, and nothing for a later re-approval to bind to.
      expect(await listTree(tmpRoot)).toEqual(before);
      await expect(
        fs.access(path.join(projectDir, '.dork', 'extensions', 'foo'))
      ).rejects.toThrow();
    });

    it('refuses a global extension when the name exists in the project, and writes nothing', async () => {
      // The mirror direction. Asserted because the check is written per-scope and
      // a one-directional fix would pass the case above while leaving the other
      // road open.
      await scaffoldExtension({
        name: 'bar',
        template: 'dashboard-card',
        scope: 'local',
        dorkHome,
        currentCwd: projectDir,
      });
      const before = await listTree(tmpRoot);

      await expect(
        scaffoldExtension({
          name: 'bar',
          template: 'dashboard-card',
          scope: 'global',
          dorkHome,
          currentCwd: projectDir,
        })
      ).rejects.toThrow("Extension 'bar' already exists");

      expect(await listTree(tmpRoot)).toEqual(before);
    });

    it('still scaffolds a genuinely new name, in either scope', async () => {
      // The positive control. A refusal that also refused new names would pass
      // both cases above and break the tool this exists to keep useful.
      const global = await scaffoldExtension({
        name: 'brand-new',
        template: 'dashboard-card',
        scope: 'global',
        dorkHome,
        currentCwd: projectDir,
      });
      expect(await listTree(global.targetDir)).toEqual(['extension.json', 'index.ts']);

      const local = await scaffoldExtension({
        name: 'also-new',
        template: 'command',
        scope: 'local',
        dorkHome,
        currentCwd: projectDir,
      });
      expect(await listTree(local.targetDir)).toEqual(['extension.json', 'index.ts']);
    });

    it('checks only the target scope when no working directory is active', async () => {
      // With no cwd there is no project root to collide with, and a global
      // create must not start failing because one could not be resolved.
      const result = await scaffoldExtension({
        name: 'no-cwd',
        template: 'dashboard-card',
        scope: 'global',
        dorkHome,
        currentCwd: null,
      });

      expect(result.targetDir).toBe(path.join(dorkHome, 'extensions', 'no-cwd'));
    });
  });
});
