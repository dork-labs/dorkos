/** Mechanical single-flight replay scheduling; caller-owned operations retain every policy decision. */
export interface ClosedReplayRun {
  page(): Promise<'again' | 'done'>;
  failed(cause: unknown): void;
  beginFinalization(): 'drain' | 'restart' | 'stop';
  drainOne(): 'again' | 'tail' | 'restart' | 'stop';
  finishFinalization(): 'restart' | 'stop';
}
interface ReplayEntry {
  revision: number;
  promise: Promise<void>;
  resolve(): void;
  reject(cause: unknown): void;
  settled: boolean;
}
/** Reserve the actual old promise before capture or paging can synchronously reenter. */
export function createDocReplayTask(captureRun: () => ClosedReplayRun) {
  let active: ReplayEntry | undefined;
  let revision = 0;
  const release = (entry: ReplayEntry) => {
    if (active === entry) active = undefined;
  };
  const settle = (entry: ReplayEntry, failure?: { cause: unknown }) => {
    if (entry.settled) return;
    entry.settled = true;
    if (failure) entry.reject(failure.cause);
    else entry.resolve();
  };
  const restart = () => {
    // Scheduling only: the old promise never adopts or awaits its newer replacement.
    void request().catch(() => {});
  };
  const finalize = (entry: ReplayEntry, run: ClosedReplayRun) => {
    const current = () => revision === entry.revision;
    if (!current()) return;
    const instruction = run.beginFinalization();
    if (!current()) return;
    if (instruction === 'restart') {
      restart();
      return;
    }
    if (instruction !== 'drain') return;
    while (current()) {
      const next = run.drainOne();
      if (!current()) return;
      if (next === 'again') continue;
      if (next === 'restart') restart();
      else if (next === 'tail') {
        const tail = run.finishFinalization();
        if (current() && tail === 'restart') restart();
      }
      return;
    }
  };
  const execute = async (entry: ReplayEntry) => {
    let run: ClosedReplayRun | undefined;
    let failure: { cause: unknown } | undefined;
    try {
      run = captureRun();
      try {
        while ((await run.page()) === 'again') {
          // The closed page itself owns lifetime, epoch, progress and per-dispatch checks.
        }
      } catch (cause) {
        run.failed(cause);
      }
    } catch (cause) {
      failure = { cause };
    } finally {
      release(entry);
      try {
        if (run) finalize(entry, run);
      } catch (cause) {
        // Match Promise.finally: a finalizer throw takes precedence, even thrown undefined.
        failure = { cause };
      } finally {
        // Revision suppresses stale phases, never settlement of this OLD owned entry.
        settle(entry, failure);
      }
    }
  };
  const request = (): Promise<void> => {
    if (active) return active.promise;
    let resolve!: () => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<void>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    const entry: ReplayEntry = { revision: ++revision, promise, resolve, reject, settled: false };
    active = entry;
    void execute(entry);
    return promise;
  };
  return Object.freeze({ request });
}
