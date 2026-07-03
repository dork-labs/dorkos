/**
 * Tests for timestamp-id allocation in spec-manifest-ops.ts (spec #271 / DOR-184).
 *
 * The `add` command no longer reads a shared `nextNumber` counter; it stamps a
 * `YYMMDD-HHMMSS` id from the local clock and never writes `nextNumber`. Legacy
 * numeric entries keep working (mixed listings). Run directly:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/__tests__/spec-manifest-ops.id.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec-manifest-ops.ts');
const TIMESTAMP_ID = /^\d{6}-\d{6}$/;

function sandbox(manifest: object): string {
  const root = mkdtempSync(join(tmpdir(), 'spec-manifest-id-'));
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'specs', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return root;
}
function runCli(root: string, args: string[]): string {
  return execFileSync(
    'node',
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SCRIPT, ...args],
    { cwd: root, encoding: 'utf-8' }
  );
}
function readManifest(root: string): { version: number; nextNumber?: number; specs: Array<{ id?: string; number?: number; slug: string }> } {
  return JSON.parse(readFileSync(join(root, 'specs', 'manifest.json'), 'utf-8'));
}

test('add allocates a timestamp id and writes no nextNumber', () => {
  const root = sandbox({ version: 1, specs: [] });
  try {
    runCli(root, ['add', 'my-feature', 'My Feature', '--quiet']);
    const m = readManifest(root);
    assert.equal(m.specs.length, 1);
    assert.match(m.specs[0].id ?? '', TIMESTAMP_ID, 'entry carries a timestamp id');
    assert.equal(m.specs[0].number, undefined, 'no legacy number on a new entry');
    assert.equal(m.nextNumber, undefined, 'no nextNumber counter is written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two adds get distinct ids even within the same second (local-uniqueness guard)', () => {
  const root = sandbox({ version: 1, specs: [] });
  try {
    runCli(root, ['add', 'alpha', 'Alpha', '--quiet']);
    runCli(root, ['add', 'beta', 'Beta', '--quiet']);
    const ids = readManifest(root).specs.map((s) => s.id);
    assert.equal(new Set(ids).size, 2, 'the second add bumps off the first when the clock matches');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy numeric entries and new id entries coexist and list together', () => {
  const root = sandbox({
    version: 1,
    nextNumber: 300,
    specs: [{ number: 299, slug: 'legacy', title: 'Legacy', created: '2026-01-01', status: 'implemented' }],
  });
  try {
    runCli(root, ['add', 'fresh', 'Fresh', '--quiet']);
    const out = runCli(root, ['list']);
    assert.match(out, /0299/, 'legacy entry shows its zero-padded number');
    assert.match(out, /\bfresh\b/, 'new entry lists too');
    assert.match(out, /\d{6}-\d{6}/, 'new entry shows a timestamp id in the listing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
