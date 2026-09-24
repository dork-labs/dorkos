/** How long open connections, such as live channel streams, get to finish before they are cut. */
export const STOP_GRACE_MS = 5_000;

/** What {@link createStop} closes: the HTTP listener, the database pool and any repeating timers. */
export interface StoppableResources {
  /** The HTTP listener; `close` stops new connections and calls back once the last one ends. */
  server: {
    close(callback?: (error?: Error) => void): unknown;
    /** Cut every open connection. Node's HTTP server has it; `close` alone waits for them. */
    closeAllConnections?(): void;
  };
  /** The Postgres pool; `end` may only ever be called once. */
  pool: { end(): Promise<void> };
  /** Background sweeps to cancel before anything else closes. */
  timers?: ReadonlyArray<ReturnType<typeof setInterval>>;
  /** How long open connections get before they are cut. Defaults to {@link STOP_GRACE_MS}. */
  graceMs?: number;
}

/**
 * Build the server's stop function. Calling it more than once is safe: every call after the first
 * returns the same promise, so each resource closes exactly once.
 *
 * Two stops are ordinary rather than exotic. Ctrl-C in a terminal delivers SIGINT to the whole
 * process group, so a parent that also forwards SIGTERM stops the server twice. A second
 * `pool.end()` rejects with "Called end on pool more than once", which used to crash a clean
 * shutdown into exit code 1 and a stack trace.
 *
 * A live channel stream never ends by itself, so `close` alone could wait forever. After the
 * grace period every remaining connection is cut; each stream sees its request abort and stops
 * polling. The pool ends even when the listener fails to close, and that failure is still
 * reported.
 */
export function createStop({
  server,
  pool,
  timers = [],
  graceMs = STOP_GRACE_MS,
}: StoppableResources): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      for (const timer of timers) clearInterval(timer);
      let closeError: unknown;
      try {
        await new Promise<void>((resolve, reject) => {
          const cut = setTimeout(() => server.closeAllConnections?.(), graceMs);
          server.close((error) => {
            clearTimeout(cut);
            if (error) reject(error);
            else resolve();
          });
        });
      } catch (error) {
        closeError = error;
      }
      await pool.end();
      if (closeError) throw closeError;
    })();
    return stopping;
  };
}

/**
 * Build the SIGINT/SIGTERM handler. The first signal starts {@link createStop}'s stop; a failure
 * is logged and leaves exit code 1. A second signal while that stop is still running exits at
 * once with code 1, the usual "press Ctrl-C again to force it".
 */
export function createSignalHandler(
  stop: () => Promise<void>,
  {
    exit = (code: number) => process.exit(code),
    setExitCode = (code: number) => {
      process.exitCode = code;
    },
    log = console.error,
  }: {
    exit?: (code: number) => void;
    setExitCode?: (code: number) => void;
    log?: (message: string, detail: string) => void;
  } = {}
): () => void {
  let state: 'running' | 'stopping' | 'stopped' | 'failed' = 'running';
  return () => {
    if (state === 'stopping') return exit(1);
    if (state !== 'running') return exit(state === 'stopped' ? 0 : 1);
    state = 'stopping';
    stop().then(
      () => {
        state = 'stopped';
      },
      (error: unknown) => {
        state = 'failed';
        log(
          'Community server did not stop cleanly',
          error instanceof Error ? error.name : 'unknown'
        );
        setExitCode(1);
      }
    );
  };
}
