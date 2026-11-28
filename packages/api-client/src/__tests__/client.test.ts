import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Problem } from '@dorkos/shared/problem';
import { ApiProblemError, createApiClient, type FetchLike } from '../index.js';

/** A `fetch` that answers every request with this status and body. */
function answering(status: number, body?: unknown, contentType = 'application/json') {
  return vi.fn<FetchLike>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': contentType },
      })
  );
}

describe('createApiClient', () => {
  it('sends an operation to its method and path, filling and encoding the parameters', async () => {
    const fetch = answering(200, { id: 'notes', status: 'compiled', bundleReady: true });
    const api = createApiClient({ baseUrl: '/api', fetch });

    const result = await api.call('extensions.restart', { path: { id: 'notes app' } });

    expect(result).toEqual({ id: 'notes', status: 'compiled', bundleReady: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/extensions/notes%20app/restart');
    // A write the document gives no body sends none, like the hand-written writes.
    expect(init).toMatchObject({ method: 'POST' });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
  });

  it('serializes the query and sends no body on a read', async () => {
    const fetch = answering(200, { kind: 'room', roomId: 'r1' });
    const api = createApiClient({ baseUrl: '/api', fetch });

    await api.call('link.resolve', { query: { uri: 'dork:room:r1' } });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/links/target?uri=dork%3Aroom%3Ar1');
    expect(init).toMatchObject({ method: 'GET' });
    expect(init?.body).toBeUndefined();
  });

  it('passes an allowed header through, and refuses every other one in any shape', async () => {
    const fetch = answering(200, {});
    const api = createApiClient({ baseUrl: '/api', fetch });

    await api.call('computers.deleteControl', {
      body: { leaseId: 'l1' },
      headers: { 'X-Client-Id': 'window-1' },
    });

    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.get('X-Client-Id')).toBe('window-1');
    expect(headers.get('Content-Type')).toBe('application/json');
    const refused = ['Content-Type', 'Authorization', 'X-DorkOS-Community-Owner', 'X-DorkOS-Agent'];
    for (const name of refused) {
      // A record, a Headers instance and an entries array cast past the type.
      for (const shape of [
        { [name]: 'secret' },
        new Headers({ [name]: 'secret' }),
        [[name, 'secret']],
      ]) {
        const call = api.call('computers.get', { headers: shape as Record<string, string> });
        const error = await call.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toContain(name.toLowerCase());
        expect((error as Error).message).not.toContain('secret');
      }
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a problem document as an ApiProblemError that carries the Problem', async () => {
    const problem = {
      type: 'urn:dorkos:problem:needs_approval',
      title: 'This waits for a person to approve it.',
      status: 403,
      code: 'needs_approval',
      detail: 'Review the app first.',
    };
    const api = createApiClient({
      baseUrl: '/api',
      fetch: answering(403, problem, 'application/problem+json'),
    });

    const error = await api
      .call('extensions.restart', { path: { id: 'notes' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiProblemError);
    expectTypeOf((error as ApiProblemError).problem).toEqualTypeOf<Problem | undefined>();
    expect(error).toMatchObject({
      message: 'Review the app first.',
      status: 403,
      code: 'needs_approval',
      problem,
    });
  });

  it('reads a held answer that is not a problem by its code, with no Problem', async () => {
    const api = createApiClient({
      baseUrl: '/api',
      fetch: answering(401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' }),
    });

    await expect(api.call('extensions.restart', { path: { id: 'notes' } })).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_REQUIRED',
      problem: undefined,
    });
  });
});
