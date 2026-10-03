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
import type { Request, Response, Router } from 'express';
import { DevLinkPackageNameSchema } from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../lib/logger.js';
import { trustedCaller } from '../../services/core/capabilities/index.js';
import { resolveDecisionAuthority } from '../../services/core/approvals/index.js';
import { OPERATOR_COOKIE_REQUIRED_CODE, readCallerAuthority } from '../../lib/caller-authority.js';
import { DevLinkError } from '../../services/marketplace/dev-links/errors.js';
import type { DevLinkService } from '../../services/marketplace/dev-links/index.js';
import type { MarketplaceRouteDeps } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';

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
  .object({ path: z.string().min(1), ...ScopeFields })
  .strict()
  .refine(scopeIsConsistent, {
    message: 'projectPath is required for, and only for, scope project',
  });

/** Body schema for `POST /api/marketplace/dev-links`. */
export const DevLinkCreateBodySchema = z
  .object({
    path: z.string().min(1),
    ...ScopeFields,
    replaceInstalled: z.boolean().optional(),
    /** Where the person is linking from, for the record. Ignored for an agent. */
    via: z.enum(['app', 'terminal']).optional(),
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
 * @param router - The marketplace router.
 * @param deps - The router's injected dependencies.
 * @param ctx - The helpers every route group shares.
 */
export function mountDevLinkRoutes(
  router: Router,
  deps: MarketplaceRouteDeps,
  ctx: MarketplaceRouteContext
): void {
  /** The service, or the 503 that says it is not running here. */
  const service = (res: Response): DevLinkService | undefined => {
    if (deps.devLinks) return deps.devLinks;
    res.status(503).json({ error: "Dev links aren't available on this server right now." });
    return undefined;
  };

  /** Answer a refusal or rethrow anything else. */
  const fail = (res: Response, err: unknown, what: string): Response => {
    if (err instanceof DevLinkError) return res.status(err.status).json(err.toBody());
    logger.error(`[Marketplace] Failed to ${what}`, err);
    return res.status(500).json({ error: `Failed to ${what}` });
  };

  /** Parse a body, answering 400 when it does not fit. */
  const parse = <T>(schema: z.ZodType<T>, req: Request, res: Response): T | undefined => {
    const parsed = schema.safeParse(req.body ?? {});
    if (parsed.success) return parsed.data;
    res.status(400).json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    return undefined;
  };

  // GET /dev-links -- every dev link and whether it is in force.
  router.get('/dev-links', async (_req, res) => {
    const devLinks = service(res);
    if (!devLinks) return;
    try {
      return res.json(await devLinks.list());
    } catch (err) {
      return fail(res, err, 'list dev links');
    }
  });

  // POST /dev-links/preview -- what linking a folder would do. Changes nothing.
  router.post('/dev-links/preview', async (req, res) => {
    const devLinks = service(res);
    if (!devLinks) return;
    const body = parse(DevLinkPreviewBodySchema, req, res);
    if (!body) return;
    const confined = await ctx.confineProjectPath(res, body.projectPath);
    if (confined.refused) return confined.refused;
    try {
      return res.json(
        await devLinks.preview({
          path: body.path,
          scope: body.scope,
          ...(confined.projectPath ? { projectPath: confined.projectPath } : {}),
        })
      );
    } catch (err) {
      return fail(res, err, 'preview the dev link');
    }
  });

  // POST /dev-links -- make the link. The tier gate decides first: the person
  // runs it, an agent gets a card naming the folder (202) or a refusal (403).
  router.post('/dev-links', async (req, res) => {
    const devLinks = service(res);
    if (!devLinks) return;
    const body = parse(DevLinkCreateBodySchema, req, res);
    if (!body) return;
    // The approval binds to what the caller sent, in the capability's own
    // shape, so `dorkos call marketplace.link` and this route mint and honour
    // the same token.
    const decision = await ctx.authorize(req, res, 'marketplace.link', {
      path: body.path,
      ...(body.projectPath !== undefined && { projectPath: body.projectPath }),
      ...(body.replaceInstalled !== undefined && { replaceInstalled: body.replaceInstalled }),
    });
    if (decision.outcome !== 'allowed') return ctx.gateResponse(res, decision);
    const confined = await ctx.confineProjectPath(res, body.projectPath);
    if (confined.refused) return confined.refused;
    const person = !!trustedCaller(readCallerAuthority(req, res));
    try {
      const status = await devLinks.link({
        path: body.path,
        scope: body.scope,
        ...(confined.projectPath ? { projectPath: confined.projectPath } : {}),
        ...(body.replaceInstalled ? { replaceInstalled: true } : {}),
        via: person ? (body.via ?? 'app') : 'agent-card',
      });
      return res.status(201).json(status);
    } catch (err) {
      return fail(res, err, 'link the folder');
    }
  });

  // POST /dev-links/:name/unlink -- the person only, on the bar for deciding
  // an approval card: unlinking changes which code runs.
  router.post('/dev-links/:name/unlink', async (req, res) => {
    const authority = readCallerAuthority(req, res);
    if (!trustedCaller(authority)) {
      if (!resolveDecisionAuthority(authority).allowed) {
        return res.status(403).json({
          error: 'Only you can unlink a dev link, not an agent.',
          code: 'operator_only',
        });
      }
      return res.status(403).json({
        error: 'DorkOS requires sign-in, so only a person signed in to the app can unlink this.',
        code: OPERATOR_COOKIE_REQUIRED_CODE,
      });
    }
    const devLinks = service(res);
    if (!devLinks) return;
    const name = DevLinkPackageNameSchema.safeParse(req.params.name);
    if (!name.success) return res.status(400).json({ error: 'That is not a package name.' });
    const body = parse(DevLinkUnlinkBodySchema, req, res);
    if (!body) return;
    const confined = await ctx.confineProjectPath(res, body.projectPath);
    if (confined.refused) return confined.refused;
    try {
      return res.json(
        await devLinks.unlink({
          name: name.data,
          scope: body.scope,
          ...(confined.projectPath ? { projectPath: confined.projectPath } : {}),
        })
      );
    } catch (err) {
      return fail(res, err, 'unlink the dev link');
    }
  });
}
