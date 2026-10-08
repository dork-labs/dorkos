import { afterEach, expect, it, vi } from 'vitest';
import { acquireBrowser } from '../lifecycle/acquisition.js';
import { closeRecord } from '../lifecycle/close.js';
import { ordinaryRecord } from '../lifecycle/ownership.js';
import { configuration, record, fakePage, deferred, tick, root } from './parent-fixture.js';
const mocks = vi.hoisted(() => ({ launch: vi.fn(), directory: vi.fn(), proxy: vi.fn() }));
vi.mock('../runtime/public-library.js', () => ({
  verifiedLibrary: async () => ({ launchPersistentContext: mocks.launch }),
}));
vi.mock('../runtime/host-identity.js', () => ({
  hostIdentity: () => root,
  nativeHolder: async () => root,
}));
vi.mock('../profiles/owned-directory.js', () => ({
  ownDirectory: mocks.directory,
  assertDirectory: vi.fn(),
}));
vi.mock('../profiles/paths.js', () => ({ prepareDataRoot: async () => '/fixture/data' }));
vi.mock('../network/fixture-proxy.js', () => ({ startFixtureProxy: mocks.proxy }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/fixture/data/ephemeral/private-warm',
  rm: vi.fn(async () => {}),
}));
afterEach(() => vi.resetAllMocks());
function fixture() {
  const r = record('opening');
  r.mode = 'ephemeral';
  const config = configuration();
  let closed = false;
  config.processes.observe = vi.fn(async () => ({
    status: closed ? ('dead' as const) : ('alive' as const),
  }));
  const ordinary = fakePage();
  const unrelated = fakePage();
  const warm = fakePage();
  Object.defineProperty(warm.page, 'goto', {
    configurable: true,
    value: vi.fn(async () => ({
      status: () => 200,
      url: () => 'http://127.0.0.1:9002/private-warm',
      request: () => ({ redirectedFrom: () => null }),
    })),
  });
  const callbacks = new Map<string, (...args: unknown[]) => void>();
  const context = {
    pages: vi.fn(() => [ordinary.page, warm.page]),
    newPage: vi.fn(async () => warm.page),
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => {
      callbacks.set(name, callback);
    }),
    close: vi.fn(async () => {
      closed = true;
      callbacks.get('close')?.();
    }),
  };
  mocks.launch.mockResolvedValue(context);
  mocks.directory.mockImplementation((path: string) => ({ path, dev: 1, ino: 1 }));
  mocks.proxy.mockResolvedValue({ url: 'http://127.0.0.1:9002', close: vi.fn(async () => {}) });
  r.authenticationWarmup = Object.freeze({
    url: 'http://127.0.0.1:9002/private-warm',
    confirm: vi.fn(async () => {}),
  });
  r.networkCustody = () => true;
  let cancelled = false;
  return {
    r,
    config,
    context,
    warm,
    ordinary,
    unrelated,
    callbacks,
    cancelled: () => cancelled,
    cancel: () => {
      cancelled = true;
    },
  };
}
it('acquires before census and excludes exactly warm Page while tracking unrelated originals', async () => {
  const f = fixture();
  try {
    await acquireBrowser(f.config, f.r, f.cancelled);
    expect(f.context.newPage).toHaveBeenCalledOnce();
    expect(f.context.newPage.mock.invocationCallOrder[0]).toBeLessThan(
      f.context.on.mock.invocationCallOrder[0]!
    );
    expect([...f.r.tabs.values()].map((tab) => tab.page)).toEqual([f.ordinary.page]);
    f.callbacks.get('page')?.(f.warm.page);
    expect(f.r.tabs.size).toBe(1);
    f.callbacks.get('page')?.(f.unrelated.page);
    expect([...f.r.tabs.values()].map((tab) => tab.page)).toEqual([
      f.ordinary.page,
      f.unrelated.page,
    ]);
    f.warm.event('framenavigated');
    f.warm.event('close');
    expect(ordinaryRecord(f.r)).toBe(true);
    await f.r.privateProxyWarmup!.run(f.r.authenticationWarmup!);
    expect(f.warm.raw.close).toHaveBeenCalledOnce();
    expect(ordinaryRecord(f.r)).toBe(true);
  } finally {
    await closeRecord(f.config, f.r);
  }
});
it('retains and joins a late original private Page after acquisition cancellation', async () => {
  const f = fixture();
  const acquired = deferred<typeof f.warm.page>();
  const closed = deferred<void>();
  f.context.newPage.mockImplementation(() => acquired.promise);
  f.warm.raw.close.mockImplementation(() => closed.promise);
  const opening = acquireBrowser(f.config, f.r, f.cancelled);
  void opening.catch(() => {});
  let retiring: ReturnType<typeof closeRecord> | undefined;
  let retired = false;
  try {
    await vi.waitFor(() => expect(f.context.newPage).toHaveBeenCalledOnce());
    f.cancel();
    retiring = closeRecord(f.config, f.r);
    void retiring.then(() => {
      retired = true;
    });
    acquired.resolve(f.warm.page);
    await expect(opening).rejects.toThrow('ENGINE_STOPPED');
    await vi.waitFor(() => expect(f.warm.raw.close).toHaveBeenCalledOnce());
    expect(f.r.privateProxyWarmupPage).toBe(f.warm.page);
    expect(f.r.lifetime.pending.size).toBeGreaterThan(0);
    expect(f.r.tabs.size).toBe(0);
    expect(f.context.on).not.toHaveBeenCalled();
    expect(retired).toBe(false);
  } finally {
    acquired.resolve(f.warm.page);
    closed.resolve();
    await opening.catch(() => {});
    await closeRecord(f.config, f.r);
    if (retiring) await retiring;
    await tick();
  }
  expect(f.warm.raw.close).toHaveBeenCalledOnce();
  expect(f.r.lifetime.pending.size).toBe(0);
});
it.each([false, undefined])(
  'keeps context custody when private Page getter throws %s',
  async (value) => {
    const f = fixture();
    Object.defineProperty(f.warm.page, 'goto', {
      get() {
        throw value;
      },
    });
    try {
      await expect(acquireBrowser(f.config, f.r, f.cancelled)).rejects.toBe(value);
      expect(f.r.privateProxyWarmupPage).toBe(f.warm.page);
      expect(f.r.context).toBe(f.context);
      expect(f.r.tabs.size).toBe(0);
    } finally {
      await closeRecord(f.config, f.r);
    }
    expect(f.context.close).toHaveBeenCalledOnce();
  }
);
