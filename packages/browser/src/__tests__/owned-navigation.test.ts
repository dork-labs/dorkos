import type { BrowserBinding } from '../contracts.js';
import { installOwnerNavigation } from '../navigation/owner-continuation.js';
import type { Route } from 'playwright-core';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Frame, Request } from 'playwright-core';
import { tabFixture, configuration } from './parent-fixture.js';
import { composeInput } from '../lifecycle/input-owner.js';
import { navigateOwned } from '../navigation/navigate.js';
import { createOwnedNavigationIssuer } from '../navigation/owned-work.js';
import { currentAuthorityCustody } from '../lifecycle/live-custody.js';
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

/** Page/Route are semantic doubles; original engine reset/queue/canonical binding are real. */
async function ownerRouteFixture(join: () => Promise<void> = async () => {}) {
  const f = await fixture();
  f.record.mode = 'ephemeral';
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

it('refuses an original same-document event that changes origin despite matching root protocol proof', async () => {
  const f = await ownerRouteFixture();
  await f.enter('http://127.0.0.1:4801/document').operation;
  f.withinDocument('http://127.0.0.1:4802/foreign');
  f.commit('http://127.0.0.1:4802/foreign');
  await vi.waitFor(() => expect(f.record.status).not.toBe('running'));
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.acquire).toHaveBeenCalledTimes(1);
});
