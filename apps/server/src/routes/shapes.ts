/**
 * Shape routes (DOR-355, spec §9) — list, apply, and fork installed Shapes.
 *
 * - `GET  /api/shapes` — installed Shapes (name, displayName, active flag, lineage).
 * - `POST /api/shapes/:name/apply` — apply a Shape; returns the exact §5 value
 *   `{ ok, applied, warnings[], offeredAgents[] }` so the client restores the
 *   chrome (`applied.layout`) without a second fetch.
 * - `POST /api/shapes/:name/fork` — fork a Shape (body `{ as?, captureCurrent? }`).
 *
 * The router holds no I/O of its own — every collaborator is injected, so it is
 * driven with fakes in tests and the real singletons in `index.ts`.
 *
 * @module routes/shapes
 */
import { Router } from 'express';
import { ForkShapeRequestSchema } from '@dorkos/shared/schemas';
import { parseBody } from '../lib/route-utils.js';
import {
  applyShape,
  ShapeNotInstalledError,
  type ApplyShapeDeps,
} from '../services/shapes/apply-shape.js';
import { forkShape, ShapeForkConflictError, type ForkShapeDeps } from '../services/shapes/fork.js';
import { listInstalledShapes } from '../services/shapes/shape-services.js';

/** Constructor dependencies for {@link createShapesRouter}. */
export interface ShapesRouterDeps {
  /** Resolved DorkOS data directory. */
  dorkHome: string;
  /** Injected collaborators for the apply flow. */
  applyDeps: ApplyShapeDeps;
  /** Injected collaborators for the fork flow. */
  forkDeps: ForkShapeDeps;
}

/**
 * Create the Shapes router.
 *
 * @param deps - Injected data directory + apply/fork collaborators.
 * @returns An Express router mounted at `/api/shapes`.
 */
export function createShapesRouter(deps: ShapesRouterDeps): Router {
  const router = Router();

  // GET /api/shapes — installed Shapes, active flag resolved from config.
  router.get('/', async (_req, res) => {
    const active = deps.applyDeps.configStore.getShapePrefs().active;
    const shapes = await listInstalledShapes(deps.dorkHome, active);
    res.json({ shapes });
  });

  // POST /api/shapes/:name/apply — apply a Shape. Only "not installed" is fatal.
  router.post('/:name/apply', async (req, res) => {
    try {
      const result = await applyShape(req.params.name, deps.applyDeps);
      res.json(result);
    } catch (err) {
      if (err instanceof ShapeNotInstalledError) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  });

  // POST /api/shapes/:name/fork — fork a Shape.
  router.post('/:name/fork', async (req, res) => {
    // Express 5 leaves `req.body` undefined on an empty POST; every field is
    // optional, so default to `{}` (fork with all defaults).
    const body = parseBody(ForkShapeRequestSchema, req.body ?? {}, res);
    if (!body) return;
    try {
      const result = await forkShape(req.params.name, body, deps.forkDeps);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof ShapeNotInstalledError) {
        return res.status(404).json({ error: err.message });
      }
      if (err instanceof ShapeForkConflictError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  });

  return router;
}
