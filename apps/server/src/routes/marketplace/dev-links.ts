/**
 * Marketplace routes: `/dev-links`: run a package from a folder on this
 * computer, list what runs that way, and switch back (DOR-2696).
 *
 * Making a link answers to the `marketplace.link` tier gate (destructive, no
 * permission area): the person in the app or their terminal runs it, an agent
 * gets an approval card naming the folder. Unlinking is the person's alone, on
 * the same bar as deciding an approval card.
 *
 * @module routes/marketplace/dev-links
 */
import { z } from 'zod';
import { DevLinkPackageNameSchema } from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../lib/logger.js';
import { trustedCaller } from '../../services/core/capabilities/index.js';
import { resolveDecisionAuthority } from '../../services/core/approvals/index.js';
import { OPERATOR_COOKIE_REQUIRED_CODE, readCallerAuthority } from '../../lib/caller-authority.js';
import { DevLinkError } from '../../services/marketplace/dev-links/errors.js';
import { readJsonBody } from '../../http/request-body.js';
import { honoRequestFacts } from '../../http/request-facts.js';
import type { MarketplaceRouteDeps, MarketplaceRoutes } from '../marketplace.js';
import type { MarketplaceContext, MarketplaceRouteContext } from './context.js';
import { validationFailed } from './shared.js';
import { DEV_LINK_PATH_MAX } from '../../services/marketplace-mcp/tool-link.js';

/** The folder field: required, and capped like the capability's own input. */
const PathField = z.string().min(1).max(DEV_LINK_PATH_MAX);

/**
 * The longest `expectedChange` accepted. Deliberately far above what one card
 * holds, so a folder that runs too much is refused by its own sentence
 * (`dev_link_card_too_long`) rather than a bare validation failure.
 */
const EXPECTED_CHANGE_MAX = 65_536;

/** Where a link goes: every session, or one project. */
const ScopeFields = {
  scope: z.enum(['global', 'project']),
  projectPath: z.string().min(1).optional(),
};

/** A project link names its project; a global one does not. */
function scopeIsConsistent(body: { scope: 'global' | 'project'; projectPath?: string }): boolean {
  return (body.scope === 'project') === (body.projectPath !== undefined);
}

/** Body schema for `POST /api/marketplace/dev-links/preview`. */
export const DevLinkPreviewBodySchema = z
  .object({
    path: PathField,
    ...ScopeFields,
    /** Describe the link as setting an installed copy aside, as the link would. */
    replaceInstalled: z.boolean().optional(),
  })
  .strict()
  .refine(scopeIsConsistent, {
    message: 'projectPath is required for, and only for, scope project',
  });

/** Body schema for `POST /api/marketplace/dev-links`. */
export const DevLinkCreateBodySchema = z
  .object({
    path: PathField,
    ...ScopeFields,
    replaceInstalled: z.boolean().optional(),
    /** Where the person is linking from, for the record. Ignored for an agent. */
    via: z.enum(['app', 'terminal']).optional(),
    /**
     * The preview's `change` text the person said yes to. Linking is refused
     * with `dev_link_changed` when the folder no longer describes the same
     * way. Ignored for an agent: its yes is bound by the approval card.
     */
    expectedChange: z.string().min(1).max(EXPECTED_CHANGE_MAX).optional(),
  })
  .strict()
  .refine(scopeIsConsistent, {
    message: 'projectPath is required for, and only for, scope project',
  });

/** Body schema for `POST /api/marketplace/dev-links/:name/unlink`. */
export const DevLinkUnlinkBodySchema = z.object(ScopeFields).strict().refine(scopeIsConsistent, {
  message: 'projectPath is required for, and only for, scope project',
});

/**
 * Register the `/dev-links` routes on the marketplace router.
 *
 * @param app - The marketplace routes.
 * @param deps - The router's injected dependencies.
 * @param ctx - The helpers every route group shares.
 */
export function mountDevLinkRoutes(
  app: MarketplaceRoutes,
  deps: MarketplaceRouteDeps,
  ctx: MarketplaceRouteContext
): void {
  /** The 503 that says the dev link service is not running here. */
  const unavailable = (c: MarketplaceContext): Response =>
    c.json({ error: "Dev links aren't available on this server right now." }, 503);

  /** Answer a refusal, or log anything else and answer 500. */
  const fail = (c: MarketplaceContext, err: unknown, what: string): Response => {
    if (err instanceof DevLinkError) return c.json(err.toBody(), err.status);
    logger.error(`[Marketplace] Failed to ${what}`, err);
    return c.json({ error: `Failed to ${what}` }, 500);
  };

  /** Parse a body, or the 400 that says it does not fit. */
  const parse = <T>(
    schema: z.ZodType<T>,
    c: MarketplaceContext
  ): { data: T; refused?: undefined } | { refused: Response } => {
    const parsed = schema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (parsed.success) return { data: parsed.data };
    return { refused: validationFailed(c, parsed.error) };
  };

  // GET /dev-links -- every dev link and whether it is in force.
  app.get('/dev-links', async (c) => {
    const devLinks = deps.devLinks;
    if (!devLinks) return unavailable(c);
    try {
      return c.json(await devLinks.list());
    } catch (err) {
      return fail(c, err, 'list dev links');
    }
  });

  // POST /dev-links/preview -- what linking a folder would do. Changes nothing.
  app.post('/dev-links/preview', async (c) => {
    const devLinks = deps.devLinks;
    if (!devLinks) return unavailable(c);
    const parsed = parse(DevLinkPreviewBodySchema, c);
    if (parsed.refused) return parsed.refused;
    const body = parsed.data;
    const confined = await ctx.confineProjectPath(c, body.projectPath);
    if (confined.refused) return confined.refused;
    try {
      return c.json(
        await devLinks.preview({
          path: body.path,
          scope: body.scope,
          ...(confined.projectPath ? { projectPath: confined.projectPath } : {}),
          ...(body.replaceInstalled ? { replaceInstalled: true } : {}),
        })
      );
    } catch (err) {
      return fail(c, err, 'preview the dev link');
    }
  });

  // POST /dev-links -- make the link. The tier gate decides first: the person
  // runs it, an agent gets a card naming the folder (202) or a refusal (403).
  app.post('/dev-links', async (c) => {
    const devLinks = deps.devLinks;
    if (!devLinks) return unavailable(c);
    const parsed = parse(DevLinkCreateBodySchema, c);
    if (parsed.refused) return parsed.refused;
    const body = parsed.data;
    // The project is confined first, so a path outside the boundary is refused
    // before anyone is shown a card for it.
    const confined = await ctx.confineProjectPath(c, body.projectPath);
    if (confined.refused) return confined.refused;
    const target = {
      path: body.path,
      scope: body.scope,
      ...(confined.projectPath ? { projectPath: confined.projectPath } : {}),
      ...(body.replaceInstalled ? { replaceInstalled: true } : {}),
    };
    try {
      // What the card says, read from the folder now and bound into the
      // approval. A folder that cannot be linked is refused here, with no card.
      const change = await devLinks.describeApproval(target);
      // The approval binds to what the caller sent, in the capability's own
      // shape, plus that description, so `dorkos call marketplace.link` and this
      // route mint and honour the same token.
      const decision = await ctx.authorize(
        c,
        'marketplace.link',
        {
          path: body.path,
          ...(body.projectPath !== undefined && { projectPath: body.projectPath }),
          ...(body.replaceInstalled !== undefined && { replaceInstalled: body.replaceInstalled }),
        },
        change
      );
      if (decision.outcome !== 'allowed') return ctx.gateResponse(c, decision);
      const person = !!trustedCaller(readCallerAuthority(honoRequestFacts(c)));
      const status = await devLinks.link({
        ...target,
        via: person ? (body.via ?? 'app') : 'agent-card',
        // A person's yes was given to the preview they read, possibly long
        // before this request, so it binds to that text. An agent's yes is the
        // card the gate just honoured, bound to `change`; what an agent sends
        // here never replaces it.
        expectedChange: person && body.expectedChange !== undefined ? body.expectedChange : change,
      });
      return c.json(status, 201);
    } catch (err) {
      return fail(c, err, 'link the folder');
    }
  });

  // POST /dev-links/:name/unlink -- the person only, on the bar for deciding
  // an approval card: unlinking changes which code runs.
  app.post('/dev-links/:name/unlink', async (c) => {
    const authority = readCallerAuthority(honoRequestFacts(c));
    if (!trustedCaller(authority)) {
      if (!resolveDecisionAuthority(authority).allowed) {
        return c.json(
          { error: 'Only you can unlink a dev link, not an agent.', code: 'operator_only' },
          403
        );
      }
      return c.json(
        {
          error: 'DorkOS requires sign-in, so only a person signed in to the app can unlink this.',
          code: OPERATOR_COOKIE_REQUIRED_CODE,
        },
        403
      );
    }
    const devLinks = deps.devLinks;
    if (!devLinks) return unavailable(c);
    const name = DevLinkPackageNameSchema.safeParse(c.req.param('name'));
    if (!name.success) return c.json({ error: 'That is not a package name.' }, 400);
    const parsed = parse(DevLinkUnlinkBodySchema, c);
    if (parsed.refused) return parsed.refused;
    const body = parsed.data;
    const confined = await ctx.confineProjectPath(c, body.projectPath);
    if (confined.refused) return confined.refused;
    try {
      return c.json(
        await devLinks.unlink({
          name: name.data,
          scope: body.scope,
          ...(confined.projectPath ? { projectPath: confined.projectPath } : {}),
        })
      );
    } catch (err) {
      return fail(c, err, 'unlink the dev link');
    }
  });
}
