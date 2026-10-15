import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  ManagedConnectorCloudError,
  type ManagedConnectorCloudErrorCode,
} from '../../services/core/auth/cloud-link-client.js';
import { managedCloudErrorResponse } from '../managed-cloud-error.js';

/** Answer one request with whatever the helper makes of `error`, or a 418 when it declines. */
async function answerFor(error: unknown): Promise<globalThis.Response> {
  const app = new Hono();
  app.get('/', (c) => managedCloudErrorResponse(c, error) ?? c.body(null, 418));
  return app.request('/');
}

describe('managedCloudErrorResponse', () => {
  const cases: Array<[ManagedConnectorCloudErrorCode, number, string]> = [
    ['unauthorized', 401, 'cloud_link_required'],
    ['permission_upgrade_required', 409, 'cloud_link_needs_update'],
    ['unavailable', 503, 'cloud_unavailable'],
    ['network_error', 503, 'cloud_unavailable'],
    ['request_failed', 502, 'cloud_refused'],
    ['invalid_response', 502, 'cloud_refused'],
    ['not_found', 502, 'cloud_refused'],
    ['conflict', 502, 'cloud_refused'],
  ];

  it.each(cases)('answers %s with %i %s', async (code, status, routeCode) => {
    const res = await answerFor(
      new ManagedConnectorCloudError(code, { status: 500, reason: 'PRIVATE_REASON' })
    );
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe(routeCode);
    expect(body.error.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_REASON');
  });

  it('leaves any other error to the caller and answers nothing', async () => {
    expect((await answerFor(new Error('other'))).status).toBe(418);
    expect((await answerFor(undefined)).status).toBe(418);
  });
});
