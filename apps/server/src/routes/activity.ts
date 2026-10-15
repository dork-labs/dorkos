/**
 * Activity feed routes — query paginated activity events.
 *
 * @module routes/activity
 */
import { Hono } from 'hono';
import { ListActivityQuerySchema } from '@dorkos/shared/activity-schemas';
import { validationFailureBody } from '../lib/route-utils.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import type { ActivityService } from '../services/activity/activity-service.js';

/**
 * The `/api/activity` routes: the list endpoint.
 *
 * @param activityService - ActivityService instance for querying events
 * @returns The routes, for `app.route('/api/activity', …)`.
 */
export function createActivityRoutes(activityService: ActivityService): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/', async (c) => {
    const query = ListActivityQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);

    try {
      const result = await activityService.list(query.data);
      return c.json(result);
    } catch (_err) {
      return c.json({ error: 'Failed to fetch activity events' }, 500);
    }
  });

  return router;
}
