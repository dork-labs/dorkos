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
import type {
  CloudMembersResponse,
  CloudNudgeResponse,
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
import { cloudInstanceRef, isCloudLinked, problemOf } from '../services/core/cloud/v1-client.js';
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

/** POST /api/cloud/unlink — best-effort server-side revoke, then clear local state. */
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

/**
 * Answer a seat write, translating a refusal the service described into the
 * problem envelope the client renders verbatim.
 *
 * This is the whole reason the app can say "this needs a plan change" without
 * knowing a single plan: the words, including `requiredPlanDisplayName`, are the
 * service's.
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
 */
function seatWriteFailed(res: Response, error: unknown) {
  const problem = problemOf(error);
  if (problem !== null) {
    return res.json({ ok: false, problem } satisfies CloudSeatActionResponse);
  }
  logger.warn('[Cloud] Seat action failed', logError(error));
  return res.json({
    ok: false,
    message: 'Could not reach the DorkOS cloud. Try again shortly.',
  } satisfies CloudSeatActionResponse);
}

/** POST /api/cloud/seats/:seatId/assign — give a seat to a person or an agent. */
router.post('/seats/:seatId/assign', async (req, res) => {
  // 200 with a refusal envelope, for the reason {@link seatWriteFailed} gives.
  if (!isCloudLinked()) {
    return res.json({ ok: false, message: 'This instance is not linked to a DorkOS account.' });
  }
  const parsed = SeatAssignBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, message: 'Unknown subject' });
  try {
    const seat = await assignSeat(req.params.seatId, parsed.data.subject);
    return res.json({ ok: true, seat } satisfies CloudSeatActionResponse);
  } catch (err) {
    return seatWriteFailed(res, err);
  }
});

/** POST /api/cloud/seats/:seatId/release — hand a seat back. */
router.post('/seats/:seatId/release', async (req, res) => {
  if (!isCloudLinked()) {
    return res.json({ ok: false, message: 'This instance is not linked to a DorkOS account.' });
  }
  try {
    await releaseSeat(req.params.seatId);
    return res.json({ ok: true } satisfies CloudSeatActionResponse);
  } catch (err) {
    return seatWriteFailed(res, err);
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
  const instanceRef = cloudInstanceRef();
  if (creditsFlagEnabled() && instanceRef !== null) await primeCreditsInference(instanceRef);
  return res.json(creditsWiringReport());
});

export default router;
