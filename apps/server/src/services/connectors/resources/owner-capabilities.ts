/**
 * The owner's connection doors the capability mount serves on
 * `/api/connectors` (ADR 261123-170830, DOR-4978): what disconnecting one
 * account would touch, renaming one, removing a disconnected one, and following
 * one sign-in. The owner's management doors (`owner-management-capabilities.ts`)
 * share these deps, this bar and these refusals.
 *
 * **Behind the account-decision bar, every door** (`http.ownerBar:
 * 'account-decision'`, `lib/http/account-decision-bar.ts`): the mount runs it before
 * the handler on the REST path and on `/invoke`, and hands the handler the
 * server-owned owner as `context.ownerAuthority`. Person-only, with no MCP
 * surface: no agent reads or changes the owner's accounts here. Each answers
 * the connector store's `503` first (`http.precheck: 'connector-store'`), as
 * the hand group did.
 *
 * The rest of the groups stay hand routes for now (`routes/connector-resources.ts`,
 * `routes/connector-management.ts`): the lists until they page, the reads that
 * set their own caching or follow the client going away, the writes a Wi-Fi
 * sign-in may make, and every write that waits on "Confirm it's you".
 *
 * @module services/connectors/resources/owner-capabilities
 */
import { z } from 'zod';
import {
  ACCOUNT_DECISION_OWNER_ONLY,
  PERSON_ONLY_CODE,
  PERSON_ONLY_MESSAGE,
  type HttpSurface,
} from '@dorkos/shared/capabilities';
import {
  ConnectorAuthenticationFlowStateSchema,
  ConnectorConnectionPatchSchema,
  ConnectorDisconnectImpactSchema,
  ConnectorLifecycleResultSchema,
} from '@dorkos/shared/connector-resource-schemas';

import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../../core/capabilities/capability-definition.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import type { ConnectorOwnerAuthority } from '../../core/connections-lease/index.js';
import { logError, logger } from '../../../lib/logger.js';
import {
  ConnectorAuthenticationFlowError,
  type ConnectorAuthenticationFlowService,
} from './authentication-flow-service.js';
import { ConnectorLifecycleError, type ConnectorLifecycleService } from './lifecycle-service.js';
import {
  ConnectorOperatorQueryError,
  type ConnectorOperatorQueryService,
} from './operator-query-service.js';
import {
  connectionToolCode,
  lifecycleToolCode,
  ownerQueryToolCode,
  type ConnectionRefusalFamily,
} from './owner-refusals.js';
import type { ConnectionManagementDeps } from './owner-door-types.js';

/** What the owner's connection doors read: the services the hand routes hold. */
export interface ConnectionOwnerDeps extends ConnectionManagementDeps {
  /** The owner's reads of accounts. */
  readonly query: Pick<ConnectorOperatorQueryService, 'disconnectImpact'>;
  /** Local lifecycle changes. */
  readonly lifecycle: Pick<ConnectorLifecycleService, 'rename' | 'remove'>;
  /** The owner's sign-ins to an app. */
  readonly authentication: Pick<ConnectorAuthenticationFlowService, 'poll'>;
  /**
   * The code of a refused call to DorkOS's managed cloud, or `undefined` for
   * any other error (`routes/managed-cloud-error.ts`), injected so these doors
   * answer it as the hand routes did without reaching into the cloud link.
   */
  readonly cloudRefusalCode: (error: unknown) => string | undefined;
}

/** The services the composition root holds, under the names it holds them by. */
export interface ConnectionOwnerServices {
  readonly connectorOperatorQueries: ConnectionOwnerDeps['query'];
  readonly connectorLifecycle: ConnectionOwnerDeps['lifecycle'];
  readonly connectorAuthenticationFlows: ConnectionOwnerDeps['authentication'];
  readonly connectorManagementReviews: ConnectionOwnerDeps['reviews'];
  readonly connectorReconciliation: ConnectionOwnerDeps['reconciliation'];
  readonly connectorGrantExclusions: ConnectionOwnerDeps['exclusions'];
  readonly connectorAccess: ConnectionOwnerDeps['usage'];
}

/**
 * The doors' deps: the same service instances the hand routes hold.
 *
 * @param services - The composition root's services.
 * @param agentRequests - Agents' requests, absent while agent identity is off.
 * @param cloudRefusalCode - Reads a refused managed-cloud call's code.
 */
export function connectionOwnerDepsFor(
  services: ConnectionOwnerServices,
  agentRequests: ConnectionOwnerDeps['agentRequests'],
  cloudRefusalCode: ConnectionOwnerDeps['cloudRefusalCode']
): ConnectionOwnerDeps {
  return {
    query: services.connectorOperatorQueries,
    lifecycle: services.connectorLifecycle,
    authentication: services.connectorAuthenticationFlows,
    reviews: services.connectorManagementReviews,
    reconciliation: services.connectorReconciliation,
    exclusions: services.connectorGrantExclusions,
    usage: services.connectorAccess,
    cloudRefusalCode,
    ...(agentRequests && { agentRequests }),
  };
}

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The owner's connection doors on `/api/connectors` (DOR-4978). */
    connectionOwnerDeps?: ConnectionOwnerDeps;
  }
}

/**
 * The deps, or a fault: the domain is composed only with them.
 *
 * @param deps - The registry's deps.
 */
export function connectionOwnerDepsOf(deps: CapabilityDeps): ConnectionOwnerDeps {
  if (!deps.connectionOwnerDeps) throw new Error('Connection owner doors are unavailable.');
  return deps.connectionOwnerDeps;
}

/**
 * The owner the mount's bar resolved. The registry refuses the call before
 * the handler when there is none, so this never throws in practice.
 *
 * @param context - The handler's context.
 */
export function ownerOf(context: CapabilityHandlerContext): ConnectorOwnerAuthority {
  const owner = context.ownerAuthority;
  if (!owner) throw new CapabilityToolError({ code: PERSON_ONLY_CODE, error: PERSON_ONLY_MESSAGE });
  return owner;
}

/** An error class a door maps, with the family its codes are thrown under. */
export type RefusalFamilyOf = readonly [
  new (...args: never[]) => Error & { code: string },
  ConnectionRefusalFamily,
];

/**
 * A service refusal of a known family, or a refused managed-cloud call, as a
 * tool refusal with the hand routes' code and sentence, logging only its code;
 * or `undefined` for anything else.
 *
 * @param deps - The registry's deps, for the managed-cloud reader.
 * @param error - What the service threw.
 * @param families - The error classes this door maps, each with its family.
 */
export function knownConnectionRefusal(
  deps: CapabilityDeps,
  error: unknown,
  families: readonly RefusalFamilyOf[]
): CapabilityToolError | undefined {
  const refusal = (family: ConnectionRefusalFamily, code: string) => {
    logger.info('[connectors] a request was refused', { code });
    return new CapabilityToolError({ code: connectionToolCode(family, code), error: code });
  };
  for (const [type, family] of families) {
    if (error instanceof type) return refusal(family, error.code);
  }
  const cloud = connectionOwnerDepsOf(deps).cloudRefusalCode(error);
  return cloud === undefined ? undefined : refusal('CLOUD', cloud);
}

/**
 * A service refusal as a tool refusal with the hand routes' code and sentence.
 * Only the code is logged; anything unknown is logged and answered as a
 * generic failure, as the hand routes did. A schema error is thrown on, so
 * the mount answers it as the hand routes did (`invalid_request`).
 */
function connectionRefusal(deps: CapabilityDeps, error: unknown): never {
  if (error instanceof z.ZodError) throw error;
  if (error instanceof ConnectorLifecycleError) {
    logger.info('[connectors] a request was refused', { code: error.code });
    throw new CapabilityToolError({ code: lifecycleToolCode(error.code), error: error.code });
  }
  if (error instanceof ConnectorOperatorQueryError) {
    logger.info('[connectors] a request was refused', { code: error.code });
    throw new CapabilityToolError({ code: ownerQueryToolCode(error.code), error: error.code });
  }
  const known = knownConnectionRefusal(deps, error, [
    [ConnectorAuthenticationFlowError, 'SIGN_IN'],
  ]);
  if (known) throw known;
  logger.error('[Connectors] Connection request failed', logError(error));
  throw new CapabilityToolError({ code: 'CONNECTION_REQUEST_FAILED', error: 'failed' });
}

/** The bar every door declares, with the connections' own `owner_only` sentence. */
export const OWNER_BAR = {
  audience: 'person',
  ownerBar: 'account-decision',
  ownerOnly: ACCOUNT_DECISION_OWNER_ONLY[0],
  precheck: 'connector-store',
} as const satisfies Partial<HttpSurface>;

/** Why these doors are closed to agents, for the catalog. */
export const PERSON_ONLY_NOTE =
  'the owner’s own connected accounts; agents use the connector tools';

/** The account a path names. */
export const ConnectionId = z.string().min(1).describe('The connected account’s id.');

/** `connectors.disconnect_impact`: what disconnecting one account would touch. */
export const disconnectImpactCapability = defineCapability({
  id: 'connectors.disconnect_impact',
  title: 'See what disconnecting an account would touch',
  description:
    'How many agents, chats and notification choices use one connected account, so the owner ' +
    'sees what disconnecting it would end. Only the owner of this DorkOS.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ connectionId: ConnectionId }),
  output: ConnectorDisconnectImpactSchema,
  surfaces: {
    http: {
      method: 'get',
      path: '/api/connectors/connections/{connectionId}/disconnect-impact',
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, { connectionId }, context) => {
    try {
      return connectionOwnerDepsOf(deps).query.disconnectImpact(ownerOf(context), connectionId);
    } catch (error) {
      connectionRefusal(deps, error);
    }
  },
});

/** `connectors.rename_connection`: give one account a new name. */
export const renameConnectionCapability = defineCapability({
  id: 'connectors.rename_connection',
  title: 'Rename a connected account',
  description: 'Give one connected account a new name in DorkOS. Only the owner of this DorkOS.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: ConnectorConnectionPatchSchema.extend({ connectionId: ConnectionId }),
  output: ConnectorLifecycleResultSchema,
  surfaces: {
    http: { method: 'patch', path: '/api/connectors/connections/{connectionId}', ...OWNER_BAR },
  },
  invoke: async (deps, { connectionId, label }, context) => {
    try {
      return connectionOwnerDepsOf(deps).lifecycle.rename(ownerOf(context), connectionId, label);
    } catch (error) {
      connectionRefusal(deps, error);
    }
  },
});

/** `connectors.remove_connection`: take a disconnected account off the list. */
export const removeConnectionCapability = defineCapability({
  id: 'connectors.remove_connection',
  title: 'Remove a disconnected account',
  description:
    'Take a disconnected account off the list, keeping its history. Only the owner of this DorkOS.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ connectionId: ConnectionId }).strict(),
  // Nothing: the route answers 204 with no body.
  output: z.unknown(),
  surfaces: {
    http: {
      method: 'post',
      path: '/api/connectors/connections/{connectionId}/remove',
      success: 204,
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, { connectionId }, context) => {
    try {
      connectionOwnerDepsOf(deps).lifecycle.remove(ownerOf(context), connectionId);
    } catch (error) {
      connectionRefusal(deps, error);
    }
  },
});

/** `connectors.get_sign_in`: where one sign-in to an app stands. */
export const signInCapability = defineCapability({
  id: 'connectors.get_sign_in',
  title: 'Check a sign-in to an app',
  description:
    'Where one sign-in to an app stands: still waiting, connected, or ended. Only the owner of ' +
    'this DorkOS.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ flowId: z.string().min(1).describe('The sign-in’s id.') }),
  output: ConnectorAuthenticationFlowStateSchema,
  surfaces: {
    http: { method: 'get', path: '/api/connectors/authentication-flows/{flowId}', ...OWNER_BAR },
  },
  invoke: async (deps, { flowId }, context) => {
    try {
      return await connectionOwnerDepsOf(deps).authentication.poll(ownerOf(context), flowId);
    } catch (error) {
      connectionRefusal(deps, error);
    }
  },
});

/** The owner's connection doors, served on `/api/connectors` by the mount. */
export const connectionOwnerDomain: CapabilityDomain = {
  name: 'connectors',
  assertDeps: connectionOwnerDepsOf,
  capabilities: [
    disconnectImpactCapability,
    renameConnectionCapability,
    removeConnectionCapability,
    signInCapability,
  ],
};
