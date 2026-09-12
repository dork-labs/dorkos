import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

import { logger } from '../../../../lib/logger.js';
import {
  PLUGIN_RELOAD_SILENT_TOKENS,
  conversationTokens,
  logCacheImpactMeasurement,
  pluginReloadIsWorthHolding,
  readCacheImpact,
  type PluginReloadCacheImpact,
} from '../messaging/plugin-reload-policy.js';

const IMPACT: PluginReloadCacheImpact = {
  mcpServersAdded: ['plugin:flow:linear'],
  mcpServersRemoved: [],
  lspToolChange: 'adds',
};

describe('pluginReloadIsWorthHolding', () => {
  // The threshold comparison is the whole policy, so both sides of it are
  // pinned: a mutation from `>=` to `>` or a nudged constant reds here.
  it('holds a conversation exactly at the threshold', () => {
    expect(pluginReloadIsWorthHolding(PLUGIN_RELOAD_SILENT_TOKENS)).toBe(true);
  });

  it('applies one token below the threshold', () => {
    expect(pluginReloadIsWorthHolding(PLUGIN_RELOAD_SILENT_TOKENS - 1)).toBe(false);
  });

  it('holds a conversation well above the threshold', () => {
    expect(pluginReloadIsWorthHolding(PLUGIN_RELOAD_SILENT_TOKENS * 10)).toBe(true);
  });

  it('applies at once when the size is unknown — a fresh session has no cache to protect', () => {
    expect(pluginReloadIsWorthHolding(undefined)).toBe(false);
  });

  it('applies at once on an empty conversation', () => {
    expect(pluginReloadIsWorthHolding(0)).toBe(false);
  });
});

describe('readCacheImpact', () => {
  it('reads the three fields the CLI sends', () => {
    expect(
      readCacheImpact({
        mcp_servers_added: ['plugin:a:one'],
        mcp_servers_removed: ['plugin:b:two'],
        lsp_tool_change: 'may-remove',
      })
    ).toEqual({
      mcpServersAdded: ['plugin:a:one'],
      mcpServersRemoved: ['plugin:b:two'],
      lspToolChange: 'may-remove',
    });
  });

  it('survives a hold that carried no cache_impact at all', () => {
    expect(readCacheImpact(undefined)).toEqual({
      mcpServersAdded: [],
      mcpServersRemoved: [],
      lspToolChange: null,
    });
  });

  it('drops an lsp value outside the four the SDK declares', () => {
    expect(readCacheImpact({ lsp_tool_change: 'explodes' }).lspToolChange).toBeNull();
  });

  it('drops non-string entries from the server name lists', () => {
    expect(readCacheImpact({ mcp_servers_added: ['ok', 7, null] }).mcpServersAdded).toEqual(['ok']);
  });
});

describe('logCacheImpactMeasurement', () => {
  beforeEach(() => vi.mocked(logger.debug).mockClear());

  it('writes every hold check to debug, held or not, with the three fields', () => {
    logCacheImpactMeasurement({
      sessionId: 's1',
      held: false,
      contextTokens: 4_200,
      impact: undefined,
    });

    expect(logger.debug).toHaveBeenCalledWith(
      '[plugin-reload] cache-impact check',
      expect.objectContaining({
        sessionId: 's1',
        held: false,
        contextTokens: 4_200,
        mcpServersAdded: [],
        mcpServersRemoved: [],
        lspToolChange: null,
      })
    );
  });

  it('carries the impact fields when the reload was held', () => {
    logCacheImpactMeasurement({
      sessionId: 's1',
      held: true,
      contextTokens: 90_000,
      impact: IMPACT,
    });

    expect(logger.debug).toHaveBeenCalledWith(
      '[plugin-reload] cache-impact check',
      expect.objectContaining({
        held: true,
        mcpServersAdded: ['plugin:flow:linear'],
        lspToolChange: 'adds',
      })
    );
  });
});

describe('conversationTokens', () => {
  it('sums the input-side terms of the last request', () => {
    expect(
      conversationTokens({
        lastRequestUsage: { inputTokens: 10, cacheReadTokens: 200, cacheCreationTokens: 3_000 },
      })
    ).toBe(3_210);
  });

  it('answers unknown for a session that has completed no request', () => {
    expect(conversationTokens({})).toBeUndefined();
  });
});
