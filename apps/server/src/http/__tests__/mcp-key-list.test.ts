import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
}));
vi.mock('../../services/core/auth/remote-mcp-audit.js', () => ({
  annotateRemoteMcpKeyList: vi.fn(async (response: Response) => {
    const body = await response.json();
    return Response.json({ ...body, annotated: true });
  }),
}));

import { mountBetterAuth } from '../better-auth.js';
import type { ApiEnv } from '../api-chain.js';
import type { Auth } from '../../services/core/auth/index.js';
import { annotateRemoteMcpKeyList } from '../../services/core/auth/remote-mcp-audit.js';

describe('key list remote-use projection at the HTTP boundary', () => {
  it('decorates the key list after the auth handler answers, leaving other endpoints alone', async () => {
    const handler = vi.fn(async () => Response.json({ apiKeys: [], total: 0 }));
    const app = new Hono<ApiEnv>();
    mountBetterAuth(app, { auth: { handler } as unknown as Auth });
    async function get(path: string) {
      const headers = { host: 'localhost:4242' };
      return app.request(path, { headers }, {
        incoming: { headers, socket: { remoteAddress: '127.0.0.1' }, url: path, method: 'GET' },
      });
    }
    const list = await get('/api/auth/api-key/list');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ apiKeys: [], total: 0, annotated: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(annotateRemoteMcpKeyList).toHaveBeenCalledTimes(1);
    const other = await get('/api/auth/get-session');
    expect(await other.json()).toEqual({ apiKeys: [], total: 0 });
    expect(annotateRemoteMcpKeyList).toHaveBeenCalledTimes(1);
  });
});
