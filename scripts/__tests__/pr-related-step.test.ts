/**
 * The workflow half of the tests-by-import lane (DOR-5110): test-shard-count's
 * "Decide whether this change's tests can be chosen by import" step, and the
 * pull request test step that hands the shards to scripts/pr-related-tests.sh.
 * The scripts themselves are pinned by scripts/test-pr-related.sh.
 *
 * What must hold, because a slip in any of them is silent:
 *   - only a pull request ever answers `related=true`: the merge queue, the
 *     canary and a release pull request run every suite;
 *   - the decision is read from the BASE commit, so a pull request that adds
 *     or edits the script is not graded by it;
 *   - the step has no `if:`, so the job always reports;
 *   - the shards take the lane only on a `selected` plan, and the queue sweep
 *     never reads it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
const STEP = "Decide whether this change's tests can be chosen by import";
const PR_STEP =
  "Run the affected packages' test suites (shard ${{ matrix.shard }}/${{ strategy.job-total }})";

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

/**
 * A depth-2 clone of a test-merge commit, as test-shard-count checks out a
 * pull request: first parent main, second parent the change.
 */
function checkout(
  changes: string[],
  { baseHasScript = true, prScript = '' }: { baseHasScript?: boolean; prScript?: string } = {}
): string {
  const origin = temp('pr-related-origin-');
  git(origin, 'init', '-q', '-b', 'main');
  if (baseHasScript) {
    mkdirSync(join(origin, 'scripts'), { recursive: true });
    copyFileSync(
      join(root, 'scripts/pr-related-scope.sh'),
      join(origin, 'scripts/pr-related-scope.sh')
    );
  }
  write(origin, 'apps/server/src/a.ts', 'export const a = 1;\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'base');
  git(origin, 'checkout', '-q', '-b', 'pr');
  for (const path of changes) write(origin, path, `change ${path}\n`);
  if (prScript) write(origin, 'scripts/pr-related-scope.sh', prScript);
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'pr change');
  git(origin, 'checkout', '-q', 'main');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'main moved on');
  git(origin, 'merge', '-q', '--no-ff', '--no-edit', 'pr');
  const clone = temp('pr-related-checkout-');
  execFileSync('git', ['clone', '-q', '--depth=2', `file://${origin}`, clone], {
    env: gitEnv(clone),
  });
  return clone;
}

/** Run the decision step in `cwd`; return its exit code and outputs. */
function decide(cwd: string, env: Record<string, string>) {
  const runnerTemp = temp('pr-related-runner-');
  const output = join(runnerTemp, 'github-output');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['-c', stepBody('test-shard-count', STEP)], {
    cwd,
    encoding: 'utf8',
    env: { ...gitEnv(cwd), RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output, ...env },
  });
  const text = readFileSync(output, 'utf8');
  return {
    code: r.status ?? 1,
    related: text.match(/^related=(.*)$/m)?.[1] ?? '',
    files: text.match(/^vitest_files=(.*)$/m)?.[1] ?? '',
    log: `${r.stdout}${r.stderr}`,
  };
}

describe("test-shard-count's tests-by-import decision", () => {
  it('takes the lane for a pull request that changes source', () => {
    const repo = checkout(['apps/server/src/a.ts', 'changelog/unreleased/x.md']);
    const got = decide(repo, { EVENT: 'pull_request' });
    expect(got.code, got.log).toBe(0);
    expect(got.related).toBe('true');
    expect(JSON.parse(got.files)).toEqual(['apps/server/src/a.ts', 'changelog/unreleased/x.md']);
  });

  it.each(['merge_group', 'schedule', 'workflow_dispatch', 'release_pull_request'])(
    'answers false on %s without looking: those run every suite',
    (event) => {
      const repo = checkout(['apps/server/src/a.ts']);
      const got = decide(repo, { EVENT: event });
      expect(got.code, got.log).toBe(0);
      expect(got.related).toBe('false');
      expect(got.files).toBe('[]');
    }
  );

  it('answers false when the base has no script, as the pull request that adds it does', () => {
    const repo = checkout(['apps/server/src/a.ts'], { baseHasScript: false });
    expect(decide(repo, { EVENT: 'pull_request' }).related).toBe('false');
  });

  it('reads the script from the base, never the checkout', () => {
    // The pull request rewrites the rule to always say yes, beside a config
    // change the base's rule refuses.
    const repo = checkout(['apps/server/vitest.config.ts'], {
      prScript: 'printf "related=true\\nreason=x\\nvitest_files=[]\\n"\n',
    });
    expect(decide(repo, { EVENT: 'pull_request' }).related).toBe('false');
  });

  it('answers false for a config change', () => {
    const repo = checkout(['apps/server/src/a.ts', 'apps/server/vitest.config.ts']);
    expect(decide(repo, { EVENT: 'pull_request' }).related).toBe('false');
  });

  it('leaves a text-only change to the text-only lane', () => {
    const repo = checkout(['apps/server/src/a.ts']);
    expect(decide(repo, { EVENT: 'pull_request', TEXT_ONLY: 'true' }).related).toBe('false');
  });

  it('answers false when HEAD is not a test-merge commit', () => {
    const repo = temp('pr-related-plain-');
    git(repo, 'init', '-q', '-b', 'main');
    write(repo, 'a.ts', 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'one');
    expect(decide(repo, { EVENT: 'pull_request' }).related).toBe('false');
  });
});

describe('the wiring', () => {
  it('the decision has no `if:`, so the job always reports', () => {
    expect(stepText('test-shard-count', STEP)).not.toMatch(/^ {8}if:/m);
  });

  it('hands the shards the answer, the file list and the plan directories', () => {
    const job = jobText('test-shard-count');
    expect(job).toMatch(
      /^ {6}related: \$\{\{ steps\.related\.outputs\.related \|\| 'false' \}\}$/m
    );
    expect(job).toMatch(/^ {6}dirs: \$\{\{ steps\.plan\.outputs\.dirs \}\}$/m);
    // The text-only lane's list wins when it has the change; the lane's
    // otherwise; never the text-only lane's empty `[]` over a related list.
    expect(job).toContain(
      "vitest_files: ${{ steps.textonly.outputs.text_only == 'true' && steps.textonly.outputs.vitest_files || steps.related.outputs.vitest_files || '[]' }}"
    );
  });

  it('the pull request step takes the lane only on a selected plan', () => {
    const body = stepBody('test-shard', PR_STEP);
    expect(body).toContain(
      `if [ "$SCOPE" = 'selected' ] && [ "\${RELATED:-}" = true ]; then\n  exec bash scripts/pr-related-tests.sh '\${{ matrix.shard }}/\${{ strategy.job-total }}' "$VITEST_FILES"\nfi`
    );
  });

  it('the queue sweep never reads it', () => {
    const sweep = stepText(
      'test-shard',
      "Run every package's test suite (shard ${{ matrix.shard }}/${{ strategy.job-total }})"
    );
    expect(sweep).not.toContain('RELATED');
    expect(sweep).not.toContain('pr-related');
  });
});
