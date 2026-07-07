import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJSON, buildQueryString } from '../http-client';
import { getAuthRequired, setAuthRequired } from '../../auth-signal';

describe('fetchJSON', () => {
  const BASE_URL = 'http://localhost:4242';

  beforeEach(() => {
    vi.restoreAllMocks();
    setAuthRequired(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setAuthRequired(false);
  });

  it('sends credentials so the Better Auth session cookie rides every call', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await fetchJSON(BASE_URL, '/api/test');

    expect(fetchSpy.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('flips the auth-required signal on a 401 AUTH_REQUIRED response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }), {
        status: 401,
      })
    );

    expect(getAuthRequired()).toBe(false);
    await expect(fetchJSON(BASE_URL, '/api/sessions')).rejects.toThrow('Unauthorized');
    expect(getAuthRequired()).toBe(true);
  });

  it('does not flip the auth-required signal on other 401s', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bad token' }), { status: 401 })
    );

    await expect(fetchJSON(BASE_URL, '/api/sessions')).rejects.toThrow('Bad token');
    expect(getAuthRequired()).toBe(false);
  });

  it('returns parsed JSON on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const result = await fetchJSON<{ ok: boolean }>(BASE_URL, '/api/test');
    expect(result).toEqual({ ok: true });
  });

  it('throws on non-OK responses with error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    );

    await expect(fetchJSON(BASE_URL, '/api/missing')).rejects.toThrow('Not found');
  });

  it('throws user-friendly message on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new DOMException('The operation was aborted.', 'TimeoutError');
      return Promise.reject(err);
    });

    await expect(fetchJSON(BASE_URL, '/api/slow', { timeout: 5000 })).rejects.toThrow(
      'Request timed out after 5s'
    );
  });

  it('re-throws non-timeout fetch errors as-is', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fetchJSON(BASE_URL, '/api/down')).rejects.toThrow('Failed to fetch');
  });

  it('passes caller-provided signal alongside timeout signal', async () => {
    const controller = new AbortController();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await fetchJSON(BASE_URL, '/api/test', { signal: controller.signal });

    // The fetch call should have received a composed signal (not the original)
    const passedSignal = fetchSpy.mock.calls[0][1]?.signal;
    expect(passedSignal).toBeDefined();
    // The composed signal should not be the caller's original signal
    expect(passedSignal).not.toBe(controller.signal);
  });
});

describe('buildQueryString', () => {
  it('builds query string from params', () => {
    expect(buildQueryString({ a: '1', b: 2 })).toBe('?a=1&b=2');
  });

  it('omits undefined values', () => {
    expect(buildQueryString({ a: '1', b: undefined })).toBe('?a=1');
  });

  it('returns empty string when all values are undefined', () => {
    expect(buildQueryString({ a: undefined })).toBe('');
  });
});
