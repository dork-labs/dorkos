/**
 * Round-trip regression test for spec-manifest-ops.ts (DOR-751).
 *
 * Adding one spec used to sometimes rewrite the whole manifest: the file's
 * unicode escaping was not stable across writers (an em dash stored as a
 * literal `—` in some titles and an escaped `—` in others), and the
 * first write to touch the file after that drifted would normalize every
 * title in one shot, producing an ~85-line diff dominated by unrelated
 * churn. All manifest writes funnel through the single `writeManifest`
 * (plain `JSON.stringify`, never escapes unicode), so a write today should
 * touch only the lines the new entry adds — this test operates on the
 * REAL committed specs/manifest.json specifically to catch drift back into
 * that file, not just a synthetic fixture.
 *
 * Run directly:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/__tests__/spec-manifest-ops.roundtrip.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(TEST_DIR, '..', 'spec-manifest-ops.ts');
const REPO_ROOT = join(TEST_DIR, '..', '..', '..');
const REAL_MANIFEST = join(REPO_ROOT, 'specs', 'manifest.json');

function runCli(root: string, args: string[]): string {
  return execFileSync(
    'node',
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SCRIPT, ...args],
    { cwd: root, encoding: 'utf-8' }
  );
}

test("adding one spec through the canonical script touches only that entry's lines", () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-manifest-roundtrip-'));
  try {
    mkdirSync(join(root, 'specs'), { recursive: true });
    const manifestPath = join(root, 'specs', 'manifest.json');
    cpSync(REAL_MANIFEST, manifestPath);
    const before = readFileSync(manifestPath, 'utf-8');
    const beforeLines = before.split('\n');

    runCli(root, ['add', 'dor-751-roundtrip-fixture', 'DOR-751 roundtrip fixture', '--quiet']);

    const after = readFileSync(manifestPath, 'utf-8');
    const afterLines = after.split('\n');

    // `add` unshifts the new entry right after the `"specs": [` line, so
    // everything up to and including that line is untouched header...
    const specsLineIdx = beforeLines.findIndex((l) => l.includes('"specs": ['));
    assert.notEqual(specsLineIdx, -1, 'fixture manifest has a "specs": [ line');
    assert.deepEqual(
      afterLines.slice(0, specsLineIdx + 1),
      beforeLines.slice(0, specsLineIdx + 1),
      'the header above "specs": [ is byte-for-byte unchanged'
    );

    // ...and everything from the first pre-existing entry onward is also
    // byte-for-byte unchanged: the new entry contributes a contiguous block
    // of new lines and nothing else in the file moves.
    const oldTail = beforeLines.slice(specsLineIdx + 1);
    const newTail = afterLines.slice(afterLines.length - oldTail.length);
    assert.deepEqual(
      newTail,
      oldTail,
      'every pre-existing entry is untouched, not just re-serialized identically'
    );

    // Sanity: the new entry actually landed, so this test cannot pass by the
    // tail assertion alone matching an accidental no-op.
    assert.ok(after.includes('dor-751-roundtrip-fixture'), 'the new entry was actually added');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
