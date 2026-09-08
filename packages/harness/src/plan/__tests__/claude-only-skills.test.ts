/**
 * `manifest.claudeOnlySkills` — the exception list, measured against where the
 * skill actually lives (SK-04).
 *
 * The list names skills deliberately kept out of the canonical `.agents/skills`
 * layer. Before this, the drop only fired for a skill the scanner found IN
 * `.agents/skills`, so an entry that lives solely in `.claude/skills` — all 13 in
 * this repo — produced no line at all, and one present in BOTH made claude-code
 * plan a symlink over the real directory (a conflict, reproduced 2026-09-07).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../projector.js';
import { parseHarnessManifest, type HarnessId } from '../../manifest/schema.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Write a real skill directory (never a symlink) at `<repo>/<rel>/<name>`. */
function writeSkill(repo: string, rel: string, name: string): void {
  mkdirSync(join(repo, rel, name), { recursive: true });
  writeFileSync(join(repo, rel, name, 'SKILL.md'), `# ${name}\n`);
}

/** A repo with `only` in `.claude/skills` and `both` in both skill roots. */
function stage(opts: { inClaude: string[]; inAgents: string[] }): string {
  const repo = mkdtempSync(join(tmpdir(), 'harness-claudeonly-'));
  for (const name of opts.inClaude) writeSkill(repo, '.claude/skills', name);
  for (const name of opts.inAgents) writeSkill(repo, '.agents/skills', name);
  return repo;
}

const THREE: readonly HarnessId[] = ['claude-code', 'codex', 'opencode'];

/** The manifest shape under test: `harnesses` plus one `claudeOnlySkills` entry. */
function manifestFor(names: string[], harnesses: readonly HarnessId[] = THREE) {
  return parseHarnessManifest({
    version: 1,
    harnesses: [...harnesses],
    claudeOnlySkills: names.map((name) => ({
      name,
      path: `.claude/skills/${name}`,
      reason: 'kept Claude-only for the test',
    })),
  });
}

describe('claudeOnlySkills — the skill lives only in .claude/skills', () => {
  it('is native for claude-code and an honest drop for every other enabled harness', () => {
    dir = stage({ inClaude: ['secret'], inAgents: [] });
    const plan = buildPlan({
      repoRoot: dir,
      manifest: manifestFor(['secret']),
      agentsMdExists: false,
      claudeSkillDirs: ['secret'],
    });

    const native = plan.actions.filter((a) => a.artifact === 'skill' && a.name === 'secret');
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({
      kind: 'native',
      harness: 'claude-code',
      source: '.claude/skills/secret',
    });

    const drops = plan.drops.filter((d) => d.artifact === 'skill' && d.name === 'secret');
    expect(drops).toHaveLength(THREE.length - 1);
    expect(new Set(drops.map((d) => d.harness))).toEqual(new Set(['codex', 'opencode']));
    for (const drop of drops) {
      expect(drop.reason).toBe(
        'claude-only skill, kept in .claude/skills by manifest.claudeOnlySkills'
      );
    }
    // Nothing is written for it: the directory is already where Claude reads.
    expect(plan.actions.some((a) => a.target?.includes('secret'))).toBe(false);
    expect(plan.warnings.filter((w) => w.name === 'secret')).toEqual([]);
  });
});

describe('claudeOnlySkills — the skill lives in BOTH skill roots', () => {
  it('warns and plans no claude-code symlink, so the real directory is never a conflict', () => {
    dir = stage({ inClaude: ['dual'], inAgents: ['dual'] });
    const plan = buildPlan({
      repoRoot: dir,
      manifest: manifestFor(['dual']),
      agentsMdExists: false,
      claudeSkillDirs: ['dual'],
    });

    const warnings = plan.warnings.filter((w) => w.artifact === 'skill' && w.name === 'dual');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe(
      'claudeOnlySkills names a skill that also lives in .agents/skills — move it or drop the entry'
    );

    // The symlink the engine used to plan straight over the real directory.
    expect(
      plan.actions.filter((a) => a.artifact === 'skill' && a.target === '.claude/skills/dual')
    ).toEqual([]);
    // The other harnesses are still told the manifest keeps it out of their way.
    const drops = plan.drops.filter((d) => d.artifact === 'skill' && d.name === 'dual');
    expect(new Set(drops.map((d) => d.harness))).toEqual(new Set(['codex', 'opencode']));
  });
});

describe('claudeOnlySkills — the skill lives in NEITHER skill root', () => {
  it('warns that the entry is stale rather than silently listing a skill nobody has', () => {
    dir = stage({ inClaude: [], inAgents: [] });
    const plan = buildPlan({
      repoRoot: dir,
      manifest: manifestFor(['ghost']),
      agentsMdExists: false,
      claudeSkillDirs: [],
    });

    const warnings = plan.warnings.filter((w) => w.artifact === 'skill' && w.name === 'ghost');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/stale/);
    expect(plan.actions.filter((a) => a.name === 'ghost')).toEqual([]);
    expect(plan.drops.filter((a) => a.name === 'ghost')).toEqual([]);
  });
});

describe('claudeOnlySkills — this repo’s own manifest', () => {
  /** This repository's live `.agents/harness.manifest.json`, parsed. */
  function repoManifest() {
    const path = fileURLToPath(
      new URL('../../../../../.agents/harness.manifest.json', import.meta.url)
    );
    return parseHarnessManifest(JSON.parse(readFileSync(path, 'utf8')));
  }

  it('drops all 13 Claude-only skills once per non-claude harness, and warns about none', () => {
    // The shape the review reproduced: every entry is a real directory in
    // `.claude/skills` and none of them is in `.agents/skills`, so the honest
    // answer is one drop per entry per other harness — 13 × 2 here — and not a
    // single warning, because nothing about the manifest is stale.
    const manifest = repoManifest();
    expect(manifest.claudeOnlySkills.length).toBe(13);
    expect(manifest.harnesses.length).toBeGreaterThan(1);

    dir = stage({ inClaude: manifest.claudeOnlySkills.map((c) => c.name), inAgents: [] });
    const plan = buildPlan({
      repoRoot: dir,
      manifest,
      agentsMdExists: false,
      claudeSkillDirs: manifest.claudeOnlySkills.map((c) => c.name),
    });

    const drops = plan.drops.filter(
      (d) =>
        d.artifact === 'skill' &&
        d.reason === 'claude-only skill, kept in .claude/skills by manifest.claudeOnlySkills'
    );
    expect(drops).toHaveLength(manifest.claudeOnlySkills.length * (manifest.harnesses.length - 1));
    expect(plan.warnings.filter((w) => w.artifact === 'skill')).toEqual([]);
    expect(
      plan.actions.filter((a) => a.artifact === 'skill' && a.harness === 'claude-code')
    ).toHaveLength(manifest.claudeOnlySkills.length);
  });

  it('every entry’s `path` points at the `.claude/skills` directory it names', () => {
    // The manifest's `path` is the only place the entry says WHERE the skill is
    // kept; a stale one sends whoever reads it to a directory that is not there.
    const manifest = repoManifest();
    expect(manifest.claudeOnlySkills.length).toBe(13);
    for (const entry of manifest.claudeOnlySkills) {
      expect({ name: entry.name, path: entry.path }).toEqual({
        name: entry.name,
        path: `.claude/skills/${entry.name}`,
      });
    }
  });
});
