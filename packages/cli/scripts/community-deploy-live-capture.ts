/**
 * The live gate's two waits that happen after provider resources may already exist.
 *
 * Both used to be able to strand a run: an unbounded wait for the bootstrap secret hung the
 * process forever behind a listening socket, and a launcher that failed while the gate waited on
 * something else crashed Node on the unhandled rejection. Either way the gate never reached the
 * code that prints how to reconcile what it created. They live here, beside the clipboard shim that
 * feeds the first of them, with no provider boundary, so all three can be proven without spending
 * anything.
 */
import { chmod, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';

/** A redacted command failure. Provider output is never reproduced in the receipt. */
export class CommunityLiveGateError extends Error {
  /**
   * Create a failure naming only the step that failed.
   *
   * @param step - Stable, non-secret name of the failed step.
   * @param recoveryCommand - The command that reconciles retained resources, when known.
   * @param detail - A fixed, non-secret sentence saying what the failure left behind.
   */
  constructor(
    readonly step: string,
    readonly recoveryCommand: string | null = null,
    detail?: string
  ) {
    super(`Community live gate failed (${step})${detail ? `: ${detail}` : ''}`);
    this.name = 'CommunityLiveGateError';
  }
}

/** Shape a clipboard value must have to be a bootstrap secret. */
export const BOOTSTRAP_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,}$/u;

/**
 * Values the published launcher copies that are not the bootstrap secret, and must still succeed.
 *
 * The launcher proves the clipboard works by copying harmless test text before its first provider
 * write, and clears the clipboard with an empty value after the handoff. Anything else that is not
 * a bootstrap secret makes the shim exit non-zero, which fails the launcher's copy and so the run,
 * instead of letting the gate wait on a secret that was dropped. If a future launcher changes its
 * test text, that failure lands at the capability check, before anything is created.
 */
export const CLIPBOARD_SHIM_PASSTHROUGH = ['', 'DorkOS clipboard capability check'] as const;

/**
 * Write an executable `pbcopy` stand-in that forwards a bootstrap secret to `socketPath`.
 *
 * The value crosses a private local socket only. It is neither logged nor written to disk.
 */
export async function writePrivateClipboardShim(
  directory: string,
  socketPath: string
): Promise<string> {
  const path = join(directory, 'pbcopy');
  const source = `#!${process.execPath}
const net = require('node:net');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const value = Buffer.concat(chunks);
  const text = value.toString('utf8');
  if (${JSON.stringify(CLIPBOARD_SHIM_PASSTHROUGH)}.includes(text)) return;
  if (!new RegExp(${JSON.stringify(BOOTSTRAP_SECRET_PATTERN.source)}, 'u').test(text)) process.exit(1);
  const c = net.createConnection(${JSON.stringify(socketPath)}, () => c.end(value));
  c.on('error', () => process.exit(1));
});
`;
  await writeFile(path, source, { mode: 0o700, flag: 'wx' });
  await chmod(path, 0o700);
  return path;
}

/** The private receiving end of the clipboard shim. */
export interface ClipboardCapture {
  /**
   * Wait for the next captured secret.
   *
   * Rejects with a {@link CommunityLiveGateError} and closes the socket when nothing valid
   * arrives within `timeoutMs`, so a lost secret ends the run instead of hanging it.
   */
  next(timeoutMs: number): Promise<string>;
  /** Stop listening and fail any pending wait. Safe to call more than once. */
  close(): Promise<void>;
}

/** Listen on a private local socket for secrets written by the clipboard shim. */
export async function receiveClipboard(socketPath: string): Promise<ClipboardCapture> {
  const secrets: string[] = [];
  const waiting: Array<{ resolve(value: string): void; reject(reason: Error): void }> = [];
  let closed: Promise<void> | null = null;
  const server = createServer((connection) => {
    const chunks: Buffer[] = [];
    connection.on('data', (chunk: Buffer) => chunks.push(chunk));
    connection.on('end', () => {
      const secret = Buffer.concat(chunks).toString('utf8');
      for (const chunk of chunks) chunk.fill(0);
      const next = waiting.shift();
      if (!BOOTSTRAP_SECRET_PATTERN.test(secret))
        next?.reject(new CommunityLiveGateError('bootstrap-capture'));
      else if (next) next.resolve(secret);
      else secrets.push(secret);
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(socketPath, resolve)
  );
  const close = (): Promise<void> => {
    closed ??= new Promise<void>((resolve) => {
      for (const pending of waiting.splice(0))
        pending.reject(new CommunityLiveGateError('bootstrap-capture'));
      server.close(() => resolve());
    });
    return closed;
  };
  return {
    next: (timeoutMs) => {
      const secret = secrets.shift();
      if (secret) return Promise.resolve(secret);
      if (closed) return Promise.reject(new CommunityLiveGateError('bootstrap-capture'));
      return new Promise<string>((resolve, reject) => {
        const entry = {
          resolve: (value: string) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (reason: Error) => {
            clearTimeout(timer);
            reject(reason);
          },
        };
        const timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          // Closing here, not only in the caller's finally, is what lets the process exit: a
          // listening server alone keeps Node alive.
          void close().then(() => reject(new CommunityLiveGateError('bootstrap-capture-timeout')));
        }, timeoutMs);
        waiting.push(entry);
      });
    },
    close,
  };
}

/** How long a wait may outlive a launcher that exited cleanly, and the step it then fails as. */
export interface LauncherExitGrace {
  /** Milliseconds the wait may continue after the launcher's clean exit. */
  ms: number;
  /** Stable, non-secret step name the wait fails as when the grace runs out. */
  step: string;
}

/**
 * Await `work` while a launcher runs beside it, failing as soon as the launcher does.
 *
 * The launcher is observed from the moment this is called, so its rejection is never unhandled —
 * not while `work` is pending, and not after `work` has settled either. Any launcher failure
 * surfaces as a {@link CommunityLiveGateError}, so the caller's catch can attach the recovery
 * command.
 *
 * A launcher that exits cleanly does not end the wait on its own. Without `exitGrace` the wait runs
 * to `work`'s own timeout. With it, a wait that depends on the launcher (a secret only the launcher
 * can send) gets `exitGrace.ms` more to finish and then fails as `exitGrace.step`, instead of
 * holding the run, and whatever it created, for the rest of a twelve-minute timeout.
 */
export function whileLauncherRuns<T>(
  launcher: Promise<unknown>,
  work: Promise<T>,
  exitGrace?: LauncherExitGrace
): Promise<T> {
  let settled = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const launcherFailed = launcher.then(
    () =>
      new Promise<never>((_resolve, reject) => {
        // A wait that already finished must not keep the process alive for a grace nobody reads.
        if (!exitGrace || settled) return;
        graceTimer = setTimeout(
          () => reject(new CommunityLiveGateError(exitGrace.step)),
          exitGrace.ms
        );
      }),
    (error: unknown) => {
      throw error instanceof CommunityLiveGateError
        ? error
        : new CommunityLiveGateError('published-launcher');
    }
  );
  // `race` subscribes to both inputs, so the failure branch stays handled even when `work` wins.
  return Promise.race([work, launcherFailed]).finally(() => {
    settled = true;
    clearTimeout(graceTimer);
  });
}
