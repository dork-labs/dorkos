/**
 * Ownership of the engine-generated hook files (HK-11).
 *
 * A generated hook file is the engine's only when a `<target>.dorkos-generated`
 * sidecar sits beside it holding the sha256 of the exact bytes on disk. That is
 * what separates "DorkOS wrote this and may rewrite or prune it" from "a person
 * wrote this, or edited what DorkOS wrote, and it is theirs now" — a distinction
 * an in-file marker could never make, because Codex's and Cursor's own docs tell
 * people to hand-write exactly these files.
 *
 * These cases cover the three migration rules for files the engine wrote BEFORE
 * sidecars existed, the narrowness of rule 2, and the sweep's one guard —
 * ownership, which is the whole of it: a harness leaving the manifest does not
 * spare a file the engine wrote, and does not endanger one it did not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';
import { sweepGeneratedOrphans } from '../generated-targets.js';
import { getActionContent } from '../../plan/content-map.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';
import type { ProjectionPlan } from '../../plan/types.js';

/**
 * The sidecar suffix, spelled out rather than imported: this file states the
 * on-disk contract a person's tree has to satisfy, so it must red if the engine
 * ever renames the suffix. `resolve-roots.test.ts` pins the same string against
 * the gitignore patterns.
 */
const GENERATED_SIDECAR_SUFFIX = '.dorkos-generated';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/**
 * A repo enabling claude-code + codex + cursor with one authored Stop hook, so
 * the plan generates BOTH `.codex/hooks.json` and `.cursor/hooks.json`.
 */
function stageRepo(harnesses: string[] = ['claude-code', 'codex', 'cursor']): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-own-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-own-home-'));
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), { version: 1, harnesses });
  writeFileAt(join(repo, 'AGENTS.md'), '# Project\n');
  writeJsonAt(join(repo, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
  });
}

/** The exact bytes the current plan would write to `target`. */
function plannedContent(plan: ProjectionPlan, target: string): string {
  const action = plan.actions.find((a) => a.kind === 'generate' && a.target === target);
  expect(action, `expected a generate action for ${target}`).toBeDefined();
  const content = getActionContent(action!);
  expect(content).toBeDefined();
  return content!;
}

/** The sidecar path beside a repo-relative target. */
function sidecarOf(target: string): string {
  return join(repo, `${target}${GENERATED_SIDECAR_SUFFIX}`);
}

describe('generated hook file ownership', () => {
  it('HK-11: writes a sidecar holding the sha256 of exactly the bytes it wrote', () => {
    stageRepo();
    const plan = project(repo, { dorkHome });
    applyPlan(repo, plan);

    const written = readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8');
    expect(readFileSync(sidecarOf('.codex/hooks.json'), 'utf8')).toBe(
      `${createHash('sha256').update(written).digest('hex')}\n`
    );
  });

  it('HK-11: adopts a pre-sidecar file whose bytes it would have written anyway (migration rule 1)', () => {
    stageRepo();
    const plan = project(repo, { dorkHome });
    const target = '.codex/hooks.json';
    writeFileAt(join(repo, target), plannedContent(plan, target));

    const { applied, conflicts } = applyPlan(repo, plan);

    expect(conflicts.map((c) => c.target)).not.toContain(target);
    expect(applied.map((a) => a.target)).toContain(target);
    expect(existsSync(sidecarOf(target))).toBe(true);
    expect(readFileSync(join(repo, target), 'utf8')).toBe(plannedContent(plan, target));
  });

  it('HK-01, HK-11: rewrites its own pre-sidecar legacy bare event map into the documented shape (migration rule 2)', () => {
    stageRepo();
    const plan = project(repo, { dorkHome });
    const target = '.codex/hooks.json';
    // What every DorkOS before this change wrote: the bare event map, with no
    // `hooks` wrapper and no `description`.
    writeFileAt(
      join(repo, target),
      `${JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] }, null, 2)}\n`
    );

    const { applied, conflicts } = applyPlan(repo, plan);

    expect(conflicts.map((c) => c.target)).not.toContain(target);
    expect(applied.map((a) => a.target)).toContain(target);
    const rewritten = JSON.parse(readFileSync(join(repo, target), 'utf8'));
    expect(Object.keys(rewritten).sort()).toEqual(['description', 'hooks']);
    expect(existsSync(sidecarOf(target))).toBe(true);
  });

  it('HK-01, HK-11: does not adopt a bare map keyed by an event it could never have written', () => {
    // Rule 2's licence is "only DorkOS could have produced this". The old
    // generator dropped every event Codex has no home for, so `Notification` in
    // a bare map means a person wrote the file.
    stageRepo();
    const plan = project(repo, { dorkHome });
    const target = '.codex/hooks.json';
    const mine = `${JSON.stringify({ Notification: [{ hooks: [{ type: 'command', command: 'echo MINE' }] }] }, null, 2)}\n`;
    writeFileAt(join(repo, target), mine);

    const { applied, conflicts } = applyPlan(repo, plan);

    expect(readFileSync(join(repo, target), 'utf8')).toBe(mine);
    expect(applied.map((a) => a.target)).not.toContain(target);
    expect(conflicts.map((c) => c.target)).toContain(target);
  });

  it('HK-01, HK-11: never adopts a bare map at any path but the Codex one', () => {
    // Only `.codex/hooks.json` ever held the bare event map. Cursor's and
    // Copilot's generated files were always `{ version, hooks }`, so a bare map
    // at those paths cannot be the engine's old output — whoever wrote it, it
    // was not DorkOS.
    stageRepo();
    const plan = project(repo, { dorkHome });
    const mine = `${JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo MINE' }] }] }, null, 2)}\n`;
    writeFileAt(join(repo, '.cursor', 'hooks.json'), mine);

    const { applied, conflicts } = applyPlan(repo, plan);

    expect(readFileSync(join(repo, '.cursor', 'hooks.json'), 'utf8')).toBe(mine);
    expect(applied.map((a) => a.target)).not.toContain('.cursor/hooks.json');
    expect(conflicts.map((c) => c.target)).toContain('.cursor/hooks.json');
  });

  it('HK-11: does not re-adopt a file it wrote that somebody has since edited into a bare map', () => {
    // The other half of rule 2's narrowness: a sidecar EXISTS here, so DorkOS
    // demonstrably wrote this path once. Its bytes no longer match, which makes
    // the edit a person's, and the legacy shape is no longer evidence of
    // anything — rule 2 is only for files written before sidecars existed.
    stageRepo();
    const plan = project(repo, { dorkHome });
    applyPlan(repo, plan);
    const target = '.codex/hooks.json';
    expect(existsSync(sidecarOf(target))).toBe(true);

    const edited = `${JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo MINE' }] }] }, null, 2)}\n`;
    writeFileSync(join(repo, target), edited);

    const { applied, conflicts } = applyPlan(repo, plan);

    expect(readFileSync(join(repo, target), 'utf8')).toBe(edited);
    expect(applied.map((a) => a.target)).not.toContain(target);
    expect(conflicts.map((c) => c.target)).toContain(target);
  });

  it('HK-11: treats a hand-written Cursor file with no sidecar as a conflict (migration rule 3)', () => {
    stageRepo();
    const plan = project(repo, { dorkHome });
    const target = '.cursor/hooks.json';
    const mine = `${JSON.stringify({ version: 1, hooks: { stop: [{ type: 'command', command: 'echo MINE' }] } }, null, 2)}\n`;
    writeFileAt(join(repo, target), mine);

    const { applied, conflicts } = applyPlan(repo, plan);

    expect(readFileSync(join(repo, target), 'utf8')).toBe(mine);
    expect(applied.map((a) => a.target)).not.toContain(target);
    const conflict = conflicts.find((c) => c.target === target);
    expect(conflict?.reason).toContain('.claude/settings.json');
    expect(existsSync(sidecarOf(target))).toBe(false);
  });

  it('HK-11: treats a generated file somebody has since edited as theirs, not a rewrite target', () => {
    stageRepo();
    const plan = project(repo, { dorkHome });
    applyPlan(repo, plan);

    const target = '.codex/hooks.json';
    const edited = '{\n  "description": "I changed this",\n  "hooks": {}\n}\n';
    writeFileSync(join(repo, target), edited);

    const { conflicts } = applyPlan(repo, plan);
    expect(readFileSync(join(repo, target), 'utf8')).toBe(edited);
    expect(conflicts.map((c) => c.target)).toContain(target);
  });

  it('AP-01: does not rewrite an owned file whose content has not changed', () => {
    stageRepo();
    const plan = project(repo, { dorkHome });
    applyPlan(repo, plan);
    const target = join(repo, '.codex', 'hooks.json');

    // Stamp a known past mtime rather than reading the clock: any write at all
    // moves it to now, whatever the filesystem's timestamp granularity.
    const stamped = new Date('2020-01-02T03:04:05.000Z');
    utimesSync(target, stamped, stamped);

    applyPlan(repo, project(repo, { dorkHome }));

    // Re-syncing an unchanged hooks file must not touch it: the harnesses watch
    // these paths, and a rewrite that changes nothing is still a change event.
    expect(statSync(target).mtime.toISOString()).toBe(stamped.toISOString());
  });

  it('AP-07: sweeps an orphaned generated file together with its sidecar', () => {
    stageRepo();
    applyPlan(repo, project(repo, { dorkHome }));
    expect(existsSync(sidecarOf('.codex/hooks.json'))).toBe(true);

    // Remove the only hook source, then re-project: nothing generates the file.
    writeJsonAt(join(repo, '.claude', 'settings.json'), { hooks: {} });
    const swept = sweepGeneratedOrphans(repo, project(repo, { dorkHome }));

    expect(swept).toContain('.codex/hooks.json');
    expect(swept).toContain(`.codex/hooks.json${GENERATED_SIDECAR_SUFFIX}`);
    expect(existsSync(join(repo, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(sidecarOf('.codex/hooks.json'))).toBe(false);
  });

  it('AP-07: sweeps its own generated file once its harness leaves the manifest', () => {
    stageRepo();
    applyPlan(repo, project(repo, { dorkHome }));
    const cursorHooks = join(repo, '.cursor', 'hooks.json');
    expect(existsSync(cursorHooks)).toBe(true);

    // Cursor leaves the manifest. Turning a harness off means DorkOS stops
    // projecting into it — leaving a live hooks file behind would be the
    // opposite. The sidecar makes this unambiguous: the engine wrote these exact
    // bytes, so they are the engine's to take back.
    writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
      version: 1,
      harnesses: ['claude-code', 'codex'],
    });
    const swept = sweepGeneratedOrphans(repo, project(repo, { dorkHome }));

    expect(swept).toContain('.cursor/hooks.json');
    expect(swept).toContain(`.cursor/hooks.json${GENERATED_SIDECAR_SUFFIX}`);
    expect(existsSync(cursorHooks)).toBe(false);
  });

  it('HK-11, AP-07: leaves a hand-written file at a disabled harness alone, and never sweeps it', () => {
    // The other half of the rule above: ownership, not the manifest, is what
    // decides. A file the engine never wrote survives a harness leaving the
    // manifest exactly as it survives everything else.
    stageRepo();
    const mine = `${JSON.stringify({ version: 1, hooks: {} }, null, 2)}\n`;
    writeFileAt(join(repo, '.cursor', 'hooks.json'), mine);
    writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
      version: 1,
      harnesses: ['claude-code', 'codex'],
    });

    const { swept, leftAlone, conflicts } = applyPlan(repo, project(repo, { dorkHome }), {
      sweepOrphans: true,
    });

    expect(swept).toEqual([]);
    expect(leftAlone).toContain('.cursor/hooks.json');
    expect(conflicts.map((c) => c.target)).not.toContain('.cursor/hooks.json');
    expect(readFileSync(join(repo, '.cursor', 'hooks.json'), 'utf8')).toBe(mine);
  });

  it('HK-11: reports a hand-written file at a path it is not generating as left alone, not a conflict', () => {
    // Nothing was blocked: this plan writes no Copilot hooks at all, so a person
    // who has their own file there has nothing to fix and must not be handed a
    // standing non-zero exit for it.
    stageRepo();
    const mine = `${JSON.stringify({ version: 1, hooks: {} }, null, 2)}\n`;
    writeFileAt(join(repo, '.github', 'hooks', 'copilot-hooks.json'), mine);

    const { conflicts, leftAlone } = applyPlan(repo, project(repo, { dorkHome }));

    expect(leftAlone).toEqual(['.github/hooks/copilot-hooks.json']);
    expect(conflicts).toEqual([]);
    expect(readFileSync(join(repo, '.github', 'hooks', 'copilot-hooks.json'), 'utf8')).toBe(mine);
  });

  it('HK-11, VC-01: tells --check what is blocked and what it stepped over, without calling either drift', () => {
    stageRepo();
    const mineCursor = `${JSON.stringify({ version: 1, hooks: { stop: [] } }, null, 2)}\n`;
    writeFileAt(join(repo, '.cursor', 'hooks.json'), mineCursor);
    writeFileAt(
      join(repo, '.github', 'hooks', 'copilot-hooks.json'),
      `${JSON.stringify({ version: 1, hooks: {} }, null, 2)}\n`
    );
    const plan = project(repo, { dorkHome });
    applyPlan(repo, plan);

    const drift = checkPlan(repo, plan);

    // `.cursor/hooks.json` is planned but cannot be written: blocked, and the
    // reason a `--check` exits non-zero. Copilot's file blocks nothing.
    expect(drift.blocked.map((a) => a.target)).toEqual(['.cursor/hooks.json']);
    expect(drift.leftAlone).toEqual(['.github/hooks/copilot-hooks.json']);
    expect(drift.drifted.map((a) => a.target)).not.toContain('.cursor/hooks.json');
    expect(drift.clean).toBe(false);
  });

  it('AP-07: removes a sidecar whose file is gone', () => {
    stageRepo();
    applyPlan(repo, project(repo, { dorkHome }));
    rmSync(join(repo, '.codex', 'hooks.json'));

    writeJsonAt(join(repo, '.claude', 'settings.json'), { hooks: {} });
    const swept = sweepGeneratedOrphans(repo, project(repo, { dorkHome }));

    expect(swept).toContain(`.codex/hooks.json${GENERATED_SIDECAR_SUFFIX}`);
    expect(existsSync(sidecarOf('.codex/hooks.json'))).toBe(false);
  });
});
