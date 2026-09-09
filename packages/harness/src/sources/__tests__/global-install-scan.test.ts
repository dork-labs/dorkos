/**
 * SRC-04, slice A1 — what the scan reports about a package installed for every
 * project.
 *
 * Before this slice `scanPluginsRoot` recorded a global package's identity and
 * nothing else: empty `skills`, empty `commands`, no hooks and no directory. A
 * package with two skills and a slash command was reported as a name, so the
 * line a person read could not say what was in it. These cases assert the scan
 * now enumerates it against its absolute install directory, to the same standard
 * as a project install.
 *
 * **The staged HOME is snapshotted across the whole file** (see the `beforeAll`
 * and `afterAll` below). Enumerating a directory is a read, and the claim that
 * this slice writes nothing outside a repository is measured here rather than
 * assumed: the guard is slice-wide on purpose, because the failure it catches is
 * a write nobody expected from a case nobody suspected.
 *
 * @module sources/__tests__/global-install-scan
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInstalledPlugins, type InstalledPlugin } from '../installed.js';
import { diffSnapshots, snapshotTree, type SnapshotEntry } from '../../__tests__/journeys/stage.js';

/** The staged DorkOS data directory every case in this file reads, and none may write. */
let dorkHome = '';

/** The staged HOME as it was before the first case ran. */
let homeBefore = new Map<string, SnapshotEntry>();

/** Project roots the cases make, cleaned up between them. */
const projectRoots: string[] = [];

/** A fresh, empty project root — no `.dork/plugins`, so only the global scope answers. */
function emptyProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'a1-scan-proj-'));
  projectRoots.push(root);
  return root;
}

/** Write a package's `.dork/manifest.json`. */
function writeManifest(pluginDir: string, name: string, layers: string[]): void {
  mkdirSync(join(pluginDir, '.dork'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'plugin',
      description: `The ${name} package`,
      layers,
    })
  );
}

/** Write a `<parent>/<name>/SKILL.md`, optionally declaring a schedule. */
function writeSkill(parent: string, name: string, schedule?: string): void {
  mkdirSync(join(parent, name), { recursive: true });
  const block = schedule === undefined ? '' : `schedule:\n  cron: '${schedule}'\n`;
  writeFileSync(
    join(parent, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n${block}---\n\n# ${name}\n`
  );
}

beforeAll(() => {
  dorkHome = mkdtempSync(join(tmpdir(), 'a1-scan-home-'));

  // `globex`: two skills (one on a timer), one slash command, readable hooks.
  const globex = join(dorkHome, 'plugins', 'globex');
  writeManifest(globex, 'globex', ['skills', 'commands', 'hooks']);
  writeSkill(join(globex, 'skills'), 'greet');
  writeSkill(join(globex, 'skills'), 'nightly', '0 3 * * *');
  mkdirSync(join(globex, 'commands'), { recursive: true });
  writeFileSync(join(globex, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\n\nHi.\n');
  mkdirSync(join(globex, 'hooks'), { recursive: true });
  writeFileSync(
    join(globex, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo global' }] }] })
  );

  // `brokenhooks`: the same package shape with a `hooks/hooks.json` nobody can read.
  const broken = join(dorkHome, 'plugins', 'brokenhooks');
  writeManifest(broken, 'brokenhooks', ['hooks']);
  mkdirSync(join(broken, 'hooks'), { recursive: true });
  writeFileSync(join(broken, 'hooks', 'hooks.json'), '{ not json');

  // `nohooks`: no `hooks/` at all, which is the state `unreadableHooks` has to
  // tell apart from "read, and nothing was lost".
  writeManifest(join(dorkHome, 'plugins', 'nohooks'), 'nohooks', ['skills']);

  homeBefore = snapshotTree(dorkHome);
});

afterEach(() => {
  for (const root of projectRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  // Content-hashed both ways: a read that leaves a marker, a lockfile or a
  // rewritten manifest behind names its own path here.
  expect(diffSnapshots(homeBefore, snapshotTree(dorkHome))).toEqual({
    added: [],
    changed: [],
    removed: [],
  });
  rmSync(dorkHome, { recursive: true, force: true });
});

/** The scanned package of this name, which every case here expects to exist. */
function scanned(name: string): InstalledPlugin {
  const found = scanInstalledPlugins({ dorkHome, projectRoot: emptyProject() }).find(
    (p) => p.name === name
  );
  expect(found, `a scanned package named ${name}`).toBeDefined();
  return found as InstalledPlugin;
}

describe('SRC-04 — a globally installed package is enumerated, not just named', () => {
  it('SRC-04: a global package with two skills, one command and a hooks file is enumerated, with absolute source paths', () => {
    // Seeded defect: keep the identity-only branch (`skills: []`, `commands: []`,
    // no hooks, no directory). Every list below is empty and the location is gone.
    const globex = join(dorkHome, 'plugins', 'globex');

    const pkg = scanned('globex');

    expect(pkg.location).toEqual({ scope: 'global', absDir: globex });
    expect(pkg.skills).toEqual([
      {
        name: 'greet',
        sourceDir: `${globex}/skills/greet`,
        usesPluginRoot: false,
        hasSchedule: false,
        linkedInDorkHome: false,
        frontmatterName: 'greet',
      },
      {
        name: 'nightly',
        sourceDir: `${globex}/skills/nightly`,
        usesPluginRoot: false,
        hasSchedule: true,
        linkedInDorkHome: false,
        frontmatterName: 'nightly',
      },
    ]);
    expect(pkg.commands.map((c) => [c.name, c.sourcePath])).toEqual([
      ['hello', `${globex}/commands/hello.md`],
    ]);
    expect(pkg.hooks).toHaveProperty('Stop');
    expect(pkg.unreadableHooks).toEqual([]);
    // Every path it carries resolves on its own, with no repo root to join it to.
    for (const dir of pkg.skills.map((s) => s.sourceDir)) expect(dir.startsWith(globex)).toBe(true);
  });

  it('SRC-04: a global package whose hooks/hooks.json is malformed produces an unreadableHooks entry, not an absent field', () => {
    // Seeded defect: leave `unreadableHooks` off for global packages. Absent then
    // means two things again — "never read" and "nothing was lost" — and the
    // package's discarded hook is silent.
    const broken = join(dorkHome, 'plugins', 'brokenhooks');

    const pkg = scanned('brokenhooks');

    expect(pkg.unreadableHooks).toEqual([{ path: `${broken}/hooks/hooks.json`, total: true }]);
    expect(pkg.hooks).toBeUndefined();
  });

  it('SRC-04: absent unreadableHooks means there is no hooks file, and an empty array means one was read', () => {
    // Seeded defect: return `{ unreadable: [] }` when the file does not exist.
    // The two states the field documents collapse into one, so "read and nothing
    // was lost" is indistinguishable from "there was nothing to read" — the same
    // ambiguity this slice deleted from the doc when a global install stopped
    // meaning "never read".
    expect(scanned('nohooks').unreadableHooks).toBeUndefined();
    expect(scanned('globex').unreadableHooks).toEqual([]);
  });
});
