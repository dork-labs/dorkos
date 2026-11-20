/**
 * Wi-Fi sign-in requests and their one-time codes
 * (`sessions/wifi-sign-in-requests.ts`, DOR-4744).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  approveWifiSignIn,
  declineWifiSignIn,
  listWifiSignInRequests,
  MAX_MISSES_PER_REQUEST,
  MAX_MISSES_PER_WINDOW,
  MAX_OPEN_REQUESTS,
  MAX_STARTS_PER_ADDRESS,
  redeemWifiSignIn,
  resetWifiSignInForTests,
  startWifiSignIn,
  WIFI_SIGN_IN_CODE_TTL_MS,
  WIFI_SIGN_IN_REQUEST_TTL_MS,
} from '../sessions/wifi-sign-in-requests.js';

const NOW = 1_800_000_000_000;
const PHONE = { deviceName: 'Safari on iPhone', address: '192.168.1.31' };

/** Start a request from `address` and approve it; returns the secret and the code. */
function approved(address = PHONE.address, now = NOW) {
  const started = startWifiSignIn({ ...PHONE, address }, now)!;
  const view = listWifiSignInRequests(now).find((r) => !r.approved)!;
  const { code } = approveWifiSignIn(view.id, 'owner-1', now)!;
  return { requestId: started.requestId, code, viewId: view.id };
}

beforeEach(() => resetWifiSignInForTests());

describe('a request', () => {
  it('shows the desk the device and when it asked, never its secret', () => {
    const started = startWifiSignIn(PHONE, NOW)!;
    const [view] = listWifiSignInRequests(NOW);
    expect(view).toMatchObject({
      deviceName: 'Safari on iPhone',
      address: '192.168.1.31',
      approved: false,
    });
    expect(JSON.stringify(view)).not.toContain(started.requestId);
    expect(Buffer.from(started.requestId, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(Buffer.from(view!.id, 'base64url').length).toBeGreaterThanOrEqual(16);
  });

  it('ends after 5 minutes unapproved', () => {
    startWifiSignIn(PHONE, NOW);
    expect(listWifiSignInRequests(NOW + WIFI_SIGN_IN_REQUEST_TTL_MS)).toHaveLength(0);
  });

  it('is approved once', () => {
    const { viewId } = approved();
    expect(approveWifiSignIn(viewId, 'owner-1', NOW)).toBeNull();
  });

  it('can be declined, and then no code signs it in', () => {
    const { requestId, code, viewId } = approved();
    expect(declineWifiSignIn(viewId)).toBe(true);
    expect(redeemWifiSignIn(requestId, code, NOW)).toEqual({ refusal: 'refused' });
  });

  it('limits how many are open and how many one address starts', () => {
    for (let i = 0; i < MAX_OPEN_REQUESTS; i += 1) {
      expect(startWifiSignIn({ ...PHONE, address: `10.0.0.${i}` }, NOW)).not.toBeNull();
    }
    expect(startWifiSignIn({ ...PHONE, address: '10.0.0.99' }, NOW)).toBeNull();
    resetWifiSignInForTests();
    for (let i = 0; i < MAX_STARTS_PER_ADDRESS; i += 1) {
      const started = startWifiSignIn(PHONE, NOW)!;
      declineWifiSignIn(listWifiSignInRequests(NOW)[0]!.id);
      expect(started).not.toBeNull();
    }
    expect(startWifiSignIn(PHONE, NOW)).toBeNull();
  });
});

describe('a code', () => {
  it('signs in its own request once', () => {
    const { requestId, code } = approved();
    expect(redeemWifiSignIn(requestId, code.toLowerCase(), NOW)).toEqual({ userId: 'owner-1' });
    expect(redeemWifiSignIn(requestId, code, NOW)).toEqual({ refusal: 'refused' });
  });

  it('never signs in another request', () => {
    const mine = approved('10.0.0.1');
    const other = startWifiSignIn({ ...PHONE, address: '10.0.0.2' }, NOW)!;
    expect(redeemWifiSignIn(other.requestId, mine.code, NOW)).toEqual({ refusal: 'refused' });
  });

  it('typed for another request, it ends the request it was made for too', () => {
    const a = approved('10.0.0.1');
    const b = startWifiSignIn({ ...PHONE, address: '10.0.0.2' }, NOW)!;
    expect(redeemWifiSignIn(b.requestId, a.code, NOW)).toEqual({ refusal: 'refused' });
    expect(redeemWifiSignIn(a.requestId, a.code, NOW)).toEqual({ refusal: 'refused' });
    expect(listWifiSignInRequests(NOW).some((r) => r.id === a.viewId)).toBe(false);
  });

  it('shows the device and the desk the same short match code', () => {
    const started = startWifiSignIn(PHONE, NOW)!;
    const [view] = listWifiSignInRequests(NOW);
    expect(started.matchCode).toHaveLength(4);
    expect(view!.matchCode).toBe(started.matchCode);
  });

  it('stops working after 5 minutes', () => {
    const { requestId, code } = approved();
    expect(redeemWifiSignIn(requestId, code, NOW + WIFI_SIGN_IN_CODE_TTL_MS)).toEqual({
      refusal: 'refused',
    });
  });

  it('never outlives its request', () => {
    const started = startWifiSignIn(PHONE, NOW)!;
    const view = listWifiSignInRequests(NOW)[0]!;
    const late = NOW + WIFI_SIGN_IN_REQUEST_TTL_MS - 1000;
    const { code, expiresAt } = approveWifiSignIn(view.id, 'owner-1', late)!;
    expect(Date.parse(expiresAt)).toBe(NOW + WIFI_SIGN_IN_REQUEST_TTL_MS);
    expect(redeemWifiSignIn(started.requestId, code, late + 1000)).toEqual({ refusal: 'refused' });
  });

  it('a request survives a few wrong codes, then ends', () => {
    const { requestId, code } = approved();
    for (let i = 1; i < MAX_MISSES_PER_REQUEST; i += 1) {
      expect(redeemWifiSignIn(requestId, 'WRONGONE', NOW)).toEqual({ refusal: 'refused' });
    }
    expect(redeemWifiSignIn(requestId, 'WRONGONE', NOW)).toEqual({ refusal: 'too-many-tries' });
    expect(redeemWifiSignIn(requestId, code, NOW)).toEqual({ refusal: 'refused' });
  });

  it('the listener stops taking codes after too many wrong ones', () => {
    for (let i = 0; i < MAX_MISSES_PER_WINDOW; i += 1) redeemWifiSignIn('nope', 'WRONGONE', NOW);
    const { requestId, code } = approved('10.0.0.9');
    expect(redeemWifiSignIn(requestId, code, NOW)).toEqual({ refusal: 'too-many-tries' });
  });
});
