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
import usageWithOtherChargesFixture from '@dork-labs/cloud-api/fixtures/v1/billing/usage-with-other-charges.json' with { type: 'json' };
import nudgeFixture from '@dork-labs/cloud-api/fixtures/v1/billing/nudge.json' with { type: 'json' };
import denominatedBalanceFixture from '@dork-labs/cloud-api/fixtures/v1/billing/balance-denominated.json' with { type: 'json' };
import denominatedEntitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-denominated.json' with { type: 'json' };
import denominatedUsageFixture from '@dork-labs/cloud-api/fixtures/v1/billing/usage-denominated.json' with { type: 'json' };
import denominatedNudgeFixture from '@dork-labs/cloud-api/fixtures/v1/billing/nudge-denominated.json' with { type: 'json' };
import seatFixture from '@dork-labs/cloud-api/fixtures/v1/seats/seat.json' with { type: 'json' };
import seatRequiredFixture from '@dork-labs/cloud-api/fixtures/v1/problem/person-seat-required.json' with { type: 'json' };

const config = vi.hoisted(() => ({ cloud: { instanceToken: 'tok_test' } as unknown }));
vi.mock('../../config-manager.js', () => ({
  configManager: { get: (section: string) => (section === 'cloud' ? config.cloud : undefined) },
}));

const { assignSeat, listSeats, readNudge, readPlanOverview, readUsage } =
  await import('../plan.js');
const { isCloudLinked, problemOf } = await import('../v1-client.js');
const { logger } = await import('../../../../lib/logger.js');

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

  // The client renders every amount in the unit the response names, and shows
  // "couldn't read" without one. These reads parse through the contract's
  // schemas, so a schema that did not know `denomination` would strip it here
  // and every figure downstream would go dark. Each read must carry it through.
  it('carries the served denomination through every amount-bearing read, unchanged', async () => {
    stubFetch({
      '/v1/entitlements': { status: 200, body: denominatedEntitlementsFixture },
      '/v1/balance': { status: 200, body: denominatedBalanceFixture },
      '/v1/usage': { status: 200, body: denominatedUsageFixture },
      '/v1/nudge': { status: 200, body: denominatedNudgeFixture },
    });
    const overview = await readPlanOverview();
    expect(overview?.entitlements.denomination).toEqual(
      denominatedEntitlementsFixture.denomination
    );
    expect(overview?.balance?.denomination).toEqual(denominatedBalanceFixture.denomination);
    expect((await readUsage('seat'))?.denomination).toEqual(denominatedUsageFixture.denomination);
    expect((await readNudge())?.denomination).toEqual(denominatedNudgeFixture.denomination);
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

  it('passes charges that are not inference through, and leaves them out when absent', async () => {
    // The contract's parse drops any key it does not define, so this fails if
    // the server reads usage against a schema without the other-charges block.
    stubFetch({ '/v1/usage': { status: 200, body: usageWithOtherChargesFixture } });
    const withCharges = await readUsage('seat');
    expect(withCharges?.otherCharges).toEqual(usageWithOtherChargesFixture.otherCharges);

    stubFetch({ '/v1/usage': { status: 200, body: usageFixture } });
    const without = await readUsage('seat');
    expect(without).not.toHaveProperty('otherCharges');
  });

  it('keeps the inference rows when the other-charges block is malformed', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // One bad row must not turn the whole read into a failure and take the
    // credits breakdown down with it.
    const [row] = usageWithOtherChargesFixture.otherCharges.rows;
    stubFetch({
      '/v1/usage': {
        status: 200,
        body: {
          ...usageWithOtherChargesFixture,
          otherCharges: { rows: [{ ...row, units: -1 }], dorkosPriceMicro: '0' },
        },
      },
    });
    const usage = await readUsage('seat');
    expect(usage?.rows).toEqual(usageWithOtherChargesFixture.rows);
    expect(usage?.otherCharges).toBeUndefined();
    // A billed charge the card cannot show must not vanish without a trace.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/otherCharges/);
  });

  it('logs nothing when the block is readable or was never sent', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    stubFetch({ '/v1/usage': { status: 200, body: usageWithOtherChargesFixture } });
    await readUsage('seat');
    stubFetch({ '/v1/usage': { status: 200, body: usageFixture } });
    await readUsage('seat');
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a trace and keeps the inference rows when the charges read fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // Only the longer window fails, so the breakdown must still arrive.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const asked = new URL(url);
        const days = windowDays(asked);
        const body = days > 30 ? { code: 'internal', status: 500, title: 'Down' } : usageFixture;
        return new Response(JSON.stringify(body), {
          status: days > 30 ? 500 : 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    const usage = await readUsage('seat');
    expect(usage?.rows).toEqual(usageFixture.rows);
    expect(usage).not.toHaveProperty('otherCharges');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/not inference/);
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

/** A window's length in days, from a `/v1/usage` request's own query. */
function windowDays(asked: URL): number {
  const from = Date.parse(asked.searchParams.get('from')!);
  const to = Date.parse(asked.searchParams.get('to')!);
  return (to - from) / (24 * 60 * 60 * 1000);
}

/** One billing period the fake service knows, and when its close settled it. */
interface FakePeriod {
  start: string;
  end: string;
  settledAt: string;
  displayName?: string;
  unit?: string;
  micro?: string;
}

/**
 * Stand in for `/v1/usage` the way the contract defines it: a period appears
 * once it has settled, and only in a window it STARTED in (`from` inclusive,
 * `to` exclusive). The inference rows are the same in every window, so what a
 * test sees under `otherCharges` is decided by the window the app asked for.
 */
function stubContractUsage(periods: FakePeriod[]) {
  const fetchMock = vi.fn(async (url: string) => {
    const asked = new URL(url);
    const from = Date.parse(asked.searchParams.get('from')!);
    const to = Date.parse(asked.searchParams.get('to')!);
    const now = Date.now();
    const rows = periods
      .filter((p) => Date.parse(p.settledAt) <= now)
      .filter((p) => Date.parse(p.start) >= from && Date.parse(p.start) < to)
      .map((p) => ({
        periodStart: p.start,
        periodEnd: p.end,
        units: 1.5,
        unit: p.unit ?? 'GB-month',
        displayName: p.displayName ?? 'Extra storage',
        dorkosPriceMicro: p.micro ?? '100',
        costBasis: 'published_price',
      }));
    const body = {
      ...usageFixture,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      groupBy: asked.searchParams.get('groupBy'),
      ...(rows.length === 0
        ? {}
        : {
            otherCharges: {
              rows,
              dorkosPriceMicro: rows
                .reduce((sum, r) => sum + BigInt(r.dorkosPriceMicro), 0n)
                .toString(),
            },
          }),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A calendar month's period that settled an hour after it ended. */
function month(start: string, end: string): FakePeriod {
  return { start, end, settledAt: new Date(Date.parse(end) + 60 * 60 * 1000).toISOString() };
}

/** The periods `readUsage` surfaced, as `start → end` pairs. */
async function shownPeriods(): Promise<string[]> {
  const usage = await readUsage('seat');
  return (usage?.otherCharges?.rows ?? []).map((r) => `${r.periodStart} → ${r.periodEnd}`);
}

// DOR-2589. The old read asked for one rolling 30-day window, and the contract
// lists a period only in the window it started in. A settled month-long period
// always started before that window, so the card never showed a storage
// charge. Every case below fails against that read.
describe('the latest settled charge', () => {
  const AUG = month('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  const SEP = month('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  const OCT = month('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');

  beforeEach(() => {
    config.cloud = { instanceToken: 'tok_test' };
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows last month in the middle of this one', async () => {
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    stubContractUsage([AUG, SEP, OCT]);
    expect(await shownPeriods()).toEqual(['2026-09-01T00:00:00.000Z → 2026-10-01T00:00:00.000Z']);
  });

  it('shows the month just closed once it settles, the day the next one starts', async () => {
    vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'));
    stubContractUsage([AUG, SEP, OCT]);
    expect(await shownPeriods()).toEqual(['2026-09-01T00:00:00.000Z → 2026-10-01T00:00:00.000Z']);
  });

  it('keeps showing the month before while the one just ended has not settled', async () => {
    vi.setSystemTime(new Date('2026-10-01T00:30:00.000Z'));
    stubContractUsage([AUG, SEP, OCT]);
    expect(await shownPeriods()).toEqual(['2026-08-01T00:00:00.000Z → 2026-09-01T00:00:00.000Z']);
  });

  it('shows a 31-day period on the last day of the month after it', async () => {
    vi.setSystemTime(new Date('2026-09-30T23:00:00.000Z'));
    stubContractUsage([AUG, SEP]);
    expect(await shownPeriods()).toEqual(['2026-08-01T00:00:00.000Z → 2026-09-01T00:00:00.000Z']);
  });

  it('shows the oldest a latest settled period can be: two 31-day months, before the second settles', async () => {
    // December and January are both 31 days. Half an hour into February,
    // January has not settled, so December is the latest: it started 62 days
    // and half an hour ago.
    vi.setSystemTime(new Date('2027-02-01T00:30:00.000Z'));
    stubContractUsage([
      month('2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      month('2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z'),
    ]);
    expect(await shownPeriods()).toEqual(['2026-12-01T00:00:00.000Z → 2027-01-01T00:00:00.000Z']);
  });

  it('shows a period that starts in the middle of a month', async () => {
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
    stubContractUsage([
      month('2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z'),
      month('2026-09-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z'),
    ]);
    expect(await shownPeriods()).toEqual(['2026-08-15T00:00:00.000Z → 2026-09-15T00:00:00.000Z']);
  });

  it('keeps the latest period of each charge, and totals only what it keeps', async () => {
    // Early in October the window reaches back past August 1, so it holds two
    // storage periods; only September's is shown. A second charge last seen in
    // August stays only while August can still be its latest period.
    vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'));
    const ARCHIVE = { displayName: 'Archive space', unit: 'widget-days' };
    stubContractUsage([
      { ...AUG, micro: '300' },
      { ...SEP, micro: '500' },
      { ...month('2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z'), ...ARCHIVE, micro: '7' },
    ]);
    const usage = await readUsage('seat');
    expect(usage?.otherCharges?.rows.map((r) => [r.displayName, r.periodStart])).toEqual([
      ['Extra storage', SEP.start],
      ['Archive space', '2026-08-15T00:00:00.000Z'],
    ]);
    expect(usage?.otherCharges?.dorkosPriceMicro).toBe('507');
  });

  it('shows no charge once the month after a charged one has ended with none', async () => {
    // September was charged; October charged nothing, so it sent no row.
    // September still started inside the window, but it is not the latest
    // charge any more.
    stubContractUsage([SEP]);
    vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
    expect(await shownPeriods()).toEqual(['2026-09-01T00:00:00.000Z → 2026-10-01T00:00:00.000Z']);
    vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'));
    expect(await readUsage('seat')).not.toHaveProperty('otherCharges');
  });

  it('drops an older period of one charge but keeps the current period of another', async () => {
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    stubContractUsage([
      { ...month('2026-08-14T00:00:00.000Z', '2026-09-13T00:00:00.000Z'), micro: '40' },
      { ...SEP, displayName: 'Archive space', unit: 'widget-days', micro: '9' },
    ]);
    const usage = await readUsage('seat');
    expect(usage?.otherCharges?.rows.map((r) => r.displayName)).toEqual(['Archive space']);
    expect(usage?.otherCharges?.dorkosPriceMicro).toBe('9');
  });

  it('keeps both rows when one charge has two for the same period', async () => {
    // August is in the window too, so the total is recomputed, not passed on.
    vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z'));
    stubContractUsage([
      { ...AUG, micro: '50' },
      { ...SEP, micro: '100' },
      { ...SEP, micro: '200' },
    ]);
    const usage = await readUsage('seat');
    expect(usage?.otherCharges?.rows.map((r) => r.dorkosPriceMicro)).toEqual(['100', '200']);
    expect(usage?.otherCharges?.dorkosPriceMicro).toBe('300');
  });

  it('still reads inference over the last 30 days, and says so on the response', async () => {
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    const fetchMock = stubContractUsage([AUG, SEP]);
    const usage = await readUsage('seat');
    const windows = fetchMock.mock.calls.map(([url]) => windowDays(new URL(url as string)));
    expect(windows.sort((a, b) => a - b)).toEqual([30, 63]);
    expect(usage?.from).toBe('2026-09-15T12:00:00.000Z');
    expect(usage?.to).toBe('2026-10-15T12:00:00.000Z');
    expect(usage?.rows).toEqual(usageFixture.rows);
  });

  it('shows nothing when no period has settled in the window', async () => {
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    stubContractUsage([OCT]);
    expect(await readUsage('seat')).not.toHaveProperty('otherCharges');
  });
});
