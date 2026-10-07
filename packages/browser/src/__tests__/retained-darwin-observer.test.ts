import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi, beforeEach } from 'vitest';
import { openRetainedDarwinObserver } from '../runtime/journal/retained-observer.js';
const controls = vi.hoisted(() => ({ launch: vi.fn(), verify: vi.fn(), accepts: vi.fn() }));
vi.mock('../runtime/darwin-owned-child.js', () => ({
  createDarwinOwnedChildLauncher: () => ({ launch: controls.launch }),
  acceptsDarwinOwnedChildReturn: controls.accepts,
}));
vi.mock('../runtime/darwin-process-observer.js', async (original) => ({
  ...(await original<typeof import('../runtime/darwin-process-observer.js')>()),
  verifyOriginalDarwinObserverArtifact: controls.verify,
}));
beforeEach(() => {
  controls.launch.mockReset();
  controls.verify.mockReset().mockResolvedValue(undefined);
  controls.accepts.mockReset().mockReturnValue(true);
});
const artifact = { path: '/owned/native', sha256: 'a'.repeat(64) };
const manager = { pid: 42, birth: 'darwin-bsd-start:10:0' };
const identity = { pid: 99, birth: 'darwin-bsd-start:11:0' };
const parent = { pid: 99, seconds: '11', microseconds: '0' };
const children = {
  version: 1,
  bootSeconds: '1',
  bootMicroseconds: '0',
  complete: true,
  parentBefore: parent,
  parentAfter: parent,
  processes: [],
};
function peer(
  options: {
    held?: boolean;
    holdReturn?: boolean;
    onEnd?(): void;
    endFailure?: { value: unknown };
    endCallbackFailure?: Error;
    holdStopReturn?: boolean;
  } = {}
) {
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const requests: string[] = [];
  let releaseReply = () => {};
  let releaseReturn!: () => void;
  const completed = new Promise<{ firstCause: null }>((yes) => {
    releaseReturn = () => yes({ firstCause: null });
  });
  let ends = 0,
    stops = 0;
  const stdin = new Writable({
    write(bytes, _encoding, done) {
      const line: string = bytes.toString().trim();
      requests.push(line);
      const fields = line.split(' ');
      const reply =
        fields[0] === 'C'
          ? children
          : {
              version: 1,
              bootSeconds: '1',
              bootMicroseconds: '0',
              processes: fields.slice(1).map((pid) => ({ kind: 'absent', pid: Number(pid) })),
            };
      const send = () => {
        stdout.write(JSON.stringify(reply) + '\n');
        done();
      };
      if (options.held) releaseReply = send;
      else send();
    },
    final(done) {
      ends++;
      options.onEnd?.();
      stdout.end();
      stderr.end();
      if (options.endCallbackFailure) {
        queueMicrotask(() => done(options.endCallbackFailure));
      } else {
        if (!options.holdReturn) releaseReturn();
        done();
      }
    },
  });
  if (options.endFailure)
    stdin.end = () => {
      throw options.endFailure!.value;
    };
  const original = {
    child: Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill() {
        stops++;
        stdout.end();
        stderr.end();
        if (!options.holdStopReturn) releaseReturn();
        return true;
      },
    }),
    identity: async () => identity,
    completion: () => completed,
    returned: () => completed.then(() => ({})),
  };
  return {
    original,
    stderr,
    requests,
    releaseReply: () => releaseReply(),
    releaseReturn,
    ends: () => ends,
    stops: () => stops,
    finish: () => {
      releaseReply();
      releaseReturn();
    },
  };
}
it('reuses one original child, freshly verifies each request and preserves interleaved original query order', async () => {
  const f = peer();
  controls.launch.mockResolvedValue(f.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  try {
    await owner.observer.inspect([10]);
    expect(f.requests).toEqual(['I 10']);
    expect(await owner.observer.children?.(identity)).toEqual(children);
    expect(f.requests).toEqual(['I 10', 'C 99']);
    await owner.observer.inspect([20]);
    expect(f.requests).toEqual(['I 10', 'C 99', 'I 20']);
    expect(controls.verify).toHaveBeenCalledTimes(3);
    expect(controls.launch).toHaveBeenCalledTimes(1);
  } finally {
    try {
      await owner.close();
    } finally {
      f.finish();
    }
  }
});
it('does not issue a later parent query while the preceding original census is held', async () => {
  const f = peer({ held: true });
  controls.launch.mockResolvedValue(f.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  const first = owner.observer.children!(identity),
    second = owner.observer.inspect([20]);
  void first.catch(() => {});
  void second.catch(() => {});
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests).toEqual(['C 99']);
    f.releaseReply();
    await first;
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    f.releaseReply();
    await second;
  } finally {
    f.finish();
    await Promise.allSettled([first, second, owner.close()]);
  }
});
it('close publishes its same promise before reentrant original EOF and joins held original return', async () => {
  const owned: { owner?: Awaited<ReturnType<typeof openRetainedDarwinObserver>> } = {};
  let reentered: Promise<void> | undefined;
  const f = peer({
    holdReturn: true,
    onEnd: () => {
      const original = owned.owner;
      if (!original) throw new Error('fixture original owner unavailable');
      reentered = original.close();
    },
  });
  controls.launch.mockResolvedValue(f.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  owned.owner = owner;
  let settled = false;
  const closing = owner.close();
  void closing.then(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(f.ends()).toBe(1));
    expect(reentered).toBe(closing);
    expect(settled).toBe(false);
    f.releaseReturn();
    await closing;
    expect(settled).toBe(true);
  } finally {
    f.finish();
    await Promise.allSettled([closing]);
  }
});
it.each([false, undefined])(
  'retains original EOF-entry falsy failure after independent child return: %s',
  async (cause) => {
    const f = peer({ endFailure: { value: cause } });
    controls.launch.mockResolvedValue(f.original);
    const owner = await openRetainedDarwinObserver({ artifact, manager });
    try {
      await expect(owner.close()).rejects.toBe(cause);
    } finally {
      f.finish();
      await Promise.allSettled([owner.close()]);
    }
  }
);
it('refuses the reused parent birth without altering incomplete native errno evidence', async () => {
  const f = peer();
  controls.launch.mockResolvedValue(f.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  try {
    let refusal: { value: unknown } | undefined;
    try {
      await owner.observer.children!({ ...identity, birth: 'darwin-bsd-start:12:0' });
    } catch (value) {
      refusal = { value };
    }
    expect(refusal).toBeDefined();
    await expect(owner.close()).rejects.toBe(refusal?.value);
  } finally {
    f.finish();
    await Promise.allSettled([owner.close()]);
  }
});
it('rotates only between original requests and joins prior child return before opening another', async () => {
  const first = peer({ holdReturn: true }),
    second = peer();
  controls.launch.mockResolvedValueOnce(first.original).mockResolvedValueOnce(second.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  let operation: Promise<unknown> | undefined;
  try {
    // Genuine bounded native-schema replies (512 rows) grow the unchanged retained byte bank.
    const pids = Array.from({ length: 512 }, (_, i) => i + 1);
    for (let i = 0; i < 13; i++) await owner.observer.inspect(pids);
    operation = owner.observer.inspect(pids);
    void operation.catch(() => {});
    await vi.waitFor(() => expect(first.ends()).toBe(1));
    expect(controls.launch).toHaveBeenCalledTimes(1);
    first.releaseReturn();
    await operation;
    expect(controls.launch).toHaveBeenCalledTimes(2);
  } finally {
    first.finish();
    second.finish();
    await Promise.allSettled([...(operation ? [operation] : []), owner.close()]);
  }
});

it('refuses unexpected original stderr and still joins held request and child return', async () => {
  const f = peer({ held: true, holdReturn: true });
  controls.launch.mockResolvedValue(f.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  const operation = owner.observer.inspect([10]);
  void operation.catch(() => {});
  let closing: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.stderr.write('original helper refusal\n');
    f.releaseReply();
    let refusal: { value: unknown } | undefined;
    try {
      await operation;
    } catch (value) {
      refusal = { value };
    }
    expect(refusal).toBeDefined();
    closing = owner.close();
    void closing.catch(() => {});
    let returned = false;
    void closing.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      }
    );
    await vi.waitFor(() => expect(f.ends()).toBe(1));
    expect(returned).toBe(false);
    f.releaseReturn();
    await expect(closing).rejects.toBe(refusal?.value);
  } finally {
    f.finish();
    await Promise.allSettled([operation, ...(closing ? [closing] : []), owner.close()]);
  }
});

it('fences new requests while retaining already admitted queued originals through close', async () => {
  const f = peer({ held: true });
  controls.launch.mockResolvedValue(f.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  const first = owner.observer.inspect([10]),
    second = owner.observer.inspect([20]);
  void first.catch(() => {});
  void second.catch(() => {});
  let closing: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    closing = owner.close();
    void closing.catch(() => {});
    expect(() => owner.observer.inspect([30])).toThrow('PROCESS_OBSERVER_CLOSED');
    expect(f.ends()).toBe(0);
    f.releaseReply();
    await first;
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.ends()).toBe(0);
    f.releaseReply();
    await second;
    await closing;
    expect(f.requests).toEqual(['I 10', 'I 20']);
    expect(f.ends()).toBe(1);
  } finally {
    f.finish();
    await Promise.allSettled([first, second, ...(closing ? [closing] : []), owner.close()]);
  }
});

it('stops the exact child on asynchronous original EOF callback failure and joins its held return', async () => {
  const cause = new Error('original asynchronous EOF refusal');
  const f = peer({ endCallbackFailure: cause, holdStopReturn: true });
  controls.launch.mockResolvedValue(f.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  const closing = owner.close();
  let settled = false;
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  try {
    await vi.waitFor(() => expect(f.stops()).toBe(1));
    expect(f.ends()).toBe(1);
    expect(settled).toBe(false);
    expect(owner.close()).toBe(closing);
    f.releaseReturn();
    await expect(closing).rejects.toBe(cause);
    expect(f.stops()).toBe(1);
  } finally {
    f.finish();
    await Promise.allSettled([closing, owner.close()]);
  }
});

it('retains premature original child completion as a failure before any retirement entry', async () => {
  const f = peer();
  controls.launch.mockResolvedValue(f.original);
  const owner = await openRetainedDarwinObserver({ artifact, manager });
  let original: { value: unknown } | undefined;
  try {
    f.releaseReturn();
    await f.original.completion();
    try {
      owner.observer.inspect([10]);
    } catch (value) {
      original = { value };
    }
    expect(original).toBeDefined();
    expect(original?.value).toBeInstanceOf(Error);
    expect(f.requests).toEqual([]);
    await expect(owner.close()).rejects.toBe(original?.value);
    expect(f.ends()).toBe(1);
  } finally {
    f.finish();
    await Promise.allSettled([owner.close()]);
  }
});
