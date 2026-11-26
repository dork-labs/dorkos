/**
 * The person's extension doors as the capability mount serves them
 * (`routes/capability-http.ts`), for route tests that used to mount the hand
 * routes: the real dispatcher and the real person bar, over a manager the test
 * chooses.
 *
 * @module services/extensions/http-capabilities/__tests__/extension-doors-fixture
 */
import { noopLogger } from '@dorkos/shared/logger';
import type { Hono } from 'hono';

import type { ApiEnv } from '../../../../http/api-chain.js';
import { createCapabilityHttpRoutes } from '../../../../routes/capability-http.js';
import { composeRegistry } from '../../../core/capabilities/index.js';
import type { ExtensionManager } from '../../extension-manager.js';
import {
  extensionPersonDomain,
  type ExtensionPersonDeps,
} from '../extension-person-capabilities.js';

/**
 * The doors' routes, at `/api/extensions/{id}/…`, and the registry behind them.
 *
 * @param manager - The manager the doors act on (a narrow fake is fine).
 * @param extra - The broadcast and the Activity feed, when the test reads them.
 */
export function extensionDoorRoutes(
  manager: Partial<ExtensionManager>,
  extra: Partial<Omit<ExtensionPersonDeps, 'manager'>> = {}
): Hono<ApiEnv> {
  const registry = composeRegistry([extensionPersonDomain], {
    logger: noopLogger,
    extensionPersonDeps: {
      manager: manager as ExtensionManager,
      broadcastReloaded: extra.broadcastReloaded ?? (() => {}),
      ...(extra.activity ? { activity: extra.activity } : {}),
    },
  });
  return createCapabilityHttpRoutes({
    registry: () => registry,
    capabilities: extensionPersonDomain.capabilities,
  });
}
