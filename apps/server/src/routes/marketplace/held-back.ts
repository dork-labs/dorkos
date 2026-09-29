/**
 * Marketplace routes: `/held-back`: global packages held back from sessions, raising their card again, and a person's decision.
 *
 * @module routes/marketplace/held-back
 */
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { DisclosedEffectsSchema } from '../../services/marketplace/preview/disclosed-effects.js';
import {
  decideHeldBackPackage,
  HeldBackDecisionError,
  HeldBackReviewError,
  listHeldBackPackages,
  reviewHeldBackPackage,
} from '../../services/marketplace/consent/ask-withheld-global-plugins.js';
import { trustedCaller } from '../../services/core/capabilities/index.js';
import { resolveDecisionAuthority } from '../../services/core/approvals/index.js';
import { OPERATOR_COOKIE_REQUIRED_CODE, readCallerAuthority } from '../../lib/caller-authority.js';
import type { MarketplaceRouteDeps } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import type { Router } from 'express';

/** Body schema for `POST /api/marketplace/held-back/:name/decision`. */
const HeldBackDecisionBodySchema = z
  .object({
    decision: z.enum(['allow', 'refuse']),
    // Exactly as `GET /held-back` listed them: what it runs, and what the
    // decision binds (an install's recorded hash, or `linked:<path>`).
    effects: DisclosedEffectsSchema,
    bindsTo: z.string().min(1),
  })
  .strict();

/**
 * Register the `/held-back` routes on the marketplace router.
 *
 * @param router - The marketplace router.
 * @param deps - The router's injected dependencies.
 * @param _ctx - The helpers every route group shares.
 */
export function mountHeldBackRoutes(
  router: Router,
  deps: MarketplaceRouteDeps,
  _ctx: MarketplaceRouteContext
): void {
  const { dorkHome, heldBackCards } = deps;

  // GET /held-back -- every global package held back from sessions, and why
  // (DOR-2306): what it runs, and the content hash a decision is bound to.
  router.get('/held-back', async (_req, res) => {
    try {
      return res.json({ packages: await listHeldBackPackages(dorkHome) });
    } catch (err) {
      logger.error('[Marketplace] Failed to list held-back packages', err);
      return res.status(500).json({ error: 'Failed to list held-back packages' });
    }
  });

  // POST /held-back/:name/review -- raise the approval card for a held-back
  // package again, because a person asked. Raising a card only ever asks a
  // person, so any caller may; deciding it is the person's.
  router.post('/held-back/:name/review', async (req, res) => {
    try {
      await reviewHeldBackPackage({ dorkHome, ...heldBackCards }, String(req.params.name));
      return res.status(202).json({ status: 'asked' });
    } catch (err) {
      if (err instanceof HeldBackReviewError) {
        return res.status(409).json({ error: err.message, code: 'not_reviewable' });
      }
      logger.error(`[Marketplace] Failed to raise a card for ${req.params.name}`, err);
      return res.status(500).json({ error: 'Failed to raise the approval card' });
    }
  });

  // POST /held-back/:name/decision -- a person's allow or refuse, made in the
  // terminal after seeing everything the package runs, bound to what they saw.
  // The same bar as deciding an approval card (`routes/approvals.ts`): a
  // trusted caller, which under login means a person's session cookie. An
  // agent, a caller holding an approval token, and an API key under login are
  // all refused; under login the terminal is pointed at the app's Review card.
  router.post('/held-back/:name/decision', async (req, res) => {
    const authority = readCallerAuthority(req, res);
    if (!trustedCaller(authority)) {
      if (!resolveDecisionAuthority(authority).allowed) {
        return res.status(403).json({
          error: 'Only you can decide whether a held-back package runs, not an agent.',
          code: 'operator_only',
        });
      }
      return res.status(403).json({
        error:
          'DorkOS requires sign-in, so this has to be decided by a person signed in to the app. ' +
          'Open DorkOS, go to Marketplace, then Installed, and press Review on the package.',
        code: OPERATOR_COOKIE_REQUIRED_CODE,
      });
    }
    const parsed = HeldBackDecisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }
    try {
      await decideHeldBackPackage(dorkHome, String(req.params.name), parsed.data.decision, {
        effects: parsed.data.effects,
        bindsTo: parsed.data.bindsTo,
      });
      if (parsed.data.decision === 'allow') await heldBackCards.onGranted();
      return res.status(204).send();
    } catch (err) {
      if (err instanceof HeldBackDecisionError) {
        return res.status(409).json({ error: err.message, code: 'not_decidable' });
      }
      logger.error(`[Marketplace] Failed to record a decision for ${req.params.name}`, err);
      return res.status(500).json({ error: 'Failed to record the decision' });
    }
  });
}
