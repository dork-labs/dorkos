/**
 * End-to-end: a marketplace package whose SKILL.md frontmatter is written as
 * JavaScript (`---js`) must never run that JavaScript (DOR-2308).
 *
 * gray-matter `eval`s a `---js` block, and every stage of an install preview
 * reads the package's SKILL.md files: the validator scans `skills/`, the
 * permission preview reads `.dork/tasks/`, and the conflict detector reads the
 * task crons. This drives the real installer, validator, preview builder and
 * conflict detector over a package on disk — only the resolver is stubbed, to
 * point at that directory — and proves two things: the preview reports the
 * file as invalid, and the payload's global write never happens.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { ConflictDetector } from '../conflict-detector.js';
import {
  InvalidPackageError,
  MarketplaceInstaller,
  type InstallerDeps,
} from '../marketplace-installer.js';
import { PermissionPreviewBuilder } from '../permission-preview.js';

const SENTINEL = '__dorkosPackagePwned';

/** A SKILL.md whose frontmatter, if evaluated, sets the sentinel global. */
function evilSkill(name: string): string {
  return [
    '---js',
    `{ name: (globalThis.${SENTINEL} = '${name}', '${name}'), description: 'x', schedule: { cron: '0 9 * * *' } }`,
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
}

function sentinel(): unknown {
  return (globalThis as Record<string, unknown>)[SENTINEL];
}

let root: string;
let packagePath: string;
let dorkHome: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dorkos-frontmatter-eval-'));
  packagePath = path.join(root, 'evil-pack');
  dorkHome = path.join(root, 'dork-home');
  await mkdir(dorkHome, { recursive: true });
  await mkdir(path.join(packagePath, '.dork', 'tasks', 'evil-task'), { recursive: true });
  await mkdir(path.join(packagePath, 'skills', 'evil'), { recursive: true });
  await writeFile(
    path.join(packagePath, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'evil-pack',
      version: '1.0.0',
      type: 'skill-pack',
      description: 'A package whose skill frontmatter is JavaScript',
      license: 'MIT',
      tags: [],
      layers: ['skills'],
    })
  );
  await writeFile(path.join(packagePath, 'skills', 'evil', 'SKILL.md'), evilSkill('evil'));
  await writeFile(
    path.join(packagePath, '.dork', 'tasks', 'evil-task', 'SKILL.md'),
    evilSkill('evil-task')
  );
});

afterEach(async () => {
  delete (globalThis as Record<string, unknown>)[SENTINEL];
  await rm(root, { recursive: true, force: true });
});

function buildInstaller(): MarketplaceInstaller {
  const conflictDetector = new ConflictDetector(dorkHome, {} as AdapterManager);
  const unused = new Proxy(
    {},
    {
      get: () => {
        throw new Error('an install flow must not run during a preview');
      },
    }
  );
  const deps: InstallerDeps = {
    dorkHome,
    resolver: {
      resolve: vi.fn().mockResolvedValue({
        kind: 'local',
        packageName: 'evil-pack',
        localPath: packagePath,
      }),
    } as unknown as InstallerDeps['resolver'],
    fetcher: unused as InstallerDeps['fetcher'],
    previewBuilder: new PermissionPreviewBuilder(dorkHome, conflictDetector),
    pluginFlow: unused as InstallerDeps['pluginFlow'],
    agentFlow: unused as InstallerDeps['agentFlow'],
    skillPackFlow: unused as InstallerDeps['skillPackFlow'],
    adapterFlow: unused as InstallerDeps['adapterFlow'],
    shapeFlow: unused as InstallerDeps['shapeFlow'],
    uninstallFlow: unused as InstallerDeps['uninstallFlow'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return new MarketplaceInstaller(deps);
}

describe('install preview of a package with `---js` frontmatter (DOR-2308)', () => {
  // Purpose: the user-visible answer. The preview refuses the package and names
  // the file, and the validator's read of skills/evil/SKILL.md never evaluates it.
  it('reports the SKILL.md as invalid and never runs its frontmatter', async () => {
    const error = await buildInstaller()
      .preview({ name: 'evil-pack' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InvalidPackageError);
    expect((error as InvalidPackageError).errors.join('\n')).toMatch(
      /Failed to parse frontmatter: Frontmatter written as "js" is not supported/
    );
    expect(sentinel()).toBeUndefined();
  });

  // Purpose: the preview builder and conflict detector read `.dork/tasks/`
  // SKILL.md files on their own path, after validation. Build that preview
  // directly (as a package detail page does for a package the validator would
  // pass) and prove neither reader evaluates the block.
  it('builds the permission preview without running task frontmatter', async () => {
    const conflictDetector = new ConflictDetector(dorkHome, {} as AdapterManager);
    const builder = new PermissionPreviewBuilder(dorkHome, conflictDetector);

    const preview = await builder.build(packagePath, {
      schemaVersion: 1,
      name: 'evil-pack',
      version: '1.0.0',
      type: 'skill-pack',
      description: 'x',
      tags: [],
      layers: ['skills'],
      requires: [],
      schedules: [],
    });

    // The refused task declares no schedule a person would be shown.
    expect(preview.schedules).toEqual([]);
    expect(sentinel()).toBeUndefined();
  });
});
