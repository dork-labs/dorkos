import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
  realpathSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../engine.js';
import { applyPlan, checkPlan } from '../apply/apply.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Build a realistic temp repo: one skill, a Stop hook, AGENTS.md, and a manifest. */
function buildFixtureRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'harness-int-'));
  mkdirSync(join(d, '.agents', 'skills', 'demo'), { recursive: true });
  writeFileSync(join(d, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo skill\n');
  writeFileSync(
    join(d, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
  );
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(
    join(d, '.claude', 'settings.json'),
    JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } },
      null,
      2
    )
  );
  writeFileSync(join(d, 'AGENTS.md'), '# Project\n');
  return d;
}

describe('harness engine integration', () => {
  it('projects, applies, stays idempotent, detects drift, and never destroys hand-authored content', () => {
    // Full project() -> applyPlan() -> checkPlan() lifecycle against a real temp repo.
    dir = buildFixtureRepo();
    const plan = project(dir);

    const first = applyPlan(dir, plan);
    expect(first.conflicts).toEqual([]);

    // 1. the skill symlink on disk resolves to the canonical source
    const link = join(dir, '.claude', 'skills', 'demo');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(dir, '.agents', 'skills', 'demo')));

    // 2. the generated codex hooks file is valid JSON with a Stop key
    const hooksPath = join(dir, '.codex', 'hooks.json');
    expect(existsSync(hooksPath)).toBe(true);
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(hooks).toHaveProperty('Stop');

    // 3. the scaffolded CLAUDE.md points at AGENTS.md
    expect(readFileSync(join(dir, '.claude', 'CLAUDE.md'), 'utf8')).toContain('@../AGENTS.md');

    // 4. idempotency: a fresh check after apply sees no drift
    expect(checkPlan(dir, plan).clean).toBe(true);

    // 5. deleting the skill symlink registers as drift
    rmSync(link);
    const drift = checkPlan(dir, plan);
    expect(drift.clean).toBe(false);
    expect(drift.drifted.some((a) => a.artifact === 'skill' && a.name === 'demo')).toBe(true);

    // 6. re-apply restores the deleted symlink AND leaves a hand-edited CLAUDE.md untouched —
    //    a customized scaffold is user-owned, never a conflict, and --check agrees it is clean
    //    (so --check and --fix never disagree on a diverged scaffold; review finding #2).
    writeFileSync(join(dir, '.claude', 'CLAUDE.md'), '# hand edited\n');
    const second = applyPlan(dir, plan);
    expect(second.conflicts).toEqual([]);
    expect(readFileSync(join(dir, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# hand edited\n');
    expect(checkPlan(dir, plan).clean).toBe(true);

    // 7. regression: a real (non-symlink) directory occupying a skill target is reported as a
    //    conflict and is NEVER destroyed (the rm -rf data-loss bug; review finding #1).
    rmSync(link, { force: true });
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'precious.md'), '# do not delete\n');
    const third = applyPlan(dir, plan);
    expect(
      third.conflicts.some((a) => a.artifact === 'skill' && a.target === '.claude/skills/demo')
    ).toBe(true);
    expect(lstatSync(link).isDirectory()).toBe(true);
    expect(readFileSync(join(link, 'precious.md'), 'utf8')).toBe('# do not delete\n');
  });
});
