/**
 * Pin suite for `check-copy-spec-drift.ts`, the DOR-1647 copy/spec guard.
 *
 * WHY THIS EXISTS. The guard's whole value is a threshold judgement — which
 * runs of text count as copy, when a rewrite counts as a deletion, and when an
 * unrelated string elsewhere in the tree is allowed to say "no, that still
 * renders". Drift in either direction fails silently: loosened, it stops
 * catching the queue ejections it was built for; tightened, it reds a correct
 * PR, which stops `merge-tail.yml` arming auto-merge and teaches everyone to
 * ignore it. Same argument `check-vocab-gate.test.ts` beside this file makes,
 * at the same stakes.
 *
 * THE TWO REGRESSIONS ARE FIXTURES, NOT PROSE. `catches the real 2026-08-31
 * regressions` reproduces #1397's actual shapes — the interpolated
 * `Compacted context — ${pre} → ${post} tokens` in a bare `return`, and the
 * `Connected — ${n} tool…` template whose spec asserts a REGEX — because those
 * two are what the design was calibrated against and a rewrite that quietly
 * stops catching them is the only failure that matters.
 *
 * The last suite runs the real script against a real throwaway git repository:
 * a base commit, a copy rewrite committed on top, and `runCopySpecGuard` doing
 * its own `git diff`/`git show`. The classification tests would all still pass
 * if the git plumbing addressed the wrong side of the diff, so the plumbing is
 * executed rather than mocked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dropSupported,
  extractChunks,
  isProseChunk,
  isScannablePath,
  matchSpecStrings,
  normalizeCopy,
  removedChunks,
  runCopySpecGuard,
  type Chunk,
} from '../check-copy-spec-drift.ts';

const tempDirs: string[] = [];

/** A fresh temp directory, tracked for cleanup after the test. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copy-spec-drift-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Chunk texts only, for assertions that do not care about position. */
function texts(chunks: Chunk[]): string[] {
  return chunks.map((chunk) => chunk.text);
}

// ---------------------------------------------------------------------------
// What counts as copy
// ---------------------------------------------------------------------------

describe('isProseChunk', () => {
  it('accepts two-word copy at the length the MCP regression needed', () => {
    // `Connected —` is eleven characters and is the exact run that broke
    // mcp-oauth-signin.spec.ts. A threshold that excluded it would make this
    // gate blind to half the incident it exists for.
    expect(isProseChunk('Connected —')).toBe(true);
  });

  it('rejects a single word, however long', () => {
    expect(isProseChunk('SomeVeryLongIdentifierName')).toBe(false);
  });

  it('rejects runs shorter than the threshold', () => {
    expect(isProseChunk('Save it')).toBe(false);
  });

  it('rejects text with no letters', () => {
    expect(isProseChunk('123 456 789 000')).toBe(false);
  });

  it('rejects paths and URLs even when they contain spaces', () => {
    expect(isProseChunk('./a path/to file')).toBe(false);
    expect(isProseChunk('https://dorkos.ai/one place')).toBe(false);
  });
});

describe('normalizeCopy', () => {
  it('collapses the wrapping JSX applies to multi-line copy', () => {
    expect(normalizeCopy('\n      Sign in to continue\n      reading.\n    ')).toBe(
      'Sign in to continue reading.'
    );
  });
});

describe('isScannablePath', () => {
  it('accepts TypeScript and TSX source', () => {
    expect(isScannablePath('apps/client/src/Foo.tsx')).toBe(true);
    expect(isScannablePath('apps/e2e/tests/foo.spec.ts')).toBe(true);
  });

  it('rejects unit-test fixtures, builds and the dev playground', () => {
    expect(isScannablePath('apps/client/src/__tests__/Foo.test.tsx')).toBe(false);
    expect(isScannablePath('apps/client/src/dev/Showcase.tsx')).toBe(false);
    expect(isScannablePath('apps/server/dist/index.js')).toBe(false);
  });

  it('rejects non-source files a copy-root diff can still list', () => {
    expect(isScannablePath('apps/client/src/index.css')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe('extractChunks', () => {
  it('splits a template literal into its static runs', () => {
    // The compaction regression in one line: neither side ever holds the whole
    // sentence, so only the static runs can be compared.
    const chunks = extractChunks(
      'CompactBoundaryRow.tsx',
      'export const label = `Compacted context — ${pre} → ${post} tokens`;'
    );
    expect(texts(chunks)).toContain('Compacted context —');
  });

  it('reads copy out of a bare return, which the vocab gate cannot', () => {
    const chunks = extractChunks(
      'honest-error.ts',
      "export function message() { return 'Could not reach the server just now.'; }"
    );
    expect(texts(chunks)).toContain('Could not reach the server just now.');
  });

  it('reads JSX text and collapses its wrapping', () => {
    const chunks = extractChunks(
      'Banner.tsx',
      'export const B = () => (\n  <p>\n    Your agent finished\n    the task.\n  </p>\n);'
    );
    expect(texts(chunks)).toContain('Your agent finished the task.');
  });

  it('ignores comments, so a prose sweep over docblocks is not a deletion', () => {
    const chunks = extractChunks(
      'thing.ts',
      '/** Connected — a nice long docblock sentence. */\nexport const x = 1;'
    );
    expect(chunks).toEqual([]);
  });

  it('ignores regular expressions unless asked, and reads their source when asked', () => {
    const source = 'const found = page.getByText(/Connected — 2 tools\\./);';
    expect(texts(extractChunks('spec.ts', source))).toEqual([]);
    expect(texts(extractChunks('spec.ts', source, { includeRegex: true }))).toEqual([
      'Connected — 2 tools\\.',
    ]);
  });

  it('reports 1-based lines so a CI annotation lands on the right row', () => {
    const chunks = extractChunks('Banner.tsx', "const a = 1;\nconst b = 'Sign in to continue';");
    expect(chunks[0]?.line).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Removal, matching and suppression
// ---------------------------------------------------------------------------

/** Shorthand for a chunk at an arbitrary position. */
function chunk(text: string, file = 'apps/client/src/Foo.tsx'): Chunk {
  return { file, line: 1, text };
}

describe('removedChunks', () => {
  it('reports a run the change deleted', () => {
    expect(
      texts(removedChunks([chunk('Compacted context —')], [chunk('Compacted context ·')]))
    ).toEqual(['Compacted context —']);
  });

  it('does not report copy that only grew', () => {
    // Playwright's default text matching is substring-based, so a spec
    // asserting the shorter run still passes.
    expect(
      removedChunks([chunk('Sign in to continue')], [chunk('Sign in to continue now')])
    ).toEqual([]);
  });

  it('does not report copy moved to another file in the same change', () => {
    expect(
      removedChunks(
        [chunk('Sign in to continue', 'apps/client/src/A.tsx')],
        [chunk('Sign in to continue', 'apps/client/src/B.tsx')]
      )
    ).toEqual([]);
  });

  it('reports each distinct run once, however often it appeared', () => {
    expect(
      texts(removedChunks([chunk('Sign in to continue'), chunk('Sign in to continue')], []))
    ).toEqual(['Sign in to continue']);
  });
});

describe('matchSpecStrings', () => {
  it('pairs a removed run with the spec string that spans it', () => {
    const findings = matchSpecStrings(
      [chunk('Compacted context —')],
      [chunk('Compacted context — 51.2k → 4.2k tokens', 'apps/e2e/tests/chat/compaction.ts')]
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.specFile).toBe('apps/e2e/tests/chat/compaction.ts');
    expect(findings[0]?.removed).toBe('Compacted context —');
  });

  it('says nothing when no spec string spans the removed run', () => {
    expect(
      matchSpecStrings([chunk('Compacted context —')], [chunk('Some other assertion here')])
    ).toEqual([]);
  });
});

describe('dropSupported', () => {
  const finding = matchSpecStrings(
    [chunk('Sign in to continue')],
    [chunk('Sign in to continue reading', 'apps/e2e/tests/a.spec.ts')]
  );

  it('suppresses when HEAD copy covers the spec string more specifically', () => {
    expect(dropSupported(finding, ['Sign in to continue reading'])).toEqual([]);
  });

  it('keeps the finding when the only HEAD match is no more specific', () => {
    // The `Connected —` collision: an unrelated component holds exactly the
    // run that vanished, and the spec still cannot match.
    expect(dropSupported(finding, ['Sign in to continue'])).toHaveLength(1);
  });

  it('keeps the finding when a longer HEAD run is unrelated to the spec string', () => {
    expect(dropSupported(finding, ['Something entirely different and long'])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The two failures this gate was built for
// ---------------------------------------------------------------------------

describe('catches the real 2026-08-31 regressions', () => {
  /** Run the pure pipeline the way `runCopySpecGuard` composes it. */
  function guard(before: string, after: string, spec: string, corpus: string[] = []): number {
    const removed = removedChunks(
      extractChunks('apps/client/src/Card.tsx', before),
      extractChunks('apps/client/src/Card.tsx', after)
    );
    const matched = matchSpecStrings(
      removed,
      extractChunks('apps/e2e/tests/x.spec.ts', spec, { includeRegex: true })
    );
    return dropSupported(matched, [
      ...texts(extractChunks('apps/client/src/Card.tsx', after)),
      ...corpus,
    ]).length;
  }

  it('catches #1397 breaking compaction.ts (interpolated copy, string assertion)', () => {
    expect(
      guard(
        'export function label(pre: string, post: string) {\n  return `Compacted context — ${pre} → ${post} tokens`;\n}',
        'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}',
        "await expect(liveRow).toContainText('Compacted context — 51.2k → 4.2k tokens');"
      )
    ).toBe(1);
  });

  it('catches #1397 breaking mcp-oauth-signin.spec.ts (regex assertion)', () => {
    expect(
      guard(
        'export function label(n: number) {\n  return `Connected — ${n} tool${n === 1 ? "" : "s"}.`;\n}',
        'export function label(n: number) {\n  return `Connected · ${n} tool${n === 1 ? "" : "s"}.`;\n}',
        'await expect(section.getByText(/Connected — 2 tools\\./)).toBeVisible();',
        // The unrelated component that kept `Connected —` alive through the
        // sweep. A corpus-wide presence test would suppress on this; the
        // more-specific rule must not.
        ['Connected —']
      )
    ).toBe(1);
  });

  it('stays quiet once the spec is updated in the same change', () => {
    expect(
      guard(
        'export function label(pre: string, post: string) {\n  return `Compacted context — ${pre} → ${post} tokens`;\n}',
        'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}',
        "await expect(liveRow).toContainText('Compacted context · 51.2k → 4.2k tokens');"
      )
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End to end, through real git
// ---------------------------------------------------------------------------

/** Write `contents` to `repo/relPath`, creating parent directories. */
function write(repo: string, relPath: string, contents: string): void {
  const absolute = join(repo, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** Run git in `repo` with hooks and signing disabled. */
function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8' }
  );
}

describe('runCopySpecGuard — through a real git checkout', () => {
  const COMPONENT = 'apps/client/src/CompactBoundaryRow.tsx';
  const SPEC = 'apps/e2e/tests/chat/compaction.spec.ts';

  /** A repo whose base commit renders and asserts the same copy. */
  function seedRepo(): { repo: string; base: string } {
    const repo = makeTempDir();
    git(repo, 'init', '-b', 'main');
    write(
      repo,
      COMPONENT,
      'export function label(pre: string, post: string) {\n  return `Compacted context — ${pre} → ${post} tokens`;\n}\n'
    );
    write(
      repo,
      SPEC,
      "test('shows the boundary', async () => {\n  await expect(row).toContainText('Compacted context — 51.2k → 4.2k tokens');\n});\n"
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    return { repo, base: git(repo, 'rev-parse', 'HEAD').trim() };
  }

  it('reds on a copy rewrite the browser suite still asserts', () => {
    const { repo, base } = seedRepo();
    write(
      repo,
      COMPONENT,
      'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}\n'
    );
    git(repo, 'commit', '-am', 'em-dash sweep');

    const findings = runCopySpecGuard(repo, base);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.specFile).toBe(SPEC);
    expect(findings[0]?.specLine).toBe(2);
    expect(findings[0]?.copyFile).toBe(COMPONENT);
    expect(findings[0]?.removed).toBe('Compacted context —');
  });

  it('stays green when the same change updates the spec', () => {
    const { repo, base } = seedRepo();
    write(
      repo,
      COMPONENT,
      'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}\n'
    );
    write(
      repo,
      SPEC,
      "test('shows the boundary', async () => {\n  await expect(row).toContainText('Compacted context · 51.2k → 4.2k tokens');\n});\n"
    );
    git(repo, 'commit', '-am', 'em-dash sweep, suite in step');

    expect(runCopySpecGuard(repo, base)).toEqual([]);
  });

  it('stays green when the change touches no copy root at all', () => {
    const { repo, base } = seedRepo();
    write(repo, 'docs/thing.mdx', 'Compacted context — some prose.\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'docs only');

    expect(runCopySpecGuard(repo, base)).toEqual([]);
  });

  it('sees an uncommitted rewrite, so running it before pushing is worth something', () => {
    const { repo, base } = seedRepo();
    write(
      repo,
      COMPONENT,
      'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}\n'
    );

    expect(runCopySpecGuard(repo, base)).toHaveLength(1);
  });
});
