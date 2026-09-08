/**
 * A dead symlink at a target the engine writes (AP-05, IN-05).
 *
 * A broken link is not content: there is nothing at the end of it to protect, and
 * nothing to read to decide who owns it. So the engine treats one as **drift** —
 * `--check` says so without throwing, and `--fix` removes the link and writes the
 * real file at that path.
 *
 * Removing the link before writing is the load-bearing half. `writeFileSync`
 * FOLLOWS a symlink, so writing through a dead `.codex/hooks.json` creates the
 * file wherever the link happens to point — outside the repo, if the link says
 * so — and leaves the path DorkOS was asked to write still a link. These cases
 * assert both halves: the right path gets the file, and the link's destination
 * stays empty.
 *
 * Before DOR-1843 the generate case made `checkPlan` throw ENOENT (it `lstat`ed
 * the path and then read it), and the scaffold case read as "already present" so
 * the pointer was never repaired.
 *
 * The two shapes that are NOT a dead link live here too, because they are the
 * cases the dead-link rule must not swallow: a **directory** and a **live
 * symlink** at a generate target are `blocked`, never drift. Both were measured
 * doing real damage — a directory made `--check` promise a `--fix` that then died
 * with EISDIR mid-loop, and a live link had the sidecar migration rewrite a file
 * OUTSIDE the repository.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';
import { getActionContent } from '../../plan/content-map.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';
import type { ProjectionAction, ProjectionPlan } from '../../plan/types.js';

/** The Codex hooks file the plan generates once an authored Stop hook exists. */
const GENERATE_TARGET = '.codex/hooks.json';

/** The Claude instruction pointer the plan scaffolds once `AGENTS.md` exists. */
const SCAFFOLD_TARGET = '.claude/CLAUDE.md';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** A repo enabling claude-code + codex, with an authored Stop hook and AGENTS.md. */
function stageRepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-dead-link-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-dead-link-home-'));
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Project\n');
  writeJsonAt(join(repo, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
  });
}

/** Put a symlink to a non-existent sibling at `rel`, and return where it points. */
function stageDeadLink(rel: string): string {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync('nowhere.json', abs);
  expect(lstatSync(abs).isSymbolicLink()).toBe(true);
  expect(existsSync(abs)).toBe(false); // it really is dead
  return join(dirname(abs), 'nowhere.json');
}

/** The exact bytes the current plan would write to `target`. */
function plannedContent(plan: ProjectionPlan, target: string): string {
  const action = plan.actions.find((a) => a.target === target);
  expect(action, `expected an action for ${target}`).toBeDefined();
  const content = getActionContent(action!);
  expect(content).toBeDefined();
  return content!;
}

describe('a dead link at a generate target', () => {
  it('is drift, and asking is not a crash', () => {
    stageRepo();
    stageDeadLink(GENERATE_TARGET);
    const plan = project(repo, { dorkHome });

    const drift = checkPlan(repo, plan);

    expect(drift.drifted.map((a) => a.target)).toContain(GENERATE_TARGET);
    // Nothing to read means no ownership question: it is stale, not blocked.
    expect(drift.blocked.map((a) => a.target)).not.toContain(GENERATE_TARGET);
    expect(drift.clean).toBe(false);
  });

  it('is replaced by the real file, at the real path', () => {
    stageRepo();
    const pointedAt = stageDeadLink(GENERATE_TARGET);
    const plan = project(repo, { dorkHome });

    const { applied, conflicts } = applyPlan(repo, plan);

    const abs = join(repo, GENERATE_TARGET);
    expect(lstatSync(abs).isFile()).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe(plannedContent(plan, GENERATE_TARGET));
    // The write did not follow the link somewhere else.
    expect(existsSync(pointedAt)).toBe(false);
    expect(applied.map((a) => a.target)).toContain(GENERATE_TARGET);
    expect(conflicts.map((a) => a.target)).not.toContain(GENERATE_TARGET);
    // Ownership is recorded, so the next run may rewrite or sweep it.
    expect(existsSync(`${abs}.dorkos-generated`)).toBe(true);
    expect(checkPlan(repo, plan).clean).toBe(true);
  });
});

describe('a dead link at a scaffold target', () => {
  it('is drift — a pointer nobody can follow is not a pointer', () => {
    stageRepo();
    stageDeadLink(SCAFFOLD_TARGET);
    const plan = project(repo, { dorkHome });

    const drift = checkPlan(repo, plan);

    expect(drift.drifted.map((a) => a.target)).toContain(SCAFFOLD_TARGET);
    expect(drift.clean).toBe(false);
  });

  it('is replaced by the pointer, at the real path', () => {
    stageRepo();
    const pointedAt = stageDeadLink(SCAFFOLD_TARGET);
    const plan = project(repo, { dorkHome });

    applyPlan(repo, plan);

    const abs = join(repo, SCAFFOLD_TARGET);
    expect(lstatSync(abs).isFile()).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe(plannedContent(plan, SCAFFOLD_TARGET));
    expect(existsSync(pointedAt)).toBe(false);
    expect(checkPlan(repo, plan).clean).toBe(true);
  });

  it('still never overwrites a real scaffold a person has edited', () => {
    // The dead-link branch must not widen into "the engine owns this path".
    stageRepo();
    writeFileAt(join(repo, SCAFFOLD_TARGET), '# my own pointer\n');
    const plan = project(repo, { dorkHome });

    applyPlan(repo, plan);

    expect(readFileSync(join(repo, SCAFFOLD_TARGET), 'utf8')).toBe('# my own pointer\n');
    expect(checkPlan(repo, plan).drifted.map((a) => a.target)).not.toContain(SCAFFOLD_TARGET);
  });
});

describe('what the engine refuses to write over at a generate target', () => {
  it('a directory is blocked, not drift — so --check never promises a --fix that dies', () => {
    // Measured before this rule: `--check` printed "Run --fix to apply", and the
    // `--fix` it recommended threw EISDIR partway through the action loop.
    stageRepo();
    writeFileAt(join(repo, GENERATE_TARGET, 'notes.md'), '# mine\n');
    const plan = project(repo, { dorkHome });

    const drift = checkPlan(repo, plan);

    expect(drift.drifted.map((a) => a.target)).not.toContain(GENERATE_TARGET);
    expect(drift.blocked.map((a) => a.target)).toContain(GENERATE_TARGET);
    expect(drift.blocked.find((a) => a.target === GENERATE_TARGET)?.reason).toContain('directory');
    expect(drift.clean).toBe(false);

    const { applied, conflicts } = applyPlan(repo, plan);

    expect(conflicts.map((a) => a.target)).toContain(GENERATE_TARGET);
    expect(applied.map((a) => a.target)).not.toContain(GENERATE_TARGET);
    expect(readFileSync(join(repo, GENERATE_TARGET, 'notes.md'), 'utf8')).toBe('# mine\n');
  });

  it('a LIVE link is blocked, so nothing is written through it', () => {
    // The link points OUTSIDE the repository at a file holding the engine's own
    // legacy bare event map — the one shape migration rule 2 is allowed to
    // rewrite. It rewrote that outside file, at a path no ownership rule in this
    // package has ever been asked about.
    stageRepo();
    const outside = mkdtempSync(join(tmpdir(), 'harness-outside-'));
    const elsewhere = join(outside, 'their-hooks.json');
    const theirBytes = `${JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo THEIRS' }] }] }, null, 2)}\n`;
    writeFileAt(elsewhere, theirBytes);
    mkdirSync(join(repo, '.codex'), { recursive: true });
    symlinkSync(elsewhere, join(repo, GENERATE_TARGET));

    try {
      const plan = project(repo, { dorkHome });

      const drift = checkPlan(repo, plan);
      expect(drift.blocked.map((a) => a.target)).toContain(GENERATE_TARGET);
      expect(drift.blocked.find((a) => a.target === GENERATE_TARGET)?.reason).toContain('symlink');
      expect(drift.drifted.map((a) => a.target)).not.toContain(GENERATE_TARGET);

      const { conflicts } = applyPlan(repo, plan, { sweepOrphans: true });

      expect(conflicts.map((a) => a.target)).toContain(GENERATE_TARGET);
      // The link is still a link, and the file it points at still holds their bytes.
      expect(lstatSync(join(repo, GENERATE_TARGET)).isSymbolicLink()).toBe(true);
      expect(readFileSync(elsewhere, 'utf8')).toBe(theirBytes);
      // And no sidecar was minted for a file the engine never wrote.
      expect(existsSync(`${join(repo, GENERATE_TARGET)}.dorkos-generated`)).toBe(false);
      expect(existsSync(`${elsewhere}.dorkos-generated`)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports drift for a content-less action at an absent target rather than throwing', () => {
    // A `generate` action the projector never attached bytes to is a projector
    // bug, and `requireActionContent` says so loudly — but `--check` must reach
    // its report to say anything at all, so absence is settled first.
    stageRepo();
    const action: ProjectionAction = {
      kind: 'generate',
      artifact: 'hook',
      harness: 'codex',
      provenance: 'authored',
      name: 'contentless',
      target: '.codex/never-written.json',
    };
    const plan: ProjectionPlan = { actions: [action], drops: [], warnings: [] };

    expect(checkPlan(repo, plan).drifted).toEqual([action]);
  });
});
