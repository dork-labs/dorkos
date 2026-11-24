import { fakeJPEG } from './parent-fixture.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserEngine } from '../engine.js';
import { configuration, fakePage, deferred, tick, root, requestId } from './parent-fixture.js';
import { type BrowserContext } from 'playwright-core';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  reserve: vi.fn(),
  proxy: vi.fn(),
  host: vi.fn(),
  removed: vi.fn(),
  directory: vi.fn(),
}));
vi.mock('../runtime/public-library.js', () => ({
  verifiedLibrary: async () => ({ launchPersistentContext: mocks.launch }),
}));
vi.mock('../runtime/host-identity.js', () => ({
  hostIdentity: mocks.host,
  nativeHolder: async () => ({ pid: 41, birth: 'MOCK_ROOT' }),
}));
vi.mock('../profiles/owned-directory.js', () => ({
  ownDirectory: mocks.directory,
  assertDirectory: vi.fn(),
}));
vi.mock('../profiles/paths.js', () => ({ prepareDataRoot: async () => '/fixture/data' }));
vi.mock('../profiles/reservation.js', () => ({ reserveProfile: mocks.reserve }));
vi.mock('../network/fixture-proxy.js', () => ({ startFixtureProxy: mocks.proxy }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/fixture/data/ephemeral/clean-owned',
  rm: mocks.removed,
}));
const profileId = 'profile_subject_A_000000000000000';
const command = { kind: 'open', requestId, mode: 'persistent', profileId };
function fixture() {
  mocks.directory.mockImplementation((path: string) => ({ path, dev: 1, ino: 1 }));
  const p = fakePage();
  let closed = false;
  const callbacks = new Map<string, (...values: unknown[]) => void>();
  const context = {
    pages: vi.fn(() => [p.page]),
    newPage: vi.fn(async () => p.page),
    on: vi.fn((event: string, callback: (...values: unknown[]) => void) => {
      callbacks.set(event, callback);
    }),
    close: vi.fn(async () => {
      closed = true;
      callbacks.get('close')?.();
    }),
  };
  const release = vi.fn(async () => {}),
    proxyClose = vi.fn(async () => {});
  mocks.launch.mockResolvedValue(context);
  mocks.host.mockReturnValue(root);
  mocks.reserve.mockResolvedValue({
    profileDir: '/fixture/data/profiles/owned',
    release,
    recordJournal: vi.fn(),
    recordFailure: vi.fn(),
    beginLaunch: vi.fn(),
    recordBrowser: vi.fn(),
  });
  mocks.proxy.mockResolvedValue({ url: 'http://127.0.0.1:9002', close: proxyClose });
  const config = configuration();
  config.processes.observe = vi.fn(async () => ({
    status: closed ? ('dead' as const) : ('alive' as const),
  }));
  return {
    ...p,
    inputContext: p.context,
    config,
    context,
    release,
    proxyClose,
    event: (name: string, value?: unknown) => callbacks.get(name)?.(value),
  };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('actual parent acquisition navigates before real leaf creation, dispatches/reset/captures and closes', async () => {
  const h = fixture(),
    order: string[] = [],
    goto = h.raw.goto.getMockImplementation()!;
  h.raw.goto.mockImplementation(async () => {
    order.push('goto');
    return goto();
  });
  h.raw.context = () => {
    order.push('inputCreate');
    return h.inputContext;
  };
  const engine = createBrowserEngine(h.config);
  const outcome = await engine.open(command).then(
    (opened) => ({ opened }),
    (error: unknown) => ({ error })
  );
  expect(order).toEqual(['goto', 'inputCreate']);
  expect(outcome).toHaveProperty('opened');
  const opened = (outcome as { opened: import('../lifecycle/records.js').OpenedResult }).opened;
  expect(opened.tab.navigationGeneration).toBe(1);
  expect(mocks.launch.mock.calls[0][1]).toMatchObject({ chromiumSandbox: true, headless: true });
  const input = {
    kind: 'input',
    requestId,
    binding: opened.tab,
    steps: [{ kind: 'text', text: 'PARENT_EFFECT' }],
  };
  expect((await engine.input(input)).outcome).toBe('completed');
  const reset = await engine.resetInput(opened.tab);
  expect(reset.status).toBe('ready');
  expect((await engine.input(input)).outcome).toBe('rejected');
  expect((await engine.input({ ...input, binding: reset.binding })).outcome).toBe('completed');
  expect(
    (await engine.capture({ kind: 'capture', requestId, binding: reset.binding })).receipt.binding
  ).toEqual(reset.binding);
  const result = await engine.close({
    kind: 'close',
    requestId,
    browserId: opened.browserId,
    browserGeneration: 0,
  });
  expect(result.cleanup).toBe('observed');
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  expect(h.proxyClose).toHaveBeenCalledTimes(1);
  expect(h.release).toHaveBeenCalledTimes(1);
  expect(h.proxyClose.mock.invocationCallOrder[0]).toBeLessThan(
    h.release.mock.invocationCallOrder[0]
  );
  expect(h.raw.keyboard.insertText).toHaveBeenCalledTimes(2);
});
it('initial goto and session ACK gate opened publication; same-profile opening is refused', async () => {
  const h = fixture(),
    navigation = deferred<null>(),
    session = deferred<import('playwright-core').CDPSession>();
  h.raw.goto.mockImplementation(() => navigation.promise);
  h.inputContext.newCDPSession.mockImplementation(() => session.promise);
  const engine = createBrowserEngine(h.config);
  let settled = false;
  const opening = engine.open(command);
  void opening.then(() => {
    settled = true;
  });
  await tick();
  expect(h.inputContext.newCDPSession).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  await expect(engine.open(command)).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
  navigation.resolve(null);
  await tick();
  expect(h.inputContext.newCDPSession).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  session.resolve(h.session as unknown as import('playwright-core').CDPSession);
  const opened = await opening;
  expect(settled).toBe(true);
  expect(
    (
      await engine.close({
        kind: 'close',
        requestId,
        browserId: opened.browserId,
        browserGeneration: 0,
      })
    ).cleanup
  ).toBe('observed');
});
it('popup session admission is immediate refusal until its own ACK without creating another owner', async () => {
  const h = fixture(),
    engine = createBrowserEngine(h.config),
    opened = await engine.open(command);
  const popup = fakePage(),
    session = deferred<import('playwright-core').CDPSession>();
  popup.context.newCDPSession.mockImplementation(() => session.promise);
  h.event('page', popup.page);
  const binding = engine
    .listTabs(opened.browserId, 0)
    .find((tab) => tab.tabId !== opened.tab.tabId)!;
  const input = {
    kind: 'input',
    requestId,
    binding,
    steps: [{ kind: 'text', text: 'POPUP_EFFECT' }],
  };
  expect((await engine.input(input)).outcome).toBe('rejected');
  expect(popup.effects).toEqual([]);
  session.resolve(popup.session as unknown as import('playwright-core').CDPSession);
  await tick();
  expect((await engine.input(input)).outcome).toBe('completed');
  expect(popup.context.newCDPSession).toHaveBeenCalledTimes(1);
  expect(
    (
      await engine.close({
        kind: 'close',
        requestId,
        browserId: opened.browserId,
        browserGeneration: 0,
      })
    ).cleanup
  ).toBe('observed');
});
it('proxy release pending refuses same-profile reacquisition until exact closure settles', async () => {
  const h = fixture(),
    engine = createBrowserEngine(h.config),
    opened = await engine.open(command),
    held = deferred<void>();
  const releaseEntered = deferred<void>();
  h.release.mockImplementation(() => {
    releaseEntered.resolve();
    return held.promise;
  });
  const closing = engine.close({
    kind: 'close',
    requestId,
    browserId: opened.browserId,
    browserGeneration: 0,
  });
  await releaseEntered.promise;
  expect(h.release).toHaveBeenCalledTimes(1);
  await expect(engine.open(command)).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
  expect(mocks.launch).toHaveBeenCalledTimes(1);
  held.resolve();
  expect((await closing).cleanup).toBe('observed');
});

it('refuses proxy acquisition after the profile observation retires this parent', async () => {
  const h = fixture(),
    engine = createBrowserEngine(h.config);
  let shutdown: ReturnType<typeof engine.shutdown> | undefined;
  mocks.directory.mockImplementation((path: string) => {
    if (path === '/fixture/data/profiles/owned') shutdown = engine.shutdown();
    return { path, dev: 1, ino: 1 };
  });
  await expect(engine.open(command)).rejects.toMatchObject({ code: 'ENGINE_STOPPED' });
  expect(shutdown).toBeDefined();
  expect(mocks.proxy).not.toHaveBeenCalled();
  expect(mocks.launch).not.toHaveBeenCalled();
  await shutdown;
});

it('observes screenshot once and refuses its effect after the getter retires this parent', async () => {
  const h = fixture(),
    engine = createBrowserEngine(h.config),
    opened = await engine.open(command);
  const effect = vi.fn(async () => fakeJPEG(100, 80, 9)),
    getter = vi.fn(() => {
      h.event('close');
      return effect;
    });
  Object.defineProperty(h.raw, 'screenshot', { get: getter });
  await expect(
    engine.capture({ kind: 'capture', requestId, binding: opened.tab })
  ).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(getter).toHaveBeenCalledTimes(1);
  expect(effect).not.toHaveBeenCalled();
  await engine.close({
    kind: 'close',
    requestId,
    browserId: opened.browserId,
    browserGeneration: 0,
  });
});

it('shutdown enters all available closes before waiting for held opening, then retains late custody', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const h = fixture(),
    engine = createBrowserEngine(h.config),
    opened = await engine.open(command);
  const second = deferred<BrowserContext>(),
    secondProxy = vi.fn(async () => {});
  mocks.launch.mockImplementation(() => second.promise);
  mocks.proxy.mockResolvedValue({ url: 'http://127.0.0.1:9003', close: secondProxy });
  mocks.reserve.mockResolvedValue({
    profileDir: '/fixture/data/profiles/second',
    release: vi.fn(),
    recordJournal: vi.fn(),
    recordFailure: vi.fn(),
    beginLaunch: vi.fn(),
    recordBrowser: vi.fn(),
  });
  const opening = engine.open({ ...command, profileId: 'profile_subject_B_000000000000000' });
  const refusal = opening.then(
    () => null,
    (error: unknown) => error
  );
  await tick();
  const firstEntry = deferred<void>(),
    secondEntry = deferred<void>();
  h.proxyClose.mockImplementation(async () => {
    firstEntry.resolve();
  });
  secondProxy.mockImplementation(async () => {
    secondEntry.resolve();
  });
  const shutdown = engine.shutdown();
  expect(engine.shutdown()).toBe(shutdown);
  expect(() => engine.listTabs(opened.browserId, opened.browserGeneration)).toThrow();
  await Promise.all([firstEntry.promise, secondEntry.promise]);
  expect(h.context.close).toHaveBeenCalledTimes(1);
  expect(h.proxyClose).toHaveBeenCalledTimes(1);
  expect(secondProxy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5001);
  const results = await shutdown;
  expect(results).toHaveLength(2);
  expect(results.find((value) => value.browserId !== opened.browserId)?.cleanup).toBe('unverified');
  const late = { close: vi.fn(async () => {}) } as unknown as BrowserContext;
  second.resolve(late);
  await tick();
  expect(await refusal).toMatchObject({ code: 'ENGINE_STOPPED' });
  expect(late.close).toHaveBeenCalledTimes(1);
  expect(engine.shutdown()).toBe(shutdown);
  await expect(engine.open(command)).rejects.toMatchObject({ code: 'ENGINE_STOPPED' });
});
