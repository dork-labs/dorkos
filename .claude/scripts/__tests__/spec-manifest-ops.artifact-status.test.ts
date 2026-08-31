/**
 * Tests for getHighestArtifact()'s artifact-name allow-list (DOR-818).
 *
 * A `04-*` file used to always mean "implemented" (ARTIFACT_TO_STATUS[4]),
 * but the visual-companion skill's `04-design-decisions.md` convention writes
 * that number long before a spec is built, so a freshly designed spec got
 * auto-promoted to "implemented" the moment that file landed. The fix
 * inverted the check into an allow-list: a file only counts if its exact
 * name is a KNOWN status-bearing artifact, so an unrecognized `0N-*` name —
 * not just the one this bug was filed for — is a no-op rather than a guess.
 *
 * Driven through `audit --json` against orphan directories (no manifest
 * entry needed), the same way the sibling suites in this directory drive
 * behavior through the CLI rather than importing internals.
 *
 * Run directly:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/__tests__/spec-manifest-ops.artifact-status.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec-manifest-ops.ts');

interface OrphanFinding {
  type: string;
  slug: string;
  expected: string;
}

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'spec-manifest-artifact-status-'));
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(
    join(root, 'specs', 'manifest.json'),
    JSON.stringify({ version: 1, specs: [] }, null, 2) + '\n'
  );
  return root;
}

function auditOrphans(root: string): OrphanFinding[] {
  const out = execFileSync(
    'node',
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      SCRIPT,
      'audit',
      '--json',
    ],
    { cwd: root, encoding: 'utf-8' }
  );
  const findings = JSON.parse(out) as OrphanFinding[];
  return findings.filter((f) => f.type === 'orphan');
}

test('a spec dir with only 04-design-decisions.md is NOT promoted to implemented', () => {
  const root = sandbox();
  try {
    const dir = join(root, 'specs', 'freshly-designed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '04-design-decisions.md'), '# Design decisions\n');

    const orphans = auditOrphans(root);
    const found = orphans.find((f) => f.slug === 'freshly-designed');
    assert.ok(found, 'the directory is picked up as an orphan');
    assert.equal(
      found?.expected,
      'ideation',
      'no known artifact matched, so it falls back to ideation'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a spec dir with 04-implementation.md IS promoted to implemented', () => {
  const root = sandbox();
  try {
    const dir = join(root, 'specs', 'actually-built');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '04-implementation.md'), '# Implementation\n');

    const orphans = auditOrphans(root);
    const found = orphans.find((f) => f.slug === 'actually-built');
    assert.ok(found, 'the directory is picked up as an orphan');
    assert.equal(found?.expected, 'implemented', 'a known implementation artifact promotes status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unrecognized 04-* name fails closed, same as the design-decisions case', () => {
  const root = sandbox();
  try {
    const dir = join(root, 'specs', 'unknown-convention');
    mkdirSync(dir, { recursive: true });
    // Not a name this script has ever seen — the allow-list's whole point is
    // that a NEW convention it doesn't recognize does not silently promote
    // status either, not just the one case this bug was filed for.
    writeFileSync(join(dir, '04-retrospective.md'), '# Retrospective\n');

    const orphans = auditOrphans(root);
    const found = orphans.find((f) => f.slug === 'unknown-convention');
    assert.ok(found, 'the directory is picked up as an orphan');
    assert.equal(
      found?.expected,
      'ideation',
      'an unrecognized artifact name is a no-op, not a guess'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('05-bootstrap.md and 05-feedback.md still promote to implemented (post-implementation artifacts)', () => {
  for (const name of ['05-bootstrap.md', '05-feedback.md']) {
    const root = sandbox();
    try {
      const dir = join(root, 'specs', 'post-implementation-spec');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), '# Post-implementation\n');

      const orphans = auditOrphans(root);
      const found = orphans.find((f) => f.slug === 'post-implementation-spec');
      assert.ok(found, `${name}: the directory is picked up as an orphan`);
      assert.equal(
        found?.expected,
        'implemented',
        `${name} is a known post-implementation artifact`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
