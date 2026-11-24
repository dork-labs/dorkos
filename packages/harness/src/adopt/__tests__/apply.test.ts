/**
 * AP-17 and SRC-10 — the move, the link, the crash and the restore, over REAL
 * temp repositories.
 *
 * The `hook-projection-gate` and `project-agent-workspace` suites are the
 * precedent, and this surface's whole subject is what happens to files: a plan
 * asserted against a fake filesystem would prove nothing about the one property
 * that matters, which is that a failed adopt leaves the tree exactly as it found
 * it.
 *
 * **Two things are stubbed and only two**, and they are the two failures a
 * filesystem will not produce on demand: `applyPlan` throwing, and `renameSync`
 * coming back `EXDEV`. Everything else is the real engine over a real tree.
 *
 * Nothing here exists on `main`, so "fails on main" proves nothing. Each case
 * names the seeded defect that discriminates it instead — a one-line mutation of
 * the shipped code that must turn it red.
 *
 * @module adopt/__tests__/apply
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkCheckFor, linkMatchesPlan } from '../../apply/symlink-occupants.js';

/**
 * Whether `applyPlan` should throw instead of writing the link, and whether
 * something should be planted at the link's target first.
 *
 * Hoisted because `vi.mock` is, and a flag the cases can flip is what keeps the
 * stub to the one call it is about rather than mocking the module for the file.
 */
const stub = vi.hoisted(() => ({
  throws: false,
  plant: undefined as string | undefined,
  exdev: false,
  failSecondRename: false,
  renames: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      stub.renames += 1;
      if (stub.failSecondRename && stub.renames === 2) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      if (!stub.exdev) return actual.renameSync(...args);
      const err: NodeJS.ErrnoException = new Error('EXDEV: cross-device link');
      err.code = 'EXDEV';
      throw err;
    },
  };
});

vi.mock('../../apply/apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apply/apply.js')>();
  return {
    ...actual,
    applyPlan: (...args: Parameters<typeof actual.applyPlan>) => {
      if (stub.throws) throw new Error('the projection died between the two steps');
      if (stub.plant !== undefined) writeFileSync(stub.plant, 'somebody else got here first\n');
      return actual.applyPlan(...args);
    },
  };
});

const { applyAdopt } = await import('../apply.js');
const { planAdopt } = await import('../plan.js');
const { readAdoptCandidates } = await import('../read.js');
const { loadManifest } = await import('../../engine.js');
const { inventorySourceTree } = await import('../../inventory/index.js');

/** The skill every case is about. */
const NAME = 'deploy-checklist';

/**
 * The link back points at the canonical copy — asked the way the engine asks it,
 * because the link TEXT differs by platform: POSIX stores the relative text
 * verbatim; Windows has no relative junction, so `readlink` answers an absolute
 * path for the same, correct link (measured on the `harness-windows` leg).
 */
function expectLinkBack(repo: string): void {
  const link = join(repo, '.claude', 'skills', NAME);
  const target = join(repo, '.agents', 'skills', NAME);
  expect(
    linkMatchesPlan(link, target, `../../.agents/skills/${NAME}`, linkCheckFor(process.platform)),
    `${link} does not point at the canonical copy`
  ).toBe(true);
}

/** The temp repositories one case made, removed at the end of it. */
let repos: string[] = [];

beforeEach(() => {
  stub.throws = false;
  stub.plant = undefined;
  stub.exdev = false;
  stub.failSecondRename = false;
  stub.renames = 0;
  repos = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

/**
 * A repository with a manifest, and one skill in a harness-owned root.
 *
 * @param root - the root to stage the skill in.
 * @param harnesses - the harnesses the manifest enables.
 * @returns the absolute repository root.
 */
function stageRepo(root = '.claude/skills', harnesses = ['claude-code', 'codex']): string {
  const repo = mkdtempSync(join(tmpdir(), 'dorkos-adopt-apply-'));
  repos.push(repo);
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    `${JSON.stringify({ version: 1, harnesses }, null, 2)}\n`
  );
  mkdirSync(join(repo, root, NAME), { recursive: true });
  writeFileSync(
    join(repo, root, NAME, 'SKILL.md'),
    `---\nname: ${NAME}\ndescription: Check the deploy\n---\n\nStep one.\n`
  );
  writeFileSync(join(repo, root, NAME, 'checklist.txt'), 'one\ntwo\n');
  return repo;
}

/**
 * The plan one explicit adopt run would make in a real repository.
 *
 * The real reader over the real tree, so a case cannot pass by planning
 * something the reader would never have produced.
 *
 * @param repo - the repository root.
 * @param name - the skill to adopt.
 * @param claudeOnly - whether to declare rather than move.
 * @returns the plan.
 */
function planFor(repo: string, name = NAME, claudeOnly = false) {
  const read = readAdoptCandidates(repo, inventorySourceTree(repo), loadManifest(repo));
  return planAdopt({
    ...read,
    request: { mode: 'explicit', name, ...(claudeOnly ? { claudeOnly: true } : {}) },
    ownership: 'plain',
  });
}

/**
 * Every path under `root`, with what is AT it — a content hash rather than a
 * path list.
 *
 * The shape-only version of this idea is the CLI suite's `snapshotTree`, whose
 * own docstring names the blind spot: an in-place rewrite of a file that already
 * existed passes it. Two of this file's assertions are exactly that case — a
 * restore has to put the same BYTES back, not a path with the same name — so
 * this one hashes.
 *
 * @param root - the directory to walk.
 * @returns one line per path, sorted, each carrying its own digest.
 */
function hashTree(root: string): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = join(dir, entry.name);
        if (entry.isSymbolicLink()) return [`${rel} -> ${readlinkSync(abs)}`];
        if (entry.isDirectory()) return [`${rel}/`, ...walk(abs, rel)];
        return [`${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`];
      })
      .sort();
  return walk(root, '');
}

describe('AP-17 — applyAdopt moves one skill and leaves the projection behind', () => {
  it('AP-17: moves the whole directory and leaves the relative link Claude Code reads', () => {
    // Seeded defect: copy the SKILL.md instead of renaming the directory, and
    // the second file in the skill never arrives — which the content hash sees
    // and a path list would too, but only this one sees a truncated copy.
    const repo = stageRepo();
    const before = hashTree(join(repo, '.claude', 'skills', NAME));

    const result = applyAdopt(repo, planFor(repo));

    expect({
      moved: result.moved.map((move) => `${move.from} -> ${move.to}`),
      refusals: result.refusals.map((refusal) => refusal.rule),
    }).toEqual({
      moved: [`.claude/skills/${NAME} -> .agents/skills/${NAME}`],
      refusals: [],
    });
    expect(hashTree(join(repo, '.agents', 'skills', NAME))).toEqual(before);
    expectLinkBack(repo);
  });

  it('AP-17: puts everything back when the projection dies between the two steps', () => {
    // Seeded defect: delete the restore, and the source-path assertion reds.
    const repo = stageRepo();
    const before = hashTree(repo);
    stub.throws = true;

    const result = applyAdopt(repo, planFor(repo));

    expect({
      moved: result.moved.length,
      rules: result.refusals.map((refusal) => refusal.rule),
      reason: result.refusals[0]?.reason,
    }).toEqual({
      moved: 0,
      rules: ['link-blocked'],
      reason: 'the projection died between the two steps',
    });
    // Not just "the source is back": NO other path in the tree changed either.
    expect(hashTree(repo)).toEqual(before);
  });

  it('AP-17: keeps the skill whole when somebody takes the old path while it works', () => {
    // The one conflict a `.claude/skills` adopt can reach, because the link's
    // target IS the path the move vacated. DorkOS cannot rename back onto a file
    // a person just put there, so it says where the skill is and how to finish —
    // the same drift a crash leaves, named out loud.
    //
    // Seeded defect: restore unconditionally, and the rename throws ENOTDIR out
    // of the middle of the apply instead of reporting anything.
    const repo = stageRepo();
    stub.plant = join(repo, '.claude', 'skills', NAME);

    const result = applyAdopt(repo, planFor(repo));

    expect(result.moved).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    const refusal = result.refusals[0]!;
    expect(refusal.rule).toBe('link-blocked');
    // `applySymlink`'s own words about the occupant, not a second vocabulary.
    expect(refusal.reason).toContain('.claude/skills');
    expect(refusal.reason).toContain(
      `Your skill is safe at .agents/skills/${NAME}, where every agent but Claude Code reads it. ` +
        `Clear .claude/skills/${NAME}, then run dorkos harness sync --fix to give Claude Code ` +
        `its link back.`
    );
    expect(readFileSync(join(repo, '.agents', 'skills', NAME, 'checklist.txt'), 'utf8')).toBe(
      'one\ntwo\n'
    );
  });

  it('AP-17: says where the skill is when even the way back fails', () => {
    // The restore is one rename into a path this process vacated a moment ago,
    // and it is still not guaranteed: whatever blocked the link may equally
    // block the way back. Stubbed here by making the SECOND rename the failing
    // one, which no filesystem produces on demand.
    //
    // Seeded defect: leave the rename-back unguarded and the refusal becomes an
    // exception out of the middle of the apply — the one shape this module
    // exists to avoid.
    const repo = stageRepo();
    stub.throws = true;
    stub.failSecondRename = true;

    const result = applyAdopt(repo, planFor(repo));

    expect(result.moved).toEqual([]);
    expect(result.refusals[0]?.reason).toContain(
      `Your skill is safe at .agents/skills/${NAME}, where every agent but Claude Code reads it.`
    );
    // Nothing was lost: every byte is at the canonical root.
    expect(readFileSync(join(repo, '.agents', 'skills', NAME, 'checklist.txt'), 'utf8')).toBe(
      'one\ntwo\n'
    );
  });

  it('AP-17: refuses a move across filesystems rather than copying half a skill', () => {
    const repo = stageRepo();
    const before = hashTree(repo);
    stub.exdev = true;

    const result = applyAdopt(repo, planFor(repo));

    expect(result.moved).toEqual([]);
    expect(result.refusals.map((refusal) => `${refusal.rule}: ${refusal.reason}`)).toEqual([
      `cross-device: DorkOS can't move .claude/skills/${NAME} into .agents/skills because the ` +
        `two folders are on different drives. Move the folder yourself, then run dorkos harness ` +
        `sync --fix.`,
    ]);
    stub.exdev = false;
    expect(hashTree(repo)).toEqual(before);
  });

  it('AP-17: adopting the same name twice is refused the second time, and changes nothing', () => {
    const repo = stageRepo();
    applyAdopt(repo, planFor(repo));
    const after = hashTree(repo);

    // The skill is now at `.agents/skills` with a link where it was, so the
    // reader offers nothing and R1 answers — the same sentence a name nobody
    // has ever used gets, because a duplicate is what the tree would hold.
    const second = applyAdopt(repo, planFor(repo));

    expect(second.moved).toEqual([]);
    expect(second.refusals.map((refusal) => refusal.rule)).toEqual(['not-adoptable']);
    expect(hashTree(repo)).toEqual(after);
  });
});

describe('AP-17 — --claude-only writes one manifest element and moves nothing', () => {
  it('AP-17: records the skill, leaving every other byte of the manifest alone', () => {
    const repo = stageRepo();
    const manifestPath = join(repo, '.agents', 'harness.manifest.json');
    const before = readFileSync(manifestPath, 'utf8');
    const skillBefore = hashTree(join(repo, '.claude', 'skills', NAME));

    const result = applyAdopt(repo, planFor(repo, NAME, true));

    expect(result.declared).toEqual([
      { name: NAME, path: `.claude/skills/${NAME}`, reason: 'Kept in Claude Code on purpose.' },
    ]);
    expect(result.moved).toEqual([]);
    const after = readFileSync(manifestPath, 'utf8');
    expect(JSON.parse(after)).toEqual({
      version: 1,
      harnesses: ['claude-code', 'codex'],
      claudeOnlySkills: [
        { name: NAME, path: `.claude/skills/${NAME}`, reason: 'Kept in Claude Code on purpose.' },
      ],
    });
    // A pure insertion, asserted as BYTES: the file with the one new element
    // taken back out is the file that was there before, separator included.
    const inserted = [
      ',',
      '  "claudeOnlySkills": [{',
      `    "name": "${NAME}",`,
      `    "path": ".claude/skills/${NAME}",`,
      '    "reason": "Kept in Claude Code on purpose."',
      '  }]',
    ].join('\n');
    expect(after.replace(inserted, '')).toBe(before);
    expect(hashTree(join(repo, '.claude', 'skills', NAME))).toEqual(skillBefore);
  });
});
