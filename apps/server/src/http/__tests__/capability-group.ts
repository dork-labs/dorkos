/**
 * Mount a capability domain's REST paths in a route test, as the real app's
 * capability mount serves them (`routes/capability-http.ts`), for
 * {@link honoGroupListener} beside any hand routes the group still has.
 *
 * @module http/__tests__/capability-group
 */
import { noopLogger } from '@dorkos/shared/logger';

import { createCapabilityHttpRoutes } from '../../routes/capability-http.js';
import type { CapabilityDoorPorts } from '../../routes/capability-dispatch.js';
import {
  composeRegistry,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../../services/core/capabilities/index.js';
import type { MountedGroup } from './hono-group-listener.js';

/**
 * The mount for one domain, composed into its own registry.
 *
 * @param domain - The domain whose `http` surfaces to serve.
 * @param deps - Extra deps for the registry; the logger is supplied.
 * @param ports - The bars and prechecks the mount runs, as `http/hono-api.ts` hands them over.
 * @returns The group, mounted at the root as the app mounts it.
 */
export function capabilityGroup(
  domain: CapabilityDomain,
  deps: Partial<CapabilityDeps> = {},
  ports?: CapabilityDoorPorts
): MountedGroup {
  const registry = composeRegistry([domain], { logger: noopLogger, ...deps });
  return {
    path: '/',
    routes: createCapabilityHttpRoutes({
      registry: () => registry,
      capabilities: domain.capabilities,
      ...(ports ? { ports } : {}),
    }),
  };
}
