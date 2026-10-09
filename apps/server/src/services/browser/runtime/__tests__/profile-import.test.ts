import { expect, it, vi } from 'vitest';
import { importNewBrowserProfile } from '../profiles/import.js';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it.each([false, undefined])(
  'joins the original close and preserves a falsy restore/open failure %s',
  async (value) => {
    const finish = vi.fn();
    await expect(
      importNewBrowserProfile({
        open: () => Promise.reject(value),
        close: vi.fn(),
        current: () => true,
        finish,
      })
    ).rejects.toBe(value);
    expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  }
);
it('holds availability until the genuine close returns and quarantines a cancelled restore', async () => {
  const restored = deferred<object>(),
    closed = deferred<void>(),
    original = {};
  let current = true;
  const finish = vi.fn(),
    close = vi.fn(() => closed.promise);
  const operation = importNewBrowserProfile({
    open: () => restored.promise,
    close,
    current: () => current,
    finish,
  });
  const outcome = operation.then(
    () => ({ ok: true }),
    (value) => ({ ok: false, value })
  );
  current = false;
  restored.resolve(original);
  await vi.waitFor(() => expect(close).toHaveBeenCalledExactlyOnceWith(original));
  expect(finish).not.toHaveBeenCalled();
  closed.resolve();
  expect((await outcome).ok).toBe(false);
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
it.each([false, undefined])(
  'never publishes availability after an original falsy close refusal %s',
  async (value) => {
    const finish = vi.fn();
    await expect(
      importNewBrowserProfile({
        open: async () => ({}),
        close: () => Promise.reject(value),
        current: () => true,
        finish,
      })
    ).rejects.toBe(value);
    expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  }
);
it('requires both genuine restore and close before publishing availability', async () => {
  const order: string[] = [];
  await importNewBrowserProfile({
    open: async () => {
      order.push('restore');
      return {};
    },
    close: async () => {
      order.push('close');
    },
    current: () => true,
    finish: (observed) => {
      expect(observed).toBe(true);
      order.push('available');
    },
  });
  expect(order).toEqual(['restore', 'close', 'available']);
});

it.each([false, undefined])(
  'quarantines a late original actor failure %s after still joining close',
  async (value) => {
    const close = vi.fn(async () => {}),
      finish = vi.fn();
    let calls = 0;
    const current = () => {
      if (++calls === 3) throw value;
      return true;
    };
    await expect(
      importNewBrowserProfile({ open: async () => ({}), close, current, finish })
    ).rejects.toBe(value);
    expect(close).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  }
);
