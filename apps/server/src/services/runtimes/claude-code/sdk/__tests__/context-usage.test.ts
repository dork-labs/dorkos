import { describe, it, expect, vi } from 'vitest';
import { mapSdkContextUsage, fetchContextBreakdown } from '../context-usage.js';
import type { Query, SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';

function sdkResponse(
  overrides: Partial<SDKControlGetContextUsageResponse> = {}
): SDKControlGetContextUsageResponse {
  return {
    totalTokens: 28471,
    maxTokens: 1000000,
    rawMaxTokens: 1000000,
    percentage: 3,
    model: 'claude-opus-4-8',
    categories: [
      { name: 'System tools', tokens: 2685, color: '#1' },
      { name: 'MCP tools (deferred)', tokens: 35186, color: '#2', isDeferred: true },
      { name: 'Skills', tokens: 14425, color: '#3' },
      { name: 'Messages', tokens: 11247, color: '#4' },
      { name: 'Free space', tokens: 970455, color: '#5' },
    ],
    gridRows: [],
    memoryFiles: [],
    mcpTools: [],
    ...overrides,
  } as SDKControlGetContextUsageResponse;
}

describe('mapSdkContextUsage', () => {
  it('keeps totals and active categories, drops deferred + free space', () => {
    const result = mapSdkContextUsage(sdkResponse());
    expect(result.totalTokens).toBe(28471);
    expect(result.maxTokens).toBe(1000000);
    expect(result.percentage).toBe(3);
    expect(result.model).toBe('claude-opus-4-8');
    expect(result.categories.map((c) => c.name)).toEqual(['System tools', 'Skills', 'Messages']);
  });

  it('maps name/tokens and assigns a CSS color (not the SDK theme token)', () => {
    const result = mapSdkContextUsage(sdkResponse());
    expect(result.categories[0].name).toBe('System tools');
    expect(result.categories[0].tokens).toBe(2685);
    // SDK colors are theme tokens (e.g. "#1" stand-in / "warning"); we reassign CSS.
    expect(result.categories[0].color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('fetchContextBreakdown', () => {
  it('returns the mapped breakdown from the query', async () => {
    const query = { getContextUsage: vi.fn().mockResolvedValue(sdkResponse()) } as unknown as Query;
    const result = await fetchContextBreakdown(query, 1000);
    expect(result.totalTokens).toBe(28471);
    expect(result.categories.some((c) => c.name === 'Free space')).toBe(false);
  });

  it('rejects when the control response does not arrive within the timeout', async () => {
    const query = {
      getContextUsage: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    } as unknown as Query;
    await expect(fetchContextBreakdown(query, 20)).rejects.toThrow(/timed out/);
  });
});
