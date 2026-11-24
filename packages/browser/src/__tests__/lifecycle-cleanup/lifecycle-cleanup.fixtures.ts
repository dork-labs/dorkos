import type {} from '../../configuration.js';
import { type ChildProcess } from 'node:child_process';

// Fixture-only original ChildProcess custody; no numeric-PID signal or descendant authority.
export const TRUSTED_CHILD_SOURCE =
  "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1000)";

export const TRUSTED_CHILD_ENV = Object.freeze({});

export function ownTrustedChild(child: ChildProcess, end: number, now = () => performance.now()) {
  let exit = false,
    close = false,
    stdinClosed = false;
  let failed: { value: unknown } | null = null;
  let refused = false;
  let stopPromise: Promise<void> | undefined;
  let resolveExit!: () => void, resolveClose!: () => void, resolveStdin!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const inputClosed = new Promise<void>((resolve) => {
    resolveStdin = resolve;
  });
  child.once('exit', () => {
    exit = true;
    resolveExit();
  });
  child.once('close', () => {
    close = true;
    resolveClose();
  });
  child.on('error', (value) => {
    failed ??= { value };
  });
  const stdin = child.stdin;
  stdin?.once('close', () => {
    stdinClosed = true;
    resolveStdin();
  });
  stdin?.on('error', (value) => {
    failed ??= { value };
  });
  const complete = () => exit && close && stdinClosed && failed === null && !refused;
  return Object.freeze({
    isClosed: complete,
    facts: () => Object.freeze({ exit, close, stdinClosed, failed }),
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      let resolve!: () => void, reject!: (value: unknown) => void;
      stopPromise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      // Memoization and all three terminal promises exist before the EOF request.
      void (async () => {
        const entered = now();
        if (!stdin || !Number.isFinite(entered) || entered >= end)
          throw Error('OWNED_CHILD_STOP_END_EXPIRED');
        if (!stdinClosed) stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([exited, closed, inputClosed]),
            new Promise<never>((_, fail) => {
              timer = setTimeout(
                () => fail(Error('OWNED_CHILD_CLOSURE_UNVERIFIED')),
                Math.max(0, end - now())
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        const settled = now();
        if (!Number.isFinite(settled) || settled >= end || !complete())
          throw Error('OWNED_CHILD_CLOSURE_UNVERIFIED', { cause: failed?.value });
      })().then(resolve, (cause) => {
        refused = true;
        reject(cause);
      });
      return stopPromise;
    },
  });
}

export function throwCaseFailure(
  primary: { value: unknown } | null,
  cleanup: { value: unknown } | null
): void {
  if (primary !== null) {
    if (cleanup !== null)
      throw new AggregateError([primary.value, cleanup.value], 'PHYSICAL_CASE_FAILED', {
        cause: primary.value,
      });
    throw primary.value;
  }
  if (cleanup !== null) throw cleanup.value;
}
