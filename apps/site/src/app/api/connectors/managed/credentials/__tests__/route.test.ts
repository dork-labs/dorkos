/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), complete: vi.fn(), available: vi.fn() }));
vi.mock('@/db/transaction-client', () => ({ getTransactionDb: () => ({ kind: 'synthetic-db' }) }));
vi.mock('@/lib/auth', () => ({ getAuth: () => ({ api: { getSession: mocks.getSession } }) }));
vi.mock('@/lib/connectors/managed/config', () => ({
  readManagedConnectorConfig: () => ({ callbackOrigin: 'https://dorkos.test' }),
  managedCapabilityAvailability: mocks.available,
}));
vi.mock('@/lib/connectors/managed/authentication-owner-service', () => ({
  createManagedAuthenticationOwnerService: () => ({ completeFields: mocks.complete }),
}));
import { POST } from '../route';
const SECRET = 'SYNTHETIC-KEY-NOT-IN-OUTPUT';
function request(
  headers: Record<string, string> = {},
  body: BodyInit = JSON.stringify({
    csrfToken: 'csrf',
    descriptorDigest: 'a'.repeat(64),
    fields: { api_key: SECRET },
  })
) {
  return new Request('https://dorkos.test/api/connectors/managed/credentials', {
    method: 'POST',
    headers: {
      origin: 'https://dorkos.test',
      'content-type': 'application/json',
      cookie: 'dorkos_managed_account_fields=opaque-flow',
      ...headers,
    },
    body,
    duplex: 'half',
  } as RequestInit);
}
describe('hosted credential completion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: 'owner-a' } });
    mocks.available.mockReturnValue({ status: 'available' });
    mocks.complete.mockResolvedValue({ connectionId: 'managed-exact' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('uses only the signed-in owner, clears the fields cookie and returns no credential values', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connectionId: 'managed-exact' });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-a',
        expectedOrigin: 'https://dorkos.test',
        requestOrigin: 'https://dorkos.test',
        cookieValue: 'opaque-flow',
        fields: { api_key: SECRET },
      })
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain(
      'dorkos_managed_account_fields=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
    );
  });
  it.each(['owner', 'origin', 'duplicate-cookie', 'availability', 'encoding'] as const)(
    'refuses %s before reading fields',
    async (kind) => {
      let reads = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads += 1;
            controller.enqueue(new TextEncoder().encode('{}'));
            controller.close();
          },
        },
        { highWaterMark: 0 }
      );
      const headers: Record<string, string> = {};
      if (kind === 'owner') mocks.getSession.mockResolvedValue(null);
      if (kind === 'origin') headers.origin = 'https://foreign.test';
      if (kind === 'duplicate-cookie')
        headers.cookie = 'dorkos_managed_account_fields=one; dorkos_managed_account_fields=two';
      if (kind === 'availability') mocks.available.mockReturnValue({ status: 'unavailable' });
      if (kind === 'encoding') headers['content-encoding'] = 'gzip';
      const response = await POST(request(headers, body));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(reads).toBe(0);
      expect(mocks.complete).not.toHaveBeenCalled();
    }
  );
  it('bounds both declared and actually streamed bytes without trusting content-length', async () => {
    let reads = 0;
    const unopened = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1;
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    expect((await POST(request({ 'content-length': '1000000' }, unopened))).status).toBe(400);
    expect(reads).toBe(0);
    let cancelled = false;
    let chunks = 0;
    const oversized = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunks++ === 0)
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  csrfToken: 'csrf',
                  descriptorDigest: 'a'.repeat(64),
                  fields: { api_key: 'a'.repeat(73 * 1024) },
                })
              )
            );
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    expect((await POST(request({ 'content-length': '1' }, oversized))).status).toBe(400);
    expect(cancelled).toBe(true);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('cancels an aborted pending body and never retries the service or prints an error body', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          controller.abort();
        },
      },
      { highWaterMark: 0 }
    );
    const req = new Request(request({}, stream), { signal: controller.signal });
    expect((await POST(req)).status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.complete.mockRejectedValue(new Error(SECRET));
    const failed = await POST(request());
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(SECRET);
    expect(log).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it('rejects authority selectors and malformed input without reflecting the body', async () => {
    const response = await POST(
      request(
        {},
        JSON.stringify({
          ownerId: 'foreign',
          csrfToken: 'csrf',
          descriptorDigest: 'a'.repeat(64),
          fields: { api_key: SECRET },
        })
      )
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(SECRET);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
