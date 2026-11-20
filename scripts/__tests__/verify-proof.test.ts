import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readBinaryTestGlobs,
  runVerification,
  TURBO_RUNS,
  type VerificationOptions,
} from '../verify-proof/cli.ts';
import { planPreopen, runPreopen, type PreopenStep } from '../verify-proof/preopen.ts';
import { TURBO_SUMMARY_READ_AGAINST, watchTurboRuns } from '../verify-proof/turbo-runs.ts';

const script = path.resolve(import.meta.dirname, '../verify-proof/cli.ts');
let repo: string;
let sha: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
const check = (...args: string[]) =>
  spawnSync(process.execPath, [script, 'check', sha, ...args], { cwd: repo, encoding: 'utf8' });
const refusal = () =>
  `no pnpm verify pass recorded for ${sha.slice(0, 12)}; run pnpm verify, or pass --no-verify-proof\n`;

/** Where turbo writes its run summaries in the fixture repository. */
const turboRuns = () => path.join(repo, '.turbo/runs');

/**
 * A run summary the way `turbo run --summarize` writes it, with made-up values. Only
 * `execution` is read; these defaults are a run where every task finished.
 */
const runSummary = (execution: Record<string, number> = {}) =>
  JSON.stringify({
    id: '2fYw4fJ0example0run0summary0',
    version: '1',
    turboVersion: '2.10.13',
    execution: {
      command: 'turbo run test --affected',
      repoPath: '',
      success: 2,
      failed: 0,
      cached: 1,
      attempted: 3,
      startTime: 1_763_600_000_000,
      endTime: 1_763_600_042_000,
      exitCode: 0,
      ...execution,
    },
    tasks: [],
  });

/**
 * Put a fake `pnpm` first on the fixture's PATH. Its body may call `write_runs <n>`,
 * which writes n turbo run summaries holding `$PROOF_TEST_SUMMARY`, the way each
 * `turbo run --summarize` step does.
 */
function installFakePnpm(body: string): void {
  const bin = path.join(repo, '.git/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, 'pnpm'),
    [
      '#!/bin/sh',
      'write_runs() {',
      '  mkdir -p .turbo/runs; i=0',
      '  while [ "$i" -lt "$1" ]; do',
      '    i=$((i + 1)); runs=$((${runs:-0} + 1))',
      `    printf '%s\\n' "$PROOF_TEST_SUMMARY" > ".turbo/runs/run-$$-$runs.json"`,
      '  done',
      '}',
      body,
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  // The real repository ignores .turbo/, so turbo's summaries never dirty its tree.
  mkdirSync(path.join(repo, '.git/info'), { recursive: true });
  appendFileSync(path.join(repo, '.git/info/exclude'), '.turbo/\n');
}

/** A CLI run's environment: the fake pnpm first on PATH, and a finished run summary. */
const cliEnv = (extra: Record<string, string> = {}) => ({
  // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
  ...process.env,
  // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; the fake pnpm must come first on PATH
  PATH: `${path.join(repo, '.git/bin')}:${process.env.PATH}`,
  PROOF_TEST_SUMMARY: runSummary(),
  ...extra,
});

/** Run a gate (`run` or `run-preopen`) through the CLI in the fixture repository, to completion. */
const runGate = (command: string, extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, command], {
    cwd: repo,
    encoding: 'utf8',
    env: cliEnv(extra),
  });

/**
 * Record a run the way a finished gate does: with the number of turbo run summaries
 * its completion check judged, which is what a check accepts.
 */
const verified = (
  verify: (excluded: readonly string[]) => number | Promise<number>,
  excluded: readonly string[] = [],
  options: VerificationOptions = {}
) =>
  runVerification(repo, verify, excluded, {
    turboRuns: TURBO_RUNS[options.level ?? 'full'],
    ...options,
  });

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'verify-proof-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test Founder');
  git('config', 'user.email', 'founder@example.test');
  writeFileSync(path.join(repo, 'example.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  sha = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('verification proof', () => {
  it('wires pnpm verify through the wrapper without changing the checks', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
    );
    expect(pkg.scripts.verify).toBe('node scripts/verify-proof/cli.ts run');
    expect(pkg.scripts['verify:checks']).toContain('pnpm test:scripts && pnpm lint:root');
  });

  it('runs the checks exactly once through the CLI and preserves a failed exit', () => {
    installFakePnpm('echo "$*" >> .git/gate-runs\nwrite_runs 2\nexit "${PROOF_TEST_EXIT:-0}"');
    const run = (status: string) => runGate('run', { PROOF_TEST_EXIT: status });
    // The host-binary suites are left to CI: every glob in the data file rides as an exclude.
    const globs = readBinaryTestGlobs(path.resolve(import.meta.dirname, '../..'));
    const gateRun = `run verify:checks ${globs.map((glob) => `--exclude=${glob}`).join(' ')}\n`;
    expect(run('0').status).toBe(0);
    expect(check().status).toBe(0);
    expect(readFileSync(path.join(repo, '.git/gate-runs'), 'utf8')).toBe(gateRun);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof.excluded).toEqual(globs);
    // The summaries it judged are turbo's to write and the gate's to clear once they pass.
    expect(readdirSync(turboRuns())).toEqual([]);
    expect(run('8').status).toBe(8);
    expect(check().status).toBe(1);
    expect(readFileSync(path.join(repo, '.git/gate-runs'), 'utf8')).toBe(gateRun + gateRun);
  });

  it('records exactly the excludes it handed to the checks', async () => {
    const excluded = ['**/fixture/**/*.binary.test.ts', '**/other/*.binary.test.ts'];
    let seen: readonly string[] | undefined;
    expect(
      await verified((globs) => {
        seen = globs;
        return 0;
      }, excluded)
    ).toBe(0);
    expect(seen).toEqual(excluded);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof).toEqual({
      sha,
      tree: git('rev-parse', `${sha}^{tree}`),
      level: 'full',
      excluded,
      finished: true,
      turboRuns: 2,
      passedAt: expect.any(String),
    });
    expect(check().status).toBe(0);
  });

  it('records an empty exclusion list when nothing was left out', async () => {
    expect(await verified(() => 0)).toBe(0);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof.excluded).toEqual([]);
  });

  // Proofs from before DOR-4616 are refused whatever else they hold (see isPass), so
  // the older shapes that used to stay valid no longer do.
  it.each([
    ['no exclusion list (before DOR-4501)', 'excluded'],
    ['no finished marker (before DOR-4616)', 'finished'],
    ['no turbo run count (before DOR-4616)', 'turboRuns'],
  ])('refuses a full proof with %s', async (_label, field) => {
    expect(await verified(() => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const { [field]: _dropped, ...older } = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, JSON.stringify(older));
    expect(check().status).toBe(1);
    // A proof with no marker at all gets its own line; the lone-copy test pins its words.
    expect(check().stderr).toMatch(
      field === 'finished' ? /was recorded before DOR-4616 and cannot arm/ : /^no pnpm verify pass/
    );
  });

  it.each([
    ['finished: false', { finished: false }],
    ['finished as a string', { finished: 'true' }],
    ['one turbo run where the full gate makes two', { turboRuns: 1 }],
    ['a turbo run count that is not a number', { turboRuns: '2' }],
  ])('refuses a full proof that says %s', async (_label, fields) => {
    expect(await verified(() => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    writeFileSync(proof, JSON.stringify({ ...JSON.parse(readFileSync(proof, 'utf8')), ...fields }));
    expect(check().status).toBe(1);
  });

  it('records a proof no check accepts when no completion check judged the run', async () => {
    // runVerification on its own judged no turbo summaries, so its proof says 0.
    expect(await runVerification(repo, () => 0)).toBe(0);
    const proof = JSON.parse(
      readFileSync(path.join(repo, '.git/dorkos-verify-proof', sha), 'utf8')
    );
    expect(proof.turboRuns).toBe(0);
    expect(check().status).toBe(1);
  });

  it('reads globs one per line, skipping blank lines and comments', () => {
    mkdirSync(path.join(repo, 'scripts/ci'), { recursive: true });
    writeFileSync(
      path.join(repo, 'scripts/ci/binary-test-glob.txt'),
      '# why these are left to CI\n\n  **/a/*.binary.test.ts  \n**/b/*.binary.test.ts\n'
    );
    expect(readBinaryTestGlobs(repo)).toEqual(['**/a/*.binary.test.ts', '**/b/*.binary.test.ts']);
  });

  it('refuses extra arguments to run before any check starts', () => {
    const result = spawnSync(process.execPath, [script, 'run', '--force'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^pnpm verify takes no arguments \(got: --force\);/);
    expect(existsSync(path.join(repo, '.git/dorkos-verify-proof'))).toBe(false);
  });

  it('refuses a missing record with exactly one actionable line', () => {
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
    expect(result.stdout).toBe('');
  });

  it('refuses a record for another tree', async () => {
    expect(await verified(() => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const record = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, JSON.stringify({ ...record, tree: '0'.repeat(40) }));
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('allows a matching record and shares it with another worktree', async () => {
    expect(await verified(() => 0)).toBe(0);
    expect(check().status).toBe(0);
    const sibling = path.join(repo, 'sibling');
    git('worktree', 'add', '--detach', sibling, sha);
    writeFileSync(path.join(sibling, 'other-work.txt'), 'unrelated work');
    const result = spawnSync(process.execPath, [script, 'check', sha], {
      cwd: sibling,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('allows the explicit escape and logs who, when, the full SHA, and its tree', () => {
    const escaped = spawnSync(process.execPath, [script, 'check', sha, '--no-verify-proof'], {
      cwd: repo,
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
      env: { ...process.env, USER: 'test-operator' },
    });
    expect(escaped.status).toBe(0);
    const log = readFileSync(path.join(repo, '.git/dorkos-verify-proof/escapes.jsonl'), 'utf8');
    const record = JSON.parse(log.trim());
    expect(record).toEqual({
      sha,
      tree: git('rev-parse', `${sha}^{tree}`),
      who: 'Test Founder',
      user: 'test-operator',
      when: expect.any(String),
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(record.when))).toBe(false);
    expect(check().status).toBe(1);
  });

  it('refuses the escape when the git user is unknown, and logs nothing', () => {
    git('config', '--unset', 'user.name');
    const result = spawnSync(process.execPath, [script, 'check', sha, '--no-verify-proof'], {
      cwd: repo,
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; child processes inherit PATH and git config
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
    expect(existsSync(path.join(repo, '.git/dorkos-verify-proof/escapes.jsonl'))).toBe(false);
  });

  it.each([
    ['corrupt JSON', '{"sha":'],
    ['a JSON null', 'null'],
    ['an empty file', ''],
    [
      'an unparseable pass time',
      (record: object) => JSON.stringify({ ...record, passedAt: 'soon' }),
    ],
    ['another commit', (record: object) => JSON.stringify({ ...record, sha: 'f'.repeat(40) })],
    [
      'an exclusion list that is not a list of globs',
      (record: object) => JSON.stringify({ ...record, excluded: '**/*.binary.test.ts' }),
    ],
  ])('refuses a proof file holding %s', async (_label, contents) => {
    expect(await verified(() => 0)).toBe(0);
    const proof = path.join(repo, '.git/dorkos-verify-proof', sha);
    const record = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, typeof contents === 'string' ? contents : contents(record));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(refusal());
  });

  it('refuses a proof path it cannot read as a file', () => {
    mkdirSync(path.join(repo, '.git/dorkos-verify-proof', sha), { recursive: true });
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('refuses a ref that is not a commit', () => {
    sha = 'not-a-ref';
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });

  it('judges valid proof the same from a checkout with unrelated edits', async () => {
    expect(await verified(() => 0)).toBe(0);
    // The arm script checks from the main checkout, which carries other people's edits.
    writeFileSync(path.join(repo, 'example.txt'), 'someone else is mid-edit');
    writeFileSync(path.join(repo, 'scratch.txt'), 'untracked');
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('records nothing for a dirty starting tree even if checks clean it', async () => {
    writeFileSync(path.join(repo, 'example.txt'), 'dirty');
    expect(
      await verified(() => {
        writeFileSync(path.join(repo, 'example.txt'), 'original');
        return 0;
      })
    ).toBe(0);
    expect(check().status).toBe(1);
  });

  it('records nothing if files change during checks', async () => {
    expect(
      await verified(() => {
        writeFileSync(path.join(repo, 'example.txt'), 'changed');
        return 0;
      })
    ).toBe(0);
    writeFileSync(path.join(repo, 'example.txt'), 'original');
    expect(check().status).toBe(1);
  });

  it('records nothing if HEAD changes during checks', async () => {
    expect(
      await verified(() => {
        git('commit', '--allow-empty', '-qm', 'new head');
        return 0;
      })
    ).toBe(0);
    expect(check().status).toBe(1);
    sha = git('rev-parse', 'HEAD');
    expect(check().status).toBe(1);
  });

  it('preserves failure and invalidates an older pass', async () => {
    expect(await verified(() => 0)).toBe(0);
    expect(await verified(() => 7)).toBe(7);
    expect(check().status).toBe(1);
  });

  it('records no proof for untracked source and invalidates the older pass', async () => {
    await verified(() => 0);
    writeFileSync(path.join(repo, 'untracked.txt'), 'new source');
    expect(await verified(() => 0)).toBe(0);
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
  });
});

const proofs = () => path.join(repo, '.git/dorkos-verify-proof');
const preopenRefusal = () =>
  `no pnpm verify:preopen or pnpm verify pass recorded for ${sha.slice(0, 12)}; ` +
  'run pnpm verify:preopen, or pass --no-verify-proof\n';

describe('the preopen level (DOR-4728)', () => {
  it('wires pnpm verify:preopen to the same wrapper, with its own command', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
    );
    expect(pkg.scripts.verify).toBe('node scripts/verify-proof/cli.ts run');
    expect(pkg.scripts['verify:preopen']).toBe('node scripts/verify-proof/cli.ts run-preopen');
    expect(pkg.scripts['verify:preopen:turbo']).toContain('turbo run typecheck lint --affected');
    expect(pkg.scripts['verify:preopen:turbo']).not.toMatch(/turbo run test\b/);
  });

  it('records a preopen pass in its own file, which the default check never accepts', async () => {
    expect(await verified(() => 0, [], { level: 'preopen' })).toBe(0);
    expect(existsSync(path.join(proofs(), sha))).toBe(false);
    const proof = JSON.parse(readFileSync(path.join(proofs(), `${sha}.preopen`), 'utf8'));
    expect(proof).toEqual({
      sha,
      tree: git('rev-parse', `${sha}^{tree}`),
      level: 'preopen',
      excluded: [],
      finished: true,
      turboRuns: 1,
      passedAt: expect.any(String),
    });
    expect(check().status).toBe(1);
    expect(check().stderr).toBe(refusal());
    expect(check('--level', 'full').status).toBe(1);
    expect(check('--level', 'preopen').status).toBe(0);
  });

  it('never touches an existing full proof, whether the preopen run passes or fails', async () => {
    expect(await verified(() => 0)).toBe(0);
    const full = path.join(proofs(), sha);
    const bytes = readFileSync(full);
    expect(await verified(() => 0, [], { level: 'preopen' })).toBe(0);
    expect(readFileSync(full).equals(bytes)).toBe(true);
    expect(await verified(() => 7, [], { level: 'preopen' })).toBe(7);
    expect(readFileSync(full).equals(bytes)).toBe(true);
    // The failed rerun cleared its own earlier pass, and only that.
    expect(existsSync(path.join(proofs(), `${sha}.preopen`))).toBe(false);
    expect(check().status).toBe(0);
  });

  it('records a full pass at level full and leaves a preopen proof where it was', async () => {
    expect(await verified(() => 0, [], { level: 'preopen' })).toBe(0);
    const preopen = readFileSync(path.join(proofs(), `${sha}.preopen`));
    expect(await verified(() => 0)).toBe(0);
    expect(JSON.parse(readFileSync(path.join(proofs(), sha), 'utf8')).level).toBe('full');
    expect(readFileSync(path.join(proofs(), `${sha}.preopen`)).equals(preopen)).toBe(true);
  });

  it.each(['preopen', 'quick', null, 1])(
    'refuses a full proof file whose level is %j at the default level',
    async (level) => {
      expect(await verified(() => 0)).toBe(0);
      const full = path.join(proofs(), sha);
      writeFileSync(full, JSON.stringify({ ...JSON.parse(readFileSync(full, 'utf8')), level }));
      expect(check().status).toBe(1);
      expect(check().stderr).toBe(refusal());
      // Nor does a mislabelled full file pass as preopen: that level has one file name only.
      expect(check('--level', 'preopen').status).toBe(1);
      expect(check('--level', 'preopen').stderr).toBe(preopenRefusal());
    }
  );

  it('refuses a proof with no level, which only a CLI from before DOR-4728 wrote', async () => {
    expect(await verified(() => 0)).toBe(0);
    const full = path.join(proofs(), sha);
    const { level: _level, ...older } = JSON.parse(readFileSync(full, 'utf8'));
    writeFileSync(full, JSON.stringify(older));
    expect(check().status).toBe(1);
    expect(check('--level', 'full').status).toBe(1);
    expect(check('--level', 'preopen').status).toBe(1);
  });

  it('refuses a preopen proof with no finished marker', async () => {
    expect(await verified(() => 0, [], { level: 'preopen' })).toBe(0);
    const file = path.join(proofs(), `${sha}.preopen`);
    const { finished: _finished, ...older } = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify(older));
    expect(check('--level', 'preopen').status).toBe(1);
  });

  it('accepts a full pass at the preopen level, since it covers more', async () => {
    expect(await verified(() => 0)).toBe(0);
    expect(existsSync(path.join(proofs(), `${sha}.preopen`))).toBe(false);
    expect(check('--level', 'preopen').status).toBe(0);
  });

  it.each(['full', undefined])('refuses a preopen file that claims level %j', async (level) => {
    expect(await verified(() => 0, [], { level: 'preopen' })).toBe(0);
    const file = path.join(proofs(), `${sha}.preopen`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), level }));
    expect(check('--level', 'preopen').status).toBe(1);
    expect(check('--level', 'preopen').stderr).toBe(preopenRefusal());
    expect(check().status).toBe(1);
  });

  it('refuses a preopen file for another tree', async () => {
    expect(await verified(() => 0, [], { level: 'preopen' })).toBe(0);
    const file = path.join(proofs(), `${sha}.preopen`);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...record, tree: '0'.repeat(40) }));
    expect(check('--level', 'preopen').status).toBe(1);
  });

  it('keeps the clean-tree and unchanged-HEAD rules for preopen runs', async () => {
    writeFileSync(path.join(repo, 'example.txt'), 'dirty');
    expect(await verified(() => 0, [], { level: 'preopen' })).toBe(0);
    expect(check('--level', 'preopen').status).toBe(1);
    writeFileSync(path.join(repo, 'example.txt'), 'original');
    expect(
      await verified(
        () => {
          git('commit', '--allow-empty', '-qm', 'new head');
          return 0;
        },
        [],
        { level: 'preopen' }
      )
    ).toBe(0);
    expect(check('--level', 'preopen').status).toBe(1);
  });

  it('runs the preopen steps through the CLI and records only the preopen proof', () => {
    const log = path.join(repo, '.git/preopen-runs');
    // Only the typecheck and lint step goes through turbo, so only it writes a summary.
    installFakePnpm(
      `echo "$*" >> '${log}'\n` +
        'case "$*" in "run verify:preopen:turbo") write_runs 1 ;; esac\nexit 0'
    );
    const result = runGate('run-preopen');
    expect(result.status, result.stderr).toBe(0);
    // HEAD is main itself, so nothing changed: the repo-wide scripts suites (which any
    // change can break) and the typecheck and lint step run, nothing else.
    expect(readFileSync(log, 'utf8')).toBe(
      'exec vitest run --config scripts/vitest.repo.config.ts\nrun verify:preopen:turbo\n'
    );
    expect(existsSync(path.join(proofs(), sha))).toBe(false);
    expect(check('--level', 'preopen').status).toBe(0);
    expect(check().status).toBe(1);
  });

  it.each([
    // `pnpm verify --preopen`: only the verify:preopen script may ask for the lighter gate.
    [['run', '--preopen'], 'pnpm verify takes no arguments (got: --preopen);'],
    [['run', '--preopen', '--force'], 'pnpm verify takes no arguments (got: --preopen --force);'],
    // `pnpm verify:preopen --force`: the message names only what the person typed.
    [['run-preopen', '--force'], 'pnpm verify:preopen takes no arguments (got: --force);'],
  ])('refuses %j before any check starts', (args, message) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr.startsWith(message), result.stderr).toBe(true);
    expect(existsSync(proofs())).toBe(false);
  });

  it.each([[['--level']], [['--level', 'quick']], [['--preopen']], [['--level', 'preopen', 'x']]])(
    'answers check %j with the usage line',
    (flags) => {
      const result = check(...flags);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        'usage: node scripts/verify-proof/cli.ts run | run-preopen | ' +
          'check <sha> [--level full|preopen] [--no-verify-proof]\n'
      );
    }
  );

  it.each([
    [['--level', 'preopen', '--no-verify-proof']],
    [['--no-verify-proof', '--level', 'preopen']],
  ])('refuses the escape at the preopen level %j, and logs nothing', (flags) => {
    const result = check(...flags);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      '--no-verify-proof escapes the full check only; drop --level preopen to use it\n'
    );
    expect(existsSync(path.join(proofs(), 'escapes.jsonl'))).toBe(false);
  });

  /** A lone copy of the CLI in a directory named by its real path, as arm.sh makes one. */
  const withLoneCopy = (body: (cli: string, lone: string) => void) => {
    // realpath: on macOS tmpdir() is a symlink, and a copy reached through one is the
    // other case below, not this one.
    const lone = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-proof-lone-')));
    try {
      copyFileSync(script, path.join(lone, 'cli.ts'));
      body(path.join(lone, 'cli.ts'), lone);
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  };
  const runCli = (cli: string, ...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8' });

  it('checks from a lone copy of the CLI, the way the arm script runs it', async () => {
    expect(await verified(() => 0)).toBe(0);
    withLoneCopy((cli) => {
      const passed = runCli(cli, 'check', sha);
      expect(passed.status, passed.stderr).toBe(0);
      expect(runCli(cli, 'check', sha, '--level', 'preopen').status).toBe(0);
      // A pass means nothing unless the copy can also refuse: a commit with no proof.
      git('commit', '--allow-empty', '-qm', 'no proof here');
      sha = git('rev-parse', 'HEAD');
      const refused = runCli(cli, 'check', sha);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toBe(refusal());
    });
  });

  it('refuses, from a lone copy, the proof a CLI from before DOR-4616 writes', () => {
    // Exactly what that CLI wrote, for a run a signal stopped as much as for a real
    // pass: a branch cut before the fix still runs it. Made-up excludes.
    mkdirSync(proofs(), { recursive: true });
    writeFileSync(
      path.join(proofs(), sha),
      JSON.stringify({
        sha,
        tree: git('rev-parse', `${sha}^{tree}`),
        level: 'full',
        excluded: ['**/example/*.binary.test.ts'],
        passedAt: '2026-11-19T21:04:00.000Z',
      }) + '\n'
    );
    withLoneCopy((cli) => {
      const refused = runCli(cli, 'check', sha);
      expect(refused.status).toBe(1);
      // Its own line: the file is there and matches, but cannot say its run finished.
      expect(refused.stderr).toBe(
        `the pnpm verify proof for ${sha.slice(0, 12)} was recorded before DOR-4616 and ` +
          'cannot arm; green CI at this head still arms, or run pnpm verify from a branch ' +
          'that has the fix\n'
      );
      const preopen = runCli(cli, 'check', sha, '--level', 'preopen');
      expect(preopen.status).toBe(1);
      expect(preopen.stderr).toBe(
        `the proof for ${sha.slice(0, 12)} was recorded before DOR-4616 and does not count; ` +
          'run pnpm verify:preopen from a branch that has the fix\n'
      );
    });
  });

  it('runs when it is reached through a symlinked path', () => {
    withLoneCopy((cli, lone) => {
      const link = path.join(lone, 'linked-cli.ts');
      symlinkSync(cli, link);
      const refused = runCli(link, 'check', sha);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toBe(refusal());
    });
  });
});

describe("arm.sh's verify-proof call, end to end (DOR-4728)", () => {
  /**
   * The two shell lines `.temp/coord/arm.sh` runs, as it runs them: it writes main's
   * `cli.ts` beside itself with `git show`, then runs that lone copy from the main
   * checkout (`$REPO` here) with the full head SHA and no level flag.
   */
  const armCheck = (coord: string) =>
    spawnSync(
      '/bin/sh',
      [
        '-c',
        'vpcli="$(cd "$COORD" && pwd)/verify-proof-cli.ts"\n' +
          'git -C "$REPO" show origin/main:scripts/verify-proof/cli.ts > "$vpcli" || exit 9\n' +
          '( cd "$REPO" && node "$vpcli" check "$SHA" )',
      ],
      {
        encoding: 'utf8',
        // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; the child needs PATH for git and node
        env: { ...process.env, COORD: coord, REPO: repo, SHA: sha },
      }
    );

  it('refuses a head whose only proof is a real preopen pass, and arms it after a full one', async () => {
    // main carries the checker under test, the way origin/main does for arm.sh.
    mkdirSync(path.join(repo, 'scripts/verify-proof'), { recursive: true });
    copyFileSync(script, path.join(repo, 'scripts/verify-proof/cli.ts'));
    git('add', '-A');
    git('commit', '-qm', 'ship the checker');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    sha = git('rev-parse', 'HEAD');
    // Not realpath'd: arm.sh names its folder by `pwd`, which keeps a symlinked path.
    const coord = mkdtempSync(path.join(tmpdir(), 'verify-proof-coord-'));
    try {
      expect(await verified(() => 0, [], { level: 'preopen' })).toBe(0);
      expect(existsSync(path.join(proofs(), `${sha}.preopen`))).toBe(true);
      expect(existsSync(path.join(proofs(), sha))).toBe(false);
      const refused = armCheck(coord);
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stderr).toBe(refusal());
      // The same head after a real full run arms, so the refusal above is the level's doing.
      expect(await verified(() => 0)).toBe(0);
      const armed = armCheck(coord);
      expect(armed.status, armed.stderr).toBe(0);
      expect(armed.stderr).toBe('');
    } finally {
      rmSync(coord, { recursive: true, force: true });
    }
  });
});

describe('what a preopen run checks (DOR-4728)', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const top = () => git('rev-parse', '--show-toplevel');
  /** Commit `files` on a topic branch off main, then plan. `null` deletes a file. */
  const planFor = (files: Record<string, string | null>): PreopenStep[] => {
    git('switch', '-qc', 'topic');
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(repo, file);
      if (contents === null) unlinkSync(target);
      else {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, contents);
      }
    }
    git('add', '-A');
    git('commit', '-qm', 'change');
    return planPreopen(repo, root);
  };
  const names = (steps: PreopenStep[]) => steps.map((step) => step.name);
  const lintArgs = (steps: PreopenStep[]) =>
    steps.find((step) => step.name === 'lint:changed')?.args;

  it.each([
    ['scripts/', 'scripts/check-thing.sh'],
    ['.agents/', '.agents/skills/some-skill/SKILL.md'],
    ['.claude/', '.claude/rules/some-rule.md'],
    ['.github/', '.github/workflows/some-workflow.yml'],
    ['the root package.json', 'package.json'],
    ['packages/shared/src, through the scope script', 'packages/shared/src/thing.md'],
    ['turbo.json, through the scope script', 'turbo.json'],
  ])('runs test:scripts for a change under %s', (_kind, file) => {
    const steps = names(planFor({ [file]: 'changed' }));
    expect(steps[0]).toBe('test:scripts');
    // The full suite already holds the repo-wide files; running them twice buys nothing.
    expect(steps).not.toContain('scripts-repo');
    expect(steps.at(-1)).toBe('typecheck-lint');
  });

  it('runs test:scripts when a file under scripts/ is deleted', () => {
    mkdirSync(path.join(repo, 'scripts'));
    writeFileSync(path.join(repo, 'scripts/old-check.sh'), 'echo');
    git('add', '-A');
    git('commit', '-qm', 'base script');
    expect(names(planFor({ 'scripts/old-check.sh': null }))).toEqual([
      'test:scripts',
      'typecheck-lint',
    ]);
  });

  it('runs test:scripts when the scope script cannot answer', () => {
    // A root with no scripts/scripts-test-scope.sh: bash fails, and a broken check runs more.
    const noScope = mkdtempSync(path.join(tmpdir(), 'verify-proof-noscope-'));
    try {
      git('switch', '-qc', 'topic');
      mkdirSync(path.join(repo, 'apps/client'), { recursive: true });
      writeFileSync(path.join(repo, 'apps/client/README.md'), 'words');
      git('add', '-A');
      git('commit', '-qm', 'change');
      expect(names(planPreopen(repo, noScope))).toEqual(['test:scripts', 'typecheck-lint']);
    } finally {
      rmSync(noScope, { recursive: true, force: true });
    }
  });

  it('runs the repo-wide scripts suites in place of test:scripts for an apps/client/ change', () => {
    const steps = planFor({ 'apps/client/src/view.tsx': 'export {};' });
    expect(names(steps)).toEqual(['scripts-repo', 'lint:changed', 'typecheck-lint']);
    expect(steps.at(-1)?.args).toEqual(['run', 'verify:preopen:turbo']);
  });

  it('still runs the repo-wide scripts suites for a change only under apps/server/src/services/', () => {
    // Those suites are censuses over the whole tree (agents-service-census reads this
    // very directory), and the required typecheck workflow runs them on every PR.
    const steps = planFor({ 'apps/server/src/services/new-domain/index.md': 'words' });
    expect(names(steps)).toEqual(['scripts-repo', 'typecheck-lint']);
    expect(steps[0]?.args).toEqual([
      'exec',
      'vitest',
      'run',
      '--config',
      'scripts/vitest.repo.config.ts',
    ]);
  });

  it.each([
    'eslint.config.js',
    'packages/eslint-config/index.js',
    'package.json',
    'pnpm-lock.yaml',
  ])('lints the whole root with pnpm lint:root when %s changes', (file) => {
    const steps = planFor({ [file]: 'changed', 'apps/client/src/view.tsx': 'export {};' });
    expect(names(steps)).toContain('lint:root');
    expect(names(steps)).not.toContain('lint:changed');
    expect(steps.find((step) => step.name === 'lint:root')?.args).toEqual(['run', 'lint:root']);
  });

  it('lints only changed files when a workspace eslint.config.js changes', () => {
    // Only the root config decides what `eslint .` from the root sees.
    const steps = planFor({ 'apps/client/eslint.config.js': 'export default [];' });
    expect(names(steps)).toContain('lint:changed');
    expect(names(steps)).not.toContain('lint:root');
  });

  it.each([
    [200, 'lint:changed'],
    [201, 'lint:root'],
  ])('with %i changed lintable files, lints with %s', (count, step) => {
    const files = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`apps/client/src/many/f${i}.ts`, ''])
    );
    const steps = planFor(files);
    expect(names(steps)).toContain(step);
    if (step === 'lint:changed') expect(lintArgs(steps)).toHaveLength(3 + count);
  });

  it('lints only the changed files that still exist, are JS or TS, and live in the repo', () => {
    writeFileSync(path.join(repo, 'gone.ts'), 'export {};');
    git('add', '-A');
    git('commit', '-qm', 'base file');
    const outside = mkdtempSync(path.join(tmpdir(), 'verify-proof-outside-'));
    try {
      writeFileSync(path.join(outside, 'elsewhere.js'), '');
      git('switch', '-qc', 'topic');
      symlinkSync(path.join(outside, 'elsewhere.js'), path.join(repo, 'link-out.js'));
      const lintable = ['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.js', 'f.jsx', 'g.mjs', 'h.cjs'];
      for (const file of [...lintable, 'notes.md', 'data.json', 'style.css']) {
        writeFileSync(path.join(repo, file), '');
      }
      unlinkSync(path.join(repo, 'gone.ts'));
      git('add', '-A');
      git('commit', '-qm', 'change');
      // An untracked file is part of the change too.
      writeFileSync(path.join(repo, 'untracked.ts'), '');
      expect(lintArgs(planPreopen(repo, root))).toEqual([
        'exec',
        'eslint',
        '--no-warn-ignored',
        ...[...lintable, 'untracked.ts'].sort().map((file) => path.join(top(), file)),
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips the lint step when nothing lintable changed', () => {
    const steps = planFor({ 'apps/client/README.md': 'words', 'example.txt': null });
    expect(names(steps)).toEqual(['scripts-repo', 'typecheck-lint']);
  });

  it('measures the change from origin/main when there is one, not from main', () => {
    // main is behind origin/main, whose extra commit touched scripts/.
    git('switch', '-qc', 'upstream');
    mkdirSync(path.join(repo, 'scripts'));
    writeFileSync(path.join(repo, 'scripts/upstream.sh'), 'echo');
    git('add', '-A');
    git('commit', '-qm', 'upstream');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(path.join(repo, 'apps.txt'), 'mine');
    git('add', '-A');
    git('commit', '-qm', 'mine');
    expect(names(planPreopen(repo, root))).toEqual(['scripts-repo', 'typecheck-lint']);
    git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(names(planPreopen(repo, root))).toEqual(['test:scripts', 'typecheck-lint']);
  });

  it('stops at the first failing step and returns its exit code', async () => {
    const steps: PreopenStep[] = [
      { name: 'test:scripts', args: ['run', 'test:scripts'] },
      { name: 'lint:changed', args: ['exec', 'eslint'] },
      { name: 'typecheck-lint', args: ['run', 'verify:preopen:turbo'] },
    ];
    const ran: string[] = [];
    const exec = (fail?: PreopenStep['name']) => (step: PreopenStep) => {
      ran.push(step.name);
      return step.name === fail ? 3 : 0;
    };
    expect(await runPreopen(steps, exec('lint:changed'))).toBe(3);
    expect(ran).toEqual(['test:scripts', 'lint:changed']);
    ran.length = 0;
    expect(await runPreopen(steps, exec())).toBe(0);
    expect(ran).toEqual(['test:scripts', 'lint:changed', 'typecheck-lint']);
  });
});

describe('a proof only for a run that finished (DOR-4616)', () => {
  const proof = () => path.join(proofs(), sha);
  /** The incident's numbers: a turbo stopped mid-run that printed 29 of 35 and exited 0. */
  const cutShort = runSummary({ attempted: 35, success: 20, cached: 9 });

  /** Start the CLI without waiting for it, so a test can signal it mid-run. */
  const startCli = (command: string) => {
    const child = spawn(process.execPath, [script, command], {
      cwd: repo,
      env: cliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdout.resume();
    const exited = new Promise<{ code: number | null; signal: string | null; stderr: string }>(
      (resolve) => child.on('close', (code, signal) => resolve({ code, signal, stderr }))
    );
    return { child, exited };
  };
  /** Wait, bounded, for the fake pnpm to say it has started. */
  /**
   * Wait, bounded, for the fake pnpm to say it has started, and return its pid. The
   * fake moves the file into place whole, and the pid is checked as well: an empty or
   * partial read would be 0, and signalling pid 0 reaches this test runner's whole
   * process group.
   */
  const started = async (): Promise<number> => {
    const file = path.join(repo, '.git/pnpm-started');
    const read = () => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
    for (let i = 0; i < 200 && !/^\d+$/.test(read()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(read()).toMatch(/^\d+$/);
    const pid = Number(read());
    expect(pid).toBeGreaterThan(1);
    return pid;
  };
  /** The refusals the CLI recorded, one parsed line each. */
  const refusals = () =>
    readFileSync(path.join(proofs(), 'refusals.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  /**
   * A pnpm that behaves like turbo under a signal: it shuts down, writes summaries
   * that look finished, and exits 0. Unsignalled, it runs `seconds` and passes. A
   * signal test gives it far longer than it can take, so only the signal ends it.
   */
  const turboLikePnpm = (seconds: number) =>
    installFakePnpm(
      [
        // The sleep holds none of the CLI's output open, and goes when the fake does.
        `trap 'echo TERM >> .git/pnpm-signals; kill $sleeper; write_runs 2; exit 0' TERM`,
        `trap 'echo INT >> .git/pnpm-signals; kill $sleeper; write_runs 2; exit 0' INT`,
        'echo $$ > .git/pnpm-started.tmp && mv .git/pnpm-started.tmp .git/pnpm-started',
        `sleep ${seconds} >/dev/null 2>&1 & sleeper=$!`,
        'wait $sleeper',
        'write_runs 2',
        'exit 0',
      ].join('\n')
    );

  it('records no proof for a turbo stopped mid-run that still exited 0', () => {
    // The first step finished; the test step was stopped with 29 of its 35 tasks done.
    installFakePnpm(
      [
        'write_runs 1',
        'echo " Tasks:    29 successful, 35 total"',
        'PROOF_TEST_SUMMARY="$PROOF_TEST_CUT_SHORT"; write_runs 1',
        'exit 0',
      ].join('\n')
    );
    const result = runGate('run', { PROOF_TEST_CUT_SHORT: cutShort });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pnpm verify exited 0 but did not finish');
    expect(result.stderr).toContain('shows 29 of 35 tasks finished, 0 failed, exit code 0');
    expect(result.stderr).toContain('no proof recorded');
    expect(existsSync(proof())).toBe(false);
    expect(check().status).toBe(1);
    // The unfinished summary stays for the person to read, and the message says where;
    // the finished one is cleared.
    const kept = readdirSync(turboRuns());
    expect(kept).toHaveLength(1);
    expect(result.stderr).toContain(
      `turbo's unfinished run summary is kept at ${path.join(realpathSync(turboRuns()), kept[0] ?? '')}`
    );
    expect(refusals()).toEqual([
      {
        sha,
        level: 'full',
        kind: 'unfinished',
        why: expect.stringContaining('shows 29 of 35 tasks finished'),
        when: expect.any(String),
      },
    ]);
  });

  it('keeps only the newest unfinished summary, even when the gate itself failed', () => {
    // A failed gate returns before the completion check; its summaries still go.
    installFakePnpm(
      [
        'PROOF_FINISHED="$PROOF_TEST_SUMMARY"',
        'PROOF_TEST_SUMMARY="$PROOF_TEST_CUT_SHORT"; write_runs 1',
        'sleep 0.05; write_runs 1',
        'PROOF_TEST_SUMMARY="$PROOF_FINISHED"; write_runs 1',
        'exit 1',
      ].join('\n')
    );
    const result = runGate('run', { PROOF_TEST_CUT_SHORT: cutShort });
    expect(result.status).toBe(1);
    const kept = readdirSync(turboRuns());
    // The second of the two cut-short summaries: written last of the unfinished ones.
    expect(kept).toEqual([expect.stringMatching(/-2\.json$/)]);
    expect(result.stderr).toContain(
      `kept at ${path.join(realpathSync(turboRuns()), kept[0] ?? '')}`
    );
    // A failed gate is a failure, not an unfinished run: nothing is recorded as one.
    expect(existsSync(path.join(proofs(), 'refusals.jsonl'))).toBe(false);
  });

  it('leaves no summaries behind when a failed gate wrote only finished ones', () => {
    installFakePnpm('write_runs 1\nexit 1');
    expect(runGate('run').status).toBe(1);
    expect(readdirSync(turboRuns())).toEqual([]);
  });

  it('notes a refusal on the hook run it is part of, as ci_steward_note does', () => {
    installFakePnpm('write_runs 1\nexit 0');
    const timings = path.join(repo, '.git/timings.jsonl');
    const result = runGate('run', {
      CI_STEWARD_TIMINGS_FILE: timings,
      CI_STEWARD_HOOK: 'pre-push',
      CI_STEWARD_COMMAND: 'verify',
      CI_STEWARD_RUN_ID: '4242-1763600000',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(timings, 'utf8'))).toEqual({
      v: 1,
      e: 'O',
      h: 'pre-push',
      c: 'verify',
      id: '4242-1763600000',
      t: expect.any(Number),
      o: 'verify_unfinished',
      d: null,
    });
  });

  it('records no proof when a turbo step wrote no summary', () => {
    installFakePnpm('write_runs 1\nexit 0');
    const result = runGate('run');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected 2 turbo run summaries in .turbo/runs, found 1');
    expect(existsSync(proof())).toBe(false);
  });

  it('records no preopen proof for a typecheck and lint step stopped mid-run', () => {
    installFakePnpm(
      'case "$*" in "run verify:preopen:turbo") ' +
        'PROOF_TEST_SUMMARY="$PROOF_TEST_CUT_SHORT"; write_runs 1 ;; esac\nexit 0'
    );
    const result = runGate('run-preopen', { PROOF_TEST_CUT_SHORT: cutShort });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pnpm verify:preopen exited 0 but did not finish');
    expect(check('--level', 'preopen').status).toBe(1);
  });

  it('records no proof for a verify stopped with TERM, and passes the TERM on', async () => {
    turboLikePnpm(60);
    const run = startCli('run');
    await started();
    run.child.kill('SIGTERM');
    const result = await run.exited;
    // A shell's code for a TERMed run, not a signal death and never 0.
    expect({ code: result.code, signal: result.signal }).toEqual({ code: 143, signal: null });
    expect(result.stderr).toContain('pnpm verify was stopped by SIGTERM; no proof recorded');
    expect(readFileSync(path.join(repo, '.git/pnpm-signals'), 'utf8')).toBe('TERM\n');
    expect(existsSync(proof())).toBe(false);
    expect(check().status).toBe(1);
    expect(refusals()).toEqual([
      {
        sha,
        level: 'full',
        kind: 'stopped',
        why: 'pnpm verify was stopped by SIGTERM; no proof recorded',
        status: 143,
        when: expect.any(String),
      },
    ]);
    // The summaries the stopped run wrote looked finished, so none is kept.
    expect(readdirSync(turboRuns())).toEqual([]);
  });

  it('records no proof for a verify that got INT, which it leaves to the terminal', async () => {
    turboLikePnpm(60);
    const run = startCli('run');
    const pnpm = await started();
    // What a terminal's Ctrl-C does: INT reaches the CLI and pnpm both.
    run.child.kill('SIGINT');
    process.kill(pnpm, 'SIGINT');
    const result = await run.exited;
    expect({ code: result.code, signal: result.signal }).toEqual({ code: 130, signal: null });
    expect(result.stderr).toContain('pnpm verify was stopped by SIGINT; no proof recorded');
    // Once from the "terminal", never a second time from the CLI.
    expect(readFileSync(path.join(repo, '.git/pnpm-signals'), 'utf8')).toBe('INT\n');
    expect(existsSync(proof())).toBe(false);
  });

  it('records a proof for the same run when nothing stopped it', async () => {
    turboLikePnpm(1);
    const result = await startCli('run').exited;
    expect(result.code, result.stderr).toBe(0);
    expect(check().status).toBe(0);
    expect(existsSync(path.join(proofs(), 'refusals.jsonl'))).toBe(false);
  });

  it('gives each gate the turbo steps the CLI counts, every one with --summarize', () => {
    const scripts = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
    ).scripts as Record<string, string>;
    // Each step's own arguments: what comes before `--` is turbo's, after it the task's.
    const turboSteps = (name: string) =>
      (scripts[name] ?? '')
        .split('&&')
        .filter((part) => /\bturbo run\b/.test(part))
        .map((part) => part.split(' -- ')[0]);
    expect(turboSteps('verify:checks')).toHaveLength(TURBO_RUNS.full);
    expect(turboSteps('verify:preopen:turbo')).toHaveLength(TURBO_RUNS.preopen);
    for (const step of [...turboSteps('verify:checks'), ...turboSteps('verify:preopen:turbo')]) {
      expect(step).toMatch(/\bturbo run .*--summarize\b/);
    }
  });
});

describe("watchTurboRuns: turbo's own counts decide (DOR-4616)", () => {
  it('was read against the turbo package.json pins, so a turbo bump means a re-read', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
    ) as { devDependencies?: Record<string, string> };
    // On a turbo upgrade, re-read crates/turborepo-run-summary/src/execution.rs at the
    // new tag: what `attempted`, `success`, `cached` and `failed` count. Then move
    // TURBO_SUMMARY_READ_AGAINST in scripts/verify-proof/turbo-runs.ts to match.
    expect(pkg.devDependencies?.turbo).toBe(TURBO_SUMMARY_READ_AGAINST);
  });

  const root = () => repo;
  const write = (name: string, contents: string) => {
    mkdirSync(turboRuns(), { recursive: true });
    writeFileSync(path.join(turboRuns(), name), contents);
  };

  it('passes runs where every task that started finished, cache hits included', () => {
    const watch = watchTurboRuns(root(), 2);
    write('a.json', runSummary());
    write('b.json', runSummary({ success: 0, cached: 4, attempted: 4 }));
    expect(watch.unfinished()).toBeUndefined();
    expect(watch.tidy()).toBeUndefined();
    expect(readdirSync(turboRuns())).toEqual([]);
  });

  it('passes a run with no affected tasks at all', () => {
    const watch = watchTurboRuns(root(), 1);
    write('a.json', runSummary({ success: 0, cached: 0, attempted: 0 }));
    expect(watch.unfinished()).toBeUndefined();
  });

  it('ignores summaries that were there before the gate started', () => {
    write('old.json', '{"not": "a run summary"}');
    const watch = watchTurboRuns(root(), 1);
    write('new.json', runSummary());
    expect(watch.unfinished()).toBeUndefined();
    watch.tidy();
    expect(readdirSync(turboRuns())).toEqual(['old.json']);
  });

  it('tidies away all but the newest unfinished summary it saw written', async () => {
    const watch = watchTurboRuns(root(), 3);
    write('older.json', runSummary({ success: 1 }));
    // Far enough apart that the two files' modified times differ.
    await new Promise((resolve) => setTimeout(resolve, 20));
    write('newer.json', runSummary({ failed: 1, success: 1 }));
    write('done.json', runSummary());
    expect(watch.tidy()).toBe(path.join(turboRuns(), 'newer.json'));
    expect(readdirSync(turboRuns())).toEqual(['newer.json']);
  });

  it.each([
    ['a failed task', { failed: 1, success: 1 }, '2 of 3 tasks finished, 1 failed, exit code 0'],
    ['a cancelled task', { success: 1 }, '2 of 3 tasks finished, 0 failed, exit code 0'],
    ['a non-zero exit code', { exitCode: 1 }, '3 of 3 tasks finished, 0 failed, exit code 1'],
  ])('refuses %s, and keeps that summary', (_label, execution, reason) => {
    const watch = watchTurboRuns(root(), 1);
    write('a.json', runSummary(execution));
    expect(watch.unfinished()).toBe(`turbo's run summary a.json shows ${reason}`);
    expect(watch.tidy()).toBe(path.join(turboRuns(), 'a.json'));
    expect(readdirSync(turboRuns())).toEqual(['a.json']);
  });

  it.each([
    ['corrupt JSON', '{"execution":'],
    ['no execution block', '{"tasks": []}'],
    ['a count that is not a number', runSummary().replace('"attempted":3', '"attempted":"3"')],
  ])('refuses a summary holding %s', (_label, contents) => {
    const watch = watchTurboRuns(root(), 1);
    write('a.json', contents);
    expect(watch.unfinished()).toBe("turbo's run summary a.json could not be read");
  });

  it.each([
    [0, 'expected 1 turbo run summary in .turbo/runs, found 0'],
    [2, 'expected 1 turbo run summary in .turbo/runs, found 2'],
  ])('refuses %i summaries where it expects one', (count, reason) => {
    const watch = watchTurboRuns(root(), 1);
    for (let i = 0; i < count; i++) write(`run-${i}.json`, runSummary());
    expect(watch.unfinished()).toBe(reason);
  });
});
