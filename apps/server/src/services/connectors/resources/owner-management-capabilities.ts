/**
 * The owner's management doors the capability mount serves on
 * `/api/connectors` (ADR 261123-170830, DOR-4978): one program's review, the
 * sign-in an agent's request started, stopping an every-agent share, leaving
 * one agent out of it, and the owner's usage.
 *
 * Behind the account-decision bar like the connection doors
 * (`owner-capabilities.ts`), whose deps, bar and refusals they share:
 * person-only, with no MCP surface, and the connector store's `503` first.
 * Each answers the codes and sentences its hand route did
 * (`routes/connector-management.ts`, `routes/connector-execution.ts`).
 *
 * The rest of those groups stay hand routes for now: the lists until they
 * page, the reads that follow the client going away, a program's own review
 * doors, and every write that waits on "Confirm it's you".
 *
 * @module services/connectors/resources/owner-management-capabilities
 */
import { z } from 'zod';
import {
  ConnectorEveryAgentRevokeResponseSchema,
  ConnectorManagementReviewItemSchema,
  ConnectorUsagePageSchema,
} from '@dorkos/shared/connector-schemas';
import { ConnectorAuthenticationFlowStateSchema } from '@dorkos/shared/connector-resource-schemas';
import { ConnectorGrantExclusionChangeSchema } from '@dorkos/shared/connector-exclusion-schemas';

import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../../core/capabilities/capability-definition.js';
import {
  ConnectorGrantExclusionError,
  type ConnectorGrantExclusionService,
} from '../access/grant-exclusions.js';
import {
  ConnectorAgentRequestError,
  type ConnectorAgentRequestService,
} from '../agent-request-service.js';
import { ConnectorSubscriptionError } from '../events/subscription-store.js';
import {
  ConnectorAccessQueryError,
  type ConnectorAccessQueryService,
} from '../execution/access-query-service.js';
import {
  ConnectorManagementReviewError,
  type ConnectorManagementReviewService,
} from '../management-review-service.js';
import { ConnectorReconciliationError } from '../reconciliation/reconciliation-error.js';
import type { ConnectorReconciliationService } from '../reconciliation-service.js';
import {
  ConnectionId,
  OWNER_BAR,
  PERSON_ONLY_NOTE,
  connectionOwnerDepsOf,
  knownConnectionRefusal,
  ownerOf,
} from './owner-capabilities.js';
import { AGENT_REQUESTS_OFF_TOOL_CODE } from './owner-refusals.js';

/** What the owner's management doors read, beside the connection doors' deps. */
export interface ConnectionManagementDeps {
  /** Programs' requests for an account change, as the owner reviews them. */
  readonly reviews: Pick<ConnectorManagementReviewService, 'get'>;
  /** Agents' requests for an app; absent while agent identity is off. */
  readonly agentRequests?: Pick<ConnectorAgentRequestService, 'pollAuthentication'>;
  /** Which agents may use what. */
  readonly reconciliation: Pick<ConnectorReconciliationService, 'revokeEveryAgent'>;
  /** Agents left out of a connection's every-agent share. */
  readonly exclusions: Pick<ConnectorGrantExclusionService, 'leaveOut'>;
  /** The owner's usage of connected apps. */
  readonly usage: Pick<ConnectorAccessQueryService, 'listOperatorUsage'>;
}

/**
 * A management refusal as the hand routes answered it; anything else is
 * thrown on, as they threw it on to the error handler.
 */
function managementRefusal(deps: CapabilityDeps, error: unknown): never {
  throw (
    knownConnectionRefusal(deps, error, [
      [ConnectorAgentRequestError, 'AGENT_REQUEST'],
      [ConnectorSubscriptionError, 'SUBSCRIPTION'],
      [ConnectorManagementReviewError, 'REVIEW'],
      [ConnectorGrantExclusionError, 'EXCLUSION'],
      [ConnectorReconciliationError, 'RECONCILIATION'],
    ]) ?? error
  );
}

/** The answer, held to its schema as the hand route held it; a mismatch is a fault, not a 400. */
function heldTo<T>(schema: z.ZodType<T>, answer: unknown): T {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw new Error('A connection answer did not match its schema.');
  return parsed.data;
}

/** `connectors.get_review`: one program's request for an account change. */
export const reviewCapability = defineCapability({
  id: 'connectors.get_review',
  title: 'See a requested account change',
  description:
    'One change a program asked to make to a connected account, for the owner to review. Only ' +
    'the owner of this DorkOS.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ reviewRequestId: z.string().min(1).describe('The review’s id.') }),
  output: ConnectorManagementReviewItemSchema,
  surfaces: {
    http: { method: 'get', path: '/api/connectors/reviews/{reviewRequestId}', ...OWNER_BAR },
  },
  invoke: async (deps, { reviewRequestId }, context) => {
    try {
      return connectionOwnerDepsOf(deps).reviews.get(ownerOf(context), reviewRequestId);
    } catch (error) {
      managementRefusal(deps, error);
    }
  },
});

/** `connectors.get_agent_request_sign_in`: where the sign-in an agent's request started stands. */
export const agentRequestSignInCapability = defineCapability({
  id: 'connectors.get_agent_request_sign_in',
  title: 'Check the sign-in for an agent’s request',
  description:
    'Where the sign-in the owner started for an agent’s request stands. Only the owner of this ' +
    'DorkOS.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({
    requestId: z.string().min(1).describe('The agent’s request.'),
    flowId: z.string().min(1).describe('The sign-in’s id.'),
  }),
  output: ConnectorAuthenticationFlowStateSchema,
  surfaces: {
    http: {
      method: 'get',
      path: '/api/connectors/agent-requests/{requestId}/authentication-flows/{flowId}',
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, { requestId, flowId }, context) => {
    const requests = connectionOwnerDepsOf(deps).agentRequests;
    if (!requests) {
      throw new CapabilityToolError({ code: AGENT_REQUESTS_OFF_TOOL_CODE, error: 'unavailable' });
    }
    try {
      return await requests.pollAuthentication(ownerOf(context), requestId, flowId);
    } catch (error) {
      managementRefusal(deps, error);
    }
  },
});

/** `connectors.stop_every_agent_share`: stop sharing one account with every agent. */
export const stopEveryAgentShareCapability = defineCapability({
  id: 'connectors.stop_every_agent_share',
  title: 'Stop sharing an account with every agent',
  description:
    'Stop sharing one connected account with every agent. Agents keep only what they were given ' +
    'by name. Only the owner of this DorkOS.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({ connectionId: ConnectionId }),
  output: ConnectorEveryAgentRevokeResponseSchema,
  surfaces: {
    http: {
      method: 'delete',
      path: '/api/connectors/connections/{connectionId}/every-agent',
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, { connectionId }, context) => {
    let answer: unknown;
    try {
      answer = await connectionOwnerDepsOf(deps).reconciliation.revokeEveryAgent(
        ownerOf(context),
        connectionId
      );
    } catch (error) {
      managementRefusal(deps, error);
    }
    return heldTo(ConnectorEveryAgentRevokeResponseSchema, answer);
  },
});

/** `connectors.leave_agent_out`: leave one agent out of an account's every-agent share. */
export const leaveAgentOutCapability = defineCapability({
  id: 'connectors.leave_agent_out',
  title: 'Leave an agent out of a shared account',
  description:
    'Leave one agent out of a connected account shared with every agent. It keeps only what it ' +
    'was given by name. Only the owner of this DorkOS.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({
    connectionId: ConnectionId,
    agentId: z.string().min(1).describe('The agent left out.'),
  }),
  output: ConnectorGrantExclusionChangeSchema,
  surfaces: {
    http: {
      method: 'put',
      path: '/api/connectors/connections/{connectionId}/exclusions/{agentId}',
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, { connectionId, agentId }, context) => {
    let answer: unknown;
    try {
      answer = await connectionOwnerDepsOf(deps).exclusions.leaveOut(
        ownerOf(context),
        connectionId,
        agentId
      );
    } catch (error) {
      managementRefusal(deps, error);
    }
    return heldTo(ConnectorGrantExclusionChangeSchema, answer);
  },
});

/** `connectors.list_usage`: the owner's use of connected apps, a page at a time. */
export const operatorUsageCapability = defineCapability({
  id: 'connectors.list_usage',
  title: 'See how connected apps were used',
  description:
    'Every action run in a connected app, newest first, a page at a time: who ran it, from ' +
    'where, and how it ended. Only the owner of this DorkOS.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z
    .object({
      connectionId: z.string().min(1).optional().describe('Only this connected account.'),
      cursor: z.string().min(1).optional().describe('Where the last page ended.'),
      limit: z.coerce.number().int().min(1).max(100).optional().describe('How many to return.'),
    })
    .strict(),
  output: ConnectorUsagePageSchema,
  surfaces: { http: { method: 'get', path: '/api/connectors/usage/operator', ...OWNER_BAR } },
  invoke: async (deps, query, context) => {
    try {
      return connectionOwnerDepsOf(deps).usage.listOperatorUsage(ownerOf(context), query);
    } catch (error) {
      throw knownConnectionRefusal(deps, error, [[ConnectorAccessQueryError, 'USAGE']]) ?? error;
    }
  },
});

/** The owner's management doors, served on `/api/connectors` by the mount. */
export const connectionManagementDomain: CapabilityDomain = {
  name: 'connectors',
  assertDeps: connectionOwnerDepsOf,
  capabilities: [
    reviewCapability,
    agentRequestSignInCapability,
    stopEveryAgentShareCapability,
    leaveAgentOutCapability,
    operatorUsageCapability,
  ],
};
