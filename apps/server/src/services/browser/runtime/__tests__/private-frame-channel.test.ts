import { createOriginalProjectedResourceBank } from './private-projected-resource-bank.fixture.js';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOriginalFrameChannel,
  parseOriginalFrameStatistics,
  withOriginalFrameDrain,
  stopAndJoinOriginalFrameWorker,
  joinOriginalFrameWorkerReturns,
  releaseOriginalFrameWorker,
} from './private-frame-channel.fixture.js';
import {
  createPrivateNativeAcceptance,
  createOriginalViewerFileSink,
} from '../private-native-acceptance.js';

// Controlled ports prove refusal/cleanup, never actual resource or rendering acceptance.
it('missing original frontend/bank roles refuse without measuring an inferred PID', async () => {
  const descendants = vi.fn(async () => ({ status: 'complete' as const, identities: [] }));
  const bank = createPrivateNativeAcceptance({
    manager: { pid: 41, birth: 'original-manager' },
    processes: { descendants, observe: async () => ({ status: 'alive' }) },
    own: (original) => original,
    current: () => {},
  });
  await expect(bank.roles([])).rejects.toThrow(
    'PRIVATE_ACCEPTANCE_TWO_BROWSERS_AND_FRONTEND_REQUIRED'
  );
  expect(descendants).not.toHaveBeenCalled();
});
it('missing original queue sink parent refuses before a statistics file exists', () => {
  expect(() =>
    createOriginalViewerFileSink(
      join(tmpdir(), 'absent-original-' + crypto.randomUUID(), 'queue.json')
    )
  ).toThrow();
});
it.each([null, {}, { frames: 0, bytes: 12 }, { frames: 1, bytes: Number.NaN }])(
  'missing or invalid actual producer counters refuse %j',
  (value) => {
    expect(() => parseOriginalFrameStatistics(value)).toThrow(
      'FRAME_ORIGINAL_PRODUCER_STATS_REQUIRED'
    );
  }
);
it('frontend PID absent from genuine constructor-owned complete manager tree refuses', async () => {
  const manager = { pid: 41, birth: 'original-manager' };
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 42 });
  const bank = createPrivateNativeAcceptance({
    manager,
    processes: {
      descendants: async () => ({ status: 'complete', identities: [manager] }),
      observe: async () => ({ status: 'alive' }),
    },
    own: (original) => original,
    current: () => {},
  });
  await expect(bank.captureFrontend(child)).rejects.toThrow(
    'PRIVATE_ACCEPTANCE_FRONTEND_BIRTH_UNKNOWN'
  );
  expect(bank.originalFrontend()).toBe(child);
});
it.each([false, undefined, null, 0, ''])(
  'parent first falsy %j survives setup release and every joined close',
  async (cause) => {
    const directory = await mkdtemp(join(tmpdir(), 'original-frame-channel-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const channel = await createOriginalFrameChannel(directory, new AbortController().signal);
    const setup = channel.wait('start');
    void setup.catch(() => {});
    let released = false,
      drained = false;
    const original = withOriginalFrameDrain(
      async () => {
        throw cause;
      },
      async () => {
        await channel.write('release', null);
        released = true;
      },
      [
        async () => {
          await expect(setup).rejects.toThrow('FRAME_ORIGINAL_PARENT_RELEASED_SETUP');
          drained = true;
          throw new Error('later cleanup');
        },
      ]
    );
    await expect(original).rejects.toBe(cause);
    expect(released).toBe(true);
    expect(drained).toBe(true);
  }
);

it('projected bank refuses an original CLI child with unknown native birth', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 42 });
  const parent = { pid: 41, birth: 'original-parent' };
  const bank = createOriginalProjectedResourceBank({
    parent,
    identity: async () => null,
    attributeRoot: async () => true,
    cli: child,
    processes: {
      descendants: async () => ({ status: 'complete', identities: [parent] }),
      observe: async () => ({ status: 'alive' }),
    },
    signal: new AbortController().signal,
    current: () => {},
    own: (original) => original,
  });
  await expect(bank.captureCli()).rejects.toThrow('PROJECTED_ORIGINAL_CLI_BIRTH_UNKNOWN');
  await expect(bank.roles([])).rejects.toThrow('PROJECTED_ORIGINAL_CLI_BIRTH_UNKNOWN');
});
it.each([false, undefined])(
  'projected observation first falsy %j is retained before recovery',
  async (cause) => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 42 });
    const parent = { pid: 41, birth: 'original-parent' };
    let fail = true;
    const bank = createOriginalProjectedResourceBank({
      parent,
      identity: async () => {
        if (fail) throw cause;
        return { pid: 42, birth: 'original-cli' };
      },
      attributeRoot: async () => true,
      cli: child,
      processes: {
        descendants: async () => ({ status: 'complete', identities: [] }),
        observe: async () => ({ status: 'alive' }),
      },
      signal: new AbortController().signal,
      current: () => {},
      own: (original) => original,
    });
    await expect(bank.captureCli()).rejects.toBe(cause);
    fail = false;
    await expect(bank.captureCli()).rejects.toBe(cause);
  }
);
it('projected birth from a different manager is retained but cannot qualify a receipt', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 42 });
  const parent = { pid: 41, birth: 'original-parent' },
    cli = { pid: 42, birth: 'original-cli' },
    root = { pid: 44, birth: 'original-root' };
  const bank = createOriginalProjectedResourceBank({
    parent,
    identity: async () => cli,
    attributeRoot: async () => true,
    cli: child,
    processes: {
      descendants: async () => ({ status: 'complete', identities: [parent, cli] }),
      observe: async () => ({ status: 'alive' }),
    },
    signal: new AbortController().signal,
    current: () => {},
    own: (original) => original,
  });
  await bank.captureCli();
  await expect(
    bank.retainBirth({
      browserId: 'B'.repeat(22),
      browserGeneration: 1,
      root,
      supervisor: { pid: 45, birth: 'original-supervisor' },
      manager: { pid: 42, birth: 'substitute-birth' },
      identities: [root],
      complete: true,
    })
  ).rejects.toThrow('PROJECTED_ORIGINAL_CLI_MANAGER_MISMATCH');
  expect(bank.originalKnownBirths()).toContainEqual(root);
  await expect(bank.roles([])).rejects.toThrow('PROJECTED_ORIGINAL_CLI_MANAGER_MISMATCH');
});

it('coherent constructor birth is retained before ACK without any live tree acquisition', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 42 });
  const parent = { pid: 41, birth: 'original-parent' },
    cli = { pid: 42, birth: 'original-cli' },
    root = { pid: 44, birth: 'original-root' };
  const descendants = vi.fn(async () => {
    throw new Error('No pre-ACK tree read permitted');
  });
  const bank = createOriginalProjectedResourceBank({
    parent,
    cli: child,
    identity: async () => cli,
    attributeRoot: async () => true,
    processes: { descendants, observe: async () => ({ status: 'alive' }) },
    signal: new AbortController().signal,
    current: () => {},
    own: (original) => original,
  });
  await bank.captureCli();
  await bank.retainBirth({
    browserId: 'B'.repeat(22),
    browserGeneration: 1,
    root,
    supervisor: { pid: 45, birth: 'original-supervisor' },
    manager: cli,
    identities: [root],
    complete: true,
  });
  expect(descendants).not.toHaveBeenCalled();
  expect(bank.originalKnownBirths()).toContainEqual(root);
});

it.each([false, undefined])(
  'early parent failure %j independently stops and joins held worker',
  async (cause) => {
    const child = new ChildProcess();
    let returned = false;
    let resolve!: () => void;
    const terminal = new Promise<void>((yes) => {
      resolve = yes;
    });
    const kill = vi.spyOn(child, 'kill').mockImplementation((signal) => {
      expect(signal).toBe('SIGTERM');
      returned = true;
      resolve();
      return true;
    });
    await expect(
      withOriginalFrameDrain(
        async () => {
          throw cause;
        },
        async () => {},
        [() => stopAndJoinOriginalFrameWorker(child, terminal)]
      )
    ).rejects.toBe(cause);
    expect(kill).toHaveBeenCalledOnce();
    expect(returned).toBe(true);
  }
);

it.each([false, undefined])(
  'worker first falsy %j survives failing original log close after both pipes join',
  async (cause) => {
    let stdoutJoined = false,
      stderrJoined = false,
      closed = false;
    const original = joinOriginalFrameWorkerReturns(
      [
        Promise.reject(cause),
        Promise.resolve().then(() => {
          stdoutJoined = true;
        }),
        Promise.resolve().then(() => {
          stderrJoined = true;
        }),
      ],
      async () => {
        expect(stdoutJoined && stderrJoined).toBe(true);
        closed = true;
        throw new Error('later log close');
      }
    );
    await expect(original).rejects.toBe(cause);
    expect(closed).toBe(true);
  }
);
it.each([false, undefined])(
  'successful worker retains original falsy %j log close failure',
  async (cause) => {
    await expect(
      joinOriginalFrameWorkerReturns([Promise.resolve(), Promise.resolve()], async () => {
        throw cause;
      })
    ).rejects.toBe(cause);
  }
);
it.each([false, undefined])(
  'failed release %j stops and joins the original held worker without waiting for release',
  async (cause) => {
    const child = new ChildProcess();
    let terminate!: () => void,
      joined = false;
    const returned = new Promise<void>((_yes, no) => {
      terminate = () => no(new Error('later original worker termination'));
    }).catch((value) => {
      joined = true;
      throw value;
    });
    const kill = vi.spyOn(child, 'kill').mockImplementation((signal) => {
      expect(signal).toBe('SIGTERM');
      terminate();
      return true;
    });
    await expect(
      releaseOriginalFrameWorker(
        async () => {
          throw cause;
        },
        child,
        returned
      )
    ).rejects.toBe(cause);
    expect(kill).toHaveBeenCalledOnce();
    expect(joined).toBe(true);
  }
);

it.each([false, undefined])(
  'first pipe failure %j stops a handshake-held original worker before joining its other pipe',
  async (cause) => {
    const child = new ChildProcess();
    let returnWorker!: () => void, releaseOtherPipe!: () => void;
    let workerJoined = false,
      otherPipeJoined = false,
      logClosed = false;
    const returned = new Promise<void>((resolve) => {
      returnWorker = resolve;
    }).then(() => {
      workerJoined = true;
    });
    const otherPipe = new Promise<void>((resolve) => {
      releaseOtherPipe = resolve;
    }).then(() => {
      otherPipeJoined = true;
    });
    const kill = vi.spyOn(child, 'kill').mockImplementation((signal) => {
      expect(signal).toBe('SIGTERM');
      returnWorker();
      return true;
    });
    let settled = false;
    const original = joinOriginalFrameWorkerReturns(
      [returned, Promise.reject(cause), otherPipe],
      async () => {
        expect(workerJoined && otherPipeJoined).toBe(true);
        logClosed = true;
        throw new Error('later original log close');
      },
      () => {
        child.kill('SIGTERM');
      }
    );
    const observed = original.then(
      () => {
        settled = true;
        return { passed: true as const };
      },
      (value: unknown) => {
        settled = true;
        return { passed: false as const, value };
      }
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(kill).toHaveBeenCalledOnce();
    expect(workerJoined).toBe(true);
    expect(settled).toBe(false);
    expect(logClosed).toBe(false);
    releaseOtherPipe();
    const result = await observed;
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.value).toBe(cause);
    expect(logClosed && otherPipeJoined).toBe(true);
  }
);
