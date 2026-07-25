/**
 * The stray sweeper: delete eval sandboxes and eval containers a previous run
 * left behind.
 *
 * Retain-on-failure is worth having and also leaks: a run keeps the state of
 * anything that failed, and a hard kill keeps everything. Both were previously
 * unbounded — the sandbox prefix and the container label made strays *greppable*
 * with no actual sweep behind them, which in a repo with a disk-full history is a
 * loaded gun. `runner/interrupt.ts` stops the common leak (`Ctrl-C`); this is the
 * backstop for a `SIGKILL`, a crashed host, or a retained failure nobody went
 * back to read.
 *
 * Both halves key on the SAME markers the creators stamp — the
 * `dorkos-evals-` tmpdir prefix (`runner/sandbox.ts`) and the `dorkos-eval=1`
 * container label (`isolation/docker-launcher.ts`) — so the sweep can never touch
 * something the harness did not create.
 *
 * Run it with `pnpm evals:sweep`.
 *
 * @module evals/runner/sweep
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SANDBOX_PREFIX } from './sandbox.js';
import { EVAL_CONTAINER_LABEL, execDocker, type DockerCli } from './isolation/docker-launcher.js';

/** What one sweep removed, and what it could not. */
export interface SweepReport {
  /** Absolute paths of sandbox directories deleted. */
  sandboxes: string[];
  /** Ids of eval containers removed. */
  containers: string[];
  /** Human-readable notes for anything that could not be swept. */
  problems: string[];
}

/**
 * Every temp root a sandbox could have been created in.
 *
 * `mkdtemp` uses `os.tmpdir()`, which is NOT one fixed path: it reads `TMPDIR`,
 * and Turborepo's strict env mode filters undeclared variables out of a task's
 * environment, so a sandbox made by `turbo run test` lands in `/tmp` while the
 * same code run from a shell uses the per-user `/var/folders/...` dir. A sweep
 * that only scanned the invoking process's tmpdir would report "nothing to do"
 * while dozens of directories sat in the other one — measured on this machine.
 *
 * @param explicit - A caller-specified root (tests); used alone when given.
 * @returns The distinct roots to scan.
 */
export function tempRoots(explicit?: string): string[] {
  if (explicit !== undefined) return [explicit];
  const roots = new Set([tmpdir(), '/tmp']);
  return [...roots];
}

/** Options for {@link sweepStrays}. */
export interface SweepOptions {
  /**
   * A single temp root to scan. Omitted (the normal case) scans every root a
   * sandbox could be in — see {@link tempRoots}.
   */
  tempRoot?: string;
  /** The docker CLI seam. Defaults to the real binary; pass a fake in tests. */
  docker?: DockerCli;
  /** Report what WOULD be removed without removing it. */
  dryRun?: boolean;
  /**
   * Also remove RUNNING eval containers. Off by default: a running container is
   * probably somebody's eval in flight, and killing it wastes the model spend.
   */
  force?: boolean;
}

/**
 * Delete every `dorkos-evals-*` directory under `tempRoot`.
 *
 * @param tempRoot - The directory to scan.
 * @param dryRun - Report without deleting.
 * @param report - Accumulator for what was removed and what was not.
 * @param required - When false, a missing root is silently skipped (one of the
 *   candidate roots simply may not exist on this OS); when true, it is a problem
 *   worth reporting because the caller named it.
 */
async function sweepSandboxes(
  tempRoot: string,
  dryRun: boolean,
  report: SweepReport,
  required: boolean
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(tempRoot);
  } catch (err) {
    if (required) {
      report.problems.push(
        `could not read ${tempRoot}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(SANDBOX_PREFIX)) continue;
    const target = path.join(tempRoot, entry);
    try {
      const info = await stat(target);
      if (!info.isDirectory()) continue;
      if (!dryRun) await rm(target, { recursive: true, force: true });
      report.sandboxes.push(target);
    } catch (err) {
      report.problems.push(
        `could not remove ${target}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Remove eval containers, skipping RUNNING ones unless `force` is set.
 *
 * A stray is a container nobody is using; a running one is very likely somebody's
 * eval in flight. Sweeping while a background run is mid-turn would kill it and
 * charge the model spend for nothing, so the default is stopped-only and the
 * report says what it left behind.
 *
 * @param docker - The docker CLI seam.
 * @param opts - `dryRun` reports without removing; `force` includes running ones.
 * @param report - Accumulator for what was removed and what was not.
 */
async function sweepContainers(
  docker: DockerCli,
  opts: { dryRun: boolean; force: boolean },
  report: SweepReport
): Promise<void> {
  // `{{.State}}` alongside the id, so liveness is decided from docker's own view
  // rather than guessed. The label filter stays the exact `dorkos-eval=1` the
  // launcher stamps.
  const listed = await docker.run([
    'ps',
    '--all',
    '--format',
    '{{.ID}} {{.State}}',
    '--filter',
    `label=${EVAL_CONTAINER_LABEL}=1`,
  ]);
  if (listed.code !== 0) {
    // No daemon is the normal case on a machine that never ran the docker tier.
    report.problems.push(
      'skipped container sweep: no reachable Docker daemon (nothing to do if you never ran the docker tier).'
    );
    return;
  }

  const rows = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [id, state = ''] = line.split(/\s+/);
      return { id, running: state.toLowerCase() === 'running' };
    });

  const running = rows.filter((r) => r.running);
  if (running.length > 0 && !opts.force) {
    report.problems.push(
      `left ${String(running.length)} RUNNING eval container(s) alone (${running.map((r) => r.id).join(', ')}) — ` +
        'an eval may be using them. Re-run with --force to remove running containers too.'
    );
  }

  const ids = (opts.force ? rows : rows.filter((r) => !r.running)).map((r) => r.id);
  if (ids.length === 0 || opts.dryRun) {
    report.containers.push(...ids);
    return;
  }

  const removed = await docker.run(['rm', '--force', ...ids]);
  if (removed.code !== 0) {
    report.problems.push(
      `could not remove container(s) ${ids.join(', ')}: ${removed.stderr.trim()}`
    );
    return;
  }
  report.containers.push(...ids);
}

/**
 * Remove every stray eval sandbox and eval container.
 *
 * @param opts - Temp root, docker seam, dry-run; see {@link SweepOptions}.
 * @returns What was (or would be) removed, plus anything that could not be.
 */
export async function sweepStrays(opts: SweepOptions = {}): Promise<SweepReport> {
  const report: SweepReport = { sandboxes: [], containers: [], problems: [] };
  const explicit = opts.tempRoot !== undefined;
  for (const root of tempRoots(opts.tempRoot)) {
    await sweepSandboxes(root, opts.dryRun ?? false, report, explicit);
  }
  await sweepContainers(
    opts.docker ?? execDocker,
    { dryRun: opts.dryRun ?? false, force: opts.force ?? false },
    report
  );
  return report;
}

/**
 * Render a sweep report for the console.
 *
 * @param report - The report to render.
 * @param dryRun - True when nothing was actually removed.
 * @returns One or more lines of plain text.
 */
export function formatSweepReport(report: SweepReport, dryRun = false): string {
  const verb = dryRun ? 'would remove' : 'removed';
  const lines = [
    `${verb} ${report.sandboxes.length} sandbox directory(ies) and ${report.containers.length} container(s).`,
    ...report.sandboxes.map((s) => `  sandbox   ${s}`),
    ...report.containers.map((c) => `  container ${c}`),
    ...report.problems.map((p) => `  ! ${p}`),
  ];
  return lines.join('\n');
}
