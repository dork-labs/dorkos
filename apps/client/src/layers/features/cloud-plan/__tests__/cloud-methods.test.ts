/**
 * The transport methods against a stubbed `fetch` — the seam the component
 * tests cannot cross.
 *
 * A component test mocks the whole transport, so it proves the UI renders a
 * refusal it was HANDED. It cannot prove the transport ever hands one over, and
 * that is exactly where this feature's headline affordance was broken: the
 * server answered a refusal with a 403, `fetchJSON` throws on every non-2xx, and
 * the envelope carrying the service's words never reached the surface at all
 * while every mocked test stayed green.
 *
 * So this file drives the real `createCloudMethods` over a stubbed `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import seatRequiredFixture from '@dork-labs/cloud-api/fixtures/v1/problem/person-seat-required.json' with { type: 'json' };
import { createCloudMethods } from '@/layers/shared/lib/transport/cloud-methods';

/** A `fetch` that answers one canned response and records what it was asked. */
function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const methods = createCloudMethods('http://localhost:4242/api');

describe('the cloud transport methods', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('delivers a seat refusal to the caller instead of throwing it away', async () => {
    stubFetch(200, { ok: false, problem: seatRequiredFixture });
    const result = await methods.releaseCloudSeat('seat_0001');
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('problem');
    if (!result.ok && 'problem' in result) {
      expect(result.problem.title).toBe(seatRequiredFixture.title);
      expect(result.problem.requiredPlanDisplayName).toBe(
        seatRequiredFixture.requiredPlanDisplayName
      );
      // The service's status rides inside the envelope rather than on the
      // response, which is what keeps it reachable at all.
      expect(result.problem.status).toBe(403);
    }
  });

  it('sends the subject an assignment is for, and percent-encodes the seat id', async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await methods.assignCloudSeat('seat/0001', { kind: 'user', id: 'acct_0001' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBeTruthy();
    expect(url).toContain('/cloud/seats/seat%2F0001/assign');
    expect(JSON.parse(init.body as string)).toEqual({
      subject: { kind: 'user', id: 'acct_0001' },
    });
  });

  it('asks for the grouping the caller named', async () => {
    const fetchMock = stubFetch(200, { available: false });
    await methods.getCloudUsage('model');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('groupBy=model');
  });
});
