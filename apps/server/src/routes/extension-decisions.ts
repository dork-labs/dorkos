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
import { Router, type Request, type Response } from 'express';
import {
  DecisionActionRequestSchema,
  DecisionOfferRequestSchema,
  ListExtensionDecisionsQuerySchema,
} from '@dorkos/shared/extension-decision-schemas';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { getExtensionInbox } from '../services/extensions/inbox/extension-inbox.js';
import { logger } from '../lib/logger.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

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

/** Answer "the inbox is not up" in one place. */
function inboxOr503(res: Response) {
  const inbox = getExtensionInbox();
  if (!inbox) res.status(503).json({ error: 'The inbox is not available yet.' });
  return inbox;
}

/**
 * Record that a person's "Yes" changed an extension's per-project settings.
 *
 * @param req - The request (for who acted).
 * @param res - The response (for who acted).
 * @param changed - What was changed.
 */
export async function recordSettingsChange(
  req: Request,
  res: Response,
  changed: { extensionId: string; extensionName: string; projectName: string }
): Promise<void> {
  const activityService = req.app.locals.activityService as ActivityService | undefined;
  if (!activityService) return;
  try {
    await activityService.emit({
      ...readActivityActor(req, res),
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

/** Build the `/api/extension-decisions` router. */
export function createExtensionDecisionsRouter(): Router {
  const router = Router();

  // GET /api/extension-decisions -- Open decisions of running extensions, and
  // follow-up offers a person has not answered yet.
  router.get('/', (req, res) => {
    const query = ListExtensionDecisionsQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid query' });
    const inbox = inboxOr503(res);
    if (!inbox) return undefined;
    return res.json({
      decisions: inbox.listOpen(query.data.extensionId),
      offers: inbox.pendingOffers(),
    });
  });

  // POST /api/extension-decisions/:id/action -- A person answers in the bell or
  // the inbox. Calls the extension's handler, then resolves or keeps it open.
  router.post('/:id/action', async (req, res) => {
    try {
      if (!DECISION_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
      if (refuseIfNotAPerson(req, res, DECISION_BAR)) return undefined;
      const body = DecisionActionRequestSchema.safeParse(req.body ?? {});
      if (!body.success) {
        return res
          .status(400)
          .json({ error: 'Send an action, and keep notes under 2000 characters.' });
      }
      const inbox = inboxOr503(res);
      if (!inbox) return undefined;
      const outcome = await inbox.answer(req.params.id, body.data, { kind: 'person' });
      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.message, code: outcome.code });
      }
      return res.json(outcome.response);
    } catch (err) {
      logger.error('[Extensions] Failed to answer a decision', err);
      return res.status(500).json({ error: 'Failed to answer the decision' });
    }
  });

  // POST /api/extension-decisions/:id/offer -- "Yes" or a quiet dismiss on the
  // one-time "next time, on its own?" line. Either way it is used up.
  router.post('/:id/offer', async (req, res) => {
    try {
      if (!DECISION_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
      if (refuseIfNotAPerson(req, res, DECISION_BAR)) return undefined;
      const body = DecisionOfferRequestSchema.safeParse(req.body ?? {});
      if (!body.success) return res.status(400).json({ error: 'Send { accept: true | false }.' });
      const inbox = inboxOr503(res);
      if (!inbox) return undefined;
      const outcome = await inbox.answerOffer(req.params.id, body.data.accept);
      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.message, code: outcome.code });
      }
      if (outcome.settingsChanged) await recordSettingsChange(req, res, outcome.settingsChanged);
      return res.json({ message: outcome.message });
    } catch (err) {
      logger.error('[Extensions] Failed to answer an offer', err);
      return res.status(500).json({ error: 'Failed to answer the offer' });
    }
  });

  return router;
}
