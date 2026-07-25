/**
 * The stray sweeper. The load-bearing assertions are the negative ones: the
 * sweep must delete ONLY what the harness stamped, because it runs `rm -rf` over
 * paths in the OS temp dir and `docker rm --force` over a label filter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sweepStrays, formatSweepReport, tempRoots } from '../sweep.js';
import { SANDBOX_PREFIX } from '../sandbox.js';
import type { DockerCli } from '../isolation/docker-launcher.js';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** A fake temp root holding two eval sandboxes and two innocent bystanders. */
async function seedTempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'evals-sweep-test-'));
  await mkdir(path.join(dir, `${SANDBOX_PREFIX}AbC123`, '.dork'), { recursive: true });
  await mkdir(path.join(dir, `${SANDBOX_PREFIX}XyZ789`, 'project'), { recursive: true });
  await mkdir(path.join(dir, 'some-other-tool-cache'), { recursive: true });
  await writeFile(path.join(dir, `${SANDBOX_PREFIX}not-a-dir`), 'a file, not a sandbox', 'utf8');
  return dir;
}

/**
 * A docker seam that lists containers for the label filter and records its calls.
 *
 * `ids` are plain stopped containers; `running` are live ones, which the sweep
 * must leave alone by default.
 */
function fakeDocker(
  ids: string[],
  opts: { listCode?: number; rmCode?: number; running?: string[] } = {}
): { docker: DockerCli; calls: string[][] } {
  const calls: string[][] = [];
  const rows = [
    ...ids.map((id) => `${id} exited`),
    ...(opts.running ?? []).map((id) => `${id} running`),
  ];
  const docker: DockerCli = {
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'ps') {
        return { code: opts.listCode ?? 0, stdout: rows.join('\n'), stderr: '' };
      }
      return { code: opts.rmCode ?? 0, stdout: '', stderr: opts.rmCode ? 'nope' : '' };
    },
  };
  return { docker, calls };
}

describe('sweepStrays — sandboxes', () => {
  it('deletes every dorkos-evals-* directory and NOTHING else', async () => {
    root = await seedTempRoot();
    const report = await sweepStrays({ tempRoot: root, docker: fakeDocker([]).docker });

    expect(report.sandboxes).toHaveLength(2);
    const left = await readdir(root);
    expect(left.sort()).toEqual([`${SANDBOX_PREFIX}not-a-dir`, 'some-other-tool-cache']);
  });

  it('dry-run reports what it would delete and deletes nothing', async () => {
    root = await seedTempRoot();
    const report = await sweepStrays({
      tempRoot: root,
      docker: fakeDocker([]).docker,
      dryRun: true,
    });

    expect(report.sandboxes).toHaveLength(2);
    const left = await readdir(root);
    expect(left).toHaveLength(4);
  });

  it('reports an unreadable EXPLICIT temp root as a problem rather than throwing', async () => {
    const report = await sweepStrays({
      tempRoot: path.join(tmpdir(), 'definitely-not-here-xyz'),
      docker: fakeDocker([]).docker,
    });
    expect(report.problems.join(' ')).toMatch(/could not read/);
  });

  it('scans /tmp as well as the current temp dir when no root is named', () => {
    // `os.tmpdir()` reads TMPDIR, and Turborepo's strict env mode filters it out
    // of a task's environment — so `turbo run test` makes sandboxes in /tmp while
    // a shell run makes them in /var/folders/... A single-root sweep reported
    // "nothing to do" with 41 directories sitting in the other root.
    const roots = tempRoots();
    expect(roots).toContain('/tmp');
    expect(roots).toContain(tmpdir());
    // Deduplicated: on a machine where TMPDIR IS /tmp, nothing is scanned twice.
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('honors an explicitly named root and scans nothing else', () => {
    expect(tempRoots('/some/where')).toEqual(['/some/where']);
  });
});

describe('sweepStrays — containers', () => {
  it('removes exactly the label-filtered eval containers', async () => {
    root = await seedTempRoot();
    const { docker, calls } = fakeDocker(['abc123', 'def456']);
    const report = await sweepStrays({ tempRoot: root, docker });

    expect(report.containers).toEqual(['abc123', 'def456']);
    // The filter is the harness's own label — never a bare `docker rm $(ps -aq)`.
    expect(calls[0]).toEqual([
      'ps',
      '--all',
      '--format',
      '{{.ID}} {{.State}}',
      '--filter',
      'label=dorkos-eval=1',
    ]);
    expect(calls[1]).toEqual(['rm', '--force', 'abc123', 'def456']);
  });

  it('LEAVES RUNNING containers alone and says so', async () => {
    // A running eval container is almost certainly somebody's run in flight;
    // sweeping it would kill the run and waste the model spend already paid for.
    root = await seedTempRoot();
    const { docker, calls } = fakeDocker(['stopped1'], { running: ['live1', 'live2'] });
    const report = await sweepStrays({ tempRoot: root, docker });

    expect(report.containers).toEqual(['stopped1']);
    expect(calls.find((c) => c[0] === 'rm')).toEqual(['rm', '--force', 'stopped1']);
    expect(report.problems.join(' ')).toMatch(/left 2 RUNNING eval container\(s\) alone/);
    expect(report.problems.join(' ')).toMatch(/--force/);
  });

  it('removes running containers only when --force is given', async () => {
    root = await seedTempRoot();
    const { docker, calls } = fakeDocker(['stopped1'], { running: ['live1'] });
    const report = await sweepStrays({ tempRoot: root, docker, force: true });

    expect(report.containers.sort()).toEqual(['live1', 'stopped1']);
    expect(calls.find((c) => c[0] === 'rm')).toEqual(['rm', '--force', 'stopped1', 'live1']);
    expect(report.problems.filter((p) => p.includes('RUNNING'))).toEqual([]);
  });

  it('does not remove a running container even in a dry run', async () => {
    root = await seedTempRoot();
    const { docker, calls } = fakeDocker([], { running: ['live1'] });
    const report = await sweepStrays({ tempRoot: root, docker, dryRun: true });

    expect(report.containers).toEqual([]);
    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
  });

  it('treats a missing daemon as a note, not a failure', async () => {
    root = await seedTempRoot();
    const { docker } = fakeDocker([], { listCode: 1 });
    const report = await sweepStrays({ tempRoot: root, docker });

    expect(report.containers).toEqual([]);
    expect(report.problems.join(' ')).toMatch(/no reachable Docker daemon/);
    // The sandbox half must still have run.
    expect(report.sandboxes).toHaveLength(2);
  });

  it('does not claim a container was removed when docker refused', async () => {
    root = await seedTempRoot();
    const { docker } = fakeDocker(['abc123'], { rmCode: 1 });
    const report = await sweepStrays({ tempRoot: root, docker });

    expect(report.containers).toEqual([]);
    expect(report.problems.join(' ')).toMatch(/could not remove container/);
  });

  it('issues no rm at all when nothing carries the label', async () => {
    root = await seedTempRoot();
    const { docker, calls } = fakeDocker([]);
    await sweepStrays({ tempRoot: root, docker });
    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
  });
});

describe('formatSweepReport', () => {
  it('says removed for a real sweep and would remove for a dry run', () => {
    const report = { sandboxes: ['/tmp/dorkos-evals-a'], containers: ['abc'], problems: ['oops'] };
    expect(formatSweepReport(report)).toMatch(/^removed 1 sandbox/);
    expect(formatSweepReport(report, true)).toMatch(/^would remove 1 sandbox/);
    expect(formatSweepReport(report)).toContain('! oops');
  });
});
