// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserProductionHttp } from '../browser-production-http';
const binding = {
  browserId: 'browser_original_000000000001',
  browserGeneration: 1,
  tabId: 'tab_original_reference_000001',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const instance = {
  browserId: binding.browserId,
  browserGeneration: 1,
  mode: 'ephemeral',
  status: 'running',
};
const workspaceId = 'workspace_owned_reference_00001';
const request = {
  requestId: 'request_original_reference_0001',
  mode: 'ephemeral' as const,
};
const base = 'http://localhost:4242/api';
const signal = () => new AbortController().signal;
function serve(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
describe('production browser session wire', () => {
  it('uses original cookie auth and exact workspace/request correlation for acquisition', async () => {
    const fetch = serve({ requestId: request.requestId, instance, binding });
    const response = await createBrowserProductionHttp(base).openBrowserRuntime(
      workspaceId,
      request,
      signal()
    );
    expect(response.instance.browserId).toBe(binding.browserId);
    expect(fetch).toHaveBeenCalledWith(
      base + '/browser/runtime/open',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ workspaceId, request }),
      })
    );
    expect(Object.isFrozen(response.binding)).toBe(true);
  });
  it('rejects malformed persistent acquisition before fetch and rejects wrong original request correlation', async () => {
    const fetch = serve({
      requestId: 'request_foreign_reference_00001',
      instance,
      binding,
    });
    await expect(
      createBrowserProductionHttp(base).openBrowserRuntime(
        workspaceId,
        {
          requestId: request.requestId,
          mode: 'persistent',
          profileId: '',
        },
        signal()
      )
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      createBrowserProductionHttp(base).openBrowserRuntime(workspaceId, request, signal())
    ).rejects.toThrow('did not match');
  });
  it('refuses a rebound generation or repeated tab in original binding discovery', async () => {
    serve([{ ...binding, browserGeneration: 2 }]);
    await expect(
      createBrowserProductionHttp(base).getBrowserBindings(binding.browserId, 1, signal())
    ).rejects.toThrow('did not match');
    serve([binding, binding]);
    await expect(
      createBrowserProductionHttp(base).getBrowserBindings(binding.browserId, 1, signal())
    ).rejects.toThrow('repeated');
  });
  it('admits only genuine paired takeover counter advancement and a non-null ready controller', async () => {
    const controllerId = 'controller_original_reference_001';
    const advanced = { ...binding, epoch: 1, inputGeneration: 1 };
    serve({ binding: advanced, controllerId, status: 'ready' });
    expect(
      (await createBrowserProductionHttp(base).takeBrowserControl(binding, signal())).binding
    ).toEqual(advanced);
    serve({
      binding: { ...advanced, inputGeneration: 0 },
      controllerId,
      status: 'ready',
    });
    await expect(
      createBrowserProductionHttp(base).takeBrowserControl(binding, signal())
    ).rejects.toThrow('could not be confirmed');
    serve({ binding: advanced, controllerId: null, status: 'ready' });
    await expect(
      createBrowserProductionHttp(base).takeBrowserControl(binding, signal())
    ).rejects.toThrow('could not be confirmed');
  });
  it.each([401, 403, 503])('never retries a genuine server refusal %s', async (status) => {
    const fetch = serve({ error: 'Unavailable' }, status);
    await expect(
      createBrowserProductionHttp(base).readBrowserRuntimeStatus(signal())
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not turn enabled-only status into readiness', async () => {
    serve({ enabled: true });
    await expect(
      createBrowserProductionHttp(base).readBrowserRuntimeStatus(signal())
    ).rejects.toThrow();
  });
  it('uses the original semantic activation request and requires correlated stored position', async () => {
    const originalController = new AbortController(),
      originalSignal = originalController.signal;
    const fetch = serve({ state: 'ready', enabled: true, workspaces: [] });
    const response = await createBrowserProductionHttp(base).setBrowserRuntimeEnabled(
      true,
      originalSignal
    );
    expect(response.state).toBe('ready');
    expect(fetch).toHaveBeenCalledWith(
      base + '/browser/runtime/enable',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ enabled: true }),
      })
    );
    const fetchedSignal = fetch.mock.calls[0][1]?.signal;
    if (!fetchedSignal) throw new Error('Original fetched signal was not retained');
    expect(fetchedSignal.aborted).toBe(false);
    const originalReason = Object.freeze({
      kind: 'original activation caller loss',
    });
    originalController.abort(originalReason);
    expect(fetchedSignal.aborted).toBe(true);
    expect(fetchedSignal.reason).toBe(originalReason);
    serve({ state: 'disabled', enabled: false });
    await expect(
      createBrowserProductionHttp(base).setBrowserRuntimeEnabled(true, signal())
    ).rejects.toThrow('could not be confirmed');
  });
  it('accepts disabled only after actual off receipt and never interprets it as observed browser cleanup', async () => {
    serve({ state: 'disabled', enabled: false });
    const response = await createBrowserProductionHttp(base).setBrowserRuntimeEnabled(
      false,
      signal()
    );
    expect(response).toEqual({ state: 'disabled', enabled: false });
    expect('cleanup' in response).toBe(false);
    serve({
      state: 'unavailable',
      enabled: false,
      cause: 'custodyUnavailable',
    });
    await expect(
      createBrowserProductionHttp(base).setBrowserRuntimeEnabled(false, signal())
    ).rejects.toThrow('could not be confirmed');
  });
});

describe('production navigation wire', () => {
  const controllerId = 'controller_original_reference_001';
  const command = {
    kind: 'navigate' as const,
    requestId: request.requestId,
    binding,
    url: 'https://example.com/',
  };
  const successor = {
    ...binding,
    epoch: 1,
    inputGeneration: 1,
    navigationGeneration: 1,
  };
  it('uses cookie auth and exact command/controller correlation for actual navigation', async () => {
    const fetch = serve({ requestId: command.requestId, binding: successor });
    const receipt = await createBrowserProductionHttp(base).navigateBrowser!(
      command,
      controllerId,
      signal()
    );
    expect(receipt.binding).toEqual(successor);
    expect(Object.isFrozen(receipt.binding)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      base + '/browser/runtime/navigate',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ command, controllerId }),
      })
    );
  });
  it('refuses an otherwise valid cohort belonging to another original request', async () => {
    serve({ requestId: 'request_foreign_navigation_001', binding: successor });
    await expect(
      createBrowserProductionHttp(base).navigateBrowser!(command, controllerId, signal())
    ).rejects.toThrow('could not be confirmed');
  });
  it.each([
    { ...successor, tabId: 'tab_foreign_reference_000001' },
    { ...successor, browserGeneration: 2 },
    { ...successor, viewportVersion: 1 },
    { ...successor, epoch: 0 },
    { ...successor, navigationGeneration: 0 },
    { ...successor, inputGeneration: 0 },
  ])('refuses a result outside the exact navigation cohort %j', async (binding) => {
    serve({ requestId: command.requestId, binding });
    await expect(
      createBrowserProductionHttp(base).navigateBrowser!(command, controllerId, signal())
    ).rejects.toThrow('could not be confirmed');
  });
  it('carries optional initial URL into the existing original acquisition body', async () => {
    const fetch = serve({ requestId: request.requestId, instance, binding });
    await createBrowserProductionHttp(base).openBrowserRuntime(
      workspaceId,
      request,
      signal(),
      command.url
    );
    expect(fetch).toHaveBeenCalledWith(
      base + '/browser/runtime/open',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      })
    );
    const body = fetch.mock.calls[0][1]?.body;
    if (typeof body !== 'string') throw new Error('Expected the original JSON request body');
    expect(JSON.parse(body)).toEqual({
      workspaceId,
      request,
      initialUrl: command.url,
    });
  });
});

it('creates named owner metadata with exact request correlation and no actor or native path DTO', async () => {
  const request = {
    requestId: 'request_profile_create_0000001',
    label: 'Work account',
  };
  const profile = {
    profileId: 'profile_owned_reference_000001',
    label: request.label,
    revision: 0,
    status: 'available',
  };
  const fetch = serve({ requestId: request.requestId, profile });
  const receipt = await createBrowserProductionHttp(base).createBrowserProfile(request, signal());
  expect(receipt.profile.profileId).toBe(profile.profileId);
  expect(Object.isFrozen(receipt.profile)).toBe(true);
  expect(fetch).toHaveBeenCalledWith(
    base + '/browser/runtime/profiles',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(request),
    })
  );
  serve({ requestId: 'request_wrong_reference_000001', profile });
  await expect(
    createBrowserProductionHttp(base).createBrowserProfile(request, signal())
  ).rejects.toThrow('could not be confirmed');
});

it('forwards persistent acquisition only with its exact named profile and refuses substituted mode, profile, or generation', async () => {
  const persistent = {
    requestId: request.requestId,
    mode: 'persistent' as const,
    profileId: 'profile_owned_reference_000001',
  };
  const fetch = serve({
    requestId: persistent.requestId,
    instance: {
      ...instance,
      mode: 'persistent',
      profileId: persistent.profileId,
    },
    binding,
  });
  const receipt = await createBrowserProductionHttp(base).openBrowserRuntime(
    workspaceId,
    persistent,
    signal()
  );
  expect(receipt.instance.mode).toBe('persistent');
  expect(fetch).toHaveBeenCalledWith(
    base + '/browser/runtime/open',
    expect.objectContaining({
      body: JSON.stringify({ workspaceId, request: persistent }),
    })
  );
  serve({ requestId: persistent.requestId, instance, binding });
  await expect(
    createBrowserProductionHttp(base).openBrowserRuntime(workspaceId, persistent, signal())
  ).rejects.toThrow('did not match');
  serve({
    requestId: persistent.requestId,
    instance: {
      ...instance,
      mode: 'persistent',
      profileId: 'profile_foreign_reference_0001',
    },
    binding,
  });
  await expect(
    createBrowserProductionHttp(base).openBrowserRuntime(workspaceId, persistent, signal())
  ).rejects.toThrow('did not match');
  serve({
    requestId: persistent.requestId,
    instance: {
      ...instance,
      mode: 'persistent',
      profileId: persistent.profileId,
    },
    binding: { ...binding, browserGeneration: binding.browserGeneration + 1 },
  });
  await expect(
    createBrowserProductionHttp(base).openBrowserRuntime(workspaceId, persistent, signal())
  ).rejects.toThrow('does not match its current binding');
});

it('sends an explicit owner local endpoint request and validates its original endpoint and tab receipt', async () => {
  const request = {
    requestId: 'local_permission_original_request',
    binding,
    endpoint: 'http://127.0.0.1:4567/',
    ttlMilliseconds: 300000,
  };
  const fetch = serve({
    requestId: request.requestId,
    binding,
    endpoint: 'http://127.0.0.1:4567',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  });
  await expect(
    createBrowserProductionHttp(base).allowBrowserLocalDestination!(request, signal())
  ).resolves.toMatchObject({ endpoint: 'http://127.0.0.1:4567' });
  expect(fetch).toHaveBeenCalledWith(
    base + '/browser/runtime/local-destination',
    expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify(request),
    })
  );
  serve({
    requestId: request.requestId,
    binding: { ...binding, epoch: 1 },
    endpoint: 'http://127.0.0.1:4567',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  });
  await expect(
    createBrowserProductionHttp(base).allowBrowserLocalDestination!(request, signal())
  ).rejects.toThrow('could not be confirmed');
});
it('public, credential-bearing and non-HTTP endpoint selectors refuse before original fetch', async () => {
  const fetch = serve({});
  for (const endpoint of [
    'https://127.0.0.1:4567/',
    'http://user:pass@127.0.0.1:4567/',
    'http://example.com/',
    'http://127.0.0.1:4567/private',
  ]) {
    await expect(
      createBrowserProductionHttp(base).allowBrowserLocalDestination!(
        {
          requestId: 'local_permission_original_request',
          binding,
          endpoint,
          ttlMilliseconds: 300000,
        },
        signal()
      )
    ).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});
