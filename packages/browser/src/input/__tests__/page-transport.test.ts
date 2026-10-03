import { afterEach, expect, it, vi } from 'vitest';
import type { CDPSession, Page } from 'playwright-core';
import { createPageTransport } from '../page-transport.js';
import { createPointerLedger, type PointerLedger } from '../../tabs/pointer.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import type { BrowserBinding } from '../../contracts.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(observeBinding?: () => void, pointer?: PointerLedger) {
  let binding: BrowserBinding = {
    browserId: parseBrowserId('browser_subject_A_000000000000000'),
    browserGeneration: 0,
    tabId: parseTabId('canonical_tab_A_00000000000000000'),
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  };
  let current = true;
  const effects: unknown[] = [];
  const record = (method: string) =>
    vi.fn(async (...args: unknown[]) => {
      effects.push([method, ...args]);
    });
  const session = { send: record('send'), detach: record('detach') };
  const context = { newCDPSession: vi.fn(async () => session as unknown as CDPSession) };
  const mouse = {
    move: record('move'),
    down: record('mouseDown'),
    up: record('mouseUp'),
    wheel: record('wheel'),
  };
  const keyboard = { down: record('keyDown'), up: record('keyUp'), insertText: record('text') };
  const page = {
    context: () => context,
    mouse,
    keyboard,
    viewportSize: () => ({ width: 100, height: 80 }),
    isClosed: () => false,
  };
  const ledger = pointer ?? createPointerLedger(() => (current ? binding : null));
  const owner = createPageTransport({
    pointer: ledger,
    page: page as unknown as Page,
    current: () => current,
    readBinding: () => {
      observeBinding?.();
      return { ...binding };
    },
    retire: () => {
      current = false;
    },
  });
  return {
    owner,
    pointer: ledger,
    page,
    context,
    session,
    mouse,
    keyboard,
    effects,
    replace: () => {
      binding = { ...binding, epoch: binding.epoch + 1 };
    },
    retire: () => {
      current = false;
    },
  };
}
const signal = () => new AbortController().signal;
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

it('uses only canonical public Page input and two fixed native reset commands', async () => {
  const h = fixture();
  await h.owner.ready;
  for (const step of [
    { kind: 'mouseMove', x: 2, y: 3 },
    { kind: 'mouseDown', button: 'left' },
    { kind: 'mouseUp', button: 'left' },
    { kind: 'wheel', deltaX: 1, deltaY: -2 },
    { kind: 'keyDown', key: 'Shift' },
    { kind: 'keyUp', key: 'Shift' },
    { kind: 'text', text: '😀中文' },
  ] as const)
    await h.owner.native.dispatch(step, signal());
  await h.owner.native.cancelComposition(signal());
  await h.owner.native.cancelDrag(signal());
  expect(h.context.newCDPSession).toHaveBeenCalledWith(h.page);
  expect(h.effects).toEqual([
    ['move', 2, 3],
    ['mouseDown', { button: 'left' }],
    ['mouseUp', { button: 'left' }],
    ['wheel', 1, -2],
    ['keyDown', 'Shift'],
    ['keyUp', 'Shift'],
    ['text', '😀中文'],
    ['send', 'Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }],
    ['send', 'Input.cancelDragging'],
  ]);
  expect(await h.owner.close()).toMatchObject({ detached: true, uncertain: false });
});
it('refuses points on or beyond the canonical viewport edge without a Page move', async () => {
  const h = fixture();
  await h.owner.ready;
  await expect(
    h.owner.native.dispatch({ kind: 'mouseMove', x: 100, y: 1 }, signal())
  ).rejects.toThrow('VIEWPORT');
  expect(h.effects).toEqual([]);
  await h.owner.close();
});
it('refuses API-getter reentrant binding replacement before the native call', async () => {
  const h = fixture();
  await h.owner.ready;
  Object.defineProperty(h.keyboard, 'insertText', {
    get: () => {
      h.replace();
      return vi.fn(async () => {
        h.effects.push('WRONG_LIFETIME');
      });
    },
  });
  await expect(
    h.owner.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal())
  ).rejects.toThrow('TARGET_REFUSED');
  expect(h.effects).toEqual([]);
  await h.owner.close();
});
it('preregisters native custody before getters reenter shared close', async () => {
  const h = fixture();
  await h.owner.ready;
  let pending = -1;
  Object.defineProperty(h.page, 'keyboard', {
    get: () => {
      pending = h.owner.custody().nativePending;
      void h.owner.close();
      return h.keyboard;
    },
  });
  await expect(
    h.owner.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal())
  ).rejects.toThrow('TARGET_REFUSED');
  expect(pending).toBe(1);
  expect(h.effects).not.toContain('text');
  await h.owner.close();
});
it('abort refuses unstarted dispatch and is not a native cancellation claim', async () => {
  const h = fixture();
  await h.owner.ready;
  const abort = new AbortController();
  abort.abort();
  await expect(
    h.owner.native.dispatch({ kind: 'keyDown', key: 'Alt' }, abort.signal)
  ).rejects.toThrow('TARGET_REFUSED');
  expect(h.effects).toEqual([]);
  await h.owner.close();
});
it('terminal close does not release held keys or manufacture certain cleanup', async () => {
  const h = fixture();
  await h.owner.ready;
  await h.owner.native.dispatch({ kind: 'keyDown', key: 'Control' }, signal());
  expect(await h.owner.close()).toMatchObject({ detached: true, uncertain: true });
  expect(h.effects).toEqual([['keyDown', 'Control'], ['detach']]);
});
it.each(['Input.imeSetComposition', 'Input.cancelDragging'])(
  'unsupported %s fails and retains cleanup uncertainty',
  async (method) => {
    const h = fixture();
    await h.owner.ready;
    h.session.send.mockRejectedValueOnce(new Error('UNSUPPORTED_NATIVE_COMMAND'));
    await expect(
      method === 'Input.cancelDragging'
        ? h.owner.native.cancelDrag(signal())
        : h.owner.native.cancelComposition(signal())
    ).rejects.toThrow('UNSUPPORTED_NATIVE_COMMAND');
    expect((await h.owner.close()).uncertain).toBe(true);
  }
);
it('retains in-flight native uncertainty after detach and later acknowledgement', async () => {
  const h = fixture();
  await h.owner.ready;
  const pending = deferred<void>();
  h.keyboard.insertText.mockImplementation(() => pending.promise);
  const call = h.owner.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal());
  void call.catch(() => {});
  expect(await h.owner.close()).toMatchObject({ nativePending: 1, uncertain: true });
  pending.resolve();
  await tick();
  expect(h.owner.custody()).toMatchObject({ nativePending: 0, uncertain: true });
});
it('shares one close promise, including reentrant detach', async () => {
  const h = fixture();
  await h.owner.ready;
  let nested: unknown;
  h.session.detach.mockImplementation(async () => {
    nested = h.owner.close();
  });
  const close = h.owner.close();
  expect(h.owner.close()).toBe(close);
  await close;
  expect(nested).toBe(close);
});
it('subordinates a hung detach to caller deadline and observes late rejection', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.owner.ready;
  const detach = deferred<void>();
  h.session.detach.mockImplementation(() => detach.promise);
  const close = h.owner.close(performance.now() + 50);
  await vi.advanceTimersByTimeAsync(50);
  expect(await close).toMatchObject({ detachPending: true, uncertain: true });
  detach.reject(new Error('LATE_DETACH_REJECTION'));
  await tick();
  expect(h.owner.custody()).toMatchObject({ detachPending: false, uncertain: true });
});
it('late session after acquisition deadline is detached without publishing readiness or healing uncertainty', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.owner.ready;
  await h.owner.close();
  const session = deferred<CDPSession>();
  h.context.newCDPSession.mockImplementation(() => session.promise);
  let current = true;
  const owner = createPageTransport({
    pointer: h.pointer,
    page: h.page as unknown as Page,
    current: () => current,
    readBinding: () => null,
    retire: () => {
      current = false;
    },
  });
  const ready = expect(owner.ready).rejects.toThrow('INPUT_DEADLINE');
  await vi.advanceTimersByTimeAsync(2000);
  await ready;
  const close = owner.close(performance.now());
  await vi.advanceTimersByTimeAsync(2000);
  expect(await close).toMatchObject({ acquisitionPending: true, uncertain: true });
  h.session.detach.mockClear();
  session.resolve(h.session as unknown as CDPSession);
  await tick();
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  expect(owner.custody()).toMatchObject({
    acquisitionPending: false,
    detached: true,
    uncertain: true,
  });
});

it('already-expired caller budget still attempts exact-owned detach without claiming certainty', async () => {
  const h = fixture();
  await h.owner.ready;
  expect(await h.owner.close(performance.now() - 1)).toMatchObject({ uncertain: true });
  expect(h.session.detach).toHaveBeenCalledTimes(1);
});

it('isClosed observation reentrant close cannot admit a native effect after retirement', async () => {
  const h = fixture();
  await h.owner.ready;
  h.page.isClosed = () => {
    void h.owner.close();
    return false;
  };
  await expect(
    h.owner.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal())
  ).rejects.toThrow('TARGET_REFUSED');
  await h.owner.close();
  expect(h.effects).toEqual([['detach']]);
});

it('final binding observation losing current authority refuses captured Page IO', async () => {
  let armed = false;
  const h = fixture(() => {
    if (armed) {
      armed = false;
      h.retire();
    }
  });
  await h.owner.ready;
  const insert = h.keyboard.insertText;
  Object.defineProperty(h.keyboard, 'insertText', {
    get: () => {
      armed = true;
      return insert;
    },
  });
  await expect(
    h.owner.native.dispatch({ kind: 'text', text: 'REFUSED' }, signal())
  ).rejects.toThrow('TARGET_REFUSED');
  expect(armed).toBe(false);
  expect(h.effects).toEqual([]);
  expect(h.owner.custody()).toMatchObject({ nativePending: 0, uncertain: true });
  await h.owner.close();
});
it.each(['composition', 'drag'] as const)(
  'final binding observation refuses captured %s cancellation IO',
  async (kind) => {
    let armed = false;
    const h = fixture(() => {
      if (armed) {
        armed = false;
        h.retire();
      }
    });
    await h.owner.ready;
    const send = h.session.send;
    Object.defineProperty(h.session, 'send', {
      get: () => {
        armed = true;
        return send;
      },
    });
    const work =
      kind === 'composition'
        ? h.owner.native.cancelComposition(signal())
        : h.owner.native.cancelDrag(signal());
    await expect(work).rejects.toThrow('TARGET_REFUSED');
    expect(armed).toBe(false);
    expect(h.effects).toEqual([]);
    expect(h.owner.custody()).toMatchObject({ nativePending: 0, uncertain: true });
    await h.owner.close();
  }
);

it('unsupported observer return is refused without observing promise species or replacing native errors', async () => {
  const observed = vi.fn();
  const unexpected = Object.defineProperty({}, 'then', { get: observed });
  const unavailable = vi.fn();
  const pointer = {
    beginMove: () => unexpected,
    accepts: () => false,
    success: () => undefined,
    invalidate: () => undefined,
    unavailable,
    read: () => ({ revision: 0, terminal: true, marker: null }),
  };
  const h = fixture(undefined, pointer);
  await h.owner.ready;
  await h.owner.native.dispatch({ kind: 'mouseMove', x: 1, y: 2 }, signal());
  expect(unavailable).toHaveBeenCalledOnce();
  expect(observed).not.toHaveBeenCalled();
  const failure = Error('PRIMARY_NATIVE_FAILURE');
  h.mouse.move.mockRejectedValueOnce(failure);
  await expect(h.owner.native.dispatch({ kind: 'mouseMove', x: 1, y: 2 }, signal())).rejects.toBe(
    failure
  );
  expect(observed).not.toHaveBeenCalled();
});
it('missing observer refuses before session acquisition and unsupported accepts return is not truthy authority', async () => {
  const h = fixture();
  await h.owner.ready;
  h.context.newCDPSession.mockClear();
  expect(() =>
    createPageTransport({
      page: h.page,
      current: () => true,
      readBinding: () => null,
      retire: () => {},
    } as unknown as Parameters<typeof createPageTransport>[0])
  ).toThrow('POINTER_OBSERVER_UNAVAILABLE');
  expect(h.context.newCDPSession).not.toHaveBeenCalled();
  const read = vi.fn();
  const invalid = Object.defineProperty({}, 'then', { get: read });
  const unavailable = vi.fn();
  const pointer = {
    beginMove: () => Object.freeze({}),
    accepts: () => invalid as unknown as boolean,
    success: () => undefined,
    invalidate: () => undefined,
    unavailable,
    read: () => ({ revision: 0, terminal: true, marker: null }),
  };
  const owned = fixture(undefined, pointer);
  await owned.owner.ready;
  await owned.owner.native.dispatch({ kind: 'mouseMove', x: 1, y: 2 }, signal());
  expect(unavailable).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  await owned.owner.close();
  await h.owner.close();
});
