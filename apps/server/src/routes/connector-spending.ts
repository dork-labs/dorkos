/**
 * The monthly spend limit and each app's price per run (DOR-4204 PR 2, spec
 * 1.0 §2 and §3), under `/api/connectors/spending`.
 *
 * Only the person who owns this install changes either (spec 1.1): an agent,
 * an approval token and a teammate are refused, whatever they send. A change
 * that lets more money leave without a card waits for "Confirm it's you"
 * (spec §2.2); one that narrows goes straight through.
 *
 * @module routes/connector-spending
 */
import { Hono, type Context } from 'hono';
import {
  SetSpendingLimitBodySchema,
  SetSpendingPriceBodySchema,
  type SpendingSummary,
} from '@dorkos/shared/connector-spending';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import {
  SPENDING_LIMIT_MAX_MICRO,
  SPENDING_MIN_MICRO,
  SpendingMeterUnreadableError,
  nextMonthStart,
  type SpendingStore,
} from '../services/connectors/spending/spending-store.js';
import { SPEND_CURRENCY, limitMoney, money } from '../services/connectors/spending/spend-copy.js';
import { errorRefusalUnlessOwner, type AccountOwnerWording } from './cloud-owner-bar.js';
import { holdForStepUp } from './step-up-guard.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import type { RequestFacts } from '../http/request-facts.js';

/** What the spending routes read. */
export interface ConnectorSpendingRouteDeps {
  spending: SpendingStore;
  /** Clock seam for the month. */
  now?: () => Date;
  /** Writes the Activity lines of spec §9; omitted, nothing is recorded. */
  activity?: Pick<ActivityService, 'emit'>;
}

const WORDING: AccountOwnerWording = {
  personOnly: 'Only a person can change spending, in the DorkOS app.',
  action: 'change spending',
};

const TOOLKIT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The copy a refused amount answers with (spec §2.3). */
function amountError(micro: number, max: number | null): string | null {
  if (micro < SPENDING_MIN_MICRO) return 'Enter at least $0.01, or leave it empty.';
  if (max !== null && micro > max) return `Enter ${limitMoney(max)} or less.`;
  return null;
}

/** Parse a body amount, or answer the 400 it earns. */
function parseAmount(
  c: Context<ApiEnv>,
  raw: string | null,
  max: number | null
): number | null | Response {
  if (raw === null) return null;
  const micro = Number(raw);
  const error = amountError(micro, max);
  return error === null ? micro : c.json({ error, code: 'INVALID_AMOUNT' }, 400);
}

/** What the Spending block reads (spec §2.1); amounts are micro-unit strings. */
function summary(spending: SpendingStore, now: Date): SpendingSummary {
  const limitMicro = spending.limit();
  const base = {
    currency: SPEND_CURRENCY,
    limitMicro: limitMicro === null ? null : String(limitMicro),
    maxMicro: String(SPENDING_LIMIT_MAX_MICRO),
    resetsAt: nextMonthStart(now).toISOString(),
    prices: Object.fromEntries(
      Object.entries(spending.prices()).map(([toolkit, micro]) => [toolkit, String(micro)])
    ),
  };
  try {
    const meter = spending.meter();
    return {
      ...base,
      meterReadable: true,
      month: meter.month,
      usedMicro: String(meter.usedMicro),
      leftMicro: limitMicro === null ? null : String(Math.max(0, limitMicro - meter.usedMicro)),
      overMicro: limitMicro === null ? null : String(Math.max(0, meter.usedMicro - limitMicro)),
      approximate: meter.estimated || meter.unknownRuns > 0,
      byApp: meter.byApp.map((share) => ({ ...share, amountMicro: String(share.amountMicro) })),
    };
  } catch (error) {
    if (!(error instanceof SpendingMeterUnreadableError)) throw error;
    return { ...base, meterReadable: false };
  }
}

/**
 * The spending routes.
 *
 * @param deps - See {@link ConnectorSpendingRouteDeps}.
 */
export function createConnectorSpendingRoutes(deps: ConnectorSpendingRouteDeps): Hono<ApiEnv> {
  const { spending } = deps;
  const now = deps.now ?? (() => new Date());
  const router = new Hono<ApiEnv>();
  const refusal = (c: Context<ApiEnv>) => errorRefusalUnlessOwner(honoRequestFacts(c), WORDING);
  /** One Activity line for a person's change to spending (spec §9). */
  const record = (caller: RequestFacts, summary: string, eventType: string) =>
    void deps.activity?.emit({
      ...readActivityActor(caller),
      category: 'config',
      eventType,
      resourceType: 'spending',
      summary,
    });

  router.get('/', (c) => c.json(summary(spending, now())));

  router.put('/limit', async (c) => {
    const refused = refusal(c);
    if (refused) return c.json(refused, 403);
    const parsed = SetSpendingLimitBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success)
      return c.json({ error: 'Enter an amount, like 40.', code: 'INVALID_AMOUNT' }, 400);
    const next = parseAmount(c, parsed.data.limit, SPENDING_LIMIT_MAX_MICRO);
    if (next instanceof Response) return next;
    const current = spending.limit();
    const apply = (caller: RequestFacts, confirmed = false) => {
      spending.setLimit(next);
      record(
        caller,
        next === null
          ? 'Set spending to ask every time'
          : `${current !== null && next < current ? 'Lowered' : 'Raised'} the monthly limit to ${limitMoney(next)}${confirmed ? ' · confirmed with password' : ''}`,
        'spending.limit_changed'
      );
      return { status: 200, body: summary(spending, now()) };
    };
    // From "Ask every time" to a limit, or higher: more money may now leave with no card.
    const raises = next !== null && (current === null || next > current);
    if (!raises) {
      const done = apply(honoRequestFacts(c));
      return c.json(done.body, 200);
    }
    return holdForStepUp(c, {
      kind: 'spending.raise',
      target: 'monthly spending limit',
      input: { limitMicro: next },
      reason: `Let agents spend up to ${limitMoney(next)} a month without asking.`,
      commit: async (confirming) => {
        const stale = errorRefusalUnlessOwner(confirming, WORDING);
        if (stale) return { status: 403, body: stale };
        return apply(confirming, true);
      },
    });
  });

  router.put('/prices/:toolkit', async (c) => {
    const refused = refusal(c);
    if (refused) return c.json(refused, 403);
    const toolkit = c.req.param('toolkit').toLowerCase();
    if (!TOOLKIT.test(toolkit))
      return c.json({ error: 'No such app.', code: 'INVALID_TOOLKIT' }, 400);
    const parsed = SetSpendingPriceBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success)
      return c.json({ error: 'Enter an amount, like 0.30.', code: 'INVALID_AMOUNT' }, 400);
    const next = parseAmount(c, parsed.data.price, SPENDING_LIMIT_MAX_MICRO);
    if (next instanceof Response) return next;
    const current = spending.price(toolkit);
    const apply = (caller: RequestFacts, confirmed = false) => {
      spending.setPrice(toolkit, next);
      record(
        caller,
        next === null
          ? `Cleared ${toolkit}'s price per run`
          : `Set ${toolkit}'s price to about ${money(next)} a run${confirmed ? ' · confirmed with password' : ''}`,
        'spending.price_set'
      );
      return { status: 200, body: summary(spending, now()) };
    };
    // A first price, or a lower one, lets more runs through quietly: a raise in disguise.
    const loosens = next !== null && (current === null || next < current);
    if (!loosens) {
      const done = apply(honoRequestFacts(c));
      return c.json(done.body, 200);
    }
    return holdForStepUp(c, {
      kind: 'spending.price',
      target: `price per run for ${toolkit}`,
      input: { toolkit, priceMicro: next },
      reason: `Count each ${toolkit} run as about ${money(next)}.`,
      commit: async (confirming) => {
        const stale = errorRefusalUnlessOwner(confirming, WORDING);
        if (stale) return { status: 403, body: stale };
        return apply(confirming, true);
      },
    });
  });

  return router;
}
