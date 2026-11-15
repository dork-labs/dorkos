/**
 * The person's user-level skills win too (DOR-4392, Security's U1, U2 and G1 on
 * #3752). OpenCode reads `~/.claude/skills` and `~/.agents/skills` in every
 * project and keeps one of two skills that share a `name`, so a package skill,
 * from a project or from the global plan, must not take the name of a skill
 * there.
 *
 * Nothing reaches a real home folder: every case stages a temp HOME and passes
 * its folders in, which is the point of the engine taking them injected.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { project } from '../../engine.js';
import { readUserSkillNames } from '../../inventory/user-skills.js';
import { applyGlobalPlan } from '../../apply/global-apply.js';
import { projectGlobal, type GlobalPlanRoots } from '../global-projector.js';
import type { HarnessId } from '../../manifest/schema.js';
import type { ProjectionPlan } from '../types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`);
}

/** A package folder with one skill folder whose `SKILL.md` declares `name`. */
function writePackage(dir: string, pkg: string, folder: string, name: string): void {
  mkdirSync(join(dir, '.dork'), { recursive: true });
  writeFileSync(
    join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name: pkg, version: '1.0.0', type: 'plugin', description: pkg })
  );
  writeSkill(join(dir, 'skills', folder), name);
}

/** A temp HOME with the person's own skill `<root>/<folder>` named `name`. */
function homeWith(root: '.claude/skills' | '.agents/skills', folder: string, name: string) {
  const home = temp('dor4392-home-');
  writeSkill(join(home, root, folder), name);
  return {
    home,
    userSkills: {
      dirs: [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')],
      dorkHome: temp('dor4392-dork-'),
    },
  };
}

/** A project with a manifest and one project-scoped package. */
function repoWithPackage(folder: string, name: string): string {
  const repo = temp('dor4392-repo-');
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex', 'opencode'] })
  );
  writePackage(join(repo, '.dork', 'plugins', 'acme'), 'acme', folder, name);
  return repo;
}

/** Every link the plan makes for one projection; a target's separator is the platform's. */
function linksFor(plan: ProjectionPlan, projection: string): string[] {
  return plan.actions
    .filter((a) => a.kind === 'symlink' && a.target !== undefined)
    .filter((a) => basename(a.target!.replaceAll('\\', '/')) === projection)
    .map((a) => a.target as string);
}

describe("a project package skill never replaces the person's user-level skill", () => {
  it.each([
    ['~/.claude/skills (U1)', '.claude/skills'],
    ['~/.agents/skills (U2)', '.agents/skills'],
  ] as const)('SK-06: skips it when the name is taken in %s', (_label, root) => {
    const { home, userSkills } = homeWith(root, 'my-deploy', 'deploy');
    const plan = project(repoWithPackage('ship', 'deploy'), { userSkills });

    expect(linksFor(plan, 'acme__ship')).toEqual([]);
    expect(plan.skippedPackageSkills).toEqual([
      {
        package: 'acme',
        skill: 'ship',
        name: 'deploy',
        winner: { kind: 'own', source: join(home, root, 'my-deploy') },
      },
    ]);
  });

  it("SK-06: skips it for the person's own `team__deploy` link into their dotfiles (#3761 Should 1)", () => {
    const home = temp('dor4392-home-');
    const dotfiles = join(temp('dor4392-dotfiles-'), 'deploy');
    writeSkill(dotfiles, 'deploy');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    symlinkSync(dotfiles, join(home, '.agents', 'skills', 'team__deploy'));
    const plan = project(repoWithPackage('ship', 'deploy'), {
      userSkills: { dirs: [join(home, '.agents', 'skills')], dorkHome: temp('dor4392-dork-') },
    });

    expect(linksFor(plan, 'acme__ship')).toEqual([]);
    expect(plan.skippedPackageSkills?.[0]?.winner).toEqual({
      kind: 'own',
      source: join(home, '.agents', 'skills', 'team__deploy'),
    });
  });

  it('SK-06: keeps it when no user-level skill has the name', () => {
    const { userSkills } = homeWith('.agents/skills', 'mine', 'other');
    const plan = project(repoWithPackage('ship', 'deploy'), { userSkills });

    expect(linksFor(plan, 'acme__ship').length).toBeGreaterThan(0);
    expect(plan.skippedPackageSkills).toBeUndefined();
  });

  it('SK-06: reads nothing from a home folder it was not given', () => {
    homeWith('.agents/skills', 'my-deploy', 'deploy');
    const plan = project(repoWithPackage('ship', 'deploy'));
    expect(linksFor(plan, 'acme__ship').length).toBeGreaterThan(0);
  });
});

describe('the user-level reader', () => {
  it("leaves out DorkOS's own <pkg>__<name> links, so a package never skips itself", () => {
    const home = temp('dor4392-home-');
    const dorkHome = temp('dor4392-dork-');
    const pluginSkill = join(dorkHome, 'plugins', 'acme', 'skills', 'deploy');
    writeSkill(pluginSkill, 'deploy');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    symlinkSync(pluginSkill, join(home, '.agents', 'skills', 'acme__deploy'));
    writeSkill(join(home, '.agents', 'skills', 'mine'), 'mine');

    expect(readUserSkillNames([join(home, '.agents', 'skills')], dorkHome)).toEqual([
      { source: join(home, '.agents', 'skills', 'mine'), exactFrontmatterName: 'mine' },
    ]);
  });

  it("keeps the person's own <x>__<y> link that points anywhere else (#3761 Should 1)", () => {
    const home = temp('dor4392-home-');
    const dotfiles = join(temp('dor4392-dotfiles-'), 'a');
    writeSkill(dotfiles, 'a');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    symlinkSync(dotfiles, join(home, '.agents', 'skills', 'team__a'));

    expect(readUserSkillNames([join(home, '.agents', 'skills')], temp('dor4392-dork-'))).toEqual([
      { source: join(home, '.agents', 'skills', 'team__a'), exactFrontmatterName: 'a' },
    ]);
  });

  it('reads the name off a frontmatter DorkOS cannot parse (#3761 Should 2)', () => {
    const home = temp('dor4392-home-');
    const dir = join(home, 'skills', 'big');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: "deploy"\ndescription: big\npad: "${'a'.repeat(40_000)}"\n---\nbody\n`
    );

    expect(readUserSkillNames([join(home, 'skills')], temp('dor4392-dork-'))).toEqual([
      { source: dir, exactFrontmatterName: 'deploy' },
    ]);
  });

  it('adds nothing for a missing folder, a file, or a skill with no name', () => {
    const home = temp('dor4392-home-');
    writeFileSync(join(home, 'not-a-folder'), 'x');
    mkdirSync(join(home, 'skills', 'nameless'), { recursive: true });
    writeFileSync(join(home, 'skills', 'nameless', 'SKILL.md'), '---\ndescription: d\n---\n');

    expect(
      readUserSkillNames(
        [join(home, 'missing'), join(home, 'not-a-folder'), join(home, 'skills')],
        temp('dor4392-dork-')
      )
    ).toEqual([]);
  });
});

describe("a global package skill never replaces the person's user-level skill (G1)", () => {
  function globalPlan(own: string | null, harnesses: HarnessId[]) {
    const dorkHome = temp('dor4392-dork-');
    writePackage(join(dorkHome, 'plugins', 'acme'), 'acme', 'deploy', 'deploy');
    const home = temp('dor4392-home-');
    if (own !== null) writeSkill(join(home, '.claude', 'skills', 'mine'), own);
    const agentsSkillsDir = join(home, '.agents', 'skills');
    const claudeSkillsDir = join(home, '.claude', 'skills');
    const planRoots: GlobalPlanRoots = {
      dorkHome,
      agentsSkillsDir,
      claudeSkillsDir,
      ownSkillDirs: [claudeSkillsDir, agentsSkillsDir],
    };
    return { dorkHome, home, planRoots, plan: projectGlobal({ roots: planRoots, harnesses }) };
  }

  it('SK-06: keeps it out of every folder an agent tool reads, and in DorkOS’s own', () => {
    const { dorkHome, home, plan } = globalPlan('deploy', ['claude-code', 'opencode']);

    expect(linksFor(plan, 'acme__deploy')).toEqual([join(dorkHome, 'skills', 'acme__deploy')]);
    expect(plan.skippedPackageSkills).toEqual([
      {
        package: 'acme',
        skill: 'deploy',
        name: 'deploy',
        winner: { kind: 'own', source: join(home, '.claude', 'skills', 'mine') },
      },
    ]);
    expect(plan.warnings.filter((w) => w.name === 'acme__deploy')).toHaveLength(1);
  });

  it('SK-06: links it everywhere when the names differ', () => {
    const { plan } = globalPlan('other', ['claude-code', 'opencode']);
    expect(linksFor(plan, 'acme__deploy')).toHaveLength(3);
    expect(plan.skippedPackageSkills).toBeUndefined();
  });

  it('SK-06: says nothing when nothing is shared with an agent tool', () => {
    const { plan } = globalPlan('deploy', []);
    expect(linksFor(plan, 'acme__deploy')).toHaveLength(1);
    expect(plan.skippedPackageSkills).toBeUndefined();
    expect(plan.warnings.filter((w) => w.name === 'acme__deploy')).toEqual([]);
  });

  it('SK-06: its own links from an earlier sync do not make it skip itself', () => {
    const { planRoots, plan } = globalPlan(null, ['claude-code', 'opencode']);
    applyGlobalPlan(plan, planRoots);
    const again = projectGlobal({ roots: planRoots, harnesses: ['claude-code', 'opencode'] });

    expect(linksFor(again, 'acme__deploy')).toHaveLength(3);
    expect(again.skippedPackageSkills).toBeUndefined();
  });
});
