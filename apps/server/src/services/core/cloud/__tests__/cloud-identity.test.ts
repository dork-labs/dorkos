import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };
import { logger } from '../../../../lib/logger.js';

const link = vi.hoisted(() => ({
  token: 'token-A' as string | null,
  origin: 'https://cloud.example.invalid',
  generation: 1,
  managers: [] as Array<{
    listeners: Set<(change: { paths: readonly string[] }) => void>;
    get: (section: string) => { instanceToken: string | null } | undefined;
    onChange: (listener: (change: { paths: readonly string[] }) => void) => () => void;
  }>,
}));
vi.mock('../../config-manager.js', () => ({
  get configManager() {
    return link.managers.at(-1);
  },
}));
vi.mock('../../auth/cloud-link-client.js', () => ({
  resolveCloudBaseUrl: () => link.origin.replace(/\/+$/, ''),
}));
vi.mock('../../auth/cloud-link.js', () => ({ getCloudLinkGeneration: () => link.generation }));

import { captureCloudV1Context } from '../v1-client.js';
import {
  __setCreditsStateForTests,
  creditsTurnEnvFor,
  creditsWiringReport,
  primeCreditsInference,
  primeCreditsInferenceWithContext,
} from '../credits-inference.js';

const session = { authenticated: true, instanceId: 'service-issued-id', scopes: [] };

function replaceManager() {
  const listeners = new Set<(change: { paths: readonly string[] }) => void>();
  const manager = {
    listeners,
    get: (section: string) => (section === 'cloud' ? { instanceToken: link.token } : undefined),
    onChange: (listener: (change: { paths: readonly string[] }) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  link.managers.push(manager);
  return manager;
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function changeToken(token: string | null): void {
  link.token = token;
  for (const listener of link.managers.at(-1)!.listeners) {
    listener({ paths: ['cloud.instanceToken'] });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeCloud(handle: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn((input: string, init: RequestInit) => handle(new URL(input), init));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('authoritative Cloud identity for credits', () => {
  beforeEach(() => {
    if (link.managers.length === 0) replaceManager();
    link.token = 'token-A';
    link.origin = 'https://cloud.example.invalid';
    link.generation += 1;
    __setCreditsStateForTests({ token: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setCreditsStateForTests({ token: null });
  });

  it('introspects and mints with one bearer and origin, sending only the service ID', async () => {
    const fetch = fakeCloud((url) =>
      answer(url.pathname === '/v1/session' ? session : tokenFixture)
    );
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [sessionUrl, sessionInit] = fetch.mock.calls[0]!;
    const [mintUrl, mintInit] = fetch.mock.calls[1]!;
    expect(new URL(sessionUrl).pathname).toBe('/v1/session');
    expect(new URL(mintUrl).pathname).toBe('/v1/inference/tokens');
    expect(new URL(sessionUrl).origin).toBe(new URL(mintUrl).origin);
    expect(sessionInit.headers).toMatchObject({ authorization: 'Bearer token-A' });
    expect(mintInit.headers).toMatchObject({ authorization: 'Bearer token-A' });
    expect(JSON.parse(mintInit.body as string)).toEqual({ instanceId: 'service-issued-id' });
    expect(creditsWiringReport().ready).toBe(true);
  });

  it.each([
    ['unauthenticated', { authenticated: false, scopes: [] }],
    ['person session', { authenticated: true, scopes: [] }],
    ['blank ID', { authenticated: true, instanceId: ' ', scopes: [] }],
    ['malformed', { authenticated: 'yes', instanceId: 'id', scopes: [] }],
  ])('refuses a %s without minting', async (_name, body) => {
    const fetch = fakeCloud(() => answer(body));
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(creditsWiringReport().ready).toBe(false);
  });

  it.each([401, 404])('refuses a %s session response without minting', async (status) => {
    const fetch = fakeCloud(() =>
      answer({ code: 'not_found', status, title: 'Unavailable' }, status)
    );
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a network failure without minting', async () => {
    const fetch = fakeCloud(() => Promise.reject(new Error('offline')));
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a mint when the link changes during introspection', async () => {
    const pending = deferred<Response>();
    const fetch = fakeCloud(() => pending.promise);
    const priming = primeCreditsInferenceWithContext(captureCloudV1Context());
    changeToken('token-B');
    pending.resolve(answer(session));
    expect(await priming).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a mint when the origin changes during introspection', async () => {
    const pending = deferred<Response>();
    const fetch = fakeCloud(() => pending.promise);
    const priming = primeCreditsInferenceWithContext(captureCloudV1Context());
    link.origin = 'https://another.example.invalid';
    pending.resolve(answer(session));
    expect(await priming).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('has no request to make without a nonempty link', async () => {
    const fetch = fakeCloud(() => answer(session));
    changeToken(null);
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(false);
    changeToken('  ');
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discards a mint response after unlink, including an A → unlink → A cycle', async () => {
    const pending = deferred<Response>();
    const fetch = fakeCloud((url) =>
      url.pathname === '/v1/session' ? answer(session) : pending.promise
    );
    const priming = primeCreditsInferenceWithContext(captureCloudV1Context());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    changeToken(null);
    changeToken('token-A');
    pending.resolve(answer(tokenFixture));
    expect(await priming).toBe(false);
    expect(creditsWiringReport().ready).toBe(false);
  });

  it('invalidates launch state on token rotation, origin change and lifecycle relink', async () => {
    fakeCloud((url) => answer(url.pathname === '/v1/session' ? session : tokenFixture));
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(true);
    changeToken('token-B');
    expect(creditsWiringReport().ready).toBe(false);
    expect(creditsTurnEnvFor('claude-code', true)).toEqual({});

    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(true);
    link.origin = 'https://other.example.invalid/';
    expect(creditsWiringReport().ready).toBe(false);

    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(true);
    link.generation += 1;
    expect(creditsWiringReport().ready).toBe(false);
  });

  it('rejects a captured context after config manager replacement and moves its one listener', () => {
    const previous = link.managers.at(-1)!;
    const context = captureCloudV1Context()!;
    expect(previous.listeners.size).toBe(1);
    const current = replaceManager();
    expect(context.isCurrent()).toBe(false);
    expect(captureCloudV1Context()?.isCurrent()).toBe(true);
    expect(previous.listeners.size).toBe(0);
    expect(current.listeners.size).toBe(1);
  });

  it('lets a newer selection win when mint responses finish out of order', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let mintCount = 0;
    fakeCloud((url) => {
      if (url.pathname === '/v1/session') return answer(session);
      return ++mintCount === 1 ? first.promise : second.promise;
    });
    const older = primeCreditsInferenceWithContext(captureCloudV1Context());
    await vi.waitFor(() => expect(mintCount).toBe(1));
    const newer = primeCreditsInferenceWithContext(captureCloudV1Context());
    await vi.waitFor(() => expect(mintCount).toBe(2));
    second.resolve(answer({ ...tokenFixture, token: 'new-token' }));
    expect(await newer).toBe(true);
    expect(creditsTurnEnvFor('claude-code', true).ANTHROPIC_AUTH_TOKEN).toBe('new-token');
    first.resolve(answer({ ...tokenFixture, token: 'old-token' }));
    expect(await older).toBe(false);
    expect(creditsWiringReport().ready).toBe(true);
    expect(creditsTurnEnvFor('claude-code', true).ANTHROPIC_AUTH_TOKEN).toBe('new-token');
  });

  it('clears a prior mint on observed refusal but keeps it after a transient refresh failure', async () => {
    let status = 200;
    fakeCloud((url) =>
      status === 200
        ? answer(url.pathname === '/v1/session' ? session : tokenFixture)
        : answer({ code: 'unauthorized', status, title: 'No longer linked' }, status)
    );
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    );
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(false);
    expect(creditsWiringReport().ready).toBe(true);
    status = 401;
    fakeCloud(() => answer({ code: 'unauthorized', status, title: 'No longer linked' }, status));
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(false);
    expect(creditsWiringReport().ready).toBe(false);
  });

  it('never logs a malformed mint response body containing credential material', async () => {
    const canary = 'LEAKME';
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    fakeCloud((url) =>
      url.pathname === '/v1/session'
        ? answer(session)
        : new Response(canary, { headers: { 'content-type': 'application/json' } })
    );
    expect(await primeCreditsInferenceWithContext(captureCloudV1Context())).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
    warn.mockRestore();
  });

  it('keeps the production paid gate before any introspection', async () => {
    const fetch = fakeCloud(() => answer(session));
    expect(await primeCreditsInference()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
