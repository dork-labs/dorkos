import type { APIRequestContext } from '@playwright/test';
import { expect } from '../../fixtures';

/** What choosing Trusted moves besides the permissions themselves. */
export interface PowerSnapshot {
  trustStop: string | null;
}

/**
 * Read the global Files & commands stop, so a spec that chooses Trusted can
 * put it back for the specs after it on the same leg. `GET /api/config`
 * surfaces the stop as `executionDefaults.trustStop`.
 *
 * @param request - The leg's API context.
 */
export async function readPower(request: APIRequestContext): Promise<PowerSnapshot> {
  const res = await request.get('/api/config');
  expect(res.ok()).toBe(true);
  const config = (await res.json()) as {
    executionDefaults?: { trustStop?: string | null };
  };
  return { trustStop: config.executionDefaults?.trustStop ?? null };
}

/**
 * Choose Trusted, the preset every install runs on unless a person picked
 * Careful (ADR 261006-225605). Trusted moves Files & commands to Full autonomy.
 *
 * @param request - The leg's API context.
 */
export async function chooseTrusted(request: APIRequestContext): Promise<void> {
  const res = await request.put('/api/permissions/preset', {
    data: { preset: 'trusted', surface: 'api' },
  });
  expect(res.ok()).toBe(true);
}

/**
 * Put the stop back the way {@link readPower} found it.
 *
 * @param request - The leg's API context.
 * @param prior - What {@link readPower} read before the spec ran.
 */
export async function restorePower(
  request: APIRequestContext,
  prior: PowerSnapshot
): Promise<void> {
  await request.patch('/api/config', {
    data: { runtimes: { defaultTrustStop: prior.trustStop } },
  });
}
