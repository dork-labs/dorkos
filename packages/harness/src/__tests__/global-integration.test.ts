/**
 * The global plan against a real dork home: what it writes, what it removes,
 * and what it refuses to touch.
 *
 * Nothing is mocked. Every case stages a real `<dorkHome>/plugins/<pkg>` with
 * real `SKILL.md` files, runs the real scan through `projectGlobal`, and applies
 * the plan for real. The one thing these cases deliberately do NOT do is assert
 * the scheduler's behaviour — the engine is a leaf package and cannot import a
 * server service, so the half that proves a global scheduled skill actually
 * RUNS lives beside the scheduler, in
 * `apps/server/src/services/tasks/__tests__/global-skill-discovery.integration.test.ts`,
 * and drives the real discovery over what this apply wrote.
 *
 * What is asserted here is the shape that discovery depends on: the link exists
 * at `<dorkHome>/skills/<pkg>__<name>`, and reading `SKILL.md` THROUGH it
 * succeeds. A link pointing one directory too high satisfies "a link exists" and
 * fails that read, which is exactly the seeded defect for case 2.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGlobalPlan,
  globalSkillsDir,
  projectGlobal,
  type GlobalPlanRoots,
} from '../plan/global-projector.js';
import { applyGlobalPlan, checkGlobalPlan, findGlobalOrphans } from '../apply/global-apply.js';
import { diffSnapshots, existsOnDisk, snapshotTree } from './journeys/stage.js';

/** Every temp dork home a case staged, removed whatever the case did. */
const staged: string[] = [];

afterEach(() => {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `SKILL.md` with a `schedule:` block — what makes a skill a scheduled task. */
function scheduledSkillMd(name: string): string {
  return `---\nname: ${name}\ndescription: A skill named ${name}\nschedule:\n  cron: '0 9 * * *'\n---\nDo the thing.\n`;
}

/** A `SKILL.md` with no schedule — the ordinary case. */
function plainSkillMd(name: string): string {
  return `---\nname: ${name}\ndescription: A skill named ${name}\n---\nJust a skill.\n`;
}

/** Stage a fresh dork home holding one or more global packages. */
function stageDorkHome(
  packages: readonly { name: string; skills: readonly { name: string; scheduled?: boolean }[] }[]
): string {
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-global-'));
  staged.push(dorkHome);
  for (const pkg of packages) {
    const dir = join(dorkHome, 'plugins', pkg.name);
    mkdirSync(join(dir, '.dork'), { recursive: true });
    writeFileSync(
      join(dir, '.dork', 'manifest.json'),
      JSON.stringify({ name: pkg.name, version: '1.0.0', type: 'plugin', description: pkg.name })
    );
    for (const skill of pkg.skills) {
      const skillDir = join(dir, 'skills', skill.name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        skill.scheduled ? scheduledSkillMd(skill.name) : plainSkillMd(skill.name)
      );
    }
  }
  return dorkHome;
}

/** The roots this slice passes: the dork home, and no user root at all. */
function rootsFor(dorkHome: string): GlobalPlanRoots {
  return { dorkHome };
}

describe('SK-03 global: applying a global plan', () => {
  it('SK-03: links a global package’s scheduled skill so its SKILL.md reads through the link', () => {
    const dorkHome = stageDorkHome([
      { name: 'globex', skills: [{ name: 'greet', scheduled: true }] },
    ]);
    const roots = rootsFor(dorkHome);

    const plan = projectGlobal({ roots, harnesses: [] });
    const { applied, conflicts } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

    expect({ applied: applied.length, conflicts: conflicts.length }).toEqual({
      applied: 1,
      conflicts: 0,
    });

    // The shape the scheduler's discovery walks: a `<pkg>__<name>` entry in the
    // DorkOS skills folder whose SKILL.md is readable through it. Pointing the
    // link at the package root instead of the skill directory reds here.
    const link = join(globalSkillsDir(dorkHome), 'globex__greet');
    const md = readFileSync(join(link, 'SKILL.md'), 'utf8');
    expect(md).toContain('name: greet');
    expect(md).toContain('schedule:');
  });

  it('SK-03: writes nothing outside <dorkHome>/skills', () => {
    const dorkHome = stageDorkHome([
      { name: 'globex', skills: [{ name: 'greet' }, { name: 'wave' }] },
    ]);
    const roots = rootsFor(dorkHome);

    const before = snapshotTree(dorkHome);
    applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });
    const { added, changed, removed } = diffSnapshots(before, snapshotTree(dorkHome));

    expect({ added, changed, removed }).toEqual({
      added: ['skills', 'skills/globex__greet', 'skills/globex__wave'],
      changed: [],
      removed: [],
    });
  });
});

describe('IN-05 global: the sweep and the check agree', () => {
  it('IN-05: checkGlobalPlan().orphans equals the next applyGlobalPlan().swept, both ways', () => {
    const dorkHome = stageDorkHome([
      { name: 'globex', skills: [{ name: 'greet' }] },
      { name: 'acme', skills: [{ name: 'build' }, { name: 'ship' }] },
    ]);
    const roots = rootsFor(dorkHome);
    applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });

    // Uninstall: the package directory goes first, exactly as a real uninstall
    // does it, so the links it left behind are now DANGLING. `realpath` throws
    // on every one of them, which is why clause 3 reads the link's text.
    rmSync(join(dorkHome, 'plugins', 'acme'), { recursive: true, force: true });

    const plan = projectGlobal({ roots, harnesses: [] });
    const promised = checkGlobalPlan(plan, roots).orphans;
    const { swept } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

    expect(promised).toEqual([
      join(globalSkillsDir(dorkHome), 'acme__build'),
      join(globalSkillsDir(dorkHome), 'acme__ship'),
    ]);
    // Set equality in BOTH directions: "most of what will be deleted" is a
    // warning with a hole in it, and the hole is where the surprise lives.
    expect([...swept].sort()).toEqual([...promised].sort());
    expect(promised.every((p) => swept.includes(p))).toBe(true);
    expect(swept.every((p) => promised.includes(p))).toBe(true);
    expect(existsOnDisk(join(globalSkillsDir(dorkHome), 'acme__build'))).toBe(false);
    expect(existsOnDisk(join(globalSkillsDir(dorkHome), 'globex__greet'))).toBe(true);
  });

  it('IN-05: a check makes no promise it cannot keep on a clean tree', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: [{ name: 'greet' }] }]);
    const roots = rootsFor(dorkHome);
    const plan = projectGlobal({ roots, harnesses: [] });
    applyGlobalPlan(plan, roots, { sweepOrphans: true });

    expect(checkGlobalPlan(plan, roots)).toEqual({
      drifted: [],
      blocked: [],
      orphans: [],
      leftAlone: [],
      clean: true,
    });
  });
});

describe('AP-07 global: what the sweep may touch', () => {
  it('AP-07: leaves a hand-authored link and a lookalike neighbour alone, and never descends', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: [{ name: 'greet' }] }]);
    const roots = rootsFor(dorkHome);
    const skillsRoot = globalSkillsDir(dorkHome);
    mkdirSync(skillsRoot, { recursive: true });

    // A person's own directory, named the way a projection is named.
    mkdirSync(join(skillsRoot, 'mine__helper'), { recursive: true });
    writeFileSync(join(skillsRoot, 'mine__helper', 'SKILL.md'), plainSkillMd('helper'));

    // A person's own SYMLINK into a directory they wrote — the operator's real
    // shape, and the one the two-clause repository predicate would remove.
    mkdirSync(join(dorkHome, 'mine', 'handmade'), { recursive: true });
    writeFileSync(join(dorkHome, 'mine', 'handmade', 'SKILL.md'), plainSkillMd('handmade'));
    symlinkSync('../mine/handmade', join(skillsRoot, 'hand__made'));

    // A link into a directory whose name merely STARTS with the plugins root.
    mkdirSync(join(dorkHome, 'plugins-elsewhere', 'other'), { recursive: true });
    symlinkSync('../plugins-elsewhere/other', join(skillsRoot, 'other__thing'));

    // One of ours, two levels down: the sweep reads one level and stops.
    mkdirSync(join(skillsRoot, 'nested'), { recursive: true });
    symlinkSync('../../plugins/globex/skills/greet', join(skillsRoot, 'nested', 'deep__link'));

    // A dead link of OURS, left by a package that is gone.
    symlinkSync('../plugins/gone/skills/away', join(skillsRoot, 'gone__away'));

    const plan = projectGlobal({ roots, harnesses: [] });
    const { swept } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

    expect(swept).toEqual([join(skillsRoot, 'gone__away')]);
    for (const survivor of ['mine__helper', 'hand__made', 'other__thing', 'nested/deep__link']) {
      expect({ survivor, present: existsOnDisk(join(skillsRoot, survivor)) }).toEqual({
        survivor,
        present: true,
      });
    }
  });

  it('AP-07: a real directory at a target is a conflict, never an overwrite', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: [{ name: 'greet' }] }]);
    const roots = rootsFor(dorkHome);
    const skillsRoot = globalSkillsDir(dorkHome);
    mkdirSync(join(skillsRoot, 'globex__greet'), { recursive: true });
    writeFileSync(join(skillsRoot, 'globex__greet', 'precious.md'), '# do not delete\n');

    const plan = projectGlobal({ roots, harnesses: [] });
    const { applied, conflicts } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

    expect({ applied: applied.length, conflicts: conflicts.length }).toEqual({
      applied: 0,
      conflicts: 1,
    });
    expect(conflicts[0]?.reason).toContain('blocked by a real directory');
    expect(readFileSync(join(skillsRoot, 'globex__greet', 'precious.md'), 'utf8')).toBe(
      '# do not delete\n'
    );
  });
});

describe('AP-04 global: a second run applies nothing', () => {
  it('AP-04: applying twice leaves the tree byte-identical and the second check clean', () => {
    const dorkHome = stageDorkHome([
      { name: 'globex', skills: [{ name: 'greet', scheduled: true }, { name: 'wave' }] },
    ]);
    const roots = rootsFor(dorkHome);

    const first = applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, {
      sweepOrphans: true,
    });
    expect(first.applied).toHaveLength(2);
    const afterFirst = snapshotTree(dorkHome);

    const secondPlan = projectGlobal({ roots, harnesses: [] });
    const second = applyGlobalPlan(secondPlan, roots, { sweepOrphans: true });
    const afterSecond = snapshotTree(dorkHome);

    // The second run RE-APPLIES nothing: a link already pointing where the plan
    // says is left exactly as it is, so `applied` is empty and the tree does not
    // move. Recreating it unconditionally reds the first of these.
    expect({ applied: second.applied.length, swept: second.swept.length }).toEqual({
      applied: 0,
      swept: 0,
    });
    expect(diffSnapshots(afterFirst, afterSecond)).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(checkGlobalPlan(secondPlan, roots).clean).toBe(true);
  });
});

describe('AP-05 global: the finders never throw for what they find', () => {
  it('AP-05: a skills root that is a plain file is nothing to sweep, not an exception', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: [{ name: 'greet' }] }]);
    const roots = rootsFor(dorkHome);
    writeFileSync(globalSkillsDir(dorkHome), 'not a directory\n');

    const plan = buildGlobalPlan({ roots, packages: [], harnesses: [] });
    expect(findGlobalOrphans(plan, roots)).toEqual([]);
    expect(checkGlobalPlan(plan, roots).clean).toBe(true);
  });
});
