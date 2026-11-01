import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALLER_ADDRESS_HEADER } from '../caller-address.js';
import {
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  TENANCY_PASSWORD,
  type TenancyHarness,
} from './tenancy-test-harness.js';

// DOR-2846: Better Auth keys its sign-in limits and each session's recorded address (takedown
// evidence) by the caller's address. These sign in over real HTTP and read the address the
// session row kept, so they prove the header the app writes is the one Better Auth reads.
const EMAIL = 'owner@caller-address.test';
let h: TenancyHarness;

beforeAll(async () => {
  h = await startTenancyHarness('caller_address');
  await bootstrapHost(h, 'Owner', EMAIL);
});

afterAll(async () => {
  await h?.close();
});

async function signInAddress(headers: Record<string, string>): Promise<string | null> {
  const response = await expectStatus(
    await h.call('/api/auth/sign-in/email', {
      body: { email: EMAIL, password: TENANCY_PASSWORD },
      headers,
    }),
    200,
    'sign in'
  );
  const { token } = (await response.json()) as { token: string };
  const row = await h.pool.query<{ ipAddress: string | null }>(
    'SELECT "ipAddress" FROM session WHERE token=$1',
    [token]
  );
  return row.rows[0]?.ipAddress ?? null;
}

describe('the address a sign-in counts against', () => {
  it('is the socket peer when no proxy is configured, whatever headers the caller sends', async () => {
    // Fails if X-Forwarded-For, or a caller's own copy of the private header, reaches Better
    // Auth: anyone with no proxy in front could pick a fresh sign-in bucket per request.
    const address = await signInAddress({
      'x-forwarded-for': '203.0.113.9',
      [CALLER_ADDRESS_HEADER]: '203.0.113.10',
    });
    expect(address).toMatch(/127\.0\.0\.1$/);
  });

  it('is the last entry of the trusted proxy header when one is configured', async () => {
    // Fails if the proxy's own address (what the proxy appends) is not the one recorded.
    h.config.trustedProxyHeader = 'fly-client-ip';
    try {
      const address = await signInAddress({
        'fly-client-ip': '203.0.113.9, 198.51.100.4',
        'x-forwarded-for': '203.0.113.11',
      });
      expect(address).toBe('198.51.100.4');
    } finally {
      h.config.trustedProxyHeader = undefined;
    }
  });
});
