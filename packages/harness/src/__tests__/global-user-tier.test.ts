/**
 * The user tier: the two directories in a person's home folder a global plan
 * writes links into, and everything it must not touch while it is there.
 *
 * Nothing is mocked, and nothing here reaches a real home directory: every case
 * stages a temp HOME beside a temp dork home and passes both roots in, which is
 * the whole point of the engine taking them injected rather than resolving them.
 *
 * The case that decides this slice is AP-07 global. A home directory is not a
 * repository: people hand-build the exact projection this feature automates, and
 * on the operator's own machine `~/.claude/skills/composio-cli` and
 * `~/.claude/skills/find-skills` are relative symlinks into `~/.agents/skills`
 * whose targets are directories a person wrote. Under the two-clause predicate
 * the only thing standing between those and a sweep is the absence of `__` in
 * their names. So every removal case here stages a person's own work beside
 * DorkOS's and counts what went.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  AGENTS_SKILLS_DIR_READERS,
  globalBoundarySkipLine,
  globalPluginsDir,
  globalSkillsDir,
  projectGlobal,
  AGENTS_USER_LINK_REASON,
  CLAUDE_USER_LINK_REASON,
  type GlobalPlanRoots,
} from '../plan/global-projector.js';
import { applyGlobalPlan, checkGlobalPlan, findGlobalOrphans } from '../apply/global-apply.js';
import { snapshotTree } from './journeys/stage.js';
import type { HarnessId } from '../manifest/schema.js';

/** Every temp directory a case staged, removed whatever the case did. */
const staged: string[] = [];

afterEach(() => {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `SKILL.md` with no schedule — the ordinary case. */
function plainSkillMd(name: string): string {
  return `---\nname: ${name}\ndescription: A skill named ${name}\n---\nJust a skill.\n`;
}

/** Stage a fresh dork home holding one or more global packages. */
function stageDorkHome(packages: readonly { name: string; skills: readonly string[] }[]): string {
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-a3-dork-'));
  staged.push(dorkHome);
  for (const pkg of packages) {
    const dir = join(dorkHome, 'plugins', pkg.name);
    mkdirSync(join(dir, '.dork'), { recursive: true });
    writeFileSync(
      join(dir, '.dork', 'manifest.json'),
      JSON.stringify({ name: pkg.name, version: '1.0.0', type: 'plugin', description: pkg.name })
    );
    for (const skill of pkg.skills) {
      const skillDir = join(dir, 'skills', skill);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), plainSkillMd(skill));
    }
  }
  return dorkHome;
}

/** The two user directories, staged under a temp HOME nobody's shell knows about. */
function stageHome(): { home: string; agentsSkillsDir: string; claudeSkillsDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'harness-a3-home-'));
  staged.push(home);
  const agentsSkillsDir = join(home, '.agents', 'skills');
  const claudeSkillsDir = join(home, '.claude', 'skills');
  return { home, agentsSkillsDir, claudeSkillsDir };
}

/** Every absolute symlink target a plan names, sorted. */
function targetsOf(plan: { actions: readonly { target?: string }[] }): string[] {
  return plan.actions.map((a) => a.target ?? '').sort();
}

describe('SRC-04 global: which directories the user tier writes', () => {
  it('case 1: one link in the shared folder for the five tools, and a Claude link only for the sixth', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir, claudeSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir, claudeSkillsDir };

    // Codex alone: the shared folder is written, Claude Code's is not. The
    // seeded defect — plan the Claude link whenever the root is passed — makes
    // the third entry appear here, for a tool the person never enabled.
    const codexOnly = projectGlobal({ roots, harnesses: ['codex'] });
    expect(targetsOf(codexOnly)).toEqual(
      [
        join(globalSkillsDir(dorkHome), 'globex__greet'),
        join(agentsSkillsDir, 'globex__greet'),
      ].sort()
    );

    // Claude Code alone: its own folder is written, and the shared one is not —
    // measured, not assumed. DOR-1856 staged a link in a sandbox `~/.agents/skills`
    // and a real `claude` 2.1.266 did not list it.
    const claudeOnly = projectGlobal({ roots, harnesses: ['claude-code'] });
    expect(targetsOf(claudeOnly)).toEqual(
      [
        join(globalSkillsDir(dorkHome), 'globex__greet'),
        join(claudeSkillsDir, 'globex__greet'),
      ].sort()
    );

    // Both, and it is still THREE links rather than seven: one directory serves
    // five tools, so the harness list decides whether it is written at all and
    // never how many times.
    const both = projectGlobal({ roots, harnesses: [...AGENTS_SKILLS_DIR_READERS, 'claude-code'] });
    expect(targetsOf(both)).toEqual(
      [
        join(globalSkillsDir(dorkHome), 'globex__greet'),
        join(agentsSkillsDir, 'globex__greet'),
        join(claudeSkillsDir, 'globex__greet'),
      ].sort()
    );
  });

  it('case 1: any one of the five turns the shared folder on, and it is one link either way', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir, claudeSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir, claudeSkillsDir };

    for (const harness of AGENTS_SKILLS_DIR_READERS) {
      const plan = projectGlobal({ roots, harnesses: [harness] });
      expect(targetsOf(plan), `${harness} alone`).toContain(join(agentsSkillsDir, 'globex__greet'));
      expect(targetsOf(plan), `${harness} alone`).not.toContain(
        join(claudeSkillsDir, 'globex__greet')
      );
    }
  });

  it('case 1: an enabled tool with no root passed writes nothing in a home directory', () => {
    // The root and the harness list are two clauses and both are required. This
    // is the shape a `DORKOS_BOUNDARY` deployment passes, and it is also what a
    // machine whose home directory could not be resolved would pass.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const plan = projectGlobal({
      roots: { dorkHome },
      harnesses: ['codex', 'claude-code'],
    });
    expect(targetsOf(plan)).toEqual([join(globalSkillsDir(dorkHome), 'globex__greet')]);
  });

  it('case 1: carries the two frozen reasons, and labels the shared link as no one tool’s', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir, claudeSkillsDir } = stageHome();
    const plan = projectGlobal({
      roots: { dorkHome, agentsSkillsDir, claudeSkillsDir },
      harnesses: ['codex', 'claude-code'],
    });

    const shared = plan.actions.find((a) => a.target === join(agentsSkillsDir, 'globex__greet'));
    expect(shared?.reason).toBe(AGENTS_USER_LINK_REASON);
    // Five tools read that one link, so no per-tool cell may claim it.
    expect(shared?.harnessAgnostic).toBe(true);

    const claude = plan.actions.find((a) => a.target === join(claudeSkillsDir, 'globex__greet'));
    expect(claude?.reason).toBe(CLAUDE_USER_LINK_REASON);
    // That directory has exactly one reader, so the label is a claim and it is true.
    expect(claude?.harness).toBe('claude-code');
    expect(claude?.harnessAgnostic).toBeUndefined();
  });

  it('case 1: applies for real, and SKILL.md reads through both user links', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { home, agentsSkillsDir, claudeSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir, claudeSkillsDir };

    const { applied, conflicts } = applyGlobalPlan(
      projectGlobal({ roots, harnesses: ['codex', 'claude-code'] }),
      roots,
      { sweepOrphans: true }
    );
    expect({ applied: applied.length, conflicts: conflicts.length }).toEqual({
      applied: 3,
      conflicts: 0,
    });

    // A link one directory too high satisfies "a link exists" and fails this read.
    for (const dir of [agentsSkillsDir, claudeSkillsDir]) {
      expect(readFileSync(join(dir, 'globex__greet', 'SKILL.md'), 'utf8')).toContain('name: greet');
    }

    // Nothing but the two links and the folders holding them is in the home
    // directory, and both links are symlinks with relative text — so a dork home
    // that moves, or lives under a symlinked parent, keeps working. Every macOS
    // temp directory is one.
    const homeAfter = snapshotTree(home);
    expect([...homeAfter.keys()].sort()).toEqual([
      '.agents',
      '.agents/skills',
      '.agents/skills/globex__greet',
      '.claude',
      '.claude/skills',
      '.claude/skills/globex__greet',
    ]);
    const linkTarget = join(dorkHome, 'plugins', 'globex', 'skills', 'greet');
    expect(homeAfter.get('.agents/skills/globex__greet')).toEqual({
      kind: 'symlink',
      linkText: relative(agentsSkillsDir, linkTarget),
    });
    expect(homeAfter.get('.claude/skills/globex__greet')).toEqual({
      kind: 'symlink',
      linkText: relative(claudeSkillsDir, linkTarget),
    });
  });
});

describe('AP-07 global: the user tier removes only what DorkOS wrote', () => {
  it('case 2: four staged shapes in one home directory, and exactly one removal', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir, claudeSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir, claudeSkillsDir };
    mkdirSync(agentsSkillsDir, { recursive: true });

    // 1. A real directory the person wrote themselves.
    const authored = join(agentsSkillsDir, 'my-own-skill');
    mkdirSync(authored, { recursive: true });
    writeFileSync(join(authored, 'SKILL.md'), plainSkillMd('my-own-skill'));

    // 2. A hand-built SYMLINK of the exact shape this feature automates. This is
    //    the one the two-clause predicate removes, and the operator's own
    //    machine has two of them.
    const handBuiltTarget = join(agentsSkillsDir, 'my-own-skill');
    symlinkSync(relative(agentsSkillsDir, handBuiltTarget), join(agentsSkillsDir, 'composio__cli'));

    // 3. A directory another tool's installer put there.
    const vendorInstalled = join(agentsSkillsDir, 'codex__bundled');
    mkdirSync(vendorInstalled, { recursive: true });
    writeFileSync(join(vendorInstalled, 'SKILL.md'), plainSkillMd('bundled'));

    // 4. A DorkOS link for a package that is no longer installed.
    symlinkSync(
      relative(agentsSkillsDir, join(globalPluginsDir(dorkHome), 'goneco', 'skills', 'vanished')),
      join(agentsSkillsDir, 'goneco__vanished')
    );

    const plan = projectGlobal({ roots, harnesses: ['codex'] });
    const orphans = findGlobalOrphans(plan, roots);
    expect(orphans.map((o) => o.path)).toEqual([join(agentsSkillsDir, 'goneco__vanished')]);

    const { swept } = applyGlobalPlan(plan, roots, { sweepOrphans: true });
    expect(swept).toEqual([join(agentsSkillsDir, 'goneco__vanished')]);

    // The person's own work, byte for byte, after the sweep.
    expect(readFileSync(join(authored, 'SKILL.md'), 'utf8')).toBe(plainSkillMd('my-own-skill'));
    expect(readFileSync(join(agentsSkillsDir, 'composio__cli', 'SKILL.md'), 'utf8')).toBe(
      plainSkillMd('my-own-skill')
    );
    expect(readFileSync(join(vendorInstalled, 'SKILL.md'), 'utf8')).toBe(plainSkillMd('bundled'));
  });

  it('case 3: a dangling DorkOS link left by an uninstall is still swept', () => {
    // Clause 3 reads the link's own TEXT, resolved lexically. A global uninstall
    // removes the package directory first, so `realpath` throws on exactly the
    // orphans the sweep exists to remove — the seeded defect strands every one
    // of them.
    const dorkHome = stageDorkHome([{ name: 'stays', skills: ['here'] }]);
    const { claudeSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, claudeSkillsDir };
    mkdirSync(claudeSkillsDir, { recursive: true });

    const dead = join(claudeSkillsDir, 'uninstalled__skill');
    symlinkSync(
      relative(claudeSkillsDir, join(globalPluginsDir(dorkHome), 'uninstalled', 'skills', 'skill')),
      dead
    );
    // Nothing is at the other end of it.
    expect(() => readFileSync(join(dead, 'SKILL.md'), 'utf8')).toThrow();

    const plan = projectGlobal({ roots, harnesses: ['claude-code'] });
    expect(findGlobalOrphans(plan, roots).map((o) => o.path)).toEqual([dead]);
    expect(applyGlobalPlan(plan, roots, { sweepOrphans: true }).swept).toEqual([dead]);
  });

  it('case 4: a link into a neighbour of the packages folder is not ours and is not swept', () => {
    // The promise: a directory next to `<dorkHome>/plugins` is not DorkOS's,
    // whatever it is called, and a link into it is never removed.
    //
    // **Three independent clauses hold this, and no single one of them can be
    // removed to red it — measured, not assumed.** `isInside` is a path-SEGMENT
    // test, so a bare `startsWith` matching `<dorkHome>/plugins-elsewhere` is the
    // defect the spec names; but `relative()` then yields a first segment of
    // `..`, which the attribution rejects on its own; and even with BOTH of those
    // gone the package name is `..`, which the plan never enumerated, so clause 4
    // keeps the link. So this case asserts the OUTCOME rather than one clause,
    // and the belt-and-braces is deliberate: each clause is cheap and the failure
    // it prevents is deleting somebody else's file.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir };
    mkdirSync(agentsSkillsDir, { recursive: true });

    const neighbour = join(dorkHome, 'plugins-elsewhere', 'other', 'skills', 'thing');
    mkdirSync(neighbour, { recursive: true });
    writeFileSync(join(neighbour, 'SKILL.md'), plainSkillMd('thing'));
    const link = join(agentsSkillsDir, 'other__thing');
    symlinkSync(relative(agentsSkillsDir, neighbour), link);

    const plan = projectGlobal({ roots, harnesses: ['codex'] });
    expect(findGlobalOrphans(plan, roots)).toEqual([]);
    applyGlobalPlan(plan, roots, { sweepOrphans: true });
    expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toBe(plainSkillMd('thing'));
    // And a second run does not change its mind about it.
    expect(checkGlobalPlan(plan, roots).orphans).toEqual([]);
  });

  it('case 5: the sweep reads one level and never descends', () => {
    // A person's own subdirectory tree in their own home folder is not walked,
    // so nothing inside it can be a candidate — even a path that would otherwise
    // pass all four clauses.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir };
    const nested = join(agentsSkillsDir, 'my-collection', 'inner');
    mkdirSync(nested, { recursive: true });

    const buried = join(nested, 'goneco__vanished');
    symlinkSync(
      relative(nested, join(globalPluginsDir(dorkHome), 'goneco', 'skills', 'vanished')),
      buried
    );

    const plan = projectGlobal({ roots, harnesses: ['codex'] });
    expect(findGlobalOrphans(plan, roots)).toEqual([]);
    applyGlobalPlan(plan, roots, { sweepOrphans: true });
    expect([...snapshotTree(nested).keys()]).toEqual(['goneco__vanished']);
  });

  it('case 7: a hand-authored directory at a target is a conflict, never an overwrite', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir };

    // Exactly where the plan wants to write, and the person got there first.
    const occupied = join(agentsSkillsDir, 'globex__greet');
    mkdirSync(occupied, { recursive: true });
    const theirs = '---\nname: mine\ndescription: I wrote this\n---\nHands off.\n';
    writeFileSync(join(occupied, 'SKILL.md'), theirs);

    const plan = projectGlobal({ roots, harnesses: ['codex'] });
    const { applied, conflicts } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

    // The dork-home link is written; the occupied user target is not.
    expect(applied.map((a) => a.target)).toEqual([
      join(globalSkillsDir(dorkHome), 'globex__greet'),
    ]);
    expect(conflicts.map((a) => a.target)).toEqual([occupied]);
    expect(conflicts[0]?.reason).toBeTruthy();
    // Their bytes, unchanged. The seeded defect replaces the target and this reds.
    expect(readFileSync(join(occupied, 'SKILL.md'), 'utf8')).toBe(theirs);
    // And `--check` says the same thing rather than calling it drift, so nobody
    // is told to run a command they then watch decline.
    const drift = checkGlobalPlan(plan, roots);
    expect(drift.blocked.map((a) => a.target)).toEqual([occupied]);
    expect(drift.drifted.map((a) => a.target)).not.toContain(occupied);
  });
});

describe('DORKOS_BOUNDARY: the user tier is skipped and the dork-home tier is not', () => {
  it('case 6: a confined deployment still plans and applies its scheduled global skills', () => {
    // The boundary limits how far DorkOS reaches into a person's disk, and
    // `<dorkHome>` is DorkOS's own directory, which every deployment already
    // writes to on every boot. The seeded defect — skip both tiers — stops the
    // scheduled skill running on a confined machine.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { home } = stageHome();

    const roots: GlobalPlanRoots = { dorkHome };
    const plan = projectGlobal({ roots, harnesses: ['codex', 'claude-code'] });
    const { applied } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

    expect(applied.map((a) => a.target)).toEqual([
      join(globalSkillsDir(dorkHome), 'globex__greet'),
    ]);
    // Nothing at all in the home directory, and nothing was read there either:
    // an absent root is not scanned, so the sweep cannot remove from it.
    expect([...snapshotTree(home).keys()]).toEqual([]);
  });

  it('case 6: the frozen line names the root a person configured', () => {
    expect(globalBoundarySkipLine('/workspace')).toBe(
      'Packages you installed for all your projects stay inside DorkOS on this machine. ' +
        'DorkOS is limited to /workspace, so it will not add links in your home folder.'
    );
  });
});

describe('the harness list is the switch, and an empty one is off', () => {
  it('plans no user link at all with no agent tool enabled, both roots passed', () => {
    // The other half of the two-clause rule. Both roots are here and readable;
    // nobody has said yes, so nothing in the home directory is planned.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir, claudeSkillsDir } = stageHome();
    const plan = projectGlobal({
      roots: { dorkHome, agentsSkillsDir, claudeSkillsDir },
      harnesses: [],
    });
    expect(targetsOf(plan)).toEqual([join(globalSkillsDir(dorkHome), 'globex__greet')]);
  });

  it('the readers of the shared folder are every harness but claude-code', () => {
    // Pinned here as well as in `vendor-facts.test.ts`, because this list is
    // what the planner branches on and the other is what the vendor pages say.
    // Two places, one fact: they have to agree.
    const readers: readonly HarnessId[] = AGENTS_SKILLS_DIR_READERS;
    expect([...readers].sort()).toEqual(['codex', 'copilot', 'cursor', 'gemini', 'opencode']);
    expect(readers).not.toContain('claude-code');
  });
});
