/**
 * The no-code scope decision in test.yml, as it actually ships (DOR-4484,
 * ledger 261115-205154).
 *
 * scripts/test-no-code-scope.sh pins the RULE (which paths count as no code).
 * This file pins the WIRING that feeds it, which is where the check failed for
 * its whole life: it ran inside `test-shard`, whose checkout is depth 1, so the
 * test-merge commit's parents were never in the clone, `HEAD^2` never resolved,
 * and every pull request logged "cannot diff" and ran the shards.
 *
 * So the decision step is extracted from test-shard-count's YAML and run in a
 * shallow clone made at the depth that job's checkout declares. What it holds:
 *
 *   - a docs-only pull request answers `false`, a code change `true`;
 *   - a checkout that cannot see the base (depth 1, or no merge commit) and a
 *     script that errors answer `true`, never `false`;
 *   - the queue and the canary always answer `true`;
 *   - test-shard and test-binary skip only on the literal `false`, on a pull
 *     request only, and the jobs still report to the `test` fan-in.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
const STEP = 'Decide whether this change can affect a test';

/** A test.yml job's text, up to the next top-level job. */
function jobText(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `test.yml has no ${name} job`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** One step's YAML, from its `- name:` line to the next step. */
function stepText(job: string, name: string): string {
  const text = jobText(job);
  const at = text.indexOf(`      - name: ${name}\n`);
  expect(at, `${job} has no step "${name}"`).toBeGreaterThan(-1);
  const rest = text.slice(at);
  const next = rest.slice(1).search(/\n {6}- /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** A step's `run: |` body, de-indented. */
function stepBody(job: string, name: string): string {
  const lines = stepText(job, name).split('\n');
  const at = lines.indexOf('        run: |');
  expect(at, `${job} step "${name}" has no run: | block`).toBeGreaterThan(0);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

/** The `fetch-depth` of a job's (single) actions/checkout step. */
function checkoutDepth(job: string): number {
  const depths = [...jobText(job).matchAll(/^ {10}fetch-depth: (\d+)$/gm)].map((m) => Number(m[1]));
  expect(depths, `${job} has one checkout depth`).toHaveLength(1);
  return depths[0] ?? 0;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const gitEnv = (home: string) => ({
  // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; git, bash and jq come from the real PATH, and nothing else from this process
  PATH: process.env.PATH ?? '',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: home,
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(cwd) }).trim();
}

function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

interface Fixture {
  /** The files the pull request changes. */
  changes: string[];
  /** The base's scripts/no-code-scope.sh: the real one (default), none, or this text. */
  scopeScript?: true | false | string;
  /** Clone depth, as actions/checkout's fetch-depth. */
  depth: number;
}

/**
 * A clone shaped like what actions/checkout gives a pull request: HEAD is a
 * test-merge commit of the PR onto its base, fetched at `depth`, through
 * file:// so git honours the depth exactly as it does for the real fetch.
 */
function checkout({ changes, scopeScript = true, depth }: Fixture): string {
  const origin = temp('no-code-scope-origin-');
  git(origin, 'init', '-q', '-b', 'main');
  if (scopeScript === true) {
    mkdirSync(join(origin, 'scripts'), { recursive: true });
    copyFileSync(join(root, 'scripts/no-code-scope.sh'), join(origin, 'scripts/no-code-scope.sh'));
  } else if (typeof scopeScript === 'string') {
    write(origin, 'scripts/no-code-scope.sh', scopeScript);
  }
  write(origin, 'README.md', 'base\n');
  write(origin, 'docs/index.md', 'docs\n');
  write(origin, 'apps/server/src/a.ts', 'export const a = 1;\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'base');
  git(origin, 'checkout', '-q', '-b', 'pr');
  for (const path of changes) write(origin, path, `change ${path}\n`);
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'pr change');
  git(origin, 'checkout', '-q', 'main');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'main moved on');
  git(origin, 'merge', '-q', '--no-ff', '--no-edit', 'pr');
  const clone = temp('no-code-scope-checkout-');
  execFileSync('git', ['clone', '-q', `--depth=${depth}`, `file://${origin}`, clone], {
    env: gitEnv(clone),
  });
  return clone;
}

/** Run a shipped step body in `cwd`; return its exit code, `run=` output and log. */
function runStep(
  body: string,
  cwd: string,
  env: Record<string, string>
): { code: number; run: string; log: string } {
  const runnerTemp = temp('no-code-scope-runner-');
  const output = join(runnerTemp, 'github-output');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['-c', body], {
    cwd,
    encoding: 'utf8',
    env: { ...gitEnv(cwd), RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output, ...env },
  });
  const run = readFileSync(output, 'utf8').match(/^run=(.*)$/m)?.[1] ?? '';
  return { code: r.status ?? 1, run, log: `${r.stdout}${r.stderr}` };
}

const decideBody = () => stepBody('test-shard-count', STEP);
const decide = (repo: string, event: string) => runStep(decideBody(), repo, { EVENT: event });
const depth = () => checkoutDepth('test-shard-count');

describe("test-shard-count's no-code scope decision", () => {
  it('skips a docs-only pull request', () => {
    const repo = checkout({ changes: ['docs/guides/x.md', 'CHANGELOG.md'], depth: depth() });
    const r = decide(repo, 'pull_request');
    expect(r).toMatchObject({ code: 0, run: 'false' });
    expect(r.log).not.toContain('cannot diff');
  });

  it('runs a pull request that changes code', () => {
    const repo = checkout({ changes: ['docs/x.md', 'apps/server/src/a.ts'], depth: depth() });
    expect(decide(repo, 'pull_request')).toMatchObject({ code: 0, run: 'true' });
  });

  it('runs when the diff cannot be determined (a depth-1 checkout, the old bug)', () => {
    const repo = checkout({ changes: ['docs/x.md'], depth: 1 });
    const r = decide(repo, 'pull_request');
    expect(r).toMatchObject({ code: 0, run: 'true' });
    expect(r.log).toContain('cannot diff');
  });

  it.each([
    ['has no scope script', false],
    ['scope script fails', 'exit 3\n'],
    ['scope script answers nonsense', 'echo maybe\n'],
    ['scope script says false and then fails', 'echo false; exit 1\n'],
  ] as const)('runs when the base %s', (_, scopeScript) => {
    const repo = checkout({ changes: ['docs/x.md'], scopeScript, depth: depth() });
    expect(decide(repo, 'pull_request')).toMatchObject({ code: 0, run: 'true' });
  });

  it.each(['merge_group', 'schedule', 'workflow_dispatch'])(
    'always runs on %s, whatever changed',
    (event) => {
      const repo = checkout({ changes: ['docs/x.md'], depth: depth() });
      expect(decide(repo, event)).toMatchObject({ code: 0, run: 'true' });
    }
  );

  it('is on a checkout deep enough to see the base, and publishes its answer', () => {
    expect(depth()).toBeGreaterThanOrEqual(2);
    const step = stepText('test-shard-count', STEP);
    expect(step).not.toMatch(/^ {8}if:/m);
    expect(step).toMatch(/^ {8}id: noscope$/m);
    expect(jobText('test-shard-count')).toMatch(
      /^ {6}tests: \$\{\{ steps\.noscope\.outputs\.run \}\}$/m
    );
    expect(jobText('test-shard-count')).not.toMatch(/^ {4}if:/m);
  });

  it('reads the rule from the base commit, never the checkout', () => {
    expect(decideBody()).toContain('git cat-file blob "$base:scripts/no-code-scope.sh"');
    expect(decideBody()).not.toMatch(/bash scripts\/no-code-scope\.sh/);
  });
});

describe("test-shard reads the answer and skips only on 'false'", () => {
  const read = (EVENT: string, TESTS: string) =>
    runStep(stepBody('test-shard', STEP), root, { EVENT, TESTS });

  it('skips the PR test step on a pull request answered false', () => {
    expect(read('pull_request', 'false')).toMatchObject({ code: 0, run: 'false' });
  });

  it.each(['true', '', 'FALSE', 'false ', 'garbage'])('runs on a pull request answered %j', (t) => {
    expect(read('pull_request', t)).toMatchObject({ code: 0, run: 'true' });
  });

  it.each(['merge_group', 'schedule', 'workflow_dispatch'])('never skips on %s', (event) => {
    expect(read(event, 'false')).toMatchObject({ code: 0, run: 'true' });
  });

  it('is wired to test-shard-count, gates only the PR test step, and never skips its job', () => {
    const step = stepText('test-shard', STEP);
    expect(step).not.toMatch(/^ {8}if:/m);
    expect(step).toMatch(/^ {8}id: noscope$/m);
    expect(step).toMatch(/^ {10}TESTS: \$\{\{ needs\.test-shard-count\.outputs\.tests \}\}$/m);
    const gated = jobText('test-shard')
      .split('\n')
      .filter((line) => line.includes('steps.noscope.outputs.run'));
    expect(gated).toEqual([
      "        if: ${{ github.event_name == 'pull_request' && steps.noscope.outputs.run == 'true' }}",
    ]);
    expect(jobText('test-shard')).not.toMatch(/^ {4}if:/m);
  });
});

describe("test-binary honours the same 'false'", () => {
  const plan = (env: Record<string, string>) =>
    runStep(stepBody('test-binary', 'Decide which binary suites run'), root, {
      SCOPE: 'full',
      PACKAGES: '',
      ...env,
    });

  it('runs none on a pull request answered false', () => {
    expect(plan({ EVENT: 'pull_request', TESTS: 'false' })).toMatchObject({
      code: 0,
      run: 'false',
    });
  });

  it.each(['true', '', 'garbage'])('runs them on a pull request answered %j', (TESTS) => {
    expect(plan({ EVENT: 'pull_request', TESTS })).toMatchObject({ code: 0, run: 'true' });
  });

  it.each(['merge_group', 'schedule', 'workflow_dispatch'])('never skips on %s', (EVENT) => {
    expect(plan({ EVENT, TESTS: 'false' })).toMatchObject({ code: 0, run: 'true' });
  });

  it('reads it from test-shard-count', () => {
    expect(stepText('test-binary', 'Decide which binary suites run')).toMatch(
      /^ {10}TESTS: \$\{\{ needs\.test-shard-count\.outputs\.tests \}\}$/m
    );
  });
});

describe('the required `test` fan-in', () => {
  it('still requires test-shard and test-binary to succeed, so a skip is a green job, not a skipped one', () => {
    const fanIn = jobText('test');
    expect(fanIn).toMatch(/needs\.test-shard\.result[\s\S]*\[ "\$result" = "success" \]/);
    expect(fanIn).toMatch(/needs\.test-binary\.result[\s\S]*\[ "\$result" = "success" \]/);
  });
});
