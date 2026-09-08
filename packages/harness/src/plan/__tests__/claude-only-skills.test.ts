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
  it('is native for every harness that reads .claude/skills, listed or not', () => {
    // The manifest entry says what a person INTENDED, and the vendor facts say
    // what each harness does. OpenCode's own docs list `.claude/skills` among its
    // read paths, so it loads this skill whatever the manifest calls it — and the
    // engine dropped it for OpenCode until DOR-1845's review, which is SK-05's
    // stale-drop shape on the path that runs on this repository. Codex does not
    // read that directory, so for Codex the drop is the true answer.
    const plan = planIn(manifestFor([{ name: 'secret' }]), (repo) =>
      writeSkill(repo, '.claude/skills/secret')
    );

    const natives = plan.actions.filter((a) => a.artifact === 'skill' && a.name === 'secret');
    expect(new Set(natives.map((a) => a.harness))).toEqual(new Set(['claude-code', 'opencode']));
    for (const native of natives) {
      expect(native).toMatchObject({ kind: 'native', source: '.claude/skills/secret' });
    }
    // The listed half changes the wording and nothing else.
    expect(natives.find((a) => a.harness === 'opencode')?.reason).toContain(
      'listed in manifest.claudeOnlySkills, but OpenCode reads .claude/skills directly'
    );

    const drops = plan.drops.filter((d) => d.artifact === 'skill' && d.name === 'secret');
    expect(drops.map((d) => d.harness)).toEqual(['codex']);
    expect(drops[0].reason).toContain('Codex does not read .claude/skills');

    // Nothing is written for it: the directory is already where Claude reads.
    expect(plan.actions.some((a) => a.target?.includes('secret'))).toBe(false);
    expect(plan.warnings.filter((w) => w.name === 'secret')).toEqual([]);
  });

  it('says the same thing about an unlisted directory as a listed one', () => {
    // Two identical directories, one named by the manifest and one not. Before
    // the two code paths were unified they got opposite answers for OpenCode.
    const plan = planIn(manifestFor([{ name: 'listed' }]), (repo) => {
      writeSkill(repo, '.claude/skills/listed');
      writeSkill(repo, '.claude/skills/unlisted');
    });

    for (const harness of THREE) {
      const kinds = (name: string): string[] =>
        [...plan.actions, ...plan.drops]
          .filter((a) => a.artifact === 'skill' && a.name === name && a.harness === harness)
          .map((a) => a.kind);
      expect([harness, kinds('listed')]).toEqual([harness, kinds('unlisted')]);
      expect([harness, kinds('listed').length]).toEqual([harness, 1]);
    }
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

    const entryWarning = plan.warnings.filter(
      (w) => w.name === 'vaulted' && w.reason.includes('drop the entry')
    );
    expect(entryWarning).toHaveLength(1);
    expect(entryWarning[0].reason).toContain('is a symlink');
    expect(entryWarning[0].reason).not.toContain('redundant');

    // The link is also a real skill a person put where Claude Code reads, so it
    // gets the same per-harness account any other `.claude/skills` skill gets.
    // Claude Code documents following symlinks, so it loads; Codex does not read
    // the directory at all; OpenCode reads it and documents nothing about links,
    // so the plan refuses to decide exactly as `harnessCoverage` does.
    expect(
      plan.actions.filter((a) => a.name === 'vaulted').map((a) => [a.harness, a.kind])
    ).toEqual([['claude-code', 'native']]);
    expect(plan.drops.filter((a) => a.name === 'vaulted').map((a) => a.harness)).toEqual(['codex']);
    const undecided = plan.warnings.filter((w) => w.name === 'vaulted' && w.harness === 'opencode');
    expect(undecided).toHaveLength(1);
    expect(undecided[0].reason).toContain('does not document whether it follows one');
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

  it('accounts for all 13 Claude-only skills per harness, by what that harness reads', () => {
    // Every entry is a real directory in `.claude/skills` and none is in
    // `.agents/skills`, so each gets exactly one line per enabled harness — and
    // WHICH line is the vendor's answer, not the manifest's. Claude Code and
    // OpenCode both read that directory (their own docs), so both load all 13;
    // Codex does not, so all 13 are honest drops there. Not a single warning:
    // nothing about the manifest is stale, and no name breaks a rule.
    const manifest = repoManifest();
    expect(manifest.claudeOnlySkills.length).toBe(13);
    expect(manifest.harnesses.length).toBeGreaterThan(1);

    const plan = planIn(manifest, (repo) => {
      for (const entry of manifest.claudeOnlySkills) writeSkill(repo, entry.path);
    });

    const listedNames = new Set(manifest.claudeOnlySkills.map((entry) => entry.name));
    const linesFor = (harness: HarnessId, from: 'actions' | 'drops'): number =>
      plan[from].filter(
        (a) => a.artifact === 'skill' && listedNames.has(a.name) && a.harness === harness
      ).length;

    for (const harness of manifest.harnesses) {
      const reads = harness === 'claude-code' || harness === 'opencode';
      expect({
        harness,
        natives: linesFor(harness, 'actions'),
        drops: linesFor(harness, 'drops'),
      }).toEqual({
        harness,
        natives: reads ? 13 : 0,
        drops: reads ? 0 : 13,
      });
    }
    expect(plan.warnings.filter((w) => w.artifact === 'skill')).toEqual([]);
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
