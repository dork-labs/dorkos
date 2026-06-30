/**
 * Tests for the `archive` subcommand of spec-manifest-ops.ts.
 *
 * This script is a standalone Node tool (run via `node --experimental-strip-types`),
 * not part of any pnpm/Turborepo workspace, so it is tested with Node's built-in
 * test runner rather than Vitest. Run it directly:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/__tests__/spec-manifest-ops.archive.test.ts
 *
 * Each test builds a throwaway `specs/` tree in the OS temp dir (which is NOT a
 * git repo, so the script's findProjectRoot() falls back to process.cwd()) and
 * drives the real CLI against it via execFileSync with cwd set to that temp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec-manifest-ops.ts');

interface SpecEntry {
  number: number;
  slug: string;
  title: string;
  created: string;
  status: string;
  project?: string;
}

interface Manifest {
  version: number;
  nextNumber: number;
  specs: SpecEntry[];
}

/** Build a temp `specs/` tree with the given manifest + on-disk spec dirs. */
function makeSandbox(manifest: Manifest, specDirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'spec-manifest-ops-'));
  const specsDir = join(root, 'specs');
  mkdirSync(specsDir, { recursive: true });
  writeFileSync(join(specsDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const slug of specDirs) {
    mkdirSync(join(specsDir, slug), { recursive: true });
    writeFileSync(join(specsDir, slug, '01-ideation.md'), `# ${slug}\n`);
  }
  return root;
}

/** Run the CLI inside the sandbox; returns stdout. Throws on non-zero exit. */
function runCli(root: string, args: string[]): string {
  return execFileSync(
    'node',
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SCRIPT, ...args],
    { cwd: root, encoding: 'utf-8' }
  );
}

function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, 'specs', 'manifest.json'), 'utf-8'));
}

test('archive moves the spec dir into specs/archive/ and drops the manifest entry', () => {
  const root = makeSandbox(
    {
      version: 1,
      nextNumber: 11,
      specs: [
        {
          number: 10,
          slug: 'keep-me',
          title: 'Keep Me',
          created: '2026-01-01',
          status: 'implemented',
        },
        {
          number: 9,
          slug: 'old-spec',
          title: 'Old Spec',
          created: '2026-01-01',
          status: 'implemented',
        },
      ],
    },
    ['keep-me', 'old-spec']
  );
  try {
    const out = runCli(root, ['archive', 'old-spec']);
    assert.match(out, /Archived spec #9 old-spec/);

    // Directory was moved, not copied.
    assert.ok(!existsSync(join(root, 'specs', 'old-spec')), 'source dir should be gone');
    assert.ok(
      existsSync(join(root, 'specs', 'archive', 'old-spec', '01-ideation.md')),
      'spec should be under specs/archive/'
    );

    // Manifest entry dropped; the other spec is untouched.
    const m = readManifest(root);
    assert.equal(m.specs.length, 1);
    assert.equal(m.specs[0].slug, 'keep-me');
    assert.ok(!m.specs.some((s) => s.slug === 'old-spec'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive leaves nextNumber untouched (no number reuse)', () => {
  const root = makeSandbox(
    {
      version: 1,
      nextNumber: 42,
      specs: [
        { number: 41, slug: 'gone', title: 'Gone', created: '2026-01-01', status: 'superseded' },
      ],
    },
    ['gone']
  );
  try {
    runCli(root, ['archive', 'gone']);
    assert.equal(readManifest(root).nextNumber, 42, 'nextNumber must not be decremented');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive refuses to overwrite an existing specs/archive/<slug>/', () => {
  const root = makeSandbox(
    {
      version: 1,
      nextNumber: 6,
      specs: [
        { number: 5, slug: 'dup', title: 'Dup', created: '2026-01-01', status: 'implemented' },
      ],
    },
    ['dup']
  );
  // Pre-create the collision target.
  mkdirSync(join(root, 'specs', 'archive', 'dup'), { recursive: true });
  try {
    assert.throws(() => runCli(root, ['archive', 'dup']), /already exists/);
    // Nothing was mutated: source dir and manifest entry both remain.
    assert.ok(existsSync(join(root, 'specs', 'dup')));
    assert.equal(readManifest(root).specs.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive errors when the spec exists nowhere', () => {
  const root = makeSandbox({ version: 1, nextNumber: 2, specs: [] }, []);
  try {
    assert.throws(() => runCli(root, ['archive', 'ghost']), /no manifest entry and no/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit ignores the specs/archive/ directory (not treated as an orphan spec)', () => {
  const root = makeSandbox(
    {
      version: 1,
      nextNumber: 8,
      specs: [
        { number: 7, slug: 'live', title: 'Live', created: '2026-01-01', status: 'ideation' },
      ],
    },
    ['live']
  );
  // Put an archived spec on disk; it must NOT show up as an orphan.
  mkdirSync(join(root, 'specs', 'archive', 'retired'), { recursive: true });
  writeFileSync(join(root, 'specs', 'archive', 'retired', '01-ideation.md'), '# retired\n');
  try {
    const out = runCli(root, ['audit', '--json']);
    const findings = JSON.parse(out) as Array<{ slug: string; type: string }>;
    assert.ok(
      !findings.some((f) => f.slug === 'archive' || f.slug === 'retired'),
      'archive dir and its contents must not appear in audit findings'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
