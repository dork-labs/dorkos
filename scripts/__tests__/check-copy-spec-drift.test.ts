/**
 * Pin suite for `check-copy-spec-drift.ts`, the DOR-1647 copy/spec guard — the
 * RULES half.
 *
 * WHY THIS EXISTS. The guard's whole value is a threshold judgement — which
 * runs of text count as copy, how a regex literal is read, which of two
 * overlapping runs contains the other, and when a string elsewhere in the tree
 * is allowed to say "no, that still renders". Drift in either direction fails
 * silently: loosened, it stops catching the queue ejections it was built for;
 * tightened, it reds a correct PR, which stops `merge-tail.yml` arming
 * auto-merge and teaches everyone to ignore it. Same argument
 * `check-vocab-gate.test.ts` beside this file makes, at the same stakes.
 *
 * `check-copy-spec-drift-replay.test.ts` holds the other half: #1397's and
 * #1549's real shapes replayed end to end, and the whole script driven through
 * a throwaway git checkout. Every threshold asserted here is calibrated on an
 * incident replayed there, so the two files are read together.
 */
import { describe, expect, it } from 'vitest';
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
  spans,
  type Chunk,
  type Finding,
} from '../check-copy-spec-drift.ts';

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

  it('folds case on BOTH clauses, so copy that grew AND lowercased still suppresses', () => {
    // The asymmetry this pins: one clause folded case and the other read the
    // removed run verbatim, so a HEAD run that really did absorb the copy —
    // `Working Directory` growing into `open the working directory picker`
    // during a sentence-case sweep — failed the verbatim clause and the finding
    // survived. A `/i` locator goes on matching that; reporting it is a false
    // positive.
    const insensitive = matchSpecStrings(
      [chunk('Working Directory')],
      [ciChunk('open the working directory picker now')]
    );
    expect(insensitive).toHaveLength(1);
    expect(dropSupported(insensitive, ['open the working directory picker'])).toEqual([]);
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

  it('keeps two DIFFERENT stale strings on one line apart', () => {
    // `expect(row).toHaveText('Paused — no traffic', 'Resume routing')` is two
    // separate fixes on one line. Keying on the position alone reported the
    // first and swallowed the second.
    const oneLine = matchSpecStrings(
      [
        chunk('Paused — no traffic', 'apps/client/src/BindingCard.tsx'),
        chunk('Resume routing', 'apps/client/src/BindingCard.tsx'),
      ],
      [
        { file: 'apps/e2e/tests/a.spec.ts', line: 7, text: 'Paused — no traffic' },
        { file: 'apps/e2e/tests/a.spec.ts', line: 7, text: 'Resume routing' },
      ]
    );
    expect(
      collapseByPosition(oneLine)
        .map((finding) => finding.removed)
        .sort()
    ).toEqual(['Paused — no traffic', 'Resume routing']);
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
