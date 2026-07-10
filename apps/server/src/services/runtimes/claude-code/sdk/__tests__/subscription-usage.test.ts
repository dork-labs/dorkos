import { describe, it, expect, vi } from 'vitest';
import { mapSdkUsageResponse, fetchSubscriptionUsage } from '../subscription-usage.js';
import type { Query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';

function sdkResponse(
  overrides: Partial<SDKControlGetUsageResponse> = {}
): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 1.23,
      total_api_duration_ms: 1000,
      total_duration_ms: 2000,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 34, resets_at: '2026-07-10T18:00:00.000Z' },
      seven_day: { utilization: 12, resets_at: '2026-07-14T00:00:00.000Z' },
    },
    behaviors: null,
    ...overrides,
  } as SDKControlGetUsageResponse;
}

describe('mapSdkUsageResponse', () => {
  it('maps the highest-utilization window to a subscription UsageStatus', () => {
    const usage = mapSdkUsageResponse(sdkResponse());
    expect(usage).toEqual({
      kind: 'subscription',
      utilization: 0.34,
      windowLabel: '5-hour window',
      resetsAt: '2026-07-10T18:00:00.000Z',
    });
  });

  it('picks the binding (max) window across all reported windows', () => {
    const usage = mapSdkUsageResponse(
      sdkResponse({
        rate_limits: {
          five_hour: { utilization: 10, resets_at: null },
          seven_day: { utilization: 55, resets_at: '2026-07-14T00:00:00.000Z' },
          seven_day_opus: { utilization: 41, resets_at: null },
        },
      } as Partial<SDKControlGetUsageResponse>)
    );
    expect(usage?.windowLabel).toBe('7-day window');
    expect(usage?.utilization).toBe(0.55);
  });

  it('marks a fully-consumed window as exhausted', () => {
    const usage = mapSdkUsageResponse(
      sdkResponse({
        rate_limits: { five_hour: { utilization: 100, resets_at: null } },
      } as Partial<SDKControlGetUsageResponse>)
    );
    expect(usage?.state).toBe('exhausted');
    // No resets_at → the field is absent, not null.
    expect(usage).not.toHaveProperty('resetsAt');
  });

  it('returns undefined for API-key sessions (rate limits unavailable)', () => {
    expect(
      mapSdkUsageResponse(
        sdkResponse({ subscription_type: null, rate_limits_available: false, rate_limits: null })
      )
    ).toBeUndefined();
  });

  it('returns undefined when no window reports a utilization', () => {
    expect(
      mapSdkUsageResponse(
        sdkResponse({
          rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: null },
        } as Partial<SDKControlGetUsageResponse>)
      )
    ).toBeUndefined();
  });
});

describe('fetchSubscriptionUsage', () => {
  it('returns the mapped usage from the query', async () => {
    const query = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi
        .fn()
        .mockResolvedValue(sdkResponse()),
    } as unknown as Query;
    const usage = await fetchSubscriptionUsage(query, 1000);
    expect(usage?.kind).toBe('subscription');
    expect(usage?.utilization).toBe(0.34);
  });

  it('rejects when the control response does not arrive within the timeout', async () => {
    const query = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi
        .fn()
        .mockReturnValue(new Promise(() => {})), // never resolves
    } as unknown as Query;
    await expect(fetchSubscriptionUsage(query, 20)).rejects.toThrow(/timed out/);
  });
});
