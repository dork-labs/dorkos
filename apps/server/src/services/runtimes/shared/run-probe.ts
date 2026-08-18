/**
 * Non-blocking CLI probe helpers shared across runtime dependency checks.
 *
 * Dependency probes shell out to a runtime's binary (`--version`, `login
 * status`, `auth list`) and to `which`/`where`. Running them synchronously
 * (`execFileSync`) blocks the Node event loop, so a hung binary or a `PATH`
 * entry on a stalled network mount stutters every live SSE stream. These helpers
 * run each probe asynchronously and bound it with a hard timeout that rejects
 * (and SIGKILLs the child), so a hung probe degrades to "missing" fast instead
 * of hanging (absorbs the DOR-180 "make checkDependencies probes async"
 * follow-up).
 *
 * @module services/runtimes/shared/run-probe
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { logger } from '../../../lib/logger.js';

/**
 * Run `binary args`, bounded by `timeoutMs`, resolving trimmed stdout.
 *
 * Rejects on non-zero exit, spawn error, or timeout. A dedicated timer bounds
 * the wait independently of `execFile`'s own `timeout` option, so a
 * never-resolving child (or a mocked one, in tests) still rejects promptly; the
 * `timeout` + `killSignal` passed to `execFile` reap the real OS child even when
 * the timer wins the race. The timer is `unref`'d so a pending probe never keeps
 * the process alive on its own.
 *
 * @param binary - Absolute path or PATH name of the executable to run.
 * @param args - Argument vector (no shell, no interpolation — spec §Security).
 * @param timeoutMs - Hard upper bound on the probe.
 */
export function runBinaryProbe(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`probe timed out after ${timeoutMs}ms: ${binary}`))),
      timeoutMs
    );
    timer.unref?.();

    execFile(
      binary,
      args,
      { encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout) => {
        if (err) return finish(() => reject(err));
        finish(() => resolve((typeof stdout === 'string' ? stdout : String(stdout)).trim()));
      }
    );
  });
}

/**
 * Failures already reported, keyed by check + binary + error code.
 *
 * `GET /api/system/requirements` re-runs every probe on each poll, so an
 * unfixable failure (no binary, a signed-out CLI) would otherwise write the same
 * warning forever. One line per distinct failure is what a person debugging
 * actually needs; the repeats are noise.
 */
const reportedProbeFailures = new Set<string>();

/** Clear the "already reported" set. For tests, which assert on the first notice. */
export function resetProbeFailureNotices(): void {
  reportedProbeFailures.clear();
}

/**
 * Report a swallowed probe failure at `warn`, once per distinct failure.
 *
 * Dependency probes deliberately degrade to "missing" rather than throwing, and
 * for a long time they did it in silence: the packaged Mac app reported its own
 * bundled Claude Code as missing and the server log said nothing at all, so
 * there was no way to tell an absent binary from one that could not be spawned
 * (DOR-1334 / F3). Every `catch` that turns a probe error into `missing` calls
 * this, so the reason is always one `grep` away.
 *
 * @param check - The dependency check that failed, as the user sees it named
 *   (e.g. `'Claude Code CLI'`) — the log must say WHICH answer this explains.
 * @param binary - The binary the probe tried to run.
 * @param err - Whatever the probe rejected with.
 */
export function logProbeFailure(check: string, binary: string, err: unknown): void {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : undefined;
  const key = `${check} | ${binary} | ${code ?? ''}`;
  if (reportedProbeFailures.has(key)) return;
  reportedProbeFailures.add(key);
  logger.warn(`[Runtimes] ${check} probe failed — reporting it missing`, {
    binary,
    ...(code !== undefined ? { code } : {}),
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Report why a `PATH` lookup came back empty.
 *
 * The two reasons are not equally interesting and must not read alike. A
 * locator that exits non-zero is simply saying "not installed" — ordinary, and
 * `debug`. A locator that could not be spawned, or that had to be bounded out
 * because a `PATH` entry sits on a stalled mount, means the answer "not found"
 * was never actually established: `warn`, because on a busy or broken machine
 * that is how a perfectly present binary silently reads as missing (DOR-1334
 * review — it fired during the review run).
 *
 * @param name - Binary name that was looked for.
 * @param err - Whatever the locator rejected with.
 */
export function logLocatorFailure(name: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // A numeric exit status means the locator RAN and said no: `code` from
  // `execFile`'s callback error, `status` from a sync `execFileSync` throw. A
  // string `code` (`ENOENT`), a signal, or neither means it never answered.
  const detail = err as { code?: unknown; status?: unknown } | null;
  const exited = typeof detail?.code === 'number' || typeof detail?.status === 'number';
  if (exited) {
    logger.debug(`[Runtimes] no ${name} on PATH`, { error: message });
    return;
  }
  logger.warn(`[Runtimes] could not establish whether ${name} is on PATH`, { error: message });
}

/**
 * Find `name` on `PATH` (`which`/`where`), bounded by `timeoutMs`.
 *
 * A hung locator (e.g. a `PATH` entry on a stalled network mount) is bounded out
 * and treated as "not found" rather than blocking the event loop — but never
 * silently: see {@link logLocatorFailure}.
 *
 * @param name - Binary name to locate (e.g. `'codex'`).
 * @param timeoutMs - Hard upper bound on the lookup.
 * @returns Absolute path to an existing binary on PATH, or `null` when none is found.
 */
export async function findBinaryOnPath(name: string, timeoutMs: number): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = await runBinaryProbe(locator, [name], timeoutMs);
    const found = out.split(/\r?\n/)[0]?.trim(); // `where` may return multiple matches
    if (found && existsSync(found)) return found;
    logger.debug(`[Runtimes] ${locator} named a ${name} that is not on disk`, { found });
  } catch (err) {
    logLocatorFailure(name, err);
  }
  return null;
}
