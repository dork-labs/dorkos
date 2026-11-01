/**
 * The pull request leg's test plan, run against a real turbo (DOR-3518).
 *
 * scripts/pr-test-plan.sh keeps the `test` tasks whose turbo HASH a change
 * moved. These cases build a small monorepo shaped like this one, with the
 * same kinds of cross-package reads declared as task `inputs`, and run the
 * shipped script over it with the repo's own turbo binary. A stubbed turbo
 * would only encode what we believe turbo does; the point of the script is
 * what turbo actually hashes. Stubs appear only where turbo must FAIL.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'scripts/pr-test-plan.sh');
const turbo = path.join(root, 'node_modules/.bin/turbo');

// The child git must not inherit a session's GIT_* settings or a person's own config.
const env = Object.fromEntries(
  // eslint-disable-next-line no-restricted-syntax -- the real script runs under a real environment.
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

const scratch = mkdtempSync(path.join(tmpdir(), 'dorkos-pr-plan-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run git in a fixture repo with a fixed identity. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env }
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** Write a file in a fixture repo, making its folders. */
function put(cwd: string, file: string, body = `${file}\n`): void {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), body);
}

/** A package manifest with a `test` script and the given workspace dependencies. */
function manifest(name: string, deps: string[] = []): string {
  const dependencies = Object.fromEntries(deps.map((dep) => [dep, 'workspace:*']));
  return `${JSON.stringify({ name, version: '0.0.0', scripts: { test: 'vitest run' }, dependencies })}\n`;
}

let count = 0;
/**
 * A committed monorepo: `shared`, a `server` that depends on it and reads a
 * root doc, and a `steward` that reads `ci/` and the workflows. Returns its
 * path and base commit. With `planner`, the base carries the real planner
 * script, as `main` will once this lands.
 */
function monorepo({ planner = false } = {}): { repo: string; base: string } {
  const repo = path.join(scratch, `repo-${(count += 1)}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(
    repo,
    'package.json',
    `${JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: 'pnpm@10.28.2',
      devDependencies: { turbo: '2.10.13' },
    })}\n`
  );
  put(repo, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  put(
    repo,
    'pnpm-lock.yaml',
    [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      'importers:',
      '',
      '  .: {}',
      '',
      '  apps/server:',
      '    dependencies:',
      '      shared:',
      '        specifier: workspace:*',
      '        version: link:../../packages/shared',
      '',
      '  packages/shared: {}',
      '',
      '  packages/steward: {}',
      '',
    ].join('\n')
  );
  put(
    repo,
    'turbo.json',
    `${JSON.stringify(
      {
        $schema: 'https://turbo.build/schema.json',
        tasks: {
          build: { outputs: ['dist/**'] },
          test: { dependsOn: ['^build'] },
          'server#test': {
            dependsOn: ['^build'],
            inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/contributing/capabilities/runtimes.md'],
          },
          'steward#test': {
            dependsOn: ['^build'],
            inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/.github/workflows/**', '$TURBO_ROOT$/ci/**'],
          },
        },
      },
      null,
      2
    )}\n`
  );
  put(repo, 'apps/server/package.json', manifest('server', ['shared']));
  put(repo, 'apps/server/src/a.test.ts');
  put(repo, 'packages/shared/package.json', manifest('shared'));
  put(repo, 'packages/shared/src/index.ts');
  put(repo, 'packages/steward/package.json', manifest('steward'));
  put(repo, 'packages/steward/src/a.test.ts');
  put(repo, 'contributing/capabilities/runtimes.md');
  put(repo, '.github/workflows/lint.yml');
  put(repo, 'ci/ledger/a.md');
  put(repo, 'changelog/unreleased/a.md');
  put(repo, 'meta/notes.md');
  if (planner) put(repo, 'scripts/pr-test-plan.sh', readFileSync(script, 'utf8'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

/** Change files on top of the base and commit; returns the head commit. */
function change(repo: string, files: string[]): string {
  for (const file of files) put(repo, file, `${file} changed\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
  return git(repo, 'rev-parse', 'HEAD');
}

/** Run the shipped script over a fixture repo. */
function plan(repo: string, base: string, head: string, turboCommand = turbo) {
  const result = spawnSync('bash', [script, base, head], {
    encoding: 'utf8',
    env: { ...env, REPO_ROOT: repo, TURBO: turboCommand },
  });
  expect(result.status, result.stderr).toBe(0);
  const [verdict, ...lines] = result.stdout.trim().split('\n');
  return { verdict, suites: lines, why: result.stderr };
}

describe.skipIf(!existsSync(turbo))('pr-test-plan.sh with the real turbo', () => {
  it('a runtimes.md-only change runs the suite that declares it, where --affected ran none', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['contributing/capabilities/runtimes.md']);
    expect(plan(repo, base, head)).toMatchObject({
      verdict: 'selected',
      suites: ['server apps/server'],
    });
    // The bug this replaces, pinned so the reason stays visible: --affected
    // reads changed FILES, not task inputs, and selects no test at all.
    const affected = spawnSync(turbo, ['test', '--affected', '--dry=json'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head },
    });
    expect(affected.status, affected.stderr).toBe(0);
    const tasks = (JSON.parse(affected.stdout) as { tasks: { task: string }[] }).tasks;
    expect(tasks.filter((task) => task.task === 'test')).toEqual([]);
  });

  // Both touch how tests are chosen or run, so they run every suite, which is
  // at least one test task each, and includes the steward that reads them.
  it.each(['ci/ledger/a.md', '.github/workflows/lint.yml'])(
    'a %s-only change runs every suite',
    (file) => {
      const { repo, base } = monorepo();
      const result = plan(repo, base, change(repo, [file]));
      expect(result.verdict).toBe('full');
      expect(result.why).toContain('how tests are chosen or run');
    }
  );

  it('a change to a package runs it and every suite that builds on it', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['packages/shared/src/index.ts']);
    expect(plan(repo, base, head)).toMatchObject({
      verdict: 'selected',
      suites: ['server apps/server', 'shared packages/shared'],
    });
  });

  it('a change no suite reads runs everything, never nothing', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['meta/notes.md']);
    expect(plan(repo, base, head)).toMatchObject({ verdict: 'full', suites: [] });
  });

  // Security's list (DOR-3518): a change to any of these cannot pick its own
  // tests. The guard reads paths before turbo runs, so content never parses.
  it.each([
    'turbo.json',
    'package.json',
    'packages/shared/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    'vitest.config.ts',
    '.github/workflows/test.yml',
    '.github/CODEOWNERS',
    'scripts/pr-test-plan.sh',
    'scripts/lib/anything.mjs',
    'ci/gates.yaml',
  ])('a change to %s runs every suite', (file) => {
    const { repo, base } = monorepo();
    const result = plan(repo, base, change(repo, ['apps/server/src/a.test.ts', file]));
    expect(result.verdict).toBe('full');
    expect(result.why).toContain('how tests are chosen or run');
  });
});

describe('pr-test-plan.sh runs everything whenever it cannot plan', () => {
  it('when turbo fails', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['packages/shared/src/index.ts']);
    const result = plan(repo, base, head, 'false');
    expect(result.verdict).toBe('full');
    expect(result.why).toContain('could not plan');
  });

  it('when turbo prints something that is not its plan', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['packages/shared/src/index.ts']);
    const stub = path.join(scratch, 'not-json-turbo.sh');
    writeFileSync(stub, '#!/usr/bin/env bash\necho "WARNING: no plan today"\n');
    chmodSync(stub, 0o755);
    expect(plan(repo, base, head, stub).verdict).toBe('full');
  });

  it('when the plan has no test tasks at all', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['packages/shared/src/index.ts']);
    const stub = path.join(scratch, 'empty-turbo.sh');
    writeFileSync(stub, '#!/usr/bin/env bash\necho \'{"tasks":[]}\'\n');
    chmodSync(stub, 0o755);
    expect(plan(repo, base, head, stub).verdict).toBe('full');
  });

  it('when the base is not a commit', () => {
    const { repo } = monorepo();
    const head = change(repo, ['packages/shared/src/index.ts']);
    expect(plan(repo, '0'.repeat(40), head).verdict).toBe('full');
  });

  it('when the checkout is not at the head', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['packages/shared/src/index.ts']);
    git(repo, 'checkout', '-q', '--detach', base);
    expect(plan(repo, base, head).verdict).toBe('full');
  });

  it('when it is given no commits', () => {
    const { repo } = monorepo();
    expect(plan(repo, '', '').verdict).toBe('full');
  });
});

const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');

/** The real shell body of a named step in test.yml. */
function step(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  expect(start, `no step named ${name}`).toBeGreaterThanOrEqual(0);
  const run = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  const indent = lines[run]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/**
 * A pull request checkout over a fixture repo: a test-merge commit whose first
 * parent is `main` and whose second is the change. Returns nothing; HEAD is
 * the merge.
 */
function testMerge(repo: string, files: string[]): void {
  git(repo, 'checkout', '-q', '-b', 'pr');
  change(repo, files);
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'test merge', 'pr');
}

/**
 * Run the workflow's "Plan this pull request's suites" step in a fixture repo,
 * with `npx` on PATH standing in for the registry: it runs the repo's own
 * turbo, or fails when asked to.
 */
function planStep(repo: string, event: string, { npxFails = false } = {}) {
  const bin = mkdtempSync(path.join(scratch, 'bin-'));
  const npx = path.join(bin, 'npx');
  // `npx --yes turbo@<version> <args>`: drop the first two words, run turbo.
  writeFileSync(
    npx,
    npxFails
      ? '#!/usr/bin/env bash\nexit 1\n'
      : `#!/usr/bin/env bash\nshift 2\nexec "${turbo}" "$@"\n`
  );
  chmodSync(npx, 0o755);
  const output = path.join(bin, 'output.txt');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', step("Plan this pull request's suites")], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...env,
      EVENT: event,
      PATH: `${bin}:${env.PATH ?? ''}`,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: bin,
    },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()])
  );
}

describe.skipIf(!existsSync(turbo))('the workflow step that plans a pull request', () => {
  it('hands the shards the suites the change moved', () => {
    const { repo } = monorepo({ planner: true });
    testMerge(repo, ['contributing/capabilities/runtimes.md']);
    expect(planStep(repo, 'pull_request')).toEqual({
      scope: 'selected',
      packages: 'server',
      dirs: 'apps/server',
    });
  });

  it('runs everything when the base has no planner, as the pull request that adds it does', () => {
    const { repo } = monorepo();
    testMerge(repo, ['contributing/capabilities/runtimes.md']);
    expect(planStep(repo, 'pull_request')).toEqual({ scope: 'full' });
  });

  it('runs everything when turbo cannot be fetched', () => {
    const { repo } = monorepo({ planner: true });
    testMerge(repo, ['contributing/capabilities/runtimes.md']);
    expect(planStep(repo, 'pull_request', { npxFails: true })).toEqual({ scope: 'full' });
  });

  it('runs everything when HEAD is not a test-merge commit', () => {
    const { repo } = monorepo({ planner: true });
    change(repo, ['contributing/capabilities/runtimes.md']);
    expect(planStep(repo, 'pull_request')).toEqual({ scope: 'full' });
  });

  it.each(['merge_group', 'schedule', 'workflow_dispatch'])(
    '%s never plans: the queue and the canary run every suite',
    (event) => {
      const { repo } = monorepo({ planner: true });
      testMerge(repo, ['contributing/capabilities/runtimes.md']);
      expect(planStep(repo, event)).toEqual({ scope: 'full' });
    }
  );
});

describe('the plan reaches the pull request leg and nothing else', () => {
  it('the pull request sweep filters to the planned packages', () => {
    expect(
      step(
        "Run the affected packages' test suites (shard ${{ matrix.shard }}/${{ strategy.job-total }})"
      )
    ).toContain('for package in $PACKAGES; do filters+=("--filter=$package"); done');
  });

  it('the queue sweep reads no plan', () => {
    const sweep = step("Run every package's test suite (shard ${{ matrix.shard }}/6)");
    expect(sweep).not.toContain('PACKAGES');
    expect(sweep).not.toContain('--filter');
    expect(sweep).not.toContain('--affected');
  });
});
