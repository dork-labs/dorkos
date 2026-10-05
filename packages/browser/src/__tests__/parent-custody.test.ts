import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserContext, CDPSession } from 'playwright-core';
import { composeInput } from '../lifecycle/input-owner.js';
import { closeRecord } from '../lifecycle/close.js';
import { acceptContext, ownOperation } from '../lifecycle/ownership.js';
import { configuration, record, tabFixture, deferred, tick } from './parent-fixture.js';
vi.mock('../profiles/owned-directory.js', () => ({ assertDirectory: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function time() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
}

it('enters context, proxy and every available input close before waiting for observation', async () => {
  const h = tabFixture(),
    c = configuration(),
    observer = deferred<Awaited<ReturnType<typeof c.processes.descendants>>>(),
    observationEntered = deferred<void>();
  await composeInput(c, h.record, h.tab).readiness;
  const second = tabFixture(h.record);
  await composeInput(c, h.record, second.tab).readiness;
  c.processes.descendants = vi.fn(() => {
    observationEntered.resolve();
    return observer.promise;
  });
  const proxy = { url: 'http://127.0.0.1:9002', close: vi.fn(async () => {}) };
  h.record.proxy = proxy;
  const closing = closeRecord(c, h.record);
  expect(h.record.lifetime.ordinary.phase).toBe('retiring');
  expect(h.session.detach).not.toHaveBeenCalled();
  expect(second.session.detach).not.toHaveBeenCalled();
  // Genuine cohort drain precedes terminal detach; observation remains held throughout.
  await observationEntered.promise;
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  expect(second.session.detach).toHaveBeenCalledTimes(1);
  expect(h.record.context!.close).toHaveBeenCalledTimes(1);
  expect(proxy.close).toHaveBeenCalledTimes(1);
  expect(closeRecord(c, h.record)).toBe(closing);
  observer.resolve({ status: 'complete', identities: [h.record.root!] });
  expect(await closing).toEqual({ cleanup: 'observed' });
});
it('throwing sibling cannot suppress exact cooperative closes or release profile', async () => {
  const h = tabFixture(),
    c = configuration();
  await composeInput(c, h.record, h.tab).readiness;
  const close = vi.fn(() => {
    throw Error('CONTEXT_CLOSE_FAULT');
  });
  h.record.context!.close = close;
  const proxy = { url: 'http://127.0.0.1:9002', close: vi.fn(async () => {}) };
  h.record.proxy = proxy;
  const release = vi.fn(async () => {});
  h.record.reservation = {
    release,
    nonce: '00000000-0000-4000-8000-000000000000',
    profileDir: '/fixture/data/profiles/owned',
    beginLaunch: vi.fn(),
    recordBrowser: vi.fn(),
  } as typeof h.record.reservation;
  expect(await closeRecord(c, h.record)).toEqual({ cleanup: 'failed', reason: 'closeFailed' });
  expect(proxy.close).toHaveBeenCalledTimes(1);
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  expect(h.record.lifetime.inputs.size).toBe(1);
});
it('construction slot precedes reentrant Page getter and late handle is closed once', async () => {
  const h = tabFixture(),
    c = configuration();
  let seen = false;
  let closing!: ReturnType<typeof closeRecord>;
  h.raw.context = () => {
    seen = h.record.lifetime.inputs.get(h.tab)?.constructing === true;
    closing = closeRecord(c, h.record);
    return h.context;
  };
  const slot = composeInput(c, h.record, h.tab);
  await slot.readiness?.catch(() => {});
  expect(seen).toBe(true);
  expect(h.context.newCDPSession).not.toHaveBeenCalled();
  expect(await closing).toEqual({ cleanup: 'unverified', reason: 'observationUnavailable' });
  expect(slot.closePromise).toBeDefined();
  expect(h.record.closePromise).toBe(closing);
  expect(h.record.lifetime.inputs.get(h.tab)).toBe(slot);
});
it('pending exact detach blocks release and late ACK cannot heal its installed close result', async () => {
  time();
  const h = tabFixture(),
    c = configuration();
  await composeInput(c, h.record, h.tab).readiness;
  const detach = deferred<void>();
  h.session.detach.mockImplementation(() => detach.promise);
  const release = vi.fn(async () => {});
  h.record.reservation = {
    release,
    nonce: '00000000-0000-4000-8000-000000000000',
    profileDir: '/fixture/data/profiles/owned',
    beginLaunch: vi.fn(),
    recordBrowser: vi.fn(),
  } as typeof h.record.reservation;
  const closing = closeRecord(c, h.record),
    end = h.record.lifetime.parentEnd;
  await vi.advanceTimersByTimeAsync(5001);
  expect(await closing).toEqual({ cleanup: 'unverified', reason: 'observationUnavailable' });
  expect(release).not.toHaveBeenCalled();
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  detach.resolve();
  await tick();
  expect(closeRecord(c, h.record)).toBe(closing);
  expect(h.record.lifetime.parentEnd).toBe(end);
  expect((await closing).cleanup).toBe('unverified');
  expect(release).not.toHaveBeenCalled();
});
it('late owned context after terminal result gets exact cleanup without a new promise/end', async () => {
  const r = record('opening'),
    c = configuration();
  r.launchEntered = false;
  r.context = undefined;
  const acquisition = deferred<BrowserContext>();
  const owned = ownOperation(
    r,
    () => acquisition.promise,
    (value) => acceptContext(r, value)
  );
  expect(r.lifetime.pending.size).toBe(1);
  const closing = closeRecord(c, r),
    end = r.lifetime.parentEnd;
  expect((await closing).cleanup).toBe('unverified');
  const late = { close: vi.fn(async () => {}) } as unknown as BrowserContext;
  acquisition.resolve(late);
  await owned;
  await tick();
  expect(late.close).toHaveBeenCalledTimes(1);
  expect(r.context).toBe(late);
  expect(r.closePromise).toBe(closing);
  expect(r.lifetime.parentEnd).toBe(end);
  expect((await closing).cleanup).toBe('unverified');
  expect(r.lifetime.uncertain).toBe(true);
});
it('pending proxy blocks profile release and shares the captured parent deadline', async () => {
  time();
  const r = record(),
    c = configuration(),
    held = deferred<void>();
  const proxy = { url: 'http://127.0.0.1:9002', close: vi.fn(() => held.promise) };
  r.proxy = proxy;
  const release = vi.fn(async () => {});
  r.reservation = {
    release,
    nonce: '00000000-0000-4000-8000-000000000000',
    profileDir: '/fixture/data/profiles/owned',
    beginLaunch: vi.fn(),
    recordBrowser: vi.fn(),
  } as typeof r.reservation;
  const closing = closeRecord(c, r);
  await vi.advanceTimersByTimeAsync(5001);
  expect((await closing).cleanup).toBe('unverified');
  expect(release).not.toHaveBeenCalled();
  held.resolve();
  await tick();
  expect(closeRecord(c, r)).toBe(closing);
  expect(proxy.close).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
});
it('release getter reentrancy introduces custody before final release guard', async () => {
  const r = record(),
    c = configuration(),
    late = deferred<void>(),
    release = vi.fn(async () => {});
  const reservation = {};
  Object.defineProperty(reservation, 'release', {
    get: () => {
      void ownOperation(r, () => late.promise);
      return release;
    },
  });
  r.reservation = reservation as typeof r.reservation;
  expect((await closeRecord(c, r)).cleanup).toBe('unverified');
  expect(release).not.toHaveBeenCalled();
  expect(r.lifetime.pending.size).toBe(1);
  late.resolve();
  await tick();
  expect(r.status).toBe('uncertain');
  expect(release).not.toHaveBeenCalled();
});
it('late session acquisition is retained after bounded cleanup with no stale admission', async () => {
  time();
  const h = tabFixture(),
    c = configuration(),
    held = deferred<CDPSession>();
  h.context.newCDPSession.mockImplementation(() => held.promise);
  const slot = composeInput(c, h.record, h.tab),
    closing = closeRecord(c, h.record);
  await vi.advanceTimersByTimeAsync(5001);
  expect((await closing).cleanup).toBe('unverified');
  expect(slot.handle!.custody().acquisitionPending).toBe(true);
  held.resolve(h.session as unknown as CDPSession);
  await tick();
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  expect(slot.ready).toBe(false);
  expect(h.record.closePromise).toBe(closing);
  expect(h.record.lifetime.inputs.get(h.tab)).toBe(slot);
});
it('parent-installed child close promise/end remains exact across later parent entry', async () => {
  time();
  const h = tabFixture(),
    c = configuration();
  const slot = composeInput(c, h.record, h.tab);
  await slot.readiness;
  const detach = deferred<void>(),
    detachEntered = deferred<void>();
  h.session.detach.mockImplementation(() => {
    detachEntered.resolve();
    return detach.promise;
  });
  // Ordinary direct terminal close remains refused and requests the genuine parent driver.
  expect(() => slot.handle!.close()).toThrow('INPUT_TERMINAL_ONLY_CLOSE');
  const closing = closeRecord(c, h.record);
  await detachEntered.promise;
  const child = slot.closePromise!,
    end = h.record.lifetime.inputEnd;
  expect(child).toBeDefined();
  expect(end).toBe(2000);
  expect(h.record.lifetime.parentEnd).toBe(5000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(closeRecord(c, h.record)).toBe(closing);
  expect(slot.closePromise).toBe(child);
  await vi.advanceTimersByTimeAsync(1001);
  expect((await child).uncertain).toBe(true);
  expect((await closing).cleanup).toBe('unverified');
  expect(slot.closePromise).toBe(child);
  detach.resolve();
  await tick();
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  expect(h.record.lifetime.inputEnd).toBe(end);
  expect(closeRecord(c, h.record)).toBe(closing);
});
it('pending capture tail participates in the one shared wait and blocks release', async () => {
  time();
  const h = tabFixture(),
    c = configuration(),
    tail = deferred<void>();
  await composeInput(c, h.record, h.tab).readiness;
  h.tab.pending = 1;
  h.tab.tail = tail.promise;
  const release = vi.fn(async () => {});
  h.record.reservation = {
    release,
    nonce: '00000000-0000-4000-8000-000000000000',
    profileDir: '/fixture/data/profiles/owned',
    beginLaunch: vi.fn(),
    recordBrowser: vi.fn(),
  } as typeof h.record.reservation;
  const closing = closeRecord(c, h.record);
  await vi.advanceTimersByTimeAsync(5001);
  expect((await closing).cleanup).toBe('unverified');
  expect(release).not.toHaveBeenCalled();
  h.tab.pending = 0;
  tail.resolve();
  await tick();
  expect((await closeRecord(c, h.record)).cleanup).toBe('unverified');
  expect(release).not.toHaveBeenCalled();
});
it('later parent entry clamps to caller barrier without shortening an already installed close', async () => {
  time();
  const first = record(),
    second = record(),
    c = configuration(),
    held = deferred<void>();
  first.context!.close = vi.fn(async () => {
    vi.advanceTimersByTime(1000);
  });
  second.context!.close = vi.fn(() => held.promise);
  const prior = closeRecord(c, first, 5000),
    closing = closeRecord(c, second, 5000);
  expect(second.lifetime.parentEnd).toBe(5000);
  // Both original ends were installed before the first context callback advanced time.
  expect(second.lifetime.inputEnd).toBe(2000);
  expect(closeRecord(c, second, 1100)).toBe(closing);
  expect(second.lifetime.parentEnd).toBe(5000);
  await vi.advanceTimersByTimeAsync(2001);
  expect((await closing).cleanup).toBe('unverified');
  held.resolve();
  await tick();
  await prior;
  expect(second.lifetime.parentEnd).toBe(5000);
  expect(second.status).toBe('uncertain');
});
