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
 * AND SO IS #1549 (DOR-1819). The gate reported CLEAN on all four browser
 * assertions that batch stranded, which then ejected it from the merge queue —
 * its own failure class, reproduced against the fix for it. `catches the four
 * PR #1549 breaks` reproduces each of the three measured causes as its own
 * case, in the shapes the real files held.
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
  classifyOverlap,
  collapseByPosition,
  dropSupported,
  extractChunks,
  isProseChunk,
  isScannablePath,
  matchSpecStrings,
  normalizeCopy,
  regexLiteralSource,
  removedChunks,
  runCopySpecGuard,
  spans,
  type Chunk,
  type Finding,
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

  it('strips the anchors and carries the case flag off a regex locator', () => {
    // #1549's settings break. `^` never appears in the component's string and
    // the `i` made the casing irrelevant to Playwright — between them, the two
    // characters made this assertion invisible to the gate.
    const chunks = extractChunks(
      'spec.ts',
      "await expect(panel.getByRole('button', { name: /^working directory/i })).toBeVisible();",
      { includeRegex: true }
    );
    expect(chunks).toEqual([
      { file: 'spec.ts', line: 1, text: 'working directory', ignoreCase: true },
    ]);
  });

  it('leaves a case-sensitive regex unflagged, so app copy is compared verbatim', () => {
    const chunks = extractChunks(
      'spec.ts',
      'const chip = page.getByRole("button", { name: /live sessions — open the switcher/ });',
      { includeRegex: true }
    );
    expect(chunks[0]?.ignoreCase).toBeUndefined();
  });
});

describe('regexLiteralSource', () => {
  it('strips both anchors and reports the case flag', () => {
    expect(regexLiteralSource('/^working directory$/i')).toEqual({
      source: 'working directory',
      ignoreCase: true,
    });
  });

  it('keeps an escaped dollar, which is copy rather than an anchor', () => {
    expect(regexLiteralSource('/costs \\$/').source).toBe('costs \\$');
  });

  it('strips the anchor after an escaped backslash', () => {
    expect(regexLiteralSource('/a path\\\\$/').source).toBe('a path\\\\');
  });

  it('reports no case folding for a bare pattern', () => {
    expect(regexLiteralSource('/Connected — 2 tools/')).toEqual({
      source: 'Connected — 2 tools',
      ignoreCase: false,
    });
  });
});

describe('spans', () => {
  it('folds case only when asked', () => {
    expect(spans('Working Directory', 'working directory')).toBe(false);
    expect(spans('Working Directory', 'working directory', true)).toBe(true);
  });
});

describe('classifyOverlap', () => {
  it('reads a spec string that is broader than the removed run', () => {
    expect(classifyOverlap('Compacted context — 51.2k tokens', 'Compacted context —', false)).toBe(
      'assertion-spans-removed'
    );
  });

  it('reads a spec string that sits INSIDE the removed run', () => {
    // The session-switcher break: the component's chunk carries a trailing
    // ` for`, so the spec's regex is the shorter of the two and the original
    // one-directional containment never fired.
    expect(
      classifyOverlap(
        'live sessions — open the session switcher',
        'live sessions — open the session switcher for',
        false
      )
    ).toBe('removed-spans-assertion');
  });

  it('classifies a case-folded equality by the copy side, so a casing sweep is answerable', () => {
    // Title Case → sentence case cannot break a `/…/i` locator, and only the
    // `removed-spans-assertion` rule can see that the file still renders it.
    expect(classifyOverlap('working directory', 'Working Directory', true)).toBe(
      'removed-spans-assertion'
    );
  });

  it('ignores a short spec string that merely happens to sit inside a long run', () => {
    // `Send message`, a room composer button, inside the settings tool
    // description `Send messages and check the inbox` — the one coincidence in
    // #1549's 190 files, and 0.36 of the run it sits in.
    expect(classifyOverlap('Send message', 'Send messages and check the inbox', false)).toBeNull();
  });

  it('says nothing when the two runs do not overlap', () => {
    expect(classifyOverlap('Sign in to continue', 'Compacted context —', false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Removal, matching and suppression
// ---------------------------------------------------------------------------

/** Shorthand for a chunk at an arbitrary position. */
function chunk(text: string, file = 'apps/client/src/Foo.tsx'): Chunk {
  return { file, line: 1, text };
}

/** Shorthand for a spec chunk that came from a `/…/i` regex. */
function ciChunk(text: string, file = 'apps/e2e/tests/a.spec.ts'): Chunk {
  return { file, line: 1, text, ignoreCase: true };
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
    expect(findings[0]?.overlap).toBe('assertion-spans-removed');
  });

  it('pairs a removed run with a spec string it CONTAINS, which is the #1549 shape', () => {
    const findings = matchSpecStrings(
      [chunk('live sessions — open the session switcher for')],
      [
        chunk(
          'live sessions — open the session switcher',
          'apps/e2e/tests/dashboard-sidebar/session-switcher.spec.ts'
        ),
      ]
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.overlap).toBe('removed-spans-assertion');
  });

  it('says nothing when no spec string overlaps the removed run', () => {
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

  it('keeps the finding when the longer HEAD run does not cover the removed one', () => {
    // #1549's presence break in one line: `TAKING_LONGER` is longer than the
    // run that vanished and the spec string of course spans it, but it says
    // nothing about the em dash that disappeared before it.
    const presence = matchSpecStrings(
      [chunk('still working —')],
      [chunk('is still working — this is taking longer than usual', 'apps/e2e/tests/a.spec.ts')]
    );
    expect(dropSupported(presence, ['this is taking longer than usual'])).toHaveLength(1);
  });

  it('suppresses a spec string the removed run still spans, from its own file', () => {
    const casing = matchSpecStrings(
      [chunk('New Session', 'apps/client/src/palette.ts')],
      [ciChunk('new session')]
    );
    expect(dropSupported(casing, [], [chunk('New session', 'apps/client/src/palette.ts')])).toEqual(
      []
    );
  });

  it('will not let another changed file vouch for a spec string', () => {
    // `Select a working directory to browse its files.` is a file-explorer
    // empty state; the spec it would have silenced drives the Server tab.
    const settings = matchSpecStrings(
      [chunk('Working Directory', 'apps/client/src/ServerTab.tsx')],
      [ciChunk('working directory')]
    );
    expect(
      dropSupported(
        settings,
        [],
        [
          chunk(
            'Select a working directory to browse its files.',
            'apps/client/src/FileExplorer.tsx'
          ),
        ]
      )
    ).toHaveLength(1);
  });
});

describe('collapseByPosition', () => {
  /** Two removed runs, both overlapping one assertion on one line. */
  const findings: Finding[] = matchSpecStrings(
    [
      chunk('Select Working Directory', 'apps/client/src/DirectoryPicker.tsx'),
      chunk('Working Directory', 'apps/client/src/ServerTab.tsx'),
    ],
    [ciChunk('working directory', 'apps/e2e/tests/settings/settings-dialog.spec.ts')]
  );

  it('reports one stale assertion once, keeping the closest-fitting evidence', () => {
    expect(findings).toHaveLength(2);
    const collapsed = collapseByPosition(findings);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.removed).toBe('Working Directory');
  });

  it('keeps assertions on different lines apart', () => {
    const twoLines = matchSpecStrings(
      [chunk('Working Directory', 'apps/client/src/ServerTab.tsx')],
      [
        {
          file: 'apps/e2e/tests/settings/settings-dialog.spec.ts',
          line: 1,
          text: 'working directory',
          ignoreCase: true,
        },
        {
          file: 'apps/e2e/tests/settings/settings-dialog.spec.ts',
          line: 2,
          text: 'working directory',
          ignoreCase: true,
        },
      ]
    );
    expect(collapseByPosition(twoLines)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The two failures this gate was built for
// ---------------------------------------------------------------------------

/**
 * Run the pure pipeline the way `runCopySpecGuard` composes it, over one
 * component file and one spec file.
 *
 * @param before - The component at the base commit.
 * @param after - The component at HEAD.
 * @param spec - The apps/e2e file, read with regex harvesting on.
 * @param corpus - Extra HEAD copy from files this change did NOT touch.
 */
function guard(before: string, after: string, spec: string, corpus: string[] = []): number {
  const COMPONENT = 'apps/client/src/Card.tsx';
  const afterChunks = extractChunks(COMPONENT, after);
  const removed = removedChunks(extractChunks(COMPONENT, before), afterChunks);
  const matched = matchSpecStrings(
    removed,
    extractChunks('apps/e2e/tests/x.spec.ts', spec, { includeRegex: true })
  );
  return collapseByPosition(dropSupported(matched, [...texts(afterChunks), ...corpus], afterChunks))
    .length;
}

describe('catches the real 2026-08-31 regressions', () => {
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
// The gate's own failure class, reproduced (DOR-1819)
// ---------------------------------------------------------------------------

describe('catches the four PR #1549 breaks', () => {
  it('catches the chip, whose spec string is SHORTER than the removed run', () => {
    // `AgentListItem.tsx`. The template's static run carries a trailing ` for`
    // that the regex stops before, so one-directional containment — "does the
    // spec string contain the removed chunk" — never fired.
    expect(
      guard(
        'export const label = (n: number, who: string) =>\n  `${n} live sessions — open the session switcher for ${who}`;',
        'export const label = (n: number, who: string) =>\n  `${n} live sessions, open the session switcher for ${who}`;',
        "const chip = page.getByRole('button', { name: /live sessions — open the session switcher/ });"
      )
    ).toBe(1);
  });

  it('catches the settings row, asserted by a case-insensitive ANCHORED regex', () => {
    // `ServerTab.tsx`. `^` and the `i` flag between them made the whole
    // assertion invisible: the caret never appears in the component's string,
    // and the folded casing meant a verbatim comparison could not match either.
    expect(
      guard(
        'export const Row = () => <ConfigRow label="Working Directory" value={cwd} />;',
        'export const Row = () => <ConfigRow label="Working folder" value={cwd} />;',
        "await expect(panel.getByRole('button', { name: /^working directory/i })).toBeVisible();"
      )
    ).toBe(1);
  });

  it('catches the presence line a longer UNCHANGED constant beside it was vouching for', () => {
    // `presence-copy.ts`. `TAKING_LONGER` did not change, is longer than the
    // run that vanished, and is of course inside the spec's sentence — so the
    // old suppression rule read it as "the copy still renders".
    expect(
      guard(
        "const TAKING_LONGER = 'this is taking longer than usual';\nexport const line = (who: string) => `${who} is still working — ${TAKING_LONGER}`;",
        "const TAKING_LONGER = 'this is taking longer than usual';\nexport const line = (who: string) => `${who} is still working, ${TAKING_LONGER}`;",
        'await expect(roomsPage.presenceLine).toHaveText(`${ana.name} is still working — this is taking longer than usual · 12m`);'
      )
    ).toBe(1);
  });

  it('stays quiet on the Title-Case sweep a case-insensitive locator survives', () => {
    // The other half of the same batch, and the reason the copy side is
    // classified first: `/new session/i` goes on matching `New session`, so a
    // casing-only rewrite must report nothing.
    expect(
      guard(
        "export const action = { label: 'New Session', run };",
        "export const action = { label: 'New session', run };",
        "const item = page.getByRole('option', { name: /new session/i });"
      )
    ).toBe(0);
  });

  it('stays quiet on a short spec string that merely sits inside a longer removed run', () => {
    expect(
      guard(
        "export const tools = { messaging: 'Send messages and check the inbox' };",
        "export const tools = { messaging: 'Let agents send messages and check the inbox.' };",
        "await expect(composer.getByRole('button', { name: 'Send message' })).toBeVisible();"
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

  it('reports every stale assertion of a #1549-shaped batch, once each', () => {
    // All three causes in one change, through the real git plumbing, with the
    // e2e side left behind exactly as the batch left it. Five assertions, five
    // findings, no duplicates — the shape the real replay produces.
    const repo = makeTempDir();
    git(repo, 'init', '-b', 'main');
    write(
      repo,
      'apps/client/src/AgentListItem.tsx',
      'export const chipLabel = (n: number, who: string) =>\n  `${n} live sessions — open the session switcher for ${who}`;\n'
    );
    write(
      repo,
      'apps/client/src/ServerTab.tsx',
      'export const Row = () => <ConfigRow label="Working Directory" value={cwd} />;\n'
    );
    write(
      repo,
      'apps/client/src/presence-copy.ts',
      "const TAKING_LONGER = 'this is taking longer than usual';\n" +
        'export const line = (who: string) => `${who} is still working — ${TAKING_LONGER}`;\n'
    );
    write(
      repo,
      'apps/e2e/tests/session-switcher.spec.ts',
      "const chip = page.getByRole('button', { name: /live sessions — open the session switcher/ });\n" +
        "const again = page.getByRole('button', { name: /live sessions — open the session switcher/ });\n"
    );
    write(
      repo,
      'apps/e2e/tests/settings-dialog.spec.ts',
      "await expect(panel.getByRole('button', { name: /^working directory/i })).toBeVisible();\n"
    );
    write(
      repo,
      'apps/e2e/tests/room-presence.spec.ts',
      'await expect(line).toHaveText(`${ana.name} is still working — this is taking longer than usual · 12m`);\n' +
        'await expect(announcer).toHaveText(`${ana.name} is still working — this is taking longer than usual`);\n'
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();

    write(
      repo,
      'apps/client/src/AgentListItem.tsx',
      'export const chipLabel = (n: number, who: string) =>\n  `${n} live sessions, open the session switcher for ${who}`;\n'
    );
    write(
      repo,
      'apps/client/src/ServerTab.tsx',
      'export const Row = () => <ConfigRow label="Working folder" value={cwd} />;\n'
    );
    write(
      repo,
      'apps/client/src/presence-copy.ts',
      "const TAKING_LONGER = 'this is taking longer than usual';\n" +
        'export const line = (who: string) => `${who} is still working, ${TAKING_LONGER}`;\n'
    );
    git(repo, 'commit', '-am', 'copy: register and casing');

    const findings = runCopySpecGuard(repo, base);
    expect(findings.map((finding) => `${finding.specFile}:${finding.specLine}`).sort()).toEqual([
      'apps/e2e/tests/room-presence.spec.ts:1',
      'apps/e2e/tests/room-presence.spec.ts:2',
      'apps/e2e/tests/session-switcher.spec.ts:1',
      'apps/e2e/tests/session-switcher.spec.ts:2',
      'apps/e2e/tests/settings-dialog.spec.ts:1',
    ]);
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
