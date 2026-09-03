/**
 * Pins `scripts/vitest-flake-reporter.ts` against a SEEDED flake, and pins the
 * workflow wiring that makes it reach the merge-queue leg at all.
 *
 * The reporter's whole job is to make an absorbed retry visible, and every way
 * it can break is quiet: a reporter that records nothing prints nothing, which
 * is indistinguishable from a clean run, and a passthrough that stops loading
 * it looks exactly the same again. So the cases below drive the REAL seam —
 * they spawn real `vitest` runs over a real fixture whose first attempt really
 * fails — rather than asserting against a mocked task tree, which would only
 * encode this file's guess at vitest's retry bookkeeping.
 *
 * One case exists purely to keep the reporter honest about what it is worth:
 * `the same flake is invisible without the reporter` runs the identical fixture
 * with only the default reporter and asserts the run reports two passes and
 * names nothing. That is today's behavior on the queue leg, and it is the
 * before-picture the rest of the file is measured against.
 *
 * The fixture is generated into a throwaway directory under `scripts/` rather
 * than committed. It has to live inside the repo so `import 'vitest'` resolves
 * from the root `node_modules`, and it must not be a committed `*.spec.ts`
 * tree, because a file whose entire purpose is to fail on its first attempt is
 * a landmine for any tool that globs test files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FLAKE_REPORT_FILENAME, type FlakeReport } from '../vitest-flake-reporter.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const WORKFLOW_REL = '.github/workflows/test.yml';

/** The reporter path as seen from the fixture directory (one level under `scripts/`). */
const REPORTER_FROM_FIXTURE = path.join('..', 'vitest-flake-reporter.ts');

/** The exact flag the merge-queue leg must pass; the packages are two deep, so one path serves all. */
const REPORTER_PASSTHROUGH = '--reporter=../../scripts/vitest-flake-reporter.ts';

const FIXTURE_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['*.spec.ts'], environment: 'node' } });
`;

// Fails on its first attempt and passes on every one after it, by counting
// attempts in a file the spawning test hands it. A timer or a random draw would
// make this suite the flaky one.
const FIXTURE_FLAKY = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const statePath = process.env.FLAKE_FIXTURE_STATE as string;

describe('seeded flake', () => {
  it('fails cold and passes on the retry', () => {
    const attempts = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0;
    writeFileSync(statePath, String(attempts + 1), 'utf8');
    expect(attempts).toBeGreaterThan(0);
  });
});
`;

const FIXTURE_CLEAN = `import { expect, it } from 'vitest';

it('passes on the first attempt', () => {
  expect(1).toBe(1);
});
`;

const FIXTURE_BROKEN = `import { expect, it } from 'vitest';

it('fails on every attempt', () => {
  expect(1).toBe(2);
});
`;

let fixtureDir: string;
let runCount = 0;

/** The artifact the reporter writes into the directory vitest ran in. */
function reportPath(): string {
  return path.join(fixtureDir, FLAKE_REPORT_FILENAME);
}

interface FixtureRun {
  status: number | null;
  output: string;
}

/**
 * Run the fixture suite the way the merge-queue leg runs a package's suite.
 *
 * @param specs - Fixture spec files to select, as vitest filename filters.
 * @param options - `retry` is the CLI budget; `withReporter` loads the reporter under test.
 */
function runFixture(
  specs: string[],
  options: { retry: number; withReporter: boolean }
): FixtureRun {
  rmSync(reportPath(), { force: true });
  runCount += 1;

  const result = spawnSync(
    process.execPath,
    [
      VITEST_BIN,
      'run',
      ...specs,
      `--retry=${options.retry}`,
      '--reporter=default',
      ...(options.withReporter ? [`--reporter=${REPORTER_FROM_FIXTURE}`] : []),
    ],
    {
      cwd: fixtureDir,
      encoding: 'utf8',
      env: {
        // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; the spawned vitest needs the real PATH and HOME
        ...process.env,
        // A fresh counter per run: the seeded flake must fail cold every time.
        FLAKE_FIXTURE_STATE: path.join(fixtureDir, `attempts-${runCount}.txt`),
        // Vitest colours its output when it thinks a TTY is watching, and the
        // assertions below match on plain text.
        NO_COLOR: '1',
      },
    }
  );

  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The artifact the last run wrote, parsed. */
function readReport(): FlakeReport {
  return JSON.parse(readFileSync(reportPath(), 'utf8')) as FlakeReport;
}

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(REPO_ROOT, 'scripts', '.flake-fixture-'));
  writeFileSync(path.join(fixtureDir, 'vitest.config.ts'), FIXTURE_CONFIG, 'utf8');
  writeFileSync(path.join(fixtureDir, 'flaky.spec.ts'), FIXTURE_FLAKY, 'utf8');
  writeFileSync(path.join(fixtureDir, 'clean.spec.ts'), FIXTURE_CLEAN, 'utf8');
  writeFileSync(path.join(fixtureDir, 'broken.spec.ts'), FIXTURE_BROKEN, 'utf8');
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('the reporter names what a retry absorbed', () => {
  it('names the test that only passed on the retry, and leaves the run green', () => {
    const run = runFixture(['flaky.spec.ts', 'clean.spec.ts'], { retry: 1, withReporter: true });

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('1 test(s) only passed on a retry');
    expect(run.output).toContain(
      'flaky.spec.ts › seeded flake > fails cold and passes on the retry'
    );

    expect(readReport().flaky).toEqual([
      {
        file: 'flaky.spec.ts',
        test: 'seeded flake > fails cold and passes on the retry',
        retries: 1,
      },
    ]);
  });

  it('the same flake is invisible without the reporter', () => {
    const run = runFixture(['flaky.spec.ts', 'clean.spec.ts'], { retry: 1, withReporter: false });

    // Green, two passes, and not one word about the attempt that failed. This
    // is the merge-queue leg's behavior before this change.
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Tests  2 passed (2)');
    expect(run.output).not.toContain('only passed on a retry');
    expect(existsSync(reportPath())).toBe(false);
  });

  it('says nothing on a clean run, and still leaves a report behind', () => {
    const run = runFixture(['clean.spec.ts'], { retry: 1, withReporter: true });

    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain('only passed on a retry');
    // Empty rather than absent: the workflow reads "no file anywhere" as a
    // broken passthrough, which it can only do if a clean run writes one.
    expect(readReport().flaky).toEqual([]);
  });

  it('a test that fails both times stays red and is named by nothing', () => {
    const run = runFixture(['broken.spec.ts'], { retry: 1, withReporter: true });

    expect(run.status, run.output).not.toBe(0);
    expect(run.output).not.toContain('only passed on a retry');
    expect(readReport().flaky).toEqual([]);
  });
});

describe('the merge-queue leg is wired to the reporter', () => {
  const workflow = readFileSync(path.join(REPO_ROOT, WORKFLOW_REL), 'utf8');

  /** The shard job's suite command — the one line that carries the passthrough. */
  const suiteCommand = workflow.split('\n').find((line) => line.includes('turbo test --summarize'));

  it('passes the reporter and a retry budget of one to every package', () => {
    expect(suiteCommand, `no \`turbo test --summarize\` line in ${WORKFLOW_REL}`).toBeTypeOf(
      'string'
    );
    // Without these two the reporter is dead code: no retry means nothing is
    // ever absorbed, and no reporter means nothing names what was.
    expect(suiteCommand).toContain('--retry=1');
    expect(suiteCommand).toContain(REPORTER_PASSTHROUGH);
  });

  it('fails the shard when no package produced a report', () => {
    // The wiring proof on the CI side: the reporter writes unconditionally, so
    // an absent artifact means it never loaded. If this assertion is what broke,
    // do not delete it — a silent flake reporter is the whole failure mode. The
    // filename comes from the reporter itself, so renaming it there without
    // updating the workflow fails here rather than in a merge group.
    expect(workflow).toContain(FLAKE_REPORT_FILENAME);
    expect(workflow).toContain('the flake reporter passthrough is broken');
  });

  it('every workspace package sits two directories deep, which is what the one relative path assumes', () => {
    // Only the `packages:` block — a future top-level key with a list of its
    // own must not be read as a workspace glob.
    const lines = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8').split('\n');
    const start = lines.findIndex((line) => line.startsWith('packages:'));
    expect(start, 'pnpm-workspace.yaml has no `packages:` block').toBeGreaterThanOrEqual(0);

    const globs: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '') continue;
      if (!/^\s/.test(line)) break;
      const glob = /^\s*-\s*'?([^'\s]+)'?\s*$/.exec(line)?.[1];
      if (glob) globs.push(glob);
    }

    expect(globs.length).toBeGreaterThan(0);
    // `--reporter=../../scripts/...` resolves from a package root. A workspace
    // glob at any other depth would silently break the reporter for that
    // package — vitest would fail to load it and the shard would go red with a
    // resolution error rather than a test failure.
    for (const glob of globs) {
      expect(glob.split('/'), `workspace glob "${glob}" is not two deep`).toHaveLength(2);
    }
  });
});

/**
 * The aggregation step, RUN rather than read.
 *
 * The step is inline bash in a workflow, so nothing would otherwise execute it
 * until a merge group did — and its failure modes are all quiet ones that end
 * in a green check. It is lifted out of the YAML by name and run against
 * synthetic package trees, which is the only way to tell "reported no flakes"
 * apart from "could not tell, said no flakes".
 */
describe('the shard step that names what the reporters found', () => {
  const workflow = readFileSync(path.join(REPO_ROOT, WORKFLOW_REL), 'utf8');
  const STEP_NAME = 'Name the tests that only passed on a retry';

  /**
   * The step's `run:` block, dedented, with the shard matrix expression filled
   * in so the script is runnable outside Actions.
   */
  function stepScript(): string {
    const lines = workflow.split('\n');
    const nameAt = lines.findIndex((line) => line.trim() === `- name: ${STEP_NAME}`);
    expect(nameAt, `no step named "${STEP_NAME}" in ${WORKFLOW_REL}`).toBeGreaterThanOrEqual(0);

    const runAt = lines.findIndex((line, i) => i > nameAt && line.trim() === 'run: |');
    expect(runAt, `the "${STEP_NAME}" step is no longer a \`run: |\` block`).toBeGreaterThan(
      nameAt
    );

    const indent = (lines[runAt] as string).search(/\S/) + 2;
    const body: string[] = [];
    for (const line of lines.slice(runAt + 1)) {
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      if (line.search(/\S/) < indent) break;
      body.push(line.slice(indent));
    }

    // Deliberately NOT asserted here: that the script says `set -o pipefail`.
    // That is one mechanism for not certifying a report nothing could read, and
    // the case below tests the PROPERTY instead — so any other way of
    // reintroducing the fail-open is caught too, and any other fix passes.
    expect(body.join('\n').trim(), 'the step has an empty `run:` block').not.toBe('');
    return body.join('\n').replaceAll('${{ matrix.shard }}', '2');
  }

  let stepDir: string;

  interface StepRun {
    status: number | null;
    output: string;
    summary: string;
  }

  /**
   * Run the real step over a synthetic tree.
   *
   * @param reports - Package directory (`apps/x`, `packages/y`) to raw report file contents.
   */
  function runStep(reports: Record<string, string>): StepRun {
    rmSync(stepDir, { recursive: true, force: true });
    // Both roots always exist: `find apps packages` is an error, not an empty
    // result, when one of them is missing.
    mkdirSync(path.join(stepDir, 'apps'), { recursive: true });
    mkdirSync(path.join(stepDir, 'packages'), { recursive: true });
    for (const [pkg, contents] of Object.entries(reports)) {
      mkdirSync(path.join(stepDir, pkg), { recursive: true });
      writeFileSync(path.join(stepDir, pkg, FLAKE_REPORT_FILENAME), contents, 'utf8');
    }

    const summaryPath = path.join(stepDir, 'step-summary.md');
    writeFileSync(summaryPath, '', 'utf8');
    const scriptPath = path.join(stepDir, 'step.sh');
    writeFileSync(scriptPath, stepScript(), 'utf8');

    // `bash -e` is the shell GitHub runs a `run:` block with; anything else
    // would be testing a different script.
    const result = spawnSync('bash', ['-e', scriptPath], {
      cwd: stepDir,
      encoding: 'utf8',
      // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; bash and jq have to be found on the real PATH
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    });

    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      summary: readFileSync(summaryPath, 'utf8'),
    };
  }

  /** A well-formed report for one package. */
  function report(pkg: string, flaky: FlakeReport['flaky']): string {
    return JSON.stringify({ cwd: `/home/runner/work/dorkos/dorkos/${pkg}`, flaky });
  }

  beforeAll(() => {
    stepDir = mkdtempSync(path.join(tmpdir(), 'dorkos-flake-step-'));
  });

  afterAll(() => {
    rmSync(stepDir, { recursive: true, force: true });
  });

  it('fails when no package wrote a report at all', () => {
    const run = runStep({});

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('the flake reporter passthrough is broken');
  });

  it('fails LOUDLY on a report it cannot parse, rather than reporting no flakes', () => {
    const run = runStep({
      'apps/server': report('apps/server', []),
      // Truncated mid-write: the shape a killed or out-of-disk run leaves.
      'packages/relay': '{ "cwd": "/home/runner/work/dorkos/dorkos/packages/relay", "flaky": [',
    });

    // Without `set -o pipefail` this printed "no test needed a retry to pass"
    // and exited 0 — jq's failure was masked by `sort` succeeding over the
    // empty stream it was handed.
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain('could not be read');
    expect(run.output).not.toContain('no test needed a retry to pass');
  });

  it('says one quiet line and annotates nothing when no test needed a retry', () => {
    const run = runStep({
      'apps/server': report('apps/server', []),
      'packages/relay': report('packages/relay', []),
    });

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('shard 2/4: no test needed a retry to pass.');
    expect(run.output).not.toContain('::warning');
    expect(run.summary).toBe('');
  });

  it('names every absorbed retry in the log, the summary and an annotation', () => {
    const run = runStep({
      'apps/server': report('apps/server', []),
      'packages/relay': report('packages/relay', [
        { file: 'src/__tests__/watcher-manager.test.ts', test: 'watcher > emits', retries: 1 },
      ]),
    });

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('WARNING — 1 test(s) only passed on a retry');
    expect(run.output).toContain(
      '::warning title=vitest test passed only on a retry::packages/relay/src/__tests__/watcher-manager.test.ts › watcher > emits (1 retry)'
    );
    expect(run.summary).toContain('### Shard 2/4 — 1 test(s) only passed on a retry');
    expect(run.summary).toContain('DOR-1007');
  });

  it('caps the annotations at ten and says how many it did not raise', () => {
    const flaky = Array.from({ length: 13 }, (_, i) => ({
      file: `src/__tests__/f${i}.test.ts`,
      test: `suite > case ${i}`,
      retries: 1,
    }));
    const run = runStep({ 'packages/relay': report('packages/relay', flaky) });

    expect(run.status, run.output).toBe(0);
    // Ten named plus one overflow line — GitHub stops displaying warning
    // annotations past ten per step, and this run also proves the cap does not
    // SIGPIPE the writer feeding it now that pipefail is on.
    expect(run.output.match(/::warning/g)).toHaveLength(11);
    expect(run.output).toContain('and 3 more');
    // Every one of the thirteen is still in the summary, capped or not.
    for (const record of flaky) {
      expect(run.summary).toContain(record.test);
    }
  });

  it('ignores a stray report that is not a package root', () => {
    const run = runStep({
      'packages/relay': report('packages/relay', []),
      // `-mindepth 2 -maxdepth 2` is what keeps a nested copy — a fixture tree,
      // a stale dist — from being read as a package's verdict.
      'packages/relay/src/fixtures': report('packages/relay/src/fixtures', [
        { file: 'nested.test.ts', test: 'not a package', retries: 1 },
      ]),
    });

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('no test needed a retry to pass.');
    expect(run.output).not.toContain('not a package');
  });
});
