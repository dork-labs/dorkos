/**
 * Guard for how the shell fixture suites are found and run.
 *
 * The suites (`scripts/test-*.sh`, `.agents/skills/<skill>/scripts/test-*.sh`)
 * belong to no pnpm workspace, so turbo cannot reach them. They used to be
 * named by hand twice: a line in `scripts/run-scripts-suites.sh` (what
 * `pnpm test:scripts`, and so `pnpm verify`, runs) and a step in
 * `.github/workflows/scripts-test.yml` (what CI runs). The two lists drifted
 * (DOR-1515: CI ran eleven suites, `pnpm verify` ten, and the missing one was
 * the process-guard hook's), and every pair of PRs that each added a suite
 * conflicted at the same lines of both files, which took them out of the merge
 * queue (#4206 and #4258, Nov 24; ledger fixture-suites-by-glob).
 *
 * Now `run-scripts-suites.sh` finds the suites by glob, and both the local run
 * and both CI jobs call it (`--suites fixtures` in the required `fixtures` job,
 * `--suites harness` in `harness`, for suites that declare
 * `# scripts-suite-lane: harness`). So the invariants are:
 *
 *   1. what the runner discovers is exactly every suite file on disk, and is
 *      not empty;
 *   2. nobody names a suite by hand any more, in the workflow or the runner,
 *      so there is no second list to drift;
 *   3. each CI job calls the runner for its lane, and `test:scripts` calls it
 *      for every lane;
 *   4. the runner fails when a suite fails (after running the rest), and when
 *      it finds no suites at all.
 *
 * A vitest test rather than a shell fixture: a `scripts/test-*.sh` guard would
 * be one of the suites it guards. `scripts/vitest.config.ts` globs every
 * `.test.ts` under `__tests__`, and that run is the last link of `test:scripts`
 * and the `harness` job's `Unit tests` step.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOW_REL = '.github/workflows/scripts-test.yml';
const RUNNER_REL = 'scripts/run-scripts-suites.sh';
const LANES = ['fixtures', 'harness'] as const;

const HOW_TO_ADD =
  'Suites are discovered by glob (scripts/test-*.sh and .agents/skills/*/scripts/test-*.sh), ' +
  'so a new suite needs no registration: remove the step or line naming it. A suite that ' +
  'needs node_modules puts `# scripts-suite-lane: harness` in its first 15 lines.';

/** Text with every comment line dropped, so prose naming a suite never counts. */
function codeLines(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Every suite named by hand in a chunk of text: a path whose file name starts with `test-`. */
function namedSuites(text: string): string[] {
  const matches = text.matchAll(/(?<![\w.-])(?:[\w.-]+\/)*test-[A-Za-z0-9._-]+\.sh\b/g);
  return [...new Set([...matches].map((m) => m[0]))].sort();
}

/** Every suite file on disk, by the rule the runner's globs state. */
function suitesOnDisk(): string[] {
  const isSuite = (name: string) => /^test-.*\.sh$/.test(name);
  const found = readdirSync(path.join(repoRoot, 'scripts'))
    .filter(isSuite)
    .map((name) => `scripts/${name}`);
  const skills = path.join(repoRoot, '.agents/skills');
  for (const skill of readdirSync(skills)) {
    const dir = path.join(skills, skill, 'scripts');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(isSuite)) {
      found.push(`.agents/skills/${skill}/scripts/${name}`);
    }
  }
  return found.sort();
}

/** The runner's `--list` output as [lane, path] pairs. */
function discovered(): Array<[string, string]> {
  const res = spawnSync('bash', [RUNNER_REL, '--list'], { cwd: repoRoot, encoding: 'utf8' });
  expect(res.status, `${RUNNER_REL} --list failed: ${res.stderr}`).toBe(0);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ', 2) as [string, string]);
}

/** The text of one top-level job in the workflow, up to the next job. */
function jobBlock(text: string, job: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  expect(start, `${WORKFLOW_REL} has no \`${job}\` job`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('shell fixture suites', () => {
  it('the runner discovers exactly the suites on disk, and at least one', () => {
    const found = discovered();
    const paths = found.map(([, p]) => p).sort();
    const onDisk = suitesOnDisk();
    expect(
      onDisk.length,
      'no suite files on disk; the rule in this test is broken'
    ).toBeGreaterThan(0);
    const missed = onDisk.filter((s) => !paths.includes(s));
    expect(
      missed,
      `${RUNNER_REL} does not discover ${missed.join(', ')}. Its globs must match every ` +
        'scripts/test-*.sh and .agents/skills/*/scripts/test-*.sh, or a suite runs for nobody ' +
        '(DOR-1515). A file that is not a suite goes in its SUITE_EXCLUDE.'
    ).toEqual([]);
    const extra = paths.filter((s) => !onDisk.includes(s));
    expect(
      extra,
      `${RUNNER_REL} discovers files this test does not know: ${extra.join(', ')}`
    ).toEqual([]);
    for (const [lane, p] of found) {
      expect(LANES, `${p} declares lane '${lane}'`).toContain(lane);
    }
  });

  it('every lane CI runs has at least one suite', () => {
    const found = discovered();
    for (const lane of LANES) {
      expect(
        found.filter(([l]) => l === lane).length,
        `lane ${lane} is empty; check the \`# scripts-suite-lane:\` markers`
      ).toBeGreaterThan(0);
    }
  });

  it('no workflow step or runner line names a suite by hand', () => {
    for (const rel of [WORKFLOW_REL, RUNNER_REL]) {
      const named = namedSuites(codeLines(rel));
      expect(named, `${rel} names suite(s) by hand: ${named.join(', ')}. ${HOW_TO_ADD}`).toEqual(
        []
      );
    }
  });

  it('each CI job runs its lane through the runner, and test:scripts runs every lane', () => {
    const workflow = codeLines(WORKFLOW_REL);
    for (const lane of LANES) {
      expect(
        jobBlock(workflow, lane),
        `the \`${lane}\` job must run \`bash ${RUNNER_REL} --suites ${lane}\`. ${HOW_TO_ADD}`
      ).toContain(`bash ${RUNNER_REL} --suites ${lane}\n`);
    }
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    // Not a soft check: renamed away, `pnpm verify` would run no suite at all.
    expect(pkg.scripts?.['test:scripts'], `root test:scripts must run ${RUNNER_REL}`).toBe(
      `bash ${RUNNER_REL}`
    );
    expect(codeLines(RUNNER_REL)).toContain('\n    run_suites all\n');
  });

  describe('the runner', () => {
    /** A throwaway tree holding a copy of the runner and the given suites. */
    function tree(suites: Record<string, string>): string {
      const root = mkdtempSync(path.join(tmpdir(), 'run-scripts-suites-'));
      mkdirSync(path.join(root, 'scripts'));
      copyFileSync(path.join(repoRoot, RUNNER_REL), path.join(root, RUNNER_REL));
      for (const [rel, body] of Object.entries(suites)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), `#!/usr/bin/env bash\n${body}\n`);
        chmodSync(path.join(root, rel), 0o755);
      }
      return root;
    }

    function run(root: string, lane: string) {
      const env = { ...process.env };
      delete env.GITHUB_ACTIONS;
      delete env.GITHUB_STEP_SUMMARY;
      return spawnSync('bash', [RUNNER_REL, '--suites', lane], {
        cwd: root,
        encoding: 'utf8',
        env,
      });
    }

    it('runs every suite in the lane past a failure, then fails naming it', () => {
      const root = tree({
        'scripts/test-a.sh': 'echo ran-a',
        'scripts/test-b.sh': 'echo ran-b; exit 3',
        'scripts/test-c.sh': 'echo ran-c',
        'scripts/test-h.sh': '# scripts-suite-lane: harness\necho ran-h',
        '.agents/skills/x/scripts/test-s.sh': 'echo ran-s',
      });
      try {
        const res = run(root, 'fixtures');
        expect(res.status).toBe(1);
        for (const ran of ['ran-a', 'ran-b', 'ran-c', 'ran-s']) expect(res.stdout).toContain(ran);
        expect(res.stdout).not.toContain('ran-h');
        expect(res.stdout).toContain('4 run, 3 passed, 1 failed');
        expect(res.stdout).toMatch(/Failing suites.*\n\s+scripts\/test-b\.sh\n/);

        const harness = run(root, 'harness');
        expect(harness.status).toBe(0);
        expect(harness.stdout).toContain('ran-h');
        expect(harness.stdout).toContain('1 run, 1 passed, 0 failed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('fails when it finds no suites, or a suite names an unknown lane', () => {
      const empty = tree({});
      const harnessless = tree({ 'scripts/test-a.sh': 'true' });
      const typo = tree({ 'scripts/test-a.sh': '# scripts-suite-lane: harnes\ntrue' });
      try {
        expect(run(empty, 'fixtures').status).not.toBe(0);
        expect(run(harnessless, 'harness').status).not.toBe(0);
        const bad = run(typo, 'all');
        expect(bad.status).not.toBe(0);
        expect(bad.stderr).toContain("unknown lane 'harnes'");
      } finally {
        for (const r of [empty, harnessless, typo]) rmSync(r, { recursive: true, force: true });
      }
    });
  });
});
