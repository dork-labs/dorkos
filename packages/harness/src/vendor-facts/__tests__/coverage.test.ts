import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_IDS, type HarnessId } from '../../manifest/schema.js';
import { skillsFactsFor } from '../index.js';
import { harnessCoverage } from '../coverage.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh real temp tree. Realpathed so macOS's `/var` -> `/private/var` link never confuses a comparison. */
function makeRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-coverage-')));
  roots.push(dir);
  return dir;
}

/**
 * Stage one skill directory.
 *
 * @param root - tree root.
 * @param relDir - repo-relative directory, e.g. `.claude/skills/a`.
 * @param name - frontmatter `name`; omitted writes a SKILL.md with no frontmatter at all.
 * @returns the absolute directory.
 */
function skill(root: string, relDir: string, name?: string): string {
  const dir = join(root, relDir);
  mkdirSync(dir, { recursive: true });
  const body =
    name === undefined
      ? '# a staged skill\n'
      : `---\nname: ${name}\ndescription: a staged skill\n---\n\n# a staged skill\n`;
  writeFileSync(join(dir, 'SKILL.md'), body);
  return dir;
}

/**
 * Stage the three things that look like a skill and are not: a directory with no
 * `SKILL.md`, a loose file, and a symlink to nowhere.
 *
 * @param root - tree root.
 * @param readPath - the repo-relative read path to pollute.
 */
function stageNegativeControls(root: string, readPath: string): void {
  const dir = join(root, readPath);
  mkdirSync(join(dir, 'has-no-skill-md'), { recursive: true });
  writeFileSync(join(dir, 'loose-file.md'), '# not a skill directory\n');
  symlinkSync(join(root, 'nowhere', 'deleted-target'), join(dir, 'dangling'), 'dir');
}

describe('harnessCoverage() — Claude Code', () => {
  it('finds .claude/skills and follows a symlink out of it, reads nothing from .agents/skills, and does not model the lazy nested tier (SK-15, out of scope for a static walk)', () => {
    const root = makeRoot();
    skill(root, '.claude/skills/a');
    skill(root, '.agents/skills/b');
    symlinkSync(join(root, '.agents/skills/b'), join(root, '.claude/skills/b'), 'dir');
    skill(root, '.agents/skills/c');
    skill(root, 'pkg/.claude/skills/d');
    stageNegativeControls(root, '.claude/skills');

    const { discovered, uncertain } = harnessCoverage('claude-code', root);

    expect(discovered.map((d) => d.key)).toEqual(['a', 'b']);
    expect(discovered.map((d) => d.via)).toEqual(['.claude/skills', '.claude/skills']);
    expect(discovered[1].dir).toBe(join(root, '.claude/skills/b'));
    expect(discovered[1].skillMd).toBe(join(root, '.claude/skills/b/SKILL.md'));
    expect(uncertain).toEqual([]);
  });

  it('loads one entry for a target reachable through two links (by-realpath)', () => {
    const root = makeRoot();
    const target = skill(root, '.agents/skills/shared');
    mkdirSync(join(root, '.claude/skills'), { recursive: true });
    symlinkSync(target, join(root, '.claude/skills/x'), 'dir');
    symlinkSync(target, join(root, '.claude/skills/y'), 'dir');

    const { discovered, uncertain } = harnessCoverage('claude-code', root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0].key).toBe('x');
    expect(uncertain).toEqual([]);
  });
});

describe('harnessCoverage() — Codex', () => {
  it('reads .agents/skills under the frontmatter name and never reads .claude/skills', () => {
    const root = makeRoot();
    skill(root, '.agents/skills/c', 'canonical-name');
    skill(root, '.claude/skills/a', 'a');

    const { discovered, uncertain } = harnessCoverage('codex', root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0].key).toBe('canonical-name');
    expect(discovered[0].dir).toBe(join(root, '.agents/skills/c'));
    expect(uncertain).toEqual([]);
  });

  it('ascends from the start directory to the repo root, nearest level first', () => {
    const root = makeRoot();
    skill(root, '.agents/skills/c', 'c');
    skill(root, 'apps/web/.agents/skills/e', 'e');

    const { discovered, uncertain } = harnessCoverage('codex', root, {
      cwd: join(root, 'apps/web'),
    });

    expect(discovered.map((d) => d.key)).toEqual(['e', 'c']);
    expect(discovered.map((d) => d.via)).toEqual(['apps/web/.agents/skills', '.agents/skills']);
    expect(uncertain).toEqual([]);

    // And without a cwd the ascent has one level, so only the root skill is found.
    expect(harnessCoverage('codex', root).discovered.map((d) => d.key)).toEqual(['c']);
  });

  it('clamps a start directory outside the tree back to the root instead of climbing somewhere else', () => {
    const root = makeRoot();
    const elsewhere = makeRoot();
    skill(root, '.agents/skills/at-root', 'at-root');
    skill(elsewhere, '.agents/skills/not-ours', 'not-ours');

    const { discovered, uncertain } = harnessCoverage('codex', root, { cwd: elsewhere });

    expect(discovered.map((d) => d.key)).toEqual(['at-root']);
    expect(uncertain).toEqual([]);
  });

  it('keeps both of two skills sharing a frontmatter name — Codex documents that duplicates are not merged', () => {
    const root = makeRoot();
    skill(root, '.agents/skills/one', 'same');
    skill(root, '.agents/skills/two', 'same');

    const { discovered, uncertain } = harnessCoverage('codex', root);

    expect(discovered).toHaveLength(2);
    expect(discovered.map((d) => d.key)).toEqual(['same', 'same']);
    expect(discovered.map((d) => d.dir)).toEqual([
      join(root, '.agents/skills/one'),
      join(root, '.agents/skills/two'),
    ]);
    // `dedupe: 'none'` is a documented outcome, not a gap: nothing is uncertain.
    expect(uncertain).toEqual([]);
  });

  it("loads the engine's <pkg>__<name> projection under its frontmatter name — Codex states no charset or directory-match rule for that shape to break", () => {
    const root = makeRoot();
    skill(root, '.agents/skills/pkg__x', 'x');

    const { discovered, uncertain } = harnessCoverage('codex', root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0].key).toBe('x');
    expect(discovered[0].dir).toBe(join(root, '.agents/skills/pkg__x'));
    expect(uncertain).toEqual([]);
  });

  it('will not name a skill whose SKILL.md has no frontmatter name, because the frontmatter name IS the key here', () => {
    const root = makeRoot();
    skill(root, '.agents/skills/nameless');

    const { discovered, uncertain } = harnessCoverage('codex', root);

    expect(discovered).toEqual([]);
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0].path).toBe(join(root, '.agents/skills/nameless'));
    expect(uncertain[0].reason).toContain('frontmatter name absent');
  });
});

describe('harnessCoverage() — OpenCode', () => {
  it('reads all three project directories, in the order the docs list them', () => {
    const root = makeRoot();
    skill(root, '.opencode/skills/o-one', 'o-one');
    skill(root, '.claude/skills/o-two', 'o-two');
    skill(root, '.agents/skills/o-three', 'o-three');

    const { discovered, uncertain } = harnessCoverage('opencode', root);

    expect(discovered.map((d) => d.key)).toEqual(['o-one', 'o-two', 'o-three']);
    expect(discovered.map((d) => d.via)).toEqual([
      '.opencode/skills',
      '.claude/skills',
      '.agents/skills',
    ]);
    expect(uncertain).toEqual([]);
  });

  it('cannot say what a <pkg>__<name> directory does: the name must match the directory, and the docs never say what happens when it does not (SK-09)', () => {
    const root = makeRoot();
    skill(root, '.agents/skills/pkg__x', 'x');

    const { discovered, uncertain } = harnessCoverage('opencode', root);

    expect(discovered).toEqual([]);
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0].path).toBe(join(root, '.agents/skills/pkg__x'));
    expect(uncertain[0].reason).toContain('does not match the directory');
    expect(uncertain[0].reason).toContain('does not document what it does');
  });

  it('cannot say what the other half of the <pkg>__<name> shape does either: a name that DOES match the directory breaks the charset rule instead', () => {
    // The contract's "violated twice over": the shape cannot satisfy the
    // directory-match rule and the charset rule at the same time.
    const root = makeRoot();
    skill(root, '.agents/skills/pkg__x', 'pkg__x');

    const { discovered, uncertain } = harnessCoverage('opencode', root);

    expect(discovered).toEqual([]);
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0].reason).toContain('charset rule');
  });

  it('reports the SECOND copy of one skill reachable through two read paths, and keeps the first — SK-12 leaves "once or twice" open here too', () => {
    // The 2026-07 source check suggests OpenCode keys on the frontmatter name
    // and would collapse the pair. That is a hypothesis in the row's notes, not
    // a documented outcome, so the walk does not act on it.
    const root = makeRoot();
    skill(root, '.claude/skills/dup', 'dup');
    skill(root, '.agents/skills/dup', 'dup');

    const { discovered, uncertain } = harnessCoverage('opencode', root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0].via).toBe('.claude/skills');
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0].path).toBe(join(root, '.agents/skills/dup'));
    expect(uncertain[0].reason).toContain('loads once or twice');
    expect(uncertain[0].reason).toContain('.claude/skills/dup and .agents/skills/dup');
  });

  it('stops ascending at the nearest git worktree instead of climbing to the tree root', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'pkg/src'), { recursive: true });
    // A `.git` FILE, so a linked worktree stops the climb exactly like a checkout.
    writeFileSync(join(root, 'pkg/.git'), 'gitdir: /elsewhere/.git/worktrees/pkg\n');
    skill(root, 'pkg/.agents/skills/inner', 'inner');
    skill(root, '.agents/skills/outer', 'outer');

    const { discovered, uncertain } = harnessCoverage('opencode', root, {
      cwd: join(root, 'pkg/src'),
    });

    expect(discovered.map((d) => d.key)).toEqual(['inner']);
    expect(discovered[0].via).toBe('pkg/.agents/skills');
    expect(uncertain).toEqual([]);

    // Without the worktree marker the same tree climbs all the way to the root.
    rmSync(join(root, 'pkg/.git'));
    expect(
      harnessCoverage('opencode', root, { cwd: join(root, 'pkg/src') }).discovered.map((d) => d.key)
    ).toEqual(['inner', 'outer']);
  });
});

describe('harnessCoverage() — Cursor', () => {
  it('descends into nested project directories and reads .codex/skills as a compat path, never entering node_modules', () => {
    const root = makeRoot();
    skill(root, 'packages/api/.cursor/skills/f', 'f');
    skill(root, '.codex/skills/g', 'g');
    skill(root, 'node_modules/some-dep/.cursor/skills/z', 'z');

    const { discovered, uncertain } = harnessCoverage('cursor', root);

    expect(discovered.map((d) => d.key)).toEqual(['g', 'f']);
    expect(discovered.map((d) => d.via)).toEqual(['.codex/skills', 'packages/api/.cursor/skills']);
    expect(uncertain).toEqual([]);
  });

  it('descends six levels below the root and no further — the bound is ours, not a documented Cursor limit', () => {
    const root = makeRoot();
    skill(root, 'a/b/c/d/e/f/.cursor/skills/deep-enough', 'deep-enough');
    skill(root, 'a/b/c/d/e/f/g/.cursor/skills/too-deep', 'too-deep');

    const { discovered } = harnessCoverage('cursor', root);

    expect(discovered.map((d) => d.key)).toEqual(['deep-enough']);
  });

  it('cannot say what a <pkg>__<name> folder does: the folder is the identity, it breaks the charset rule, and the docs never say what happens', () => {
    const root = makeRoot();
    skill(root, '.cursor/skills/pkg__x', 'x');

    const { discovered, uncertain } = harnessCoverage('cursor', root);

    expect(discovered).toEqual([]);
    expect(uncertain).toHaveLength(2);
    expect(uncertain.map((u) => u.path)).toEqual([
      join(root, '.cursor/skills/pkg__x'),
      join(root, '.cursor/skills/pkg__x'),
    ]);
    expect(uncertain.some((u) => u.reason.includes('charset rule'))).toBe(true);
    expect(uncertain.some((u) => u.reason.includes('does not match the directory'))).toBe(true);
  });

  it('cannot check a must-match-the-directory rule against a SKILL.md with no name', () => {
    const root = makeRoot();
    skill(root, '.cursor/skills/no-name');

    const { discovered, uncertain } = harnessCoverage('cursor', root);

    expect(discovered).toEqual([]);
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0].reason).toContain('must match its directory');
    expect(uncertain[0].reason).toContain('has no name');
  });
});

describe('harnessCoverage() — Gemini CLI', () => {
  it('reads .gemini/skills and .agents/skills, and never .claude/skills', () => {
    const root = makeRoot();
    skill(root, '.gemini/skills/g1', 'g1');
    skill(root, '.agents/skills/g2', 'g2');
    skill(root, '.claude/skills/g3', 'g3');

    const { discovered, uncertain } = harnessCoverage('gemini', root);

    expect(discovered.map((d) => d.key)).toEqual(['g1', 'g2']);
    expect(discovered.map((d) => d.via)).toEqual(['.gemini/skills', '.agents/skills']);
    expect(uncertain).toEqual([]);
  });

  it('reads the workspace root only — no ancestor walk is documented, so a start directory deeper in the tree changes nothing', () => {
    const root = makeRoot();
    skill(root, '.gemini/skills/at-root', 'at-root');
    skill(root, 'pkg/.gemini/skills/nested', 'nested');

    const { discovered, uncertain } = harnessCoverage('gemini', root, { cwd: join(root, 'pkg') });

    expect(discovered.map((d) => d.key)).toEqual(['at-root']);
    expect(uncertain).toEqual([]);
  });

  it('refuses to name a skill whose directory and frontmatter disagree — Gemini\'s identity rule is a "(verify)" cell', () => {
    const root = makeRoot();
    skill(root, '.gemini/skills/dir-name', 'other-name');

    const { discovered, uncertain } = harnessCoverage('gemini', root);

    expect(discovered).toEqual([]);
    expect(uncertain).toHaveLength(2);
    expect(uncertain.some((u) => u.reason.includes('keyed by its directory'))).toBe(true);
    expect(uncertain.some((u) => u.reason.includes('does not document whether it must'))).toBe(
      true
    );
  });
});

describe('harnessCoverage() — Copilot', () => {
  it('reads .github/skills, .claude/skills and .agents/skills', () => {
    const root = makeRoot();
    skill(root, '.github/skills/h1', 'h1');
    skill(root, '.claude/skills/h2', 'h2');
    skill(root, '.agents/skills/h3', 'h3');

    const { discovered, uncertain } = harnessCoverage('copilot', root);

    expect(discovered.map((d) => d.key)).toEqual(['h1', 'h2', 'h3']);
    expect(discovered.map((d) => d.via)).toEqual([
      '.github/skills',
      '.claude/skills',
      '.agents/skills',
    ]);
    expect(uncertain).toEqual([]);
  });

  it('keeps the first of two REAL copies of one skill and calls the second undecidable (dedupe unknown)', () => {
    // Two real directories, not a symlinked pair: Copilot's symlink cell is
    // itself `unknown`, so a linked fixture would be testing the wrong question.
    const root = makeRoot();
    skill(root, '.claude/skills/twice', 'twice');
    skill(root, '.agents/skills/twice', 'twice');

    const { discovered, uncertain } = harnessCoverage('copilot', root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0].via).toBe('.claude/skills');
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0].path).toBe(join(root, '.agents/skills/twice'));
    expect(uncertain[0].reason).toContain('loads once or twice');
    expect(uncertain[0].reason).toContain('.claude/skills/twice and .agents/skills/twice');
  });

  it('refuses to name a <pkg>__<name> directory whose frontmatter says otherwise — "typically matches the directory" is not an identity rule', () => {
    const root = makeRoot();
    skill(root, '.agents/skills/pkg__x', 'x');

    const { discovered, uncertain } = harnessCoverage('copilot', root);

    expect(discovered).toEqual([]);
    expect(uncertain).toHaveLength(3);
    expect(uncertain.some((u) => u.reason.includes('keyed by its directory'))).toBe(true);
    expect(uncertain.some((u) => u.reason.includes('does not document whether it must'))).toBe(
      true
    );
    expect(uncertain.some((u) => u.reason.includes('charset rule'))).toBe(true);
  });
});

describe('harnessCoverage() — symlinked skill directories', () => {
  /**
   * Stage a real skill outside every read path and link it into `readPath`.
   *
   * @param root - tree root.
   * @param readPath - the repo-relative read path to link it into.
   */
  function stageLinkedSkill(root: string, readPath: string): void {
    const target = skill(root, 'elsewhere/linked', 'linked');
    mkdirSync(join(root, readPath), { recursive: true });
    symlinkSync(target, join(root, readPath, 'linked'), 'dir');
  }

  it.each(['claude-code', 'codex'] as const)(
    '%s: follows a symlinked skill directory, which its docs say it does',
    (harness: HarnessId) => {
      const root = makeRoot();
      const readPath = skillsFactsFor(harness).readPaths.project[0];
      stageLinkedSkill(root, readPath);

      const { discovered, uncertain } = harnessCoverage(harness, root);

      expect(discovered.map((d) => d.key)).toEqual(['linked']);
      expect(discovered[0].dir).toBe(join(root, readPath, 'linked'));
      expect(uncertain).toEqual([]);
    }
  );

  it.each(['opencode', 'cursor', 'gemini', 'copilot'] as const)(
    '%s: cannot say whether a symlinked skill directory is read at all — its symlink cell is undocumented',
    (harness: HarnessId) => {
      const root = makeRoot();
      const readPath = skillsFactsFor(harness).readPaths.project[0];
      stageLinkedSkill(root, readPath);

      const { discovered, uncertain } = harnessCoverage(harness, root);

      expect(discovered).toEqual([]);
      expect(uncertain).toHaveLength(1);
      expect(uncertain[0].path).toBe(join(root, readPath, 'linked'));
      expect(uncertain[0].reason).toContain('reached through a symlink');

      // And the same skill as a REAL directory in the same place is discovered,
      // so the zero above is about the link and nothing else.
      rmSync(join(root, readPath, 'linked'));
      skill(root, `${readPath}/linked`, 'linked');
      const real = harnessCoverage(harness, root);
      expect(real.discovered.map((d) => d.key)).toEqual(['linked']);
      expect(real.uncertain).toEqual([]);
    }
  );
});

describe('harnessCoverage() — negative controls', () => {
  it.each(HARNESS_IDS)(
    '%s: counts no directory without SKILL.md, no loose file and no dangling symlink — and still finds a real skill in the same directory',
    (harness: HarnessId) => {
      const root = makeRoot();
      const readPaths = skillsFactsFor(harness).readPaths.project;
      for (const readPath of readPaths) stageNegativeControls(root, readPath);

      const empty = harnessCoverage(harness, root);
      expect(empty.discovered).toEqual([]);
      expect(empty.uncertain).toEqual([]);

      // The zero above is only meaningful if the walk was looking here at all.
      skill(root, `${readPaths[0]}/control-positive`, 'control-positive');
      const after = harnessCoverage(harness, root);
      expect(after.discovered.map((d) => d.key)).toEqual(['control-positive']);
      expect(after.discovered[0].via).toBe(readPaths[0]);
      expect(after.uncertain).toEqual([]);
    }
  );
});
