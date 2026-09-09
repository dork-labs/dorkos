/**
 * The smoke runner, driven end to end through `run.sh` against a fake binary.
 *
 * Split out of `harness-smoke.test.ts` because these cases each spawn a real
 * subprocess and its unit half does not: this file is the slow, high-fidelity
 * leg (the shell wrapper, the argument parsing, the curated child environment,
 * the exit code, the report on disk), and the other is the fast one. Both run in
 * `pnpm verify`, and neither reaches a model.
 *
 * The binary under `--binary` is `harness-smoke/fake-harness.ts`, which
 * discovers the fixture through each harness's own documented read paths rather
 * than being told the answers — so a projection in the wrong shape makes it fail
 * exactly as a real binary would. Each scenario bends ONE behaviour, and each
 * one is a defect a real harness could plausibly have.
 *
 * Nothing here sets a real key: `FAKE_KEY` reaches nothing, and every case that
 * arms the gate also passes `--binary`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_SMOKE_OPT_IN_VAR, smokeHarnessFor } from '../harness-smoke/harnesses.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A key that reaches nothing: every test that uses one also passes `--binary`. */
const FAKE_KEY = 'not-a-real-key-fake-binary-only';

// ─────────────────────────────────────────────────────────────────────────────
// End to end, against the fake binary
// ─────────────────────────────────────────────────────────────────────────────

/** Write a shell wrapper that stands in for a harness binary under one scenario. */
function fakeBinary(dir: string, scenario: string): string {
  const path = join(dir, `fake-${scenario}`);
  writeFileSync(
    path,
    `#!/bin/sh\nexec "${join(REPO_ROOT, 'node_modules/.bin/tsx')}" ` +
      `"${join(REPO_ROOT, 'scripts/harness-smoke/fake-harness.ts')}" --scenario ${scenario} "$@"\n`
  );
  chmodSync(path, 0o755);
  return path;
}

/** Run `run.sh` against a fake binary and hand back its output, exit code and report. */
function runSmokeE2e(
  harnessId: string,
  scenario: string,
  extra: readonly string[] = []
): { stdout: string; code: number; report: string } {
  const dir = mkdtempSync(join(tmpdir(), `smoke-e2e-${scenario}-`));
  const reports = join(dir, 'reports');
  mkdirSync(reports, { recursive: true });
  const harness = smokeHarnessFor(harnessId);
  if (!harness) throw new Error(`no such harness ${harnessId}`);
  let stdout: string;
  let code = 0;
  try {
    stdout = execFileSync(
      'bash',
      [
        join(REPO_ROOT, 'scripts/harness-smoke/run.sh'),
        harnessId,
        '--binary',
        fakeBinary(dir, scenario),
        '--report',
        reports,
        ...extra,
      ],
      {
        encoding: 'utf8',
        env: {
          // eslint-disable-next-line no-restricted-syntax -- a child process needs a PATH; there is no app config equivalent.
          PATH: process.env.PATH ?? '',
          [HARNESS_SMOKE_OPT_IN_VAR]: '1',
          [harness.keyVar]: FAKE_KEY,
        },
      }
    );
  } catch (error) {
    const failure = error as { stdout?: string; status?: number };
    stdout = failure.stdout ?? '';
    code = failure.status ?? 1;
  }
  const written = execFileSync('ls', [reports], { encoding: 'utf8' }).trim().split('\n');
  const report = readFileSync(join(reports, written[0] as string), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { stdout, code, report };
}

describe('end to end, against the fake harness', () => {
  it('passes every oracle on a healthy tree, and prints a cost line', () => {
    const run = runSmokeE2e('claude', 'ok', ['--max-usd', '0.10']);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain('FAIL');
    expect(run.stdout).toContain('Cost: 0.0031 USD (ceiling 0.1 USD)');
    expect(run.report).toContain('**Status:** PASSED');
  }, 60_000);

  it('fails, and names the row, when the harness lists nothing', () => {
    // The fake discovers its listing by walking the projected tree, so this
    // scenario is "the harness never opened the directory" rather than "the
    // fixture was empty" — which is the defect a real harness would have.
    const run = runSmokeE2e('claude', 'no-listing');
    expect(run.code).toBe(1);
    expect(run.report).toContain('**FAIL** `listing-1`');
    expect(run.report).toContain('SK-01');
  }, 60_000);

  it('fails when the projected hook never fires', () => {
    const run = runSmokeE2e('claude', 'no-hooks');
    expect(run.code).toBe(1);
    expect(run.report).toContain('**FAIL** `activation-hook-2`');
    expect(run.report).toContain('HK-06');
  }, 60_000);

  it('fails when the skill was listed but never injected', () => {
    // The whole reason the sentinel was demoted: this run's listing is perfect
    // and its answer carries the passphrase, and it still fails.
    const run = runSmokeE2e('claude', 'no-skill');
    expect(run.code).toBe(1);
    expect(run.report).toContain('**FAIL** `activation-skill`');
    expect(run.report).toContain('**PASS** `listing-1`');
  }, 60_000);

  it('fails a turn a stored sign-in served, however healthy everything else looks', () => {
    const run = runSmokeE2e('claude', 'ambient-credential');
    expect(run.code).toBe(1);
    expect(run.report).toContain('**FAIL** `credential`');
  }, 60_000);

  it('fails a turn that breached the ceiling', () => {
    const run = runSmokeE2e('claude', 'over-budget', ['--max-usd', '0.10']);
    expect(run.code).toBe(1);
    expect(run.report).toContain('**FAIL** `ceiling`');
    expect(run.stdout).toContain('Cost: 99.0000 USD (ceiling 0.1 USD)');
  }, 60_000);

  it('does not fail on an absent sentinel alone', () => {
    const run = runSmokeE2e('claude', 'no-sentinel');
    expect(run.code).toBe(0);
    expect(run.report).toContain('**FINDING** `sentinel`');
  }, 60_000);

  it('drives Codex through its free non-model listing surface', () => {
    const run = runSmokeE2e('codex', 'ok');
    expect(run.code).toBe(0);
    expect(run.report).toContain('`codex debug prompt-input`');
    expect(run.report).toContain('**PASS** `listing-2`');
  }, 60_000);

  it('writes a SKIP report and exits 0 when nothing armed it', () => {
    // The gate refusing is the gate working, and the exit code has to say so or
    // an operator's nightly loop would report a failure every night.
    const dir = mkdtempSync(join(tmpdir(), 'smoke-e2e-skip-'));
    const stdout = execFileSync(
      'bash',
      [join(REPO_ROOT, 'scripts/harness-smoke/run.sh'), 'claude', '--report', dir],
      {
        encoding: 'utf8',
        // The dangerous square again, this time end to end: a key in the
        // environment and no flag.
        // eslint-disable-next-line no-restricted-syntax -- a child process needs a PATH; there is no app config equivalent.
        env: { PATH: process.env.PATH ?? '', ANTHROPIC_API_KEY: FAKE_KEY },
      }
    );
    expect(stdout).toContain('SKIPPED (no-opt-in)');
    expect(stdout).toContain('Cost: nothing');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
