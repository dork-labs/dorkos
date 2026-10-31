/**
 * A pull request's test plan, run against a real turbo (DOR-3518, ledger
 * 261031-165048).
 *
 * scripts/test-plan.sh keeps the `test` tasks whose turbo HASH changed between
 * the base and the head. These cases build a small monorepo shaped like this
 * one, with the same kinds of cross-package reads declared as task `inputs`,
 * and run the shipped script over it with the repo's own turbo binary. A
 * stubbed turbo would only encode what we believe turbo hashes; the point of
 * the script is what turbo actually hashes. The failure cases stub it, because
 * there the point is what the script does when turbo misbehaves.
 *
 * Security's four conditions (#dorkos, 2026-10-31) each have a case here: the
 * queue is never planned, a change to a file that decides what runs forces the
 * full set, every doubt runs everything, and each of the three gaps the lane
 * found (a declared root input, `ci/ledger/`, a workflow-only change) selects
 * at least one test.
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
const script = path.join(root, 'scripts/test-plan.sh');
const turbo = path.join(root, 'node_modules/.bin/turbo');
const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');

// The child git must not inherit a session's GIT_* settings or a person's own config.
const env = Object.fromEntries(
  // eslint-disable-next-line no-restricted-syntax -- the real script runs under a real environment.
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

const scratch = mkdtempSync(path.join(tmpdir(), 'dorkos-test-plan-'));
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
 * root doc, a `steward` that reads the workflows and ci/, and a `client` that
 * reads nothing outside itself. Returns its path and base commit. With
 * `planner`, the base carries the real planner script, as `main` will once
 * this lands.
 */
function monorepo({ planner = false, turboVersion = '2.10.13' } = {}): {
  repo: string;
  base: string;
} {
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
      devDependencies: { turbo: turboVersion },
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
      '  apps/client: {}',
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
  put(repo, 'apps/client/package.json', manifest('client'));
  put(repo, 'apps/client/src/a.test.ts');
  put(repo, 'apps/server/package.json', manifest('server', ['shared']));
  put(repo, 'apps/server/src/a.test.ts');
  put(repo, 'packages/shared/package.json', manifest('shared'));
  put(repo, 'packages/shared/src/index.ts');
  put(repo, 'packages/steward/package.json', manifest('steward'));
  put(repo, 'packages/steward/src/a.test.ts');
  put(repo, 'contributing/capabilities/runtimes.md');
  put(repo, '.github/workflows/lint.yml');
  put(repo, 'ci/ledger/a.md');
  put(repo, 'research/a.md');
  if (planner) put(repo, 'scripts/test-plan.sh', readFileSync(script, 'utf8'));
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

/** A turbo stand-in that prints `body` and exits 0. */
function stub(name: string, body: string): string {
  const file = path.join(scratch, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(!existsSync(turbo))('test-plan.sh with the real turbo', () => {
  it('a change to a declared root input runs that suite, where --affected ran none', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['contributing/capabilities/runtimes.md']);
    expect(plan(repo, base, head)).toMatchObject({
      verdict: 'selected',
      suites: ['server apps/server'],
    });
    // The gap this closes, pinned so the reason stays visible: --affected
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

  it.each(['ci/ledger/a.md', '.github/workflows/lint.yml'])(
    'a change to %s alone selects tests (every suite, by the escape list)',
    (file) => {
      const { repo, base } = monorepo();
      const head = change(repo, [file]);
      const result = plan(repo, base, head);
      expect(result.verdict).toBe('full');
      expect(result.why).toContain('a file that decides what runs changed');
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

  it('a change to one leaf package runs that package alone', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['apps/client/src/a.test.ts']);
    expect(plan(repo, base, head)).toMatchObject({
      verdict: 'selected',
      suites: ['client apps/client'],
    });
  });

  it('Markdown no suite reads runs nothing', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['research/a.md']);
    expect(plan(repo, base, head)).toMatchObject({ verdict: 'none', suites: [] });
  });

  it('any other file no suite reads runs everything, never nothing', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['research/a.md', 'research/data.json']);
    const result = plan(repo, base, head);
    expect(result.verdict).toBe('full');
    expect(result.why).toContain('research/data.json');
  });

  it.each([
    'turbo.json',
    'package.json',
    'apps/client/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.github/workflows/test.yml',
    '.github/CODEOWNERS',
    'scripts/test-plan.sh',
    'ci/required-checks.json',
  ])('a change to %s, on Security’s list, runs everything', (file) => {
    const { repo, base } = monorepo();
    // The list is read before turbo runs, so the file's new content never has
    // to parse.
    const head = change(repo, ['apps/client/src/a.test.ts', file]);
    const result = plan(repo, base, head);
    expect(result.verdict).toBe('full');
    expect(result.why).toContain('a file that decides what runs changed');
  });
});

describe('test-plan.sh runs everything whenever it cannot plan', () => {
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
    expect(plan(repo, base, head, stub('not-json.sh', 'echo "no plan today"')).verdict).toBe(
      'full'
    );
  });

  it('when the plan has no test tasks at all', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['packages/shared/src/index.ts']);
    expect(plan(repo, base, head, stub('empty.sh', `echo '{"tasks":[]}'`)).verdict).toBe('full');
  });

  it('when turbo names a package it will not pass on as a filter', () => {
    const { repo, base } = monorepo();
    const head = change(repo, ['packages/shared/src/index.ts']);
    // A different hash on every call, so the task always looks changed.
    const odd = stub(
      'odd-name.sh',
      `echo "{\\"tasks\\":[{\\"task\\":\\"test\\",\\"taskId\\":\\"x#test\\",\\"hash\\":\\"$RANDOM$RANDOM\\",\\"package\\":\\"--filter=*\\",\\"directory\\":\\"apps/x\\"}]}"`
    );
    const result = plan(repo, base, head, odd);
    expect(result.verdict).toBe('full');
    expect(result.why).toContain('will not pass on');
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
 * A fixture shaped like actions/checkout's pull request checkout: the change
 * on a branch, `main` moved on, and HEAD a test-merge commit whose first
 * parent is the base.
 */
function pullRequest(files: string[], options?: Parameters<typeof monorepo>[0]): string {
  const { repo } = monorepo(options);
  git(repo, 'checkout', '-q', '-b', 'pr');
  change(repo, files);
  git(repo, 'checkout', '-q', 'main');
  change(repo, ['research/elsewhere.md']);
  git(repo, 'merge', '-q', '--no-ff', '-m', 'test merge', 'pr');
  return repo;
}

/**
 * Run the workflow's "Plan the pull request's suites" step in a fixture repo,
 * with `npx` on PATH standing in for the registry: it runs the repo's own
 * turbo, or fails when asked to. Returns the outputs it wrote.
 */
function planStep(repo: string, event: string, { npxFails = false } = {}) {
  const bin = mkdtempSync(path.join(scratch, 'bin-'));
  // `npx --yes turbo@<version> <args>`: drop the first two words, run turbo.
  writeFileSync(
    path.join(bin, 'npx'),
    npxFails
      ? '#!/usr/bin/env bash\nexit 1\n'
      : `#!/usr/bin/env bash\nshift 2\nexec "${turbo}" "$@"\n`
  );
  chmodSync(path.join(bin, 'npx'), 0o755);
  const output = path.join(bin, 'output.txt');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', step("Plan the pull request's suites")], {
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
    const repo = pullRequest(['contributing/capabilities/runtimes.md'], { planner: true });
    expect(planStep(repo, 'pull_request')).toEqual({ scope: 'selected', packages: 'server' });
  });

  it('says none for Markdown nothing reads', () => {
    const repo = pullRequest(['research/a.md'], { planner: true });
    expect(planStep(repo, 'pull_request')).toEqual({ scope: 'none' });
  });

  it('runs everything when the base has no planner, as the pull request that adds it does', () => {
    const repo = pullRequest(['contributing/capabilities/runtimes.md']);
    expect(planStep(repo, 'pull_request')).toEqual({ scope: 'full' });
  });

  it('runs everything when turbo cannot be fetched', () => {
    const repo = pullRequest(['contributing/capabilities/runtimes.md'], { planner: true });
    expect(planStep(repo, 'pull_request', { npxFails: true })).toEqual({ scope: 'full' });
  });

  it('runs everything when the base pins turbo by a range, not an exact version', () => {
    const repo = pullRequest(['contributing/capabilities/runtimes.md'], {
      planner: true,
      turboVersion: '^2.10.13',
    });
    expect(planStep(repo, 'pull_request')).toEqual({ scope: 'full' });
  });

  it('runs everything when HEAD is not a test-merge commit', () => {
    const { repo } = monorepo({ planner: true });
    change(repo, ['contributing/capabilities/runtimes.md']);
    expect(planStep(repo, 'pull_request')).toEqual({ scope: 'full' });
  });

  it.each(['merge_group', 'schedule', 'workflow_dispatch'])(
    '%s never plans: the queue and the canary run every suite',
    (event) => {
      const repo = pullRequest(['contributing/capabilities/runtimes.md'], { planner: true });
      expect(planStep(repo, event)).toEqual({ scope: 'full' });
    }
  );
});

describe('the plan reaches every step that depends on it, on the pull request leg only', () => {
  it('the picker exports the plan and the fan-in requires the picker green', () => {
    expect(workflow).toMatch(/^ {6}scope: \$\{\{ steps\.plan\.outputs\.scope \}\}$/m);
    expect(workflow).toMatch(/^ {6}packages: \$\{\{ steps\.plan\.outputs\.packages \}\}$/m);
    expect(workflow).toMatch(
      /^ {4}needs: \[test-shard-count, test-shard, community-pg, community-packaged\]$/m
    );
    expect(step('Require the shard and suite plan green')).toContain(
      '${{ needs.test-shard-count.result }}'
    );
  });

  it('the pull request leg filters to the plan and no longer runs --affected', () => {
    const name =
      "Run the pull request's planned test suites (shard ${{ matrix.shard }}/${{ strategy.job-total }})";
    expect(step(name)).toContain(
      'for package in $PACKAGES; do filters+=("--filter=$package"); done'
    );
    expect(step(name)).toContain('set -f');
    // No command line, as opposed to a comment, still picks by --affected.
    const commands = workflow
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(commands).not.toMatch(/--affected/);
  });

  it('the queue sweep reads no plan', () => {
    const sweep = step("Run every package's test suite (shard ${{ matrix.shard }}/6)");
    expect(sweep).not.toMatch(/filter|PACKAGES|SCOPE/);
  });
});
