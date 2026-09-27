/**
 * Bridges the SDK's structured `/usage` control response to the runtime-neutral
 * `UsageStatus` descriptor, so the status bar's Usage & cost item populates on
 * every turn — not only when the SDK happens to push a (rare) `rate_limit_event`
 * (DOR-99).
 *
 * The SDK method is experimental (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_
 * THIS_API_YET`), so this module treats every failure — missing method, shape
 * drift, timeout — as "no data" and lets the existing cost-only path render.
 *
 * @module services/runtimes/claude-code/sdk/subscription-usage
 */
import type { Query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { UsageStatus } from '@dorkos/shared/types';
import { modelWindowKey, type LedgerWindowObservation } from '@dorkos/shared/account-usage';

/** One utilization window from the SDK's `rate_limits` payload. */
interface RateLimitWindow {
  utilization: number | null;
  resets_at: string | null;
}

/**
 * Window labels, keyed by the SDK's `rate_limits` field names. Authored
 * server-side (mirroring the `rate_limit_event` mapper) so every client renders
 * the same string. Windows absent from this map are ignored.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  seven_day_oauth_apps: '7-day OAuth apps',
  seven_day_opus: '7-day Opus',
  seven_day_sonnet: '7-day Sonnet',
};

/**
 * Map the SDK's structured `/usage` response to a runtime-neutral
 * {@link UsageStatus}, or `undefined` when plan rate limits do not apply
 * (API key, Bedrock, Vertex) or no window reports a utilization.
 *
 * Of the windows present, the one with the HIGHEST utilization wins — it is the
 * binding constraint, so it is the truthful single number for the status item.
 * The SDK reports utilization as a 0-100 percentage; `UsageStatus` carries a
 * 0..1 fraction.
 *
 * @param response - The SDK's structured `/usage` control response.
 */
export function mapSdkUsageResponse(response: SDKControlGetUsageResponse): UsageStatus | undefined {
  if (!response.rate_limits_available || !response.rate_limits) return undefined;

  let binding: { label: string; window: RateLimitWindow } | null = null;
  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    const window = (response.rate_limits as Record<string, RateLimitWindow | null | undefined>)[
      key
    ];
    if (!window || window.utilization === null || window.utilization === undefined) continue;
    if (!binding || window.utilization > binding.window.utilization!) {
      binding = { label, window };
    }
  }
  if (!binding) return undefined;

  const utilization = binding.window.utilization! / 100;
  return {
    kind: 'subscription',
    utilization,
    windowLabel: binding.label,
    ...(binding.window.resets_at ? { resetsAt: binding.window.resets_at } : {}),
    ...(utilization >= 1 ? { state: 'exhausted' as const } : {}),
  };
}

/** The SDK `rate_limits` windows recorded account-wide, by their SDK key. */
const LEDGER_WINDOW_KEYS = [
  'five_hour',
  'seven_day',
  'seven_day_oauth_apps',
  'seven_day_opus',
  'seven_day_sonnet',
] as const;

/**
 * Map the SDK's structured `/usage` response to usage-ledger readings (shared
 * contract §1.2, the `sdk_usage` row): every present `rate_limits` window under
 * its SDK key, and each `model_scoped[]` bucket under
 * {@link modelWindowKey}(`display_name`). `usedPct` is the SDK's 0-100 figure
 * as given, `status` is null, and a window with no utilization is skipped (an
 * entry needs a percentage or a status). `rate_limits_available: false` maps to
 * nothing.
 *
 * @param response - The SDK's structured `/usage` control response.
 * @param now - When the reading was taken.
 */
export function mapSdkUsageWindows(
  response: SDKControlGetUsageResponse,
  now: Date
): LedgerWindowObservation[] {
  if (!response.rate_limits_available || !response.rate_limits) return [];
  const limits = response.rate_limits;
  const observedAt = now.toISOString();
  const out: LedgerWindowObservation[] = [];
  const push = (key: string | null, window: RateLimitWindow | null | undefined) => {
    if (key === null || !window) return;
    if (typeof window.utilization !== 'number') return;
    out.push({
      key,
      usedPct: window.utilization,
      resetsAt: window.resets_at ?? null,
      status: null,
      observedAt,
      source: 'sdk_usage',
    });
  };
  for (const key of LEDGER_WINDOW_KEYS) push(key, limits[key]);
  for (const bucket of limits.model_scoped ?? []) {
    push(modelWindowKey(bucket.display_name), bucket);
  }
  return out;
}

/** One usage call's answer: the session's binding window, and the account's readings. */
export interface SubscriptionUsageReading {
  /** The binding window for the session's status item, or `undefined` with no plan limits. */
  status: UsageStatus | undefined;
  /** Every window as a usage-ledger reading ({@link mapSdkUsageWindows}). */
  observations: LedgerWindowObservation[];
  /** The plan the SDK reported (`pro`, `max`, …), or `null`. */
  subscriptionType: string | null;
}

/**
 * Fetch the current subscription utilization from a live query, bounded by a
 * timeout so a stuck control channel can never hang the stream. Must be called
 * while the subprocess is still alive (i.e. before the prompt's input stream is
 * closed). A non-subscription session answers with no `status` and no
 * observations.
 *
 * @param query - The active SDK query.
 * @param timeoutMs - Max time to wait for the control response.
 */
export async function fetchSubscriptionUsage(
  query: Pick<Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'>,
  timeoutMs: number
): Promise<SubscriptionUsageReading> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('get_usage timed out')), timeoutMs);
      }),
    ]);
    return {
      status: mapSdkUsageResponse(response),
      observations: mapSdkUsageWindows(response, new Date()),
      subscriptionType: response.subscription_type ?? null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
