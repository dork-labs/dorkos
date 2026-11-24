/**
 * SRC-04 and SRC-12, slice A1 — the two lines a person reads about a package
 * installed for every project.
 *
 * Before this slice the drop said `global-scope install; a project sync does not
 * project global plugins (run a global sync)`. There is no global sync: `dorkos
 * harness sync` takes `--check`, `--fix`, `--harness`, `--strict`,
 * `--allow-hooks`, `--enable` and `--write-gitignore`, and nothing accepts a
 * scope. The sentence sent people looking for a command that has never existed,
 * and it could not say what was in the package anyway. These cases pin the two
 * honest forms that replace it, and the notice a package installed at BOTH
 * scopes earns.
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
import { isAbsolute, join } from 'node:path';
import { buildPlan } from '../projector.js';
import { formatDropList, formatWarnings } from '../../report/drop-list.js';
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

/** Write a `<parent>/<name>/SKILL.md`, optionally one that runs on a timer. */
function writeSkill(parent: string, name: string, scheduled = false): void {
  mkdirSync(join(parent, name), { recursive: true });
  const schedule = scheduled ? "schedule:\n  cron: '0 9 * * *'\n" : '';
  writeFileSync(
    join(parent, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n${schedule}---\n\n# ${name}\n`
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
function planFor(repo: string, opts?: { sharedWithTools?: boolean }): ProjectionPlan {
  return buildPlan({
    repoRoot: repo,
    manifest: MANIFEST,
    agentsMdExists: false,
    installedPlugins: scanInstalledPlugins({ dorkHome, projectRoot: repo }),
    ...(opts?.sharedWithTools === true ? { sharedWithTools: true } : {}),
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

  // `soloskill`: one skill, which is the commonest global package there is.
  const solo = join(dorkHome, 'plugins', 'soloskill');
  writeManifest(solo, 'soloskill', '1.0.0', ['skills']);
  writeSkill(join(solo, 'skills'), 'nightly');

  // `bigpack`: twelve skills, two more than the first form will name.
  const big = join(dorkHome, 'plugins', 'bigpack');
  writeManifest(big, 'bigpack', '1.0.0', ['skills']);
  for (let i = 1; i <= 12; i += 1) {
    writeSkill(join(big, 'skills'), `skill-${String(i).padStart(2, '0')}`);
  }

  // `timerpack`: one skill that runs on a timer, beside one that does not — the
  // shape slice A2's appended sentence is about.
  const timer = join(dorkHome, 'plugins', 'timerpack');
  writeManifest(timer, 'timerpack', '1.0.0', ['skills']);
  writeSkill(join(timer, 'skills'), 'daily-sweep', true);
  writeSkill(join(timer, 'skills'), 'helper');

  // `twotimers`: two skills, both on a timer — the plural the sentence claims.
  const two = join(dorkHome, 'plugins', 'twotimers');
  writeManifest(two, 'twotimers', '1.0.0', ['skills']);
  writeSkill(join(two, 'skills'), 'first', true);
  writeSkill(join(two, 'skills'), 'second', true);

  // `rottedhooks`: a global package whose hooks file nobody can read.
  const rotted = join(dorkHome, 'plugins', 'rottedhooks');
  writeManifest(rotted, 'rottedhooks', '1.0.0', ['hooks']);
  mkdirSync(join(rotted, 'hooks'), { recursive: true });
  writeFileSync(join(rotted, 'hooks', 'hooks.json'), '{ not json');

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
      'installed for all your projects. Only the Claude Code chats DorkOS runs can see it. ' +
        'Its 2 skills are not shared with this project: greet, nightly. ' +
        'Run dorkos harness global --enable <tool> to share it with your other agent tools.'
    );
    expect(drop?.harnessAgnostic).toBe(true);
    // No sentence anywhere in the plan names a command that does not exist.
    // Slice A1 named none at all, because it had none to name; slice A3 names
    // `dorkos harness global --enable`, which it also built, and that is the
    // whole rule this block is written under.
    const everyReason = [...plan.drops, ...plan.warnings].map((e) => e.reason ?? '').join('\n');
    expect(everyReason).not.toMatch(/global sync/);
    expect(drop?.reason).not.toMatch(/hello/);
    // It renders once, under the heading the CLI files package-level facts under.
    const report = formatDropList(plan);
    expect(report).toContain('plugin layers:');
    expect(report).toContain('- plugin "globex": installed for all your projects.');
  });

  it('SK-03: a package whose timers are NOT linked yet is told which command links them', () => {
    // Seeded defect: gate the "now work" sentence on `hasSchedule` alone. It
    // then prints on a machine where no global sync has ever run — the claim was
    // false at the moment it was printed, which is the one thing this whole
    // block exists not to do.
    const plan = planFor(repoWith());

    const [drop] = dropsFor(plan, 'timerpack');
    expect(drop?.reason).toBe(
      'installed for all your projects. Only the Claude Code chats DorkOS runs can see it. ' +
        'Its 2 skills are not shared with this project: daily-sweep, helper. ' +
        'Run dorkos harness sync --fix --global so its skills that run on a timer work. ' +
        'Run dorkos harness global --enable <tool> to share it with your other agent tools.'
    );
  });
});

describe("HK-09 — a global package's hooks file that could not be read", () => {
  it('HK-09: a rotted global hooks file earns a line instead of being read and thrown away', () => {
    // Seeded defect: leave `planGlobalUnreadableHookWarnings` out of `buildPlan`.
    // The scan reads the file, records the loss and nothing ever says it —
    // exactly the silence DOR-1724 closed for project-scoped packages.
    const plan = planFor(repoWith());

    const [warning, ...extra] = plan.warnings.filter((w) => w.name === 'rottedhooks');
    expect(extra).toEqual([]);
    expect(warning).toMatchObject({ artifact: 'plugin', harnessAgnostic: true });
    expect(warning?.reason).toBe(
      `has a hooks file DorkOS could not read: ${join(dorkHome, 'plugins', 'rottedhooks')}/hooks/hooks.json. ` +
        `DorkOS cannot say what is in it, and does not project a global package's hooks anywhere.`
    );
    // It says what DorkOS knows, and no more: a global package is handed to the
    // Claude Agent SDK whole, so what Claude Code makes of a half-broken file is
    // not ours to claim.
    expect(warning?.reason).not.toMatch(/runs anywhere|never runs|does not run/);
    // Under the package heading, never the person's own tree.
    expect(formatWarnings(plan)).toContain('plugin layers:');
    // And a readable file still earns nothing.
    expect(plan.warnings.some((w) => w.name === 'globex')).toBe(false);
  });
});

describe('SRC-12 — the same package installed at both scopes', () => {
  /** The frozen notice, with the package name and this repository's absolute path in it. */
  function notice(pkg: string, repoRoot: string): string {
    return (
      `is installed twice: once for all your projects, and once in this project. ` +
      `In a chat DorkOS runs, Claude Code sees both copies, under different names. ` +
      `On its own, Claude Code sees only this project's copy. So does Codex, until you share it. ` +
      `Uninstall one if you only meant to have one. ` +
      `Run dorkos uninstall ${pkg} --project ${repoRoot}  to remove this project's copy. ` +
      `Run dorkos uninstall ${pkg}  to remove the all-projects copy. ` +
      `Both need DorkOS running, and both ask you first.`
    );
  }

  it('SRC-12: the same name at both scopes produces exactly one project-level notice carrying both scopes', () => {
    // Seeded defect: emit it per harness. This project runs three agent tools, so
    // the notice appears three times — about a package, under a tool's heading.
    const repo = repoWith({ name: 'globex', version: '2.0.0' });
    const plan = planFor(repo);

    const notices = plan.drops.filter((d) => d.reason?.startsWith('is installed twice'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'drop',
      artifact: 'plugin',
      name: 'globex',
      harnessAgnostic: true,
      reason: notice('globex', repo),
    });
    // Both scopes are carried: the global copy still earns its own drop beside
    // the notice, and the project copy still projects.
    expect(dropsFor(plan, 'globex')).toHaveLength(2);
    expect(plan.actions.some((a) => a.name === 'globex__greet')).toBe(true);
    // Once in the report, under the package heading rather than a tool's.
    const report = formatDropList(plan);
    expect(report.split('is installed twice')).toHaveLength(2);
    expect(report).toContain('plugin layers:');
  });

  it('SRC-12: the uninstall command names this repository by absolute path, never `.`', () => {
    // Seeded defect: interpolate a literal `.` for the project copy. The CLI
    // forwards `--project` verbatim and the SERVER resolves it against its own
    // working directory (`lib/boundary.ts`), so `.` is the server's cwd, not the
    // reader's. `installRootCandidates` then finds nothing there and falls
    // through to the dork home, so the command the sentence offers for "this
    // project's copy" removes the ALL-PROJECTS copy instead. DOR-1921 hit the
    // identical defect on its install offer.
    const repo = repoWith({ name: 'globex', version: '2.0.0' });

    const [notice] = planFor(repo).drops.filter((d) => d.reason?.startsWith('is installed twice'));

    expect(notice?.reason).toContain(`dorkos uninstall globex --project ${repo}  to remove`);
    expect(notice?.reason).not.toContain('--project .');
    expect(isAbsolute(repo)).toBe(true);
    // The all-projects command still takes no `--project` at all, which is what
    // makes the two copies separately addressable.
    expect(notice?.reason).toContain(
      'Run dorkos uninstall globex  to remove the all-projects copy'
    );
  });
});
