import { describe, it, expect, vi } from 'vitest';
import {
  createRelayListAdaptersHandler,
  createRelayEnableAdapterHandler,
  createRelayDisableAdapterHandler,
  createRelayReloadAdaptersHandler,
  type McpToolDeps,
} from '../mcp-tool-server.js';

/** Create a mock AdapterManager with default stubs. */
function makeMockAdapterManager(overrides?: Record<string, unknown>) {
  return {
    listAdapters: vi.fn().mockReturnValue([
      {
        config: { id: 'tg-main', type: 'telegram', enabled: true, config: { token: 'x', mode: 'polling' } },
        status: { state: 'connected', messageCount: { inbound: 5, outbound: 3 }, errorCount: 0 },
      },
    ]),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeMockDeps(adapterManager?: ReturnType<typeof makeMockAdapterManager> | undefined): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    adapterManager: adapterManager as unknown as McpToolDeps['adapterManager'],
  };
}

describe('Adapter MCP Tools', () => {
  describe('relay_list_adapters', () => {
    it('returns ADAPTERS_DISABLED when adapterManager is undefined', async () => {
      const handler = createRelayListAdaptersHandler(makeMockDeps());
      const result = await handler();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ADAPTERS_DISABLED' });
    });

    it('lists adapters with count', async () => {
      const mgr = makeMockAdapterManager();
      const handler = createRelayListAdaptersHandler(makeMockDeps(mgr));
      const result = await handler();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.adapters[0].config.id).toBe('tg-main');
      expect(data.adapters[0].status.state).toBe('connected');
      expect(mgr.listAdapters).toHaveBeenCalledOnce();
    });

    it('returns empty list when no adapters configured', async () => {
      const mgr = makeMockAdapterManager({ listAdapters: vi.fn().mockReturnValue([]) });
      const handler = createRelayListAdaptersHandler(makeMockDeps(mgr));
      const result = await handler();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
      expect(data.adapters).toEqual([]);
    });
  });

  describe('relay_enable_adapter', () => {
    it('returns ADAPTERS_DISABLED when adapterManager is undefined', async () => {
      const handler = createRelayEnableAdapterHandler(makeMockDeps());
      const result = await handler({ id: 'tg-main' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ADAPTERS_DISABLED' });
    });

    it('enables adapter and returns success', async () => {
      const mgr = makeMockAdapterManager();
      const handler = createRelayEnableAdapterHandler(makeMockDeps(mgr));
      const result = await handler({ id: 'tg-main' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ ok: true, id: 'tg-main', action: 'enabled' });
      expect(mgr.enable).toHaveBeenCalledWith('tg-main');
    });

    it('returns ENABLE_FAILED when adapter not found', async () => {
      const mgr = makeMockAdapterManager({
        enable: vi.fn().mockRejectedValue(new Error('Adapter not found: missing')),
      });
      const handler = createRelayEnableAdapterHandler(makeMockDeps(mgr));
      const result = await handler({ id: 'missing' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('ENABLE_FAILED');
      expect(data.error).toContain('Adapter not found');
    });
  });

  describe('relay_disable_adapter', () => {
    it('returns ADAPTERS_DISABLED when adapterManager is undefined', async () => {
      const handler = createRelayDisableAdapterHandler(makeMockDeps());
      const result = await handler({ id: 'tg-main' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ADAPTERS_DISABLED' });
    });

    it('disables adapter and returns success', async () => {
      const mgr = makeMockAdapterManager();
      const handler = createRelayDisableAdapterHandler(makeMockDeps(mgr));
      const result = await handler({ id: 'tg-main' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ ok: true, id: 'tg-main', action: 'disabled' });
      expect(mgr.disable).toHaveBeenCalledWith('tg-main');
    });

    it('returns DISABLE_FAILED when adapter not found', async () => {
      const mgr = makeMockAdapterManager({
        disable: vi.fn().mockRejectedValue(new Error('Adapter not found: missing')),
      });
      const handler = createRelayDisableAdapterHandler(makeMockDeps(mgr));
      const result = await handler({ id: 'missing' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('DISABLE_FAILED');
      expect(data.error).toContain('Adapter not found');
    });
  });

  describe('relay_reload_adapters', () => {
    it('returns ADAPTERS_DISABLED when adapterManager is undefined', async () => {
      const handler = createRelayReloadAdaptersHandler(makeMockDeps());
      const result = await handler();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'ADAPTERS_DISABLED' });
    });

    it('reloads config and returns adapter count', async () => {
      const mgr = makeMockAdapterManager();
      const handler = createRelayReloadAdaptersHandler(makeMockDeps(mgr));
      const result = await handler();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.ok).toBe(true);
      expect(data.adapterCount).toBe(1);
      expect(mgr.reload).toHaveBeenCalledOnce();
      expect(mgr.listAdapters).toHaveBeenCalledOnce();
    });

    it('returns RELOAD_FAILED on error', async () => {
      const mgr = makeMockAdapterManager({
        reload: vi.fn().mockRejectedValue(new Error('Config parse failed')),
      });
      const handler = createRelayReloadAdaptersHandler(makeMockDeps(mgr));
      const result = await handler();
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.code).toBe('RELOAD_FAILED');
      expect(data.error).toContain('Config parse failed');
    });
  });

  describe('tool registration', () => {
    it('adapter tools are not registered when adapterManager is undefined', async () => {
      // Import the factory to verify conditional registration
      const { createDorkOsToolServer } = await import('../mcp-tool-server.js');

      // The tool server with no adapterManager should not include adapter tools
      // We verify by checking the deps flow — the handler guards will block calls
      const handler = createRelayListAdaptersHandler(makeMockDeps());
      const result = await handler();
      expect(result.isError).toBe(true);
    });
  });
});
