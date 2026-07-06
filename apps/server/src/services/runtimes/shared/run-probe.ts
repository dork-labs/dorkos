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
 * Find `name` on `PATH` (`which`/`where`), bounded by `timeoutMs`.
 *
 * A hung locator (e.g. a `PATH` entry on a stalled network mount) is bounded out
 * and treated as "not found" rather than blocking the event loop.
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
  } catch {
    /* not on PATH, or the lookup hung and was bounded out */
  }
  return null;
}
