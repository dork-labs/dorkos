/**
 * The scope step of test.yml's `community-packaged` job, as it actually ships
 * (DOR-2220).
 *
 * `community-packaged` is a REQUIRED check. On a pull request it runs the
 * packaged Community proof only when the diff can reach it; on every other event
 * it always runs it. scripts/test-community-packaged-scope.sh pins the LIST; this
 * file pins the STEP that feeds it, by extracting the `run:` block from the YAML
 * and executing that block in a throwaway git repository shaped like the
 * checkout each event produces. What it holds still:
 *
 *   - the queue and the canary always run the proof, whatever changed;
 *   - a pull request touching the community slice runs it, one that does not
 *     reports green without it;
 *   - every way the pull-request path can fail to decide (no base commit, no
 *     scope script in the tree, a scope script that errors) runs the proof and
 *     never skips it or reds the required check;
 *   - the step has no `if:` of its own, and the proof and its upload are gated
 *     on its output rather than on the event.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
const STEP = 'Decide whether this change can reach the packaged proof';

/** The `community-packaged` job's text, up to the next top-level job. */
function jobText(): string {
  const start = workflow.indexOf('\n  community-packaged:\n');
  expect(start, 'test.yml has no community-packaged job').toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** One step's YAML, from its `- name:` line to the next step. */
function stepText(name: string): string {
  const job = jobText();
  const at = job.indexOf(`      - name: ${name}\n`);
  expect(at, `community-packaged has no step "${name}"`).toBeGreaterThan(-1);
  const rest = job.slice(at);
  const next = rest.slice(1).search(/\n {6}- /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The scope step's `run: |` body, de-indented. */
function scopeBody(): string {
  const body = stepText(STEP).match(/ {8}run: \|\n([\s\S]*)$/)?.[1];
  expect(body, 'the scope step has no run block').toBeTruthy();
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

interface Checkout {
  /** Include scripts/community-packaged-scope.sh in the tree (default true). */
  scopeScript?: boolean | string;
  /** The files the pull request changes. */
  changes: string[];
  /** A test-merge commit with a parent (true) or a lone root commit (false). */
  withBase?: boolean;
  /** Files the base branch changed after the pull request branched. */
  baseChanges?: string[];
  /** End on the test-merge commit (true) or on the PR's own commit (false). */
  merge?: boolean;
}

/**
 * A repository whose HEAD looks like what actions/checkout gives a pull
 * request: a merge of the PR's head onto its base, so `HEAD^1` is the base.
 */
function checkout({
  scopeScript = true,
  changes,
  withBase = true,
  baseChanges = [],
  merge = true,
}: Checkout): string {
  const repo = mkdtempSync(join(tmpdir(), 'community-packaged-scope-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  if (scopeScript === true) {
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    copyFileSync(
      join(root, 'scripts/community-packaged-scope.sh'),
      join(repo, 'scripts/community-packaged-scope.sh')
    );
  } else if (typeof scopeScript === 'string') {
    write(repo, 'scripts/community-packaged-scope.sh', scopeScript);
  }
  write(repo, 'README.md', 'base\n');
  if (!withBase) {
    for (const path of changes) write(repo, path, 'change\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'lone root');
    return repo;
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'pr');
  for (const path of changes) write(repo, path, 'change\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'pr change');
  if (!merge) return repo;
  git(repo, 'checkout', '-q', 'main');
  for (const path of baseChanges) write(repo, path, 'base change\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'main moved on');
  git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'pr');
  return repo;
}

/** Run the shipped step in `repo` under `event`; return its `run=` output. */
function decide(repo: string, event: string): { code: number; run: string; log: string } {
  const output = join(repo, '.github-output');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['-c', scopeBody()], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: repo, EVENT: event, GITHUB_OUTPUT: output },
  });
  const run = readFileSync(output, 'utf8').match(/^run=(.*)$/m)?.[1] ?? '';
  return { code: r.status ?? 1, run, log: `${r.stdout}${r.stderr}` };
}

describe('community-packaged scope step', () => {
  it('runs the proof on a pull request that touches the community slice', () => {
    const repo = checkout({ changes: ['apps/community/acceptance/driver.spec.ts'] });
    expect(decide(repo, 'pull_request')).toMatchObject({ code: 0, run: 'true' });
  });

  it('reports green without the proof on a pull request that cannot reach it', () => {
    const repo = checkout({ changes: ['docs/guides/getting-started.mdx', 'apps/client/src/a.ts'] });
    const r = decide(repo, 'pull_request');
    expect(r).toMatchObject({ code: 0, run: 'false' });
    expect(r.log).toContain('did not run here');
  });

  it('diffs only the pull request, not what moved on the base', () => {
    // A community change that landed on the base after the PR branched is in
    // the test-merge tree, but it is not this pull request's change.
    const repo = checkout({
      changes: ['docs/x.md'],
      baseChanges: ['apps/community/src/landed-elsewhere.ts'],
    });
    expect(decide(repo, 'pull_request').run).toBe('false');
  });

  it.each(['merge_group', 'schedule', 'workflow_dispatch'])(
    'always runs the proof on %s, whatever changed',
    (event) => {
      const repo = checkout({ changes: ['docs/x.md'] });
      expect(decide(repo, event)).toMatchObject({ code: 0, run: 'true' });
    }
  );

  it('runs the proof when there is no base commit to diff against', () => {
    const repo = checkout({ changes: ['docs/x.md'], withBase: false });
    expect(decide(repo, 'pull_request')).toMatchObject({ code: 0, run: 'true' });
  });

  it('runs the proof when HEAD is not a test-merge commit', () => {
    // HEAD^1 exists but is the PR's own parent, not the base it was merged
    // onto, so a diff against it would not be the pull request's change.
    const repo = checkout({ changes: ['docs/x.md'], merge: false });
    const r = decide(repo, 'pull_request');
    expect(r).toMatchObject({ code: 0, run: 'true' });
    expect(r.log).toContain('no test-merge commit');
  });

  it('matches a non-ASCII path as itself, not as a quoted escape', () => {
    const repo = checkout({ changes: ['apps/community/src/browser/naïve-välkommen.tsx'] });
    expect(decide(repo, 'pull_request')).toMatchObject({ code: 0, run: 'true' });
  });

  it('runs the proof when the tree predates the scope script', () => {
    const repo = checkout({ changes: ['docs/x.md'], scopeScript: false });
    expect(decide(repo, 'pull_request')).toMatchObject({ code: 0, run: 'true' });
  });

  it('runs the proof, green, when the scope script fails or answers nonsense', () => {
    const failing = checkout({ changes: ['docs/x.md'], scopeScript: 'exit 3\n' });
    expect(decide(failing, 'pull_request')).toMatchObject({ code: 0, run: 'true' });
    const garbled = checkout({ changes: ['docs/x.md'], scopeScript: 'echo maybe\n' });
    expect(decide(garbled, 'pull_request')).toMatchObject({ code: 0, run: 'true' });
  });

  it('never skips itself, and gates the proof on its answer rather than the event', () => {
    expect(stepText(STEP)).not.toMatch(/^ {8}if:/m);
    expect(stepText(STEP)).toMatch(/^ {8}id: scope$/m);
    expect(stepText('Build and test without public network access')).toMatch(
      /^ {8}if: steps\.scope\.outputs\.run == 'true'$/m
    );
    expect(stepText('Preserve packaged community reports')).toMatch(
      /^ {8}if: always\(\) && steps\.scope\.outputs\.run == 'true'$/m
    );
    // The job-level shape a required check depends on: no `if:`, no `paths:`.
    expect(jobText()).not.toMatch(/^ {4}if:/m);
    expect(workflow).not.toMatch(/^ {4}paths:/m);
  });

  it('checks out the base commit a pull request is diffed against', () => {
    expect(jobText()).toMatch(/- uses: actions\/checkout@v\d+\n {8}with:\n {10}fetch-depth: 2\n/);
  });
});
