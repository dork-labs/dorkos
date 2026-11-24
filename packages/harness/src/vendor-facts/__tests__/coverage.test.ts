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

  // Derived from the table, not hardcoded, so the walk is tested against what
  // the facts SAY rather than against a second copy of them that can drift.
  // Which harness sits in which list is pinned by the census in
  // `vendor-facts.test.ts`, so moving one between them still reds a test.
  const FOLLOWS_LINKS = HARNESS_IDS.filter((h) => skillsFactsFor(h).symlinks === 'followed');
  const LINKS_UNDOCUMENTED = HARNESS_IDS.filter((h) => skillsFactsFor(h).symlinks !== 'followed');

  it('has a harness in both symlink groups, so neither it.each below can pass vacuously', () => {
    expect(FOLLOWS_LINKS.length).toBeGreaterThan(0);
    expect(LINKS_UNDOCUMENTED.length).toBeGreaterThan(0);
    expect(FOLLOWS_LINKS.length + LINKS_UNDOCUMENTED.length).toBe(HARNESS_IDS.length);
  });

  it.each(FOLLOWS_LINKS)(
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
