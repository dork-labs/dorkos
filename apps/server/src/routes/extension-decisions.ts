/**
 * The routes the bell and the Activity inbox answer an extension's decisions
 * through (spec `flow-multiproject` §7.3, §7.8).
 *
 * | Route                                      | Bar                  |
 * | ------------------------------------------ | -------------------- |
 * | `GET /api/extension-decisions`             | normal API auth      |
 * | `POST /api/extension-decisions/:id/action` | `refuseIfNotAPerson` |
 * | `POST /api/extension-decisions/:id/offer`  | `refuseIfNotAPerson` |
 *
 * These are **core UI endpoints**: no `ExtensionAPI` member reaches them, and
 * an answer here is attributed to the person. An extension's own page answers
 * through `/api/extensions/:id/decisions/…` instead, attributed to the
 * extension (`routes/extensions-inbox.ts`).
 *
 * **The residual, stated as at every route on this bar** (invariant 9): the
 * bar refuses callers that name themselves agents and, with Require login on,
 * anything without the person's cookie. It cannot tell a person from an
 * approved extension's own page code, which shares the app's origin and could
 * `fetch` these URLs. That is the trust a person grants when they turn an
 * extension on; it is documented, not prevented.
 *
 * @module routes/extension-decisions
 */
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { holdRemoteExtensionAnswer } from './extension-decision-step-up.js';
import { deskGoesOnWithoutSheet } from './step-up-guard.js';
import {
  grantsPower,
  refuseApprovalYesFromWifi,
} from '../services/core/approvals/model/approval-answer-policy.js';
import type { StepUpCommitResult } from '../services/core/auth/step-up/step-up-holds.js';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  DecisionActionRequestSchema,
  DecisionOfferRequestSchema,
  ListExtensionDecisionsQuerySchema,
} from '@dorkos/shared/extension-decision-schemas';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { getExtensionInbox } from '../services/extensions/inbox/extension-inbox.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { logger } from '../lib/logger.js';
import { refuseStandingYesFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** Core's id for a decision: a ULID. */
const DECISION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** What the answer routes say when a bar refuses them. */
export const DECISION_BAR: PersonBarCopy = {
  error: 'Only a person can answer this.',
  code: 'decision_person_required',
  subject: 'answers to extension decisions',
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can answer this.`,
  agent: 'DorkOS changed nothing. Only a person can answer this. Ask them to answer it in DorkOS.',
};

/** The answer for "the inbox is not up". */
const INBOX_NOT_READY = { error: 'The inbox is not available yet.' };

/**
 * Record that a person's "Yes" changed an extension's per-project settings.
 *
 * @param activity - The Activity feed, when the server has one.
 * @param caller - The request's facts, for who acted.
 * @param changed - What was changed.
 */
export async function recordSettingsChange(
  activity: Pick<ActivityService, 'emit'> | undefined,
  caller: Pick<RequestFacts, 'headers' | 'agentIdentity'>,
  changed: { extensionId: string; extensionName: string; projectName: string }
): Promise<void> {
  if (!activity) return;
  try {
    await activity.emit({
      ...readActivityActor(caller),
      category: 'config',
      eventType: 'config.extension_project_settings_updated',
      resourceType: 'extension',
      resourceId: changed.extensionId,
      resourceLabel: changed.extensionName,
      summary: `${changed.extensionName} settings for ${changed.projectName} changed`,
    });
  } catch (err) {
    logger.warn('[Extensions] Could not record a project settings change', err);
  }
}

/** What the `/api/extension-decisions` routes read. */
export interface ExtensionDecisionsRouterDeps {
  /** The Activity feed a settings change is recorded in, when the server has one. */
  activity?: Pick<ActivityService, 'emit'>;
}

/**
 * The `/api/extension-decisions` routes.
 *
 * @param deps - See {@link ExtensionDecisionsRouterDeps}.
 * @returns The routes, for `app.route('/api/extension-decisions', …)`.
 */
export function createExtensionDecisionsRoutes(
  deps: ExtensionDecisionsRouterDeps = {}
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // GET /api/extension-decisions -- Open decisions of running extensions, and
  // follow-up offers a person has not answered yet.
  router.get('/', (c) => {
    const query = ListExtensionDecisionsQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json({ error: 'Invalid query' }, 400);
    const inbox = getExtensionInbox();
    if (!inbox) return c.json(INBOX_NOT_READY, 503);
    return c.json({
      decisions: inbox.listOpen(query.data.extensionId).map((decision) => ({
        ...decision,
        // Every yes away from this computer is held (no extension declares its effect yet).
        answerNeedsStepUp: !isAtThisComputer(honoRequestFacts(c)),
      })),
      // An offer is lasting, so it is held at the desk too unless no sheet could answer there.
      offers: inbox
        .pendingOffers()
        .map((offer) => ({
          ...offer,
          answerNeedsStepUp: !deskGoesOnWithoutSheet(honoRequestFacts(c)),
        })),
    });
  });

  // POST /api/extension-decisions/:id/action -- A person answers in the bell or
  // the inbox. Calls the extension's handler, then resolves or keeps it open.
  router.post('/:id/action', async (c) => {
    try {
      const id = c.req.param('id');
      if (!DECISION_ID.test(id)) return c.json({ error: 'Not found' }, 404);
      const refused = refusedNotAPerson(c, DECISION_BAR);
      if (refused) return refused;
      const body = DecisionActionRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
      if (!body.success) {
        return c.json({ error: 'Send an action, and keep notes under 2000 characters.' }, 400);
      }
      const inbox = getExtensionInbox();
      if (!inbox) return c.json(INBOX_NOT_READY, 503);
      const run = async (facts: RequestFacts): Promise<StepUpCommitResult> => {
        const outcome = await inbox.answer(id, body.data, { kind: 'person' });
        if (!outcome.ok)
          return { status: outcome.status, body: { error: outcome.message, code: outcome.code } };
        const offer = outcome.response.offer;
        return {
          status: 200,
          body: {
            ...outcome.response,
            offer: offer
              ? {
                  ...offer,
                  requestCode: inbox.stepUpView(id, 'offer')?.requestCode,
                  answerNeedsStepUp: !deskGoesOnWithoutSheet(facts),
                }
              : null,
          },
        };
      };
      if (grantsPower({ kind: body.data.action === 'reject' ? 'reject' : 'extension-answer' })) {
        const held = holdRemoteExtensionAnswer(
          c,
          { id, kind: 'decision', inbox, copy: DECISION_BAR },
          run
        );
        if (held) return held;
      }
      const outcome = await run(honoRequestFacts(c));
      return c.json(outcome.body as never, outcome.status as ContentfulStatusCode);
    } catch (err) {
      logger.error('[Extensions] Failed to answer a decision', err);
      return c.json({ error: 'Failed to answer the decision' }, 500);
    }
  });

  // POST /api/extension-decisions/:id/offer -- "Yes" or a quiet dismiss on the
  // one-time "next time, on its own?" line. Either way it is used up.
  router.post('/:id/offer', async (c) => {
    try {
      const id = c.req.param('id');
      if (!DECISION_ID.test(id)) return c.json({ error: 'Not found' }, 404);
      const refused = refusedNotAPerson(c, DECISION_BAR);
      if (refused) return refused;
      const body = DecisionOfferRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
      if (!body.success) return c.json({ error: 'Send { accept: true | false }.' }, 400);
      const wifi = body.data.accept ? refuseApprovalYesFromWifi(honoRequestFacts(c)) : undefined;
      if (wifi) return c.json(wifi, 403);
      // "Next time, on its own" is a standing yes: never from Wi-Fi (DOR-2969).
      const standing = refuseStandingYesFromWifi(honoRequestFacts(c), body.data.accept);
      if (standing) return c.json(standing, 403);
      const inbox = getExtensionInbox();
      if (!inbox) return c.json(INBOX_NOT_READY, 503);
      const run = async (facts: RequestFacts): Promise<StepUpCommitResult> => {
        const outcome = await inbox.answerOffer(id, body.data.accept);
        if (!outcome.ok)
          return { status: outcome.status, body: { error: outcome.message, code: outcome.code } };
        if (outcome.settingsChanged)
          await recordSettingsChange(deps.activity, facts, outcome.settingsChanged);
        return { status: 200, body: { message: outcome.message } };
      };
      if (grantsPower({ kind: body.data.accept ? 'offer-accept' : 'dismiss' })) {
        const held = holdRemoteExtensionAnswer(
          c,
          { id, kind: 'offer', inbox, copy: DECISION_BAR },
          run
        );
        if (held) return held;
      }
      const outcome = await run(honoRequestFacts(c));
      return c.json(outcome.body as never, outcome.status as ContentfulStatusCode);
    } catch (err) {
      logger.error('[Extensions] Failed to answer an offer', err);
      return c.json({ error: 'Failed to answer the offer' }, 500);
    }
  });

  return router;
}
