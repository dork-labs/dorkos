/**
 * The `/v1` origin is its own address. Pinned so it can never drift back onto
 * the website's address, where every `/v1` call answered 404 (DOR-2673).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  DORKOS_CLOUD_URL: 'https://dorkos.ai',
  DORKOS_CLOUD_API_URL: undefined as string | undefined,
}));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));

import { DEFAULT_CLOUD_API_URL, resolveCloudApiBaseUrl } from '../cloud-api-origin.js';
import { DEFAULT_CLOUD_URL, resolveCloudBaseUrl } from '../../auth/cloud-link-client.js';

afterEach(() => {
  mockEnv.DORKOS_CLOUD_URL = DEFAULT_CLOUD_URL;
  mockEnv.DORKOS_CLOUD_API_URL = undefined;
});

describe('resolveCloudApiBaseUrl', () => {
  it('sends /v1 to the cloud origin, not the website, on a default install', () => {
    expect(resolveCloudApiBaseUrl()).toBe('https://cloud.dorkos.ai');
    expect(DEFAULT_CLOUD_API_URL).not.toBe(DEFAULT_CLOUD_URL);
  });

  it('keeps the device link and account calls on the website', () => {
    expect(resolveCloudBaseUrl()).toBe('https://dorkos.ai');
  });

  it('obeys DORKOS_CLOUD_API_URL, trailing slash stripped', () => {
    mockEnv.DORKOS_CLOUD_API_URL = 'https://cloud.example.test/';
    expect(resolveCloudApiBaseUrl()).toBe('https://cloud.example.test');
    expect(resolveCloudBaseUrl()).toBe('https://dorkos.ai');
  });

  it('follows a custom DORKOS_CLOUD_URL, which serves both surfaces on one origin', () => {
    mockEnv.DORKOS_CLOUD_URL = 'http://localhost:7000/';
    expect(resolveCloudApiBaseUrl()).toBe('http://localhost:7000');
  });

  it('treats any spelling of the default website address as the default', () => {
    for (const spelling of ['https://dorkos.ai/', 'https://DorkOS.ai', 'https://dorkos.ai:443']) {
      mockEnv.DORKOS_CLOUD_URL = spelling;
      expect(resolveCloudApiBaseUrl(), spelling).toBe('https://cloud.dorkos.ai');
    }
  });

  it('prefers DORKOS_CLOUD_API_URL over a custom DORKOS_CLOUD_URL', () => {
    mockEnv.DORKOS_CLOUD_URL = 'http://localhost:7000';
    mockEnv.DORKOS_CLOUD_API_URL = 'http://localhost:7001';
    expect(resolveCloudApiBaseUrl()).toBe('http://localhost:7001');
  });
});
