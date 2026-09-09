/**
 * J-07 — a package installed for all your projects reaches the tools you use.
 *
 * Somebody installs a package once, for every project. Before this slice the
 * only thing that could see it was a Claude Code session DorkOS was driving:
 * `dorkos harness sync` in their repository listed it under `plugin layers:`
 * and said so. Now they say yes, and its skills appear in the two folders their
 * agent tools read.
 *
 * The journey asserts the three beats a person lives through, each as an EXACT
 * before/after tree diff of the staged HOME, so a stray file is a red rather
 * than an unnoticed side effect:
 *
 * 1. **Nothing, until they say yes.** Both roots exist and no agent tool is
 *    enabled: the run writes into `<dorkHome>/skills` and touches the home
 *    directory not at all.
 * 2. **Exactly the links it named.** With Codex and Claude Code enabled, the
 *    home directory gains one link per skill per folder and nothing else — no
 *    generated file, no directory of DorkOS's own beyond the two the links sit
 *    in.
 * 3. **Exactly them again, on the way out.** The package is uninstalled, and
 *    the run removes precisely the links it added. The person's own file in the
 *    same folder, staged before any of this, is byte-identical throughout.
 *
 * Nothing here reaches a real home directory: the HOME is a temp tree this file
 * stages and removes, and the engine takes both roots injected, which is the
 * whole reason it can be staged at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { projectGlobal, type GlobalPlanRoots } from '../../plan/global-projector.js';
import { applyGlobalPlan, checkGlobalPlan } from '../../apply/global-apply.js';
import { linkCheckFor, linkMatchesPlan } from '../../apply/symlink-occupants.js';
import { diffSnapshots, snapshotTree } from './stage.js';
import { stageRepo, type StagedRepo } from './stage-repo.js';

let staged: StagedRepo | undefined;
let home = '';

afterEach(() => {
  staged?.cleanup();
  staged = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = '';
});

/** A file the person wrote into the shared folder themselves, before any of this. */
const THEIR_OWN_SKILL = '---\nname: my-own-skill\ndescription: I wrote this\n---\nHands off.\n';

describe('J-07: a package installed for all your projects reaches the tools you use', () => {
  it('writes nothing in a home directory until somebody says yes, then exactly the links it named', () => {
    staged = stageRepo({
      manifest: { harnesses: ['claude-code', 'codex'] },
      agents: { agentsMd: true, skills: ['local'] },
      plugins: [{ name: 'globex', scope: 'global', skills: [{ name: 'greet' }, { name: 'wave' }] }],
    });
    const dorkHome = staged.dorkHome;

    home = mkdtempSync(join(tmpdir(), 'harness-journey-userhome-'));
    const agentsSkillsDir = join(home, '.agents', 'skills');
    const claudeSkillsDir = join(home, '.claude', 'skills');
    mkdirSync(join(agentsSkillsDir, 'my-own-skill'), { recursive: true });
    writeFileSync(join(agentsSkillsDir, 'my-own-skill', 'SKILL.md'), THEIR_OWN_SKILL);

    const pristine = snapshotTree(home);

    // ── Beat 1: nothing, until they say yes ────────────────────────────────
    // Both roots are passed and no agent tool is enabled. The dork-home tier is
    // written — it is DorkOS's own folder and needs no permission — and the home
    // directory is not touched.
    const closed: GlobalPlanRoots = { dorkHome };
    applyGlobalPlan(projectGlobal({ roots: closed, harnesses: [] }), closed, {
      sweepOrphans: true,
    });
    expect(diffSnapshots(pristine, snapshotTree(home))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(existsSync(join(dorkHome, 'skills', 'globex__greet'))).toBe(true);

    // ── Beat 2: exactly the links it named ─────────────────────────────────
    const open: GlobalPlanRoots = { dorkHome, agentsSkillsDir, claudeSkillsDir };
    const harnesses = ['codex', 'claude-code'] as const;
    const plan = projectGlobal({ roots: open, harnesses });

    // What the run PROMISED, read off the plan before it ran.
    const promised = plan.actions
      .map((action) => action.target ?? '')
      .filter((target) => target.startsWith(home))
      .sort();
    // `${dir}/${name}`, never `join`: that is the shape the planner builds and
    // slice A2's suite pins, and on Windows the two differ by one character.
    // Everything below that touches DISK keeps `join`.
    const planTarget = (dir: string, name: string): string => `${dir}/${name}`;
    expect(promised).toEqual(
      [
        planTarget(agentsSkillsDir, 'globex__greet'),
        planTarget(agentsSkillsDir, 'globex__wave'),
        planTarget(claudeSkillsDir, 'globex__greet'),
        planTarget(claudeSkillsDir, 'globex__wave'),
      ].sort()
    );

    const { applied, conflicts } = applyGlobalPlan(plan, open, { sweepOrphans: true });
    expect(conflicts).toEqual([]);
    // FOUR, not six: `applied` is what this run CHANGED, and beat 1 already
    // wrote the two dork-home links. A global run is a receipt for what DorkOS
    // did to somebody’s home directory, not a summary of the projection.
    expect(applied.map((a) => a.target).sort()).toEqual(promised);

    // What it DID, as an exact tree diff. The two folders holding the links are
    // added too, and they are the only directories DorkOS created.
    const afterApply = snapshotTree(home);
    const source = (skill: string): string => join(dorkHome, 'plugins', 'globex', 'skills', skill);
    expect(diffSnapshots(pristine, afterApply)).toEqual({
      added: [
        '.agents/skills/globex__greet',
        '.agents/skills/globex__wave',
        '.claude',
        '.claude/skills',
        '.claude/skills/globex__greet',
        '.claude/skills/globex__wave',
      ],
      changed: [],
      removed: [],
    });
    // Every one is a LINK rather than a copy, and it points at the staged skill.
    //
    // The link TEXT is asserted only where the platform keeps it. POSIX stores
    // the relative text verbatim; Windows has no relative junction, so
    // `symlinkSync(text, ..., 'junction')` resolves it and `readlink` answers an
    // absolute path for a link that is perfectly correct. `linkMatchesPlan` is
    // how this engine asks the question everywhere else, and it asks it the way
    // each platform can answer.
    const how = linkCheckFor(process.platform);
    for (const [dir, prefix] of [
      [agentsSkillsDir, '.agents/skills'],
      [claudeSkillsDir, '.claude/skills'],
    ] as const) {
      for (const skill of ['greet', 'wave']) {
        const key = `${prefix}/globex__${skill}`;
        expect(afterApply.get(key)?.kind, key).toBe('symlink');
        const link = join(dir, `globex__${skill}`);
        expect(linkMatchesPlan(link, source(skill), relative(dir, source(skill)), how), key).toBe(
          true
        );
        if (how === 'link-text') {
          expect(afterApply.get(key)?.linkText).toBe(relative(dir, source(skill)));
        }
        // And the skill reads THROUGH it, which a link one directory too high
        // would not.
        expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toContain(`name: ${skill}`);
      }
    }
    // Their own file, untouched.
    expect(readFileSync(join(agentsSkillsDir, 'my-own-skill', 'SKILL.md'), 'utf8')).toBe(
      THEIR_OWN_SKILL
    );

    // Running it again changes nothing, and the check agrees.
    const second = applyGlobalPlan(projectGlobal({ roots: open, harnesses }), open, {
      sweepOrphans: true,
    });
    expect({ applied: second.applied.length, swept: second.swept.length }).toEqual({
      applied: 0,
      swept: 0,
    });
    expect(checkGlobalPlan(projectGlobal({ roots: open, harnesses }), open).clean).toBe(true);
    expect(diffSnapshots(afterApply, snapshotTree(home))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });

    // ── Beat 3: the uninstall removes exactly them ─────────────────────────
    // The package directory goes first, which is what a global uninstall does —
    // so every link it leaves behind is DANGLING, and that is the shape the
    // sweep has to recognise without following it.
    rmSync(join(dorkHome, 'plugins', 'globex'), { recursive: true, force: true });

    const afterPlan = projectGlobal({ roots: open, harnesses });
    const willGo = checkGlobalPlan(afterPlan, open).removals;
    // The promise, before the deletion: every path, each with its own reason.
    //
    // `resolve` on BOTH sides. A sweep path comes back native, a plan target is
    // built `${dir}/${name}`, and on Windows those are the same place spelled
    // two ways — which is exactly the bridge `findGlobalOrphans` itself crosses
    // by resolving before it compares.
    expect(
      willGo
        .map(({ path }) => resolve(path))
        .filter((p) => p.startsWith(home))
        .sort()
    ).toEqual(promised.map((t) => resolve(t)).sort());
    for (const { reason } of willGo) expect(reason).toBeTruthy();

    const { removals } = applyGlobalPlan(afterPlan, open, { sweepOrphans: true });
    expect(removals.map(({ path }) => path)).toEqual(willGo.map(({ path }) => path));

    // Exactly the links, and nothing else. The two folders stay — DorkOS made
    // them, but a folder another tool now writes into is not DorkOS's to remove.
    expect(diffSnapshots(afterApply, snapshotTree(home))).toEqual({
      added: [],
      changed: [],
      removed: [
        '.agents/skills/globex__greet',
        '.agents/skills/globex__wave',
        '.claude/skills/globex__greet',
        '.claude/skills/globex__wave',
      ],
    });
    expect(readFileSync(join(agentsSkillsDir, 'my-own-skill', 'SKILL.md'), 'utf8')).toBe(
      THEIR_OWN_SKILL
    );
    // And the dork-home tier was cleaned up by the same run.
    expect(existsSync(join(dorkHome, 'skills', 'globex__greet'))).toBe(false);
  });
});
