/**
 * End-to-end: a package cannot use symbolic links to make the install preview
 * read a file outside the package (DOR-2319).
 *
 * Before staging, the preview reads the package where it is. A SKILL.md,
 * hooks.json or README that is a link to a host file (a key, DorkOS's own
 * config) would otherwise be read, and its text could surface in a parse
 * error or the preview itself. This drives the real validator, preview
 * builder and conflict detector over a package on disk whose files link to a
 * host file holding a marker, and proves the marker appears nowhere.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { ConflictDetector } from '../conflict-detector.js';
import { MarketplaceInstaller, type InstallerDeps } from '../marketplace-installer.js';
import { PermissionPreviewBuilder } from '../permission-preview.js';

const SECRET = 'host-secret-5e8d';

let root: string;
let packagePath: string;
let dorkHome: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dorkos-package-links-'));
  packagePath = path.join(root, 'linky');
  dorkHome = path.join(root, 'dork-home');
  const host = path.join(root, 'host-secret.txt');
  await writeFile(
    host,
    `---\nname: ${SECRET}\nschedule: { cron: '${SECRET}' }\n---\n{"hooks": "${SECRET}"}\n`
  );
  await mkdir(dorkHome, { recursive: true });
  await mkdir(path.join(packagePath, '.dork', 'tasks', 'nightly'), { recursive: true });
  await mkdir(path.join(packagePath, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(packagePath, 'hooks'), { recursive: true });
  await writeFile(
    path.join(packagePath, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'linky',
      version: '1.0.0',
      type: 'plugin',
      description: 'A package whose files link out of it',
      license: 'MIT',
      tags: [],
      layers: [],
    })
  );
  await writeFile(
    path.join(packagePath, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'linky', version: '1.0.0' })
  );
  await symlink(host, path.join(packagePath, '.dork', 'tasks', 'nightly', 'SKILL.md'));
  await symlink(host, path.join(packagePath, 'hooks', 'hooks.json'));
  await symlink(host, path.join(packagePath, 'README.md'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function previewBuilder(): PermissionPreviewBuilder {
  return new PermissionPreviewBuilder(
    dorkHome,
    new ConflictDetector(dorkHome, {} as AdapterManager)
  );
}

describe('a package that links to a host file (DOR-2319)', () => {
  // Purpose: the install preview refuses the linked files, and nothing it
  // returns or throws carries the host file's text.
  it('never surfaces the host file through the install preview', async () => {
    const unused = new Proxy(
      {},
      {
        get: () => {
          throw new Error('an install flow must not run during a preview');
        },
      }
    );
    const installer = new MarketplaceInstaller({
      dorkHome,
      resolver: {
        resolve: vi
          .fn()
          .mockResolvedValue({ kind: 'local', packageName: 'linky', localPath: packagePath }),
      } as unknown as InstallerDeps['resolver'],
      fetcher: unused as InstallerDeps['fetcher'],
      previewBuilder: previewBuilder(),
      pluginFlow: unused as InstallerDeps['pluginFlow'],
      agentFlow: unused as InstallerDeps['agentFlow'],
      skillPackFlow: unused as InstallerDeps['skillPackFlow'],
      adapterFlow: unused as InstallerDeps['adapterFlow'],
      shapeFlow: unused as InstallerDeps['shapeFlow'],
      uninstallFlow: unused as InstallerDeps['uninstallFlow'],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const outcome = await installer.preview({ name: 'linky' }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );

    const seen = JSON.stringify(outcome, (_key, value: unknown) =>
      value instanceof Error ? { ...value, message: value.message } : value
    );
    expect(seen).not.toContain(SECRET);
    expect(seen).toMatch(/symbolic link/);
  });

  // Purpose: built directly (as a package detail page does), the preview
  // reports the linked hooks file unreadable and shows no schedule from the
  // linked task.
  it('reports the linked declarations unreadable and reads nothing from them', async () => {
    const preview = await previewBuilder().build(packagePath, {
      schemaVersion: 1,
      name: 'linky',
      version: '1.0.0',
      type: 'plugin',
      description: 'x',
      tags: [],
      layers: [],
      requires: [],
      schedules: [],
    } as never);

    expect(JSON.stringify(preview)).not.toContain(SECRET);
    expect(preview.schedules).toEqual([]);
    expect(
      preview.unreadableHooks.some((h) => h.path === 'hooks/hooks.json') ||
        preview.unreadableDeclarations.some((d) => d.path === 'hooks/hooks.json')
    ).toBe(true);
  });

  // Purpose: a linked skill folder, as some official plugins ship, is named
  // in the preview rather than silently missing once installed.
  it('names each shortcut in the preview', async () => {
    const shared = path.join(root, 'shared', 'neon-postgres');
    await mkdir(shared, { recursive: true });
    await writeFile(path.join(shared, 'SKILL.md'), '---\nname: neon-postgres\n---\n');
    await mkdir(path.join(packagePath, 'skills'), { recursive: true });
    await symlink(shared, path.join(packagePath, 'skills', 'neon-postgres'));

    const preview = await previewBuilder().build(packagePath, {
      schemaVersion: 1,
      name: 'linky',
      version: '1.0.0',
      type: 'plugin',
      description: 'x',
      tags: [],
      layers: [],
      requires: [],
      schedules: [],
    } as never);

    expect(preview.skippedLinks).toContainEqual({
      path: 'skills/neon-postgres',
      message:
        "skills/neon-postgres is a shortcut to a folder outside the package, so it won't be installed.",
    });
  });
});
