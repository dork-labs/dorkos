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

  it('skips when the flag is present but says something other than 1', () => {
    // THE MUTATION THAT SURVIVED. Weakening the module-scope read from
    // `=== '1'` to `!== undefined` left the whole suite green, because every
    // gate case injected `optIn` directly and never crossed the real read. This
    // one crosses it: `DORKOS_HARNESS_SMOKE=0` is a person saying no.
    const dir = mkdtempSync(join(tmpdir(), 'smoke-e2e-flag0-'));
    const stdout = execFileSync(
      'bash',
      [
        join(REPO_ROOT, 'scripts/harness-smoke/run.sh'),
        'claude',
        '--binary',
        fakeBinary(dir, 'ok'),
        '--report',
        dir,
      ],
      {
        encoding: 'utf8',
        env: {
          // eslint-disable-next-line no-restricted-syntax -- a child process needs a PATH; there is no app config equivalent.
          PATH: process.env.PATH ?? '',
          [HARNESS_SMOKE_OPT_IN_VAR]: '0',
          ANTHROPIC_API_KEY: FAKE_KEY,
        },
      }
    );
    expect(stdout).toContain('SKIPPED (no-opt-in)');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('hands the child an environment with no ambient credential and an empty HOME', () => {
    // `probeEnv` is a pure function, so a test of IT proves what the runner
    // intended to pass. This crosses the real `run.sh` → `spawnSync` boundary:
    // the stand-in binary is a shell wrapper that dumps the environment it was
    // actually handed to a path outside the fixture, then behaves normally.
    const dir = mkdtempSync(join(tmpdir(), 'smoke-e2e-env-'));
    const dumped = join(dir, 'child-env.txt');
    const wrapper = join(dir, 'env-capturing-stand-in');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nenv > "${dumped}"\nexec "${join(REPO_ROOT, 'node_modules/.bin/tsx')}" ` +
        `"${join(REPO_ROOT, 'scripts/harness-smoke/fake-harness.ts')}" --scenario ok "$@"\n`
    );
    chmodSync(wrapper, 0o755);

    execFileSync(
      'bash',
      [
        join(REPO_ROOT, 'scripts/harness-smoke/run.sh'),
        'claude',
        '--binary',
        wrapper,
        '--report',
        join(dir, 'reports'),
      ],
      {
        encoding: 'utf8',
        env: {
          // eslint-disable-next-line no-restricted-syntax -- a child process needs a PATH; there is no app config equivalent.
          PATH: process.env.PATH ?? '',
          [HARNESS_SMOKE_OPT_IN_VAR]: '1',
          ANTHROPIC_API_KEY: FAKE_KEY,
          // Every one of these is a way something on this machine reaches a
          // model or finds the operator's own skills. Not one may survive.
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-should-not-survive',
          OPENAI_API_KEY: 'sk-openai-should-not-survive',
          OPENROUTER_API_KEY: 'sk-or-should-not-survive',
          HOME: '/Users/somebody',
        },
      }
    );

    const childEnv = new Map(
      readFileSync(dumped, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    for (const leaked of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'ANTHROPIC_BASE_URL',
    ]) {
      expect(childEnv.has(leaked), `${leaked} reached the probe`).toBe(false);
    }
    // The one instrument, and only it.
    expect(childEnv.get('ANTHROPIC_API_KEY')).toBe(FAKE_KEY);
    // HOME and the config home are the run's own sandbox, not the operator's:
    // that is what keeps `~/.agents/skills` and `~/.claude/skills` out of the
    // fixture's answer, and it is containment for anything the harness writes.
    expect(childEnv.get('HOME')).not.toBe('/Users/somebody');
    expect(childEnv.get('HOME')).toBe(childEnv.get('CLAUDE_CONFIG_DIR'));
    expect(childEnv.get('HOME')).toMatch(/harness-smoke-claude-/);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('gives a --free run the SAME isolation, with no instrument and a dead base URL', () => {
    // A free run reaches no model, so it needs no flag and no key — but a probe
    // that inherited the operator's home would answer with the operator's skills
    // and report them as the fixture's. Cheap must not mean careless.
    const dir = mkdtempSync(join(tmpdir(), 'smoke-e2e-free-env-'));
    const dumped = join(dir, 'child-env.txt');
    const wrapper = join(dir, 'env-capturing-stand-in');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nenv > "${dumped}"\nexec "${join(REPO_ROOT, 'node_modules/.bin/tsx')}" ` +
        `"${join(REPO_ROOT, 'scripts/harness-smoke/fake-harness.ts')}" --scenario ok "$@"\n`
    );
    chmodSync(wrapper, 0o755);

    execFileSync(
      'bash',
      [
        join(REPO_ROOT, 'scripts/harness-smoke/run.sh'),
        'claude',
        '--free',
        '--binary',
        wrapper,
        '--report',
        join(dir, 'reports'),
      ],
      {
        encoding: 'utf8',
        env: {
          // eslint-disable-next-line no-restricted-syntax -- a child process needs a PATH; there is no app config equivalent.
          PATH: process.env.PATH ?? '',
          ANTHROPIC_API_KEY: 'sk-a-real-looking-key-that-must-not-be-used',
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-should-not-survive',
          HOME: '/Users/somebody',
        },
      }
    );

    const childEnv = new Map(
      readFileSync(dumped, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    expect(childEnv.has('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
    expect(childEnv.get('HOME')).toMatch(/harness-smoke-claude-/);
    // A free run never carries a real key, even one sitting in the environment:
    // it substitutes a placeholder, and points the base URL at a dead port so
    // the placeholder could not reach anything even if it were real.
    expect(childEnv.get('ANTHROPIC_API_KEY')).not.toBe(
      'sk-a-real-looking-key-that-must-not-be-used'
    );
    expect(childEnv.get('ANTHROPIC_BASE_URL')).toBe('http://127.0.0.1:1');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('reports a --free run as FREE, and names the oracles it did not reach', () => {
    // A free run answers three oracles and cannot answer the fourth. Reporting
    // it as PASSED would be a directory of files that all look like results.
    const run = runSmokeE2e('claude', 'ok', ['--free']);
    expect(run.code).toBe(0);
    expect(run.report).toContain('**Status:** FREE');
    expect(run.report).toContain('## What this run did NOT answer');
    expect(run.report).toContain('**UNKNOWN** `activation-skill`');
    expect(run.report).toMatch(/NOT RUN/);
    // The hooks and the listing DO answer, which is the whole point.
    expect(run.report).toContain('**PASS** `listing-1`');
    expect(run.report).toContain('**PASS** `activation-hook-2`');
    // No ceiling verdict at all: there is nothing to bound.
    expect(run.report).not.toContain('`ceiling`');
    expect(run.stdout).toContain('Cost: nothing');
  }, 60_000);

  it('refuses --free for a harness that has no free probe, rather than inventing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-e2e-nofree-'));
    const stdout = execFileSync(
      'bash',
      [
        join(REPO_ROOT, 'scripts/harness-smoke/run.sh'),
        'opencode',
        '--free',
        '--binary',
        fakeBinary(dir, 'ok'),
        '--report',
        dir,
      ],
      {
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- a child process needs a PATH; there is no app config equivalent.
        env: { PATH: process.env.PATH ?? '' },
      }
    );
    expect(stdout).toContain('SKIPPED (no-free-probe)');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('names a bad --binary as a bad path, not as a hung harness', () => {
    // `spawnSync` reports a missing binary and a timeout kill the same way, so
    // an unchecked override turned a typo into "killed after 300s".
    const dir = mkdtempSync(join(tmpdir(), 'smoke-e2e-badbin-'));
    const stdout = execFileSync(
      'bash',
      [
        join(REPO_ROOT, 'scripts/harness-smoke/run.sh'),
        'claude',
        '--binary',
        join(dir, 'no-such-binary'),
        '--report',
        dir,
      ],
      {
        encoding: 'utf8',
        env: {
          // eslint-disable-next-line no-restricted-syntax -- a child process needs a PATH; there is no app config equivalent.
          PATH: process.env.PATH ?? '',
          [HARNESS_SMOKE_OPT_IN_VAR]: '1',
          ANTHROPIC_API_KEY: FAKE_KEY,
        },
      }
    );
    expect(stdout).toContain('SKIPPED (no-binary)');
    expect(stdout).toContain('no-such-binary');
    expect(stdout).not.toMatch(/killed after/);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('answers all three of DOR-1924’s questions on a healthy tree, and shows the entries', () => {
    // The deliverable is the ENTRIES, not the verdicts: a report that said
    // "listed 1×" without them would be this runner asking to be believed.
    const run = runSmokeE2e('claude', 'ok', ['--free', '--scenario', 'user-tier']);
    expect(run.code).toBe(0);
    expect(run.report).toContain('**PASS** `user-tier-listed`');
    expect(run.report).toContain('**PASS** `injection-duplicate`');
    expect(run.report).toContain('**PASS** `injection-control`');
    expect(run.report).toContain('**PASS** `agents-user-root`');
    // The raw listing, per round, and the roots the run wrote into.
    expect(run.report).toContain('### The raw listing');
    expect(run.report).toContain('`userpkg__userskill`');
    expect(run.report).toContain('`injpkg:injskill`');
    expect(run.report).toContain('### The roots it wrote');
    // Both rounds ran, and each is its own staging.
    expect(run.report).toContain('## Round `claude-user-root`');
    expect(run.report).toContain('## Round `agents-user-root`');
    // The oracles this scenario cannot reach are named rather than omitted.
    expect(run.report).toContain('## What this run did NOT answer');
  }, 90_000);

  it('reports a second entry as the FINDING that flips §2.9, and still exits 0', () => {
    const run = runSmokeE2e('claude', 'user-tier-twice', ['--free', '--scenario', 'user-tier']);
    expect(run.code).toBe(0);
    expect(run.report).toContain('**FINDING** `injection-duplicate`');
    expect(run.report).toContain('sdkInjected');
  }, 90_000);

  it('fails, naming SRC-04, when the harness never opens its own user skills folder', () => {
    const run = runSmokeE2e('claude', 'user-tier-missing', ['--free', '--scenario', 'user-tier']);
    expect(run.code).toBe(1);
    expect(run.report).toContain('**FAIL** `user-tier-listed`');
    expect(run.report).toContain('SRC-04');
    // And the duplicate question goes UNKNOWN rather than claiming a dedupe it
    // cannot see: with the link route dead, one entry is one route working.
    expect(run.report).toContain('**UNKNOWN** `injection-duplicate`');
  }, 90_000);

  it('reports a Claude Code that DOES read `~/.agents/skills` as the finding that shrinks A3', () => {
    const run = runSmokeE2e('claude', 'agents-root-read', ['--free', '--scenario', 'user-tier']);
    expect(run.code).toBe(0);
    expect(run.report).toContain('**FINDING** `agents-user-root`');
    expect(run.report).toContain('needs no second link of its own');
  }, 90_000);

  it('fails the injection control, and refuses to answer the duplicate, when nothing loaded', () => {
    const run = runSmokeE2e('claude', 'no-injection', ['--free', '--scenario', 'user-tier']);
    expect(run.code).toBe(1);
    expect(run.report).toContain('**FAIL** `injection-control`');
    expect(run.report).toContain('**UNKNOWN** `injection-duplicate`');
  }, 90_000);

  it('reports `$CODEX_HOME/skills` as a FINDING, and still exits 0', () => {
    // THE ONE THE FIRST RUN MISSED. Its raw listing carried five bundled skills
    // out of `<CODEX_HOME>/skills/.system/` and it reported "0 finding", because
    // nothing had asked. A writable directory a harness reads and the compiled
    // facts do not carry is the disagreement this tier exists to produce — and a
    // finding never fails the run.
    const run = runSmokeE2e('codex', 'ok', ['--free', '--scenario', 'user-tier']);
    expect(run.code).toBe(0);
    expect(run.report).toContain('## Round `codex-home-root`');
    expect(run.report).toContain('**FINDING** `codex-home-root`');
    expect(run.report).toContain('`homepkg:homeskill`');
    // It says what may NOT be done about it, which is the point of recording it
    // here rather than editing the facts table on the spot.
    expect(run.report).toContain('may NOT be added without a vendor page');
  }, 90_000);

  it('passes that round when the binary does not read the directory', () => {
    const run = runSmokeE2e('codex', 'user-tier-missing', ['--free', '--scenario', 'user-tier']);
    expect(run.report).toContain('**PASS** `codex-home-root`');
  }, 90_000);

  it('counts the user directories it wrote instead of asserting there were two', () => {
    // The header used to say "the two user directories below" whatever the
    // harness was. Claude Code's rounds write two; a run whose rounds wrote one
    // has to say one.
    const both = runSmokeE2e('claude', 'ok', ['--free', '--scenario', 'user-tier']);
    expect(both.report).toContain('the two user directories below are inside it');
    const one = runSmokeE2e('opencode', 'ok', ['--scenario', 'user-tier', '--max-usd', '0.10']);
    expect(one.report).toContain('the one user directory below is inside it');
  }, 120_000);

  it('asks Codex the shared-directory question, and says the duplicate one does not apply', () => {
    // Not an UNKNOWN that reads like a gap: Codex has no injection route for
    // DorkOS to use, so the question is not applicable rather than unanswered.
    const run = runSmokeE2e('codex', 'ok', ['--free', '--scenario', 'user-tier']);
    expect(run.code).toBe(0);
    expect(run.report).toContain('**PASS** `agents-user-root`');
    expect(run.report).toContain('Not an unknown; not applicable');
    expect(run.report).not.toContain('`injection-duplicate`');
    // Codex reports paths, so the report shows one beside every entry — and the
    // entry itself is the NAMESPACED key a real codex-cli 0.145.0 prints for a
    // package carrying a Claude Code plugin manifest, not the link's directory
    // name and not the bare frontmatter name.
    expect(run.report).toMatch(/`agentspkg:agentsskill` — `\S+\/SKILL\.md`/);
  }, 90_000);

  it('fails Codex’s round when a documented user read path reached nothing', () => {
    const run = runSmokeE2e('codex', 'user-tier-missing', ['--free', '--scenario', 'user-tier']);
    expect(run.code).toBe(1);
    expect(run.report).toContain('**FAIL** `agents-user-root`');
    expect(run.report).toContain('vendor facts contradicted by the binary');
  }, 90_000);

  it('writes the two scenarios to two files, so neither answer overwrites the other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-e2e-both-'));
    const reports = join(dir, 'reports');
    mkdirSync(reports, { recursive: true });
    const binary = fakeBinary(dir, 'ok');
    for (const extra of [[], ['--scenario', 'user-tier']]) {
      execFileSync(
        'bash',
        [
          join(REPO_ROOT, 'scripts/harness-smoke/run.sh'),
          'codex',
          '--free',
          '--binary',
          binary,
          '--report',
          reports,
          ...extra,
        ],
        {
          encoding: 'utf8',
          // eslint-disable-next-line no-restricted-syntax -- a child process needs a PATH; there is no app config equivalent.
          env: { PATH: process.env.PATH ?? '' },
        }
      );
    }
    const written = execFileSync('ls', [reports], { encoding: 'utf8' }).trim().split('\n');
    expect(written).toHaveLength(2);
    expect(written.filter((name) => name.endsWith('-codex-user-tier.md'))).toHaveLength(1);
    expect(written.filter((name) => name.endsWith('-codex.md'))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  }, 90_000);

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
