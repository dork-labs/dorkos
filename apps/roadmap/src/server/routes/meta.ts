/**
 * Route for roadmap project metadata and health stats.
 *
 * Mounts at `/api/roadmap/meta`.
 *
 * @module server/routes/meta
 */
import { Router } from 'express';
import type { RoadmapStore } from '../services/roadmap-store.js';

/**
 * Create the meta router with an injected RoadmapStore.
 *
 * @param store - Initialized RoadmapStore instance
 */
export function createMetaRouter(store: RoadmapStore): Router {
  const router = Router();

  // GET /api/roadmap/meta — project metadata with health stats
  router.get('/', (_req, res) => {
    const meta = store.getMeta();
    res.json(meta);
  });

  return router;
}
