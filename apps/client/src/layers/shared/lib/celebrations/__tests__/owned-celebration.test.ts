/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function library(animation: Promise<null> = Promise.resolve(null)) {
  const original = Object.assign(
    vi.fn(() => Promise.resolve(null)),
    {
      reset: vi.fn(),
      shapeFromText: vi.fn(() => ({})),
      create: vi.fn(),
    }
  );
  const owned = Object.assign(
    vi.fn(() => animation),
    { reset: vi.fn() }
  );
  original.create.mockReturnValue(owned);
  return { module: { default: original }, original, owned };
}
function owner() {
  let current = true;
  const cleanups = new Set<() => void>();
  const released = vi.fn();
  return {
    cleanups,
    released,
    retire() {
      current = false;
      for (const cleanup of cleanups) cleanup();
    },
    port: {
      beforeEffect() {
        if (!current) throw new Error('ORIGINAL_OWNER_RETIRED');
      },
      registerCleanup(cleanup: () => void) {
        cleanups.add(cleanup);
        return () => {
          cleanups.delete(cleanup);
          released();
        };
      },
    },
  };
}
afterEach(() => {
  vi.doUnmock('canvas-confetti');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('retains cancellation before a held original lazy import and never enters a late canvas', async () => {
  vi.resetModules();
  const loaded = deferred<ReturnType<typeof library>['module']>();
  const entered = deferred<void>();
  vi.doMock('canvas-confetti', () => {
    entered.resolve();
    return loaded.promise;
  });
  const { fireCelebration } = await import('../celebration-effects');
  const original = library();
  const origin = owner();
  const work = fireCelebration({ kind: 'burst' }, origin.port);
  const result = work.then(
    () => {
      throw new Error('UNEXPECTED_LATE_VISUAL');
    },
    (value: unknown) => ({ value })
  );
  try {
    await entered.promise;
    expect(origin.cleanups.size).toBe(1);
    origin.retire();
    loaded.resolve(original.module);
    expect((await result).value).toBeInstanceOf(Error);
    expect(original.original.create).not.toHaveBeenCalled();
    expect(original.original).not.toHaveBeenCalled();
    expect(original.owned).not.toHaveBeenCalled();
  } finally {
    loaded.resolve(original.module);
    await result;
  }
});

it('retires only its exact instance and timers while an ordinary celebration continues', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const animation = deferred<null>();
  const original = library(animation.promise);
  vi.doMock('canvas-confetti', () => original.module);
  const { fireCelebration } = await import('../celebration-effects');
  const origin = owner();
  const cancel = await fireCelebration({ kind: 'burst' }, origin.port);
  const ordinary = await fireCelebration({ kind: 'burst' });
  try {
    expect(original.original.create).toHaveBeenCalledExactlyOnceWith(undefined, {
      resize: true,
      useWorker: false,
    });
    expect(original.owned).toHaveBeenCalledTimes(2);
    origin.retire();
    cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(original.owned).toHaveBeenCalledTimes(2);
    expect(original.owned.reset).toHaveBeenCalledOnce();
    expect(original.original).toHaveBeenCalledTimes(3);
    expect(original.original.reset).not.toHaveBeenCalled();
  } finally {
    cancel();
    ordinary();
    animation.resolve(null);
    await animation.promise;
  }
});

it('releases its exact retained receipt only after original timers and animations complete', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const animation = deferred<null>();
  const original = library(animation.promise);
  vi.doMock('canvas-confetti', () => original.module);
  const { fireCelebration } = await import('../celebration-effects');
  const origin = owner();
  const cancel = await fireCelebration({ kind: 'burst' }, origin.port);
  try {
    await vi.advanceTimersByTimeAsync(130);
    expect(origin.cleanups.size).toBe(1);
    expect(origin.released).not.toHaveBeenCalled();
    animation.resolve(null);
    await animation.promise;
    await Promise.resolve();
    expect(origin.cleanups.size).toBe(0);
    expect(origin.released).toHaveBeenCalledOnce();
    expect(original.owned.reset).toHaveBeenCalledOnce();
  } finally {
    animation.resolve(null);
    await animation.promise;
    cancel();
  }
});

it.each([false, undefined])(
  'retains an original timer-clear failure %s without replay or foreign reset',
  async (cause) => {
    vi.useFakeTimers();
    vi.resetModules();
    const animation = deferred<null>();
    const original = library(animation.promise);
    vi.doMock('canvas-confetti', () => original.module);
    const { fireCelebration } = await import('../celebration-effects');
    const origin = owner();
    const clearOriginal = globalThis.clearTimeout;
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((id) => {
      clearOriginal(id);
      throw cause;
    });
    const cancel = await fireCelebration({ kind: 'burst' }, origin.port);
    const failure = (operation: () => void) => {
      try {
        operation();
      } catch (value) {
        return { value };
      }
      throw new Error('ORIGINAL_CLEANUP_FAILURE_LOST');
    };
    try {
      expect(failure(cancel).value).toBe(cause);
      expect(failure(cancel).value).toBe(cause);
      expect(clear).toHaveBeenCalledOnce();
      expect(original.owned.reset).toHaveBeenCalledOnce();
      expect(original.original.reset).not.toHaveBeenCalled();
      expect(origin.cleanups.size).toBe(1);
      expect(origin.released).not.toHaveBeenCalled();
    } finally {
      clear.mockRestore();
      animation.resolve(null);
      await animation.promise;
    }
  }
);

it('joins reentrant producer retirement before resetting the acquired original instance', async () => {
  vi.resetModules();
  const animation = deferred<null>();
  const original = library(animation.promise);
  const origin = owner();
  original.owned.mockImplementation(() => {
    origin.retire();
    expect(original.owned.reset).not.toHaveBeenCalled();
    return animation.promise;
  });
  vi.doMock('canvas-confetti', () => original.module);
  const { fireCelebration } = await import('../celebration-effects');
  try {
    await expect(fireCelebration({ kind: 'burst' }, origin.port)).rejects.toThrow(
      'Celebration owner retired.'
    );
    expect(original.owned).toHaveBeenCalledOnce();
    expect(original.owned.reset).toHaveBeenCalledOnce();
    expect(original.original.reset).not.toHaveBeenCalled();
  } finally {
    animation.resolve(null);
    await animation.promise;
    for (const cleanup of origin.cleanups) {
      try {
        cleanup();
      } catch {
        /* The original refused entry is asserted above. */
      }
    }
  }
});

it.each([false, undefined])(
  'retains original animation rejection %s in the exact cancellation duty',
  async (cause) => {
    vi.useFakeTimers();
    vi.resetModules();
    let reject!: (value: unknown) => void;
    const animation = new Promise<null>((_resolve, no) => {
      reject = no;
    });
    const returned = animation.catch(() => {});
    const original = library(animation);
    vi.doMock('canvas-confetti', () => original.module);
    const { fireCelebration } = await import('../celebration-effects');
    const origin = owner();
    const cancel = await fireCelebration({ kind: 'burst' }, origin.port);
    const failure = () => {
      try {
        cancel();
      } catch (value) {
        return { value };
      }
      throw new Error('ORIGINAL_ANIMATION_FAILURE_LOST');
    };
    try {
      reject(cause);
      await returned;
      await Promise.resolve();
      expect(failure().value).toBe(cause);
      expect(failure().value).toBe(cause);
      expect(original.owned.reset).toHaveBeenCalledOnce();
      expect(original.original.reset).not.toHaveBeenCalled();
      expect(origin.cleanups.size).toBe(1);
      expect(origin.released).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(original.owned).toHaveBeenCalledTimes(2);
    } finally {
      reject(cause);
      await returned;
    }
  }
);

it.each([false, undefined])(
  'retains the original synchronous producer failure %s after cancellation',
  async (cause) => {
    vi.resetModules();
    const original = library();
    original.owned.mockImplementation(() => {
      throw cause;
    });
    vi.doMock('canvas-confetti', () => original.module);
    const { fireCelebration } = await import('../celebration-effects');
    const origin = owner();
    let caught: { value: unknown } | undefined;
    try {
      await fireCelebration({ kind: 'burst' }, origin.port);
    } catch (value) {
      caught = { value };
    }
    expect(caught).toEqual({ value: cause });
    expect(origin.cleanups.size).toBe(1);
    for (const cleanup of origin.cleanups) {
      let first: { value: unknown } | undefined;
      try {
        cleanup();
      } catch (value) {
        first = { value };
      }
      expect(first).toEqual({ value: cause });
    }
    expect(original.owned).toHaveBeenCalledOnce();
    expect(original.owned.reset).toHaveBeenCalledOnce();
    expect(origin.released).not.toHaveBeenCalled();
  }
);
