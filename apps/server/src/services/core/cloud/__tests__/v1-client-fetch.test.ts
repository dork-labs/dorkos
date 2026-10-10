/**
 * The `/v1` fetch seam: production builds every contract client with the
 * global `fetch`, and only a caller that set a replacement (the test-mode
 * composition root) gets its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudApiClientOptions } from '@dork-labs/cloud-api/client';

const seen = vi.hoisted(() => ({ options: [] as CloudApiClientOptions[] }));

vi.mock('@dork-labs/cloud-api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dork-labs/cloud-api/client')>();
  return {
    ...actual,
    createCloudApiClient: (options: CloudApiClientOptions) => {
      seen.options.push(options);
      return actual.createCloudApiClient(options);
    },
  };
});
vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: (section: string) => (section === 'cloud' ? { instanceToken: 'token-A' } : undefined),
    onChange: () => () => {},
  },
}));
vi.mock('../../auth/cloud-link-client.js', () => ({
  resolveCloudBaseUrl: () => 'https://cloud.example.invalid',
}));
vi.mock('../../auth/cloud-link.js', () => ({ getCloudLinkGeneration: () => 1 }));

import { captureCloudV1Context, createCloudV1Client, setCloudV1Fetch } from '../v1-client.js';

describe('the /v1 fetch seam', () => {
  beforeEach(() => {
    seen.options.length = 0;
  });
  afterEach(() => {
    setCloudV1Fetch(undefined);
  });

  it('passes no custom fetch by default, so the global one serves production', () => {
    createCloudV1Client();
    captureCloudV1Context();
    expect(seen.options).toHaveLength(2);
    for (const options of seen.options) expect(options).not.toHaveProperty('fetch');
  });

  it('hands a set fetch to every client it builds, and answers through it', async () => {
    const fake = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ authenticated: false, scopes: [] }), {
          headers: { 'content-type': 'application/json' },
        })
    );
    setCloudV1Fetch(fake);
    const client = createCloudV1Client()!;
    const context = captureCloudV1Context()!;
    expect(seen.options.map((options) => options.fetch)).toEqual([fake, fake]);

    await client.get('/v1/session', (await import('@dork-labs/cloud-api')).SessionSchema);
    await context.client.get('/v1/session', (await import('@dork-labs/cloud-api')).SessionSchema);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(fake.mock.calls[0]![0]).toBe('https://cloud.example.invalid/v1/session');
  });

  it('goes back to the global fetch once cleared', () => {
    setCloudV1Fetch(vi.fn());
    setCloudV1Fetch(undefined);
    createCloudV1Client();
    expect(seen.options[0]).not.toHaveProperty('fetch');
  });
});
