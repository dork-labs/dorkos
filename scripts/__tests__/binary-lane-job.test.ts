/**
 * The real-CLI suites' own lane in test.yml (DOR-4190, ledger 261115-203006).
 *
 * Every `*.binary.test.ts` left the six shards: both shard legs exclude the
 * pattern, codex-sandbox runs the Codex ones and `test-binary` runs the rest.
 * The danger in that move is a suite that no job runs any more and nothing
 * notices, so this pins every link: the exclusion drops exactly the binary
 * suites, the two jobs together run exactly those (no gap, no overlap), the
 * job's shipped plan step and proof script behave as their headers say, and
 * the `test` fan-in both requires the job green and requires every binary file
 * in its union by name.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');

/** One job's text, from its key to the next top-level job key. */
function jobText(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  expect(start, `test.yml has no job ${id}`).toBeGreaterThan(0);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** A step's `run: |` body, de-indented, found by the step's name. */
function stepRun(job: string, name: string): string {
  const at = job.indexOf(`      - name: ${name}\n`);
  expect(at, `no step "${name}"`).toBeGreaterThanOrEqual(0);
  const lines = job.slice(at).split('\n');
  const runAt = lines.findIndex((line) => line === '        run: |');
  expect(runAt, `step "${name}" has no run: | block`).toBeGreaterThan(0);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const binaryJob = jobText('test-binary');
const fanIn = jobText('test');
const codexJob = jobText('codex-sandbox');

/** Every tracked binary suite in a workspace package, as the jobs read them. */
function trackedBinarySuites(): string[] {
  const out = spawnSync(
    'git',
    ['ls-files', '--', 'apps/*.binary.test.ts', 'packages/*.binary.test.ts'],
    { cwd: root, encoding: 'utf8' }
  );
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.split('\n').filter(Boolean).sort();
}

/** Every tracked vitest-shaped test file in a workspace package. */
function trackedTestFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '--', 'apps/*.test.ts', 'packages/*.test.ts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.split('\n').filter(Boolean);
}

const temps: string[] = [];
function temp(): string {
  // Real path: the script resolves report paths against process.cwd(), which
  // is the physical directory (macOS's /var is a link to /private/var).
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'binary-lane-')));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** Run the shipped plan step from the repo root; returns run= and the planned files. */
function plan(env: Record<string, string>): { run: string; files: string[]; log: string } {
  const runnerTemp = temp();
  const output = path.join(runnerTemp, 'github-output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', stepRun(binaryJob, 'Decide which binary suites run')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; the plan step needs git and jq from the real PATH, and nothing else from this process
      PATH: process.env.PATH ?? '',
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: output,
      SCOPE: 'full',
      PACKAGES: '',
      ...env,
    },
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const run = /^run=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1] ?? '';
  const files = readFileSync(path.join(runnerTemp, 'binary-files.txt'), 'utf8')
    .split('\n')
    .filter(Boolean);
  return { run, files, log: result.stdout };
}

describe('the shards exclude exactly the binary suites', () => {
  const sweeps = workflow
    .split('\n')
    .filter((line) => /pnpm exec turbo test .*--shard=/.test(line));

  it('both legs carry the one exclusion and nothing else', () => {
    expect(sweeps).toHaveLength(2);
    for (const line of sweeps) {
      expect([...line.matchAll(/--exclude='([^']+)'/g)].map((m) => m[1])).toEqual([
        '**/*.binary.test.ts',
      ]);
    }
  });

  it('the pattern drops every binary suite and no other test file', () => {
    const dropped = trackedTestFiles()
      .filter((file) => path.matchesGlob(file, '**/*.binary.test.ts'))
      .sort();
    expect(dropped).toEqual(trackedBinarySuites());
    expect(dropped.length).toBeGreaterThan(0);
    // A near miss stays in the shards.
    expect(
      path.matchesGlob('apps/server/src/x/__tests__/resolve-binary.test.ts', '**/*.binary.test.ts')
    ).toBe(false);
  });
});

describe('test-binary and codex-sandbox together run exactly the binary suites', () => {
  it('the plan is every binary suite outside codex/, on the queue and the canary', () => {
    for (const EVENT of ['merge_group', 'schedule', 'workflow_dispatch']) {
      const { run, files } = plan({ EVENT });
      expect(run).toBe('true');
      expect(files).toEqual(trackedBinarySuites().filter((file) => !file.includes('/codex/')));
    }
  });

  it('with codex-sandbox there is no gap and no overlap', () => {
    const planned = plan({ EVENT: 'merge_group' }).files;
    const codex = [
      ...new Set(
        [
          ...codexJob.matchAll(
            /(apps\/server\/src\/services\/runtimes\/codex\/\S+\.binary\.test\.ts)/g
          ),
        ].map((m) => m[1]!)
      ),
    ];
    expect(planned.filter((file) => codex.includes(file))).toEqual([]);
    expect([...planned, ...codex].sort()).toEqual(trackedBinarySuites());
  });

  it('on a pull request it runs exactly when the shards would have', () => {
    expect(plan({ EVENT: 'pull_request', SCOPE: 'full' }).run).toBe('true');
    expect(
      plan({ EVENT: 'pull_request', SCOPE: 'selected', PACKAGES: '@dorkos/shared @dorkos/server ' })
        .run
    ).toBe('true');
    expect(
      plan({ EVENT: 'pull_request', SCOPE: 'selected', PACKAGES: '@dorkos/server ' }).run
    ).toBe('true');
    expect(plan({ EVENT: 'pull_request', SCOPE: 'selected', PACKAGES: '@dorkos/site ' }).run).toBe(
      'false'
    );
    expect(plan({ EVENT: 'pull_request', SCOPE: 'selected', PACKAGES: '' }).run).toBe('false');
    // A package whose name only starts with the right one does not count.
    expect(
      plan({ EVENT: 'pull_request', SCOPE: 'selected', PACKAGES: '@dorkos/server-extras ' }).run
    ).toBe('false');
  });
});

describe('the shipped proof script', () => {
  const script = path.join(root, 'scripts/assert-binary-suites-ran.mjs');
  const files = [
    'apps/server/src/a/__tests__/one.binary.test.ts',
    'apps/server/src/b/__tests__/two.binary.test.ts',
  ];

  function prove(
    suites: Array<{ name: string; assertionResults: Array<{ status: string }> }> | null,
    planned = files
  ): { status: number | null; out: string; listed: string } {
    const dir = temp();
    writeFileSync(path.join(dir, 'planned.txt'), planned.join('\n') + '\n');
    mkdirSync(path.join(dir, 'apps/server'), { recursive: true });
    if (suites !== null) {
      writeFileSync(
        path.join(dir, 'apps/server/vitest-shard-report.json'),
        JSON.stringify({ testResults: suites.map((s) => ({ ...s, name: path.join(dir, s.name) })) })
      );
    }
    const result = spawnSync(process.execPath, [script, 'planned.txt', 'out.txt'], {
      cwd: dir,
      encoding: 'utf8',
    });
    let listed = '';
    try {
      listed = readFileSync(path.join(dir, 'out.txt'), 'utf8');
    } catch {
      // no list written
    }
    return { status: result.status, out: result.stdout + result.stderr, listed };
  }

  const passed = [{ status: 'passed' }];

  it('accepts every planned file run, and lists them for the union', () => {
    const r = prove(files.map((name) => ({ name, assertionResults: passed })));
    expect(r.status, r.out).toBe(0);
    expect(r.listed).toBe(files.join('\n') + '\n');
  });

  it('leaves a failed test to the gate that judges it', () => {
    const r = prove(files.map((name) => ({ name, assertionResults: [{ status: 'failed' }] })));
    expect(r.status, r.out).toBe(0);
  });

  it('refuses a planned file nothing collected, by name', () => {
    const r = prove([{ name: files[0]!, assertionResults: passed }]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`${files[1]}: never collected`);
  });

  it('refuses a skipped binary (every test skipped) and a partly skipped file', () => {
    for (const statuses of [['skipped'], ['passed', 'pending'], ['todo']]) {
      const r = prove([
        { name: files[0]!, assertionResults: passed },
        { name: files[1]!, assertionResults: statuses.map((status) => ({ status })) },
      ]);
      expect(r.status, statuses.join()).toBe(1);
      expect(r.listed).toBe('');
    }
  });

  it('refuses a file collected with no tests', () => {
    const r = prove([
      { name: files[0]!, assertionResults: passed },
      { name: files[1]!, assertionResults: [] },
    ]);
    expect(r.status).toBe(1);
  });

  it('refuses a filter that collected something it did not plan', () => {
    const r = prove([
      ...files.map((name) => ({ name, assertionResults: passed })),
      { name: 'apps/server/src/c/__tests__/other.test.ts', assertionResults: passed },
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain('collected but not planned');
  });

  it('refuses a missing report and an empty plan', () => {
    expect(prove(null).status).toBe(1);
    expect(
      prove(
        files.map((name) => ({ name, assertionResults: passed })),
        []
      ).status
    ).toBe(1);
  });
});

describe('the job and the fan-in', () => {
  it('test-binary needs the planner, has no job-level if, and runs the suites through turbo test', () => {
    expect(binaryJob).toMatch(/^ {2}test-binary:\n {4}needs: \[test-shard-count\]\n/);
    expect(binaryJob).not.toMatch(/^ {4}if:/m);
    expect(binaryJob).toMatch(/^ {4}timeout-minutes: \d+$/m);
    const sweep = binaryJob.split('\n').find((line) => line.includes('pnpm exec turbo test'));
    expect(sweep).toBeDefined();
    expect(sweep).toContain('--retry=$retry');
    expect(sweep).toContain('--reporter=../../scripts/vitest-flake-reporter.ts');
    expect(sweep).toContain('--outputFile.json=vitest-shard-report.json');
    expect(sweep).not.toMatch(/--passWithNoTests|--shard|--exclude|--summarize/);
    // Vitest matches a filter against the path relative to the package, so a
    // repo-relative path matches nothing from apps/server; absolute ones do.
    expect(binaryJob).toContain(
      'mapfile -t files < <(sed "s|^|$PWD/|" "$RUNNER_TEMP/binary-files.txt")'
    );
    expect(binaryJob).toContain(
      'node scripts/assert-binary-suites-ran.mjs "$RUNNER_TEMP/binary-files.txt" shard-files-binary.txt'
    );
    expect(binaryJob).toContain('name: shard-files-binary\n');
    expect(binaryJob).not.toMatch(/secrets\./);
    // Every action pinned by full SHA.
    for (const [, ref] of binaryJob.matchAll(/uses: [\w./-]+@(\S+)/g)) {
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('the shards upload no binary list of their own, so the fan-in reads one per job', () => {
    expect(workflow.match(/name: shard-files-binary\n/g)).toHaveLength(1);
  });

  it('the fan-in needs test-binary and fails on anything but success', () => {
    expect(fanIn).toMatch(/^ {4}needs: \[[^\]]*\btest-binary\b[^\]]*\]$/m);
    expect(fanIn).toContain('result="${{ needs.test-binary.result }}"');
    expect(stepRun(fanIn, 'Require the binary CLI suites green')).toContain(
      '[ "$result" = "success" ]'
    );
  });

  it('the union check requires every binary suite in the tree by name', () => {
    const union = stepRun(fanIn, "Prove the shards' union covers every package");
    expect(union).toContain(
      "git ls-files -- 'apps/*.binary.test.ts' 'packages/*.binary.test.ts' > \"$RUNNER_TEMP/binary-test-files.txt\""
    );
    expect(union).toContain('--require-files "$RUNNER_TEMP/binary-test-files.txt"');
  });
});
