/**
 * A hostile non-directory on an apply write path (AP-11, DOR-1882).
 *
 * `generate-occupants.ts` decided what may sit AT a target and
 * `symlink-occupants.ts` did the same for links, but nothing decided what may
 * sit above them — and every write this engine makes creates its parent
 * directories first. So a plain file at `.claude/commands`, an unreadable
 * `.opencode/commands`, or a wrapper directory somebody replaced with a note
 * raised ENOTDIR / EEXIST / EACCES out of the MIDDLE of `applyPlan`: some
 * actions written, the six sweeps never reached, and a `--check` a moment
 * earlier that had called all of it ordinary drift and said "run `--fix`".
 *
 * Every case here therefore asserts the same four things about one shape:
 *
 * 1. nothing throws — `--check` and `--fix` both answer;
 * 2. the blocked projection is named, with a reason that names the FOLDER in the
 *    way (it is not the target, which the report already prints) and the way out;
 * 3. every other projection is still applied and every other sweep still runs —
 *    the tree is fully done or not at all, never half;
 * 4. nothing is deleted, and the obstacle itself is byte-identical afterwards.
 *
 * The one shape that is NOT refused lives here too, because it is what keeps the
 * rule from becoming "any link is an obstacle": a live link to a real folder is
 * a folder, and somebody keeping `.claude` in a dotfiles checkout has a working
 * repository the engine must not report a fault about.
 *
 * @module apply/__tests__/write-path-occupants
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';
import type { ProjectionAction, ProjectionPlan } from '../../plan/types.js';
import {
  diffSnapshots,
  snapshotTree,
  writeFileAt,
  writeJsonAt,
} from '../../__tests__/journeys/stage.js';

/** The bytes every fixture puts where a folder belongs. */
const IN_THE_WAY = 'not a folder\n';

let repo = '';
let dorkHome = '';
/** Directories a case made unreadable; restored before the tree is removed. */
const chmodded: string[] = [];

afterEach(() => {
  // A mode-000 directory defeats `rmSync -r` as thoroughly as it defeats the
  // scan under test, so the mode goes back before the cleanup runs.
  for (const abs of chmodded.splice(0)) {
    try {
      chmodSync(abs, 0o755);
    } catch {
      /* already gone */
    }
  }
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/**
 * Whether this platform can stage an unreadable directory.
 *
 * Not Windows, where POSIX modes do not mean this, and not root, who reads
 * everything regardless — in both cases the shape under test is not there and
 * asserting about it would be asserting about nothing.
 */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Make a directory unreadable for the rest of the test. */
function makeUnreadable(rel: string): void {
  const abs = join(repo, rel);
  chmodSync(abs, 0o000);
  chmodded.push(abs);
}

/**
 * Make a directory readable but not writable — the shape that lists perfectly
 * and then raises EACCES from the write itself.
 */
function makeReadOnly(rel: string): void {
  const abs = join(repo, rel);
  chmodSync(abs, 0o555);
  chmodded.push(abs);
}

/** Put a plain file where a folder belongs. */
function fileInTheWay(rel: string): void {
  writeFileAt(join(repo, rel), IN_THE_WAY);
}

/**
 * A repo enabling Claude Code, Codex and OpenCode with an `AGENTS.md`, one
 * authored skill, an authored Stop hook, and one project-scoped plugin shipping
 * a skill, a command and a hook.
 *
 * That set is what makes the fixtures discriminating: it puts a write path into
 * `.claude/skills`, `.claude/commands/<pkg>`, `.opencode/commands`, `.codex` and
 * `.agents/skills` at once, so blocking one has to leave the other four alone.
 */
function stageRepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-write-path-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-write-path-home-'));

  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex', 'opencode'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Project\n');
  writeFileAt(
    join(repo, '.agents', 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: The alpha skill\n---\n\n# alpha\n'
  );

  const plugin = join(repo, '.dork', 'plugins', 'acme');
  writeJsonAt(join(plugin, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name: 'acme',
    version: '1.0.0',
    type: 'plugin',
    description: 'Acme test plugin',
    layers: ['skills', 'hooks', 'commands'],
  });
  writeFileAt(
    join(plugin, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: The greet skill\n---\n\n# greet\n'
  );
  writeFileAt(join(plugin, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\n\nHello.\n');
  writeJsonAt(join(plugin, 'hooks', 'hooks.json'), {
    Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }],
  });
}

/** The plan for the staged repo, rebuilt from disk the way every trigger does. */
function plan(): ProjectionPlan {
  return project(repo, { dorkHome });
}

/** Every repo-relative target the plan writes, in plan order. */
function writeTargets(p: ProjectionPlan): string[] {
  return p.actions
    .filter((a) => a.kind !== 'native' && a.kind !== 'drop' && a.target !== undefined)
    .map((a) => a.target as string);
}

/** The reason reported for one blocked target, or `undefined`. */
function reasonFor(actions: readonly ProjectionAction[], target: string): string | undefined {
  return actions.find((a) => a.target === target)?.reason;
}

/**
 * Run the shape under test end to end and assert the three things every one of
 * them must satisfy, whatever the obstacle is.
 *
 * @param blockedTargets - the targets this obstacle sits above.
 * @param obstacle - the repo-relative folder in the way, as the reason must name it.
 * @returns the apply result, for the per-shape assertions that follow.
 */
function expectBlockedNotThrown(
  blockedTargets: readonly string[],
  obstacle: string
): ReturnType<typeof applyPlan> {
  const built = plan();
  const expected = writeTargets(built);
  expect(expected).toEqual(expect.arrayContaining([...blockedTargets]));

  // 1. `--check` answers, and says the same thing the write is about to.
  const drift = checkPlan(repo, built);
  for (const target of blockedTargets) {
    expect(drift.blocked.map((a) => a.target)).toContain(target);
    // The reason names the FOLDER in the way, which is not the target the
    // report already prints, and the way out.
    expect(reasonFor(drift.blocked, target)).toContain(`\`${obstacle}\``);
    expect(reasonFor(drift.blocked, target)).toContain('then re-run');
    // Blocked is not drift: re-running fixes nothing, so `--check` never tells
    // somebody to run the `--fix` that is about to refuse.
    expect(drift.drifted.map((a) => a.target)).not.toContain(target);
  }
  expect(drift.clean).toBe(false);

  const before = snapshotTree(repo);
  const applied = applyPlan(repo, built, { sweepOrphans: true });

  // 2. Named as a conflict, in the same words, and never applied.
  for (const target of blockedTargets) {
    expect(applied.conflicts.map((a) => a.target)).toContain(target);
    expect(reasonFor(applied.conflicts, target)).toBe(reasonFor(drift.blocked, target));
    expect(applied.applied.map((a) => a.target)).not.toContain(target);
  }

  // 3. Every OTHER projection landed — the tree is fully applied around the hole.
  const blocked = new Set(blockedTargets);
  const appliedTargets = new Set(applied.applied.map((a) => a.target));
  expect(expected.filter((t) => !blocked.has(t) && !appliedTargets.has(t))).toEqual([]);

  // 4. Nothing was removed on the way through.
  expect(diffSnapshots(before, snapshotTree(repo)).removed).toEqual([]);

  return applied;
}

describe('a file where a folder belongs on a write path', () => {
  it('AP-11: at `.claude/commands`, blocks that package’s wrappers and nothing else', () => {
    // Measured before this rule: ENOTDIR out of `writeFileAtomic`'s `mkdirSync`,
    // in the middle of the action loop.
    stageRepo();
    fileInTheWay('.claude/commands');

    expectBlockedNotThrown(
      ['.claude/commands/acme/hello.md', '.claude/commands/acme/.gitignore'],
      '.claude/commands'
    );

    // The obstacle is exactly as the person left it.
    expect(readFileSync(join(repo, '.claude/commands'), 'utf8')).toBe(IN_THE_WAY);
  });

  it('AP-11: at a wrapper directory, blocks that package’s commands only', () => {
    // Measured before this rule: ENOTDIR out of `findBlockedWrapperDirs`'s
    // `readdirSync`, BEFORE the loop ran at all — so not one projection landed.
    stageRepo();
    fileInTheWay('.claude/commands/acme');

    expectBlockedNotThrown(
      ['.claude/commands/acme/hello.md', '.claude/commands/acme/.gitignore'],
      '.claude/commands/acme'
    );

    expect(readFileSync(join(repo, '.claude/commands/acme'), 'utf8')).toBe(IN_THE_WAY);
  });

  it('AP-11: at `.opencode/commands`, blocks the flat wrappers — the EEXIST shape', () => {
    // The one directory a wrapper goes STRAIGHT into, so `mkdirSync` is asked to
    // make the file itself and answers EEXIST rather than ENOTDIR.
    stageRepo();
    fileInTheWay('.opencode/commands');

    expectBlockedNotThrown(
      ['.opencode/commands/acme-hello.md', '.opencode/commands/.gitignore'],
      '.opencode/commands'
    );

    expect(readFileSync(join(repo, '.opencode/commands'), 'utf8')).toBe(IN_THE_WAY);
  });

  it('AP-11: at `.claude/skills`, blocks the links and leaves the wrappers alone', () => {
    // A symlink action creates its parent too (`applySymlink`'s own `mkdirSync`),
    // so the obstacle is not a `generate`-only shape.
    stageRepo();
    fileInTheWay('.claude/skills');

    expectBlockedNotThrown(
      ['.claude/skills/alpha', '.claude/skills/acme__greet'],
      '.claude/skills'
    );

    expect(readFileSync(join(repo, '.claude/skills'), 'utf8')).toBe(IN_THE_WAY);
  });

  it('AP-05, AP-11: at `.codex`, blocks the hooks file it would hold', () => {
    // AP-05 settled what may sit AT a generate target; this is the same answer
    // one level up, and the sidecar is never minted for a file never written.
    stageRepo();
    fileInTheWay('.codex');

    expectBlockedNotThrown(['.codex/hooks.json'], '.codex');

    expect(readFileSync(join(repo, '.codex'), 'utf8')).toBe(IN_THE_WAY);
  });

  it('HK-11, AP-11: at `.claude`, blocks everything under it and destroys none of it', () => {
    // The widest blast radius the plan has — links, wrappers, the scaffolded
    // pointer and the managed-hook merge all live under this one folder.
    stageRepo();
    fileInTheWay('.claude');

    const built = plan();
    const under = writeTargets(built).filter((t) => t.startsWith('.claude/'));
    expect(under.length).toBeGreaterThanOrEqual(4);

    const applied = expectBlockedNotThrown(under, '.claude');

    // And what is NOT under it still landed, so one hostile folder never takes
    // the whole sync down.
    expect(applied.applied.map((a) => a.target)).toContain('.agents/skills/acme__greet');
    expect(readFileSync(join(repo, '.claude'), 'utf8')).toBe(IN_THE_WAY);
  });
});

describe('a link where a folder belongs on a write path', () => {
  it('AP-11: one pointing at nothing is refused, and never followed', () => {
    stageRepo();
    mkdirSync(join(repo, '.claude'), { recursive: true });
    symlinkSync('nowhere', join(repo, '.claude', 'commands'));

    expectBlockedNotThrown(
      ['.claude/commands/acme/hello.md', '.claude/commands/acme/.gitignore'],
      '.claude/commands'
    );

    // Still a link, and the place it pointed at was never created.
    expect(lstatSync(join(repo, '.claude/commands')).isSymbolicLink()).toBe(true);
    expect(snapshotTree(repo).has('.claude/nowhere')).toBe(false);
  });

  it('AP-11: one pointing at a real folder is a folder, and blocks nothing', () => {
    // The negative that keeps the rule from becoming "a link is an obstacle": a
    // person keeping `.claude` in a dotfiles checkout has a working repository.
    stageRepo();
    const elsewhere = join(repo, 'dotfiles', 'claude');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync('dotfiles/claude', join(repo, '.claude'));

    const built = plan();
    const drift = checkPlan(repo, built);
    expect(drift.blocked).toEqual([]);

    const { conflicts, applied } = applyPlan(repo, built, { sweepOrphans: true });

    expect(conflicts).toEqual([]);
    expect(applied.map((a) => a.target)).toEqual(expect.arrayContaining(writeTargets(built)));
    // The bytes landed through the link, in the real folder.
    expect(lstatSync(join(elsewhere, 'commands', 'acme', 'hello.md')).isFile()).toBe(true);
    expect(checkPlan(repo, built).blocked).toEqual([]);
  });
});

describe('a folder nobody may read on a write path', () => {
  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'AP-11: `.claude/commands` at mode 000 is blocked, not an EACCES out of the loop',
    () => {
      stageRepo();
      mkdirSync(join(repo, '.claude', 'commands'), { recursive: true });
      makeUnreadable('.claude/commands');

      expectBlockedNotThrown(
        ['.claude/commands/acme/hello.md', '.claude/commands/acme/.gitignore'],
        '.claude/commands'
      );
    }
  );

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'AP-11: a wrapper directory at mode 000 is blocked, and its contents are never read',
    () => {
      stageRepo();
      mkdirSync(join(repo, '.claude', 'commands', 'acme'), { recursive: true });
      makeUnreadable('.claude/commands/acme');

      expectBlockedNotThrown(
        ['.claude/commands/acme/hello.md', '.claude/commands/acme/.gitignore'],
        '.claude/commands/acme'
      );
    }
  );

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'AP-11: `.opencode/commands` at mode 000 is blocked, temp file and all',
    () => {
      // This one got furthest before the rule: `mkdirSync` succeeded on the
      // existing directory, `writeFileSync` failed EACCES, and the cleanup's own
      // `rmSync` then threw a SECOND EACCES over the temp file it could not stat.
      stageRepo();
      mkdirSync(join(repo, '.opencode', 'commands'), { recursive: true });
      makeUnreadable('.opencode/commands');

      expectBlockedNotThrown(
        ['.opencode/commands/acme-hello.md', '.opencode/commands/.gitignore'],
        '.opencode/commands'
      );
    }
  );
});

describe('a folder DorkOS may not write in', () => {
  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'AP-11: at mode 0555, blocks the writes that need it — EACCES from three different calls',
    () => {
      // Listable, so the shape pass says nothing about it; the failure lands on
      // the WRITE. Measured at 0555: `mkdirSync` for a wrapper directory under
      // `.claude/commands`, `writeFileSync` for the atomic temp inside
      // `.claude/commands/acme`, and `symlinkSync` for a link into
      // `.claude/skills` — three calls, one permission.
      stageRepo();
      mkdirSync(join(repo, '.claude', 'commands'), { recursive: true });
      makeReadOnly('.claude/commands');

      const applied = expectBlockedNotThrown(
        ['.claude/commands/acme/hello.md', '.claude/commands/acme/.gitignore'],
        '.claude/commands'
      );

      expect(reasonFor(applied.conflicts, '.claude/commands/acme/hello.md')).toContain(
        'may not write in'
      );
    }
  );

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'AP-11: at mode 0555 on a skills folder, blocks the links',
    () => {
      stageRepo();
      mkdirSync(join(repo, '.claude', 'skills'), { recursive: true });
      makeReadOnly('.claude/skills');

      expectBlockedNotThrown(
        ['.claude/skills/alpha', '.claude/skills/acme__greet'],
        '.claude/skills'
      );
    }
  );

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'AP-03, AP-11: a read-only folder nothing writes to is not a fault',
    () => {
      // The objection the permission probe has to answer, or it is worse than
      // the crash: a repository whose projections all already match is one this
      // engine writes nothing to, so the mode of the folder holding them is
      // nobody's business. Sync clean FIRST, then lock the folder.
      stageRepo();
      applyPlan(repo, plan(), { sweepOrphans: true });
      makeReadOnly('.claude/skills');

      const drift = checkPlan(repo, plan());

      expect(drift.blocked.map((a) => a.target)).not.toContain('.claude/skills/alpha');
      expect(drift.clean).toBe(true);

      const { conflicts } = applyPlan(repo, plan(), { sweepOrphans: true });
      expect(conflicts).toEqual([]);
    }
  );
});

describe('what a blocked write path costs the rest of the sync', () => {
  it('AP-03, AP-11: `--check` names it and writes nothing', () => {
    // AP-03 is the standing promise that a report never touches disk, and this
    // report reads more of the tree than any before it.
    stageRepo();
    fileInTheWay('.claude/commands');

    const before = snapshotTree(repo);
    const drift = checkPlan(repo, plan());

    expect(diffSnapshots(before, snapshotTree(repo))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
    expect(drift.blocked.map((a) => a.target)).toContain('.claude/commands/acme/hello.md');
  });

  it('AP-07, AP-11: every other sweep still runs, and takes nothing under the obstacle', () => {
    // Sync clean, then take the plugin away AND put a file where the wrapper
    // directory was — the shape that used to throw before the sweeps ran at all,
    // leaving every orphan of every other kind in place.
    stageRepo();
    applyPlan(repo, plan(), { sweepOrphans: true });
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });
    rmSync(join(repo, '.claude', 'commands', 'acme'), { recursive: true, force: true });
    fileInTheWay('.claude/commands/acme');

    const uninstalled = plan();
    const preview = checkPlan(repo, uninstalled).orphans;
    const { swept } = applyPlan(repo, uninstalled, { sweepOrphans: true });

    // The uninstalled plugin's links and its OpenCode wrappers are gone…
    expect(swept).toEqual(expect.arrayContaining(['.claude/skills/acme__greet']));
    expect(swept).toEqual(expect.arrayContaining(['.agents/skills/acme__greet']));
    expect(swept.some((p) => p.startsWith('.opencode/commands/'))).toBe(true);
    // …the preview said exactly the same list (DOR-1889's equality)…
    expect([...swept].sort()).toEqual([...preview].sort());
    // …and nothing under the obstacle was touched.
    expect(swept.some((p) => p.startsWith('.claude/commands/'))).toBe(false);
    expect(readFileSync(join(repo, '.claude/commands/acme'), 'utf8')).toBe(IN_THE_WAY);
  });

  it('AP-11: clearing the obstacle is all it takes — the next run is clean', () => {
    // The way out the reason names has to actually work, or it is advice.
    stageRepo();
    fileInTheWay('.claude/commands');
    applyPlan(repo, plan(), { sweepOrphans: true });

    rmSync(join(repo, '.claude', 'commands'), { force: true });
    applyPlan(repo, plan(), { sweepOrphans: true });

    const after = checkPlan(repo, plan());
    expect(after.blocked).toEqual([]);
    expect(after.clean).toBe(true);
  });
});
