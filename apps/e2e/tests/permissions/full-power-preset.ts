import type { APIRequestContext } from '@playwright/test';
import { expect } from '../../fixtures';

/** What choosing Full power moves besides the permissions themselves. */
export interface PowerSnapshot {
  trustStop: string | null;
  autonomyAcknowledgedAt: string | null;
}

/**
 * Read the global Files & commands stop and the autonomy acknowledgement, so a
 * spec that chooses Full power can put both back for the specs after it on the
 * same leg. `GET /api/config` surfaces the stop as `executionDefaults.trustStop`.
 *
 * @param request - The leg's API context.
 */
export async function readPower(request: APIRequestContext): Promise<PowerSnapshot> {
  const res = await request.get('/api/config');
  expect(res.ok()).toBe(true);
  const config = (await res.json()) as {
    ui?: { autonomyAcknowledgedAt?: string | null };
    executionDefaults?: { trustStop?: string | null };
  };
  return {
    trustStop: config.executionDefaults?.trustStop ?? null,
    autonomyAcknowledgedAt: config.ui?.autonomyAcknowledgedAt ?? null,
  };
}

/**
 * Choose Full power, as the first-run door leaves an install. Full power moves
 * Files & commands to Full autonomy, which the server refuses without the
 * acknowledgement (spec `agent-permissions` D16), so the yes rides along.
 *
 * @param request - The leg's API context.
 */
export async function chooseFullPower(request: APIRequestContext): Promise<void> {
  const res = await request.put('/api/permissions/preset', {
    data: { preset: 'full', surface: 'api', acknowledgeAutonomy: true },
  });
  expect(res.ok()).toBe(true);
}

/**
 * Put the stop and the acknowledgement back the way {@link readPower} found them.
 *
 * @param request - The leg's API context.
 * @param prior - What {@link readPower} read before the spec ran.
 */
export async function restorePower(
  request: APIRequestContext,
  prior: PowerSnapshot
): Promise<void> {
  await request.patch('/api/config', {
    data: {
      ui: { autonomyAcknowledgedAt: prior.autonomyAcknowledgedAt },
      runtimes: { defaultTrustStop: prior.trustStop },
    },
  });
}
