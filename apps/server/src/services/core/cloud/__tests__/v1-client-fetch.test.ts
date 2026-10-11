/**
 * The `/v1` fetch seam: production builds every contract client with the
 * global `fetch`, and only a caller that set a replacement (the test-mode
 * composition root) gets its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CloudApiClientOptions } from '@dork-labs/cloud-api/client';

const seen = vi.hoisted(() => ({ options: [] as CloudApiClientOptions[] }));
const mockEnv = vi.hoisted(() => ({ DORKOS_TEST_RUNTIME: true }));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));

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
    mockEnv.DORKOS_TEST_RUNTIME = true;
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

  it('refuses a replacement outside test mode, and still allows clearing one', () => {
    mockEnv.DORKOS_TEST_RUNTIME = false;
    expect(() => setCloudV1Fetch(vi.fn())).toThrow(
      'setCloudV1Fetch is test-mode only (DORKOS_TEST_RUNTIME)'
    );
    expect(() => setCloudV1Fetch(undefined)).not.toThrow();
    createCloudV1Client();
    expect(seen.options[0]).not.toHaveProperty('fetch');
  });

  it('only the test-mode composition root names the seam outside its own module and tests', () => {
    const src = fileURLToPath(new URL('../../../../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(path);
        } else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(src);
    const naming = files
      .filter((file) => readFileSync(file, 'utf8').includes('setCloudV1Fetch'))
      .map((file) => relative(src, file))
      .sort();
    expect(naming).toEqual([
      'services/core/cloud/v1-client.ts',
      'services/runtimes/test-mode/compose-test-cloud.ts',
    ]);
  });
});
