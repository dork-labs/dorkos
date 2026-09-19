/**
 * A minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 *
 * Why a pipe and not Playwright over a debugging port: a port is a door any
 * process on the machine can walk through for as long as it is open, and the
 * browser behind it is the one the person just signed in with. A pipe is two
 * file descriptors (3 in, 4 out) that only this process holds. It also needs
 * nothing but Node built-ins, so the published CLI gains no dependency.
 *
 * The framing is Chrome's: each message is one JSON object followed by a NUL
 * byte. Commands carry an `id`; the reply echoes it. Everything else is an
 * event. A command sent to a page carries the `sessionId` from
 * `Target.attachToTarget({ flatten: true })`.
 *
 * @module lib/agent-browser/cdp-pipe
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** One event Chrome sent (anything that is not a reply). */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** How the Chrome process ended. */
export interface ChromeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Thrown for every command still waiting when Chrome goes away. */
export class ChromeExitedError extends Error {
  constructor() {
    super('Chrome closed before it answered.');
    this.name = 'ChromeExitedError';
  }
}

/** A running Chrome driven over its debugging pipe. */
export interface CdpPipe {
  /** The Chrome process id. */
  readonly pid: number | undefined;
  /** Resolves when Chrome exits, however it exits. Never rejects. */
  readonly exited: Promise<ChromeExit>;
  /** Whether Chrome has already exited. */
  hasExited(): boolean;
  /**
   * Send one command and wait for its reply.
   *
   * @param method - The CDP method, e.g. `Storage.getCookies`.
   * @param params - Its parameters.
   * @param sessionId - The page session to address, when not the browser.
   * @param timeoutMs - How long to wait for a reply (default 30 s).
   */
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number
  ): Promise<T>;
  /** Listen for events. Returns the unsubscribe function. */
  onEvent(listener: (event: CdpEvent) => void): () => void;
  /**
   * Close Chrome the polite way (`Browser.close`, which lets it write the
   * profile out), then force it after `graceMs` if it has not gone.
   *
   * The default grace is long on purpose. Forcing Chrome can lose cookie
   * changes it has not written to disk yet, which would undo a `forget`, and
   * a background Chrome with a page open was measured taking 13 seconds to
   * quit after acknowledging `Browser.close` (Chrome 153, macOS).
   */
  close(graceMs?: number): Promise<ChromeExit>;
}

/** How a Chrome process is started. Injected so tests never launch one. */
export type SpawnChrome = (executable: string, args: string[]) => ChildProcess;

/** The default spawner: fds 3 and 4 become the debugging pipe; Chrome's own output is dropped. */
const defaultSpawn: SpawnChrome = (executable, args) =>
  spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

/**
 * Start Chrome with a debugging pipe and return a client for it.
 *
 * `--remote-debugging-pipe` is added here; callers pass everything else
 * (`--user-data-dir`, the start URL, `--headless` for a background pass).
 *
 * @param executable - The Chrome binary.
 * @param args - Chrome's command-line arguments.
 * @param spawnChrome - Test seam.
 */
export function launchChromeWithPipe(
  executable: string,
  args: string[],
  spawnChrome: SpawnChrome = defaultSpawn
): CdpPipe {
  const child = spawnChrome(executable, ['--remote-debugging-pipe', ...args]);
  const toChrome = child.stdio[3] as Writable | null;
  const fromChrome = child.stdio[4] as Readable | null;
  if (!toChrome || !fromChrome) {
    child.kill();
    throw new Error('Chrome started without a debugging pipe.');
  }

  let nextId = 0;
  let exitedFlag = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  const listeners = new Set<(event: CdpEvent) => void>();

  const exited = new Promise<ChromeExit>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exitedFlag) return;
      exitedFlag = true;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new ChromeExitedError());
      }
      pending.clear();
      resolve({ code, signal });
    };
    child.once('exit', finish);
    child.once('error', () => finish(null, null));
  });
  // A write to a pipe Chrome already closed raises EPIPE on the stream; the
  // exit handler above is what reports it, so the stream error is not news.
  toChrome.on('error', () => {});
  fromChrome.on('error', () => {});

  let buffered = Buffer.alloc(0);
  fromChrome.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    let end: number;
    while ((end = buffered.indexOf(0)) !== -1) {
      const raw = buffered.subarray(0, end).toString('utf8');
      buffered = buffered.subarray(end + 1);
      let message: {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof message.id === 'number') {
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message ?? 'Chrome refused.'));
        else waiter.resolve(message.result ?? {});
      } else if (message.method) {
        const event: CdpEvent = {
          method: message.method,
          params: message.params ?? {},
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        };
        for (const listener of listeners) listener(event);
      }
    }
  });

  const send = <T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000
  ): Promise<T> => {
    if (exitedFlag) return Promise.reject(new ChromeExitedError());
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome did not answer ${method} in time.`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      toChrome.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`
      );
    });
  };

  return {
    pid: child.pid,
    exited,
    hasExited: () => exitedFlag,
    send,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close(graceMs = 30_000) {
      if (!exitedFlag) {
        await send('Browser.close', {}, undefined, graceMs).catch(() => {});
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      const result = await exited;
      clearTimeout(timer);
      return result;
    },
  };
}
