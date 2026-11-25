/**
 * Mount a capability domain's REST paths in a route test, as the real app's
 * capability mount serves them (`routes/capability-http.ts`), for
 * {@link honoGroupListener} beside any hand routes the group still has.
 *
 * @module http/__tests__/capability-group
 */
import { noopLogger } from '@dorkos/shared/logger';

import { createCapabilityHttpRoutes } from '../../routes/capability-http.js';
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
 * @returns The group, mounted at the root as the app mounts it.
 */
export function capabilityGroup(
  domain: CapabilityDomain,
  deps: Partial<CapabilityDeps> = {}
): MountedGroup {
  const registry = composeRegistry([domain], { logger: noopLogger, ...deps });
  return {
    path: '/',
    routes: createCapabilityHttpRoutes({
      registry: () => registry,
      capabilities: domain.capabilities,
    }),
  };
}
