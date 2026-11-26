/**
 * The owner's connection doors the capability mount serves on
 * `/api/connectors` (ADR 261123-170830, DOR-4978): what disconnecting one
 * account would touch, renaming one, and removing a disconnected one.
 *
 * **Behind the account-decision bar, every door** (`http.ownerBar:
 * 'account-decision'`, `lib/http/account-decision-bar.ts`): the mount runs it before
 * the handler on the REST path and on `/invoke`, and hands the handler the
 * server-owned owner as `context.ownerAuthority`. Person-only, with no MCP
 * surface: no agent reads or changes the owner's accounts here. Each answers
 * the connector store's `503` first (`http.precheck: 'connector-store'`), as
 * the hand group did.
 *
 * The rest of the group stays a hand route for now (`routes/connector-resources.ts`):
 * the lists until they page, the reads that set their own caching or follow
 * the client going away, and every write that waits on "Confirm it's you".
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
import { ConnectorLifecycleError, type ConnectorLifecycleService } from './lifecycle-service.js';
import {
  ConnectorOperatorQueryError,
  type ConnectorOperatorQueryService,
} from './operator-query-service.js';
import { lifecycleToolCode, ownerQueryToolCode } from './owner-refusals.js';

/** What the owner's connection doors read. */
export interface ConnectionOwnerDeps {
  /** The owner's reads of accounts. */
  readonly query: Pick<ConnectorOperatorQueryService, 'disconnectImpact'>;
  /** Local lifecycle changes. */
  readonly lifecycle: Pick<ConnectorLifecycleService, 'rename' | 'remove'>;
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
 */
function ownerOf(context: CapabilityHandlerContext): ConnectorOwnerAuthority {
  const owner = context.ownerAuthority;
  if (!owner) throw new CapabilityToolError({ code: PERSON_ONLY_CODE, error: PERSON_ONLY_MESSAGE });
  return owner;
}

/**
 * A service refusal as a tool refusal with the hand routes' code and sentence.
 * Only the code is logged; anything unknown is logged and answered as a
 * generic failure, as the hand routes did. A schema error is thrown on, so
 * the mount answers it as the hand routes did (`invalid_request`).
 */
function connectionRefusal(error: unknown): never {
  if (error instanceof z.ZodError) throw error;
  if (error instanceof ConnectorLifecycleError) {
    logger.info('[connectors] a request was refused', { code: error.code });
    throw new CapabilityToolError({ code: lifecycleToolCode(error.code), error: error.code });
  }
  if (error instanceof ConnectorOperatorQueryError) {
    logger.info('[connectors] a request was refused', { code: error.code });
    throw new CapabilityToolError({ code: ownerQueryToolCode(error.code), error: error.code });
  }
  logger.error('[Connectors] Connection request failed', logError(error));
  throw new CapabilityToolError({ code: 'CONNECTION_REQUEST_FAILED', error: 'failed' });
}

/** The bar every door declares, with the connections' own `owner_only` sentence. */
const OWNER_BAR = {
  audience: 'person',
  ownerBar: 'account-decision',
  ownerOnly: ACCOUNT_DECISION_OWNER_ONLY[0],
  precheck: 'connector-store',
} as const satisfies Partial<HttpSurface>;

/** Why these doors are closed to agents, for the catalog. */
const PERSON_ONLY_NOTE = 'the owner’s own connected accounts; agents use the connector tools';

/** The account a path names. */
const ConnectionId = z.string().min(1).describe('The connected account’s id.');

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
      connectionRefusal(error);
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
      connectionRefusal(error);
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
      connectionRefusal(error);
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
  ],
};
