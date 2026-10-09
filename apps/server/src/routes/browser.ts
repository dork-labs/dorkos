import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  BrowserCloseRequestSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
} from '@dorkos/shared/browser-schemas';
import { BrowserRegistryError } from '../services/browser/registry/errors.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { resolveDecisionAuthority } from '../services/core/approvals/decision-authority.js';
import { resolveCaller } from './room-caller.js';
import {
  BrowserApiRefusal,
  type BrowserApiActor,
  type BrowserApiService,
} from '../services/browser/api/service.js';

const Reference = BrowserReferenceSchema;
const InstanceQuery = z
  .object({
    browserGeneration: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .transform(Number)
      .pipe(BrowserCounterSchema),
  })
  .strict();

/** Reuse the actual cookie/local-trust posture, never an actor supplied over the wire. */
function readActor(req: Request, res: Response): BrowserApiActor | undefined {
  const authority = resolveDecisionAuthority(readCallerAuthority(req, res));
  if (!authority.allowed) return undefined;
  const user = res.locals.user as RequestUser | undefined;
  if (authority.posture === 'signed-in-operator' && user?.credential !== 'cookie') return undefined;
  const caller = resolveCaller(req, res);
  if (caller.kind !== 'human') return undefined;
  // With login off there is no cryptographic human proof (documented local-trust residual).
  // The original request is only a stable correlation identity; the posture is rechecked every time.
  return { owner: caller.id, credential: authority.posture === 'local-trust' ? req : user! };
}

/** Create owner-scoped browser metadata routes for the original service composition. */
export function createBrowserRouter(service: BrowserApiService): Router {
  const router = Router();
  const handle =
    (operation: (req: Request, actor: () => BrowserApiActor | undefined) => unknown) =>
    (req: Request, res: Response) => {
      try {
        return res.json(operation(req, () => readActor(req, res)));
      } catch (error) {
        if (error instanceof z.ZodError)
          return res.status(400).json({ error: 'Browser request couldn’t be read.' });
        if (error instanceof BrowserApiRefusal) {
          if (error.reason === 'unauthenticated')
            return res.status(401).json({ error: 'Sign in to access the shared browser' });
          if (error.reason === 'unavailable')
            return res.status(503).json({ error: 'Shared browser is unavailable' });
        }
        if (
          (error instanceof BrowserRegistryError &&
            ['inaccessible', 'staleBinding', 'stopped'].includes(error.reason)) ||
          (error instanceof BrowserApiRefusal && error.reason === 'inaccessible')
        )
          return res.status(404).json({ error: 'Browser resource not found' });
        if (error instanceof BrowserRegistryError)
          return res.status(503).json({ error: 'Shared browser is unavailable' });
        return res.status(500).json({ error: 'Shared browser request couldn’t be completed.' });
      }
    };
  router.get(
    '/profiles',
    handle((_req, actor) => ({ profiles: service.profiles(actor) }))
  );
  router.get(
    '/profiles/:profileId',
    handle((req, actor) => service.profile(actor, Reference.parse(req.params.profileId)))
  );
  router.get(
    '/instances',
    handle((_req, actor) => ({ instances: service.instances(actor) }))
  );
  router.get(
    '/instances/:browserId',
    handle((req, actor) =>
      service.instance(
        actor,
        Reference.parse(req.params.browserId),
        InstanceQuery.parse(req.query).browserGeneration
      )
    )
  );
  router.post(
    '/instances/close',
    handle((req, actor) => service.close(actor, BrowserCloseRequestSchema.parse(req.body)))
  );
  return router;
}
