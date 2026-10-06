import { expect, it, vi, onTestFinished } from 'vitest';
import {
  OriginalSameDocumentObserver,
  registerOriginalPageSession,
} from '../native-same-document.js';
import { tabFixture } from '../../__tests__/parent-fixture.js';

// Actual private record/ownership bank; original native CDP callbacks/metadata reads are explicit
// protocol doubles here. These controls do not establish Chromium event provenance or native UI.
async function fixture() {
  const f = tabFixture();
  const handlers = new Set<(event: { frameId: string; url: string }) => void>();
  let alive = true;
  const off = vi.fn(
    (_event: string, listener: (event: { frameId: string; url: string }) => void) => {
      handlers.delete(listener);
    }
  );
  Object.assign(f.session, {
    on: vi.fn((_event: string, listener: (event: { frameId: string; url: string }) => void) => {
      handlers.add(listener);
    }),
    off,
    send: vi.fn(async (method: string) =>
      method === 'Page.getFrameTree'
        ? { frameTree: { frame: { id: 'original-root-frame' } } }
        : undefined
    ),
  });
  const observer = new OriginalSameDocumentObserver(f.record, f.tab, () => alive);
  // Reserve original observer completion before any fallible asynchronous acquisition.
  onTestFinished(async () => {
    await Promise.allSettled([observer.close()]);
  });
  const original = await f.context.newCDPSession();
  registerOriginalPageSession(f.page, original, () => alive);
  await observer.start();
  return {
    ...f,
    observer,
    off,
    emit: (url: string, frameId = 'original-root-frame') => {
      for (const handler of handlers) handler({ url, frameId });
    },
    lose: () => {
      alive = false;
    },
  };
}
it.each(['/path', '/path?query=next', '/path#section'])(
  'requires exact original root native event for %s in either delivery order',
  async (path) => {
    const f = await fixture(),
      url = 'http://127.0.0.1:9001' + path;
    let complete = false;
    const original = f.observer.match(url, f.tab.binding).then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    f.emit(url, 'unrelated-subframe');
    await Promise.resolve();
    expect(complete).toBe(false);
    f.emit(url);
    await original;
    f.emit(url + '?later');
    await f.observer.match(url + '?later', f.tab.binding);
    expect(f.session.detach).not.toHaveBeenCalled();
  }
);
it('cannot consume another URL or a rebound canonical lifetime as original native proof', async () => {
  const f = await fixture();
  const url = 'http://127.0.0.1:9001/path';
  f.emit(url);
  let complete = false;
  const held = f.observer
    .match(url, { ...f.tab.binding, epoch: f.tab.binding.epoch + 1 })
    .then(() => {
      complete = true;
    });
  void held.catch(() => undefined);
  await Promise.resolve();
  expect(complete).toBe(false);
  await f.observer.close();
  await expect(held).rejects.toThrow('BROWSER_STOPPED');
});
it('retains the exact falsy original listener-removal failure while independently joining original metadata readiness', async () => {
  const f = await fixture();
  f.off.mockImplementationOnce(() => {
    throw undefined;
  });
  await expect(f.observer.close()).rejects.toBeUndefined();
  expect(f.session.detach).not.toHaveBeenCalled();
});
it('bounds unconsumed native originals and cannot accept an old proof after original observer loss', async () => {
  const f = await fixture();
  for (let index = 0; index < 16; index++) f.emit('http://127.0.0.1:9001/path/' + index);
  f.emit('http://127.0.0.1:9001/path/17');
  expect(f.record.lifetime.uncertain).toBe(true);
  await expect(f.observer.match('http://127.0.0.1:9001/path/0', f.tab.binding)).rejects.toThrow(
    'STALE_BINDING'
  );
});

it('joins the exact held original enable when that native send synchronously reenters close and rejects undefined', async () => {
  const f = tabFixture();
  let rejectEnable!: (reason: unknown) => void;
  const enable = new Promise<void>((_resolve, reject) => {
    rejectEnable = reject;
  });
  let closing: Promise<void> | undefined;
  const observer = new OriginalSameDocumentObserver(f.record, f.tab, () => true);
  // Release and join these exact originals even if any assertion below throws.
  onTestFinished(async () => {
    rejectEnable(undefined);
    await Promise.allSettled([observer.close(), enable]);
  });
  const on = vi.fn(),
    off = vi.fn();
  const send = vi.fn(async (method: string) => {
    if (method !== 'Page.enable') throw new Error('Later metadata must not enter after close');
    closing = observer.close();
    return enable;
  });
  Object.assign(f.session, { on, off, send });
  const original = await f.context.newCDPSession();
  registerOriginalPageSession(f.page, original, () => true);
  const starting = observer.start();
  const observedStart = starting.then(
    () => ({ failed: false as const }),
    (reason: unknown) => ({ failed: true as const, reason })
  );
  expect(closing).toBeDefined();
  let closeSettled = false;
  const observedClose = closing!.then(
    () => {
      closeSettled = true;
      return { failed: false as const };
    },
    (reason: unknown) => {
      closeSettled = true;
      return { failed: true as const, reason };
    }
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(closeSettled).toBe(false);
  expect(on).toHaveBeenCalledTimes(1);
  expect(off).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith('Page.enable');
  rejectEnable(undefined);
  expect(await observedStart).toEqual({ failed: true, reason: undefined });
  expect(await observedClose).toEqual({ failed: true, reason: undefined });
  expect(off).toHaveBeenCalledTimes(1);
  expect(observer.close()).toBe(closing);
  expect(f.session.detach).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  'joins a reentrant original listener registration before removal failure %s',
  async (removalFailure) => {
    const f = tabFixture();
    const observer = new OriginalSameDocumentObserver(f.record, f.tab, () => true);
    let attached = false;
    let closing: Promise<void> | undefined;
    const originals: { starting?: Promise<void> } = {};
    onTestFinished(async () => {
      await Promise.allSettled([originals.starting ?? Promise.resolve(), observer.close()]);
    });
    const off = vi.fn(() => {
      expect(attached).toBe(true);
      attached = false;
      throw removalFailure;
    });
    const send = vi.fn();
    const on = vi.fn(() => {
      closing = observer.close();
      attached = true;
      throw undefined;
    });
    Object.assign(f.session, { on, off, send });
    const original = await f.context.newCDPSession();
    registerOriginalPageSession(f.page, original, () => true);
    const starting = observer.start();
    originals.starting = starting;
    const started = starting.then(
      () => ({ failed: false }),
      (reason) => ({ failed: true, reason })
    );
    const closed = observer.close().then(
      () => ({ failed: false }),
      (reason) => ({ failed: true, reason })
    );
    expect(off).not.toHaveBeenCalled();
    expect(await started).toEqual({ failed: true, reason: undefined });
    expect(await closed).toEqual({ failed: true, reason: undefined });
    expect(observer.close()).toBe(closing);
    expect(off).toHaveBeenCalledTimes(1);
    expect(attached).toBe(false);
    expect(send).not.toHaveBeenCalled();
  }
);
