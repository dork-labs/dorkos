/**
 * Plan-shaped reads over the `/v1` contract: what this account is entitled to,
 * what its credit position is, where the credits went, whether the service has a
 * comparison to offer, and the seats it holds.
 *
 * **Every plan-shaped string in this module comes off the wire.** Nothing here
 * names a plan, prints a price, or branches on an identifier: `planId`,
 * `suggestedPlanId`, seat ids and usage keys are opaque, and the only strings a
 * surface renders are the `displayName` fields the service supplied. That is the
 * contract's own rule (`@dork-labs/cloud-api`'s catalog-blindness test) and this
 * module is the app's side of it.
 *
 * Amounts stay strings end to end. The contract carries micro-units as decimal
 * strings precisely so nobody rounds them through a float on the way to a
 * screen; this module passes them through untouched and the client formats them
 * once. Each response's `denomination` (the unit its amounts are in) rides
 * along unchanged, because the client renders nothing it cannot name the unit
 * of.
 *
 * @module services/core/cloud/plan
 */
import {
  BalanceSchema,
  EntitlementsSchema,
  MemberListResponseSchema,
  NudgeSchema,
  OrgListResponseSchema,
  SeatListResponseSchema,
  SeatSchema,
  UsageResponseSchema,
  V1_ROUTES,
  v1Path,
  type Balance,
  type Entitlements,
  type Member,
  type Nudge,
  type Org,
  type OtherCharges,
  type Seat,
  type UsageResponse,
} from '@dork-labs/cloud-api';
import { z } from 'zod';
import { logger, logError } from '../../../lib/logger.js';
import { createCloudV1Client, readOrNull } from './v1-client.js';

/** How a usage window may be grouped. Mirrors the contract's own vocabulary. */
export type UsageGrouping = 'seat' | 'model' | 'day';

/** Everything the plan card renders, in one read. */
export interface PlanOverview {
  /** What this account is entitled to. */
  entitlements: Entitlements;
  /**
   * The credit position, or `null` when the service does not serve one for this
   * account. An entitlement without a balance is a complete answer, not a
   * partial failure, so the card renders the plan half and omits the credit half.
   */
  balance: Balance | null;
}

/** One day, in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The inference window: the last 30 days, ending now. */
const USAGE_WINDOW_DAYS = 30;

/**
 * How far back to look for charges that are not inference, in days.
 *
 * The contract lists a billing period only in a window it STARTED in, and a
 * period appears only once it has ended and settled. So a month-long period
 * is never in the 30-day inference window: by the time it exists, it started
 * more than 30 days ago. A period lasts at most 31 days, and the latest
 * settled one ended no more than one period ago, so it started within the last
 * 62 days. The extra day allows for the time between a period ending and
 * settling; if settling ever takes longer, the card shows no charge until it
 * settles. The window can hold more than one period of a charge, and
 * {@link latestPeriods} keeps the latest.
 */
const CHARGES_WINDOW_DAYS = 63;

/**
 * How long after a period ends it stops being the current charge, in days.
 *
 * A month with nothing to charge sends no row, so the latest row in the window
 * can be an older month. By 32 days after a period ends, the period after it
 * (31 days at most) has ended too. If that one sent no row, it charged nothing,
 * and showing the older month as the latest charge would be wrong. Dropping a
 * row any sooner would hide a real charge while the next period is still
 * running, so after a shorter free month the older charge still shows for up
 * to the few days the free month was short by.
 */
const CHARGE_CURRENT_DAYS = 32;

/**
 * The plan card's read: entitlements, and the balance beside it.
 *
 * Returns `null` when this instance is not linked, which is what the card's
 * empty state is for. The two calls run together because the card renders them
 * as one thing; a missing balance degrades to `null` rather than failing the
 * whole read.
 *
 * @param signal - Aborts both requests.
 */
export async function readPlanOverview(signal?: AbortSignal): Promise<PlanOverview | null> {
  const [entitlements, balance] = await Promise.all([
    // `readOrNull` on BOTH halves, not just the balance. A service that has not
    // deployed `/v1/entitlements` yet answers 404, and so does one whose
    // entitlement this client is too old to parse — neither is a fault worth
    // reddening a settings page over, and both mean the same thing to the card:
    // there is nothing to show.
    readOrNull((c) => c.get(V1_ROUTES.entitlements, EntitlementsSchema, { signal })),
    readOrNull((c) => c.get(V1_ROUTES.balance, BalanceSchema, { signal })),
  ]);
  if (entitlements === null) return null;
  return { entitlements, balance };
}

/**
 * One organization's members — who could hold a person seat.
 *
 * Read by the seat surface so assigning a seat picks a real subject rather than
 * asking somebody to type an opaque identifier.
 *
 * @param orgId - The organization's opaque identifier.
 * @param signal - Aborts the request.
 */
export async function listMembers(orgId: string, signal?: AbortSignal): Promise<Member[] | null> {
  const page = await readOrNull((client) =>
    client.get(v1Path.orgMembers(orgId), MemberListResponseSchema, { signal })
  );
  return page === null ? null : page.items;
}

/**
 * The credits gauge's usage read: the last 30 days of inference, grouped as
 * asked, and the latest settled period of each charge that is not inference.
 *
 * `groupBy: 'seat'` is what the credits gauge's per-agent breakdown reads: each
 * row's `displayName` is the label, `key` is opaque, and the two price figures
 * ride along so the difference between them is visible without a second call.
 *
 * The two halves come from two windows, because the contract places a billing
 * period in the window it started in (see {@link CHARGES_WINDOW_DAYS}). The
 * response's `from`, `to`, `rows` and `totals` describe the 30-day inference
 * window; its `otherCharges` holds the latest settled period of each charge,
 * whose own `periodStart` and `periodEnd` say which days it covers. A malformed
 * `otherCharges` block is dropped by the contract and logged here once, so a
 * charge that could not be shown still leaves a trace, and a charges read that
 * fails is logged and left out rather than taking the breakdown down with it.
 *
 * @param grouping - How to group the rows.
 * @param signal - Aborts both requests.
 */
export async function readUsage(
  grouping: UsageGrouping,
  signal?: AbortSignal
): Promise<UsageResponse | null> {
  const to = new Date();
  const [usage, otherCharges] = await Promise.all([
    readUsageWindow(daysBefore(to, USAGE_WINDOW_DAYS), to, grouping, signal),
    readOtherCharges(daysBefore(to, CHARGES_WINDOW_DAYS), to, grouping, signal),
  ]);
  if (usage === null) return null;
  // Whatever the inference window carried under `otherCharges` is replaced, not
  // merged: the charges window contains the inference window, so any period
  // listed there is listed again in the charges window.
  const { otherCharges: _inferenceWindowCharges, ...inference } = usage;
  return otherCharges === undefined ? inference : { ...inference, otherCharges };
}

/**
 * The instant a whole number of days before another.
 *
 * @param at - The later instant.
 * @param days - How many days earlier.
 */
function daysBefore(at: Date, days: number): Date {
  return new Date(at.getTime() - days * DAY_MS);
}

/**
 * One `/v1/usage` window, exactly as the contract parses it.
 *
 * @param from - The window's start, inclusive.
 * @param to - The window's end, exclusive.
 * @param grouping - How to group the rows.
 * @param signal - Aborts the request.
 * @param schema - The schema to parse the body with.
 */
function readUsageWindow(
  from: Date,
  to: Date,
  grouping: UsageGrouping,
  signal: AbortSignal | undefined,
  schema: z.ZodType<UsageResponse> = UsageResponseSchema
): Promise<UsageResponse | null> {
  return readOrNull((client) =>
    client.get(V1_ROUTES.usage, schema, {
      query: { from: from.toISOString(), to: to.toISOString(), groupBy: grouping },
      signal,
    })
  );
}

/**
 * The latest settled period of each charge that is not inference, read over
 * the longer charges window.
 *
 * Answers `undefined` when the service sent no such charges or none is still
 * current (see {@link CHARGE_CURRENT_DAYS}), when it sent a
 * block this release could not read, and when the read itself failed. The last
 * two are logged: each hides a charge the account may have been billed for.
 *
 * @param from - The window's start, inclusive.
 * @param to - The window's end, exclusive.
 * @param grouping - The grouping the request carries; these charges ignore it.
 * @param signal - Aborts the request.
 */
async function readOtherCharges(
  from: Date,
  to: Date,
  grouping: UsageGrouping,
  signal: AbortSignal | undefined
): Promise<OtherCharges | undefined> {
  // The contract drops a malformed `otherCharges` block rather than failing the
  // read. That keeps the card up, but it also hides a charge the account was
  // billed for — so note whether the raw body carried the block, and leave a
  // trace when the parse let it go.
  let sentOtherCharges = false;
  const schema = z.preprocess((raw) => {
    sentOtherCharges =
      typeof raw === 'object' &&
      raw !== null &&
      (raw as Record<string, unknown>).otherCharges !== undefined;
    return raw;
  }, UsageResponseSchema);
  let usage: UsageResponse | null;
  try {
    usage = await readUsageWindow(from, to, grouping, signal, schema);
  } catch (err) {
    if (signal?.aborted) throw err;
    logger.warn(
      '[Cloud] Could not read the charges that are not inference; showing usage without them',
      logError(err)
    );
    return undefined;
  }
  if (usage !== null && sentOtherCharges && usage.otherCharges === undefined) {
    logger.warn(
      '[Cloud] usage carried an otherCharges block this release could not read; it was dropped and the inference rows kept',
      { groupBy: grouping }
    );
  }
  return usage?.otherCharges === undefined ? undefined : latestPeriods(usage.otherCharges, to);
}

/**
 * Keep only the latest period of each charge that is still current, and total
 * what is kept.
 *
 * A charge is told apart by the service's own `displayName` and `unit`, so a
 * second kind of charge the service adds later keeps its own latest period
 * rather than being hidden behind another's. Every row of that latest period
 * is kept: the contract allows two rows for one charge and period. A period
 * that ended {@link CHARGE_CURRENT_DAYS} or more days ago is dropped, because
 * the period after it has ended with no charge. The block's total is
 * recomputed from the rows kept, exactly, as integer micro-units.
 *
 * @param block - The charges in the longer window.
 * @param now - The instant the window ends at.
 * @returns The latest current period of each charge, with their total, or
 *   `undefined` when none is current.
 */
function latestPeriods(block: OtherCharges, now: Date): OtherCharges | undefined {
  const currentFrom = daysBefore(now, CHARGE_CURRENT_DAYS).getTime();
  const current = block.rows.filter((row) => Date.parse(row.periodEnd) > currentFrom);
  const kindOf = (row: OtherCharges['rows'][number]) => JSON.stringify([row.displayName, row.unit]);
  const latestStart = new Map<string, number>();
  for (const row of current) {
    const start = Date.parse(row.periodStart);
    const held = latestStart.get(kindOf(row));
    if (held === undefined || start > held) latestStart.set(kindOf(row), start);
  }
  // Keep the service's order among the rows that remain.
  const rows = current.filter(
    (row) => Date.parse(row.periodStart) === latestStart.get(kindOf(row))
  );
  if (rows.length === 0) return undefined;
  if (rows.length === block.rows.length) return block;
  const total = rows.reduce((sum, row) => sum + BigInt(row.dorkosPriceMicro), 0n);
  return { rows, dorkosPriceMicro: total.toString() };
}

/**
 * The already-reduced comparison, or `null` when there is none.
 *
 * The route sits behind a server flag and answers 404 until it is switched on,
 * so `null` is the ordinary answer and the nudge simply does not render. The
 * subtraction is the service's; nothing is computed here.
 *
 * @param signal - Aborts the request.
 */
export async function readNudge(signal?: AbortSignal): Promise<Nudge | null> {
  return readOrNull((client) => client.get(V1_ROUTES.nudge, NudgeSchema, { signal }));
}

/**
 * The organizations this account belongs to.
 *
 * @param signal - Aborts the request.
 */
export async function listOrgs(signal?: AbortSignal): Promise<Org[] | null> {
  const page = await readOrNull((client) =>
    client.get(V1_ROUTES.orgs, OrgListResponseSchema, { signal })
  );
  return page === null ? null : page.items;
}

/**
 * One organization's seats.
 *
 * @param orgId - The organization's opaque identifier.
 * @param signal - Aborts the request.
 */
export async function listSeats(orgId: string, signal?: AbortSignal): Promise<Seat[] | null> {
  const page = await readOrNull((client) =>
    client.get(v1Path.orgSeats(orgId), SeatListResponseSchema, { signal })
  );
  return page === null ? null : page.items;
}

/** Who a seat is being assigned to. */
export interface SeatSubject {
  kind: 'agent' | 'user';
  id: string;
}

/**
 * Assign a seat to a person or an agent.
 *
 * A refusal a subscription would lift comes back as the contract's problem
 * envelope carrying `requiredPlanDisplayName`; the caller renders that string
 * and never a plan name of its own. This function does not catch it — the route
 * above translates it, so the copy stays the service's.
 *
 * @param seatId - The seat's opaque identifier.
 * @param subject - Who the seat is for.
 * @param signal - Aborts the request.
 * @throws When this instance is not linked.
 */
export async function assignSeat(
  seatId: string,
  subject: SeatSubject,
  signal?: AbortSignal
): Promise<Seat> {
  const client = requireClient();
  return client.post(v1Path.seatAssign(seatId), SeatSchema, { body: { subject }, signal });
}

/**
 * The response shape of a seat release.
 *
 * Deliberately permissive: `@dork-labs/cloud-api@0.75.1` types the release
 * ROUTE but not its body, and a client that guessed a body would fail a call
 * that actually succeeded. The caller refetches the seat list instead of reading
 * anything out of this.
 */
const SeatReleaseResponseSchema = z.looseObject({});

/**
 * Release a seat.
 *
 * @param seatId - The seat's opaque identifier.
 * @param signal - Aborts the request.
 * @throws When this instance is not linked.
 */
export async function releaseSeat(seatId: string, signal?: AbortSignal): Promise<void> {
  const client = requireClient();
  await client.post(v1Path.seatRelease(seatId), SeatReleaseResponseSchema, { signal });
}

/**
 * A live `/v1` client, or a loud failure.
 *
 * Reads degrade to `null`; WRITES must not. A seat assignment that quietly did
 * nothing because the instance was unlinked is worse than one that says so.
 *
 * @throws When this instance holds no cloud credential.
 */
function requireClient() {
  const client = createCloudV1Client();
  if (client === null) throw new Error('This instance is not linked to a DorkOS account.');
  return client;
}
