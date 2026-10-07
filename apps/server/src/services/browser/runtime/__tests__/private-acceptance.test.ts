import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import {
  installPrivateBrowserAcceptance,
  readPrivateBrowserAcceptance,
} from '../private-acceptance.js';

function owner() {
  return installPrivateBrowserAcceptance({
    resources: { onOriginalChild: async () => {} },
    viewerSamples: () => {},
    wrapOriginalCodexTransport: (original) => original,
  });
}
it('retains and closes the original listener before its ready callback can run', async () => {
  const original = createServer();
  const observer = owner();
  const shutdown = vi.fn(async () => {});
  observer.captureShutdownServices(shutdown);
  observer.captureStartup(Promise.resolve());
  original.listen(0, '127.0.0.1');
  observer.captureOriginalListener(original);
  await observer.close();
  expect(original.listening).toBe(false);
  expect(shutdown).toHaveBeenCalledOnce();
  expect(readPrivateBrowserAcceptance()).toBeUndefined();
});
it('keeps a falsy original startup error while joining real listener and service cleanup', async () => {
  const original = createServer();
  original.listen(0, '127.0.0.1');
  await once(original, 'listening');
  const observer = owner();
  observer.captureOriginalListener(original);
  observer.captureListener(original);
  expect(await observer.waitForListener()).toBe(original);
  const shutdown = vi.fn(async () => {
    throw new Error('later cleanup failure');
  });
  observer.captureShutdownServices(shutdown);
  observer.captureStartup(Promise.reject(false));
  await expect(observer.close()).rejects.toBe(false);
  expect(shutdown).toHaveBeenCalledOnce();
  expect(original.listening).toBe(false);
  expect(readPrivateBrowserAcceptance()).toBeUndefined();
});
it('refuses a different ready listener without losing the retained original cleanup', async () => {
  const original = createServer(),
    other = createServer();
  original.listen(0, '127.0.0.1');
  await once(original, 'listening');
  const observer = owner();
  observer.captureOriginalListener(original);
  observer.captureStartup(Promise.resolve());
  expect(() => observer.captureListener(other)).toThrow(
    'PRIVATE_ACCEPTANCE_ORIGINAL_LISTENER_REQUIRED'
  );
  await expect(observer.close()).rejects.toThrow('PRIVATE_ACCEPTANCE_ORIGINAL_LISTENER_REQUIRED');
  expect(original.listening).toBe(false);
  expect(readPrivateBrowserAcceptance()).toBeUndefined();
});

it.each([false, undefined])(
  'joins the retained listener observation after the exact original startup failure %s',
  async (failure) => {
    let reject!: (value: unknown) => void;
    const startup = new Promise<void>((_resolve, no) => {
      reject = no;
    });
    const observer = owner();
    observer.captureStartup(startup);
    const shutdown = vi.fn(async () => {
      throw new Error('later cleanup failure');
    });
    observer.captureShutdownServices(shutdown);
    const listening = observer.waitForListener();
    let returned = false;
    const close = observer.close();
    const joined = Promise.allSettled([listening, close]).then((result) => {
      returned = true;
      return result;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    reject(failure);
    const results = await joined;
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toBe(failure);
    }
    expect(shutdown).toHaveBeenCalledOnce();
    expect(readPrivateBrowserAcceptance()).toBeUndefined();
  }
);
it('rejects the original pending listener observation on pre-listen closure', async () => {
  const observer = owner();
  observer.captureStartup(Promise.resolve());
  const listening = observer.waitForListener();
  const joined = Promise.allSettled([listening, observer.close()]);
  const [ready, closed] = await joined;
  expect(ready?.status).toBe('rejected');
  if (ready?.status === 'rejected')
    expect(ready.reason.message).toBe('PRIVATE_ACCEPTANCE_CLOSED_BEFORE_LISTENING');
  expect(closed?.status).toBe('fulfilled');
});

it('rejects actual original close before original listening without stranding the waiter', async () => {
  const original = createServer();
  const observer = owner();
  observer.captureStartup(Promise.resolve());
  observer.captureOriginalListener(original);
  const waiting = observer.waitForListener();
  const ended = once(original, 'close');
  original.close();
  await ended;
  const results = await Promise.allSettled([waiting, observer.close()]);
  for (const result of results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected')
      expect(result.reason.message).toBe('PRIVATE_ACCEPTANCE_ORIGINAL_CLOSED_BEFORE_LISTENING');
  }
  expect(readPrivateBrowserAcceptance()).toBeUndefined();
});
it.each([false, undefined])(
  'rejects exact original listener error %s without truthiness coercion',
  async (value) => {
    const original = createServer();
    const observer = owner();
    observer.captureStartup(Promise.resolve());
    observer.captureOriginalListener(original);
    const waiting = observer.waitForListener();
    // Controlled fault at the original EventEmitter error seam, not fabricated listening.
    original.emit('error', value);
    expect(await Promise.allSettled([waiting, observer.close()])).toEqual([
      { status: 'rejected', reason: value },
      { status: 'rejected', reason: value },
    ]);
    expect(readPrivateBrowserAcceptance()).toBeUndefined();
  }
);
