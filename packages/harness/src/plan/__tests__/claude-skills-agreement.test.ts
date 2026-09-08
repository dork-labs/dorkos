/**
 * The `.claude/skills` placement, measured against the reader.
 *
 * `harnessCoverage()` walks a real tree the way each vendor's own documentation
 * says that harness walks it, and knows nothing about the projector. So it is the
 * oracle the plan has to agree with, and these are the two disagreements the
 * first facts-driven version shipped with:
 *
 * - a `native` for a directory whose NAME breaks the harness's own rule. The
 *   placement consulted `readPaths` and `symlinks` and stopped there, so a
 *   directory an agent dropped in `.claude/skills` under whatever name it liked
 *   was claimed as loading in OpenCode and Cursor while the walk refused to
 *   decide about it.
 * - a stale drop for the SAME directory when the manifest happens to list it.
 *   `claudeOnlySkills` is a statement of intent, not a fact about what OpenCode
 *   reads, and the walk discovers a listed skill exactly as it discovers an
 *   unlisted one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { harnessCoverage } from '../../vendor-facts/coverage.js';
import type { HarnessId } from '../../manifest/schema.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** Stage a repo with skills only in `.claude/skills`, and a manifest listing some of them. */
function stage(skills: { dir: string; name: string }[], claudeOnly: string[] = []): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-cskills-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-cskills-home-'));
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'opencode', 'cursor'],
    claudeOnlySkills: claudeOnly.map((name) => ({
      name,
      path: `.claude/skills/${name}`,
      reason: 'kept for Claude Code',
    })),
  });
  for (const skill of skills) {
    writeFileAt(
      join(repo, '.claude', 'skills', skill.dir, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: The ${skill.name} skill\n---\n\n# ${skill.dir}\n`
    );
  }
}

/** How the plan describes one source for one harness: the kinds, in one string. */
function planSays(plan: ReturnType<typeof project>, harness: HarnessId, source: string): string[] {
  return [
    ...plan.actions.filter((a) => a.harness === harness && a.source === source).map((a) => a.kind),
    ...plan.drops.filter((a) => a.harness === harness && a.source === source).map(() => 'drop'),
    ...plan.warnings
      .filter((w) => w.harness === harness && w.source === source)
      .map(() => 'warning'),
  ].sort();
}

/** How the walk describes one directory for one harness. */
function walkSays(
  repoRoot: string,
  harness: HarnessId,
  relDir: string
): 'discovered' | 'uncertain' | 'neither' {
  const coverage = harnessCoverage(harness, repoRoot);
  const abs = join(repoRoot, relDir);
  if (coverage.discovered.some((d) => d.dir === abs)) return 'discovered';
  if (coverage.uncertain.some((u) => u.path === abs)) return 'uncertain';
  return 'neither';
}

describe('a .claude/skills line agrees with what the harness would really do', () => {
  it('refuses to call a name-rule-breaking directory native, because the walk refuses too', () => {
    stage([{ dir: 'My_Skill', name: 'totally-different' }]);
    const plan = project(repo, { dorkHome });
    const source = '.claude/skills/My_Skill';

    // Claude Code keys by directory and documents no charset rule: it loads.
    expect([walkSays(repo, 'claude-code', source), planSays(plan, 'claude-code', source)]).toEqual([
      'discovered',
      ['native'],
    ]);

    // OpenCode keys by the frontmatter name and requires it to match the
    // directory; Cursor adds a charset rule the directory breaks. Neither vendor
    // documents what happens next, so neither the walk nor the plan may decide.
    for (const harness of ['opencode', 'cursor'] as const) {
      expect([harness, walkSays(repo, harness, source), planSays(plan, harness, source)]).toEqual([
        harness,
        'uncertain',
        ['warning'],
      ]);
    }
  });

  it('says the same thing about a listed skill as an identical unlisted one', () => {
    stage(
      [
        { dir: 'listed', name: 'listed' },
        { dir: 'unlisted', name: 'unlisted' },
      ],
      ['listed']
    );
    const plan = project(repo, { dorkHome });

    for (const harness of ['claude-code', 'opencode', 'cursor'] as const) {
      const listed = planSays(plan, harness, '.claude/skills/listed');
      const unlisted = planSays(plan, harness, '.claude/skills/unlisted');
      expect([harness, listed, unlisted]).toEqual([harness, unlisted, unlisted]);
      // And both agree with the walk, which discovers the pair alike.
      expect([harness, walkSays(repo, harness, '.claude/skills/listed')]).toEqual([
        harness,
        'discovered',
      ]);
      expect([harness, listed]).toEqual([harness, ['native']]);
    }
  });
});
