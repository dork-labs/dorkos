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
      { name: 'System tools', tokens: 2685, color: '#1', kind: 'used' },
      {
        name: 'MCP tools (deferred)',
        tokens: 35186,
        color: '#2',
        isDeferred: true,
        kind: 'deferred',
      },
      { name: 'Skills', tokens: 14425, color: '#3', kind: 'used' },
      { name: 'Messages', tokens: 11247, color: '#4', kind: 'used' },
      { name: 'Autocompact buffer', tokens: 45000, color: '#6', kind: 'buffer' },
      { name: 'Free space', tokens: 970455, color: '#5', kind: 'free' },
    ],
    gridRows: [],
    memoryFiles: [],
    mcpTools: [],
    ...overrides,
  } as SDKControlGetContextUsageResponse;
}

describe('mapSdkContextUsage', () => {
  it('keeps totals, the occupied rows and the compaction reserve; drops deferred + free space', () => {
    const result = mapSdkContextUsage(sdkResponse());
    expect(result.totalTokens).toBe(28471);
    expect(result.maxTokens).toBe(1000000);
    expect(result.percentage).toBe(3);
    expect(result.model).toBe('claude-opus-4-8');
    expect(result.categories.map((c) => c.name)).toEqual([
      'System tools',
      'Skills',
      'Messages',
      'Autocompact buffer',
    ]);
  });

  it('classifies rows by kind, not by what the CLI happens to call them', () => {
    // The same four rows under names no `name !==` match could have anticipated.
    const renamed = mapSdkContextUsage(
      sdkResponse({
        categories: [
          { name: 'Conversation', tokens: 10, color: '#1', kind: 'used' },
          { name: 'Unused window', tokens: 900, color: '#2', kind: 'free' },
          { name: 'Reserved for compaction', tokens: 50, color: '#3', kind: 'buffer' },
          { name: 'Tools you have not loaded', tokens: 40, color: '#4', kind: 'deferred' },
        ],
      } as Partial<SDKControlGetContextUsageResponse>)
    );

    expect(renamed.categories.map((c) => c.name)).toEqual([
      'Conversation',
      'Reserved for compaction',
    ]);
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

  it('asks for the FULL breakdown rather than the estimated summary', async () => {
    // Measured on a live session at SDK 0.3.268 (see the function's TSDoc):
    // `detail: 'summary'` matches the headline percentage exactly but splits the
    // per-category rows wrongly — it banks what it could not count against system
    // tools — and saves ~1ms a turn for it. DorkOS renders those rows, so the
    // request is pinned here: it must be explicit, and it must be 'full'.
    const getContextUsage = vi.fn().mockResolvedValue(sdkResponse());
    await fetchContextBreakdown({ getContextUsage } as unknown as Query, 1000);
    expect(getContextUsage).toHaveBeenCalledWith({ detail: 'full' });
  });

  it('rejects when the control response does not arrive within the timeout', async () => {
    const query = {
      getContextUsage: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    } as unknown as Query;
    await expect(fetchContextBreakdown(query, 20)).rejects.toThrow(/timed out/);
  });
});
