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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectFiles,
  isAllowlisted,
  loadAllowlist,
  loadBannedTerms,
  runVocabGate,
  scanSource,
  type AllowlistEntry,
  type BannedTerm,
} from '../check-vocab-gate.ts';

const TERMS: BannedTerm[] = [{ term: 'connection', wave: 'wave-1', issue: 'DOR-855' }];

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

  it('catches an object property named like a copy field', () => {
    const violations = scanSource(
      'config.ts',
      `export const CONFIG = { label: 'Connection lost', key: 'connection' };`,
      TERMS
    );
    // Only `label`, not `key` — `key` is not a copy-bearing property name.
    expect(violations).toHaveLength(1);
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
// The shipped data files
// ---------------------------------------------------------------------------

describe('the shipped banned-terms.json and allowlist.json', () => {
  it('parses banned-terms.json and includes the Wave 1 "connection" term', () => {
    const terms = loadBannedTerms();
    expect(terms).toContainEqual({ term: 'connection', wave: 'wave-1', issue: 'DOR-855' });
  });

  it('parses allowlist.json, and every entry carries a non-empty reason', () => {
    const entries = loadAllowlist();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.path.length).toBeGreaterThan(0);
    }
  });

  it('the real repo is clean against its own shipped data (regression canary)', () => {
    // Not hermetic by design: this is the one test that intentionally reads
    // the real checkout, so a genuine regression fails CI here rather than
    // only when someone remembers to run the script by hand.
    const repoRoot = join(import.meta.dirname, '../..');
    expect(runVocabGate(repoRoot)).toEqual([]);
  });
});
