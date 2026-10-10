import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

const mockEnv = vi.hoisted(() => ({
  DORKOS_TEST_RUNTIME: true,
  DORKOS_TEST_RUNTIME_DOE: false,
  DORKOS_HOST: 'localhost',
  DORKOS_PORT: 7242,
}));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));
const doe = vi.hoisted(() => ({ constructed: 0 }));
vi.mock('../../doe/index.js', () => ({
  DoeRuntime: class {
    readonly type = 'doe';
    constructor() {
      doe.constructed += 1;
    }
    setSessionSettings() {}
  },
}));
const link = vi.hoisted(() => ({
  fetchImpl: undefined as undefined | ((input: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../../../core/auth/cloud-link.js', () => ({
  initCloudLinkManager: (options: { fetchImpl: typeof link.fetchImpl }) => {
    link.fetchImpl = options.fetchImpl;
  },
}));
const v1 = vi.hoisted(() => ({ fetch: undefined as unknown }));
vi.mock('../../../core/cloud/v1-client.js', () => ({
  setCloudV1Fetch: (fetch: unknown) => {
    v1.fetch = fetch;
  },
}));

import { composeTestModeCloud } from '../compose-test-cloud.js';
import { testControlRouter } from '../../../../routes/test-control.js';
import type { RuntimeRegistry } from '../../../core/runtime-registry.js';

function registry() {
  const registered: unknown[] = [];
  return {
    registered,
    port: {
      register: (runtime: unknown) => registered.push(runtime),
    } as unknown as RuntimeRegistry,
  };
}

describe('composeTestModeCloud', () => {
  const listener = swappableServer();
  beforeEach(() => {
    mockEnv.DORKOS_TEST_RUNTIME = true;
    mockEnv.DORKOS_TEST_RUNTIME_DOE = false;
    doe.constructed = 0;
    v1.fetch = undefined;
    link.fetchImpl = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to run outside test mode', () => {
    mockEnv.DORKOS_TEST_RUNTIME = false;
    expect(() => composeTestModeCloud(registry().port)).toThrow(
      'composeTestModeCloud is test-mode only (DORKOS_TEST_RUNTIME)'
    );
    expect(v1.fetch).toBeUndefined();
    expect(link.fetchImpl).toBeUndefined();
  });

  it('fakes the link and /v1, mounts the local pages, and leaves Doe out by default', async () => {
    const { port, registered } = registry();
    expect(composeTestModeCloud(port)).toBeNull();
    expect(registered).toEqual([]);
    expect(doe.constructed).toBe(0);
    expect(typeof v1.fetch).toBe('function');

    const codes = await link.fetchImpl!('https://cloud.example.invalid/api/auth/device/code', {
      method: 'POST',
    });
    expect(await codes.json()).toMatchObject({
      verification_uri: 'http://localhost:7242/api/test/fake-cloud/approve',
    });

    const app = express().use(express.json()).use('/api/test', testControlRouter);
    const page = await request(listener.mount(app)).get(
      '/api/test/fake-cloud/approve?code=DORK-2F7Q'
    );
    expect(page.status).toBe(200);
    expect(page.text).toContain("You're in.");
    const models = await request(listener.mount(app)).get('/api/test/fake-inference/v1/models');
    expect(models.status).toBe(200);
  });

  it('registers the DorkOS runtime when DORKOS_TEST_RUNTIME_DOE is on', () => {
    mockEnv.DORKOS_TEST_RUNTIME_DOE = true;
    const { port, registered } = registry();
    const runtime = composeTestModeCloud(port);
    expect(runtime).not.toBeNull();
    expect(registered).toEqual([runtime]);
  });
});
