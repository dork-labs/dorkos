import type { BrowserBinding } from '../contracts.js';
import { parseProfileId } from '../ids.js';
import { navigationPending } from '../navigation/cohort.js';
import { installOwnerNavigation } from '../navigation/owner-continuation.js';
import type { Route } from 'playwright-core';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Frame, Request } from 'playwright-core';
import { tabFixture, configuration, deferred } from './parent-fixture.js';
import { composeInput } from '../lifecycle/input-owner.js';
import { captureTab, joinTabCaptureOriginals } from '../tabs/capture.js';
import { navigateOwned } from '../navigation/navigate.js';
import { createOwnedNavigationIssuer } from '../navigation/owned-work.js';
import { currentAuthorityCustody } from '../lifecycle/live-custody.js';
import { submitInput, resetInput } from '../lifecycle/parent-actions.js';
// Exact semantic SDK methods the original navigation producer observes; redirect links retain
// the actual earlier request object rather than widening the baseline null-only inference.
type NavigationRequest = Pick<Request, 'isNavigationRequest' | 'frame' | 'url'> & {
  redirectedFrom(): NavigationRequest | null;
};
type NavigationResponse = { request(): NavigationRequest; url(): string };
/** Semantic Page callbacks with genuine parent/input owner composition; no native-browser claim. */
async function fixture() {
  const releases: (() => void)[] = [];
  const h = tabFixture();
  onTestFinished(async () => {
    for (const release of releases.splice(0)) release();
    h.record.lifetime.requestRetirement('explicitStop');
    await h.record.lifetime.ordinary.retirement.promise;
  });
  const config = {
    ...configuration(),
    network: { kind: 'owned' as const, origin: 'about:blank' as const, policyRevision: 1 },
  };
  const peer = Object.freeze({
    url: 'http://127.0.0.1:4901',
    credentials: Object.freeze({ username: 'dorkos', password: 'fixture-only' }),
    isCustodyKnown: () => true,
    close: async () => {},
  });
  h.record.networkPeer = peer;
  h.record.networkCustody = peer.isCustodyKnown;
  h.record.proxy = { url: peer.url, close: async () => {} };
  h.record.directory = {} as NonNullable<typeof h.record.directory>;
  h.record.dataRoot = {} as NonNullable<typeof h.record.dataRoot>;
  let url = 'about:blank';
  const frame = h.page.mainFrame();
  Object.defineProperty(frame, 'url', { value: () => url });
  Object.defineProperty(h.page, 'url', { value: () => url, configurable: true });
  const goto = vi.fn<(target: string) => Promise<NavigationResponse>>(async (target) => {
    const request = {
      redirectedFrom: () => null,
      isNavigationRequest: () => true,
      frame: () => frame,
      url: () => target,
      method: () => 'GET',
      resourceType: () => 'document',
    };
    h.event('request', request);
    url = target;
    h.event('framenavigated', frame);
    return { request: () => request, url: () => target };
  });
  Object.defineProperty(h.page, 'goto', { value: goto });
  // These are original CDP protocol method doubles, not native same-document evidence.
  const nativeEvents = new Map<string, Set<(event: { frameId: string; url: string }) => void>>();
  const originalSend = h.session.send.getMockImplementation();
  if (!originalSend) throw new Error('Original session send implementation unavailable');
  Object.assign(h.session, {
    send: vi.fn(async (method: string, ...args: unknown[]) => {
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'owned-root-frame' } } };
      if (method === 'Page.enable') return {};
      return Reflect.apply(originalSend, h.session, [method, ...args]);
    }),
    on: (event: string, listener: (value: { frameId: string; url: string }) => void) => {
      const bank = nativeEvents.get(event) ?? new Set();
      bank.add(listener);
      nativeEvents.set(event, bank);
      return h.session;
    },
    off: (event: string, listener: (value: { frameId: string; url: string }) => void) => {
      nativeEvents.get(event)?.delete(listener);
      return h.session;
    },
  });
  const slot = composeInput(config, h.record, h.tab);
  await slot.readiness;
  const current = () => h.record.lifetime.ordinary.records?.get(h.record.browserId) === h.record;
  const command = {
    kind: 'navigate',
    requestId: h.command().requestId,
    binding: { ...h.tab.binding },
    url: 'http://127.0.0.1:4801/',
  };
  const issuer = createOwnedNavigationIssuer();
  let authorized = true;
  const authorizeURL = vi.fn(
    async (
      _binding: import('../contracts.js').BrowserBinding,
      _url: string,
      _signal: AbortSignal
    ): Promise<'allowed' | 'refused' | 'unknown'> => (authorized ? 'allowed' : 'refused')
  );
  const authorization = { isCurrent: () => authorized, authorize: authorizeURL };
  const navigate = (value: unknown = command) => {
    const token = issuer.issue(value, authorization);
    return navigateOwned(config, h.record, current, value, token).finally(() =>
      issuer.invalidate(token)
    );
  };
  const known = () => currentAuthorityCustody(h.record, current);
  const cleanup = async () => {
    for (const release of releases.splice(0)) release();
    h.record.lifetime.requestRetirement('explicitStop');
    await h.record.lifetime.ordinary.retirement.promise;
  };
  return {
    ...h,
    config,
    slot,
    current,
    navigationCommand: command,
    navigate,
    authorizeURL,
    releases,
    revoke: () => {
      authorized = false;
    },
    known,
    goto,
    cleanup,
    withinDocument: (target: string, frameId = 'owned-root-frame') => {
      for (const listener of nativeEvents.get('Page.navigatedWithinDocument') ?? [])
        listener({ frameId, url: target });
    },
    commit: (target: string) => {
      url = target;
      h.event('framenavigated', frame as Frame);
    },
  };
}

it('retains the same original Page/input target across two genuine reset and observed navigation cohorts', async () => {
  const f = await fixture();
  const target = f.slot.registeredTarget;
  expect(
    (await submitInput(f.record, { ...f.command(), steps: [{ kind: 'keyDown', key: 'Shift' }] }))
      .outcome
  ).toBe('completed');
  const next = await f.navigate();
  expect(next).toEqual({
    ...f.navigationCommand.binding,
    epoch: 1,
    inputGeneration: 1,
    navigationGeneration: 1,
  });
  expect(f.effects).toContain('keyUp');
  const again = await f.navigate({
    ...f.navigationCommand,
    binding: next,
    url: 'http://127.0.0.1:4801/again',
  });
  expect(again).toEqual({ ...next, epoch: 2, inputGeneration: 2, navigationGeneration: 2 });
  expect(f.slot.registeredTarget).toBe(target);
  expect(f.goto).toHaveBeenCalledTimes(2);
  expect(f.known()).toBe(true);
  expect((await submitInput(f.record, f.command(next))).outcome).toBe('rejected');
  expect((await submitInput(f.record, f.command(again))).outcome).toBe('completed');
});
it('fences concurrent input and competing navigation before held original policy settles', async () => {
  const f = await fixture();
  const held = deferred<'allowed'>();
  f.releases.push(() => held.resolve('allowed'));
  f.config.policy.authorizeAction = () => held.promise;
  const original = f.navigate();
  expect((await submitInput(f.record, f.command(f.tab.binding))).outcome).toBe('rejected');
  await expect(f.navigate({ ...f.navigationCommand, binding: f.tab.binding })).rejects.toThrow();
  expect(f.goto).not.toHaveBeenCalled();
  expect((await resetInput(f.record, f.tab.binding)).status).toBe('stopped');
  held.resolve('allowed');
  expect((await original).navigationGeneration).toBe(1);
});
it('refuses native goto when actual command authority is revoked during the original reset/policy turn', async () => {
  const f = await fixture();
  f.config.policy.authorizeAction = async () => {
    f.revoke();
    return 'allowed';
  };
  await expect(f.navigate()).rejects.toThrow();
  expect(f.goto).not.toHaveBeenCalled();
  expect(f.known()).toBe(false);
});
it('rejects a conflicting actual main-frame commit instead of adopting a URL body as evidence', async () => {
  const f = await fixture();
  f.goto.mockImplementation(async (target) => {
    const request = {
      redirectedFrom: () => null,
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => target,
      method: () => 'GET',
      resourceType: () => 'document',
    };
    f.event('request', request);
    f.commit('http://127.0.0.1:4801/foreign');
    return { request: () => request, url: () => target };
  });
  await expect(f.navigate()).rejects.toThrow();
  expect(f.known()).toBe(false);
});
it.each([undefined, null, false, 0, ''])(
  'retains first falsy native failure %j through independent request-listener cleanup',
  async (primary) => {
    const f = await fixture();
    f.goto.mockImplementation(async () => {
      throw primary;
    });
    const off = f.page.off;
    Object.defineProperty(f.page, 'off', {
      value: (...args: unknown[]) => {
        if (args[0] === 'request') throw new Error('SECONDARY');
        return Reflect.apply(off, f.page, args);
      },
    });
    await expect(f.navigate()).rejects.toBe(primary);
    expect(f.record.lifetime.uncertain).toBe(true);
  }
);

it('follows the bounded genuine original redirect chain under one fresh original navigation flow', async () => {
  const f = await fixture();
  const finalURL = 'http://127.0.0.1:4801/final';
  f.goto.mockImplementation(async (target) => {
    const first: NavigationRequest = {
      redirectedFrom: () => null,
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => target,
    };
    f.event('request', first);
    const second: NavigationRequest = {
      redirectedFrom: () => first,
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => finalURL,
    };
    f.event('request', second);
    f.commit(finalURL);
    return { request: () => second, url: () => finalURL };
  });
  const next = await f.navigate();
  expect(next.navigationGeneration).toBe(1);
  expect(f.authorizeURL.mock.calls.every(([, url]) => url === f.navigationCommand.url)).toBe(true);
  expect(f.known()).toBe(true);
});
it('refuses a second main-frame request whose actual redirectedFrom is outside the original chain', async () => {
  const f = await fixture();
  f.goto.mockImplementation(async (target) => {
    const first: NavigationRequest = {
      redirectedFrom: () => null,
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => target,
    };
    f.event('request', first);
    const competing: NavigationRequest = {
      redirectedFrom: () => null,
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => target + 'other',
    };
    f.event('request', competing);
    return { request: () => competing, url: () => competing.url() };
  });
  await expect(f.navigate()).rejects.toThrow();
  expect(f.known()).toBe(false);
});

it('refuses the seventeenth observed original redirect and publishes no successful binding', async () => {
  const f = await fixture();
  f.goto.mockImplementation(async (target) => {
    let previous: NavigationRequest | null = null;
    for (let index = 0; index <= 17; index++) {
      const parent = previous;
      const url = index === 0 ? target : target + 'redirect-' + index;
      const request: NavigationRequest = {
        redirectedFrom: () => parent,
        isNavigationRequest: () => true,
        frame: () => f.page.mainFrame(),
        url: () => url,
      };
      f.event('request', request);
      previous = request;
    }
    throw new Error('FIXTURE_MUST_NOT_REACH_FINAL_COMMIT');
  });
  await expect(f.navigate()).rejects.toThrow();
  expect(f.known()).toBe(false);
});

it('owned navigation joins the original held screenshot before claiming the tab or entering goto', async () => {
  const f = await fixture();
  const returned = deferred<void>(),
    entered = deferred<void>();
  f.releases.push(() => returned.resolve());
  const original = f.raw.screenshot.getMockImplementation();
  if (!original) throw new Error('Original screenshot implementation unavailable');
  f.raw.screenshot.mockImplementation(async () => {
    entered.resolve();
    await returned.promise;
    return original();
  });
  const capture = captureTab(f.config, f.record, {
    kind: 'capture',
    requestId: f.command().requestId,
    binding: f.tab.binding,
  });
  const observed = capture.then(
    (value) => ({ value }),
    (reason) => ({ reason })
  );
  await entered.promise;
  const navigation = f.navigate();
  const result = navigation.then(
    (value) => ({ value }),
    (reason) => ({ reason })
  );
  await Promise.resolve();
  expect(f.tab.pending).toBe(1);
  expect(f.goto).not.toHaveBeenCalled();
  returned.resolve();
  expect(await observed).toHaveProperty('value');
  const final = await result;
  expect(final).toHaveProperty('value');
  expect(f.goto).toHaveBeenCalledTimes(1);
  expect(f.tab.pending).toBe(0);
  await f.cleanup();
});

it('raw screenshot remains joined after its caller deadline, without admitting navigation', async () => {
  const f = await fixture();
  const returned = deferred<void>(),
    entered = deferred<void>();
  f.releases.push(() => returned.resolve());
  const original = f.raw.screenshot.getMockImplementation();
  if (!original) throw new Error('Original screenshot implementation unavailable');
  f.raw.screenshot.mockImplementation(async () => {
    entered.resolve();
    await returned.promise;
    return original();
  });
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const capture = captureTab(f.config, f.record, {
    kind: 'capture',
    requestId: f.command().requestId,
    binding: f.tab.binding,
  });
  const failure = capture.catch((reason) => reason);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(2000);
  expect(await failure).toMatchObject({ code: 'CAPTURE_TIMEOUT' });
  let joined = false;
  const drain = joinTabCaptureOriginals(f.tab).then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  expect(f.goto).not.toHaveBeenCalled();
  returned.resolve();
  await drain;
  expect(joined).toBe(true);
  vi.useRealTimers();
  await f.cleanup();
});

/** Page/Route are semantic doubles; original engine reset/queue/canonical binding are real. */
async function ownerRouteFixture(
  join: () => Promise<void> = async () => {},
  mode: 'ephemeral' | 'persistent' = 'ephemeral'
) {
  const f = await fixture();
  f.record.mode = mode;
  if (mode === 'persistent')
    f.record.profileId = parseProfileId('retained-owner-navigation-profile');
  let handler: ((route: Route, request: Request) => Promise<void>) | undefined;
  const register = vi.fn(async (_matcher: string, original: typeof handler) => {
    handler = original;
  });
  Object.defineProperty(f.page, 'route', { value: register });
  let admitted = true;
  const complete = vi.fn();
  const close = vi.fn(async () => {});
  const authorize = vi.fn(
    async (_binding: BrowserBinding): Promise<'allowed' | 'refused' | 'unknown'> =>
      admitted ? 'allowed' : 'refused'
  );
  const acquire = vi.fn(async () => ({
    authorization: {
      isCurrent: () => admitted,
      authorize,
    },
    ready: Promise.resolve(),
    complete,
    close,
  }));
  await installOwnerNavigation(f.config, f.record, f.tab, f.current, {
    acquire,
    joinPublications: join,
  });
  const enter = (url = 'http://127.0.0.1:4801/link') => {
    const request = {
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      redirectedFrom: () => null,
      url: () => url,
    } as Request;
    const fallback = vi.fn(async () => {
      f.commit(url);
    });
    const abort = vi.fn(async () => {});
    const route = { fallback, abort, request: () => request } as unknown as Route;
    const operation = handler!(route, request);
    return { operation, fallback, abort, request };
  };
  return {
    ...f,
    enter,
    authorize,
    acquire,
    complete,
    close,
    lose: () => {
      admitted = false;
    },
  };
}

it.each(['ephemeral', 'persistent'] as const)(
  '%s joins the original HTTP publication before native link reset/fallback and adopts its actual Page',
  async (mode) => {
    const wire = deferred<void>();
    const f = await ownerRouteFixture(() => wire.promise, mode);
    f.releases.push(() => wire.resolve());
    expect(
      (await submitInput(f.record, { ...f.command(), steps: [{ kind: 'keyDown', key: 'Shift' }] }))
        .outcome
    ).toBe('completed');
    const target = f.slot.registeredTarget,
      before = { ...f.tab.binding };
    const incoming = f.enter();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.acquire).not.toHaveBeenCalled();
    expect(incoming.fallback).not.toHaveBeenCalled();
    expect(f.effects).not.toContain('keyUp');
    expect((await submitInput(f.record, f.command())).outcome).toBe('rejected');
    wire.resolve();
    await incoming.operation;
    expect(incoming.fallback).toHaveBeenCalledTimes(1);
    expect(incoming.abort).not.toHaveBeenCalled();
    expect(f.effects).toContain('keyUp');
    expect(f.tab.binding).toEqual({
      ...before,
      epoch: before.epoch + 1,
      inputGeneration: before.inputGeneration + 1,
      navigationGeneration: before.navigationGeneration + 1,
    });
    expect(f.slot.registeredTarget).toBe(target);
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(f.tab.binding);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.record.mode).toBe(mode);
    if (mode === 'persistent') expect(f.record.profileId).toBe('retained-owner-navigation-profile');
  }
);

it('does not fallback a real owner request whose original publication failed, including undefined', async () => {
  const f = await ownerRouteFixture(async () => {
    throw undefined;
  });
  const incoming = f.enter();
  await expect(incoming.operation).rejects.toBeUndefined();
  expect(f.acquire).not.toHaveBeenCalled();
  expect(incoming.fallback).not.toHaveBeenCalled();
  expect(incoming.abort).toHaveBeenCalledTimes(1);
});

it.each(['ephemeral', 'persistent'] as const)(
  '%s rejects a natural owner continuation after original authority loss before route fallback',
  async (mode) => {
    const f = await ownerRouteFixture(undefined, mode);
    f.config.policy.authorizeAction = async () => {
      f.lose();
      return 'allowed';
    };
    const incoming = f.enter();
    await expect(incoming.operation).rejects.toMatchObject({ code: 'STALE_BINDING' });
    expect(incoming.fallback).not.toHaveBeenCalled();
    expect(incoming.abort).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  }
);

it('retains the original natural navigation cohort when original close rejects undefined', async () => {
  const f = await ownerRouteFixture();
  f.close.mockRejectedValue(undefined);
  const incoming = f.enter();
  await expect(incoming.operation).rejects.toBeUndefined();
  expect(incoming.fallback).toHaveBeenCalledTimes(1);
  expect(f.record.lifetime.uncertain).toBe(true);
  expect(navigationPending(f.tab)).toBe(true);
});

it('adopts an actual original same-document anchor event without another goto or synthetic Page event', async () => {
  const f = await ownerRouteFixture();
  const incoming = f.enter('http://127.0.0.1:4801/document');
  await incoming.operation;
  const before = { ...f.tab.binding },
    target = f.slot.registeredTarget;
  expect(
    (
      await submitInput(f.record, {
        ...f.command(before),
        steps: [{ kind: 'keyDown', key: 'Shift' }],
      })
    ).outcome
  ).toBe('completed');
  f.withinDocument('http://127.0.0.1:4801/document#section');
  f.commit('http://127.0.0.1:4801/document#section');
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2));
  expect(f.tab.binding).toEqual({
    ...before,
    epoch: before.epoch + 1,
    inputGeneration: before.inputGeneration + 1,
    navigationGeneration: before.navigationGeneration + 1,
  });
  expect(f.effects).toContain('keyUp');
  expect(f.slot.registeredTarget).toBe(target);
  expect(f.goto).not.toHaveBeenCalled();
  expect((await submitInput(f.record, f.command(f.tab.binding))).outcome).toBe('completed');
});

for (const suffix of ['/changed-path', '/changed-path?query=replace']) {
  it(`adopts original same-document protocol proof for ${suffix} with old input reset`, async () => {
    const f = await ownerRouteFixture();
    await f.enter('http://127.0.0.1:4801/document').operation;
    const before = { ...f.tab.binding },
      target = f.slot.registeredTarget;
    expect(
      (
        await submitInput(f.record, {
          ...f.command(before),
          steps: [{ kind: 'keyDown', key: 'Shift' }],
        })
      ).outcome
    ).toBe('completed');
    const url = 'http://127.0.0.1:4801' + suffix;
    // Public SDK Frame observation alone has no same-document authority.
    f.commit(url);
    await Promise.resolve();
    expect(f.complete).toHaveBeenCalledTimes(1);
    f.withinDocument(url);
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2));
    expect(f.tab.binding).toEqual({
      ...before,
      epoch: before.epoch + 1,
      inputGeneration: before.inputGeneration + 1,
      navigationGeneration: before.navigationGeneration + 1,
    });
    expect(f.effects).toContain('keyUp');
    expect(f.slot.registeredTarget).toBe(target);
    expect(f.goto).not.toHaveBeenCalled();
    expect((await submitInput(f.record, f.command(f.tab.binding))).outcome).toBe('completed');
  });
}

it('refuses an original same-document event that changes origin despite matching root protocol proof', async () => {
  const f = await ownerRouteFixture();
  await f.enter('http://127.0.0.1:4801/document').operation;
  f.withinDocument('http://127.0.0.1:4802/foreign');
  f.commit('http://127.0.0.1:4802/foreign');
  await vi.waitFor(() => expect(f.record.status).not.toBe('running'));
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.acquire).toHaveBeenCalledTimes(1);
});

it('refreshes original destination authorization on the post-reset binding before route fallback', async () => {
  const f = await ownerRouteFixture();
  const before = { ...f.tab.binding };
  f.authorize.mockImplementation(async (binding) =>
    binding.inputGeneration === before.inputGeneration ? 'allowed' : 'refused'
  );
  const incoming = f.enter();
  await expect(incoming.operation).rejects.toMatchObject({ code: 'POLICY_REFUSED' });
  expect(f.authorize.mock.calls.map(([binding]) => binding.inputGeneration)).toEqual([
    before.inputGeneration,
    before.inputGeneration + 1,
  ]);
  expect(incoming.fallback).not.toHaveBeenCalled();
  expect(incoming.abort).toHaveBeenCalledTimes(1);
  expect(f.complete).not.toHaveBeenCalled();
});
it('refreshes original authorization after input reset before adopting same-document proof', async () => {
  const f = await ownerRouteFixture();
  await f.enter('http://127.0.0.1:4801/document').operation;
  const before = { ...f.tab.binding };
  f.authorize.mockClear();
  f.authorize.mockImplementation(async (binding) =>
    binding.inputGeneration === before.inputGeneration ? 'allowed' : 'refused'
  );
  const url = 'http://127.0.0.1:4801/document#revoked';
  f.commit(url);
  f.withinDocument(url);
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(2));
  expect(f.authorize.mock.calls.map(([binding]) => binding.inputGeneration)).toEqual([
    before.inputGeneration,
    before.inputGeneration + 1,
  ]);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.tab.binding.navigationGeneration).toBe(before.navigationGeneration);
  expect(f.record.lifetime.ordinary.phase).not.toBe('ordinary');
});
