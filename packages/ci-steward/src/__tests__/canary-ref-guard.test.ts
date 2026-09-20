/**
 * The main canary's ref guard, as it actually ships (DOR-2150).
 *
 * `test.yml`, `browser-test.yml`, `typecheck.yml` and `lint.yml` run against
 * `main` HEAD on a `schedule` and carry `workflow_dispatch`. A dispatch is
 * ref-free, so `--ref <a PR's branch>` would run the suite against that branch
 * and post the check run — under the name of a REQUIRED context — on that pull
 * request's head. Every canary job's first step refuses that.
 *
 * THIS SUITE READS THE REAL WORKFLOWS, not a script beside them. An earlier
 * version of the guard was a `bash scripts/assert-canary-ref.sh` step placed
 * before `actions/checkout`, where the workspace is still empty: it would have
 * exited 127 on every event and reddened four required checks on every pull
 * request and every queue build. The fixtures at the time resolved that script
 * by absolute path, so they passed and said nothing at all about the workspace
 * it shipped into. That is the failure this file is shaped against — it
 * extracts the `run:` block from the YAML, executes THAT, and pins where it
 * sits.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadHandFiles } from '../load.ts';
import { loadWorkflows } from '../workflows.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const GUARD = 'A canary run is against main';

/**
 * Jobs of a canary workflow that are NOT on the canary path, with the reason.
 *
 * DERIVED, NOT LISTED. An earlier version of this file named the eight guarded
 * jobs, which meant a ninth job added to a canary workflow would have shipped
 * with no guard and nothing would have said so — the opt-in-by-name shape the
 * `stewarding-ci-pipeline` skill warns about, and the same one `canary.exempt`
 * exists to close in `ci/config.yaml`. The sites are now every job of every
 * workflow in `canary.workflows`, minus this table, so a new job is guarded or
 * it is excused here in writing.
 */
const NOT_ON_THE_CANARY_PATH: Record<string, Record<string, string>> = {
  'browser-test.yml': {
    'copy-spec-drift':
      'Diffs a change against its base SHA, which no scheduled run carries, so it does not run on a canary event at all.',
  },
};

const workflows = loadWorkflows(REPO, '.github/workflows', (e) => {
  throw e;
});

const config = loadHandFiles(REPO).files!.config;

function jobOf(file: string, id: string) {
  const wf = workflows.find((w) => w.file === file);
  expect(wf, `no ${file}`).toBeDefined();
  const job = wf!.jobs.find((j) => j.id === id);
  expect(job, `${file} has no job ${id}`).toBeDefined();
  return job!;
}

const sites = config.canary.workflows.flatMap((file) => {
  const wf = workflows.find((w) => w.file === file);
  if (!wf) throw new Error(`canary.workflows names ${file}, which does not exist`);
  const excused = NOT_ON_THE_CANARY_PATH[file] ?? {};
  return wf.jobs.filter((j) => !(j.id in excused)).map((j) => [file, j.id] as const);
});

/** Run the shipped block under a given event and ref. */
function runGuard(body: string, env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync('bash', ['-c', body], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('the ref guard is present, first, and self-contained', () => {
  it.each(sites)('%s / %s carries it as its FIRST step', (file, job) => {
    expect(jobOf(file, job).steps[0]?.key, `${file} / ${job}: the guard must be step 1`).toBe(
      GUARD
    );
  });

  it.each(sites)('%s / %s needs no file from the workspace', (file, job) => {
    const body = jobOf(file, job).steps[0]!.run ?? '';
    // It runs before actions/checkout, so the workspace is empty. A `bash
    // scripts/…`, or any other path read here, exits 127 on EVERY event — and
    // this step has no `if:`, so that would red the check on every PR.
    expect(body).not.toMatch(/\bscripts\//);
    expect(body).not.toMatch(/\bbash\s+\S+\.sh/);
    expect(body.length).toBeGreaterThan(0);
  });

  it.each(sites)('%s / %s runs before its own checkout, and carries no if:', (file, job) => {
    const steps = jobOf(file, job).steps;
    const checkout = steps.findIndex((s) => s.key.startsWith('actions/checkout'));
    if (checkout >= 0) expect(checkout).toBeGreaterThan(0);
    // An event-branching `if:` in a required job needs a census allowlist
    // entry; the body is a no-op on the gating events instead.
    expect(steps[0]!.if).toBeUndefined();
  });

  it('is byte-identical in every job, so one cannot rot alone', () => {
    // The count is asserted so a workflow silently losing its jobs, or the
    // canary list losing a workflow, does not turn this suite into a no-op.
    expect(sites).toHaveLength(8);
    expect(new Set(sites.map(([f, j]) => jobOf(f, j).steps[0]!.run)).size).toBe(1);
    // The env block carries EVENT and REF; the body reads nothing else.
    for (const [f, j] of sites) {
      const text = jobOf(f, j).steps[0]!.text;
      expect(text).toContain('github.event_name');
      expect(text).toContain('github.ref');
    }
  });
});

describe('what the shipped block actually does', () => {
  const body = jobOf('test.yml', 'test-shard').steps[0]!.run!;

  it('passes a scheduled round and an on-demand dispatch on main', () => {
    for (const EVENT of ['schedule', 'workflow_dispatch']) {
      const r = runGuard(body, { EVENT, REF: 'refs/heads/main' });
      expect(r.code).toBe(0);
      expect(r.out).toContain('refs/heads/main');
    }
  });

  it('FAILS a dispatch aimed at any other ref, and says which', () => {
    const r = runGuard(body, { EVENT: 'workflow_dispatch', REF: 'refs/heads/feat/some-pr' });
    // Exit 1, not 0: a skipped or passing check run on a pull request's head,
    // under a required context's name, is exactly what this prevents.
    expect(r.code).toBe(1);
    expect(r.out).toContain('refs/heads/feat/some-pr');
    expect(r.out).toContain('::error');
  });

  it('is a no-op on the gating events, whatever their ref', () => {
    // pull_request and merge_group refs are whatever GitHub built; checking
    // them would red the queue.
    for (const EVENT of ['pull_request', 'merge_group']) {
      expect(runGuard(body, { EVENT, REF: 'refs/pull/1234/merge' }).code).toBe(0);
    }
  });

  it('fails closed when either variable is empty, rather than falling through', () => {
    // An empty EVENT used to fall past the canary test and exit 0. Nothing can
    // be shown safe from nothing.
    expect(runGuard(body, { EVENT: '', REF: 'refs/heads/main' }).code).toBe(1);
    expect(runGuard(body, { EVENT: 'schedule', REF: '' }).code).toBe(1);
    expect(runGuard(body, {}).code).toBe(1);
  });
});
