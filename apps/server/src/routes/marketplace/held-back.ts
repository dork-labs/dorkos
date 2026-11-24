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
import { readCallerAuthority } from '../../lib/caller-authority.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { honoRequestFacts } from '../../http/request-facts.js';
import type { MarketplaceRouteDeps, MarketplaceRoutes } from '../marketplace.js';
import type { MarketplaceContext, MarketplaceRouteContext } from './context.js';
import { validationFailed } from './shared.js';
import { runFrontDoorWrite } from '../front-door-step-up.js';

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
      return problem(c, 'internal_error', {
        detail: "Couldn't list held-back packages. Try again.",
      });
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
        logger.info(`[Marketplace] No card raised for ${name}`, { error: err.message });
        return problem(c, 'conflict', {
          detail: 'This package has nothing to review right now.',
        });
      }
      logger.error(`[Marketplace] Failed to raise a card for ${name}`, err);
      return problem(c, 'internal_error', {
        detail: "Couldn't raise the approval card. Try again.",
      });
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
        return problem(c, 'operator_only', {
          detail: 'Only you can decide whether a held-back package runs, not an agent.',
        });
      }
      return problem(c, 'person_only', {
        detail:
          'DorkOS requires sign-in. In the app, open Marketplace, Installed, and press Review.',
      });
    }
    const parsed = HeldBackDecisionBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) return validationFailed(c, parsed.error);
    const { decision, effects, bindsTo } = parsed.data;
    const decide = async (): Promise<Response> => {
      try {
        await decideHeldBackPackage(dorkHome, name, decision, { effects, bindsTo });
        if (decision === 'allow') await heldBackCards.onGranted();
        return c.body(null, 204);
      } catch (err) {
        return decisionFailed(c, name, err);
      }
    };
    // Refusing keeps it from running, so it is recorded at once.
    if (decision === 'refuse') return decide();
    try {
      // A package that is not held back is refused before anyone is asked.
      const held = await listHeldBackPackages(dorkHome, { bindings: false });
      if (!held.some((pkg) => pkg.name === name)) {
        throw new HeldBackDecisionError(`${name} is not held back.`);
      }
      // Allowing it lets its code run in every session, so the owner confirms
      // it's them first (DOR-4355).
      return await runFrontDoorWrite(c, {
        kind: 'marketplace.install',
        target: name,
        input: { name, decision, effects, bindsTo },
        reason: `Let ${name} run in every session.`,
        subject: 'which code runs here',
        run: decide,
      });
    } catch (err) {
      return decisionFailed(c, name, err);
    }
  });
}

/** Answer a decision that was not recorded: 409 `conflict` when it cannot be decided as shown, else 500. */
function decisionFailed(c: MarketplaceContext, name: string, err: unknown): Response {
  if (err instanceof HeldBackDecisionError) {
    logger.info(`[Marketplace] Decision for ${name} not recorded`, { error: err.message });
    return problem(c, 'conflict', {
      detail: "That package isn't held back as shown. Check again, then decide.",
    });
  }
  logger.error(`[Marketplace] Failed to record a decision for ${name}`, err);
  return problem(c, 'internal_error', { detail: "Couldn't record the decision. Try again." });
}
