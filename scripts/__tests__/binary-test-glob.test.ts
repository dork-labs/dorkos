/**
 * `pnpm verify` leaves the real-CLI suites (`*.binary.test.ts`) to CI (DOR-4501).
 *
 * Those suites spawn whichever Codex, Claude or OpenCode binary the host has
 * installed, so a local pass or fail says nothing about the branch. The globs
 * live in one data file, `scripts/ci/binary-test-glob.txt`; the verify wrapper
 * passes each one to vitest as `--exclude`. This test holds that file to the
 * excludes CI's shards use, so the local gate can skip exactly what CI runs
 * somewhere else, and nothing more.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBinaryTestGlobs } from '../verify-proof/cli.ts';

const root = path.resolve(import.meta.dirname, '../..');
const globs = readBinaryTestGlobs(root);
const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');

/**
 * Every shard line in test.yml that runs vitest through turbo. The test-binary
 * job's turbo line is not a shard: it runs the binary suites, so it has no
 * exclude to match.
 */
const shardLines = workflow
  .split('\n')
  .filter((line) => /pnpm exec turbo test\b/.test(line) && /--shard=/.test(line));

describe('the binary-test glob file', () => {
  it('lists at least one glob, each matching at least one tracked binary suite', () => {
    expect(globs.length).toBeGreaterThan(0);
    const tracked = execFileSync('git', ['ls-files', '--', '*.binary.test.ts'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    for (const glob of globs) {
      expect(glob).toMatch(/\.binary\.test\.ts$/);
      expect(tracked.some((file) => path.matchesGlob(file, glob))).toBe(true);
    }
  });

  it('equals the binary-test excludes on every turbo test line in test.yml', () => {
    // Two on main today: the queue sweep and the PR leg.
    expect(shardLines.length).toBeGreaterThanOrEqual(2);
    for (const line of shardLines) {
      const excludes = [...line.matchAll(/--exclude='([^']+)'/g)]
        .map((match) => match[1] ?? '')
        .filter((glob) => glob.includes('.binary.test.ts'));
      expect(excludes).toEqual(globs);
    }
  });

  it('reaches vitest: the excludes the wrapper appends land after the test step', () => {
    // pnpm appends `pnpm run verify:checks <args>` to the END of the script, so
    // the test step must stay last for the excludes to reach every package.
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['verify:checks']).toMatch(/&& [^&]*turbo run test [^&]*-- --run$/);
  });
});
