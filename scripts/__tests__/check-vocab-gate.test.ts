/**
 * Pin suite for `check-vocab-gate.ts`, the DOR-855 vocabulary gate.
 *
 * WHY THIS EXISTS. The gate's entire value is in NOT matching identifiers,
 * comments, and import paths while STILL catching real copy — a classifier
 * that drifted either way would fail silently: too loose and it stops
 * catching regressions, too strict and the first false positive teaches
 * everyone to ignore it. Same argument as `test-assert-tests-executed.sh`
 * (that header explains it at length): the gate is one matcher away from
 * certifying nothing, so both directions are pinned here, not just the
 * happy path.
 *
 * Fixtures are synthetic source strings passed straight to `scanSource`
 * (no disk I/O) for the classification tests, and a throwaway temp
 * directory for the file-discovery and end-to-end tests — mirroring the
 * hermetic-fixture pattern `test-assert-tests-executed.sh` uses, so this
 * suite can never red-light an unrelated PR just because the real repo grew
 * a new file.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  collectFiles,
  collectMdxFiles,
  isAllowlisted,
  loadAllowlist,
  loadBannedTerms,
  runVocabGate,
  scanMdx,
  scanSource,
  stripNonProse,
  termMatcher,
  type AllowlistEntry,
  type BannedTerm,
} from '../check-vocab-gate.ts';

const TERMS: BannedTerm[] = [{ term: 'connection', wave: 'wave-1', issue: 'DOR-855' }];

/** Wave 3 bans punctuation, not words — the case boundary-fencing gets wrong. */
const PUNCTUATION_TERMS: BannedTerm[] = [
  { term: '...', wave: 'wave-3', issue: 'DOR-1756' },
  { term: '&apos;', wave: 'wave-3', issue: 'DOR-1756' },
];

/**
 * Wave 4 — the four nouns ADR 260804-021140 retired for "Connections", in both
 * numbers. Kept here as a fixture rather than read from the shipped file so the
 * counterfactuals below assert the matcher, not the data.
 */
const WAVE_4_TERMS: BannedTerm[] = [
  'integration',
  'integrations',
  'connector',
  'connectors',
  'adapter',
  'adapters',
  'provider',
  'providers',
].map((term) => ({ term, wave: 'wave-4', issue: 'DOR-1814' }));

const tempDirs: string[] = [];

/** A fresh temp directory, tracked for cleanup after the test. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-gate-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Real copy is caught
// ---------------------------------------------------------------------------

describe('scanSource — copy positions the gate must catch', () => {
  it('catches bare JSX text', () => {
    const violations = scanSource(
      'Banner.tsx',
      `export function Banner() { return <p>Connection lost. Check your network.</p>; }`,
      TERMS
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('connection');
  });

  it('catches a JSX attribute the render path treats as copy', () => {
    const violations = scanSource(
      'Field.tsx',
      `<Input label="Connection" placeholder="e.g. Connection" />`,
      TERMS
    );
    // Two attributes, both copy-bearing: label and placeholder.
    expect(violations).toHaveLength(2);
  });

  it('ignores a JSX attribute this render path does not treat as copy', () => {
    const violations = scanSource('Field.tsx', `<div data-testid="connection-row" />`, TERMS);
    expect(violations).toHaveLength(0);
  });

  it('ignores q/a as JSX attributes — deliberately prop-only (DOR-1520)', () => {
    // Unlike label/title/etc., q/a are not added to COPY_ATTR_NAMES — not
    // because an attribute is riskier than a property (it isn't: `{ a: '...' }`
    // scans as a real violation the same way an attribute would), but because
    // nothing needs them there yet. Only the FAQ object-property shape is
    // scanned; add the attribute form if a real `<Foo q=... a=... />` copy
    // position ever shows up.
    const violations = scanSource('Field.tsx', `<Foo q="Connection?" a="Connection." />`, TERMS);
    expect(violations).toHaveLength(0);
  });

  it('catches an object property named like a copy field', () => {
    const violations = scanSource(
      'config.ts',
      `export const CONFIG = { label: 'Connection lost', key: 'connection' };`,
      TERMS
    );
    // Only `label`, not `key` — `key` is not a copy-bearing property name.
    expect(violations).toHaveLength(1);
  });

  it('catches the compare-page FAQ shape (DOR-1520): q/a object properties', () => {
    const violations = scanSource(
      'comparisons.ts',
      `faq: [{ q: 'Is there a Connection fee?', a: 'No Connection fee applies.' }]`,
      TERMS
    );
    expect(violations).toHaveLength(2);
  });

  it('catches a toast.error(...) first argument', () => {
    const violations = scanSource('foo.ts', `toast.error('Connection lost', { id: 'x' });`, TERMS);
    expect(violations).toHaveLength(1);
  });

  it('catches a *.setError(...) message', () => {
    const violations = scanSource('foo.ts', `machine.setError('Connection timed out');`, TERMS);
    expect(violations).toHaveLength(1);
  });

  it('catches copy behind a ternary in JSX children', () => {
    const violations = scanSource(
      'Banner.tsx',
      `<p>{isDown ? 'Connection lost' : 'All good'}</p>`,
      TERMS
    );
    expect(violations).toHaveLength(1);
  });

  it('catches copy behind a ?? fallback', () => {
    const violations = scanSource(
      'foo.ts',
      `return { message: err.message ?? 'Connection failed' };`,
      TERMS
    );
    expect(violations).toHaveLength(1);
  });

  it('catches copy behind a && short-circuit in JSX children', () => {
    // The idiom every conditional JSX-text render in this codebase actually
    // uses (`{cond && 'copy'}`), not just the ternary form above. Missing
    // this was a real gap found in review — AdapterSetupWizard.tsx's
    // `{step === 'test' && 'Testing connection to the adapter.'}` shipped
    // unscanned until `&&` joined the transparent-operator list.
    const violations = scanSource(
      'Wizard.tsx',
      `<p>{step === 'test' && 'Testing connection to the adapter.'}</p>`,
      TERMS
    );
    expect(violations).toHaveLength(1);
  });

  it('catches literal spans inside a template expression used as copy', () => {
    const violations = scanSource(
      'foo.ts',
      'const x = { message: `${n} connection${n > 1 ? "s" : ""} down` };',
      TERMS
    );
    expect(violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Code, not copy, is invisible to the walk
// ---------------------------------------------------------------------------

describe('scanSource — non-copy positions the gate must ignore', () => {
  it('ignores a bare identifier, even one built from the banned word', () => {
    const violations = scanSource(
      'foo.ts',
      `const connection = new SSEConnection(url); connection.connect();`,
      TERMS
    );
    expect(violations).toHaveLength(0);
  });

  it('ignores a type name containing the banned word with no boundary', () => {
    const violations = scanSource(
      'foo.ts',
      `type ConnectionState = 'connected' | 'disconnected';`,
      TERMS
    );
    expect(violations).toHaveLength(0);
  });

  it('ignores an import specifier', () => {
    const violations = scanSource(
      'foo.ts',
      `import { SSEConnection } from './sse-connection';`,
      TERMS
    );
    expect(violations).toHaveLength(0);
  });

  it('ignores a switch/case discriminant', () => {
    const violations = scanSource(
      'foo.ts',
      `switch (key) { case 'connection': return 1; default: return 0; }`,
      TERMS
    );
    expect(violations).toHaveLength(0);
  });

  it('ignores an object key that is not a copy-bearing property name', () => {
    const violations = scanSource('foo.ts', `const item = { key: 'connection' };`, TERMS);
    expect(violations).toHaveLength(0);
  });

  it('ignores a comment', () => {
    const violations = scanSource(
      'foo.ts',
      `// Reset the connection\n/** Connection lost is the loudest state. */\nconst x = 1;`,
      TERMS
    );
    expect(violations).toHaveLength(0);
  });

  it('does not fire on the plural, domain-legitimate word', () => {
    const violations = scanSource('foo.tsx', `<p>Manage your connections here.</p>`, TERMS);
    expect(violations).toHaveLength(0);
  });

  it('does not fire on an inflection that only shares a prefix', () => {
    const violations = scanSource('foo.tsx', `<p>Reconnecting… Connecting now.</p>`, TERMS);
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Punctuation terms (wave 3)
// ---------------------------------------------------------------------------

describe('termMatcher — boundaries only where a word boundary exists', () => {
  it('fences a word term, so an inflection sharing its prefix stays clean', () => {
    const re = termMatcher('connection');
    expect(re.test('Connection lost')).toBe(true);
    expect(re.test('reconnecting now')).toBe(false);
  });

  it('does not fence a punctuation term — `\\b...\\b` would match nothing', () => {
    const re = termMatcher('...');
    expect(re.test('Saving...')).toBe(true);
    expect(re.test('Saving…')).toBe(false);
  });

  it('escapes the term, so `...` is three literal periods and not three wildcards', () => {
    expect(termMatcher('...').test('abc')).toBe(false);
  });

  it('still fences the leading word character of an entity term', () => {
    // `&apos;` starts with `&`, a non-word character, so no leading `\b`.
    expect(termMatcher('&apos;').test('Couldn&apos;t copy')).toBe(true);
  });
});

describe('scanSource — punctuation in copy positions', () => {
  it('catches a three-period ellipsis in a copy attribute', () => {
    const violations = scanSource(
      'Filter.tsx',
      `<Input placeholder="Filter agents..." />`,
      PUNCTUATION_TERMS
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('...');
  });

  it('catches an `&apos;` entity in JSX text', () => {
    const violations = scanSource(
      'Copy.tsx',
      `export function Copy() { return <span>Couldn&apos;t copy</span>; }`,
      PUNCTUATION_TERMS
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('&apos;');
  });

  it('passes the single ellipsis character and a literal curly apostrophe', () => {
    const violations = scanSource(
      'Filter.tsx',
      `<Input placeholder="Filter agents…" title="Couldn’t copy" />`,
      PUNCTUATION_TERMS
    );
    expect(violations).toEqual([]);
  });

  it('ignores a spread, which is three periods in a position that is not copy', () => {
    const violations = scanSource(
      'Row.tsx',
      `function Row({ label, ...rest }) { return <div {...rest}>{label}</div>; }`,
      PUNCTUATION_TERMS
    );
    expect(violations).toEqual([]);
  });
});

describe('isAllowlisted', () => {
  const entries: AllowlistEntry[] = [
    { path: 'features/connections/', terms: ['connection'], reason: 'The Connections page.' },
    { path: 'features/everything/', reason: 'Scoped to no terms means every term.' },
  ];

  it('suppresses a hit at an allowlisted path for a covered term', () => {
    expect(
      isAllowlisted('apps/client/src/layers/features/connections/Page.tsx', 'connection', entries)
    ).toBe(true);
  });

  it('does not suppress a hit outside every allowlisted path', () => {
    expect(
      isAllowlisted('apps/client/src/layers/features/relay/Banner.tsx', 'connection', entries)
    ).toBe(false);
  });

  it('an entry with no terms[] covers every term at its path', () => {
    expect(
      isAllowlisted('apps/client/src/layers/features/everything/x.ts', 'integration', entries)
    ).toBe(true);
  });

  it('an entry scoped to specific terms does not cover an unlisted term', () => {
    expect(
      isAllowlisted('apps/client/src/layers/features/connections/Page.tsx', 'integration', entries)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAllowlisted's `contains` field (DOR-2508, second review round): a
// path-only entry exempts every matching line in that file, which is exactly
// what a genuinely whole-page developer guide needs (docs/integrations/) but
// too wide for a narrow, single-purpose entry (one real config-field-name key
// or one Card title). `contains` narrows such an entry to the line that
// actually needs it, so a NEW, unrelated use of the same term anywhere else
// in the file is still caught.
// ---------------------------------------------------------------------------

describe("isAllowlisted's `contains` field", () => {
  const scopedEntries: AllowlistEntry[] = [
    {
      path: 'docs/getting-started/configuration.mdx',
      terms: ['connector', 'connectors'],
      contains: "'connectors.rawMcpServers'",
      reason: 'The real config field name key.',
    },
  ];

  it('suppresses a hit whose snippet contains the pinned substring', () => {
    expect(
      isAllowlisted(
        'docs/getting-started/configuration.mdx',
        'connectors',
        scopedEntries,
        "'connectors.rawMcpServers': {"
      )
    ).toBe(true);
  });

  it('does NOT suppress a hit at the same path and term whose snippet lacks the pinned substring — the mutation this field exists to catch', () => {
    expect(
      isAllowlisted(
        'docs/getting-started/configuration.mdx',
        'connectors',
        scopedEntries,
        '### Connectors'
      )
    ).toBe(false);
  });

  it('treats a missing snippet as never satisfying a `contains` entry, rather than throwing', () => {
    expect(
      isAllowlisted('docs/getting-started/configuration.mdx', 'connectors', scopedEntries)
    ).toBe(false);
  });

  it('an entry with no `contains` still covers every matching line at its path (unchanged whole-file behavior)', () => {
    const pathOnly: AllowlistEntry[] = [
      { path: 'docs/integrations/', terms: ['adapter'], reason: 'Whole-page developer guide.' },
    ];
    expect(
      isAllowlisted(
        'docs/integrations/building-relay-adapters.mdx',
        'adapter',
        pathOnly,
        'anything at all'
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

describe('collectFiles', () => {
  it('finds source files under the scan roots and skips __tests__, dev/, and node_modules', () => {
    const root = makeTempDir();
    const paths = [
      'apps/client/src/layers/features/foo/Foo.tsx',
      'apps/client/src/layers/features/foo/__tests__/Foo.test.tsx',
      'apps/client/src/dev/showcases/FooShowcase.tsx',
      'apps/client/src/node_modules/pkg/index.ts',
      'apps/site/src/components/Bar.tsx',
    ];
    for (const p of paths) {
      const full = join(root, p);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, 'export const x = 1;');
    }

    const found = collectFiles(['apps/client/src', 'apps/site/src'], root).map((f) =>
      f.slice(root.length + 1)
    );

    expect(found.sort()).toEqual(
      ['apps/client/src/layers/features/foo/Foo.tsx', 'apps/site/src/components/Bar.tsx'].sort()
    );
  });

  it('tolerates a configured root that does not exist', () => {
    const root = makeTempDir();
    expect(collectFiles(['apps/client/src', 'apps/does-not-exist'], root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe('runVocabGate', () => {
  it('reports a violation with file, line, and term, unfiltered by any allowlist entry', () => {
    const root = makeTempDir();
    const bannerPath = join(root, 'apps/client/src/layers/features/foo/Banner.tsx');
    mkdirSync(join(bannerPath, '..'), { recursive: true });
    writeFileSync(bannerPath, `export const Banner = () => <p>Connection lost.</p>;`);

    const violations = runVocabGate(root, ['apps/client/src']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('apps/client/src/layers/features/foo/Banner.tsx');
    expect(violations[0]?.term).toBe('connection');
    // The real allowlist.json ships no entry for a made-up `features/foo/`
    // path, so this fixture is unaffected by it — end-to-end suppression via
    // a real allowlist entry is what the regression-canary test below proves,
    // against the actual Connections-domain files it covers.
  });

  it('finds nothing when the scan roots hold no source files', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'apps/client/src'), { recursive: true });
    expect(runVocabGate(root, ['apps/client/src'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The docs scan (DOR-2508): stripNonProse's fence handling
//
// A fenced code block is tracked with a small state machine, and real files
// in this repo broke a naive version of it before these tests existed:
// `docs/contributing/testing.mdx` (Prettier collapses a short fenced block
// onto one line inside a JSX child) and `docs/self-hosting/deployment.mdx`
// (a multi-line fence whose closer trailed real code content instead of
// opening its own line — a genuine site bug, not just a gate false negative;
// the fence never closed, silently swallowing the "Interactive Setup" tab
// into the wrong code block, fixed alongside these tests). Both shapes are
// pinned here as synthetic fixtures, plus the nested-fence-length case a
// 4-backtick block needs.
// ---------------------------------------------------------------------------

describe("stripNonProse — fence detection the docs scan's line/column pins depend on", () => {
  it('blanks a normal multi-line fence and resumes scanning the line after it closes', () => {
    const text = [
      'Before.',
      '```bash',
      'a connector mention inside the fence',
      '```',
      'After.',
    ].join('\n');
    const stripped = stripNonProse(text).split('\n');
    expect(stripped).toEqual(['Before.', '', '', '', 'After.']);
  });

  it('a fence that opens AND closes on the same line is inline code — real text on either side stays prose (docs/contributing/testing.mdx:18 shape)', () => {
    // Mirrors `    \`\`\`bash pnpm vitest run ... \`\`\`` — Prettier collapsed a
    // fenced block onto one line with nothing else on it.
    const text = '    ```bash pnpm vitest run apps/server -- a connector test ```';
    const stripped = stripNonProse(text);
    expect(stripped.trim()).toBe('');
  });

  it('the banned noun INSIDE a same-line fence is never flagged, but a banned noun on the very next line still is (DOR-2508, second review round: the meaningful version of the test above)', () => {
    // A `stripNonProse`-only assertion on one isolated line cannot tell a
    // correct same-line-fence-is-inline-code implementation from a broken one
    // that falls through to "this line OPENS a multi-line fence" instead —
    // both blank the fence line itself. The difference only shows up on the
    // line AFTER it: a real multi-line-fence-open would swallow line 2 as
    // still-fenced content and hide its violation; the correct same-line
    // handling leaves line 2 as ordinary prose. Driven through scanMdx, not
    // stripNonProse, so this is the same seam a docs reader's compiled page
    // — and check-vocab-gate's own scan — actually goes through.
    const text = [
      '    ```bash pnpm vitest run apps/server -- a connector test ```',
      'A connector mention on the very next line should still be flagged.',
    ].join('\n');
    const violations = scanMdx('docs/fixture.mdx', text, WAVE_4_TERMS);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.term).toBe('connector');
  });

  it('a same-line fence pair with prose on both sides leaves the prose scannable (docs/contributing/testing.mdx:15 shape)', () => {
    // Mirrors `<Tab value="All tests">\`\`\`bash pnpm test \`\`\` Runs all tests
    // via a connector.</Tab>` — text before AND after the inline fence.
    const text =
      '  <Tab value="All tests">```bash pnpm test ``` Runs all tests via a connector.</Tab>';
    const stripped = stripNonProse(text);
    expect(stripped).toContain('<Tab value="All tests">');
    expect(stripped).toContain('Runs all tests via a connector.</Tab>');
    expect(stripped).not.toContain('pnpm test');
  });

  it("a closer trailing real content on the same physical line does NOT close the fence, per CommonMark — verified against the real MDX compiler, not assumed (docs/self-hosting/deployment.mdx's ORIGINAL, now-fixed shape)", () => {
    // An earlier version of this suite assumed the opposite — that a closer
    // trailing content still closes the fence — and shipped that as the
    // "deployment.mdx shape." It was never checked against a real parser.
    // Compiling the real file as it shipped at the time with @mdx-js/mdx, by
    // hand, showed the fence genuinely never closed there: the ``` at the end of
    // "...DORKOS_BOUNDARY=/path/to/boundary ```" was swallowed as code text,
    // and the block absorbed everything after it — including the entire
    // "Interactive Setup" tab, which never rendered. A real, pre-existing
    // site bug, fixed directly in that file in the same change that added
    // this test (real fenced block, closer alone on its own line). This
    // fixture keeps the ORIGINAL broken shape as a synthetic regression pin
    // for what the fence tracker SHOULD do when it sees it again anywhere
    // else: stay open past a closer that isn't alone on its own line.
    const text = [
      '  ```bash export ANTHROPIC_API_KEY=your-key-here export',
      '  DORKOS_DEFAULT_CWD=/path/to/projects export DORKOS_BOUNDARY=/path/to/boundary ```',
      'Still inside the fence: a connector mention here must NOT be flagged.',
      '```',
      'A connector mention after the REAL closer is flagged.',
    ].join('\n');
    const stripped = stripNonProse(text).split('\n');
    expect(stripped[0]).toBe('');
    expect(stripped[1]).toBe('');
    expect(stripped[2]).toBe('');
    expect(stripped[3]).toBe('');
    expect(stripped[4]).toBe('A connector mention after the REAL closer is flagged.');
  });

  it('a fence-character run in the MIDDLE of a content line is never a closer — only a line that is the run alone, per CommonMark (DOR-2508, second review round)', () => {
    const text = [
      '```bash',
      'echo "look, a ``` sequence mid-line"',
      '```',
      'A connector mention after the real closer.',
    ].join('\n');
    const stripped = stripNonProse(text).split('\n');
    expect(stripped[0]).toBe('');
    // The mid-line ``` inside the echo string does not close the fence, so
    // this whole content line stays blanked as fenced content.
    expect(stripped[1]).toBe('');
    expect(stripped[2]).toBe('');
    expect(stripped[3]).toBe('A connector mention after the real closer.');
  });

  it('a closer may be indented, but nothing may follow it on the line — verified with scanMdx end to end', () => {
    const text = [
      '```',
      '  a connector mention as fenced content',
      '   ```   ',
      'A connector mention after the indented closer is flagged.',
    ].join('\n');
    const violations = scanMdx('docs/fixture.mdx', text, WAVE_4_TERMS);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(4);
  });

  it('a fence only closes on a run of its own character at least as long as the opener — a shorter same-character run inside is content, never a closer (4-backtick block with an inner 3-backtick fence)', () => {
    const text = [
      'Before.',
      '````',
      'a connector mention inside the outer fence',
      '```',
      'inner fenced content, a second connector mention here too',
      '```',
      '````',
      'After: a connector mention should be caught now.',
    ].join('\n');
    const stripped = stripNonProse(text).split('\n');
    expect(stripped).toHaveLength(8);
    expect(stripped[0]).toBe('Before.');
    // Every line from the opener through the true (4-backtick) closer is
    // blanked, including both inner 3-backtick lines that look like closers
    // but are one character short.
    for (let i = 1; i <= 6; i++) expect(stripped[i]).toBe('');
    expect(stripped[7]).toBe('After: a connector mention should be caught now.');
  });

  it('a tilde fence does not close on a backtick run, or vice versa', () => {
    const text = [
      '~~~',
      'a connector mention, and a fake ``` closer that is the wrong character',
      '~~~',
      'After.',
    ].join('\n');
    const stripped = stripNonProse(text).split('\n');
    expect(stripped).toEqual(['', '', '', 'After.']);
  });
});

// ---------------------------------------------------------------------------
// The docs scan (DOR-2508): scanMdx
// ---------------------------------------------------------------------------

describe('scanMdx — copy positions the docs gate must catch', () => {
  it('catches a banned noun in an ordinary prose sentence', () => {
    const violations = scanMdx(
      'docs/guide.mdx',
      'Connect a chat integration to your agents.',
      WAVE_4_TERMS
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('integration');
    expect(violations[0]?.line).toBe(1);
  });

  it('catches a banned noun in a heading', () => {
    const violations = scanMdx('docs/guide.mdx', '## Built-in adapters\n', WAVE_4_TERMS);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('adapters');
  });

  it('catches link TEXT, but not the URL sitting in the same link target', () => {
    // The word appears twice: once in the visible link text (a reader reads
    // it) and once in the URL (a reader does not) — only the first counts.
    const violations = scanMdx(
      'docs/guide.mdx',
      'See the [integration guide](/docs/integrations/building-integrations) for details.',
      WAVE_4_TERMS
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('integration');
    expect(violations[0]?.column).toBeLessThan(
      'See the [integration guide]('.length + '/docs/integrations/'.length
    );
  });

  it('a "vocab-allow" marker inside docs/ is ITSELF a violation, not an exemption (DOR-2508, third review round)', () => {
    // An inline marker was tried and reverted: Fumadocs' remarkHeading and
    // remarkStructure copy a JSX comment's text into the live page's heading
    // titles/anchors and search index. There is no longer any per-line
    // exemption mechanism for docs/ — only a `contains`-scoped
    // allowlist.json entry (see AllowlistEntry.contains) works.
    const violations = scanMdx(
      'docs/guide.mdx',
      '### Claude Code adapter {/* vocab-allow: names the real built-in component */}\n',
      WAVE_4_TERMS
    );
    // Two independent violations on the same line: the banned term itself
    // (still fully reported — the marker text does not suppress it anymore)
    // and the marker-ban hit.
    expect(violations.map((v) => v.term).sort()).toEqual(['adapter', 'vocab-allow']);
    expect(violations.every((v) => v.line === 1)).toBe(true);
    const markerHit = violations.find((v) => v.term === 'vocab-allow');
    expect(markerHit?.wave).toBe('docs-marker-ban');
  });

  it('the marker ban fires even on a line with no banned term at all', () => {
    const violations = scanMdx(
      'docs/guide.mdx',
      'Nothing retired here. {/* vocab-allow: reason */}\n',
      WAVE_4_TERMS
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('vocab-allow');
  });

  it('the marker ban is NOT allowlistable — a normal contains-scoped entry never suppresses it (mutation this bans-not-exempts design exists to catch)', () => {
    const scopedButNotForMarkers: AllowlistEntry[] = [
      {
        path: 'docs/guide.mdx',
        terms: ['vocab-allow'],
        reason: 'An entry someone might mistakenly add, naming the marker text as its own term.',
      },
    ];
    const violations = scanMdx(
      'docs/guide.mdx',
      '### Claude Code adapter {/* vocab-allow: reason */}\n',
      WAVE_4_TERMS
    );
    const markerHit = violations.find((v) => v.term === 'vocab-allow')!;
    expect(markerHit).toBeDefined();
    // isAllowlisted alone WOULD suppress it (it only checks path/terms/contains) —
    // proving the real protection lives in runVocabGate's `v.wave !==
    // 'docs-marker-ban'` guard, not in scanMdx or isAllowlisted individually.
    expect(
      isAllowlisted(markerHit.file, markerHit.term, scopedButNotForMarkers, markerHit.snippet)
    ).toBe(true);
  });
});

describe('scanMdx — non-copy positions the docs gate must ignore', () => {
  it('ignores a banned noun inside a fenced code block', () => {
    const text = ['```bash', 'dorkos package init my-adapter --type adapter', '```'].join('\n');
    expect(scanMdx('docs/guide.mdx', text, WAVE_4_TERMS)).toEqual([]);
  });

  it('ignores a banned noun inside an inline code span', () => {
    const text = 'Set `connectors.rawMcpServers` in your config file.';
    expect(scanMdx('docs/guide.mdx', text, WAVE_4_TERMS)).toEqual([]);
  });

  it('ignores a banned noun inside an href attribute value', () => {
    const text = '<Card title="MCP Server" href="/docs/integrations/mcp-server">Learn more.</Card>';
    expect(scanMdx('docs/guide.mdx', text, WAVE_4_TERMS)).toEqual([]);
  });

  it('ignores a banned noun inside a src attribute value', () => {
    const text = '<img src="/img/adapter-diagram.png" alt="Diagram" />';
    expect(scanMdx('docs/guide.mdx', text, WAVE_4_TERMS)).toEqual([]);
  });

  it('ignores an import line naming a banned noun in its path', () => {
    const text =
      "import { IntegrationCard } from '../integrations/IntegrationCard';\nReal prose below.";
    const violations = scanMdx('docs/guide.mdx', text, WAVE_4_TERMS);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The docs scan (DOR-2508): collectMdxFiles
// ---------------------------------------------------------------------------

describe('collectMdxFiles', () => {
  it('finds .mdx files under the docs root, skipping node_modules', () => {
    const root = makeTempDir();
    const paths = [
      'docs/connections/index.mdx',
      'docs/connections/composio.mdx',
      'docs/node_modules/pkg/README.mdx',
      'docs/connections/README.md', // wrong extension, not .mdx
    ];
    for (const p of paths) {
      const full = join(root, p);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, '# Title\n');
    }
    const found = collectMdxFiles(['docs'], root).map((f) => f.slice(root.length + 1));
    expect(found.sort()).toEqual(
      ['docs/connections/index.mdx', 'docs/connections/composio.mdx'].sort()
    );
  });

  it('excludes docs/api/** (generated OpenAPI reference)', () => {
    const root = makeTempDir();
    const apiPath = join(root, 'docs/api/api/connectors/providers/get.mdx');
    mkdirSync(join(apiPath, '..'), { recursive: true });
    writeFileSync(apiPath, '# Generated\n');
    const guidePath = join(root, 'docs/guides/real-guide.mdx');
    mkdirSync(join(guidePath, '..'), { recursive: true });
    writeFileSync(guidePath, '# Real guide\n');

    const found = collectMdxFiles(['docs'], root).map((f) => f.slice(root.length + 1));
    expect(found).toEqual(['docs/guides/real-guide.mdx']);
  });

  it('excludes the two compiled changelog files (frozen historical record)', () => {
    const root = makeTempDir();
    for (const p of [
      'docs/changelog.mdx',
      'docs/changelog-archive.mdx',
      'docs/guides/real-guide.mdx',
    ]) {
      const full = join(root, p);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, '# Title\n');
    }
    const found = collectMdxFiles(['docs'], root).map((f) => f.slice(root.length + 1));
    expect(found).toEqual(['docs/guides/real-guide.mdx']);
  });
});

// ---------------------------------------------------------------------------
// The docs scan (DOR-2508): end to end through runVocabGate
//
// These are the mutation-catching tests: if the docs half of runVocabGate is
// ever removed, disabled, or its result silently dropped, the FIRST test
// below fails, because it drives the seeded violation through runVocabGate
// itself (never scanMdx directly). The second proves the wave-scoping
// decision (wave 4 only, not wave 1) survives at the same seam.
// ---------------------------------------------------------------------------

describe('runVocabGate — docs scan wired end to end', () => {
  it('reports a docs violation merged with source violations (fails if the docs scan is ever disabled)', () => {
    const root = makeTempDir();
    const docPath = join(root, 'docs/guides/fixture-guide.mdx');
    mkdirSync(join(docPath, '..'), { recursive: true });
    writeFileSync(docPath, 'Connect a chat integration to your agents.\n');

    const violations = runVocabGate(root, ['apps/client/src'], ['docs']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('docs/guides/fixture-guide.mdx');
    expect(violations[0]?.term).toBe('integration');
  });

  it('scans docs against wave 4 only — a wave-1 "connection" hit in docs prose is not flagged', () => {
    const root = makeTempDir();
    const docPath = join(root, 'docs/guides/fixture-guide.mdx');
    mkdirSync(join(docPath, '..'), { recursive: true });
    writeFileSync(
      docPath,
      'Your connection drops sometimes; that is an ordinary network sentence, not a Connections violation. But this chat integration line should still be caught.\n'
    );

    const violations = runVocabGate(root, ['apps/client/src'], ['docs']);
    expect(violations.map((v) => v.term)).toEqual(['integration']);
  });

  it('applies the real allowlist to docs the same way it does to source', () => {
    const root = makeTempDir();
    // Reuses a real, shipped allowlist path substring so this test proves the
    // SAME allowlist.json — not a fixture copy — is consulted for docs.
    const docPath = join(root, 'docs/integrations/fixture.mdx');
    mkdirSync(join(docPath, '..'), { recursive: true });
    writeFileSync(docPath, 'Build a custom integration adapter on top of DorkOS.\n');

    expect(runVocabGate(root, ['apps/client/src'], ['docs'])).toEqual([]);
  });

  it('finds nothing when the docs root holds no .mdx files', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'docs'), { recursive: true });
    expect(runVocabGate(root, ['apps/client/src'], ['docs'])).toEqual([]);
  });

  it('a NEW "### Connectors" heading in configuration.mdx is still caught, even though the real allowlist covers three other lines in that exact file (DOR-2508, second review round — `contains` scoping)', () => {
    const root = makeTempDir();
    // The real shipped file, byte for byte, plus one mutation: an unrelated
    // "### Connectors" heading nobody reworded or allowlisted. Reusing the
    // real repo-relative path means the real, shipped allowlist.json entries
    // for `'memory.provider'`, `'connectors.rawMcpServers'` and
    // `'runtimes.opencode.provider'` are in play — this is the regression a
    // path-only (no `contains`) version of those entries would have hidden.
    const real = readFileSync(
      join(import.meta.dirname, '../../docs/getting-started/configuration.mdx'),
      'utf8'
    );
    const docPath = join(root, 'docs/getting-started/configuration.mdx');
    mkdirSync(join(docPath, '..'), { recursive: true });
    writeFileSync(docPath, `${real}\n### Connectors\n`);

    const violations = runVocabGate(root, ['apps/client/src'], ['docs']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('connectors');
    expect(violations[0]?.snippet).toBe('### Connectors');
  });

  it('a vocab-allow marker anywhere under docs/ fails the real, end-to-end gate — never suppressed by any allowlist.json entry (DOR-2508, third review round)', () => {
    const root = makeTempDir();
    const docPath = join(root, 'docs/guides/fixture-guide.mdx');
    mkdirSync(join(docPath, '..'), { recursive: true });
    writeFileSync(docPath, '### Ordinary heading {/* vocab-allow: some reason */}\n');

    const violations = runVocabGate(root, ['apps/client/src'], ['docs']);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.term).toBe('vocab-allow');
    expect(violations[0]?.wave).toBe('docs-marker-ban');
  });
});

// ---------------------------------------------------------------------------
// Counterfactual: would the gate have caught the DOR-855 payment strings?
//
// Adversarial review asked this exact question against the pre-fix source at
// origin/main. The honest answer is a split verdict, and both halves are
// pinned here rather than reported once and forgotten:
//
//   - AdapterSetupWizard.tsx's step description used the JSX `cond && 'copy'`
//     idiom — the gate would have MISSED it before the && fix above, and
//     catches it now. This is a real regression-catching improvement.
//   - tunnel-utils.ts and http-client.ts wrote their strings as a bare
//     `return '...'` / `throw new Error('...')`. Neither is a copy-bearing
//     position this script recognizes (no property name, no JSX position to
//     classify against) — see the module doc's "WHAT IT WON'T CATCH" gap.
//     The gate would NOT have caught either one, before or after this
//     review's fixes, and still doesn't. Pinning that here is the honest
//     alternative to letting the gap go unverified.
// ---------------------------------------------------------------------------

describe('counterfactual — would the gate have caught the pre-fix DOR-855 strings?', () => {
  it("YES: AdapterSetupWizard.tsx — the `step === 'test' && '...'` step description", () => {
    const preFix = `
      export function AdapterSetupWizard() {
        return (
          <DialogDescription>
            {step === 'configure' && (currentSetupStep?.description ?? 'Configure the adapter settings.')}
            {step === 'test' && 'Testing connection to the adapter.'}
          </DialogDescription>
        );
      }
    `;
    expect(scanSource('AdapterSetupWizard.tsx', preFix, TERMS)).toHaveLength(1);
  });

  it("NO (known gap): tunnel-utils.ts — friendlyErrorMessage's bare `return` literals", () => {
    const preFix = `
      export function friendlyErrorMessage(raw: string): string {
        if (/timeout|ETIMEDOUT/i.test(raw)) {
          return 'Connection timed out. Check your network.';
        }
        if (/ECONNREFUSED/i.test(raw)) {
          return 'Connection refused. Ensure the server is running.';
        }
        return raw;
      }
    `;
    expect(scanSource('tunnel-utils.ts', preFix, TERMS)).toEqual([]);
  });

  it('NO (known gap): http-client.ts — the `throw new Error(\\`...\\`)` timeout message', () => {
    const preFix = `
      export async function fetchJson(url: string, timeout: number) {
        throw new Error(\`Request timed out after \${timeout / 1000}s — check your network connection\`);
      }
    `;
    expect(scanSource('http-client.ts', preFix, TERMS)).toEqual([]);
  });
});

describe('counterfactual — would the gate have caught the pre-fix DOR-1814 strings?', () => {
  it('YES: RelayEmptyState.tsx — the "Add Integration" button the UI audit found on screen', () => {
    const preFix = `
      export function RelayEmptyState() {
        return (
          <EmptyState
            title="No integrations yet"
            description="Add your first integration to start sending and receiving messages."
          >
            <Button>Add Integration</Button>
          </EmptyState>
        );
      }
    `;
    // title, description and the button's JSX text — three copy positions.
    expect(scanSource('RelayEmptyState.tsx', preFix, WAVE_4_TERMS)).toHaveLength(3);
  });

  it('YES: MarketplaceSidebar.tsx — the plural facet a singular-only ban would have missed', () => {
    const preFix = `<FacetGroup label="Connectors" />`;
    expect(scanSource('MarketplaceSidebar.tsx', preFix, WAVE_4_TERMS)).toHaveLength(1);
  });

  it('NO: the identifiers and import paths the ADR deliberately leaves alone', () => {
    const code = `
      import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
      import { RelayAdapter } from './relay-adapter.js';
      const providers = new Map<string, ConnectorProvider>();
      switch (kind) { case 'adapter': return new RelayAdapter(); }
    `;
    expect(scanSource('connector-registry.ts', code, WAVE_4_TERMS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shipped data files
// ---------------------------------------------------------------------------

describe('the shipped banned-terms.json and allowlist.json', () => {
  it('parses banned-terms.json and includes the Wave 1 "connection" term', () => {
    const terms = loadBannedTerms();
    expect(terms).toContainEqual({ term: 'connection', wave: 'wave-1', issue: 'DOR-855' });
  });

  it('carries the Wave 3 typography terms', () => {
    const terms = loadBannedTerms();
    expect(terms).toContainEqual({ term: '...', wave: 'wave-3', issue: 'DOR-1756' });
    expect(terms).toContainEqual({ term: '&apos;', wave: 'wave-3', issue: 'DOR-1756' });
  });

  it('carries the Wave 4 Connections terms in singular AND plural', () => {
    // Both forms, because the matcher fences a word term with `\b` at each end:
    // banning "adapter" alone leaves "Adapters" rendering on screen, which is
    // exactly the marketplace-facet spelling of the word. A wave that shipped
    // only the singulars would read as enforced and enforce half of itself.
    const terms = loadBannedTerms();
    for (const term of [
      'integration',
      'integrations',
      'connector',
      'connectors',
      'adapter',
      'adapters',
      'provider',
      'providers',
    ]) {
      expect(terms).toContainEqual({ term, wave: 'wave-4', issue: 'DOR-1814' });
    }
  });

  it('parses allowlist.json, and every entry carries a non-empty reason', () => {
    const entries = loadAllowlist();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.path.length).toBeGreaterThan(0);
    }
  });

  it('every shipped entry is scoped to specific terms', () => {
    // `terms` is optional in the type — omitting it exempts a path from EVERY
    // wave, present and future, which is how a gate stops meaning anything. No
    // shipped entry has ever needed that, and DOR-1814 leaned on the scoping
    // hard: connector-capabilities.ts is exempt for "connector" and "adapter"
    // and NOT for "provider", so the one sentence rewritten there cannot come
    // back. Keep it that way — if a new entry genuinely needs every term, say
    // so in its reason and change this test deliberately.
    for (const entry of loadAllowlist()) {
      expect(entry.terms, `${entry.path} allowlists every banned term`).toBeDefined();
      expect(entry.terms?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('the real repo is clean against its own shipped data (regression canary)', () => {
    // Not hermetic by design: this is the one test that intentionally reads
    // the real checkout, so a genuine regression fails CI here rather than
    // only when someone remembers to run the script by hand.
    // Walking three full workspaces (client, site, server) through the real
    // TypeScript parser is genuinely slower than vitest's 5s default,
    // especially on a machine busy with other agents — this failed on CI
    // timing out, not on finding a violation. 20s leaves headroom without
    // masking an actual hang.
    const repoRoot = join(import.meta.dirname, '../..');
    expect(runVocabGate(repoRoot)).toEqual([]);
  }, 20_000);

  it('checks literal API errors and owner-refusal messages in connector management', () => {
    const repoRoot = join(import.meta.dirname, '../..');
    const routePath = join(repoRoot, 'apps/server/src/routes/connector-management.ts');
    const routeSource = readFileSync(routePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      routePath,
      routeSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const apiCopy: string[] = [];

    function staticText(node: ts.Expression | undefined): string | undefined {
      if (node && ts.isStringLiteralLike(node)) return node.text;
      if (node && ts.isTemplateExpression(node)) {
        return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
      }
      return undefined;
    }

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'error') {
        const text = staticText(node.initializer);
        if (text !== undefined) apiCopy.push(text);
      }
      if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'sendOwnerRefusal') {
        const text = staticText(node.arguments[2]);
        if (text !== undefined) apiCopy.push(text);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);

    const copySource = apiCopy
      .map((text, index) => `const apiCopy${index} = { message: ${JSON.stringify(text)} };`)
      .join('\n');
    expect(apiCopy).toHaveLength(11);
    expect(scanSource(routePath, copySource, loadBannedTerms())).toEqual([]);
  });

  it('every allowlist entry path resolves to a real file or directory', () => {
    // A rename or deletion that leaves a stale allowlist entry behind is not
    // dangerous (it just suppresses nothing, silently), but it IS the kind of
    // drift that makes the audit trail this file exists to be untrustworthy —
    // a path nobody can find on disk anymore. Catch it here rather than
    // during the next unrelated sweep.
    const repoRoot = join(import.meta.dirname, '../..');
    const entries = loadAllowlist();
    for (const entry of entries) {
      expect(existsSync(join(repoRoot, entry.path)), `${entry.path} does not exist`).toBe(true);
    }
  });
});
