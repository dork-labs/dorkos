import { describe, it, expect, vi } from 'vitest';
import {
  mapSdkUsageResponse,
  mapSdkUsageWindows,
  fetchSubscriptionUsage,
} from '../subscription-usage.js';
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
    expect(usage.status?.kind).toBe('subscription');
    expect(usage.status?.utilization).toBe(0.34);
    expect(usage.subscriptionType).toBe('max');
    expect(usage.observations.map((o) => o.key)).toEqual(['five_hour', 'seven_day']);
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

describe('mapSdkUsageWindows (spec claude-account-fleet D2, the sdk_usage row)', () => {
  const now = new Date('2026-07-10T16:00:00.000Z');

  it('maps every present window by its SDK key, 0-100 as given, status null', () => {
    const observations = mapSdkUsageWindows(
      sdkResponse({
        rate_limits: {
          five_hour: { utilization: 34, resets_at: '2026-07-10T18:00:00.000Z' },
          seven_day: { utilization: 12, resets_at: null },
          seven_day_oauth_apps: { utilization: 3, resets_at: null },
          seven_day_opus: { utilization: 50, resets_at: null },
          seven_day_sonnet: null,
        },
      } as Partial<SDKControlGetUsageResponse>),
      now
    );
    expect(observations).toEqual([
      {
        key: 'five_hour',
        usedPct: 34,
        resetsAt: '2026-07-10T18:00:00.000Z',
        status: null,
        observedAt: now.toISOString(),
        source: 'sdk_usage',
      },
      expect.objectContaining({ key: 'seven_day', usedPct: 12, resetsAt: null }),
      expect.objectContaining({ key: 'seven_day_oauth_apps', usedPct: 3 }),
      expect.objectContaining({ key: 'seven_day_opus', usedPct: 50 }),
    ]);
  });

  it('maps each model_scoped bucket under model:<slug>, skipping a name that slugs to nothing', () => {
    const observations = mapSdkUsageWindows(
      sdkResponse({
        rate_limits: {
          model_scoped: [
            { display_name: 'Fable', utilization: 71, resets_at: '2026-07-14T00:00:00.000Z' },
            { display_name: '!!!', utilization: 5, resets_at: null },
          ],
        },
      } as Partial<SDKControlGetUsageResponse>),
      now
    );
    expect(observations).toEqual([
      expect.objectContaining({ key: 'model:fable', usedPct: 71, source: 'sdk_usage' }),
    ]);
  });

  it('skips a window with no utilization', () => {
    const observations = mapSdkUsageWindows(
      sdkResponse({
        rate_limits: { five_hour: { utilization: null, resets_at: null } },
      } as Partial<SDKControlGetUsageResponse>),
      now
    );
    expect(observations).toEqual([]);
  });

  it('maps nothing when plan rate limits do not apply', () => {
    expect(
      mapSdkUsageWindows(sdkResponse({ rate_limits_available: false, rate_limits: null }), now)
    ).toEqual([]);
  });
});
