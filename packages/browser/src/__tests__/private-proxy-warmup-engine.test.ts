import { afterEach, expect, it, vi } from 'vitest';
import { constructOwnedBrowserEngine } from '../engine.js';
import { acquireBrowser } from '../lifecycle/acquisition.js';
import { composeInput } from '../lifecycle/input-owner.js';
import { ownOperation } from '../lifecycle/ownership.js';
import { ownPrivateProxyWarmupPage } from '../network/private-proxy-warmup.js';
import { configuration, tabFixture, deferred, root, requestId, tick } from './parent-fixture.js';
vi.mock('../lifecycle/acquisition.js', () => ({ acquireBrowser: vi.fn() }));
vi.mock('../runtime/host-identity.js', () => ({ hostIdentity: () => root }));
afterEach(() => vi.resetAllMocks());

it('does not publish opened until ACTIVE, actual warm response, broker confirmation and original close', async () => {
  const order: string[] = [];
  const response = deferred<{
    status(): number;
    url(): string;
    request(): { redirectedFrom(): null };
  }>();
  const confirmed = deferred<void>();
  const closed = deferred<void>();
  const url = 'http://127.0.0.1:43210/private-warm';
  const warm = {
    goto: vi.fn(() => {
      order.push('goto');
      return response.promise;
    }),
    close: vi.fn(() => {
      order.push('close');
      return closed.promise;
    }),
  };
  const peer = Object.freeze({
    url: 'http://127.0.0.1:43210',
    credentials: Object.freeze({ username: 'dorkos', password: 'private-fixture' }),
    authenticationWarmup: Object.freeze({
      url,
      confirm: () => {
        order.push('confirm');
        return confirmed.promise;
      },
    }),
    isCustodyKnown: () => true,
    close: async () => {},
  });
  vi.mocked(acquireBrowser).mockImplementation(async (config, r, _cancelled, bind) => {
    await bind!();
    const f = tabFixture(r);
    r.context = { close: vi.fn(async () => {}) } as unknown as NonNullable<typeof r.context>;
    r.proxy = { url: peer.url, close: vi.fn(async () => {}) };
    r.directory = { path: '/fixture/profile', dev: 1, ino: 1 };
    r.dataRoot = { path: '/fixture/data', dev: 1, ino: 1 };
    r.root = root;
    r.rootAttributed = true;
    r.launchEntered = true;
    r.privateProxyWarmup = ownPrivateProxyWarmupPage(
      warm,
      () => r.status === 'running' && !r.lifetime.gate.stopped,
      (enter) => ownOperation(r, enter)
    );
    const input = composeInput(config, r, f.tab);
    await input.readiness;
    r.status = 'running';
  });
  const engine = constructOwnedBrowserEngine(
    { ...configuration(), network: { kind: 'owned', origin: 'about:blank', policyRevision: 7 } },
    {
      registerBirth() {},
      refuseBirth() {},
      network: {
        bindBeforeLaunch: async () => peer,
        activateReady: async () => {
          order.push('active');
        },
      },
    }
  );
  let published = false;
  const opening = engine.open({ kind: 'open', requestId, mode: 'ephemeral' }).then((value) => {
    published = true;
    return value;
  });
  void opening.catch(() => {});
  try {
    await vi.waitFor(() => expect(warm.goto).toHaveBeenCalledOnce());
    expect(order).toEqual(['active', 'goto']);
    expect(published).toBe(false);
    response.resolve({
      status: () => 200,
      url: () => url,
      request: () => ({ redirectedFrom: () => null }),
    });
    await vi.waitFor(() => expect(order).toEqual(['active', 'goto', 'confirm']));
    expect(published).toBe(false);
    expect(warm.close).not.toHaveBeenCalled();
    confirmed.resolve();
    await vi.waitFor(() => expect(warm.close).toHaveBeenCalledOnce());
    expect(published).toBe(false);
    closed.resolve();
    expect(await opening).toMatchObject({ kind: 'opened' });
    expect(order).toEqual(['active', 'goto', 'confirm', 'close']);
  } finally {
    response.resolve({
      status: () => 200,
      url: () => url,
      request: () => ({ redirectedFrom: () => null }),
    });
    confirmed.resolve();
    closed.resolve();
    await opening.catch(() => {});
    await engine.shutdown();
    await tick();
  }
  expect(warm.close).toHaveBeenCalledOnce();
});
