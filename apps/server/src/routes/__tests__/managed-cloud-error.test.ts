import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  ManagedConnectorCloudError,
  type ManagedConnectorCloudErrorCode,
} from '../../services/core/auth/cloud-link-client.js';
import { sendManagedCloudError } from '../managed-cloud-error.js';

function fakeResponse() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('sendManagedCloudError', () => {
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

  it.each(cases)('answers %s with %i %s', (code, status, routeCode) => {
    const res = fakeResponse();
    const handled = sendManagedCloudError(
      res as unknown as Response,
      new ManagedConnectorCloudError(code, { status: 500, reason: 'PRIVATE_REASON' })
    );
    expect(handled).toBe(true);
    expect(res.status).toHaveBeenCalledWith(status);
    const body = res.json.mock.calls[0][0] as { error: string; code: string };
    expect(body.code).toBe(routeCode);
    expect(body.error.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_REASON');
  });

  it('leaves any other error to the caller and touches nothing', () => {
    const res = fakeResponse();
    expect(sendManagedCloudError(res as unknown as Response, new Error('other'))).toBe(false);
    expect(sendManagedCloudError(res as unknown as Response, undefined)).toBe(false);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
