/**
 * `manifest.claudeOnlySkills` — the exception list, measured against where the
 * skill actually is (SK-04).
 *
 * The list names skills deliberately kept out of the canonical `.agents/skills`
 * layer, so the scanner never sees them and the manifest entry is the only
 * evidence they exist. Before this, the drop only fired for a skill the scanner
 * found IN `.agents/skills` — so an entry living solely in `.claude/skills` (all
 * 13 in this repo) produced no line at all, and one present in BOTH made
 * claude-code plan a symlink over the real directory (a conflict, reproduced
 * 2026-09-07).
 *
 * Every case here resolves the entry through the REAL loader
 * (`scanClaudeOnlySkills`) against a real staged tree, rather than hand-feeding
 * the projector a map: the entry's `path` is the claim under test, and a test
 * that supplies the answer cannot fail on the loader misreading it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../projector.js';
import { scanClaudeOnlySkills } from '../../engine.js';
import {
  parseHarnessManifest,
  type HarnessManifest,
  type HarnessId,
} from '../../manifest/schema.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Write a real skill directory (never a symlink) at `<repo>/<rel>`. */
function writeSkill(repo: string, rel: string): void {
  mkdirSync(join(repo, rel), { recursive: true });
  writeFileSync(join(repo, rel, 'SKILL.md'), `---\nname: ${rel.split('/').pop()}\n---\n`);
}

const THREE: readonly HarnessId[] = ['claude-code', 'codex', 'opencode'];

/** A manifest with one `claudeOnlySkills` entry per `{ name, path }` pair given. */
function manifestFor(
  entries: { name: string; path?: string }[],
  harnesses: readonly HarnessId[] = THREE
): HarnessManifest {
  return parseHarnessManifest({
    version: 1,
    harnesses: [...harnesses],
    claudeOnlySkills: entries.map(({ name, path }) => ({
      name,
      path: path ?? `.claude/skills/${name}`,
      reason: 'kept Claude-only for the test',
    })),
  });
}

/** Plan `manifest` over a fresh temp repo, resolving its entries off real disk. */
function planIn(manifest: HarnessManifest, stage: (repo: string) => void) {
  dir = mkdtempSync(join(tmpdir(), 'harness-claudeonly-'));
  stage(dir);
  return buildPlan({
    repoRoot: dir,
    manifest,
    agentsMdExists: false,
    claudeOnlySkills: scanClaudeOnlySkills(dir, manifest),
  });
}

describe('claudeOnlySkills — a real directory where Claude Code reads', () => {
  it('is native for claude-code and an honest drop for every other enabled harness', () => {
    const plan = planIn(manifestFor([{ name: 'secret' }]), (repo) =>
      writeSkill(repo, '.claude/skills/secret')
    );

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
    const plan = planIn(manifestFor([{ name: 'dual' }]), (repo) => {
      writeSkill(repo, '.claude/skills/dual');
      writeSkill(repo, '.agents/skills/dual');
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

describe('claudeOnlySkills — the entry points somewhere else entirely', () => {
  it('says the skill is real and unread, rather than calling a present skill stale', () => {
    // Reproduced in review: `path: docs/skills/oddball` with a real skill there
    // was reported as a stale entry — a wrong statement about a skill that is
    // right where the manifest says. It is also NOT a `native`: Claude Code
    // loads skills from `.claude/skills`, so nothing reads it there.
    const plan = planIn(manifestFor([{ name: 'oddball', path: 'docs/skills/oddball' }]), (repo) =>
      writeSkill(repo, 'docs/skills/oddball')
    );

    const warnings = plan.warnings.filter((w) => w.name === 'oddball');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain('docs/skills/oddball');
    expect(warnings[0].reason).toContain('which no harness reads');
    expect(warnings[0].reason).not.toMatch(/stale/);

    expect(plan.actions.filter((a) => a.name === 'oddball')).toEqual([]);
    expect(plan.drops.filter((a) => a.name === 'oddball')).toEqual([]);
  });
});

describe('claudeOnlySkills — the skill is canonical, so the entry is redundant', () => {
  /** Stage the skill in `.agents/skills` only — a fresh clone, before any apply. */
  function freshClone(repo: string): void {
    writeSkill(repo, '.agents/skills/linked');
  }

  /** The same tree one apply later: the projection symlink now exists. */
  function afterApply(repo: string): void {
    freshClone(repo);
    mkdirSync(join(repo, '.claude', 'skills'), { recursive: true });
    symlinkSync(
      join('..', '..', '.agents', 'skills', 'linked'),
      join(repo, '.claude/skills/linked')
    );
  }

  it('warns on the FIRST pass, before anything has been projected', () => {
    // The gap this closes: the warning used to need a real directory at the
    // projection target, so on a fresh clone the entry was silent and only spoke
    // up after the first sync — at which point the message it gave described
    // DorkOS's own symlink rather than the manifest's mistake.
    const plan = planIn(manifestFor([{ name: 'linked' }]), freshClone);

    const warnings = plan.warnings.filter((w) => w.name === 'linked');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe(
      'claudeOnlySkills names a skill that also lives in .agents/skills; nothing is at .claude/skills/linked. The entry is redundant — drop it'
    );

    // Redundant is not a conflict: the projection is planned as usual.
    expect(
      plan.actions.some((a) => a.artifact === 'skill' && a.target === '.claude/skills/linked')
    ).toBe(true);
  });

  it('still warns on the second pass, naming the link as the projection it is', () => {
    const plan = planIn(manifestFor([{ name: 'linked' }]), afterApply);

    const warnings = plan.warnings.filter((w) => w.name === 'linked');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain('also lives in .agents/skills');
    expect(warnings[0].reason).toContain('is a symlink, which is the projection DorkOS makes');
    expect(warnings[0].reason).toContain('drop it');

    // The projection itself is STILL planned. Withholding it would leave the
    // link unowned by the plan, and the orphan sweep would prune a working one.
    expect(
      plan.actions.some((a) => a.artifact === 'skill' && a.target === '.claude/skills/linked')
    ).toBe(true);
  });

  it('says the same thing on both passes, so the message is about the manifest', () => {
    // Not a restatement of the two cases above: it pins that the FACT does not
    // change with the state of the tree, which is the whole defect.
    const first = planIn(manifestFor([{ name: 'linked' }]), freshClone).warnings.filter(
      (w) => w.name === 'linked'
    );
    const second = planIn(manifestFor([{ name: 'linked' }]), afterApply).warnings.filter(
      (w) => w.name === 'linked'
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    for (const [pass, warning] of [first[0], second[0]].entries()) {
      expect({
        pass,
        redundant: warning.reason.includes('The entry is redundant — drop it'),
      }).toEqual({ pass, redundant: true });
    }
  });
});

describe('claudeOnlySkills — the entry’s path is a symlink to something else', () => {
  it('warns that a link is not a skill kept in .claude/skills, whatever it points at', () => {
    // No canonical skill of this name, so this is the entry's own claim under
    // test rather than a redundancy: `.claude/skills/vaulted` is a link into a
    // directory kept outside the skills roots entirely.
    const plan = planIn(manifestFor([{ name: 'vaulted' }]), (repo) => {
      writeSkill(repo, 'vault/vaulted');
      mkdirSync(join(repo, '.claude', 'skills'), { recursive: true });
      symlinkSync(join('..', '..', 'vault', 'vaulted'), join(repo, '.claude/skills/vaulted'));
    });

    const warnings = plan.warnings.filter((w) => w.name === 'vaulted');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toContain('is a symlink');
    expect(warnings[0].reason).toContain('drop the entry');
    expect(warnings[0].reason).not.toContain('redundant');
    // Nothing is claimed for it either way.
    expect(plan.actions.filter((a) => a.name === 'vaulted')).toEqual([]);
    expect(plan.drops.filter((a) => a.name === 'vaulted')).toEqual([]);
  });
});

describe('claudeOnlySkills — nothing is there at all', () => {
  it('warns that the entry is stale rather than silently listing a skill nobody has', () => {
    const plan = planIn(manifestFor([{ name: 'ghost' }]), () => {});

    const warnings = plan.warnings.filter((w) => w.artifact === 'skill' && w.name === 'ghost');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/stale/);
    expect(warnings[0].reason).toContain('.claude/skills/ghost');
    expect(plan.actions.filter((a) => a.name === 'ghost')).toEqual([]);
    expect(plan.drops.filter((a) => a.name === 'ghost')).toEqual([]);
  });

  it('treats a directory with no SKILL.md as nothing, because no harness would load it', () => {
    const plan = planIn(manifestFor([{ name: 'empty' }]), (repo) =>
      mkdirSync(join(repo, '.claude', 'skills', 'empty'), { recursive: true })
    );
    expect(plan.warnings.filter((w) => w.name === 'empty')[0]?.reason).toMatch(/stale/);
  });
});

describe('claudeOnlySkills — this repo’s own manifest', () => {
  /** This repository's live `.agents/harness.manifest.json`, parsed. */
  function repoManifest(): HarnessManifest {
    const path = fileURLToPath(
      new URL('../../../../../.agents/harness.manifest.json', import.meta.url)
    );
    return parseHarnessManifest(JSON.parse(readFileSync(path, 'utf8')));
  }

  it('drops all 13 Claude-only skills once per non-claude harness, and warns about none', () => {
    // The shape the review reproduced: every entry is a real directory in
    // `.claude/skills` and none of them is in `.agents/skills`, so the honest
    // answer is one drop per entry per other harness — 13 x 2 here — and not a
    // single warning, because nothing about the manifest is stale.
    const manifest = repoManifest();
    expect(manifest.claudeOnlySkills.length).toBe(13);
    expect(manifest.harnesses.length).toBeGreaterThan(1);

    const plan = planIn(manifest, (repo) => {
      for (const entry of manifest.claudeOnlySkills) writeSkill(repo, entry.path);
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
    // The manifest's `path` is now what the engine resolves, so a wrong one is
    // no longer cosmetic: it decides whether the skill is found at all.
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
