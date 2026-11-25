/**
 * codex-binary-macos.yml's scope step and its `codex-sandbox-macos` fan-in, as
 * they actually ship (DOR-4402).
 *
 * `codex-sandbox-macos` is meant to be a required check, so it reports on every
 * pull request and queue build, and only a change that can reach the Codex
 * suites pays for the macOS runner. scripts/test-codex-macos-scope.sh pins the
 * LIST; this file pins the STEP that feeds it and the FAN-IN that reports, by
 * extracting their `run:` blocks from the YAML and executing them. What it
 * holds still:
 *
 *   - each event diffs the right range (a PR's test-merge commit against its
 *     first parent, a queue entry against its first parent, a push against
 *     `before`), and a dispatch always runs;
 *   - the list is read from the base commit, not from the change being graded;
 *   - every way the step cannot decide answers true (run the suites), green;
 *   - the fan-in is green only for "no Codex change", "macOS passed" or "the
 *     queue proved the pass on the PR head", and red for everything else,
 *     including a scope it cannot read.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const workflow = readFileSync(join(root, '.github/workflows/codex-binary-macos.yml'), 'utf8');
const SCOPE_STEP = 'Decide whether this change can reach the macOS Codex suites';
const FAN_IN_STEP = 'Require the macOS suites green, no Codex change, or a proven pass';
const CODEX_FILE = 'apps/server/src/services/runtimes/codex/app-server/app-server-client.ts';

/** A job's text, up to the next top-level job. */
function jobText(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `codex-binary-macos.yml has no ${name} job`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** One step's `run: |` body, de-indented. */
function runBody(job: string, step: string): string {
  const text = jobText(job);
  const at = text.indexOf(`      - name: ${step}\n`);
  expect(at, `${job} has no step "${step}"`).toBeGreaterThan(-1);
  const rest = text.slice(at);
  const next = rest.slice(1).search(/\n {6}- /);
  const body = (next === -1 ? rest : rest.slice(0, next + 1)).match(/ {8}run: \|\n([\s\S]*)$/)?.[1];
  expect(body, `"${step}" has no run block`).toBeTruthy();
  return body!
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
    },
  }).trim();
}

function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function commit(repo: string, paths: string[], message: string): string {
  for (const path of paths) write(repo, path, `${message}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

interface Base {
  /** The base's scope list: the real one (true), none (false), or this text. */
  scopeScript?: boolean | string;
}

/** A repository whose main branch holds the base commit. */
function repoWithBase({ scopeScript = true }: Base = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'codex-macos-scope-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  if (scopeScript === true) {
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    copyFileSync(
      join(root, 'scripts/codex-macos-scope.sh'),
      join(repo, 'scripts/codex-macos-scope.sh')
    );
  } else if (typeof scopeScript === 'string') {
    write(repo, 'scripts/codex-macos-scope.sh', scopeScript);
  }
  commit(repo, ['README.md'], 'base');
  return repo;
}

interface PullRequest extends Base {
  changes: string[];
  /** Files the base branch changed after the pull request branched. */
  baseChanges?: string[];
  /** End on the test-merge commit (true) or on the PR's own commit (false). */
  merge?: boolean;
  /** Replace the scope list in the PR's own tree with this text. */
  prScopeScript?: string;
}

/** What actions/checkout gives a pull request: a merge of its head onto its base. */
function pullRequest({
  changes,
  baseChanges = [],
  merge = true,
  prScopeScript,
  ...base
}: PullRequest) {
  const repo = repoWithBase(base);
  git(repo, 'checkout', '-q', '-b', 'pr');
  if (prScopeScript !== undefined) write(repo, 'scripts/codex-macos-scope.sh', prScopeScript);
  commit(repo, changes, 'pr change');
  if (!merge) return repo;
  git(repo, 'checkout', '-q', 'main');
  commit(repo, baseChanges, 'main moved on');
  git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'pr');
  return repo;
}

/** Run the shipped scope step in `repo`; return its `codex=` answer. */
function decide(
  repo: string,
  event: string,
  before = ''
): { code: number; codex: string; log: string } {
  const output = join(repo, '.github-output');
  writeFileSync(output, '');
  const temp = join(repo, '.runner-temp');
  mkdirSync(temp, { recursive: true });
  const r = spawnSync('bash', ['-c', runBody('scope', SCOPE_STEP)], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: repo,
      EVENT: event,
      BEFORE: before,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: temp,
    },
  });
  const codex = readFileSync(output, 'utf8').match(/^codex=(.*)$/m)?.[1] ?? '';
  return { code: r.status ?? 1, codex, log: `${r.stdout}${r.stderr}` };
}

describe('codex-binary-macos scope step', () => {
  it('runs the suites on a pull request that touches Codex', () => {
    const repo = pullRequest({ changes: [CODEX_FILE] });
    expect(decide(repo, 'pull_request')).toMatchObject({ code: 0, codex: 'true' });
  });

  it('skips them on a pull request that cannot reach them', () => {
    const repo = pullRequest({ changes: ['docs/x.md', 'apps/client/src/a.ts'] });
    const r = decide(repo, 'pull_request');
    expect(r).toMatchObject({ code: 0, codex: 'false' });
    expect(r.log).toContain('do not run here');
  });

  it('diffs only the pull request, not what moved on the base', () => {
    const repo = pullRequest({ changes: ['docs/x.md'], baseChanges: [CODEX_FILE] });
    expect(decide(repo, 'pull_request').codex).toBe('false');
  });

  it('runs them when HEAD is not a test-merge commit', () => {
    const repo = pullRequest({ changes: ['docs/x.md'], merge: false });
    const r = decide(repo, 'pull_request');
    expect(r).toMatchObject({ code: 0, codex: 'true' });
    expect(r.log).toContain('no test-merge commit');
  });

  it('grades a pull request with the base commit’s list, not its own', () => {
    // The PR's own copy says "never"; the base's copy is what decides.
    const repo = pullRequest({
      changes: [CODEX_FILE],
      prScopeScript: 'cat >/dev/null; echo false\n',
    });
    expect(decide(repo, 'pull_request').codex).toBe('true');
    // And the other way round: a base list that says "never" wins over the PR's.
    const neutered = pullRequest({
      changes: [CODEX_FILE],
      scopeScript: 'cat >/dev/null; echo false\n',
    });
    expect(decide(neutered, 'pull_request').codex).toBe('false');
  });

  it('runs them when the base has no list, or the list fails or answers nonsense', () => {
    expect(
      decide(pullRequest({ changes: ['docs/x.md'], scopeScript: false }), 'pull_request')
    ).toMatchObject({
      code: 0,
      codex: 'true',
    });
    expect(
      decide(pullRequest({ changes: ['docs/x.md'], scopeScript: 'exit 3\n' }), 'pull_request')
    ).toMatchObject({ code: 0, codex: 'true' });
    expect(
      decide(pullRequest({ changes: ['docs/x.md'], scopeScript: 'echo maybe\n' }), 'pull_request')
    ).toMatchObject({ code: 0, codex: 'true' });
  });

  it('diffs a queue entry against its first parent only', () => {
    // main, then an earlier entry that touches Codex, then this entry.
    const repo = repoWithBase();
    commit(repo, [CODEX_FILE], 'entry ahead in the queue');
    commit(repo, ['docs/x.md'], 'this entry');
    expect(decide(repo, 'merge_group')).toMatchObject({ code: 0, codex: 'false' });
    commit(repo, [CODEX_FILE], 'a codex entry');
    expect(decide(repo, 'merge_group')).toMatchObject({ code: 0, codex: 'true' });
  });

  it('diffs a push to main against every commit the push brought', () => {
    const repo = repoWithBase();
    const before = git(repo, 'rev-parse', 'HEAD');
    commit(repo, [CODEX_FILE], 'first merge in the push');
    commit(repo, ['docs/x.md'], 'second merge in the push');
    expect(decide(repo, 'push', before)).toMatchObject({ code: 0, codex: 'true' });
    // With no usable `before`, the last commit alone is the range.
    expect(decide(repo, 'push', '')).toMatchObject({ code: 0, codex: 'false' });
    expect(decide(repo, 'push', '0'.repeat(40))).toMatchObject({ code: 0, codex: 'false' });
  });

  it('always runs them on a dispatch, whatever changed', () => {
    const repo = pullRequest({ changes: ['docs/x.md'] });
    expect(decide(repo, 'workflow_dispatch')).toMatchObject({ code: 0, codex: 'true' });
  });

  it('never skips itself and checks out the parent it diffs against', () => {
    const job = jobText('scope');
    expect(job).not.toMatch(/^ {4}if:/m);
    expect(job).toMatch(/- uses: actions\/checkout@v\d+\n {8}with:\n {10}fetch-depth: 2\n/);
    expect(job).toContain('persist-credentials: false');
  });
});

/** Run the shipped fan-in step with these job results. */
function fanIn(env: Record<string, string>): number {
  const r = spawnSync('bash', ['-c', runBody('codex-sandbox-macos', FAN_IN_STEP)], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  return r.status ?? 1;
}

const PR = { EVENT: 'pull_request', SCOPE: 'success', ATTEST: 'skipped', ATTESTED: '' };
const QUEUE = { EVENT: 'merge_group', SCOPE: 'success' };

describe('codex-sandbox-macos fan-in', () => {
  it.each([
    ['no Codex change', { ...PR, CODEX: 'false', MACOS: 'skipped' }],
    ['a Codex PR whose macOS run passed', { ...PR, CODEX: 'true', MACOS: 'success' }],
    [
      'a queue entry with no Codex change',
      { ...QUEUE, CODEX: 'false', ATTEST: 'skipped', MACOS: 'skipped' },
    ],
    [
      'a Codex queue entry attested on its PR head',
      { ...QUEUE, CODEX: 'true', ATTEST: 'success', ATTESTED: 'true', MACOS: 'skipped' },
    ],
    [
      'a Codex queue entry not attested, macOS passed',
      { ...QUEUE, CODEX: 'true', ATTEST: 'success', ATTESTED: 'false', MACOS: 'success' },
    ],
    [
      'a push to main with a Codex change that passed',
      { ...PR, EVENT: 'push', CODEX: 'true', MACOS: 'success' },
    ],
  ])('is green for %s', (_, env) => {
    expect(fanIn(env)).toBe(0);
  });

  it.each([
    ['a Codex PR whose macOS run failed', { ...PR, CODEX: 'true', MACOS: 'failure' }],
    ['a Codex PR whose macOS run was cancelled', { ...PR, CODEX: 'true', MACOS: 'cancelled' }],
    ['a Codex PR whose macOS run was skipped', { ...PR, CODEX: 'true', MACOS: 'skipped' }],
    ['a scope job that failed', { ...PR, SCOPE: 'failure', CODEX: '', MACOS: 'skipped' }],
    [
      'a scope job that was cancelled',
      { ...PR, SCOPE: 'cancelled', CODEX: 'false', MACOS: 'skipped' },
    ],
    ['a scope with no answer', { ...PR, CODEX: '', MACOS: 'skipped' }],
    ['a scope with a garbled answer', { ...PR, CODEX: 'maybe', MACOS: 'skipped' }],
    ['no Codex change but a red macOS run', { ...PR, CODEX: 'false', MACOS: 'failure' }],
    [
      'an attest that failed',
      { ...QUEUE, CODEX: 'true', ATTEST: 'failure', ATTESTED: '', MACOS: 'skipped' },
    ],
    [
      'a queue entry not attested whose macOS run failed',
      { ...QUEUE, CODEX: 'true', ATTEST: 'success', ATTESTED: 'false', MACOS: 'failure' },
    ],
    [
      'a queue entry not attested whose macOS run was skipped',
      { ...QUEUE, CODEX: 'true', ATTEST: 'success', ATTESTED: 'false', MACOS: 'skipped' },
    ],
    [
      'an "attested" skip outside the queue',
      { ...PR, CODEX: 'true', ATTEST: 'success', ATTESTED: 'true', MACOS: 'skipped' },
    ],
  ])('is red for %s', (_, env) => {
    expect(fanIn(env)).toBe(1);
  });

  it('always reports, on both gating events, and reads every job it needs', () => {
    const job = jobText('codex-sandbox-macos');
    expect(job).toMatch(/^ {4}needs: \[scope, attest, codex-binary-macos\]$/m);
    expect(job).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
    for (const need of ['scope', 'attest', 'codex-binary-macos']) {
      expect(job).toContain(`needs.${need}.result`);
    }
    expect(workflow).toMatch(/^ {2}pull_request:\n {2}merge_group:\n/m);
    expect(workflow).not.toMatch(/^ {4}paths(-ignore)?:/m);
  });

  it('asks attest-pr-check.sh about this very context', () => {
    expect(jobText('attest')).toContain(
      'bash scripts/attest-pr-check.sh codex-sandbox-macos "$HEAD_REF"'
    );
  });

  it('passes no secret to any job', () => {
    expect(workflow).not.toMatch(/\$\{\{[^}]*\bsecrets\./);
    expect(workflow).not.toMatch(/^\s*secrets:/m);
  });
});
