import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
const original = vi.hoisted(() => ({
  callbacks: [] as { callback: (error: unknown, values?: string[]) => void; returned: boolean }[],
  cancel: vi.fn(() => {}),
  invoke: undefined as
    undefined | ((callback: (error: unknown, values?: string[]) => void) => void),
}));
// Both backends consume exactly the same original family producer for the old/new comparison.
vi.mock('node:dns', () => ({
  Resolver: class {
    cancel() {
      original.cancel();
    }
    resolve4(_name: string, callback: (error: unknown, values?: string[]) => void) {
      if (original.invoke) return original.invoke(callback);
      original.callbacks.push({ callback, returned: false });
    }
    resolve6 = this.resolve4;
    resolveCname = this.resolve4;
  },
}));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    cancel() {
      original.cancel();
    }
    resolve4() {
      return new Promise<string[]>((resolve, reject) => {
        const callback = (error: unknown, values?: string[]) =>
          error === null ? resolve(values!) : reject(error);
        if (original.invoke) original.invoke(callback);
        else original.callbacks.push({ callback, returned: false });
      });
    }
    resolve6 = this.resolve4;
    resolveCname = this.resolve4;
  },
}));
import { createProductionDestinationResolver } from '../node-resolver.js';
function returned(index: number, supplied?: unknown) {
  const error = arguments.length === 1 ? null : supplied;
  const family = original.callbacks[index]!;
  if (family.returned) throw new Error('ORIGINAL_CALLBACK_ALREADY_RETURNED');
  family.returned = true;
  family.callback(error, error === null ? [] : undefined);
}
function cancelled() {
  return Object.assign(new Error('original cancellation'), { code: 'ECANCELLED' });
}
beforeEach(() => {
  original.callbacks = [];
  original.cancel.mockReset();
  original.cancel.mockImplementation(() => {});
  original.invoke = undefined;
});
function fixture() {
  const resolver = createProductionDestinationResolver();
  const jobs: Promise<unknown>[] = [];
  const retain = <T>(work: Promise<T>) => {
    jobs.push(work);
    void work.catch(() => {});
    return work;
  };
  onTestFinished(async () => {
    for (let i = 0; i < original.callbacks.length; i++)
      if (!original.callbacks[i]!.returned) returned(i);
    retain(resolver.close());
    await Promise.allSettled(jobs);
    original.invoke = undefined;
    original.cancel.mockReset();
  });
  return { resolver, retain };
}
async function entered(count = 3) {
  await vi.waitFor(() => expect(original.callbacks).toHaveLength(count));
}

it('joins every original cancellation callback and closes without poisoning owned Off', async () => {
  const { resolver, retain } = fixture();
  const work = retain(resolver.resolve('example.test', new AbortController().signal));
  await entered();
  original.cancel.mockImplementation(() => {
    for (let i = 0; i < 3; i++) returned(i, cancelled());
  });
  const close = retain(resolver.close());
  await expect(work).rejects.toMatchObject({ code: 'ABORTED' });
  await expect(close).resolves.toBeUndefined();
  expect(original.callbacks.every((family) => family.returned)).toBe(true);
});
it.each([false, undefined])(
  'maps owned signal reason %s exactly and admits a fresh peer',
  async (reason) => {
    const { resolver, retain } = fixture();
    const signal = new AbortController();
    const work = retain(resolver.resolve('example.test', signal.signal));
    await entered();
    original.cancel.mockImplementation(() => {
      for (let i = 0; i < 3; i++) returned(i, cancelled());
    });
    signal.abort(reason);
    await expect(work).rejects.toBe(signal.signal.reason);
    const fresh = retain(resolver.resolve('other.test', new AbortController().signal));
    await entered(6);
    for (let i = 3; i < 6; i++) returned(i);
    await expect(fresh).resolves.toEqual({ a: [], aaaa: [], cname: [] });
    await expect(retain(resolver.close())).resolves.toBeUndefined();
  }
);
it('keeps an earlier foreign ECANCELLED when close enters before its catch microtask', async () => {
  const { resolver, retain } = fixture();
  const work = retain(resolver.resolve('example.test', new AbortController().signal));
  await entered();
  const foreign = cancelled();
  returned(0, foreign);
  original.cancel.mockImplementation(() => {
    returned(1, cancelled());
    returned(2, cancelled());
  });
  const close = retain(resolver.close());
  await expect(work).rejects.toBe(foreign);
  await expect(close).rejects.toBe(foreign);
});
it('retains an uncancelled ECANCELLED callback as genuine failure', async () => {
  const { resolver, retain } = fixture();
  const work = retain(resolver.resolve('example.test', new AbortController().signal));
  await entered();
  const foreign = cancelled();
  returned(0, foreign);
  returned(1);
  returned(2);
  await expect(work).rejects.toBe(foreign);
  await expect(retain(resolver.close())).rejects.toBe(foreign);
});
it.each([false, undefined])(
  'preserves earlier callback failure before a later cancel throws %s',
  async (reason) => {
    const { resolver, retain } = fixture();
    const work = retain(resolver.resolve('example.test', new AbortController().signal));
    await entered();
    const foreign = new Error('ORIGINAL_FOREIGN');
    returned(0, foreign);
    original.cancel.mockImplementation(() => {
      throw reason;
    });
    const close = retain(resolver.close());
    returned(1);
    returned(2);
    await expect(work).rejects.toBe(foreign);
    await expect(close).rejects.toBe(foreign);
  }
);
it.each([false, undefined])(
  'does not qualify synchronous cancellation callbacks when cancel throws %s',
  async (reason) => {
    const { resolver, retain } = fixture();
    const work = retain(resolver.resolve('example.test', new AbortController().signal));
    await entered();
    const first = cancelled();
    original.cancel.mockImplementation(() => {
      returned(0, first);
      returned(1, cancelled());
      returned(2, cancelled());
      throw reason;
    });
    const close = retain(resolver.close());
    await expect(work).rejects.toBe(first);
    await expect(close).rejects.toBe(first);
  }
);
it.each([false, undefined])(
  'retains invocation throw %s after a synchronous success callback',
  async (reason) => {
    const { resolver, retain } = fixture();
    original.invoke = (callback) => {
      callback(null, []);
      throw reason;
    };
    const work = retain(resolver.resolve('example.test', new AbortController().signal));
    await expect(work).rejects.toBe(reason);
    await expect(retain(resolver.close())).rejects.toBe(reason);
  }
);
it('holds close until the last original cancelled callback returns', async () => {
  const { resolver, retain } = fixture();
  const work = retain(resolver.resolve('example.test', new AbortController().signal));
  await entered();
  original.cancel.mockImplementation(() => {
    returned(0, cancelled());
    returned(1, cancelled());
  });
  const close = retain(resolver.close());
  let settled = false;
  void close.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  returned(2, cancelled());
  await expect(work).rejects.toMatchObject({ code: 'ABORTED' });
  await expect(close).resolves.toBeUndefined();
});
it.each([false, undefined])(
  'keeps a non-cancellation callback failure %s after owned cancel',
  async (reason) => {
    const { resolver, retain } = fixture();
    const work = retain(resolver.resolve('example.test', new AbortController().signal));
    await entered();
    const close = retain(resolver.close());
    returned(0, reason);
    returned(1, cancelled());
    returned(2, cancelled());
    await expect(work).rejects.toBe(reason);
    await expect(close).rejects.toBe(reason);
  }
);

it.each([false, undefined])(
  'preserves original callback rejection before invocation throw %s',
  async (reason) => {
    const { resolver, retain } = fixture();
    const foreign = new Error('ORIGINAL_CALLBACK');
    original.invoke = (callback) => {
      callback(foreign);
      throw reason;
    };
    await expect(
      retain(resolver.resolve('example.test', new AbortController().signal))
    ).rejects.toBe(foreign);
    await expect(retain(resolver.close())).rejects.toBe(foreign);
  }
);
it('does not turn absence plus invocation throw into an empty answer', async () => {
  const { resolver, retain } = fixture();
  const absence = Object.assign(new Error('ORIGINAL_ABSENCE'), { code: 'ENODATA' });
  original.invoke = (callback) => {
    callback(absence);
    throw false;
  };
  await expect(retain(resolver.resolve('example.test', new AbortController().signal))).rejects.toBe(
    false
  );
  await expect(retain(resolver.close())).rejects.toBe(false);
});

it.each([false, undefined])(
  'keeps staged cancellation before duplicate and failed cancel %s',
  async (reason) => {
    const { resolver, retain } = fixture();
    const work = retain(resolver.resolve('example.test', new AbortController().signal));
    await entered();
    const first = cancelled();
    original.cancel.mockImplementation(() => {
      returned(0, first);
      original.callbacks[0]!.callback(null, []);
      returned(1, cancelled());
      returned(2, cancelled());
      throw reason;
    });
    const close = retain(resolver.close());
    await expect(work).rejects.toBe(first);
    await expect(close).rejects.toBe(first);
  }
);
