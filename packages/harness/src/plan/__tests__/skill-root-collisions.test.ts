/**
 * SK-12 — one skill NAME in two folders the same tool reads.
 *
 * DOR-1902 taught the inventory to walk another tool's own skills folder, which
 * made a shape reachable that nothing had a sentence for: `.claude/skills/x` and
 * `.opencode/skills/x` are two different skills with one name, OpenCode reads
 * BOTH folders, and the plan said `native` twice and nothing else. Two lines
 * that each read like good news are not a report of a collision.
 *
 * What the warning has to say is the harness's own `dedupe` cell, which has
 * three outcomes and no fourth: the two collapse into one, both load, or the
 * vendor never wrote it down. Each is one frozen sentence, and each has its own
 * case here, because the mapping from a cell to a sentence is the whole claim —
 * only `unknown` is reachable through a real tree today (every harness that
 * reads more than one project skills root is `unknown`), so the other two are
 * put to the mapping directly rather than left unchecked.
 *
 * Each case states the seeded defect that reds it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import type { HarnessId } from '../../manifest/schema.js';
import type { ProjectionPlan } from '../types.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';
import { SKILL_ROOT_COLLISION_OUTCOMES, skillRootCollisionOutcome } from '../source-artifacts.js';

let repo = '';
let dorkHome = '';

/** Directories sealed by a case, unsealed before the cleanup that has to read them. */
const locked: string[] = [];

afterEach(() => {
  for (const dir of locked.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Already gone, or never sealed — neither is this test's business.
    }
  }
  for (const dir of [repo, dorkHome]) if (dir) rmSync(dir, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/**
 * Whether this machine can make a directory genuinely unreadable.
 *
 * Root ignores mode bits and Windows has no equivalent, so the case below is
 * skipped rather than faked there — same predicate `reason-vocabulary.test.ts`
 * uses for the same reason.
 */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Stage a repository whose manifest enables `harnesses`. */
function stage(harnesses: readonly HarnessId[]): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-collision-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-collision-home-'));
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: [...harnesses],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Our project\n\nHouse rules.\n');
}

/** Write a real skill directory whose frontmatter matches its folder. */
function stageSkill(relDir: string): void {
  const name = relDir.split('/').pop() as string;
  writeFileAt(
    join(repo, relDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n`
  );
}

/** The plan for the staged repository as it stands. */
function plan(): ProjectionPlan {
  return project(repo, { dorkHome });
}

/** Every warning one harness carries about one source. */
function warningsAbout(p: ProjectionPlan, harness: HarnessId, source: string): string[] {
  return p.warnings
    .filter((w) => w.harness === harness && w.source === source)
    .map((w) => w.reason)
    .sort();
}

/** Every `native` line one harness carries about one source. */
function nativeAbout(p: ProjectionPlan, harness: HarnessId, source: string): string[] {
  return p.actions
    .filter((a) => a.harness === harness && a.source === source && a.kind === 'native')
    .map((a) => a.reason ?? '')
    .sort();
}

describe('SK-12 — the three outcomes a dedupe cell has', () => {
  it('SK-12: a cell that keys by name says one of the two loses', () => {
    // Seeded defect: map `by-name` to the "both load" sentence. A person is then
    // told to expect two skills where the tool keeps one.
    expect(SKILL_ROOT_COLLISION_OUTCOMES[skillRootCollisionOutcome('by-name')]).toBe(
      'Only one of them loads, and which one is not something you choose.'
    );
  });

  it('SK-12: a cell that says duplicates are not merged says both load', () => {
    // Seeded defect: map `none` to the undocumented sentence. Codex's page states
    // the answer out loud, and calling a stated answer unknown is a worse report
    // than saying nothing.
    expect(SKILL_ROOT_COLLISION_OUTCOMES[skillRootCollisionOutcome('none')]).toBe(
      'Both of them load, under the same name.'
    );
    // Two folders are two real paths, so a realpath rule keeps both as well — it
    // collapses one folder reached twice, which is a different shape.
    expect(skillRootCollisionOutcome('by-realpath')).toBe(skillRootCollisionOutcome('none'));
  });

  it('SK-12: a cell the vendor never wrote says so, and does not guess', () => {
    // Seeded defect: map `unknown` to either of the other two. Four of the six
    // rows are `unknown`, so a guess here is what most people would read.
    expect(SKILL_ROOT_COLLISION_OUTCOMES[skillRootCollisionOutcome('unknown')]).toBe(
      'Its own documentation does not say which one wins.'
    );
  });
});

describe('SK-12 — one name in two folders one tool reads', () => {
  it('SK-12: warns beside BOTH native lines, and replaces neither', () => {
    // The seeded defect this whole ticket is: `.claude/skills/x` plus
    // `.opencode/skills/x` gave OpenCode two `native` lines and not one word
    // about there being two files under one name.
    stage(['claude-code', 'opencode']);
    stageSkill('.claude/skills/review-pr');
    stageSkill('.opencode/skills/review-pr');
    const p = plan();

    // Each line is read from its own file's point of view and names the OTHER
    // copy, so the terminal prints two sentences a person can tell apart and each
    // row in the app carries the one about the file that row is.
    const undocumented = 'Its own documentation does not say which one wins. Keep one.';
    expect(warningsAbout(p, 'opencode', '.claude/skills/review-pr')).toEqual([
      `another skill named "review-pr" is in .opencode/skills, and OpenCode reads both folders. ${undocumented}`,
    ]);
    expect(warningsAbout(p, 'opencode', '.opencode/skills/review-pr')).toEqual([
      `another skill named "review-pr" is in .claude/skills, and OpenCode reads both folders. ${undocumented}`,
    ]);
    // Both copies genuinely load, so neither `native` line goes away.
    expect(nativeAbout(p, 'opencode', '.claude/skills/review-pr')).toHaveLength(1);
    expect(nativeAbout(p, 'opencode', '.opencode/skills/review-pr')).toHaveLength(1);
  });

  it('SK-12: says nothing to a tool that reads only one of the two folders', () => {
    // Seeded defect: warn every enabled harness. Claude Code reads
    // `.claude/skills` and nothing else at project scope, so for Claude Code
    // there is exactly one skill of that name and no collision to report.
    stage(['claude-code', 'opencode']);
    stageSkill('.claude/skills/review-pr');
    stageSkill('.opencode/skills/review-pr');
    const p = plan();

    expect(warningsAbout(p, 'claude-code', '.claude/skills/review-pr')).toEqual([]);
    expect(warningsAbout(p, 'claude-code', '.opencode/skills/review-pr')).toEqual([]);
  });

  it('SK-12: counts folders, not copies — one name in one folder is not a collision', () => {
    // Seeded defect: count inventory entries instead of distinct roots. Every
    // ordinary skill in a repo would then be reported as colliding with itself.
    stage(['claude-code', 'opencode']);
    stageSkill('.claude/skills/review-pr');
    stageSkill('.opencode/skills/ship-it');
    const p = plan();

    expect(p.warnings.filter((w) => w.reason.includes('Keep one.'))).toEqual([]);
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'SK-12: a folder nobody can read is not half of a collision',
    () => {
      // The cross-check DOR-1933/1934/1935 made worth making: those changes taught
      // the engine to keep and NAME what it could not read, and a collision line
      // is a claim about two files a tool will load. A folder the engine could not
      // open is not evidence of a second skill — saying "two skills are named x"
      // about it would send somebody to delete a directory nobody has read.
      //
      // Seeded defect: inventory an unreadable skill directory as an ordinary
      // entry. The line comes back, naming a folder whose SKILL.md was never read.
      stage(['claude-code', 'opencode']);
      stageSkill('.claude/skills/review-pr');
      stageSkill('.opencode/skills/review-pr');
      const sealed = join(repo, '.claude', 'skills', 'review-pr');
      chmodSync(sealed, 0o000);
      locked.push(sealed);

      const p = plan();

      expect(p.warnings.filter((w) => w.reason.includes('Keep one.'))).toEqual([]);
      // And the copy that CAN be read keeps its own honest line.
      expect(nativeAbout(p, 'opencode', '.opencode/skills/review-pr')).toHaveLength(1);
    }
  );

  it('SK-12: names every other folder when a tool reads more than two of them', () => {
    // Seeded defect: hard-code "both folders". Cursor reads four project skills
    // roots, so a name in three of them is a real shape, and a sentence claiming
    // two would be counting wrong in front of a person.
    stage(['cursor']);
    stageSkill('.claude/skills/review-pr');
    stageSkill('.cursor/skills/review-pr');
    stageSkill('.codex/skills/review-pr');
    const p = plan();

    const tail =
      'all of those folders. Its own documentation does not say which one wins. Keep one.';
    expect(warningsAbout(p, 'cursor', '.cursor/skills/review-pr')).toEqual([
      `other skills named "review-pr" are in .claude/skills and .codex/skills, and Cursor reads ${tail}`,
    ]);
    expect(warningsAbout(p, 'cursor', '.claude/skills/review-pr')).toEqual([
      `other skills named "review-pr" are in .codex/skills and .cursor/skills, and Cursor reads ${tail}`,
    ]);
    expect(warningsAbout(p, 'cursor', '.codex/skills/review-pr')).toEqual([
      `other skills named "review-pr" are in .claude/skills and .cursor/skills, and Cursor reads ${tail}`,
    ]);
    // Three copies, three sentences — and no fourth from anywhere else.
    expect(p.warnings.filter((w) => w.reason.includes('Keep one.'))).toHaveLength(3);
  });

  it('SK-12: leaves the `.agents/skills` twin to the line that already answers for it', () => {
    // Seeded defect: drop the canonical-layer exclusion. Every skill this repo
    // keeps in both `.agents/skills` and `.claude/skills` would then carry a
    // second sentence beside the one `planAuthoredRootSkill` already writes —
    // which names the same two files and gives the same way out.
    stage(['claude-code', 'opencode']);
    stageSkill('.agents/skills/review-pr');
    stageSkill('.claude/skills/review-pr');
    const p = plan();

    expect(p.warnings.filter((w) => w.reason.includes('named "review-pr"'))).toEqual([]);
    // The line that does answer for it is still there, and still says "remove one".
    expect(
      p.actions.some(
        (a) =>
          a.source === '.claude/skills/review-pr' &&
          (a.reason ?? '').includes('remove it, or remove the canonical copy')
      )
    ).toBe(true);
  });
});
