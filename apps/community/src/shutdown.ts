/** What {@link createStop} closes: the HTTP listener, the database pool and any repeating timers. */
export interface StoppableResources {
  /** The HTTP listener; `close` stops new connections and calls back once the last one ends. */
  server: { close(callback?: (error?: Error) => void): unknown };
  /** The Postgres pool; `end` may only ever be called once. */
  pool: { end(): Promise<void> };
  /** Background sweeps to cancel before anything else closes. */
  timers?: ReadonlyArray<ReturnType<typeof setInterval>>;
}

/**
 * Build the server's stop function. Calling it more than once is safe: every call after the first
 * returns the same promise, so each resource closes exactly once.
 *
 * Two stops are ordinary rather than exotic. Ctrl-C in a terminal delivers SIGINT to the whole
 * process group, so a parent that also forwards SIGTERM (the backup rehearsal does) stops the
 * server twice. A second `pool.end()` rejects with "Called end on pool more than once", which used
 * to crash a clean shutdown into exit code 1 and a stack trace.
 */
export function createStop({ server, pool, timers = [] }: StoppableResources): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      for (const timer of timers) clearInterval(timer);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await pool.end();
    })();
    return stopping;
  };
}
