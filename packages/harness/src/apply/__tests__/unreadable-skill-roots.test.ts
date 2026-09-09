/**
 * A skill SOURCE folder nobody can list, and why the sweeps stand down over one
 * (AP-07, SK-10, AP-11, DOR-1882).
 *
 * The sweeps read the plan as their keep-set: a `.claude/skills` link the plan
 * does not name came from something that is gone, so it goes. That inference is
 * only as good as the plan, and a folder nobody could read yields the same empty
 * listing an empty folder does. So the moment the scan started swallowing
 * ENOTDIR and EACCES instead of throwing them, one `chmod 000` on
 * `.agents/skills` made every authored projection look orphaned and a sync
 * deleted `.claude/skills/*` — and an unreadable package `skills/` took all four
 * of that package's links the same way, with nothing printed at all. Measured on
 * the built dist. The crash it replaced was worse to read and better to have:
 * it removed nothing.
 *
 * So the scan tells ABSENT from UNLISTABLE — ENOENT with nothing there is the
 * only silent answer — and an unlistable root puts its folder on
 * `plan.unreadableSkillRoots`, which does three things: both skill-link sweeps
 * stand down, a warning names the folder and says what was left alone, and
 * `checkPlan` is not clean.
 *
 * Five shapes, and the last one is the reason ENOENT alone is not the test: a
 * root that is a LINK POINTING AT NOTHING reads as ENOENT, and treating it as an
 * empty folder deleted every link into it — which it did before any of this,
 * too.
 *
 * @module apply/__tests__/unreadable-skill-roots
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';
import type { ProjectionPlan } from '../../plan/types.js';
import {
  diffSnapshots,
  snapshotTree,
  writeFileAt,
  writeJsonAt,
} from '../../__tests__/journeys/stage.js';

/** The repo-relative links a clean sync of the fixture leaves behind. */
const PROJECTED_LINKS = [
  '.claude/skills/alpha',
  '.claude/skills/beta',
  '.claude/skills/acme__greet',
  '.claude/skills/acme__wave',
  '.agents/skills/acme__greet',
  '.agents/skills/acme__wave',
] as const;

let repo = '';
let dorkHome = '';
/** Directories a case made unreadable; restored before the tree is removed. */
const chmodded: string[] = [];

afterEach(() => {
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
 * everything regardless — in both cases the shape under test is not there, and
 * asserting about it would be asserting about nothing.
 */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Make a directory unreadable for the rest of the test. */
function makeUnreadable(rel: string): void {
  const abs = join(repo, rel);
  chmodSync(abs, 0o000);
  chmodded.push(abs);
}

/** Two authored skills and a package shipping two more, all four projected. */
function stageRepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-skill-root-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-skill-root-home-'));

  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex'],
  });
  for (const name of ['alpha', 'beta']) {
    writeFileAt(
      join(repo, '.agents', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n`
    );
  }
  const plugin = join(repo, '.dork', 'plugins', 'acme');
  writeJsonAt(join(plugin, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name: 'acme',
    version: '1.0.0',
    type: 'plugin',
    description: 'Acme test plugin',
    layers: ['skills'],
  });
  for (const name of ['greet', 'wave']) {
    writeFileAt(
      join(plugin, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n`
    );
  }
}

/** The plan for the staged repo, rebuilt from disk the way every trigger does. */
function plan(): ProjectionPlan {
  return project(repo, { dorkHome });
}

/** Sync the staged repo the way `dorkos harness sync --fix` does. */
function sync(): ReturnType<typeof applyPlan> {
  return applyPlan(repo, plan(), { sweepOrphans: true });
}

/**
 * Stage the fixture, sync it clean, then break one skill root and sync again —
 * asserting the four things every one of these shapes must satisfy.
 *
 * @param folder - the repo-relative skill folder the break is at, as the
 *   warning and the marker must name it.
 * @param breakIt - how to make that folder unlistable.
 */
function expectSweepsStandDown(folder: string, breakIt: () => void): void {
  stageRepo();
  sync();
  // Every projection is really there before the break, or nothing below is a
  // claim about links at risk.
  const afterFirstSync = snapshotTree(repo);
  for (const link of PROJECTED_LINKS) {
    expect({ link, present: afterFirstSync.has(link) }).toEqual({ link, present: true });
  }

  breakIt();
  const broken = plan();

  // 1. The plan says which folder it could not read.
  expect(broken.unreadableSkillRoots).toEqual([folder]);

  // 2. One warning, naming the folder and what was left alone — and only one,
  //    because the inventory reports the same folder in smaller words.
  const named = broken.warnings.filter((w) => w.name === folder);
  expect(named).toHaveLength(1);
  expect(named[0]?.reason).toContain(folder);
  expect(named[0]?.reason).toContain('left exactly as it is');
  expect(named[0]?.harnessAgnostic).toBe(true);

  // 3. `--check` promises no removal, and does not call the tree clean.
  const drift = checkPlan(repo, broken);
  expect(drift.orphans).toEqual([]);
  expect(drift.clean).toBe(false);

  // 4. `--fix` removes nothing, and every link is still exactly where it was.
  const before = snapshotTree(repo);
  const { swept } = sync();

  expect(swept).toEqual([]);
  expect(diffSnapshots(before, snapshotTree(repo)).removed).toEqual([]);
}

describe('a skills folder DorkOS cannot read', () => {
  it('AP-07, SK-10: a FILE at `.agents/skills` sweeps nothing', () => {
    // Measured before the marker: `swept: ['.claude/skills/alpha',
    // '.claude/skills/beta']` — two live projections, deleted in silence.
    expectSweepsStandDown('.agents/skills', () => {
      rmSync(join(repo, '.agents', 'skills'), { recursive: true, force: true });
      writeFileSync(join(repo, '.agents', 'skills'), 'not a folder\n');
    });
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'AP-07, SK-10: `.agents/skills` at mode 000 sweeps nothing',
    () => {
      expectSweepsStandDown('.agents/skills', () => {
        makeUnreadable('.agents/skills');
      });
    }
  );

  it('AP-07, AP-11: a FILE at a package’s `skills/` sweeps none of its links', () => {
    // The package half, and the one that printed NOTHING before: four links
    // swept with `plan.warnings: []`.
    expectSweepsStandDown('.dork/plugins/acme/skills', () => {
      const skills = join(repo, '.dork', 'plugins', 'acme', 'skills');
      rmSync(skills, { recursive: true, force: true });
      writeFileSync(skills, 'not a folder\n');
    });
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'AP-07, AP-11: a package’s `skills/` at mode 000 sweeps none of its links',
    () => {
      expectSweepsStandDown('.dork/plugins/acme/skills', () => {
        makeUnreadable('.dork/plugins/acme/skills');
      });
    }
  );

  it('AP-07, SK-10: a skills root that is a link to nothing sweeps nothing', () => {
    // `readdir` answers ENOENT for this one, exactly as it does for a folder
    // that was never there — and the two are opposite facts. Somebody made this
    // entry, and the links into it are still live projections. This flavour
    // deleted them before any of DOR-1882, so it is a fix rather than a
    // regression closed.
    expectSweepsStandDown('.agents/skills', () => {
      mkdirSync(join(repo, 'vault'), { recursive: true });
      renameSync(join(repo, '.agents', 'skills'), join(repo, 'vault', 'skills'));
      symlinkSync('../vault/skills', join(repo, '.agents', 'skills'));
      renameSync(join(repo, 'vault', 'skills'), join(repo, 'vault', 'moved'));
    });
  });
});

describe('what a readable tree still gets', () => {
  it('AP-07: an ABSENT skills folder is silent, and the sweeps still run', () => {
    // The negative that keeps the marker from becoming "never sweep": absent is
    // the one answer that stays silent, so a plugin somebody uninstalled still
    // has its links removed.
    stageRepo();
    sync();
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const uninstalled = plan();

    expect(uninstalled.unreadableSkillRoots).toBeUndefined();
    expect(uninstalled.warnings.map((w) => w.name)).not.toContain('.dork/plugins/acme/skills');

    const { swept } = applyPlan(repo, uninstalled, { sweepOrphans: true });

    expect([...swept].sort()).toEqual([
      '.agents/skills/acme__greet',
      '.agents/skills/acme__wave',
      '.claude/skills/acme__greet',
      '.claude/skills/acme__wave',
    ]);
    // The authored links are untouched, so the sweep is scoped, not switched off.
    expect(snapshotTree(repo).has('.claude/skills/alpha')).toBe(true);
  });

  it('AP-07: clearing the folder lets the sweep catch up', () => {
    // The way out the warning names has to work, or it is advice: the links the
    // sweep declined to take are taken as soon as it can see again.
    stageRepo();
    sync();
    const skills = join(repo, '.dork', 'plugins', 'acme', 'skills');
    rmSync(skills, { recursive: true, force: true });
    writeFileSync(skills, 'not a folder\n');
    expect(sync().swept).toEqual([]);

    rmSync(skills, { force: true });
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const { swept } = sync();

    expect([...swept].sort()).toEqual([
      '.agents/skills/acme__greet',
      '.agents/skills/acme__wave',
      '.claude/skills/acme__greet',
      '.claude/skills/acme__wave',
    ]);
    expect(checkPlan(repo, plan()).clean).toBe(true);
  });
});
