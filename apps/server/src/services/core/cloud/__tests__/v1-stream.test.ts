/**
 * `openCloudV1Stream` (DOR-2086): an event stream under a captured link
 * presents that link's key, and refuses once the link has changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const link = vi.hoisted(() => ({ token: 'token-A' as string | null, generation: 1 }));
vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: (section: string) => (section === 'cloud' ? { instanceToken: link.token } : undefined),
    onChange: () => () => undefined,
  },
}));
vi.mock('../../auth/cloud-link-client.js', () => ({
  resolveCloudBaseUrl: () => 'https://cloud.example.invalid',
}));
vi.mock('../../auth/cloud-link.js', () => ({ getCloudLinkGeneration: () => link.generation }));

import { captureCloudV1Context, openCloudV1Stream, type CloudV1Context } from '../v1-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  link.generation = 1;
});

describe('openCloudV1Stream', () => {
  it('asks for an event stream with the captured key', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const context = captureCloudV1Context()!;
    const signal = new AbortController().signal;
    await openCloudV1Stream(context, '/v1/remote/commands', signal);
    expect(fetch).toHaveBeenCalledWith('https://cloud.example.invalid/v1/remote/commands', {
      headers: { authorization: 'Bearer token-A', accept: 'text/event-stream' },
      signal,
    });
    // The key is not a property anything could read off the context.
    expect(JSON.stringify(Object.values(context))).not.toContain('token-A');
  });

  it('refuses a context whose link changed, or one not captured here', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const context = captureCloudV1Context()!;
    link.generation = 2;
    const signal = new AbortController().signal;
    await expect(openCloudV1Stream(context, '/v1/remote/commands', signal)).rejects.toThrow();
    const forged: CloudV1Context = { client: context.client, isCurrent: () => true };
    await expect(openCloudV1Stream(forged, '/v1/remote/commands', signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
