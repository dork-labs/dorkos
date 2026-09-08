/**
 * SRC-04, slice A1 — the line a person reads about a package installed for
 * every project.
 *
 * Before this slice the drop said `global-scope install; a project sync does not
 * project global plugins (run a global sync)`. There is no global sync: `dorkos
 * harness sync` takes `--check`, `--fix`, `--harness`, `--strict`,
 * `--allow-hooks`, `--enable` and `--write-gitignore`, and nothing accepts a
 * scope. The sentence sent people looking for a command that has never existed,
 * and it could not say what was in the package anyway. These cases pin the two
 * honest forms that replace it.
 *
 * **The staged HOME is snapshotted across the whole file** (`beforeAll` /
 * `afterAll`). `buildPlan` is pure and the scan only reads, so nothing here may
 * add, change or remove a byte under it — measured, not assumed.
 *
 * @module plan/__tests__/global-install-drop
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan } from '../projector.js';
import { formatDropList } from '../../report/drop-list.js';
import { parseHarnessManifest } from '../../manifest/schema.js';
import { scanInstalledPlugins } from '../../sources/installed.js';
import type { ProjectionAction, ProjectionPlan } from '../types.js';
import { diffSnapshots, snapshotTree, type SnapshotEntry } from '../../__tests__/journeys/stage.js';

/** Three agent tools, so "once per package" is visibly not "once per tool". */
const MANIFEST = parseHarnessManifest({
  version: 1,
  harnesses: ['claude-code', 'codex', 'cursor'],
});

/** The staged DorkOS data directory every case reads, and none may write. */
let dorkHome = '';

/** The staged HOME as it was before the first case ran. */
let homeBefore = new Map<string, SnapshotEntry>();

/** Repositories the cases make, cleaned up between them. */
const repos: string[] = [];

/** Write a package's `.dork/manifest.json`. */
function writeManifest(pluginDir: string, name: string, version: string, layers: string[]): void {
  mkdirSync(join(pluginDir, '.dork'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version,
      type: 'plugin',
      description: `The ${name} package`,
      layers,
    })
  );
}

/** Write a `<parent>/<name>/SKILL.md`. */
function writeSkill(parent: string, name: string): void {
  mkdirSync(join(parent, name), { recursive: true });
  writeFileSync(
    join(parent, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n`
  );
}

/** A repository with a manifest, and optionally a project-scoped copy of a package. */
function repoWith(projectCopy?: { name: string; version: string }): string {
  const repo = mkdtempSync(join(tmpdir(), 'a1-drop-repo-'));
  repos.push(repo);
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex', 'cursor'] })
  );
  if (projectCopy) {
    const dir = join(repo, '.dork', 'plugins', projectCopy.name);
    writeManifest(dir, projectCopy.name, projectCopy.version, ['skills']);
    writeSkill(join(dir, 'skills'), 'greet');
  }
  return repo;
}

/** The plan for a repository, with both install scopes scanned off disk. */
function planFor(repo: string): ProjectionPlan {
  return buildPlan({
    repoRoot: repo,
    manifest: MANIFEST,
    agentsMdExists: false,
    installedPlugins: scanInstalledPlugins({ dorkHome, projectRoot: repo }),
  });
}

/** Every drop about the named package. */
function dropsFor(plan: ProjectionPlan, name: string): ProjectionAction[] {
  return plan.drops.filter((d) => d.name === name);
}

beforeAll(() => {
  dorkHome = mkdtempSync(join(tmpdir(), 'a1-drop-home-'));

  // `globex`: two skills and a slash command, none of which reach this project.
  const globex = join(dorkHome, 'plugins', 'globex');
  writeManifest(globex, 'globex', '1.0.0', ['skills', 'commands']);
  writeSkill(join(globex, 'skills'), 'greet');
  writeSkill(join(globex, 'skills'), 'nightly');
  mkdirSync(join(globex, 'commands'), { recursive: true });
  writeFileSync(join(globex, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\n\nHi.\n');

  // `barepkg`: a package with nothing portable in it at all.
  writeManifest(join(dorkHome, 'plugins', 'barepkg'), 'barepkg', '1.0.0', ['extensions']);

  // `ccnative`: a Claude-Code-native package, installed verbatim, so nothing on
  // disk states its version or its layers (see the SRC-12 case below).
  const cc = join(dorkHome, 'plugins', 'ccnative');
  mkdirSync(join(cc, '.claude-plugin'), { recursive: true });
  writeFileSync(join(cc, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ccnative' }));
  writeSkill(join(cc, 'skills'), 'greet');

  homeBefore = snapshotTree(dorkHome);
});

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

afterAll(() => {
  expect(diffSnapshots(homeBefore, snapshotTree(dorkHome))).toEqual({
    added: [],
    changed: [],
    removed: [],
  });
  rmSync(dorkHome, { recursive: true, force: true });
});

describe('SRC-04 — the global-install drop says what the package holds', () => {
  it('SRC-04: the drop names the skills that are not shared, and names no command', () => {
    // Seeded defect: restore the old string. The reason then reads "run a global
    // sync", a command `dorkos harness sync` has never accepted.
    const plan = planFor(repoWith());

    const [drop, ...extra] = dropsFor(plan, 'globex');
    expect(extra).toEqual([]);
    expect(drop?.reason).toBe(
      'installed for all your projects. Only the Claude Code sessions DorkOS runs can see it. ' +
        'Its 2 skills are not shared with this project: greet, nightly'
    );
    expect(drop?.harnessAgnostic).toBe(true);
    // No sentence anywhere in the plan names a command that does not exist, and
    // this one names no command at all: `hello` is real but nothing in slice A1
    // does anything with it, and "a global sync" is not a thing.
    const everyReason = [...plan.drops, ...plan.warnings].map((e) => e.reason ?? '').join('\n');
    expect(everyReason).not.toMatch(/global sync/);
    expect(drop?.reason).not.toMatch(/hello|dorkos harness/);
    // It renders once, under the heading the CLI files package-level facts under.
    const report = formatDropList(plan);
    expect(report).toContain('plugin layers:');
    expect(report).toContain('- plugin "globex": installed for all your projects.');
  });

  it('SRC-04: a global package with no skills gets the second form', () => {
    // Seeded defect: emit the first form with an empty list. The sentence then
    // reads "Its 0 skills are not shared with this project: ".
    const plan = planFor(repoWith());

    const [drop] = dropsFor(plan, 'barepkg');
    expect(drop?.reason).toBe(
      'installed for all your projects. Only the Claude Code sessions DorkOS runs can see it. ' +
        'It has no skills to share.'
    );
    expect(drop?.reason).not.toMatch(/skills are not shared/);
  });
});
