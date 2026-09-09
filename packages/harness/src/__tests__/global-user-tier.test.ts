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
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  AGENTS_SKILLS_DIR_READERS,
  GLOBAL_CLAUDE_ONLY_NOTE,
  GLOBAL_REACH_NOTE,
  USER_TIER_MEASUREMENT_NOTE,
  globalBoundarySkipLine,
  globalClosingNote,
  globalPluginsDir,
  globalSkillsDir,
  projectGlobal,
  AGENTS_USER_LINK_REASON,
  CLAUDE_USER_LINK_REASON,
  type GlobalPlanRoots,
} from '../plan/global-projector.js';
import { applyGlobalPlan, checkGlobalPlan, findGlobalOrphans } from '../apply/global-apply.js';
import { linkCheckFor, linkMatchesPlan } from '../apply/symlink-occupants.js';
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

/**
 * The target string the PLANNER builds for one link: a native directory plus a
 * forward slash, which is slice A2's convention and what its own suite pins
 * (`startsWith(`${globalSkillsDir(dorkHome)}/`)`).
 *
 * `join` would be wrong here, and only on Windows, where the two forms differ by
 * one character. Every comparison against a plan, conflict or blocked `target`
 * goes through this; anything that touches DISK keeps `join`, because that is a
 * real path and the platform spells it natively. The sweep bridges the two by
 * `resolve()`-ing before it compares, which normalises the separator.
 */
function planTarget(dir: string, name: string): string {
  return `${dir}/${name}`;
}

/** Every absolute symlink target a plan names, sorted. */
function targetsOf(plan: { actions: readonly { target?: string }[] }): string[] {
  return plan.actions.map((a) => a.target ?? '').sort();
}

describe('the target convention every reader of a global plan shares', () => {
  it('a target is the native directory plus a FORWARD SLASH plus the name', () => {
    // Slice A2 set this and its own suite pins it
    // (`startsWith(`${globalSkillsDir(dorkHome)}/`)`); slice A3 has to agree,
    // because one plan now carries targets in three directories and every
    // reader — the apply, the sweep, the CLI report, these tests — compares them
    // as strings.
    //
    // **This cannot fail on POSIX**, and that is the whole reason it is written
    // down rather than left to `join`. There `join(a, b)` IS `${a}/${b}`, so a
    // planner that joined looked identical here and red only on Windows, where
    // the two differ by one character. The Windows leg of CI is the instrument;
    // this is the statement it measures.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir, claudeSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir, claudeSkillsDir };

    const plan = projectGlobal({ roots, harnesses: ['codex', 'claude-code'] });
    expect(plan.actions).toHaveLength(3);
    for (const dir of [globalSkillsDir(dorkHome), agentsSkillsDir, claudeSkillsDir]) {
      const target = plan.actions.find((a) => (a.target ?? '').startsWith(`${dir}/`))?.target;
      expect(target, `no target under ${dir}`).toBe(`${dir}/globex__greet`);
      // The directory is carried VERBATIM, so a reader can slice it off.
      expect(target?.slice(0, dir.length)).toBe(dir);
      expect(target?.charAt(dir.length)).toBe('/');
    }
  });
});

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
        planTarget(globalSkillsDir(dorkHome), 'globex__greet'),
        planTarget(agentsSkillsDir, 'globex__greet'),
      ].sort()
    );

    // Claude Code alone: its own folder is written, and the shared one is not —
    // measured, not assumed. DOR-1856 staged a link in a sandbox `~/.agents/skills`
    // and a real `claude` 2.1.266 did not list it.
    const claudeOnly = projectGlobal({ roots, harnesses: ['claude-code'] });
    expect(targetsOf(claudeOnly)).toEqual(
      [
        planTarget(globalSkillsDir(dorkHome), 'globex__greet'),
        planTarget(claudeSkillsDir, 'globex__greet'),
      ].sort()
    );

    // Both, and it is still THREE links rather than seven: one directory serves
    // five tools, so the harness list decides whether it is written at all and
    // never how many times.
    const both = projectGlobal({ roots, harnesses: [...AGENTS_SKILLS_DIR_READERS, 'claude-code'] });
    expect(targetsOf(both)).toEqual(
      [
        planTarget(globalSkillsDir(dorkHome), 'globex__greet'),
        planTarget(agentsSkillsDir, 'globex__greet'),
        planTarget(claudeSkillsDir, 'globex__greet'),
      ].sort()
    );
  });

  it('case 1: any one of the five turns the shared folder on, and it is one link either way', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir, claudeSkillsDir } = stageHome();
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir, claudeSkillsDir };

    for (const harness of AGENTS_SKILLS_DIR_READERS) {
      const plan = projectGlobal({ roots, harnesses: [harness] });
      expect(targetsOf(plan), `${harness} alone`).toContain(
        planTarget(agentsSkillsDir, 'globex__greet')
      );
      expect(targetsOf(plan), `${harness} alone`).not.toContain(
        planTarget(claudeSkillsDir, 'globex__greet')
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
    expect(targetsOf(plan)).toEqual([planTarget(globalSkillsDir(dorkHome), 'globex__greet')]);
  });

  it('case 1: carries the two frozen reasons, and labels the shared link as no one tool’s', () => {
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { agentsSkillsDir, claudeSkillsDir } = stageHome();
    const plan = projectGlobal({
      roots: { dorkHome, agentsSkillsDir, claudeSkillsDir },
      harnesses: ['codex', 'claude-code'],
    });

    const shared = plan.actions.find(
      (a) => a.target === planTarget(agentsSkillsDir, 'globex__greet')
    );
    expect(shared?.reason).toBe(AGENTS_USER_LINK_REASON);
    // Five tools read that one link, so no per-tool cell may claim it.
    expect(shared?.harnessAgnostic).toBe(true);

    const claude = plan.actions.find(
      (a) => a.target === planTarget(claudeSkillsDir, 'globex__greet')
    );
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
    // directory, and both entries are LINKS rather than copies.
    const homeAfter = snapshotTree(home);
    expect([...homeAfter.keys()].sort()).toEqual([
      '.agents',
      '.agents/skills',
      '.agents/skills/globex__greet',
      '.claude',
      '.claude/skills',
      '.claude/skills/globex__greet',
    ]);
    for (const key of ['.agents/skills/globex__greet', '.claude/skills/globex__greet']) {
      expect(homeAfter.get(key)?.kind, key).toBe('symlink');
    }

    // WHERE each link points, asked the way this engine asks it everywhere else:
    // `linkMatchesPlan` with the check this platform can make.
    //
    // The link TEXT cannot be asserted directly on both platforms. POSIX stores
    // the relative text verbatim, which is what makes a dork home that moves, or
    // one under a symlinked parent, keep working — every macOS temp directory is
    // the second case. Windows has no relative junction: `symlinkSync(text, ...,
    // 'junction')` resolves the text and stores an ABSOLUTE path, so `readlink`
    // there answers `C:\Users\RUNNER~1\...` for the same link. Asserting the
    // relative text is asserting the POSIX representation, and it reds on
    // Windows for a link that is perfectly correct.
    const linkTarget = join(dorkHome, 'plugins', 'globex', 'skills', 'greet');
    const how = linkCheckFor(process.platform);
    for (const dir of [agentsSkillsDir, claudeSkillsDir]) {
      const link = join(dir, 'globex__greet');
      expect(
        linkMatchesPlan(link, linkTarget, relative(dir, linkTarget), how),
        `${link} does not point at the staged skill`
      ).toBe(true);
    }
    // And on the platform that keeps the text, the text is RELATIVE — the
    // property the absolute form would silently lose.
    if (how === 'link-text') {
      expect(homeAfter.get('.agents/skills/globex__greet')?.linkText).toBe(
        relative(agentsSkillsDir, linkTarget)
      );
      expect(homeAfter.get('.claude/skills/globex__greet')?.linkText).toBe(
        relative(claudeSkillsDir, linkTarget)
      );
    }
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
    // Two spellings of one path on purpose: `occupiedOnDisk` is what the
    // filesystem is handed, `occupied` is what the PLAN calls the same place.
    const occupiedOnDisk = join(agentsSkillsDir, 'globex__greet');
    const occupied = planTarget(agentsSkillsDir, 'globex__greet');
    mkdirSync(occupiedOnDisk, { recursive: true });
    const theirs = '---\nname: mine\ndescription: I wrote this\n---\nHands off.\n';
    writeFileSync(join(occupiedOnDisk, 'SKILL.md'), theirs);

    const plan = projectGlobal({ roots, harnesses: ['codex'] });
    const { applied, conflicts } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

    // The dork-home link is written; the occupied user target is not.
    expect(applied.map((a) => a.target)).toEqual([
      planTarget(globalSkillsDir(dorkHome), 'globex__greet'),
    ]);
    expect(conflicts.map((a) => a.target)).toEqual([occupied]);
    expect(conflicts[0]?.reason).toBeTruthy();
    // Their bytes, unchanged. The seeded defect replaces the target and this reds.
    expect(readFileSync(join(occupiedOnDisk, 'SKILL.md'), 'utf8')).toBe(theirs);
    // And `--check` says the same thing rather than calling it drift, so nobody
    // is told to run a command they then watch decline.
    const drift = checkGlobalPlan(plan, roots);
    expect(drift.blocked.map((a) => a.target)).toEqual([occupied]);
    expect(drift.drifted.map((a) => a.target)).not.toContain(occupied);
  });
});

describe('the sentence a run ends on', () => {
  it('F1: sharing with Claude Code ALONE does not end on "does not share them with Claude Code"', () => {
    // The defect: the closing note branched on the SHARED folder alone, so a
    // person who enabled Claude Code and nothing else got
    // `GLOBAL_REACH_NOTE` — "It does not share them with Claude Code, Codex or
    // any other agent tool yet" — printed directly under the list of links the
    // run had just made in Claude Code's own skills folder.
    const roots: GlobalPlanRoots = { dorkHome: '/d', claudeSkillsDir: '/h/.claude/skills' };
    const note = globalClosingNote(roots);

    expect(note).toBe(GLOBAL_CLAUDE_ONLY_NOTE);
    expect(note).not.toBe(GLOBAL_REACH_NOTE);
    expect(note).not.toContain('does not share them with Claude Code');
    // It says what IS shared, which is the whole point of the branch.
    expect(note).toContain('Claude Code');
    // And it does not claim five tools this run never touched.
    expect(note).not.toContain('Codex');
  });

  it('F1: the other three branches are unchanged', () => {
    // Nothing shared: the reach note is still true, and still the answer.
    expect(globalClosingNote({ dorkHome: '/d' })).toBe(GLOBAL_REACH_NOTE);
    // The shared folder, with or without Claude Code beside it: the measured
    // sentence, because that folder is the one with four unmeasured readers.
    expect(globalClosingNote({ dorkHome: '/d', agentsSkillsDir: '/h/.agents/skills' })).toBe(
      USER_TIER_MEASUREMENT_NOTE
    );
    expect(
      globalClosingNote({
        dorkHome: '/d',
        agentsSkillsDir: '/h/.agents/skills',
        claudeSkillsDir: '/h/.claude/skills',
      })
    ).toBe(USER_TIER_MEASUREMENT_NOTE);
    // A boundary outranks all three: it names the root and says nothing was
    // written in a home folder, because nothing was.
    expect(globalClosingNote({ dorkHome: '/d' }, '/workspace')).toBe(
      globalBoundarySkipLine('/workspace')
    );
  });
});

describe('F2: a user root that is not a folder at all', () => {
  it('a plain FILE at the shared folder is a conflict, not an EEXIST out of mkdirSync', () => {
    // Measured: `unwritableGlobalDir` asked only about the target's immediate
    // parent and answered `undefined` for anything that was not a directory —
    // "a shape question, answered elsewhere". At global scope there is no
    // elsewhere, so the run reached `mkdirSync` and threw EEXIST.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { home } = stageHome();
    const agentsSkillsDir = join(home, '.agents', 'skills');
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(agentsSkillsDir, 'not a folder\n');
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir };

    const plan = projectGlobal({ roots, harnesses: ['codex'] });
    // ONE apply, and its not-throwing is the first half of the claim: the defect
    // was an EEXIST out of `mkdirSync`, so a second call here would report zero
    // applied and hide the other half.
    let result: ReturnType<typeof applyGlobalPlan> | undefined;
    expect(() => {
      result = applyGlobalPlan(plan, roots, { sweepOrphans: true });
    }).not.toThrow();
    expect(result).toBeDefined();
    const { applied, conflicts } = result as ReturnType<typeof applyGlobalPlan>;
    expect(conflicts.map((a) => a.target)).toEqual([planTarget(agentsSkillsDir, 'globex__greet')]);
    // DOR-1882's sentence shape, from DOR-1882's own table: the obstacle and the
    // way out, naming the path that is really in the way.
    expect(conflicts[0]?.reason).toBe(
      `blocked by \`${agentsSkillsDir}\`, which is a file — DorkOS needs a folder there to ` +
        `write this. Move the file aside, then re-run`
    );
    // The dork-home tier is unaffected: one hostile path costs exactly the links
    // that go through it.
    expect(applied.map((a) => a.target)).toEqual([
      planTarget(globalSkillsDir(dorkHome), 'globex__greet'),
    ]);
    // Their file, byte for byte.
    expect(readFileSync(agentsSkillsDir, 'utf8')).toBe('not a folder\n');
    // And `--check` says the same thing, so nobody is promised a fix that then
    // refuses.
    expect(checkGlobalPlan(plan, roots).blocked.map((a) => a.target)).toEqual([
      planTarget(agentsSkillsDir, 'globex__greet'),
    ]);
  });

  it('the SHAPE half runs on a platform that cannot be asked about permission', () => {
    // The Windows failure, reproduced on this machine. The probe opened with a
    // single gate — "not Windows" — in front of BOTH halves, so on Windows it
    // returned `undefined` for everything and a plain file at the shared folder
    // reached `mkdirSync`. The log said `EEXIST: file already exists, mkdir
    // 'C:\...\.agents\skills'`, and on POSIX the same shape says ENOTDIR — which
    // is exactly why the shape question is asked through DOR-1882's helper
    // rather than by reading an `errno` here.
    //
    // Permission is genuinely unanswerable on Windows (`accessSync` reports the
    // read-only attribute, which a directory does not meaningfully carry). Shape
    // is not, and `write-path-occupants.test.ts` runs green there. So the gate
    // belongs in front of the permission half alone, and this pins that.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { home } = stageHome();
    const agentsSkillsDir = join(home, '.agents', 'skills');
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(agentsSkillsDir, 'not a folder\n');
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir };

    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const plan = projectGlobal({ roots, harnesses: ['codex'] });
      const { conflicts } = applyGlobalPlan(plan, roots, { sweepOrphans: true });
      expect(conflicts.map((a) => a.target)).toEqual([
        planTarget(agentsSkillsDir, 'globex__greet'),
      ]);
      expect(conflicts[0]?.reason).toContain('is a file');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    // Restored, so nothing after this case is measured on a fake platform.
    expect(process.platform).not.toBe('win32');
  });

  it('a file at an ANCESTOR is named, rather than the deeper path it makes unreadable', () => {
    // Shallowest first. A file at `~/.agents` makes `~/.agents/skills`
    // unreadable too, and naming the deeper one sends somebody to look at a
    // path that is only wrong because of the one above it.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { home } = stageHome();
    writeFileSync(join(home, '.agents'), 'not a folder\n');
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir: join(home, '.agents', 'skills') };

    const plan = projectGlobal({ roots, harnesses: ['codex'] });
    const { conflicts } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toContain(`blocked by \`${join(home, '.agents')}\``);
    expect(conflicts[0]?.reason).not.toContain(join(home, '.agents', 'skills'));
  });

  it('a SYMLINK to a file says so in its own words', () => {
    // "`~/.agents/skills` is a file" about a path that is plainly a link sends
    // somebody to look for a file that is not there.
    const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
    const { home } = stageHome();
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(join(home, 'somefile'), 'x\n');
    const agentsSkillsDir = join(home, '.agents', 'skills');
    symlinkSync(join(home, 'somefile'), agentsSkillsDir);
    const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir };

    const { conflicts } = applyGlobalPlan(projectGlobal({ roots, harnesses: ['codex'] }), roots, {
      sweepOrphans: true,
    });
    expect(conflicts[0]?.reason).toContain('is a link to a file');
  });
});

describe('a user folder DorkOS may not write in', () => {
  // `chmod` means nothing when the process is root, and Windows reports the
  // read-only attribute rather than the permission — so the case says which
  // platform it is measuring rather than passing vacuously on the others.
  const canMakeUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canMakeUnreadable)(
    'is a reported conflict, not an exception, and nothing in it is changed or removed',
    () => {
      const dorkHome = stageDorkHome([{ name: 'globex', skills: ['greet'] }]);
      const { agentsSkillsDir } = stageHome();
      const roots: GlobalPlanRoots = { dorkHome, agentsSkillsDir };
      mkdirSync(agentsSkillsDir, { recursive: true });

      // A link DorkOS put there earlier, and a file the person put there.
      symlinkSync(
        relative(agentsSkillsDir, join(globalPluginsDir(dorkHome), 'goneco', 'skills', 'vanished')),
        join(agentsSkillsDir, 'goneco__vanished')
      );
      chmodSync(agentsSkillsDir, 0o000);
      try {
        const plan = projectGlobal({ roots, harnesses: ['codex'] });

        // `--check` says it, rather than promising a fix that would then throw.
        const drift = checkGlobalPlan(plan, roots);
        expect(drift.blocked.map((a) => a.target)).toContain(
          planTarget(agentsSkillsDir, 'globex__greet')
        );
        expect(drift.blocked[0]?.reason).toContain('cannot read (permission denied)');

        // And `--fix` says the same thing instead of raising EACCES out of
        // `symlinkSync`, which is what it did before this probe existed.
        const result = applyGlobalPlan(plan, roots, { sweepOrphans: true });
        expect(result.conflicts.map((a) => a.target)).toContain(
          planTarget(agentsSkillsDir, 'globex__greet')
        );
        // The dork-home tier is unaffected: one hostile folder costs exactly the
        // links that go through it.
        expect(result.applied.map((a) => a.target)).toEqual([
          planTarget(globalSkillsDir(dorkHome), 'globex__greet'),
        ]);
        // And nothing was removed from the folder nobody could read. The sweep
        // already skipped it — `listDir` answers nothing — and this pins that the
        // two halves agree.
        expect(result.swept).toEqual([]);
      } finally {
        chmodSync(agentsSkillsDir, 0o755);
      }
      expect([...snapshotTree(agentsSkillsDir).keys()]).toEqual(['goneco__vanished']);
    }
  );
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
      planTarget(globalSkillsDir(dorkHome), 'globex__greet'),
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
    expect(targetsOf(plan)).toEqual([planTarget(globalSkillsDir(dorkHome), 'globex__greet')]);
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
