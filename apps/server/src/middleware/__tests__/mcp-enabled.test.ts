import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
  },
}));

import { requireMcpEnabled } from '../mcp-enabled.js';
import { configManager } from '../../services/core/config-manager.js';

/** The switch in front of a route that says it was reached. */
const app = new Hono();
app.use('/mcp', requireMcpEnabled);
app.post('/mcp', (c) => c.json({ reached: true }));

/** One request through the switch. */
function post(): Promise<Response> {
  return Promise.resolve(app.request('/mcp', { method: 'POST' }));
}

describe('requireMcpEnabled', () => {
  beforeEach(() => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
  });

  it('lets the request through when mcp.enabled is true', async () => {
    vi.mocked(configManager.get).mockReturnValue({
      enabled: true,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });

  it('lets the request through when mcp config is undefined (default enabled)', async () => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
    const res = await post();
    expect(res.status).toBe(200);
  });

  it('returns 503 with JSON-RPC error when mcp.enabled is false', async () => {
    vi.mocked(configManager.get).mockReturnValue({
      enabled: false,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    });
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'External MCP access is disabled.' },
      id: null,
    });
  });

  it('reads from the "mcp" config key', async () => {
    await post();
    expect(configManager.get).toHaveBeenCalledWith('mcp');
  });
});
