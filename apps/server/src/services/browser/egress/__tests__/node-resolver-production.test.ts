import { expect, it, onTestFinished, vi } from 'vitest';
const original = vi.hoisted(() => ({
  cancel: vi.fn(() => {}),
  a: vi.fn(async (): Promise<string[]> => []),
  aaaa: vi.fn(async (): Promise<string[]> => []),
  cname: vi.fn(async (): Promise<string[]> => []),
  readCancel: undefined as undefined | (() => void),
}));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    get cancel() {
      original.readCancel?.();
      return original.cancel;
    }
    resolve4 = original.a;
    resolve6 = original.aaaa;
    resolveCname = original.cname;
  },
}));
vi.mock('node:dns', () => ({
  Resolver: class {
    get cancel() {
      original.readCancel?.();
      return original.cancel;
    }
    resolve4(_name: string, callback: (error: unknown, values?: string[]) => void) {
      void original.a().then(
        (values) => callback(null, values),
        (value) => callback(value)
      );
    }
    resolve6(_name: string, callback: (error: unknown, values?: string[]) => void) {
      void original.aaaa().then(
        (values) => callback(null, values),
        (value) => callback(value)
      );
    }
    resolveCname(_name: string, callback: (error: unknown, values?: string[]) => void) {
      void original.cname().then(
        (values) => callback(null, values),
        (value) => callback(value)
      );
    }
  },
}));
import { createProductionDestinationResolver } from '../node-resolver.js';

it.each([undefined, false])(
  'joins held original DNS rejection %s through cancellation without healing',
  async (reason) => {
    let release!: (value: unknown) => void;
    const held = new Promise<string[]>((_resolve, reject) => {
      release = reject;
    });
    const resolver = createProductionDestinationResolver();
    const originals: { work?: Promise<unknown>; close?: Promise<void> } = {};
    onTestFinished(async () => {
      release(reason);
      const results = await Promise.allSettled([
        ...(originals.work ? [originals.work] : []),
        ...(originals.close ? [originals.close] : []),
      ]);
      for (const result of results)
        if (result.status === 'rejected' && !Object.is(result.reason, reason)) throw result.reason;
      original.cancel.mockReset();
      original.a.mockReset();
      original.aaaa.mockReset();
      original.cname.mockReset();
      original.readCancel = undefined;
    });
    original.cancel.mockImplementation(() => {});
    original.a.mockImplementation(() => held);
    original.aaaa.mockResolvedValue([]);
    original.cname.mockResolvedValue([]);
    originals.work = resolver.resolve('example.test', new AbortController().signal);
    void originals.work.catch(() => {});
    await vi.waitFor(() => expect(original.a).toHaveBeenCalledOnce());
    originals.close = resolver.close();
    void originals.close.catch(() => {});
    let settled = false;
    void originals.close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release(reason);
    await expect(originals.work).rejects.toBe(reason);
    await expect(originals.close).rejects.toBe(reason);
    expect(original.cancel).toHaveBeenCalledOnce();
  }
);

it('banks resolution before original cancel getter reenters close; late exact resolver is cancelled and no family begins', async () => {
  const resolver = createProductionDestinationResolver();
  const originals: { work?: Promise<unknown>; close?: Promise<void> } = {};
  let aborted: unknown;
  onTestFinished(async () => {
    const results = await Promise.allSettled([
      ...(originals.work ? [originals.work] : []),
      ...(originals.close ? [originals.close] : []),
    ]);
    for (const result of results)
      if (result.status === 'rejected' && result.reason !== aborted) throw result.reason;
    original.cancel.mockReset();
    original.a.mockReset();
    original.aaaa.mockReset();
    original.cname.mockReset();
    original.readCancel = undefined;
  });
  original.cancel.mockImplementation(() => {});
  original.readCancel = () => {
    originals.close = resolver.close();
  };
  originals.work = resolver.resolve('example.test', new AbortController().signal);
  try {
    await originals.work;
  } catch (value) {
    aborted = value;
  }
  await originals.close;
  expect(original.cancel).toHaveBeenCalledOnce();
  expect(original.a).not.toHaveBeenCalled();
  expect(original.aaaa).not.toHaveBeenCalled();
  expect(original.cname).not.toHaveBeenCalled();
});

it.each([undefined, false])(
  'retains original cancellation rejection %s while still joining the held DNS callback',
  async (reason) => {
    let release!: (value: unknown) => void;
    const held = new Promise<string[]>((_resolve, reject) => {
      release = reject;
    });
    const secondary = new Error('ORIGINAL_DNS_SECONDARY');
    const resolver = createProductionDestinationResolver();
    const originals: { work?: Promise<unknown>; close?: Promise<void> } = {};
    onTestFinished(async () => {
      release(secondary);
      if (originals.work) {
        const result = await Promise.allSettled([originals.work]);
        if (result[0]!.status !== 'rejected' || result[0]!.reason !== secondary)
          throw new Error('ORIGINAL_DNS_NOT_JOINED');
      }
      if (originals.close) {
        const result = await Promise.allSettled([originals.close]);
        if (result[0]!.status !== 'rejected' || !Object.is(result[0]!.reason, reason))
          throw new Error('ORIGINAL_CANCEL_NOT_RETAINED');
      }
      original.cancel.mockReset();
      original.a.mockReset();
      original.aaaa.mockReset();
      original.cname.mockReset();
      original.readCancel = undefined;
    });
    original.cancel.mockImplementation(() => {
      throw reason;
    });
    original.a.mockImplementation(() => held);
    original.aaaa.mockResolvedValue([]);
    original.cname.mockResolvedValue([]);
    originals.work = resolver.resolve('example.test', new AbortController().signal);
    void originals.work.catch(() => {});
    await vi.waitFor(() => expect(original.a).toHaveBeenCalledOnce());
    originals.close = resolver.close();
    void originals.close.catch(() => {});
    let settled = false;
    void originals.close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release(secondary);
    await expect(originals.work).rejects.toBe(secondary);
    await expect(originals.close).rejects.toBe(reason);
  }
);

it('retains uncancelled original family undefined for both caller and later close without classifying an absent token', async () => {
  const resolver = createProductionDestinationResolver();
  const originals: { work?: Promise<unknown>; close?: Promise<void> } = {};
  onTestFinished(async () => {
    let failure: Readonly<{ value: unknown }> | undefined;
    // Enter the exact owner's close even when an earlier assertion prevented body assignment.
    try {
      originals.close ??= resolver.close();
    } catch (value) {
      failure = Object.freeze({ value });
    }
    const results = await Promise.allSettled([
      ...(originals.work ? [originals.work] : []),
      ...(originals.close ? [originals.close] : []),
    ]);
    for (const result of results) {
      if (result.status === 'fulfilled')
        failure ??= Object.freeze({ value: new Error('EXACT_UNDEFINED_ORIGINAL_NOT_RETAINED') });
      else if (result.reason !== undefined) failure ??= Object.freeze({ value: result.reason });
    }
    // Mock restoration is independent of every original join outcome.
    for (const restore of [
      () => original.cancel.mockReset(),
      () => original.a.mockReset(),
      () => original.aaaa.mockReset(),
      () => original.cname.mockReset(),
      () => {
        original.readCancel = undefined;
      },
    ]) {
      try {
        restore();
      } catch (value) {
        failure ??= Object.freeze({ value });
      }
    }
    if (failure) throw failure.value;
  });
  original.cancel.mockImplementation(() => {});
  original.a.mockRejectedValue(undefined);
  original.aaaa.mockResolvedValue([]);
  original.cname.mockResolvedValue([]);
  originals.work = resolver.resolve('example.test', new AbortController().signal);
  await expect(originals.work).rejects.toBeUndefined();
  originals.close = resolver.close();
  await expect(originals.close).rejects.toBeUndefined();
  expect(original.cancel).not.toHaveBeenCalled();
});
