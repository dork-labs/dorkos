/**
 * Cloud-link route — local HTTP API the client Settings panel uses to link this
 * instance to a DorkOS account, read the link state, and unlink
 * (accounts-and-auth P2, task 2.4).
 *
 * Thin over {@link getCloudLinkManager}: each handler validates nothing beyond
 * the empty bodies these endpoints take, delegates to the manager, and shapes
 * the response. These routes ride the app-wide session gate like any other
 * `/api/*` route and are INDEPENDENT of `config.auth.enabled`.
 *
 * ## The plan-aware half (DOR-2027)
 *
 * The routes below `/status` read the `/v1` contract through
 * `services/core/cloud`. They sit BESIDE the legacy link routes above rather
 * than replacing them, and every one of them answers `{ available: false }`
 * — never an error — when this instance holds no cloud credential or the
 * service does not serve that route. That is what lets the whole surface hide
 * itself on an install with no cloud account, with no request leaving the
 * machine.
 *
 * Nothing here names a plan or prints a price. Plan-shaped strings are the
 * service's `displayName` fields and amounts are its micro-unit decimal
 * strings, both passed through untouched.
 *
 * @module routes/cloud
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Problem } from '@dork-labs/cloud-api';
import type {
  CloudAccountExportResponse,
  CloudBillingPage,
  CloudBillingSessionResponse,
  CloudMembersResponse,
  CloudNudgeResponse,
  CloudOffersResponse,
  CloudOrgsResponse,
  CloudPlanResponse,
  CloudSeatActionResponse,
  CloudSeatsResponse,
  CloudUsageResponse,
} from '@dorkos/shared/cloud-schemas';
import { getCloudLinkManager } from '../services/core/auth/cloud-link.js';
import {
  assignSeat,
  listMembers,
  listOrgs,
  listSeats,
  readNudge,
  readPlanOverview,
  readUsage,
  releaseSeat,
  type UsageGrouping,
} from '../services/core/cloud/plan.js';
import { isAbsent, isCloudLinked, problemOf } from '../services/core/cloud/v1-client.js';
import {
  openBillingPage,
  readOffers,
  requestAccountExport,
} from '../services/core/cloud/billing-pages.js';
import {
  creditsFlagEnabled,
  creditsWiringReport,
  primeCreditsInference,
} from '../services/core/cloud/credits-inference.js';
import { logger, logError } from '../lib/logger.js';
import { createCloudCommunitiesRouter } from './cloud-communities.js';

const router = Router();

/** Hosted communities: "Start a community" and "Move a community here". */
router.use('/communities', createCloudCommunitiesRouter());

/** POST /api/cloud/link/start — begin the device flow; returns codes to display. */
router.post('/link/start', async (_req, res) => {
  try {
    const result = await getCloudLinkManager().startLink();
    return res.json(result);
  } catch (err) {
    logger.error('[Cloud] Failed to start device link', logError(err));
    return res
      .status(502)
      .json({ error: 'Could not reach the DorkOS cloud to start linking. Try again shortly.' });
  }
});

/** GET /api/cloud/link/status — the live link-flow state machine. */
router.get('/link/status', (_req, res) => {
  res.json(getCloudLinkManager().getStatus());
});

/** POST /api/cloud/unlink — withdraw locally before best-effort server-side revoke. */
router.post('/unlink', async (_req, res) => {
  try {
    await getCloudLinkManager().unlink();
    return res.json({ ok: true });
  } catch (err) {
    logger.error('[Cloud] Unlink failed', logError(err));
    return res.status(500).json({ error: 'Failed to unlink this instance' });
  }
});

/** GET /api/cloud/status — settled linked/unlinked summary for Settings. */
router.get('/status', (_req, res) => {
  res.json(getCloudLinkManager().getSummary());
});

/**
 * Turn an unexpected `/v1` failure into a 502 without ever echoing a body.
 *
 * "Unexpected" excludes the two conditions the readers already fold into
 * `available: false` — unlinked, and route absent — so reaching here really does
 * mean the service is unwell.
 *
 * @param res - The Express response to answer on.
 * @param error - The value the read rejected with.
 * @param what - What was being read, for the log line.
 */
function cloudReadFailed(res: Response, error: unknown, what: string) {
  logger.warn(`[Cloud] Could not read ${what}`, logError(error));
  return res.status(502).json({ error: 'Could not reach the DorkOS cloud. Try again shortly.' });
}

/** GET /api/cloud/plan — the plan card's entitlements + credit position. */
router.get('/plan', async (_req, res) => {
  try {
    const overview = await readPlanOverview();
    const body: CloudPlanResponse =
      overview === null
        ? { available: false }
        : { available: true, entitlements: overview.entitlements, balance: overview.balance };
    return res.json(body);
  } catch (err) {
    return cloudReadFailed(res, err, 'the plan');
  }
});

/** The groupings `GET /v1/usage` accepts, restated so a query string cannot widen them. */
const UsageGroupingSchema = z.enum(['seat', 'model', 'day']).default('seat');

/** GET /api/cloud/usage — one grouped usage window for the credits gauge. */
router.get('/usage', async (req, res) => {
  const grouping = UsageGroupingSchema.safeParse(req.query.groupBy);
  if (!grouping.success) return res.status(400).json({ error: 'Unknown grouping' });
  try {
    const usage = await readUsage(grouping.data as UsageGrouping);
    const body: CloudUsageResponse =
      usage === null ? { available: false } : { available: true, usage };
    return res.json(body);
  } catch (err) {
    return cloudReadFailed(res, err, 'usage');
  }
});

/** GET /api/cloud/nudge — the already-reduced comparison, when there is one. */
router.get('/nudge', async (_req, res) => {
  try {
    const nudge = await readNudge();
    const body: CloudNudgeResponse =
      nudge === null ? { available: false } : { available: true, nudge };
    return res.json(body);
  } catch (err) {
    // A nudge is an optional affordance; an unwell service hides it rather than
    // turning the settings page red.
    logger.warn('[Cloud] Could not read the nudge', logError(err));
    return res.json({ available: false } satisfies CloudNudgeResponse);
  }
});

/** GET /api/cloud/orgs — the organizations this account belongs to. */
router.get('/orgs', async (_req, res) => {
  try {
    const orgs = await listOrgs();
    const body: CloudOrgsResponse =
      orgs === null ? { available: false } : { available: true, orgs };
    return res.json(body);
  } catch (err) {
    return cloudReadFailed(res, err, 'organizations');
  }
});

/** GET /api/cloud/orgs/:orgId/seats — one organization's seats. */
router.get('/orgs/:orgId/seats', async (req, res) => {
  try {
    const seats = await listSeats(req.params.orgId);
    const body: CloudSeatsResponse =
      seats === null ? { available: false } : { available: true, seats };
    return res.json(body);
  } catch (err) {
    return cloudReadFailed(res, err, 'seats');
  }
});

/** GET /api/cloud/orgs/:orgId/members — who could hold a person seat. */
router.get('/orgs/:orgId/members', async (req, res) => {
  try {
    const members = await listMembers(req.params.orgId);
    const body: CloudMembersResponse =
      members === null ? { available: false } : { available: true, members };
    return res.json(body);
  } catch (err) {
    return cloudReadFailed(res, err, 'members');
  }
});

/** The body `POST /api/cloud/seats/:seatId/assign` takes. Ids stay opaque strings. */
const SeatAssignBodySchema = z.object({
  subject: z.object({ kind: z.enum(['agent', 'user']), id: z.string().min(1) }),
});

/** What a refusal envelope looks like on the wire, whichever write produced it. */
type CloudWriteRefusal = { ok: false; problem: Problem } | { ok: false; message: string };

/** How one write words the refusals the service did not describe. */
interface WriteFailureWording {
  /** What was being done, for the log line. */
  what: string;
  /**
   * What to tell the person when the service does not serve this write at all:
   * a 404 that is not a problem envelope, which is a route that is not
   * deployed. Also used for a `not_found` problem when `notFound` is absent.
   * Without it, such a refusal is passed through like any other.
   */
  absent?: string;
  /**
   * What to tell the person when the service answers with a `not_found`
   * problem: the route is there, but the thing the write names is not (an
   * offer no longer on sale, say).
   */
  notFound?: string;
}

/**
 * Answer a failed cloud write: the service's own refusal verbatim, or one plain
 * sentence of ours.
 *
 * This is the whole reason the app can say "this needs a plan change" without
 * knowing a single plan: the words, including `requiredPlanDisplayName`, are the
 * service's.
 *
 * A "not found" is the exception. Its words are written for developers, not
 * people, so a write that can meet one names its own plain sentences: one for
 * a route that is not served at all (`wording.absent`), and one for a route
 * that is served but could not find what the write named (`wording.notFound`).
 * The two are told apart by the answer's shape: a deployed route refuses with
 * a problem envelope, a missing one does not.
 *
 * **It answers 200, and that is not sloppiness.** A refusal a plan change would
 * lift is an ANSWER this route succeeded in obtaining, not a failure of this
 * route — and the client's `fetchJSON` throws on every non-2xx, discarding the
 * body into an exception whose shape the caller would have to reverse-engineer.
 * Passing the status through would therefore make the one affordance this whole
 * feature exists for — explaining a refusal in the service's own words —
 * unreachable in the running app while still passing a mocked test. The
 * `{ ok: false, problem }` envelope carries the service's status inside
 * `problem.status`, so nothing is lost.
 *
 * @param res - The Express response to answer on.
 * @param error - The value the write rejected with.
 * @param wording - What was being done, and what to say when it is not served.
 */
function cloudWriteFailed(res: Response, error: unknown, wording: WriteFailureWording) {
  const problem = problemOf(error);
  if (isAbsent(error)) {
    const sentence = problem !== null ? (wording.notFound ?? wording.absent) : wording.absent;
    if (sentence !== undefined) {
      return res.json({ ok: false, message: sentence } satisfies CloudWriteRefusal);
    }
  }
  if (problem !== null) {
    return res.json({ ok: false, problem } satisfies CloudWriteRefusal);
  }
  logger.warn(`[Cloud] Could not ${wording.what}`, logError(error));
  return res.json({
    ok: false,
    message: 'Couldn’t reach your DorkOS account. Try again shortly.',
  } satisfies CloudWriteRefusal);
}

/** Said, with HTTP 200, by every cloud write while this instance is not linked. */
const NOT_LINKED: CloudWriteRefusal = {
  ok: false,
  message: 'This instance is not linked to a DorkOS account.',
};

/** POST /api/cloud/seats/:seatId/assign — give a seat to a person or an agent. */
router.post('/seats/:seatId/assign', async (req, res) => {
  // 200 with a refusal envelope, for the reason {@link cloudWriteFailed} gives.
  if (!isCloudLinked()) return res.json(NOT_LINKED);
  const parsed = SeatAssignBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, message: 'Unknown subject' });
  try {
    const seat = await assignSeat(req.params.seatId, parsed.data.subject);
    return res.json({ ok: true, seat } satisfies CloudSeatActionResponse);
  } catch (err) {
    return cloudWriteFailed(res, err, { what: 'change a seat' });
  }
});

/** POST /api/cloud/seats/:seatId/release — hand a seat back. */
router.post('/seats/:seatId/release', async (req, res) => {
  if (!isCloudLinked()) return res.json(NOT_LINKED);
  try {
    await releaseSeat(req.params.seatId);
    return res.json({ ok: true } satisfies CloudSeatActionResponse);
  } catch (err) {
    return cloudWriteFailed(res, err, { what: 'change a seat' });
  }
});

/** GET /api/cloud/offers — what the service will sell this account, as it sent it. */
router.get('/offers', async (_req, res) => {
  try {
    const offers = await readOffers();
    const body: CloudOffersResponse =
      offers === null ? { available: false } : { available: true, offers };
    return res.json(body);
  } catch (err) {
    return cloudReadFailed(res, err, 'offers');
  }
});

/** The pages `POST /api/cloud/billing/:page` opens. */
const BillingPageSchema = z.enum(['portal', 'checkout', 'topup']);

/** The body a checkout takes: one opaque offer identifier from `GET /api/cloud/offers`. */
const CheckoutBodySchema = z.object({ skuId: z.string().min(1) });

/** What each billing page is called when it is not available on this account. */
const BILLING_ABSENT: Record<CloudBillingPage, string> = {
  portal: 'Billing isn’t available on your account yet.',
  checkout: 'Changing plan isn’t available on your account yet.',
  topup: 'Adding credits isn’t available on your account yet.',
};

/**
 * POST /api/cloud/billing/:page — start a session on one billing page and
 * answer with its web address.
 *
 * `portal` is where a plan is changed or ended and invoices live, `checkout`
 * starts one offer, `topup` buys credits. The answer is only an address for
 * the person's own browser; nothing is paid here. A refusal answers 200, for
 * the reason {@link cloudWriteFailed} gives.
 */
router.post('/billing/:page', async (req, res) => {
  const page = BillingPageSchema.safeParse(req.params.page);
  if (!page.success) return res.status(404).json({ ok: false, message: 'Unknown billing page' });
  let skuId: string | undefined;
  if (page.data === 'checkout') {
    const parsed = CheckoutBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, message: 'Choose an offer' });
    skuId = parsed.data.skuId;
  }
  // A short-lived page address is not something to keep in any cache.
  res.setHeader('Cache-Control', 'no-store');
  if (!isCloudLinked()) return res.json(NOT_LINKED);
  try {
    const url = await openBillingPage({ kind: page.data, skuId });
    return res.json({ ok: true, url } satisfies CloudBillingSessionResponse);
  } catch (err) {
    return cloudWriteFailed(res, err, {
      what: `open the ${page.data} page`,
      absent: BILLING_ABSENT[page.data],
      // A served checkout that cannot find the offer: it is no longer on sale.
      ...(page.data === 'checkout' ? { notFound: 'That plan isn’t on sale any more.' } : {}),
    });
  }
});

/**
 * POST /api/cloud/account/export — ask for a copy of everything the account
 * holds. When the answer already carries a download link, it is here; until
 * then, asking again is how to get it. Sent `no-store`.
 */
router.post('/account/export', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isCloudLinked()) return res.json(NOT_LINKED);
  try {
    const job = await requestAccountExport();
    const body: CloudAccountExportResponse = {
      ok: true,
      export: { requestedAt: job.requestedAt, readyAt: job.readyAt, downloadUrl: job.downloadUrl },
    };
    return res.json(body);
  } catch (err) {
    return cloudWriteFailed(res, err, {
      what: 'request an account export',
      absent: 'Exporting your data isn’t available on your account yet.',
      notFound: 'Couldn’t find your DorkOS account. Try linking this computer again.',
    });
  }
});

/** GET /api/cloud/credits — whether the credits path is armed. Carries no credential. */
router.get('/credits', (_req, res) => {
  res.json(creditsWiringReport());
});

/**
 * POST /api/cloud/credits/select — obtain an inference token for this process.
 *
 * Behind the `DORKOS_CLOUD_CREDITS` flag, which is off by default, and behind
 * the link credential beside it. With either missing this answers the same
 * report the GET does, unchanged, rather than an error: nothing was armed, and
 * nothing was spent.
 */
router.post('/credits/select', async (_req, res) => {
  if (creditsFlagEnabled()) await primeCreditsInference();
  return res.json(creditsWiringReport());
});

export default router;
