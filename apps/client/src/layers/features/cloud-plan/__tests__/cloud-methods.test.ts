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

  it('hands over the person-only refusal of a deletion as its own sentence', async () => {
    const message = 'Only you can delete your DorkOS account, from the DorkOS app while signed in.';
    stubFetch(403, { ok: false, code: 'person_only', message });
    await expect(methods.requestCloudAccountDeletion()).resolves.toEqual({ ok: false, message });
  });

  // Every DorkOS account write refuses anyone but the install's owner with a
  // 403 sentence (DOR-2652); each must reach the surface as that sentence, not
  // as "couldn't reach your account".
  it.each([
    ['opening billing', () => methods.createCloudBillingSession('portal')],
    ['an export', () => methods.requestCloudAccountExport()],
    ['a seat change', () => methods.releaseCloudSeat('seat_0001')],
    [
      'starting a space',
      () => methods.startHostedCommunity({ idempotencyKey: 'k1', name: 'Team' }),
    ],
    ['a claim link', () => methods.getHostedCommunityClaimLink('c_1')],
    ['keeping a space', () => methods.keepHostedCommunity('c_1', [])],
    ['reopening a space', () => methods.restoreHostedCommunity('c_1')],
    ['cancelling a move', () => methods.cancelHostedCommunityMove('move_1')],
    ['resending a move', () => methods.retryHostedCommunityMoveUpload('move_1')],
  ])('hands over the owner-only refusal of %s as its own sentence', async (_name, call) => {
    const message = 'Only the person who owns this install can do that.';
    stubFetch(403, { ok: false, code: 'owner_only', message });
    await expect(call()).resolves.toEqual({ ok: false, message });
  });

  it('still throws a deletion failure that carries no sentence', async () => {
    stubFetch(500, { error: 'boom' });
    await expect(methods.requestCloudAccountDeletion()).rejects.toThrow('boom');
  });

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
