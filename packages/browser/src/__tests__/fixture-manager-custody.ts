import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

type Owner = {
  readonly child: ChildProcess;
  readonly sends: Set<Promise<void>>;
  closed: boolean;
  exited: boolean;
  pipesReturned: boolean;
};
const retained = new Set<Owner>();
/** Bound only waiting; keep original child, sends, pipes and callbacks until their actual return. */
export async function fixtureWait<T>(
  original: Promise<T>,
  milliseconds: number,
  cause: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(cause)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Private fixture-only original manager custody, never a metadata PID or process-group signal. */
export function ownFixtureManager(child: ChildProcess) {
  const owner: Owner = {
    child,
    sends: new Set(),
    closed: false,
    exited: false,
    pipesReturned: false,
  };
  retained.add(owner);
  const send = child.send,
    kill = child.kill;
  let resolveReady!: (message: unknown) => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<unknown>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  child.once('message', resolveReady);
  child.on('error', rejectReady);
  let exitCode: number | null = null,
    exitSignal: NodeJS.Signals | null = null;
  child.once('exit', (code, signal) => {
    owner.exited = true;
    exitCode = code;
    exitSignal = signal;
  });
  const terminal = new Promise<void>((resolve) =>
    child.once('close', (code, signal) => {
      if (code !== exitCode || signal !== exitSignal) owner.exited = false;
      owner.closed = true;
      rejectReady(new Error('FIXTURE_MANAGER_CLOSED_BEFORE_READY'));
      resolve();
    })
  );
  const drain = async (stream: Readable | null) => {
    if (!stream) throw new Error('FIXTURE_PIPE_MISSING');
    let eof = false,
      bytes = 0,
      overflow = false;
    const closed = new Promise<void>((resolve) => stream.once('close', resolve));
    stream.once('end', () => {
      eof = true;
    });
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 262144) overflow = true;
    }
    await closed;
    if (!eof || !stream.readableEnded || overflow)
      throw new Error('FIXTURE_PIPE_RETURN_UNVERIFIED');
  };
  const pipes = Promise.allSettled([drain(child.stdout), drain(child.stderr)]);
  const returned = Promise.all([terminal, pipes]).then(([, results]) => {
    owner.pipesReturned = results.every((value) => value.status === 'fulfilled');
    if (owner.closed && owner.exited && owner.pipesReturned && !owner.sends.size)
      retained.delete(owner);
    return owner.closed && owner.exited && owner.pipesReturned && !owner.sends.size;
  });
  const sendClose = () => {
    if (!child.connected) return Promise.resolve();
    const original = new Promise<void>((resolve, reject) =>
      Reflect.apply(send, child, [
        { kind: 'close' },
        (error: Error | null) => (error ? reject(error) : resolve()),
      ])
    );
    owner.sends.add(original);
    void original.then(
      () => owner.sends.delete(original),
      () => owner.sends.delete(original)
    );
    return original;
  };
  let closing:
    | Promise<Readonly<{ observed: boolean; forced: boolean; failures: readonly string[] }>>
    | undefined;
  return Object.freeze({
    ready: () => fixtureWait(ready, 15000, 'FIXTURE_MANAGER_READY_EXPIRED'),
    terminal,
    returned,
    crash() {
      if (owner.closed) return false;
      return Reflect.apply(kill, child, ['SIGKILL']) as boolean;
    },
    close() {
      closing ??= (async () => {
        const failures: string[] = [];
        let forced = false;
        const attempt = async (operation: () => Promise<unknown>) => {
          try {
            await operation();
          } catch (error) {
            failures.push(error instanceof Error ? error.message : 'FIXTURE_CLEANUP_FAILURE');
          }
        };
        if (!owner.closed) {
          await attempt(() => fixtureWait(sendClose(), 500, 'FIXTURE_CLOSE_SEND_EXPIRED'));
          await attempt(() => fixtureWait(terminal, 2000, 'FIXTURE_COOPERATIVE_CLOSE_EXPIRED'));
        }
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
          if (owner.closed) break;
          forced = true;
          await attempt(async () => {
            if (!Reflect.apply(kill, child, [signal]))
              throw new Error('FIXTURE_ORIGINAL_SIGNAL_REFUSED');
          });
          await attempt(() => fixtureWait(terminal, 2000, 'FIXTURE_ORIGINAL_RETURN_EXPIRED'));
        }
        let observed = false;
        await attempt(async () => {
          observed = await fixtureWait(returned, 2000, 'FIXTURE_PIPE_RETURN_EXPIRED');
        });
        if (observed) retained.delete(owner);
        return Object.freeze({ observed, forced, failures: Object.freeze(failures) });
      })();
      return closing;
    },
  });
}
