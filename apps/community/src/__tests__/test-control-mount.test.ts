import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCommunityApp } from '../app.js';
import { COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE, parseConfig } from '../config.js';

const env = {
  COMMUNITY_DATABASE_URL: 'postgres://postgres:pass@127.0.0.1:1/community',
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: '/tmp/community-blobs',
};

const pools: Pool[] = [];
afterAll(() => Promise.all(pools.map((pool) => pool.end())));

function appFor(extra: Record<string, string>) {
  const config = parseConfig({ ...env, ...extra });
  // Never connected: these tests only check mounting. The one test-control route that reads the
  // database, POST /api/test/load-fixture, is only ever sent a body it refuses before that.
  const pool = new Pool({ connectionString: config.databaseUrl });
  pools.push(pool);
  return createCommunityApp({ config, pool });
}

// Purpose: fails if the unauthenticated test controls (the delivery gate, and the load-test
// seeder that writes members and credentials straight into the database) are mounted on a server
// that did not turn the test runtime on, or if turning it on (with its acknowledgement) stops
// mounting them, which the acceptance run, the two-desktop browser test (DOR-2655) and
// apps/community/load (DOR-2771) depend on.
describe('test-control routes', () => {
  it('are not there when the test runtime is off', async () => {
    const app = appFor({});
    expect((await app.request('/api/test/delivery-receipt-gate')).status).toBe(404);
    const post = await app.request('/api/test/delivery-receipt-gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    });
    expect(post.status).toBe(404);
    const seed = await app.request('/api/test/load-fixture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readerCount: 1, writerCount: 1 }),
    });
    expect(seed.status).toBe(404);
  });

  it('refuse to start with the test runtime on but not acknowledged', () => {
    expect(() => appFor({ COMMUNITY_TEST_RUNTIME: 'true' })).toThrow(/COMMUNITY_TEST_RUNTIME/);
  });

  it('are there when the test runtime is on and acknowledged', async () => {
    const app = appFor({
      COMMUNITY_TEST_RUNTIME: 'true',
      COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT: COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE,
    });
    const response = await app.request('/api/test/delivery-receipt-gate');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'idle' });
    // Mounted: a body it refuses answers 400, not 404, and never reaches the database.
    const seed = await app.request('/api/test/load-fixture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readerCount: -1 }),
    });
    expect(seed.status).toBe(400);
  });
});
