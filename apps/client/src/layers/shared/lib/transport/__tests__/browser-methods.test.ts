// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMethods } from '../browser-methods';
const base = 'http://localhost:4242/api';
const browserId = 'browser_a_____________',
  profileId = 'profile_a_____________';
const profile = { profileId, label: 'Separate profile', revision: 1, status: 'available' };
const instance = {
  browserId,
  browserGeneration: 2,
  mode: 'persistent',
  profileId,
  status: 'running',
};
const request = { requestId: 'request_a_____________', browserId, browserGeneration: 2 };
function serve(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
describe('implemented browser HTTP methods', () => {
  it('reads the exact list envelopes with original session credentials', async () => {
    const fetch = serve({ profiles: [profile] });
    expect(await createBrowserMethods(base).getBrowserProfiles()).toEqual([profile]);
    expect(fetch).toHaveBeenCalledWith(
      `${base}/browser/profiles`,
      expect.objectContaining({ credentials: 'include' })
    );
    serve({ instances: [instance] });
    expect(await createBrowserMethods(base).getBrowserInstances()).toEqual([instance]);
  });
  it('rejects extra keys and private profile fields rather than returning them to callers', async () => {
    serve({ profiles: [{ ...profile, storagePath: '/private/profile' }] });
    await expect(createBrowserMethods(base).getBrowserProfiles()).rejects.toThrow();
    serve({ instances: [], ready: true });
    await expect(createBrowserMethods(base).getBrowserInstances()).rejects.toThrow();
  });
  it('requests one exact generation and refuses a stale or replaced response', async () => {
    const fetch = serve(instance);
    expect(await createBrowserMethods(base).getBrowserInstance(browserId, 2)).toEqual(instance);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${base}/browser/instances/${browserId}?browserGeneration=2`
    );
    serve({ ...instance, browserGeneration: 3 });
    await expect(createBrowserMethods(base).getBrowserInstance(browserId, 2)).rejects.toThrow(
      'did not match'
    );
    serve({ ...profile, profileId: 'profile_b_____________' });
    await expect(createBrowserMethods(base).getBrowserProfile(profileId)).rejects.toThrow(
      'did not match'
    );
  });
  it('refuses malformed request references before any fetch', async () => {
    const fetch = serve(instance);
    await expect(createBrowserMethods(base).getBrowserInstance('../foreign', 2)).rejects.toThrow();
    await expect(
      createBrowserMethods(base).getBrowserInstance(browserId, Number.MAX_SAFE_INTEGER + 1)
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves unverified cleanup and exact request correlation', async () => {
    const receipt = { ...request, cleanup: 'unverified', reason: 'observationUnavailable' };
    const fetch = serve(receipt);
    expect(await createBrowserMethods(base).closeBrowserInstance(request)).toEqual(receipt);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(request),
      credentials: 'include',
    });
    serve({ ...receipt, requestId: 'request_b_____________' });
    await expect(createBrowserMethods(base).closeBrowserInstance(request)).rejects.toThrow(
      'did not match'
    );
  });
  it.each([401, 404, 503])(
    'preserves the existing HTTP refusal %s without fabricating an empty list',
    async (status) => {
      serve({ error: 'Shared browser is unavailable' }, status);
      await expect(createBrowserMethods(base).getBrowserInstances()).rejects.toMatchObject({
        status,
      });
    }
  );
  it('passes caller cancellation into the original fetch', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        })
    );
    vi.stubGlobal('fetch', fetch);
    const pending = createBrowserMethods(base).getBrowserProfiles(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
