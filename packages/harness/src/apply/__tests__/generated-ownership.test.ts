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
 * sidecars existed, plus the sweep's two guards (ownership, and the manifest's
 * enabled harnesses).
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
import { applyPlan, sweepGeneratedOrphans } from '../apply.js';
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
  it('writes a sidecar holding the sha256 of exactly the bytes it wrote', () => {
    stageRepo();
    const plan = project(repo, { dorkHome });
    applyPlan(repo, plan);

    const written = readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8');
    expect(readFileSync(sidecarOf('.codex/hooks.json'), 'utf8')).toBe(
      `${createHash('sha256').update(written).digest('hex')}\n`
    );
  });

  it('adopts a pre-sidecar file whose bytes it would have written anyway (migration rule 1)', () => {
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

  it('rewrites its own pre-sidecar legacy bare event map into the documented shape (migration rule 2)', () => {
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

  it('treats a hand-written Cursor file with no sidecar as a conflict (migration rule 3)', () => {
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

  it('treats a generated file somebody has since edited as theirs, not a rewrite target', () => {
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

  it('does not rewrite an owned file whose content has not changed', () => {
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

  it('sweeps an orphaned generated file together with its sidecar', () => {
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

  it('never sweeps a generated target for a harness the manifest does not enable', () => {
    stageRepo();
    applyPlan(repo, project(repo, { dorkHome }));
    const cursorHooks = join(repo, '.cursor', 'hooks.json');
    expect(existsSync(cursorHooks)).toBe(true);

    // Cursor leaves the manifest. Its generated file is no longer the engine's
    // business, so the sweep steps over it instead of pruning another harness's
    // config out from under it.
    writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
      version: 1,
      harnesses: ['claude-code', 'codex'],
    });
    const swept = sweepGeneratedOrphans(repo, project(repo, { dorkHome }));

    expect(swept).not.toContain('.cursor/hooks.json');
    expect(existsSync(cursorHooks)).toBe(true);
  });

  it('removes a sidecar whose file is gone', () => {
    stageRepo();
    applyPlan(repo, project(repo, { dorkHome }));
    rmSync(join(repo, '.codex', 'hooks.json'));

    writeJsonAt(join(repo, '.claude', 'settings.json'), { hooks: {} });
    const swept = sweepGeneratedOrphans(repo, project(repo, { dorkHome }));

    expect(swept).toContain(`.codex/hooks.json${GENERATED_SIDECAR_SUFFIX}`);
    expect(existsSync(sidecarOf('.codex/hooks.json'))).toBe(false);
  });
});
