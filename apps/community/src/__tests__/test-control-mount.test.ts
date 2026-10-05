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
  // Never connected: neither test-control route reads the database.
  const pool = new Pool({ connectionString: config.databaseUrl });
  pools.push(pool);
  return createCommunityApp({ config, pool });
}

// Purpose: fails if the unauthenticated delivery-gate controls are mounted on a server that did
// not turn the test runtime on, or if turning it on (with its acknowledgement) stops mounting
// them, which the acceptance run and the two-desktop browser test depend on (DOR-2655).
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
  });

  it('are there when the test runtime is on and acknowledged', async () => {
    const app = appFor({
      COMMUNITY_TEST_RUNTIME: 'true',
      COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT: COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE,
    });
    const response = await app.request('/api/test/delivery-receipt-gate');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'idle' });
  });
});
