/**
 * A connector hand group with the owner's doors the capability mount serves
 * beside it (DOR-4978), in the app's order, so a route test reaches every
 * path the group used to answer.
 *
 * @module routes/__tests__/connector-owner-doors
 */
import type { Hono } from 'hono';

import type { ApiEnv } from '../../http/api-chain.js';
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import type { MountedGroup } from '../../http/__tests__/hono-group-listener.js';
import type { AccountDecisionPolicy } from '../../lib/http/account-decision-bar.js';
import type { ConnectorRegistry } from '../../services/connectors/registry.js';
import {
  connectionOwnerDomain,
  type ConnectionOwnerDeps,
} from '../../services/connectors/resources/owner-capabilities.js';
import { connectionManagementDomain } from '../../services/connectors/resources/owner-management-capabilities.js';
import { connectorStoreUnavailable } from '../connector-owner-boundary.js';
import { managedCloudRefusalCode } from '../managed-cloud-error.js';

/** What a group's deps may carry for the doors: the bar's policy, and the store's health. */
type DoorDeps = AccountDecisionPolicy & {
  registry?: Pick<ConnectorRegistry, 'migrationHealth'>;
  connectorRegistry?: Pick<ConnectorRegistry, 'migrationHealth'>;
};

/**
 * The owner's doors on the mount, then the hand group at `/api/connectors`.
 *
 * @param build - The hand group's factory.
 * @param deps - Its deps, which also hold the services the doors read.
 * @param extra - Services the doors read under another name (`usage`).
 */
export function withOwnerDoors<D extends DoorDeps>(
  build: (deps: D) => Hono<ApiEnv>,
  deps: D,
  extra: Partial<ConnectionOwnerDeps> = {}
): MountedGroup[] {
  const store = deps.registry ?? deps.connectorRegistry;
  const ports = {
    accountDecision: deps,
    ...(store ? { prechecks: { 'connector-store': () => connectorStoreUnavailable(store) } } : {}),
  };
  const owned = { cloudRefusalCode: managedCloudRefusalCode, ...deps, ...extra };
  const doors = { connectionOwnerDeps: owned as unknown as ConnectionOwnerDeps };
  return [
    capabilityGroup(connectionOwnerDomain, doors, ports),
    capabilityGroup(connectionManagementDomain, doors, ports),
    { path: '/api/connectors', routes: build(deps) },
  ];
}
