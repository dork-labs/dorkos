/** Actual local SDK child custody for the installed original document capacity pool. */
import { spawn, ChildProcess } from 'node:child_process';
const terminateOriginalChild = ChildProcess.prototype.kill;
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
export interface OriginalSdkSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}
type SpawnedProcess = ChildProcessWithoutNullStreams;
import { CapacityHold, type CapacityLease } from './adapters/claude-code/capacity-hold.js';
const acquire = CapacityHold.prototype.tryAcquire,
  release = CapacityHold.prototype.release;
export interface OriginalDocumentProcessReservation {
  /** Fixed actual Node spawn; no custom spawner, process reporter or close certificate. */
  spawn(options: OriginalSdkSpawnOptions): SpawnedProcess;
  releaseNeverInvoked(): void;
  drain(): Promise<void>;
  requireReleased(): void;
  awaitPhysicalCloseAndRelease(): Promise<void>;
}
/** Internal original installed adapter constructor passes its exact private pool. */
export function reserveOriginalDocumentProcess(
  pool: CapacityHold
): OriginalDocumentProcessReservation | null {
  const lease: CapacityLease | null = acquire.call(pool);
  if (!lease) return null;
  let invoked = false,
    released = false,
    exited = false,
    closed = false,
    stdoutClosed = false,
    stderrClosed = false,
    stdinClosed = false;
  let spawned = false,
    failed = false,
    first: unknown;
  let settle!: () => void;
  const closure = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const trySettle = () => {
    if (closed && stdoutClosed && stderrClosed && stdinClosed && (exited || !spawned)) settle();
  };
  const settleLease = () => {
    if (!released) {
      release.call(pool, lease);
      released = true;
    }
  };
  let drain: Promise<void> | undefined;
  let terminate: (() => void) | undefined;
  return Object.freeze({
    spawn(options: OriginalSdkSpawnOptions): SpawnedProcess {
      if (invoked || released) throw new Error('Original document process reservation consumed');
      invoked = true;
      // SDK supplies the actual command/args/env/signal selected by its original
      // ProcessTransport. Never inherit a caller spawner or shell execution.
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      } catch (cause) {
        remember(cause);
        throw cause;
      } // No positive close: retain lease.
      // Keep the genuine child and original native termination method privately.
      // The SDK receives the child only after this capture.
      terminate = () => {
        if (!exited && !closed) terminateOriginalChild.call(child, 'SIGTERM');
      };
      child.once('spawn', () => {
        spawned = true;
      });
      child.once('exit', () => {
        exited = true;
        trySettle();
      });
      child.once('close', () => {
        closed = true;
        trySettle();
      });
      child.on('error', remember);
      const streams = [child.stdin, child.stdout, child.stderr] as const;
      if (streams.some((stream) => stream === null)) {
        remember(new Error('Original SDK pipes missing'));
        throw first;
      }
      child.stdin!.once('close', () => {
        stdinClosed = true;
        trySettle();
      });
      child.stdout!.once('close', () => {
        stdoutClosed = true;
        trySettle();
      });
      child.stderr!.once('close', () => {
        stderrClosed = true;
        trySettle();
      });
      for (const stream of streams) stream!.on('error', remember);
      // Continuous discard prevents stderr backpressure. No secret logging or
      // hidden truncated tail is represented as complete evidence.
      child.stderr!.on('data', () => {});
      return child as SpawnedProcess;
    },
    drain(): Promise<void> {
      if (drain) return drain;
      drain = Promise.resolve().then(async () => {
        if (invoked) {
          try {
            terminate?.();
          } catch (cause) {
            remember(cause);
          }
          // Termination request/return is never positive physical closure.
          await closure;
        }
        settleLease();
        if (failed) throw first;
      });
      return drain;
    },
    requireReleased(): void {
      if (
        !released ||
        (invoked &&
          !(closed && stdoutClosed && stderrClosed && stdinClosed && (exited || !spawned)))
      )
        throw new Error('Original document process closure UNKNOWN');
    },
    releaseNeverInvoked(): void {
      if (invoked) throw new Error('Original SDK spawn closure still required');
      settleLease();
    },
    async awaitPhysicalCloseAndRelease(): Promise<void> {
      if (!invoked) throw new Error('Original SDK spawn was never invoked');
      // No elapsed closure, Query.return, killed flag, result event, quiet
      // interval or synthetic callback can settle this original child.
      await closure;
      settleLease();
      if (failed) throw first; // Positive physical close releases capacity even on a failed turn.
    },
  });
}
