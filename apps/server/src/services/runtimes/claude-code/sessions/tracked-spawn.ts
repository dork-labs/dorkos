/**
 * The spawn seam that writes a warm process into the ledger the moment it
 * exists (DOR-1310).
 *
 * ## Why the SDK's seam rather than watching our own children
 *
 * The property this has to hold is "a warm subprocess never outlives the DorkOS
 * server that started it, even through a SIGKILL". A SIGKILL lands at an
 * arbitrary instant, so any scheme that notices a process AFTER it was spawned —
 * a periodic sweep of our own child processes, a snapshot taken when the pump
 * reaches `warm` — has a window in which a process exists and nothing has
 * written it down. A process spawned inside that window is exactly the orphan
 * the sweep was built to prevent.
 *
 * `Options.spawnClaudeCodeProcess` is the SDK's documented extension point and
 * it closes the window outright: we are handed the child synchronously, and the
 * ledger write is synchronous too, so the record exists before the pid is
 * returned to the SDK.
 *
 * ## Scoped to warm processes only
 *
 * This is injected in `pump-launch.ts`, not in the shared option resolver, so
 * only the PERSISTENT pump path takes it. The resume-per-message path spawns a
 * process that dies with its turn, has nothing to orphan, and keeps the SDK's
 * own local spawn byte for byte.
 *
 * ## What taking the seam costs, and what is given back
 *
 * The SDK's built-in spawn also pumps the child's stderr into the tail it
 * quotes in exit errors, and delays its `exit` event until stderr has drained.
 * A custom spawner gets neither — and, worse, a piped stderr nobody reads fills
 * its 64 KB buffer and BLOCKS the child. So this drains stderr itself, keeps
 * the same kind of bounded tail, and logs it when the child exits badly. The
 * one thing genuinely lost is the `--debug-file` argument the SDK passes to the
 * CLI when its own debug logging is enabled, which it skips whenever a custom
 * spawner is set; the SDK-side debug log is unaffected.
 *
 * @module services/runtimes/claude-code/sessions/tracked-spawn
 */
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { logger } from '../../../../lib/logger.js';
import type { WarmProcessLedger } from './warm-process-ledger.js';

/** How much of the child's stderr is kept to explain a bad exit. */
const STDERR_TAIL_LIMIT = 4096;

/**
 * Build the `spawnClaudeCodeProcess` a warm launch runs through.
 *
 * @param ledger - Where the spawned pid is written down, synchronously, before
 *   the child is handed back to the SDK
 */
export function createTrackedSpawn(
  ledger: WarmProcessLedger
): (opts: SpawnOptions) => SpawnedProcess {
  return ({ command, args, cwd, env, signal }) => {
    const child = spawn(command, args, {
      cwd,
      env,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Before anything else can happen to it. A pid we hold but have not
    // recorded is precisely the orphan this module exists to prevent.
    const pid = child.pid;
    if (pid !== undefined) ledger.record(pid);

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
    });
    // A stderr pipe nobody reads fills and blocks the child, so a read error
    // here is swallowed rather than thrown at an unhandled 'error' listener.
    child.stderr?.on('error', () => {});

    child.once('exit', (code, exitSignal) => {
      if (pid !== undefined) ledger.forget(pid);
      if (code === 0 || code === null) return;
      logger.warn('[tracked-spawn] a warm agent process exited badly', {
        pid,
        code,
        signal: exitSignal,
        stderr: stderrTail.trim().slice(-STDERR_TAIL_LIMIT),
      });
    });

    // The SDK's own contract says "ChildProcess already satisfies this
    // interface", and it does — the only mismatch is that `stdin`/`stdout` are
    // typed nullable because in general they depend on `stdio`. Both are pipes
    // here, so the cast asserts what the `stdio` two lines up already fixed.
    // Handing the real child over (rather than a projection of it) is what
    // keeps every other behaviour the SDK relies on exactly as it found it.
    return child as unknown as SpawnedProcess;
  };
}
