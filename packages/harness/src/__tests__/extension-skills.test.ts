/**
 * Running extensions' skills through Harness Sync (DOR-2685, spec
 * `extension-agent-tools-and-skills` §7): the ledger reader's containment
 * rules, the project plan (`<id>__<skill>` links like a plugin's), the global
 * plan (the same tiers, through each extension's generated plugin root), the
 * collision rule (a plugin's skill wins), and both sweeps.
 *
 * Every case runs the real engine on a temporary repository and dork home, so
 * each assertion is about links on disk or a plan built from disk.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../engine.js';
import { applyPlan, checkPlan } from '../apply/apply.js';
import { missingGitignoreLines } from '../apply/gitignore.js';
import { applyGlobalPlan, findGlobalOrphans } from '../apply/global-apply.js';
import { projectGlobal } from '../plan/global-projector.js';
import {
  extensionSkillPluginRoot,
  readRunningExtensionSkillsSync,
  runningExtensionSkillsPath,
  type RunningExtensionSkillsEntry,
} from '../sources/running-extension-skills.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary folder, real-pathed so macOS's /var link never matters. */
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** Write a valid SKILL.md for `name` under `skillsDir`. */
function writeSkill(skillsDir: string, name: string, body = 'Use it.'): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(
    join(skillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}\n`
  );
}

/** Write the ledger the server would have written. */
function writeLedger(dorkHome: string, entries: RunningExtensionSkillsEntry[]): void {
  mkdirSync(join(dorkHome, 'extensions'), { recursive: true });
  writeFileSync(
    runningExtensionSkillsPath(dorkHome),
    JSON.stringify({ version: 1, extensions: entries })
  );
}

/** A repository that enables claude-code + codex. */
function buildRepo(): string {
  const repo = temp('ext-skills-repo-');
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] })
  );
  return repo;
}

/** A project-local extension `mail` with one skill, and its ledger entry. */
function localMail(
  repo: string,
  dorkHome: string,
  extra: Partial<RunningExtensionSkillsEntry> = {}
): RunningExtensionSkillsEntry {
  const skillsDir = join(repo, '.dork', 'extensions', 'mail', 'skills');
  writeSkill(skillsDir, 'triage-inbox');
  const entry: RunningExtensionSkillsEntry = {
    id: 'mail',
    scope: 'local',
    projectRoot: repo,
    skillsDir,
    skills: ['triage-inbox'],
    ...extra,
  };
  writeLedger(dorkHome, [entry]);
  return entry;
}

describe('the running-skills ledger reader', () => {
  it('reads an absent ledger as empty and says it was absent', () => {
    const home = temp('ext-skills-home-');
    expect(readRunningExtensionSkillsSync(home)).toEqual({ state: 'absent', entries: [] });
  });

  it('refuses a ledger whose entry names a relative path or an unsafe skill name', () => {
    const home = temp('ext-skills-home-');
    writeLedger(home, [
      { id: 'mail', scope: 'global', skillsDir: 'relative/skills', skills: ['ok'] },
    ]);
    expect(readRunningExtensionSkillsSync(home).state).toBe('unreadable');
    writeLedger(home, [
      {
        id: 'mail',
        scope: 'global',
        skillsDir: join(home, 'extensions', 'mail', 'skills'),
        skills: ['..'],
      },
    ]);
    expect(readRunningExtensionSkillsSync(home).state).toBe('unreadable');
    writeLedger(home, [
      {
        id: '../x',
        scope: 'global',
        skillsDir: join(home, 'extensions', 'x', 'skills'),
        skills: ['ok'],
      },
    ]);
    expect(readRunningExtensionSkillsSync(home).state).toBe('unreadable');
  });

  it('refuses a local entry with no project', () => {
    const home = temp('ext-skills-home-');
    writeLedger(home, [
      { id: 'mail', scope: 'local', skillsDir: join(home, 'x', 'skills'), skills: ['ok'] },
    ]);
    expect(readRunningExtensionSkillsSync(home).state).toBe('unreadable');
  });
});

describe('a local extension skill at project scope', () => {
  it('plans and applies both links like a project plugin skill', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    const entry = localMail(repo, home);

    const plan = project(repo, { dorkHome: home });
    const targets = plan.actions
      .filter((a) => a.kind === 'symlink' && a.name === 'mail__triage-inbox')
      .map((a) => a.target)
      .sort();
    expect(targets).toEqual([
      '.agents/skills/mail__triage-inbox',
      '.claude/skills/mail__triage-inbox',
    ]);

    applyPlan(repo, plan, { sweepOrphans: true });
    for (const target of targets) {
      const link = join(repo, target as string);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(entry.skillsDir, 'triage-inbox')));
    }
    expect(checkPlan(repo, plan).drifted).toEqual([]);
  });

  it('sweeps the links when the extension leaves the ledger, and a terminal sync keeps them while it is there', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    localMail(repo, home);
    applyPlan(repo, project(repo, { dorkHome: home }), { sweepOrphans: true });

    // A second sync over the same ledger (the terminal's) removes nothing.
    const again = applyPlan(repo, project(repo, { dorkHome: home }), { sweepOrphans: true });
    expect(again.swept).toEqual([]);
    expect(existsSync(join(repo, '.claude/skills/mail__triage-inbox'))).toBe(true);

    writeLedger(home, []);
    const swept = applyPlan(repo, project(repo, { dorkHome: home }), { sweepOrphans: true });
    expect(swept.swept.sort()).toEqual([
      '.agents/skills/mail__triage-inbox',
      '.claude/skills/mail__triage-inbox',
    ]);
  });

  it('sweeps the links when the skills folder is gone', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    const entry = localMail(repo, home);
    applyPlan(repo, project(repo, { dorkHome: home }), { sweepOrphans: true });
    rmSync(entry.skillsDir, { recursive: true, force: true });
    const result = applyPlan(repo, project(repo, { dorkHome: home }), { sweepOrphans: true });
    expect(result.swept).toContain('.claude/skills/mail__triage-inbox');
  });

  it('plans nothing for an entry that belongs to another project', () => {
    const repo = buildRepo();
    const other = buildRepo();
    const home = temp('ext-skills-home-');
    localMail(other, home);
    const plan = project(repo, { dorkHome: home });
    expect(plan.actions.some((a) => a.name === 'mail__triage-inbox')).toBe(false);
  });

  it('ignores an entry whose skills folder is neither in the project nor a DorkOS snapshot', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    // The right shape, in the wrong place: only the location rule refuses it.
    const elsewhere = join(temp('ext-skills-elsewhere-'), '.dork', 'extensions', 'mail', 'skills');
    writeSkill(elsewhere, 'triage-inbox');
    writeLedger(home, [
      {
        id: 'mail',
        scope: 'local',
        projectRoot: repo,
        skillsDir: elsewhere,
        skills: ['triage-inbox'],
      },
    ]);
    const plan = project(repo, { dorkHome: home });
    expect(plan.actions.some((a) => a.name === 'mail__triage-inbox')).toBe(false);
  });

  it('projects a trusted copy from its snapshot outside the repository and never gitignores the snapshot', () => {
    const repo = buildRepo();
    // A git checkout, so the `.gitignore` check has something to answer for.
    mkdirSync(join(repo, '.git'));
    const home = temp('ext-skills-home-');
    const skillsDir = join(
      home,
      'extension-snapshots',
      'abc123',
      '.dork',
      'extensions',
      'mail',
      'skills'
    );
    writeSkill(skillsDir, 'triage-inbox');
    writeLedger(home, [
      { id: 'mail', scope: 'local', projectRoot: repo, skillsDir, skills: ['triage-inbox'] },
    ]);
    const plan = project(repo, { dorkHome: home });
    const link = plan.actions.find((a) => a.target === '.claude/skills/mail__triage-inbox');
    expect(link?.source).toBe(join(skillsDir, 'triage-inbox'));
    // The link is ignorable like any projection; the snapshot it points at is
    // nowhere near this repository and never becomes a line.
    const lines = missingGitignoreLines(repo, plan);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes('extension-snapshots'))).toBe(false);
    applyPlan(repo, plan, { sweepOrphans: true });
    expect(realpathSync(join(repo, '.claude/skills/mail__triage-inbox'))).toBe(
      join(skillsDir, 'triage-inbox')
    );
  });

  it("ignores a skills folder that is not the extension's own, or is a link out of it", () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    // Inside the project, but not `.dork/extensions/<id>/skills`.
    const loose = join(repo, 'docs', 'skills');
    writeSkill(loose, 'triage-inbox');
    writeLedger(home, [
      { id: 'mail', scope: 'local', projectRoot: repo, skillsDir: loose, skills: ['triage-inbox'] },
    ]);
    expect(
      project(repo, { dorkHome: home }).actions.some((a) => a.name === 'mail__triage-inbox')
    ).toBe(false);
    // The right shape, but `skills` is a link to a folder outside the extension.
    const outside = join(temp('ext-skills-outside-'), 'skills');
    writeSkill(outside, 'triage-inbox');
    const extensionDir = join(repo, '.dork', 'extensions', 'mail');
    mkdirSync(extensionDir, { recursive: true });
    symlinkSync(outside, join(extensionDir, 'skills'));
    writeLedger(home, [
      {
        id: 'mail',
        scope: 'local',
        projectRoot: repo,
        skillsDir: join(extensionDir, 'skills'),
        skills: ['triage-inbox'],
      },
    ]);
    const linked = project(repo, { dorkHome: home });
    expect(linked.actions.some((a) => a.name === 'mail__triage-inbox')).toBe(false);
    // Never silently: the same warning a dropped skill earns, as Settings says.
    expect(linked.warnings.find((w) => w.name === 'mail__triage-inbox')?.reason).toMatch(
      /links outside the "mail" extension's folder/
    );
  });

  it('keeps the links when the ledger is garbled or deleted, and sweeps them once it says the extension stopped', () => {
    // Purpose: a missing or unreadable ledger says nothing about which
    // extensions run, so a sync over it must not strip a running extension's
    // skills; only a ledger that was read can.
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    localMail(repo, home);
    applyPlan(repo, project(repo, { dorkHome: home }), { sweepOrphans: true });
    const link = join(repo, '.claude/skills/mail__triage-inbox');

    writeFileSync(runningExtensionSkillsPath(home), '{ not json');
    const garbled = project(repo, { dorkHome: home });
    expect(garbled.extensionLedger).toBe('unreadable');
    expect(applyPlan(repo, garbled, { sweepOrphans: true }).swept).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(checkPlan(repo, garbled).orphans).toEqual([]);

    rmSync(runningExtensionSkillsPath(home));
    const deleted = project(repo, { dorkHome: home });
    expect(deleted.extensionLedger).toBe('absent');
    expect(applyPlan(repo, deleted, { sweepOrphans: true }).swept).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    writeLedger(home, []);
    expect(
      applyPlan(repo, project(repo, { dorkHome: home }), { sweepOrphans: true }).swept
    ).toContain('.claude/skills/mail__triage-inbox');
  });

  it('drops a skill whose folder is a link out of the skills folder', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    const skillsDir = join(repo, '.dork', 'extensions', 'mail', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const secret = temp('ext-skills-secret-');
    writeSkill(secret, 'stolen');
    symlinkSync(join(secret, 'stolen'), join(skillsDir, 'stolen'));
    writeLedger(home, [
      { id: 'mail', scope: 'local', projectRoot: repo, skillsDir, skills: ['stolen'] },
    ]);
    const plan = project(repo, { dorkHome: home });
    expect(plan.actions.some((a) => a.name === 'mail__stolen')).toBe(false);
    expect(plan.warnings.some((w) => w.name === 'mail__stolen' && /link/.test(w.reason))).toBe(
      true
    );
  });

  it('drops an invalid SKILL.md with a warning', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    const skillsDir = join(repo, '.dork', 'extensions', 'mail', 'skills');
    mkdirSync(join(skillsDir, 'broken'), { recursive: true });
    writeFileSync(join(skillsDir, 'broken', 'SKILL.md'), '# no frontmatter\n');
    writeLedger(home, [
      { id: 'mail', scope: 'local', projectRoot: repo, skillsDir, skills: ['broken'] },
    ]);
    const plan = project(repo, { dorkHome: home });
    expect(plan.actions.some((a) => a.name === 'mail__broken')).toBe(false);
    expect(plan.warnings.find((w) => w.name === 'mail__broken')?.reason).toMatch(
      /not a valid skill/
    );
  });

  it('keeps the plugin skill when a plugin and an extension claim the same name', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    const plugin = join(repo, '.dork', 'plugins', 'mail');
    mkdirSync(join(plugin, '.dork'), { recursive: true });
    writeFileSync(
      join(plugin, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'mail',
        version: '1.0.0',
        type: 'plugin',
        description: 'Mail plugin',
        layers: ['skills'],
      })
    );
    writeSkill(join(plugin, 'skills'), 'triage-inbox');
    localMail(repo, home, {
      skillsDir: join(plugin, '.dork', 'extensions', 'mail', 'skills'),
    });
    writeSkill(join(plugin, '.dork', 'extensions', 'mail', 'skills'), 'triage-inbox');

    const plan = project(repo, { dorkHome: home });
    const links = plan.actions.filter((a) => a.target === '.claude/skills/mail__triage-inbox');
    expect(links).toHaveLength(1);
    expect(links[0]?.source).toBe('.dork/plugins/mail/skills/triage-inbox');
    const warning = plan.warnings.find((w) => w.name === 'mail__triage-inbox');
    expect(warning?.reason).toMatch(/"mail" extension's skill.*"mail" plugin/);
  });

  it('labels a dev-linked extension skill with its folder', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    localMail(repo, home, { devLink: '/work/mail' });
    const plan = project(repo, { dorkHome: home });
    const links = plan.actions.filter((a) => a.name === 'mail__triage-inbox');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.devLink).toBe('/work/mail');
      expect(link.reason).toContain('(dev link: /work/mail)');
    }
  });

  it('reads the ledger from extensionSkillsHome when no dork home is passed', () => {
    const repo = buildRepo();
    const home = temp('ext-skills-home-');
    localMail(repo, home);
    expect(project(repo).actions.some((a) => a.name === 'mail__triage-inbox')).toBe(false);
    expect(
      project(repo, { extensionSkillsHome: home }).actions.some(
        (a) => a.name === 'mail__triage-inbox'
      )
    ).toBe(true);
  });
});

describe('a global extension skill', () => {
  /** A global extension `notes` with one skill, its ledger entry, and its generated root. */
  function globalNotes(home: string): void {
    const skillsDir = join(home, 'extensions', 'notes', 'skills');
    writeSkill(skillsDir, 'daily');
    writeLedger(home, [{ id: 'notes', scope: 'global', skillsDir, skills: ['daily'] }]);
    const root = extensionSkillPluginRoot(home, 'notes');
    mkdirSync(join(root, 'skills'), { recursive: true });
    symlinkSync(join(skillsDir, 'daily'), join(root, 'skills', 'daily'));
  }

  it('links through its generated plugin root in the dork-home tier only, until a tool is shared', () => {
    const home = temp('ext-skills-home-');
    const claudeSkills = join(temp('ext-skills-claude-'), 'skills');
    globalNotes(home);

    const unanswered = projectGlobal({ roots: { dorkHome: home }, harnesses: [] });
    expect(unanswered.actions.map((a) => a.target)).toEqual([join(home, 'skills', 'notes__daily')]);
    expect(unanswered.actions[0]?.source).toBe(
      join(extensionSkillPluginRoot(home, 'notes'), 'skills', 'daily')
    );

    const shared = projectGlobal({
      roots: { dorkHome: home, claudeSkillsDir: claudeSkills },
      harnesses: ['claude-code'],
    });
    expect(shared.actions.map((a) => a.target).sort()).toEqual(
      [join(claudeSkills, 'notes__daily'), join(home, 'skills', 'notes__daily')].sort()
    );
  });

  it('sweeps its links when the ledger no longer lists it, and keeps them when the ledger cannot be read', () => {
    const home = temp('ext-skills-home-');
    globalNotes(home);
    const roots = { dorkHome: home };
    applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });
    const link = join(home, 'skills', 'notes__daily');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    writeFileSync(runningExtensionSkillsPath(home), '{ not json');
    const unreadable = projectGlobal({ roots, harnesses: [] });
    expect(unreadable.extensionLedger).toBe('unreadable');
    expect(findGlobalOrphans(unreadable, roots)).toEqual([]);

    writeLedger(home, []);
    const stopped = projectGlobal({ roots, harnesses: [] });
    expect(findGlobalOrphans(stopped, roots).map((o) => o.path)).toEqual([link]);
  });

  it('sweeps its links once the generated root is gone, even when the ledger cannot be read', () => {
    const home = temp('ext-skills-home-');
    globalNotes(home);
    const roots = { dorkHome: home };
    applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });
    rmSync(extensionSkillPluginRoot(home, 'notes'), { recursive: true, force: true });
    writeFileSync(runningExtensionSkillsPath(home), '{ not json');
    const plan = projectGlobal({ roots, harnesses: [] });
    expect(findGlobalOrphans(plan, roots).map((o) => o.path)).toEqual([
      join(home, 'skills', 'notes__daily'),
    ]);
  });

  it('gives way to a global plugin skill of the same name', () => {
    const home = temp('ext-skills-home-');
    globalNotes(home);
    const plugin = join(home, 'plugins', 'notes');
    mkdirSync(join(plugin, '.dork'), { recursive: true });
    writeFileSync(
      join(plugin, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'notes',
        version: '1.0.0',
        type: 'plugin',
        description: 'Notes plugin',
        layers: ['skills'],
      })
    );
    writeSkill(join(plugin, 'skills'), 'daily');
    const plan = projectGlobal({ roots: { dorkHome: home }, harnesses: [] });
    const links = plan.actions.filter((a) => a.name === 'notes__daily');
    expect(links).toHaveLength(1);
    expect(links[0]?.source).toBe(join(plugin, 'skills', 'daily'));
    expect(plan.warnings.some((w) => w.name === 'notes__daily' && /plugin/.test(w.reason))).toBe(
      true
    );
  });

  it('ignores a global entry whose skills folder is outside the dork home', () => {
    const home = temp('ext-skills-home-');
    const elsewhere = join(temp('ext-skills-elsewhere-'), 'extensions', 'notes', 'skills');
    writeSkill(elsewhere, 'daily');
    writeLedger(home, [{ id: 'notes', scope: 'global', skillsDir: elsewhere, skills: ['daily'] }]);
    expect(projectGlobal({ roots: { dorkHome: home }, harnesses: [] }).actions).toEqual([]);
  });
});
