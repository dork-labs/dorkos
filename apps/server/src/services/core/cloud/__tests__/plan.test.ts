/**
 * The plan reads, exercised against the contract package's own conformance
 * fixtures and a stubbed `fetch`.
 *
 * Fixtures rather than hand-written payloads on purpose: they are the same
 * bytes `@dork-labs/cloud-api` validates its schemas against, and every value in
 * them is synthetic — opaque identifiers and placeholder display strings — so a
 * test here cannot become the place a catalog value gets written down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import balanceFixture from '@dork-labs/cloud-api/fixtures/v1/billing/balance.json' with { type: 'json' };
import entitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-free.json' with { type: 'json' };
import usageFixture from '@dork-labs/cloud-api/fixtures/v1/billing/usage-by-model.json' with { type: 'json' };
import nudgeFixture from '@dork-labs/cloud-api/fixtures/v1/billing/nudge.json' with { type: 'json' };
import seatFixture from '@dork-labs/cloud-api/fixtures/v1/seats/seat.json' with { type: 'json' };
import seatRequiredFixture from '@dork-labs/cloud-api/fixtures/v1/problem/person-seat-required.json' with { type: 'json' };

const config = vi.hoisted(() => ({ cloud: { instanceToken: 'tok_test' } as unknown }));
vi.mock('../../config-manager.js', () => ({
  configManager: { get: (section: string) => (section === 'cloud' ? config.cloud : undefined) },
}));

const { assignSeat, listSeats, readNudge, readPlanOverview, readUsage } =
  await import('../plan.js');
const { isCloudLinked, problemOf } = await import('../v1-client.js');

/** Route a stubbed `fetch` by `/v1` path, answering with a status and a body. */
function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const hit = routes[path];
    if (!hit) throw new Error(`unexpected request: ${path}`);
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the plan reads', () => {
  beforeEach(() => {
    config.cloud = { instanceToken: 'tok_test' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads entitlements and the balance beside them', async () => {
    stubFetch({
      '/v1/entitlements': { status: 200, body: entitlementsFixture },
      '/v1/balance': { status: 200, body: balanceFixture },
    });
    const overview = await readPlanOverview();
    expect(overview?.entitlements.planDisplayName).toBe(entitlementsFixture.planDisplayName);
    expect(overview?.entitlements.limits.remoteAccess).toBe('byo');
    expect(overview?.balance?.allowance.remainingMicro).toBe('1250000');
  });

  it('keeps an entitlement whose balance the service does not serve', async () => {
    stubFetch({
      '/v1/entitlements': { status: 200, body: entitlementsFixture },
      '/v1/balance': { status: 404, body: { code: 'not_found', status: 404, title: 'No balance' } },
    });
    const overview = await readPlanOverview();
    expect(overview?.entitlements.planId).toBe(entitlementsFixture.planId);
    expect(overview?.balance).toBeNull();
  });

  it('answers null for every read when the instance is not linked, without a request', async () => {
    config.cloud = { instanceToken: null };
    const fetchMock = stubFetch({});
    expect(isCloudLinked()).toBe(false);
    await expect(readPlanOverview()).resolves.toBeNull();
    await expect(readUsage('seat')).resolves.toBeNull();
    await expect(readNudge()).resolves.toBeNull();
    await expect(listSeats('org_0001')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for the window it was told to group by, and passes rows through', async () => {
    const fetchMock = stubFetch({ '/v1/usage': { status: 200, body: usageFixture } });
    const usage = await readUsage('seat');
    expect(usage?.rows[0]?.displayName).toBe(usageFixture.rows[0].displayName);
    expect(usage?.rows[0]?.dorkosPriceMicro).toBe('4620');
    const asked = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(asked.searchParams.get('groupBy')).toBe('seat');
    expect(asked.searchParams.get('from')).toBeTruthy();
  });

  it('reads the nudge as the service reduced it', async () => {
    stubFetch({ '/v1/nudge': { status: 200, body: nudgeFixture } });
    const nudge = await readNudge();
    expect(nudge?.savingMicro).toBe(nudgeFixture.savingMicro);
    expect(nudge?.suggestedPlanDisplayName).toBe(nudgeFixture.suggestedPlanDisplayName);
    expect(nudge?.dismissible).toBe(true);
  });

  it('treats an absent nudge route as no nudge rather than a fault', async () => {
    stubFetch({
      '/v1/nudge': { status: 404, body: { code: 'not_found', status: 404, title: 'Off' } },
    });
    await expect(readNudge()).resolves.toBeNull();
  });

  it('lists an organization`s seats', async () => {
    stubFetch({
      '/v1/orgs/org_0001/seats': { status: 200, body: { items: [seatFixture], nextCursor: null } },
    });
    const seats = await listSeats('org_0001');
    expect(seats?.[0]?.id).toBe('seat_0001');
    expect(seats?.[0]?.address?.handle).toBe('owl');
  });

  it('surfaces a refusal a plan change would lift as the service worded it', async () => {
    stubFetch({
      '/v1/seats/seat_0001/assign': { status: 403, body: seatRequiredFixture },
    });
    const error = await assignSeat('seat_0001', { kind: 'user', id: 'acct_0001' }).catch((e) => e);
    const problem = problemOf(error);
    expect(problem?.code).toBe('person_seat_required');
    expect(problem?.requiredPlanDisplayName).toBe(seatRequiredFixture.requiredPlanDisplayName);
    expect(problem?.title).toBe(seatRequiredFixture.title);
  });

  it('refuses a seat write outright when the instance is not linked', async () => {
    config.cloud = { instanceToken: null };
    stubFetch({});
    await expect(assignSeat('seat_0001', { kind: 'user', id: 'acct_0001' })).rejects.toThrow(
      /not linked/i
    );
  });
});
