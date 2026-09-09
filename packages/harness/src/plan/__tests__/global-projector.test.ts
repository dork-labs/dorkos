/**
 * The global plan, decided from packages a caller already scanned.
 *
 * Every case here hands {@link buildGlobalPlan} a hand-built package list and a
 * dork home that DOES NOT EXIST on disk. That is the point rather than a
 * shortcut: the function is documented as pure, and a fixture pointing at a
 * directory nobody created is what makes the claim measurable — anything that
 * reached for the filesystem would come back empty or throw.
 */
import { describe, it, expect } from 'vitest';
import { join, sep } from 'node:path';
import {
  buildGlobalPlan,
  globalSkillsDir,
  projectGlobal,
  GLOBAL_CANONICAL_LINK_REASON,
  GLOBAL_SCHEDULE_LINK_REASON,
} from '../global-projector.js';
import type { InstalledPlugin, InstalledSkill } from '../../sources/installed.js';

/** A dork home that is deliberately not on disk. */
const DORK_HOME = join('/tmp', 'dorkos-global-projector-does-not-exist');

/** One scanned skill of a global package, spelled the way the scanner spells it. */
function skill(absDir: string, name: string, extra?: Partial<InstalledSkill>): InstalledSkill {
  return {
    name,
    sourceDir: `${absDir}/skills/${name}`,
    usesPluginRoot: false,
    hasSchedule: false,
    ...extra,
  };
}

/** One globally installed package, as `scanInstalledPlugins` returns it. */
function globalPackage(name: string, skills: readonly string[], extra?: Partial<InstalledSkill>) {
  const absDir = `${DORK_HOME}/plugins/${name}`;
  return {
    name,
    type: 'plugin',
    location: { scope: 'global', absDir },
    skills: skills.map((s) => skill(absDir, s, extra)),
    commands: [],
    layers: [],
  } satisfies InstalledPlugin;
}

describe('buildGlobalPlan', () => {
  it('SK-03: plans a global package’s scheduled skill into <dorkHome>/skills/<pkg>__<name> with the schedule reason', () => {
    const plan = buildGlobalPlan({
      roots: { dorkHome: DORK_HOME },
      packages: [globalPackage('globex', ['greet'], { hasSchedule: true })],
      // EMPTY on purpose: the dork-home tier is not a harness projection, so it
      // is planned whatever agent tools are enabled. Seeding "only when a
      // harness is enabled" reds exactly here.
      harnesses: [],
    });

    expect(plan.actions).toEqual([
      {
        kind: 'symlink',
        artifact: 'skill',
        harness: 'codex',
        harnessAgnostic: true,
        provenance: 'installed',
        scope: 'global',
        name: 'globex__greet',
        source: `${DORK_HOME}/plugins/globex/skills/greet`,
        target: join(globalSkillsDir(DORK_HOME), 'globex__greet'),
        reason: GLOBAL_SCHEDULE_LINK_REASON,
      },
    ]);
  });

  it('SK-03: a skill with no schedule earns the other frozen reason, and still gets its link', () => {
    const plan = buildGlobalPlan({
      roots: { dorkHome: DORK_HOME },
      packages: [globalPackage('globex', ['greet'])],
      harnesses: ['claude-code'],
    });

    expect(plan.actions.map((a) => a.reason)).toEqual([GLOBAL_CANONICAL_LINK_REASON]);
  });

  it('SK-03: plans one action per skill, and nothing for a package with none', () => {
    const plan = buildGlobalPlan({
      roots: { dorkHome: DORK_HOME },
      packages: [globalPackage('globex', ['greet', 'wave']), globalPackage('empty', [])],
      harnesses: [],
    });

    expect(plan.actions.map((a) => a.name)).toEqual(['globex__greet', 'globex__wave']);
  });

  it('SK-03: a project-scoped package in the list is never planned at global scope', () => {
    const plan = buildGlobalPlan({
      roots: { dorkHome: DORK_HOME },
      packages: [
        {
          name: 'localy',
          type: 'plugin',
          location: { scope: 'project', relDir: '.dork/plugins/localy' },
          skills: [
            {
              name: 'greet',
              sourceDir: '.dork/plugins/localy/skills/greet',
              usesPluginRoot: false,
              hasSchedule: true,
            },
          ],
          commands: [],
          layers: [],
        },
      ],
      harnesses: [],
    });

    expect(plan.actions).toEqual([]);
  });

  it('SK-03: every action is a symlink inside <dorkHome>, and the two always-empty fields are empty', () => {
    const plan = buildGlobalPlan({
      roots: { dorkHome: DORK_HOME },
      packages: [globalPackage('globex', ['greet'])],
      harnesses: ['claude-code', 'codex'],
    });

    expect(plan.actions.every((a) => a.kind === 'symlink')).toBe(true);
    expect(
      // `+ sep`, not a hard-coded `/`: a target is a real path and the planner
      // builds it with `join`, so the separator is the platform's. Spelling it
      // `/` here pinned the POSIX representation and red on Windows for a plan
      // that was right (DOR-1924).
      plan.actions.every((a) => a.target?.startsWith(globalSkillsDir(DORK_HOME) + sep) === true)
    ).toBe(true);
    expect({ notEnabled: plan.notEnabled, narrowedTo: plan.narrowedTo, drops: plan.drops }).toEqual(
      {
        notEnabled: [],
        narrowedTo: undefined,
        drops: [],
      }
    );
  });

  it('SK-03: a skill that still needs plugin context is linked and warned about, once', () => {
    const plan = buildGlobalPlan({
      roots: { dorkHome: DORK_HOME },
      packages: [globalPackage('globex', ['greet'], { usesPluginRoot: true })],
      harnesses: [],
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatchObject({
      artifact: 'skill',
      harnessAgnostic: true,
      name: 'globex__greet',
      source: `${DORK_HOME}/plugins/globex/skills/greet`,
    });
  });
});

describe('projectGlobal', () => {
  it('SK-03: a dork home with no plugins folder plans nothing and does not throw', () => {
    const plan = projectGlobal({ roots: { dorkHome: DORK_HOME }, harnesses: [] });
    expect({ actions: plan.actions, warnings: plan.warnings }).toEqual({
      actions: [],
      warnings: [],
    });
  });
});
