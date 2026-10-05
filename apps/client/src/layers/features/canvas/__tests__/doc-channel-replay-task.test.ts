import { describe, expect, it, vi } from 'vitest';
import { createDocReplayTask, type ClosedReplayRun } from '../model/doc-channel-replay-task';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function run(overrides: Partial<ClosedReplayRun> = {}): ClosedReplayRun {
  return {
    page: async () => 'done',
    failed: () => {},
    beginFinalization: () => 'drain',
    drainOne: () => 'tail',
    finishFinalization: () => 'stop',
    ...overrides,
  };
}
async function flushSettlement() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe('closed mechanical replay scheduling', () => {
  it.each(['capture', 'page'] as const)(
    'reserves the actual identical promise before %s reentry',
    async (phase) => {
      const held = deferred<'done'>();
      let nested: Promise<void> | undefined;
      const capture = vi.fn(() => {
        if (phase === 'capture') nested = task.request();
        return run({
          page: () => {
            if (phase === 'page') nested = task.request();
            return held.promise;
          },
        });
      });
      const task = createDocReplayTask(capture);
      const original = task.request();
      expect(nested).toBe(original);
      expect(task.request()).toBe(original);
      expect(capture).toHaveBeenCalledTimes(1);
      held.resolve('done');
      await original;
    }
  );

  it.each(['begin', 'drain', 'finish'] as const)(
    'settles OLD before a held NEW started by %s, without further old phases',
    async (phase) => {
      const heldNew = deferred<'done'>();
      let newPromise: Promise<void> | undefined;
      const tail = vi.fn(() => 'stop' as const);
      const startNew = () => {
        newPromise = task.request();
      };
      const begin = vi.fn(() => {
        if (phase === 'begin') startNew();
        return 'drain' as const;
      });
      const drain = vi.fn(() => {
        if (phase === 'drain') startNew();
        return 'tail' as const;
      });
      const finish = vi.fn(() => {
        if (phase === 'finish') startNew();
        return tail();
      });
      const capture = vi
        .fn()
        .mockImplementationOnce(() =>
          run({ beginFinalization: begin, drainOne: drain, finishFinalization: finish })
        )
        .mockImplementationOnce(() => run({ page: () => heldNew.promise }));
      const task = createDocReplayTask(capture);
      const oldPromise = task.request();
      let oldSettled = false;
      void oldPromise.then(() => {
        oldSettled = true;
      });
      await flushSettlement();
      let newSettled = false;
      if (!newPromise) throw new Error('Expected synchronous newer start');
      void newPromise.then(() => {
        newSettled = true;
      });
      const witness = { oldSettled, newSettled, ownCurrent: task.request() === newPromise };
      const calls = { drain: drain.mock.calls.length, finish: finish.mock.calls.length };
      heldNew.resolve('done');
      await Promise.all([oldPromise, newPromise]);
      expect(witness).toEqual({ oldSettled: true, newSettled: false, ownCurrent: true });
      expect(calls).toEqual({
        drain: phase === 'begin' ? 0 : 1,
        finish: phase === 'finish' ? 1 : 0,
      });
      expect(capture).toHaveBeenCalledTimes(2);
    }
  );

  it('does not adopt a held fire-and-forget restart promise', async () => {
    const held = deferred<'done'>();
    const capture = vi
      .fn()
      .mockImplementationOnce(() => run({ beginFinalization: () => 'restart' }))
      .mockImplementationOnce(() => run({ page: () => held.promise }));
    const task = createDocReplayTask(capture);
    const old = task.request();
    let settled = false;
    void old.then(() => {
      settled = true;
    });
    await flushSettlement();
    const newer = task.request();
    const witness = settled;
    held.resolve('done');
    await Promise.all([old, newer]);
    expect(witness).toBe(true);
    expect(newer).not.toBe(old);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it.each(['stale', 'disposed'] as const)(
    'settles every closed %s exit without invented drain work',
    async () => {
      const drain = vi.fn(() => 'tail' as const);
      const task = createDocReplayTask(() =>
        run({ beginFinalization: () => 'stop', drainOne: drain })
      );
      await task.request();
      expect(drain).not.toHaveBeenCalled();
    }
  );

  it.each([new Error('capture failure'), undefined])(
    'releases and rejects only its reserved capture failure %#',
    async (cause) => {
      const capture = vi
        .fn()
        .mockImplementationOnce(() => {
          throw cause;
        })
        .mockImplementationOnce(() => run());
      const task = createDocReplayTask(capture);
      const result = await task.request().then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, error })
      );
      expect(result).toEqual({ rejected: true, error: cause });
      await task.request();
      expect(capture).toHaveBeenCalledTimes(2);
    }
  );

  it('handles the actual page cause once and finalizes without a page retry', async () => {
    const cause = new Error('page failure');
    const page = vi.fn(async () => {
      throw cause;
    });
    const failed = vi.fn();
    const begin = vi.fn(() => 'stop' as const);
    const task = createDocReplayTask(() => run({ page, failed, beginFinalization: begin }));
    await task.request();
    expect(page).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledExactlyOnceWith(cause);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('handler failed'), undefined])(
    'finalizes after failed throws %# and preserves its actual cause',
    async (cause) => {
      const begin = vi.fn(() => 'stop' as const);
      const task = createDocReplayTask(() =>
        run({
          page: async () => {
            throw new Error('page');
          },
          failed: () => {
            throw cause;
          },
          beginFinalization: begin,
        })
      );
      const result = await task.request().then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, error })
      );
      expect(result).toEqual({ rejected: true, error: cause });
      expect(begin).toHaveBeenCalledTimes(1);
    }
  );

  it.each([new Error('finalizer failed'), undefined])(
    'gives finalizer throw %# Promise.finally precedence and retains the nested winner',
    async (cause) => {
      const held = deferred<'done'>();
      let nested: Promise<void> | undefined;
      const capture = vi
        .fn()
        .mockImplementationOnce(() =>
          run({
            page: async () => {
              throw new Error('page');
            },
            failed: () => {
              throw new Error('handler');
            },
            beginFinalization: () => {
              nested = task.request();
              throw cause;
            },
          })
        )
        .mockImplementationOnce(() => run({ page: () => held.promise }));
      const task = createDocReplayTask(capture);
      const result = await task.request().then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, error })
      );
      expect(result).toEqual({ rejected: true, error: cause });
      expect(task.request()).toBe(nested);
      held.resolve('done');
      await nested;
    }
  );
});
