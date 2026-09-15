/**
 * DOR-1937 — which folder a global plan blames when it cannot read one.
 *
 * `projectGlobal` has one catch around `scanInstalledPlugins`, and it wrote one
 * sentence: "DorkOS could not read the folder your all-projects packages live
 * in: `<dorkHome>/plugins`". That is right for the failure it was written for
 * and wrong for the one a person actually produces. The scan also probes
 * `<dorkHome>/skills` — whether each package's skill is already linked there —
 * and a FILE at that path throws ENOTDIR out of the same call, so the message
 * sent a person to look at `plugins`, which was perfectly fine, while quoting
 * an errno about `skills` in parentheses.
 *
 * Measured during DOR-1882's review (2026-09-09):
 * `unreadableRoot: <dorkHome>/plugins`, `(ENOTDIR: not a directory, lstat
 * '<dorkHome>/skills/flow__capture')`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGlobal, globalPluginsDir, globalSkillsDir } from '../global-projector.js';
import { applyGlobalPlan, checkGlobalPlan } from '../../apply/global-apply.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

/** Whether this machine can stage a folder nobody may read. */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

const staged: string[] = [];
const relaxed: string[] = [];
afterEach(() => {
  for (const dir of relaxed.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // already gone
    }
  }
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A dork home holding one package installed for every project.
 *
 * @returns the dork home.
 */
function stageDorkHome(): string {
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-global-blame-'));
  staged.push(dorkHome);
  const pkg = join(dorkHome, 'plugins', 'flow');
  writeJsonAt(join(pkg, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name: 'flow',
    version: '1.0.0',
    type: 'plugin',
    description: 'flow test package',
    layers: ['skills'],
  });
  writeFileAt(
    join(pkg, 'skills', 'capture', 'SKILL.md'),
    '---\nname: capture\ndescription: Capture a thought\n---\n\n# capture\n'
  );
  return dorkHome;
}

describe('SK-03, SRC-04 — the folder a global plan names', () => {
  it('names the SKILLS root when that is what is in the way', () => {
    // Seeded defect: hard-code `pluginsRoot` in the catch. The sentence then
    // sends a person to a folder that is perfectly readable, with an errno
    // about a different one in parentheses (DOR-1937).
    const dorkHome = stageDorkHome();
    writeFileAt(globalSkillsDir(dorkHome), 'somebody put notes here\n');

    const plan = projectGlobal({ roots: { dorkHome }, harnesses: [] });

    expect(plan.unreadableRoot).toBe(globalSkillsDir(dorkHome));
    expect(plan.actions).toEqual([]);
    expect(plan.warnings.map((w) => w.reason)).toEqual([
      `DorkOS could not read the folder your all-projects skills are linked into: ` +
        `${globalSkillsDir(dorkHome)}. Nothing was linked, and nothing was removed.`,
    ]);
  });

  it('names it when NOTHING under it is ever probed', () => {
    // The shape that tells the ROOT probe from the nested one, on every OS.
    //
    // With a package installed, the scan `lstat`s `<dorkHome>/skills/<pkg>__<x>`
    // to answer whether that skill is already linked — and on POSIX a stat under
    // a FILE raises ENOTDIR, so the catch fires and blames the right root even
    // with no root probe at all. Windows answers ENOENT for the same call, which
    // `throwIfNoEntry: false` swallows, so the scan sees "not linked", never
    // throws, and the plan carried on as though the folder were fine (PR #1875,
    // `harness-windows`).
    //
    // An EMPTY plugins folder removes that accident entirely: there is no skill
    // to probe for, nothing under the file is ever touched, and the only thing
    // that can notice it is the root probe itself. Seeded defect: drop the
    // probe, and this reds on every platform rather than on Windows alone.
    const dorkHome = mkdtempSync(join(tmpdir(), 'harness-global-blame-empty-'));
    staged.push(dorkHome);
    mkdirSync(globalPluginsDir(dorkHome), { recursive: true });
    writeFileAt(globalSkillsDir(dorkHome), 'somebody put notes here\n');

    const plan = projectGlobal({ roots: { dorkHome }, harnesses: [] });

    expect(plan.unreadableRoot).toBe(globalSkillsDir(dorkHome));
    expect(plan.actions).toEqual([]);
    expect(plan.warnings.map((w) => w.reason)).toEqual([
      `DorkOS could not read the folder your all-projects skills are linked into: ` +
        `${globalSkillsDir(dorkHome)}. Nothing was linked, and nothing was removed.`,
    ]);
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)('still names the PACKAGES root when that is the one', () => {
    const dorkHome = stageDorkHome();
    const plugins = globalPluginsDir(dorkHome);
    chmodSync(plugins, 0o000);
    relaxed.push(plugins);

    const plan = projectGlobal({ roots: { dorkHome }, harnesses: [] });

    expect(plan.unreadableRoot).toBe(plugins);
    expect(plan.warnings.map((w) => w.reason)).toEqual([
      `DorkOS could not read the folder your all-projects packages live in: ${plugins}. ` +
        `Nothing was linked, and nothing was removed.`,
    ]);
  });

  it('says no errno and no stack, whichever root it is', () => {
    const dorkHome = stageDorkHome();
    writeFileAt(globalSkillsDir(dorkHome), 'notes\n');

    for (const warning of projectGlobal({ roots: { dorkHome }, harnesses: [] }).warnings) {
      expect(warning.reason).not.toMatch(/E[A-Z]+:/);
    }
  });

  it('blocks a global write path rather than throwing, and both modes agree', () => {
    // The pre-pass half of DOR-1937. The plan is empty here, so this is stated
    // on the shape that DOES reach a write: `<dorkHome>/skills` is fine and the
    // level above one of the plan's own targets is a file.
    const dorkHome = stageDorkHome();
    const agentsSkillsDir = join(dorkHome, 'user', '.agents', 'skills');
    writeFileAt(join(dorkHome, 'user', '.agents'), 'somebody wrote this\n');
    const plan = projectGlobal({ roots: { dorkHome, agentsSkillsDir }, harnesses: ['codex'] });
    const roots = { dorkHome, agentsSkillsDir };

    expect(plan.actions.some((a) => a.target?.startsWith(agentsSkillsDir))).toBe(true);
    const applied = applyGlobalPlan(plan, roots);
    // The link into the hostile root is refused; the one into `<dorkHome>/skills`
    // is written, because the shape question is asked per write path and not per
    // run.
    expect(applied.conflicts.map((c) => c.target)).toEqual([
      join(agentsSkillsDir, 'flow__capture'),
    ]);
    expect(applied.applied.map((a) => a.target)).toEqual([
      join(dorkHome, 'skills', 'flow__capture'),
    ]);
    // The two modes name the same path for the same reason, which is the
    // pre-pass working: `--check` reads the answer the apply acts on.
    expect(checkGlobalPlan(plan, roots).blocked.map((b) => [b.target, b.reason])).toEqual(
      applied.conflicts.map((c) => [c.target, c.reason])
    );
    expect(applied.conflicts[0]?.reason).toContain('is a file — DorkOS needs a folder there');
  });
});
