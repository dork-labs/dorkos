/**
 * The `.gitignore` contract (AP-09) and the gitignored canonical layer (AP-15).
 *
 * Two halves. The first pins the tiny matcher itself — including the claim the
 * rest of the module rests on, that every pattern in
 * `EPHEMERAL_GITIGNORE_PATTERNS` is a shape the matcher understands, so a
 * pattern added in a shape it does not is a red here rather than a silent miss
 * in a person's repo. The second drives `missingGitignoreLines` against real
 * staged trees, because "is this covered" is a question about a file on disk.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendGitignoreLines,
  canonicalLayerIgnoredBy,
  gitignorePatternMatches,
  isPathIgnored,
  missingGitignoreLines,
  pathIgnoredBy,
} from '../gitignore.js';
import { EPHEMERAL_GITIGNORE_PATTERNS } from '../../sources/resolve-roots.js';
import { project } from '../../engine.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

let repo = '';
let checkout = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [checkout, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  checkout = '';
  dorkHome = '';
});

/** Options for {@link stageRepo}. */
interface StageOptions {
  /** Enabled harnesses in the scaffolded manifest. */
  harnesses?: string[];
  /** Root `.gitignore` body, or omitted for no file at all. */
  gitignore?: string;
  /** Whether to make the checkout root look like a git checkout. */
  git?: boolean;
  /**
   * What the `.git` entry is. A linked worktree and a submodule both store a
   * one-line FILE there rather than a directory.
   */
  gitAs?: 'dir' | 'file';
  /**
   * Where the project sits under the checkout root, slash-separated — omitted
   * for a project that IS the checkout root.
   */
  nest?: string;
  /** The CHECKOUT ROOT's `.gitignore` body, which only a nested stage can differ in. */
  rootGitignore?: string;
  /** A project-scoped installed plugin with one skill and one command. */
  plugin?: boolean;
  /** Authored hooks in `.claude/settings.json`, so the generated files are planned. */
  hooks?: boolean;
}

/** Stage a small repo and return the absolute path of the PROJECT. */
function stageRepo(opts: StageOptions = {}): string {
  checkout = mkdtempSync(join(tmpdir(), 'harness-gitignore-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-gitignore-home-'));
  repo = opts.nest === undefined ? checkout : join(checkout, ...opts.nest.split('/'));
  mkdirSync(repo, { recursive: true });
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: opts.harnesses ?? ['claude-code', 'codex'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Project\n');
  if (opts.git !== false) {
    if (opts.gitAs === 'file') {
      writeFileSync(join(checkout, '.git'), 'gitdir: /elsewhere/.git/worktrees/app\n');
    } else mkdirSync(join(checkout, '.git'), { recursive: true });
  }
  if (opts.rootGitignore !== undefined) {
    writeFileSync(join(checkout, '.gitignore'), opts.rootGitignore);
  }
  if (opts.gitignore !== undefined) writeFileSync(join(repo, '.gitignore'), opts.gitignore);
  if (opts.hooks) {
    writeJsonAt(join(repo, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
    });
  }
  if (opts.plugin) {
    const dir = join(repo, '.dork', 'plugins', 'acme');
    writeJsonAt(join(dir, '.dork', 'manifest.json'), {
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'acme plugin',
      layers: ['skills', 'commands'],
    });
    writeFileAt(
      join(dir, 'skills', 'greet', 'SKILL.md'),
      '---\nname: greet\ndescription: Say hello\n---\n\n# greet\n'
    );
    writeFileAt(join(dir, 'commands', 'ship.md'), '---\ndescription: Ship it\n---\n\nShip.\n');
  }
  return repo;
}

/** The plan for the staged repo as it stands. */
function plan(): ReturnType<typeof project> {
  return project(repo, { dorkHome });
}

describe('gitignorePatternMatches', () => {
  it('AP-09: matches the shapes the constant actually uses', () => {
    expect(gitignorePatternMatches('.dork/plugins/', '.dork/plugins/acme/skills/x')).toBe(true);
    // The directory itself too — but only when it IS one. A `dir/` rule says
    // nothing about a file or a symlink at that path, which is git's own rule
    // and the difference between warning a repo and letting it commit a link.
    expect(gitignorePatternMatches('.dork/plugins/', '.dork/plugins', 'dir')).toBe(true);
    expect(gitignorePatternMatches('.dork/plugins/', '.dork/plugins')).toBe(false);
    expect(gitignorePatternMatches('*__*/', '.claude/skills/acme__greet')).toBe(false);
    expect(gitignorePatternMatches('*__*', '.claude/skills/acme__greet')).toBe(true);
    expect(gitignorePatternMatches('.claude/skills/*__*', '.claude/skills/acme__greet')).toBe(true);
    expect(gitignorePatternMatches('.claude/skills/*__*', '.claude/skills/greet')).toBe(false);
    // One segment, so a nested path with `__` deeper down is not this pattern's.
    expect(gitignorePatternMatches('.claude/skills/*__*', '.claude/skills/a/b__c')).toBe(false);
    expect(gitignorePatternMatches('.codex/hooks.json', '.codex/hooks.json')).toBe(true);
    expect(gitignorePatternMatches('.codex/hooks.json', '.codex/hooks.json.dorkos-generated')).toBe(
      false
    );
  });

  it('AP-09: follows git on the shapes a person writes by hand', () => {
    // A directory pattern covers everything beneath it.
    expect(gitignorePatternMatches('.claude/', '.claude/skills/acme__greet')).toBe(true);
    // A bare name matches at any depth; an anchored one only at the root.
    expect(gitignorePatternMatches('node_modules', 'packages/x/node_modules/y')).toBe(true);
    expect(gitignorePatternMatches('/.dork', '.dork/plugins/acme')).toBe(true);
    expect(gitignorePatternMatches('/.dork', 'x/.dork/plugins')).toBe(false);
    expect(
      gitignorePatternMatches('.claude/**/settings.local.json', '.claude/settings.local.json')
    ).toBe(false);
    expect(gitignorePatternMatches('.claude/**', '.claude/settings.local.json')).toBe(true);
    // A comment, a blank, and a negation are not patterns.
    expect(gitignorePatternMatches('# .codex/hooks.json', '.codex/hooks.json')).toBe(false);
    expect(gitignorePatternMatches('   ', 'anything')).toBe(false);
    expect(gitignorePatternMatches('!.codex/hooks.json', '.codex/hooks.json')).toBe(false);
  });

  it('AP-09: understands every pattern the engine declares', () => {
    // The load-bearing claim: `missingGitignoreLines` maps an uncovered path back
    // to the pattern that covers it, so a pattern in a shape this matcher cannot
    // read would silently cover nothing. Each pattern is asked about a path built
    // from itself.
    for (const pattern of EPHEMERAL_GITIGNORE_PATTERNS) {
      const path = pattern.endsWith('/')
        ? `${pattern}some-package/file.json`
        : pattern.replace(/\*/g, 'zz');
      expect({ pattern, matches: gitignorePatternMatches(pattern, path) }).toEqual({
        pattern,
        matches: true,
      });
    }
  });
});

/**
 * Whether git is on PATH, so the conformance block below can run for real.
 *
 * Skipped rather than faked when it is not: a matcher checked only against the
 * test author's own idea of git is the thing that produced the negation bug.
 */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every shape the conformance block puts to real git: a `.gitignore` body, the
 * path to ask about, and what is at the end of it — which decides what a `dir/`
 * rule says, and which `check-ignore` reads off the tree.
 */
const GIT_CASES: ReadonlyArray<{
  gitignore: string;
  path: string;
  kind?: 'dir' | 'file' | 'symlink';
}> = [
  // The two shapes that made this block necessary: a person's `dir/*` plus a
  // re-include. Git TRACKS the file; a negation-blind matcher called it covered.
  { gitignore: '.claude/*\n!.claude/skills/\n', path: '.claude/skills/pkg__skill' },
  { gitignore: '.dork/*\n!.dork/plugins\n', path: '.dork/plugins/acme/skills/x' },
  // ...and the same idiom where the re-include does NOT apply.
  { gitignore: '.claude/*\n!.claude/agents/\n', path: '.claude/skills/pkg__skill' },
  // A negation under an excluded DIRECTORY: git cannot re-include, and says so.
  { gitignore: '.claude/\n!.claude/skills/pkg__skill\n', path: '.claude/skills/pkg__skill' },
  // Order decides: the same two lines the other way round.
  { gitignore: '!.claude/skills/\n.claude/*\n', path: '.claude/skills/pkg__skill' },
  // The engine's own declared shapes.
  { gitignore: '.dork/plugins/\n', path: '.dork/plugins/acme/skills/x' },
  { gitignore: '.dork/plugins/\n', path: '.dork/plugins', kind: 'dir' },
  // A `dir/` rule against each of the three things a leaf can be. Git calls a
  // SYMLINK a file whatever it points at, and both `*__*` families the engine
  // writes ARE symlinks to directories — so a repo whose rule is a `*__*`
  // directory one has git tracking its projections, and a matcher that assumed
  // "a `dir/` line could only name a directory" said nothing (measured
  // 2026-09-08: `--fix` printed no gitignore block while `git status` showed
  // `?? .claude/skills/acme__greet`).
  { gitignore: '*__*/\n', path: '.claude/skills/acme__greet', kind: 'symlink' },
  { gitignore: '*__*/\n', path: '.claude/skills/acme__greet', kind: 'dir' },
  // The same rule in the other two spellings a person writes it in — anchored
  // to the folder, and as a bare name matching at any depth (DOR-1947). One
  // trailing-slash case cannot tell those apart, and the answer has to be the
  // same for all three: git tracks the link.
  { gitignore: '.claude/skills/*__*/\n', path: '.claude/skills/acme__greet', kind: 'symlink' },
  { gitignore: 'acme__greet/\n', path: '.claude/skills/acme__greet', kind: 'symlink' },
  { gitignore: 'hooks.json/\n', path: '.codex/hooks.json', kind: 'file' },
  { gitignore: 'plugins/\n', path: '.dork/plugins', kind: 'dir' },
  { gitignore: '.claude/skills/*__*\n', path: '.claude/skills/acme__greet' },
  { gitignore: '.claude/skills/*__*\n', path: '.claude/skills/greet' },
  { gitignore: '.codex/hooks.json\n', path: '.codex/hooks.json' },
  { gitignore: '.codex/hooks.json\n', path: '.codex/hooks.json.dorkos-generated' },
  { gitignore: '.claude/settings.local.json\n', path: '.claude/settings.local.json' },
  // Anchoring, depth, and the bare-name rule.
  { gitignore: 'node_modules\n', path: 'packages/x/node_modules/y' },
  { gitignore: '/.dork\n', path: '.dork/plugins/acme' },
  { gitignore: '/.dork\n', path: 'x/.dork/plugins' },
  { gitignore: '.claude/**\n', path: '.claude/settings.local.json' },
  { gitignore: '**/hooks.json\n', path: '.codex/hooks.json' },
  { gitignore: '# a comment\n\n.agents/\n', path: '.agents/harness.manifest.json' },
];

describe.skipIf(!hasGit())('the matcher against real git', () => {
  it('AP-09: agrees with `git check-ignore` on every shape these paths take', () => {
    // P7 asks the matcher whether the matcher's own patterns cover a path, which
    // is self-referential about globbing. This is the outside bar: a real repo, a
    // real `.gitignore`, and git's own answer.
    for (const testCase of GIT_CASES) {
      const root = mkdtempSync(join(tmpdir(), 'harness-gitignore-git-'));
      const kind = testCase.kind ?? 'file';
      try {
        execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
        writeFileSync(join(root, '.gitignore'), testCase.gitignore);
        // `check-ignore` reads the tree, so each leaf is staged as what it is.
        mkdirSync(join(root, kind === 'dir' ? testCase.path : dirOf(testCase.path)), {
          recursive: true,
        });
        if (kind === 'file') writeFileSync(join(root, testCase.path), '');
        if (kind === 'symlink') {
          // A link to a real directory: the shape every installed projection has.
          mkdirSync(join(root, '.agents', 'skills', 'acme__greet'), { recursive: true });
          symlinkSync('../../.agents/skills/acme__greet', join(root, testCase.path));
        }

        const ours = isPathIgnored(
          readLines(testCase.gitignore),
          testCase.path,
          kind === 'dir' ? 'dir' : 'file'
        );
        expect({ ...testCase, ignored: ours }).toEqual({
          ...testCase,
          ignored: gitSaysIgnored(root, testCase.path),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    // One real `git init` and one real `git check-ignore` PER CASE, so this one
    // test spawns four dozen processes: 0.6s on an idle machine, 7.8s with the
    // rest of the monorepo's suites running beside it — which is the ordinary
    // condition in this repo, and is what timed it out against the 5s default.
    // 20s leaves room for a worse load without turning into a budget that would
    // let a genuine hang sit for a minute.
  }, 20_000);
});

/** Where a nested project sits under its checkout root in the block below. */
const NEST = 'packages/app';

/**
 * Every shape a project NESTED inside a bigger checkout takes, put to real git
 * (DOR-1957).
 *
 * A DorkOS project is very often not the checkout root, and the rules that cover
 * its projections can live at the root, in a directory on the way down, in the
 * project's own file, or in several of them at once. Each case names which
 * files exist and asks about a path relative to the PROJECT, which is what the
 * engine is asked about and what a person would type.
 */
const NESTED_GIT_CASES: ReadonlyArray<{
  what: string;
  /** `<checkout>/.gitignore`. */
  root?: string;
  /** `<checkout>/packages/.gitignore`, a file between the root and the project. */
  mid?: string;
  /** `<checkout>/packages/app/.gitignore`, the project's own. */
  own?: string;
  /** The path asked about, relative to the project. */
  path: string;
  kind?: 'dir' | 'file' | 'symlink';
}> = [
  {
    what: 'the checkout root ignores the skill links',
    root: '**/.claude/skills/*__*\n',
    path: '.claude/skills/acme__greet',
    kind: 'symlink',
  },
  {
    what: 'the checkout root ignores the canonical layer by naming the package',
    root: 'packages/app/.agents/\n',
    path: '.agents/harness.manifest.json',
  },
  {
    what: "the project's own file ignores the canonical layer",
    own: '.agents/\n',
    path: '.agents/harness.manifest.json',
  },
  {
    what: 'a rule anchored to the checkout root does not reach into a package',
    root: '/.agents\n',
    path: '.agents/harness.manifest.json',
  },
  {
    what: 'a bare name at the checkout root reaches any depth',
    root: '*__*\n',
    path: '.claude/skills/acme__greet',
    kind: 'symlink',
  },
  {
    what: 'a re-include beside the root rule that excluded it',
    root: 'packages/app/.claude/*\n!packages/app/.claude/skills/\n',
    path: '.claude/skills/acme__greet',
    kind: 'symlink',
  },
  {
    what: "the project's own file overrules the checkout root's",
    root: '**/hooks.json\n',
    own: '!hooks.json\n',
    path: '.codex/hooks.json',
  },
  {
    what: 'a file between the checkout root and the project has its say',
    mid: '**/hooks.json\n',
    path: '.codex/hooks.json',
  },
  {
    what: 'a directory excluded above cannot be re-included below',
    root: 'packages/app/.agents/\n',
    own: '!.agents/harness.manifest.json\n',
    path: '.agents/harness.manifest.json',
  },
  {
    what: "the project's own trailing-slash rule still misses a link",
    own: '*__*/\n',
    path: '.claude/skills/acme__greet',
    kind: 'symlink',
  },
  {
    what: 'the install directory, covered from the root at any depth',
    root: '**/.dork/plugins/\n',
    path: '.dork/plugins/any-package',
    kind: 'dir',
  },
  {
    what: 'nothing anywhere ignores it',
    path: '.claude/skills/acme__greet',
    kind: 'symlink',
  },
];

describe.skipIf(!hasGit())('the matcher for a project inside a bigger checkout', () => {
  it('AP-09: agrees with `git check-ignore` run from the project, wherever the rule lives', () => {
    // The walk-up is only worth having if the rules it then reads are git's. The
    // `git init` is at the checkout root and `check-ignore` runs from the
    // project, exactly as a person standing in their package would run it.
    for (const testCase of NESTED_GIT_CASES) {
      const root = mkdtempSync(join(tmpdir(), 'harness-gitignore-nested-'));
      const projectDir = join(root, ...NEST.split('/'));
      const kind = testCase.kind ?? 'file';
      try {
        execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
        mkdirSync(projectDir, { recursive: true });
        if (testCase.root !== undefined) writeFileSync(join(root, '.gitignore'), testCase.root);
        if (testCase.mid !== undefined) {
          writeFileSync(join(root, 'packages', '.gitignore'), testCase.mid);
        }
        if (testCase.own !== undefined) {
          writeFileSync(join(projectDir, '.gitignore'), testCase.own);
        }
        // `check-ignore` reads the tree, so each leaf is staged as what it is.
        mkdirSync(join(projectDir, kind === 'dir' ? testCase.path : dirOf(testCase.path)), {
          recursive: true,
        });
        if (kind === 'file') writeFileSync(join(projectDir, testCase.path), '');
        if (kind === 'symlink') {
          // An ABSOLUTE target, unlike the flat block above: `check-ignore` cares
          // only that the leaf IS a link, and the depth to `.agents` changes with
          // the nesting.
          const source = join(projectDir, '.agents', 'skills', 'acme__greet');
          mkdirSync(source, { recursive: true });
          symlinkSync(source, join(projectDir, testCase.path));
        }

        const ours = pathIgnoredBy(projectDir, testCase.path, kind === 'dir' ? 'dir' : 'file');
        expect({ ...testCase, ignored: ours !== undefined }).toEqual({
          ...testCase,
          ignored: gitSaysIgnored(projectDir, testCase.path),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    // One real `git init` and one real `git check-ignore` per case, under the
    // same monorepo load the block above measured its budget against.
  }, 20_000);

  it('AP-15: names the checkout root file a person would have to open', () => {
    // Agreement is a boolean; the advice is a path. A person standing in
    // `packages/app` opens `../../.gitignore`, and nothing else here says so.
    const root = mkdtempSync(join(tmpdir(), 'harness-gitignore-named-'));
    const projectDir = join(root, ...NEST.split('/'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(root, '.gitignore'), 'packages/app/.agents/\n');
      expect(canonicalLayerIgnoredBy(projectDir)).toBe('../../.gitignore');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The parent directory of a repo-relative path, or `.` when it has none. */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

/** The usable lines of a `.gitignore` body, mirroring what the module reads. */
function readLines(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** git's own verdict: `check-ignore -q` exits 0 for ignored, 1 for tracked. */
function gitSaysIgnored(root: string, path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('missingGitignoreLines', () => {
  it('AP-09: says nothing at all when the root is not a git checkout', () => {
    stageRepo({ git: false, plugin: true });
    expect(missingGitignoreLines(repo, plan())).toEqual([]);
  });

  it('AP-09: names every line a fresh repo with an installed plugin is missing', () => {
    stageRepo({ plugin: true });
    // The seeded case: nothing is ignored, so every ephemeral path is one
    // `git add .` away from a teammate's clone.
    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.dork/plugins/',
      '.agents/skills/*__*',
      '.claude/skills/*__*',
    ]);
  });

  it('AP-09: names the generated hooks file and its sidecar when the plan writes one', () => {
    // Their provenance is `authored` — the hooks come from
    // `.claude/settings.json` — but the file written is machine-local, and the
    // sidecar is one machine's digest. A provenance-only rule would miss both.
    stageRepo({ hooks: true });
    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
    ]);
  });

  it('AP-09: is empty once those lines are there, and after appending them', () => {
    stageRepo({ plugin: true, hooks: true, gitignore: '' });
    const missing = missingGitignoreLines(repo, plan());
    expect(missing.length).toBeGreaterThan(0);
    appendGitignoreLines(repo, missing);
    expect(missingGitignoreLines(repo, plan())).toEqual([]);
  });

  it('AP-09: does not accept a directory rule for a projection that is a link', () => {
    // Measured 2026-09-08: with `.dork/plugins/` and a `*__*` directory rule in the file, `--fix`
    // printed nothing while `git status` showed `?? .claude/skills/acme__greet`.
    // Git calls a symlink a file, so a `dir/` rule never covers one — and both
    // of these projections are symlinks.
    stageRepo({ plugin: true, gitignore: '.dork/plugins/\n*__*/\n' });

    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.agents/skills/*__*',
      '.claude/skills/*__*',
    ]);

    // The same rule WITHOUT the slash does cover them, which is what says this
    // case is about the trailing slash and not about the glob beside it
    // (DOR-1947).
    stageRepo({ plugin: true, gitignore: '.dork/plugins/\n*__*\n' });
    expect(missingGitignoreLines(repo, plan())).toEqual([]);
  });

  it('AP-09: accepts a broader rule the person already wrote', () => {
    // `.claude/` covers the skill links and the settings file; nobody should be
    // told to add a narrower line for a path git already ignores.
    stageRepo({ plugin: true, hooks: true, gitignore: '.claude/\n.dork/\n' });
    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.agents/skills/*__*',
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
    ]);
  });

  it('AP-09: never names a command wrapper — the plan writes a `.gitignore` beside it', () => {
    stageRepo({ plugin: true, harnesses: ['claude-code', 'opencode'] });
    const missing = missingGitignoreLines(repo, plan());
    // Both wrapper dirs are covered by the self-ignoring files the plan itself
    // writes, so a static root rule would only endanger authored command
    // namespaces beside them.
    expect(missing.filter((line) => line.includes('commands'))).toEqual([]);
    expect(missing).toContain('.claude/skills/*__*');
  });

  it('AP-09: honours the checkout root\u2019s rules for a package inside a monorepo', () => {
    // Seeded defect (DOR-1957): the gate was `.git` in the PROJECT directory, so
    // a package below the root answered "not a git checkout" and said nothing at
    // all. The root here covers the install directory and nothing else, so the
    // answer has to be the two families it does NOT cover — which is both halves
    // at once: the rule above is read, and the lines left are still named.
    stageRepo({ nest: 'packages/app', plugin: true, rootGitignore: '**/.dork/plugins/\n' });
    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.agents/skills/*__*',
      '.claude/skills/*__*',
    ]);
  });

  it('AP-09: names the lines a package inside a monorepo is missing, in its own words', () => {
    // The lines stay relative to the PROJECT, because that is the `.gitignore`
    // they get appended to — only the root the rules are read from moved.
    stageRepo({ nest: 'packages/app', plugin: true });
    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.dork/plugins/',
      '.agents/skills/*__*',
      '.claude/skills/*__*',
    ]);
  });

  it('AP-09: says nothing for a repo with nothing ephemeral in it', () => {
    stageRepo();
    writeFileAt(join(repo, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n');
    // Authored skills are committed on purpose, so an authored-only repo with no
    // hooks has no line to add.
    expect(missingGitignoreLines(repo, plan())).toEqual([]);
  });
});

describe('appendGitignoreLines', () => {
  it('AP-09: creates the file when there is none', () => {
    stageRepo();
    appendGitignoreLines(repo, ['.dork/plugins/']);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      '# DorkOS harness sync — ephemeral projections\n.dork/plugins/\n'
    );
  });

  it('AP-09: appends after a blank line, preserving every existing byte', () => {
    stageRepo({ gitignore: 'node_modules/\ndist/\n' });
    appendGitignoreLines(repo, ['.dork/plugins/', '.codex/hooks.json']);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      'node_modules/\ndist/\n\n# DorkOS harness sync — ephemeral projections\n.dork/plugins/\n.codex/hooks.json\n'
    );
  });

  it('AP-09: extends its own block on a second call instead of writing a second heading', () => {
    // Two calls is the ordinary case: a `--harness codex` sync and then a full
    // one, or a package installed after the first `--write-gitignore`.
    stageRepo({ gitignore: 'node_modules/\n' });
    appendGitignoreLines(repo, ['.codex/hooks.json']);
    appendGitignoreLines(repo, ['.dork/plugins/']);

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n\n# DorkOS harness sync — ephemeral projections\n' +
        '.codex/hooks.json\n.dork/plugins/\n'
    );
  });

  it('keeps a person\u2019s own lines below the block below it', () => {
    // The block ends at the first blank line, so an unrelated section a person
    // keeps at the bottom of the file stays at the bottom of the file.
    stageRepo({
      gitignore:
        '# DorkOS harness sync — ephemeral projections\n.codex/hooks.json\n\n# mine\n*.log\n',
    });

    appendGitignoreLines(repo, ['.dork/plugins/']);

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      '# DorkOS harness sync — ephemeral projections\n.codex/hooks.json\n.dork/plugins/\n\n# mine\n*.log\n'
    );
  });

  it('AP-09: does not run a final line into the header when the file has no trailing newline', () => {
    stageRepo({ gitignore: 'node_modules/' });
    appendGitignoreLines(repo, ['.dork/plugins/']);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n\n# DorkOS harness sync — ephemeral projections\n.dork/plugins/\n'
    );
  });
});

describe('canonicalLayerIgnoredBy', () => {
  it('AP-15: names the root file when it ignores `.agents/`', () => {
    stageRepo({ gitignore: 'node_modules/\n.agents/\n' });
    expect(canonicalLayerIgnoredBy(repo)).toBe('.gitignore');
  });

  it('AP-15: answers nothing for the two installed-projection patterns inside it', () => {
    // `.agents/skills/*__*` ignores machine-local projections, not the layer —
    // reading it as AP-15 would fire on every repo that follows the contract.
    stageRepo({ gitignore: '.agents/skills/*__*\n.claude/skills/*__*\n' });
    expect(canonicalLayerIgnoredBy(repo)).toBeUndefined();
  });

  it('AP-15: names `.agents/.gitignore` when that is the file doing it', () => {
    // The whole reason this returns a path: "stop ignoring .agents/" is advice
    // a person cannot act on until they know which of the two files to open.
    stageRepo();
    writeFileSync(join(repo, '.agents', '.gitignore'), '*\n');
    expect(canonicalLayerIgnoredBy(repo)).toBe('.agents/.gitignore');
  });

  it('AP-15: names the checkout root file for a package inside a monorepo', () => {
    // Seeded defect (DOR-1957): a package below the checkout root was told
    // nothing, because the audit asked whether the PROJECT directory held a
    // `.git` — so the one repo shape where the rule lives somewhere else was the
    // one that never heard about it.
    stageRepo({ nest: 'packages/app', rootGitignore: 'node_modules/\npackages/app/.agents/\n' });
    expect(canonicalLayerIgnoredBy(repo)).toBe('../../.gitignore');
  });

  it('AP-15: still names the project\u2019s own file when that is the deeper one', () => {
    // Deepest file wins, which is git's rule and the reason the answer is a path
    // rather than a boolean: two files can both have something to say.
    stageRepo({
      nest: 'packages/app',
      rootGitignore: 'packages/app/.agents/\n',
      gitignore: '.agents/\n',
    });
    expect(canonicalLayerIgnoredBy(repo)).toBe('.gitignore');
  });

  it('AP-15: finds the checkout when the `.git` above is a FILE, as a worktree\u2019s is', () => {
    // A linked worktree and a submodule both store a one-line file there. At the
    // project root `existsSync` always answered yes for it; two directories up,
    // nothing looked at all.
    stageRepo({
      nest: 'packages/app',
      gitAs: 'file',
      rootGitignore: 'packages/app/.agents/\n',
    });
    expect(canonicalLayerIgnoredBy(repo)).toBe('../../.gitignore');
  });

  it('AP-15: answers nothing outside a git checkout, whatever a `.gitignore` says', () => {
    stageRepo({ git: false, gitignore: '.agents/\n' });
    expect(existsSync(join(repo, '.git'))).toBe(false);
    expect(canonicalLayerIgnoredBy(repo)).toBeUndefined();
  });
});
