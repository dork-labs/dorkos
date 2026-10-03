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
 * ## Who may write (DOR-2652)
 *
 * Every write here acts as the DorkOS account, on the one key this computer
 * holds, so every write is for the owner of this DorkOS and nobody
 * else: never an agent, and with login on never an API key or another signed-in
 * account (`routes/cloud-owner-bar.ts`). The reads stay open to any caller that
 * passed the session gate; they carry no credential and change nothing.
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
import { runtimeDisplayName, type RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type {
  CloudAccountDeletionResponse,
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
  requestAccountDeletion,
  requestAccountExport,
} from '../services/core/cloud/billing-pages.js';
import {
  creditsIsDefaultFor,
  dismissCreditsNotice,
  setCreditsDefault,
  undoFilledDefaults,
} from '../services/core/cloud/credits-defaults.js';
import { creditsKilled } from '../services/core/cloud/credits-availability.js';
import { creditsRuntimeViews, creditsStatus } from '../services/core/cloud/credits-runtimes.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  refuseEnvelopeUnlessOwner,
  refuseErrorUnlessOwner,
  type AccountOwnerWording,
} from './cloud-owner-bar.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import { logger, logError } from '../lib/logger.js';
import { createCloudCommunitiesRouter } from './cloud-communities.js';

const router = Router();

/**
 * What each account write says when it refuses a caller that is not the person
 * who owns this install (`routes/cloud-owner-bar.ts`). Every write below runs
 * the bar FIRST, before it reads its body or reaches the account, so a refused
 * caller learns nothing and changes nothing. Reads stay open: they carry no
 * credential and change nothing.
 */
const OWNER_ONLY = {
  linkStart: {
    personOnly: 'Only you can link this computer to a DorkOS account, from the DorkOS app.',
    action: 'link this computer to a DorkOS account',
  },
  linkCancel: {
    personOnly: 'Only you can stop linking this computer to a DorkOS account, from the DorkOS app.',
    action: 'stop linking this computer to a DorkOS account',
  },
  unlink: {
    personOnly: 'Only you can unlink this computer from its DorkOS account, from the DorkOS app.',
    action: 'unlink this computer from its DorkOS account',
  },
  linkCheck: {
    personOnly: 'Only you can check this computer’s DorkOS account link, from the DorkOS app.',
    action: 'check this computer’s DorkOS account link',
  },
  seats: {
    personOnly: 'Only you can change who holds a seat, from the DorkOS app.',
    action: 'change who holds a seat',
  },
  billing: {
    personOnly: 'Only you can open billing for your DorkOS account, from the DorkOS app.',
    action: 'open billing for the DorkOS account',
  },
  export: {
    personOnly: 'Only you can export your DorkOS account’s data, from the DorkOS app.',
    action: 'export the DorkOS account’s data',
  },
  deletion: {
    personOnly: 'Only you can delete your DorkOS account, from the DorkOS app while signed in.',
    action: 'delete the DorkOS account',
  },
  credits: {
    personOnly: 'Only you can choose what runs on your DorkOS credits, from the DorkOS app.',
    action: 'choose what runs on DorkOS credits',
  },
  creditsNotice: {
    personOnly: 'Only you can dismiss a note about your DorkOS credits, from the DorkOS app.',
    action: 'dismiss a note about DorkOS credits',
  },
} as const satisfies Record<string, AccountOwnerWording>;

/** Hosted communities: "Start a community" and "Move a community here". */
router.use('/communities', createCloudCommunitiesRouter());

/** POST /api/cloud/link/start — begin the device flow; returns codes to display. */
router.post('/link/start', async (req, res) => {
  if (refuseErrorUnlessOwner(req, res, OWNER_ONLY.linkStart)) return;
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

/**
 * GET /api/cloud/link/status — the live link-flow state machine.
 *
 * Open to every caller, like the other reads, except for the code itself: a
 * code waiting for approval links this computer to whichever account approves
 * it, so only the person who may start a link (the owner bar) is shown it.
 */
router.get('/link/status', (req, res) => {
  const { pending, ...status } = getCloudLinkManager().getStatus();
  const mayLink = refuseUnlessAccountOwner(req, res) === undefined;
  res.json(pending && mayLink ? { ...status, pending } : status);
});

/**
 * POST /api/cloud/link/cancel — stop a link flow in progress, or dismiss the
 * note a finished relink left. A token exchange already in flight finishes
 * first and a key it issues is kept. Answers the state it settled in:
 * `linked` while this computer holds a key, else `idle`.
 */
router.post('/link/cancel', async (req, res) => {
  if (refuseErrorUnlessOwner(req, res, OWNER_ONLY.linkCancel)) return;
  res.json(await getCloudLinkManager().cancelLink());
});

/** POST /api/cloud/unlink — withdraw locally before best-effort server-side revoke. */
router.post('/unlink', async (req, res) => {
  if (refuseErrorUnlessOwner(req, res, OWNER_ONLY.unlink)) return;
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
 * POST /api/cloud/link/check — ask the DorkOS account, now, whether it still
 * accepts this computer, and answer the settled summary that results. A
 * computer whose account was deleted comes back unlinked with its key cleared;
 * a service that cannot be reached keeps the link. Never an error.
 */
router.post('/link/check', async (req, res) => {
  // Owner-only, like the deletion it follows: it reaches the service on this
  // computer's key, and nothing an agent does needs it.
  if (refuseEnvelopeUnlessOwner(req, res, OWNER_ONLY.linkCheck)) return;
  res.json(await getCloudLinkManager().checkLink());
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
  const problem = problemOf(error);
  logger.warn(`[Cloud] Could not read ${what}`, {
    ...logError(error),
    code: problem?.code,
    status: problem?.status,
  });
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
   * What to tell the person when the service answers "not found". The service
   * gives the same answer for a route it does not serve and for a thing the
   * write named that it cannot find, so this one sentence has to be true in
   * both cases. Without it, such a refusal is passed through like any other.
   */
  absent?: string;
  /**
   * What to tell the person when the service gave no answer it could read (a
   * timeout, a broken body) for a write that may have done something anyway.
   * Without it, such a failure reads as the account being out of reach.
   */
  unconfirmed?: string;
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
 * people, so a write that can meet one names its own plain sentence in
 * `wording.absent`. That one sentence covers both things "not found" can mean
 * here, because the answer looks the same either way: the service does not
 * serve this write, or it cannot find what the write named.
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
  if (wording.absent !== undefined && isAbsent(error)) {
    return res.json({ ok: false, message: wording.absent } satisfies CloudWriteRefusal);
  }
  const problem = problemOf(error);
  if (problem !== null) {
    return res.json({ ok: false, problem } satisfies CloudWriteRefusal);
  }
  logger.warn(`[Cloud] Could not ${wording.what}`, logError(error));
  return res.json({
    ok: false,
    message: wording.unconfirmed ?? 'Couldn’t reach your DorkOS account. Try again shortly.',
  } satisfies CloudWriteRefusal);
}

/** Said, with HTTP 200, by every cloud write while this instance is not linked. */
const NOT_LINKED: CloudWriteRefusal = {
  ok: false,
  message: 'This instance is not linked to a DorkOS account.',
};

/** POST /api/cloud/seats/:seatId/assign — give a seat to a person or an agent. */
router.post('/seats/:seatId/assign', async (req, res) => {
  if (refuseEnvelopeUnlessOwner(req, res, OWNER_ONLY.seats)) return;
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
  if (refuseEnvelopeUnlessOwner(req, res, OWNER_ONLY.seats)) return;
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
  // Not found here is as likely an offer that left the list as a route not
  // served, so the sentence says only what is true of both.
  checkout: 'That plan isn’t available right now.',
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
  if (refuseEnvelopeUnlessOwner(req, res, OWNER_ONLY.billing)) return;
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
    });
  }
});

/**
 * POST /api/cloud/account/export — ask for a copy of everything the account
 * holds. When the answer already carries a download link, it is here; until
 * then, asking again is how to get it. Sent `no-store`.
 */
router.post('/account/export', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (refuseEnvelopeUnlessOwner(req, res, OWNER_ONLY.export)) return;
  if (!isCloudLinked()) return res.json(NOT_LINKED);
  try {
    const job = await requestAccountExport();
    const body: CloudAccountExportResponse = {
      ok: true,
      export: {
        requestedAt: job.requestedAt,
        readyAt: job.readyAt,
        downloadUrl: job.downloadUrl,
        emailRequested: job.emailRequested,
      },
    };
    return res.json(body);
  } catch (err) {
    return cloudWriteFailed(res, err, {
      what: 'request an account export',
      absent: 'Exporting your data isn’t available on your account yet.',
    });
  }
});

/**
 * POST /api/cloud/account/deletion — ask for the DorkOS account to be
 * deleted. Nothing is deleted here: the service emails the account a
 * confirmation link, and the account goes only when the person follows it.
 * Once it has, `POST /api/cloud/link/check` finds this computer unlinked.
 * A refusal answers 200, for the reason {@link cloudWriteFailed} gives.
 */
router.post('/account/deletion', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Only the owner of this DorkOS may ask to end the account, never an
  // agent: not one that names itself, not one holding an approval token, and,
  // with login on, not one presenting the person's API key instead of a
  // browser session, nor a person signed in to some other account.
  if (refuseEnvelopeUnlessOwner(req, res, OWNER_ONLY.deletion)) return;
  if (!isCloudLinked()) return res.json(NOT_LINKED);
  try {
    const deletion = await requestAccountDeletion();
    const body: CloudAccountDeletionResponse = {
      ok: true,
      deletion: {
        requestedAt: deletion.requestedAt,
        confirmationSentTo: deletion.confirmationSentTo,
        confirmBy: deletion.confirmBy,
      },
    };
    return res.json(body);
  } catch (err) {
    return cloudWriteFailed(res, err, {
      what: 'ask to delete the account',
      absent: 'Deleting your account from the app isn’t available on your account yet.',
      // The request may have reached the service, and the email gone, before
      // the answer was lost, so "couldn't reach" could be untrue.
      unconfirmed:
        'We couldn’t confirm your request went through. A link may already be on its way, so check your email before asking again.',
    });
  }
});

/**
 * GET /api/cloud/credits — whether DorkOS credits can be chosen here, which
 * runtimes they reach, who chose them as a default, and the notices owed about
 * choices made for the person. Carries no credential.
 */
router.get('/credits', async (_req, res) => {
  res.json(await creditsStatus());
});

const CreditsDefaultBodySchema = z.object({
  runtime: z.string().min(1),
  useCredits: z.boolean(),
});

/**
 * PUT /api/cloud/credits/default — a person's choice for one runtime's default:
 * run new work on DorkOS credits, or go back to the runtime's own sign-in.
 * Recorded as chosen by the person (ADR 261001-000811). Refuses a runtime
 * credits do not reach (undeclared, or its protocol not served), and turning
 * credits ON while they cannot be had,
 * so nothing is ever set that would refuse every turn.
 */
router.put('/credits/default', async (req, res) => {
  if (refuseErrorUnlessOwner(req, res, OWNER_ONLY.credits)) return;
  const parsed = CreditsDefaultBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Name a runtime and whether to use credits.' });
  }
  const { runtime, useCredits } = parsed.data;
  // A runtime whose credits choice moves the whole runtime (OpenCode: one
  // process, restarted on the other side) is not switched while it is in the
  // middle of a reply: that reply would end, or run on what was switched away
  // from. The person is told why, and nothing changes.
  const live = runtimeRegistry.listRuntimes().find((candidate) => candidate.type === runtime) as
    { hasRunningTurns?: () => boolean; getCapabilities(): RuntimeCapabilities } | undefined;
  // A change that changes nothing is never refused.
  const changes = creditsIsDefaultFor(runtime) !== useCredits;
  if (
    changes &&
    live?.getCapabilities().credits?.scope === 'runtime' &&
    live.hasRunningTurns?.() === true
  ) {
    return res.status(409).json({
      error: `${runtimeDisplayName(runtime)} is in the middle of a reply. Switch once it finishes, so nothing it is doing is cut off.`,
    });
  }
  if (useCredits) {
    const view = creditsRuntimeViews().find((candidate) => candidate.type === runtime);
    if (!view?.wired) {
      return res
        .status(400)
        .json({ error: `${runtimeDisplayName(runtime)} can't run on DorkOS credits yet.` });
    }
    if (creditsKilled()) {
      return res.status(409).json({ error: 'DorkOS credits are turned off on this computer.' });
    }
    if (!isCloudLinked()) {
      return res.status(409).json({ error: 'Sign in to your DorkOS account first.' });
    }
  }
  setCreditsDefault(runtime, useCredits);
  return res.json(await creditsStatus());
});

/**
 * POST /api/cloud/credits/undo-filled — put back every runtime DorkOS set to
 * credits on a new link, leaving the person's own picks alone ("Undo all").
 */
router.post('/credits/undo-filled', async (req, res) => {
  if (refuseErrorUnlessOwner(req, res, OWNER_ONLY.credits)) return;
  undoFilledDefaults();
  return res.json(await creditsStatus());
});

const CreditsNoticeDismissBodySchema = z.object({
  kind: z.enum(['filled', 'offer', 'signed-in']),
  runtime: z.string().min(1).optional(),
});

/** POST /api/cloud/credits/notices/dismiss — settle one notice without changing any choice. */
router.post('/credits/notices/dismiss', async (req, res) => {
  if (refuseErrorUnlessOwner(req, res, OWNER_ONLY.creditsNotice)) return;
  const parsed = CreditsNoticeDismissBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Name the notice to dismiss.' });
  dismissCreditsNotice(parsed.data);
  return res.json(await creditsStatus());
});

export default router;
