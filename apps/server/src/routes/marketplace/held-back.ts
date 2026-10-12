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
import { readJsonBody } from '../../http/request-body.js';
import { honoRequestFacts } from '../../http/request-facts.js';
import type { MarketplaceRouteDeps, MarketplaceRoutes } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import { validationFailed } from './shared.js';

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
 * @param app - The marketplace routes.
 * @param deps - The router's injected dependencies.
 * @param _ctx - The helpers every route group shares.
 */
export function mountHeldBackRoutes(
  app: MarketplaceRoutes,
  deps: MarketplaceRouteDeps,
  _ctx: MarketplaceRouteContext
): void {
  const { dorkHome, heldBackCards } = deps;

  // GET /held-back -- every global package held back from sessions, and why
  // (DOR-2306): what it runs, and the content hash a decision is bound to.
  app.get('/held-back', async (c) => {
    try {
      return c.json({ packages: await listHeldBackPackages(dorkHome) });
    } catch (err) {
      logger.error('[Marketplace] Failed to list held-back packages', err);
      return c.json({ error: 'Failed to list held-back packages' }, 500);
    }
  });

  // POST /held-back/:name/review -- raise the approval card for a held-back
  // package again, because a person asked. Raising a card only ever asks a
  // person, so any caller may; deciding it is the person's.
  app.post('/held-back/:name/review', async (c) => {
    const name = c.req.param('name');
    try {
      await reviewHeldBackPackage({ dorkHome, ...heldBackCards }, name);
      return c.json({ status: 'asked' }, 202);
    } catch (err) {
      if (err instanceof HeldBackReviewError) {
        return c.json({ error: err.message, code: 'not_reviewable' }, 409);
      }
      logger.error(`[Marketplace] Failed to raise a card for ${name}`, err);
      return c.json({ error: 'Failed to raise the approval card' }, 500);
    }
  });

  // POST /held-back/:name/decision -- a person's allow or refuse, made in the
  // terminal after seeing everything the package runs, bound to what they saw.
  // The same bar as deciding an approval card (`routes/approvals.ts`): a
  // trusted caller, which under login means a person's session cookie. An
  // agent, a caller holding an approval token, and an API key under login are
  // all refused; under login the terminal is pointed at the app's Review card.
  app.post('/held-back/:name/decision', async (c) => {
    const name = c.req.param('name');
    const authority = readCallerAuthority(honoRequestFacts(c));
    if (!trustedCaller(authority)) {
      if (!resolveDecisionAuthority(authority).allowed) {
        return c.json(
          {
            error: 'Only you can decide whether a held-back package runs, not an agent.',
            code: 'operator_only',
          },
          403
        );
      }
      return c.json(
        {
          error:
            'DorkOS requires sign-in, so this has to be decided by a person signed in to the app. ' +
            'Open DorkOS, go to Marketplace, then Installed, and press Review on the package.',
          code: OPERATOR_COOKIE_REQUIRED_CODE,
        },
        403
      );
    }
    const parsed = HeldBackDecisionBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) return validationFailed(c, parsed.error);
    try {
      await decideHeldBackPackage(dorkHome, name, parsed.data.decision, {
        effects: parsed.data.effects,
        bindsTo: parsed.data.bindsTo,
      });
      if (parsed.data.decision === 'allow') await heldBackCards.onGranted();
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof HeldBackDecisionError) {
        return c.json({ error: err.message, code: 'not_decidable' }, 409);
      }
      logger.error(`[Marketplace] Failed to record a decision for ${name}`, err);
      return c.json({ error: 'Failed to record the decision' }, 500);
    }
  });
}
