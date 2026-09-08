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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendGitignoreLines,
  gitignorePatternMatches,
  isCanonicalLayerIgnored,
  missingGitignoreLines,
} from '../gitignore.js';
import { EPHEMERAL_GITIGNORE_PATTERNS } from '../../sources/resolve-roots.js';
import { project } from '../../engine.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** Options for {@link stageRepo}. */
interface StageOptions {
  /** Enabled harnesses in the scaffolded manifest. */
  harnesses?: string[];
  /** Root `.gitignore` body, or omitted for no file at all. */
  gitignore?: string;
  /** Whether to make the root look like a git checkout. */
  git?: boolean;
  /** A project-scoped installed plugin with one skill and one command. */
  plugin?: boolean;
  /** Authored hooks in `.claude/settings.json`, so the generated files are planned. */
  hooks?: boolean;
}

/** Stage a small repo and return its absolute root. */
function stageRepo(opts: StageOptions = {}): string {
  repo = mkdtempSync(join(tmpdir(), 'harness-gitignore-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-gitignore-home-'));
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: opts.harnesses ?? ['claude-code', 'codex'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Project\n');
  if (opts.git !== false) mkdirSync(join(repo, '.git'), { recursive: true });
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
  it('matches the shapes the constant actually uses', () => {
    expect(gitignorePatternMatches('.dork/plugins/', '.dork/plugins/acme/skills/x')).toBe(true);
    expect(gitignorePatternMatches('.dork/plugins/', '.dork/plugins')).toBe(false);
    expect(gitignorePatternMatches('.claude/skills/*__*', '.claude/skills/acme__greet')).toBe(true);
    expect(gitignorePatternMatches('.claude/skills/*__*', '.claude/skills/greet')).toBe(false);
    // One segment, so a nested path with `__` deeper down is not this pattern's.
    expect(gitignorePatternMatches('.claude/skills/*__*', '.claude/skills/a/b__c')).toBe(false);
    expect(gitignorePatternMatches('.codex/hooks.json', '.codex/hooks.json')).toBe(true);
    expect(gitignorePatternMatches('.codex/hooks.json', '.codex/hooks.json.dorkos-generated')).toBe(
      false
    );
  });

  it('follows git on the shapes a person writes by hand', () => {
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

  it('understands every pattern the engine declares', () => {
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

describe('missingGitignoreLines', () => {
  it('says nothing at all when the root is not a git checkout', () => {
    stageRepo({ git: false, plugin: true });
    expect(missingGitignoreLines(repo, plan())).toEqual([]);
  });

  it('names every line a fresh repo with an installed plugin is missing', () => {
    stageRepo({ plugin: true });
    // The seeded case: nothing is ignored, so every ephemeral path is one
    // `git add .` away from a teammate's clone.
    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.dork/plugins/',
      '.agents/skills/*__*',
      '.claude/skills/*__*',
    ]);
  });

  it('names the generated hooks file and its sidecar when the plan writes one', () => {
    // Their provenance is `authored` — the hooks come from
    // `.claude/settings.json` — but the file written is machine-local, and the
    // sidecar is one machine's digest. A provenance-only rule would miss both.
    stageRepo({ hooks: true });
    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
    ]);
  });

  it('is empty once those lines are there, and after appending them', () => {
    stageRepo({ plugin: true, hooks: true, gitignore: '' });
    const missing = missingGitignoreLines(repo, plan());
    expect(missing.length).toBeGreaterThan(0);
    appendGitignoreLines(repo, missing);
    expect(missingGitignoreLines(repo, plan())).toEqual([]);
  });

  it('accepts a broader rule the person already wrote', () => {
    // `.claude/` covers the skill links and the settings file; nobody should be
    // told to add a narrower line for a path git already ignores.
    stageRepo({ plugin: true, hooks: true, gitignore: '.claude/\n.dork/\n' });
    expect(missingGitignoreLines(repo, plan())).toEqual([
      '.agents/skills/*__*',
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
    ]);
  });

  it('never names a command wrapper — the plan writes a `.gitignore` beside it', () => {
    stageRepo({ plugin: true, harnesses: ['claude-code', 'opencode'] });
    const missing = missingGitignoreLines(repo, plan());
    // Both wrapper dirs are covered by the self-ignoring files the plan itself
    // writes, so a static root rule would only endanger authored command
    // namespaces beside them.
    expect(missing.filter((line) => line.includes('commands'))).toEqual([]);
    expect(missing).toContain('.claude/skills/*__*');
  });

  it('says nothing for a repo with nothing ephemeral in it', () => {
    stageRepo();
    writeFileAt(join(repo, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n');
    // Authored skills are committed on purpose, so an authored-only repo with no
    // hooks has no line to add.
    expect(missingGitignoreLines(repo, plan())).toEqual([]);
  });
});

describe('appendGitignoreLines', () => {
  it('creates the file when there is none', () => {
    stageRepo();
    appendGitignoreLines(repo, ['.dork/plugins/']);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      '# DorkOS harness sync — ephemeral projections\n.dork/plugins/\n'
    );
  });

  it('appends after a blank line, preserving every existing byte', () => {
    stageRepo({ gitignore: 'node_modules/\ndist/\n' });
    appendGitignoreLines(repo, ['.dork/plugins/', '.codex/hooks.json']);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      'node_modules/\ndist/\n\n# DorkOS harness sync — ephemeral projections\n.dork/plugins/\n.codex/hooks.json\n'
    );
  });

  it('does not run a final line into the header when the file has no trailing newline', () => {
    stageRepo({ gitignore: 'node_modules/' });
    appendGitignoreLines(repo, ['.dork/plugins/']);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n\n# DorkOS harness sync — ephemeral projections\n.dork/plugins/\n'
    );
  });
});

describe('isCanonicalLayerIgnored', () => {
  it('is true when the root file ignores `.agents/`', () => {
    stageRepo({ gitignore: 'node_modules/\n.agents/\n' });
    expect(isCanonicalLayerIgnored(repo)).toBe(true);
  });

  it('is false for the two installed-projection patterns inside it', () => {
    // `.agents/skills/*__*` ignores machine-local projections, not the layer —
    // reading it as AP-15 would fire on every repo that follows the contract.
    stageRepo({ gitignore: '.agents/skills/*__*\n.claude/skills/*__*\n' });
    expect(isCanonicalLayerIgnored(repo)).toBe(false);
  });

  it('is true for a `.agents/.gitignore` that ignores its own directory', () => {
    stageRepo();
    writeFileSync(join(repo, '.agents', '.gitignore'), '*\n');
    expect(isCanonicalLayerIgnored(repo)).toBe(true);
  });

  it('is false outside a git checkout, whatever a `.gitignore` says', () => {
    stageRepo({ git: false, gitignore: '.agents/\n' });
    expect(existsSync(join(repo, '.git'))).toBe(false);
    expect(isCanonicalLayerIgnored(repo)).toBe(false);
  });
});
