/**
 * `operator.activity_list`: the Activity feed, read by the app at
 * `GET /api/activity` (served by the capability mount), by agents as the
 * `activity_list` tool, and by `dorkos call`.
 *
 * It is the first capability of `operatorDomain`. That domain needs the Claude
 * Code runtime's tool deps, while the feed is on every server: on a computer
 * where the operator domain did not start, {@link operatorActivityDomain}
 * registers this one capability alone, so the app's Activity page never goes
 * missing. Either way its id, tool name and operationId are the same.
 *
 * @module services/activity/activity-capability
 */
import { z } from 'zod';
import { ListActivityQuerySchema } from '@dorkos/shared/activity-schemas';

import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../core/capabilities/index.js';
import type { ActivityService } from './activity-service.js';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The Activity feed; present on every server, gates `operator.activity_list`. */
    activityDeps?: {
      /** The feed. */
      activityService: Pick<ActivityService, 'list'>;
    };
  }
}

/**
 * The feed, from its own deps or the operator domain's; a refusal when this
 * server keeps none.
 *
 * @param deps - The capability bag.
 */
function activityServiceOf(deps: CapabilityDeps): Pick<ActivityService, 'list'> {
  const service = deps.activityDeps?.activityService ?? deps.operatorDeps?.activityService;
  if (!service) {
    throw new CapabilityToolError({
      error: 'Activity feed is not available in this instance.',
      code: 'ACTIVITY_UNAVAILABLE',
    });
  }
  return service;
}

/** `operator.activity_list`: one page of the feed, exactly as the service lists it. */
export const activityListCapability = defineCapability({
  id: 'operator.activity_list',
  title: 'List activity',
  description:
    'List DorkOS activity-feed events (agent, tasks, relay, config, system). ' +
    'Filter by categories (comma-separated), actorType, actorId, and a time window ' +
    '(before/since ISO timestamps); paginate with limit and the returned nextCursor.',
  tier: 'observe',
  area: null,
  areaNote: 'reading',
  input: z.object(ListActivityQuerySchema.shape),
  // Documented as unknown until the feed pages by cursor (the API lint's list rule).
  output: z.unknown(),
  surfaces: {
    mcp: {
      toolName: 'activity_list',
      servers: ['in-session', 'external'],
      readOnlyCarveOut: true,
      annotations: { idempotentHint: true },
    },
    // The mount serves `GET /api/activity`; its query string is the input.
    http: { method: 'get', path: '/api/activity' },
  },
  invoke: async (deps, input) => activityServiceOf(deps).list(input),
});

/**
 * The feed alone, for a server where `operatorDomain` did not start; never
 * composed beside it, which carries the same capability.
 */
export const operatorActivityDomain: CapabilityDomain = {
  name: 'operator',
  assertDeps: (deps) => {
    if (!deps.activityDeps)
      throw new Error('The activity domain was composed without activityDeps.');
  },
  capabilities: [activityListCapability],
};
