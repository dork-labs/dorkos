import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { mountBetterAuth } from '../better-auth.js';
import type { ApiEnv } from '../api-chain.js';
import type { Auth } from '../../services/core/auth/index.js';
import { initConfigManager } from '../../services/core/config-manager.js';

// The real config and the real key-list projection: only Better Auth's handler is a stand-in,
// answering one made-up key, so the test can see what the HTTP boundary adds to it (DOR-4206).
let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-key-list-'));
  initConfigManager(tmpDir);
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('key list remote-use projection at the HTTP boundary', () => {
  it('decorates the key list after the auth handler answers, leaving other endpoints alone', async () => {
    const handler = vi.fn(async () =>
      Response.json({ apiKeys: [{ id: 'key-test', name: 'Test' }], total: 1 })
    );
    const app = new Hono<ApiEnv>();
    mountBetterAuth(app, { auth: { handler } as unknown as Auth });
    async function get(path: string) {
      const headers = { host: 'localhost:4242' };
      return app.request(
        path,
        { headers },
        {
          incoming: { headers, socket: { remoteAddress: '127.0.0.1' }, url: path, method: 'GET' },
        }
      );
    }
    const list = await get('/api/auth/api-key/list');
    expect(list.status).toBe(200);
    // No remote use recorded for this key, so the projection says so.
    expect(await list.json()).toEqual({
      apiKeys: [{ id: 'key-test', name: 'Test', lastUsedRemotelyAt: null }],
      total: 1,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const other = await get('/api/auth/get-session');
    expect(await other.json()).toEqual({ apiKeys: [{ id: 'key-test', name: 'Test' }], total: 1 });
  });
});
