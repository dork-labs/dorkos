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
 * Three of them give an agent access, so each waits for the owner to confirm
 * it's them behind the `front-door` confirm-first hold, as its hand route held
 * it (DOR-4355): letting an agent back in, answering an agent's request with
 * access, and connecting an account for one. The mount runs the bar afresh on
 * the confirm and refuses a confirm from another owner (Security t1j,
 * 2026-11-27); the write runs with the owner the confirm resolved. Each sheet
 * binds what its hand route bound, so the 428 and its request code are unchanged.
 *
 * The paged lists are in `owner-lists/`. The rest of those groups stay hand
 * routes for now: the reads that follow the client going away, a program's
 * own review doors, and the writes held on a stored state or a write's own answer.
 *
 * @module services/connectors/resources/owner-management-capabilities
 */
import { z } from 'zod';
import {
  ConnectorAgentRequestItemSchema,
  ConnectorEveryAgentRevokeResponseSchema,
  ConnectorManagementReviewItemSchema,
  ConnectorUsagePageSchema,
} from '@dorkos/shared/connector-schemas';
import { ConnectorAuthenticationFlowStateSchema } from '@dorkos/shared/connector-resource-schemas';
import { ConnectorGrantExclusionChangeSchema } from '@dorkos/shared/connector-exclusion-schemas';
import {
  ConnectorAgentRequestAuthenticationInputSchema,
  ConnectorAgentRequestDecisionSchema,
} from '@dorkos/shared/connector-agent-request-schemas';

import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../../core/capabilities/capability-definition.js';
import { ConnectorGrantExclusionError } from '../access/grant-exclusions.js';
import { ConnectorAgentRequestError } from '../agent-request-service.js';
import { ConnectorSubscriptionError } from '../events/subscription-store.js';
import { ConnectorAccessQueryError } from '../execution/access-query-service.js';
import { ConnectorManagementReviewError } from '../management-review-service.js';
import { ConnectorReconciliationError } from '../reconciliation/reconciliation-error.js';
import {
  ConnectionId,
  OWNER_BAR,
  PERSON_ONLY_NOTE,
  connectionOwnerDepsOf,
  knownConnectionRefusal,
  ownerOf,
} from './owner-capabilities.js';
import { AGENT_REQUESTS_OFF_TOOL_CODE } from './owner-refusals.js';

/**
 * A management refusal as the hand routes answered it; anything else is
 * thrown on, as they threw it on to the error handler. A service's own schema
 * error stays a fault (a 500), never a 400 naming its internal fields, as the
 * hand routes' error handler answered it.
 *
 * @param deps - The registry's deps.
 * @param error - What the service threw.
 */
export function managementRefusal(deps: CapabilityDeps, error: unknown): never {
  if (error instanceof z.ZodError) throw new Error('A connection service failed a schema check.');
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

/**
 * The answer, held to its schema as the hand route held it; a mismatch is a fault, not a 400.
 *
 * @param schema - The answer's schema.
 * @param answer - What the service answered.
 */
export function heldTo<T>(schema: z.ZodType<T>, answer: unknown): T {
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
      // A schema error is thrown on as a 400, as the hand route's `programErrorResponse` did.
      throw knownConnectionRefusal(deps, error, [[ConnectorAccessQueryError, 'USAGE']]) ?? error;
    }
  },
});

/** What the front-door bar names when it refuses these writes, as the hand routes named it. */
const CONNECTED_APPS = 'connected apps';

/** The hold every one of these writes shares: the step-up kind and what a refusal names. */
const GRANT_HOLD = {
  bar: 'front-door',
  kind: 'connection.grant',
  subject: CONNECTED_APPS,
} as const;

/** Agents' requests, or the refusal their hand routes answered while agent identity is off. */
function agentRequestsOf(deps: CapabilityDeps) {
  const requests = connectionOwnerDepsOf(deps).agentRequests;
  if (!requests) {
    throw new CapabilityToolError({ code: AGENT_REQUESTS_OFF_TOOL_CODE, error: 'unavailable' });
  }
  return requests;
}

const RequestId = z.string().min(1).describe('The agent’s request.');

/** `connectors.let_agent_back_in`: give one agent an every-agent share again. */
export const letAgentBackInCapability = defineCapability({
  id: 'connectors.let_agent_back_in',
  title: 'Let an agent back into a shared account',
  description:
    'Let one agent use a connected account shared with every agent again, after it was left ' +
    'out. Waits for the owner to confirm it’s them. Only the owner of this DorkOS.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: z.object({
    connectionId: ConnectionId,
    agentId: z.string().min(1).describe('The agent let back in.'),
  }),
  output: ConnectorGrantExclusionChangeSchema,
  confirmFirst: {
    ...GRANT_HOLD,
    sheet: (_deps, { connectionId, agentId }) => ({
      target: connectionId,
      reason: 'Let this agent use the app again, like every other agent.',
      bound: { op: 'let-agent-back-in', connectionId, agentId },
    }),
  },
  surfaces: {
    http: {
      method: 'delete',
      path: '/api/connectors/connections/{connectionId}/exclusions/{agentId}',
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, { connectionId, agentId }, context) => {
    let answer: unknown;
    try {
      answer = await connectionOwnerDepsOf(deps).exclusions.letBackIn(
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

/**
 * The decision's fields as the body carries them. Checked in full against the
 * shared decision schema before anything is held or run, so a bad body answers
 * the same `400` its hand route did.
 */
const DecisionInput = z
  .object({
    requestId: RequestId,
    decision: z
      .enum(['denied', 'current_access'])
      .describe('`denied`, or `current_access`: answer with the access the agent holds now.'),
    connectionId: z.string().optional().describe('For `current_access`: the account.'),
    eventScopes: z
      .array(z.unknown())
      .optional()
      .describe('For `current_access`: the updates the agent may hear about.'),
  })
  .loose();

/** The decision without its path's request id, held to the shared schema (a `400` when it fails). */
function decisionOf({ requestId: _requestId, ...decision }: z.infer<typeof DecisionInput>) {
  return ConnectorAgentRequestDecisionSchema.parse(decision);
}

/** `connectors.answer_agent_request`: answer one agent's request for an app. */
export const answerAgentRequestCapability = defineCapability({
  id: 'connectors.answer_agent_request',
  title: 'Answer an agent’s request for an app',
  description:
    'Answer one agent’s request for a connected app: no, or yes with the access it holds now. ' +
    'A yes waits for the owner to confirm it’s them. Only the owner of this DorkOS.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: DecisionInput,
  output: ConnectorAgentRequestItemSchema,
  confirmFirst: {
    ...GRANT_HOLD,
    // A no is immediate; answering with access waits for the owner (DOR-4355).
    when: (input) => input.decision !== 'denied',
    sheet: (deps, input) => {
      agentRequestsOf(deps);
      return {
        target: input.requestId,
        reason: 'Give an agent the access it asked for.',
        bound: {
          op: 'answer-agent-request',
          requestId: input.requestId,
          decision: decisionOf(input),
        },
      };
    },
  },
  surfaces: {
    http: {
      method: 'post',
      path: '/api/connectors/agent-requests/{requestId}/decision',
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, input, context) => {
    const requests = agentRequestsOf(deps);
    const decision = decisionOf(input);
    try {
      return await requests.resolve(
        ownerOf(context),
        input.requestId,
        decision,
        context.signal ?? new AbortController().signal
      );
    } catch (error) {
      managementRefusal(deps, error);
    }
  },
});

/** `connectors.start_agent_request_sign_in`: connect an account for one agent's request. */
export const startAgentRequestSignInCapability = defineCapability({
  id: 'connectors.start_agent_request_sign_in',
  title: 'Connect an account for an agent’s request',
  description:
    'Start signing in to an app for the agent that asked for it. Waits for the owner to ' +
    'confirm it’s them. Only the owner of this DorkOS.',
  tier: 'act',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: ConnectorAgentRequestAuthenticationInputSchema.extend({ requestId: RequestId }),
  output: ConnectorAuthenticationFlowStateSchema,
  confirmFirst: {
    ...GRANT_HOLD,
    sheet: (deps, { requestId, ...input }) => {
      agentRequestsOf(deps);
      return {
        target: requestId,
        reason: 'Connect an account for the agent that asked.',
        bound: { op: 'connect-for-agent-request', requestId, ...input },
      };
    },
  },
  surfaces: {
    http: {
      method: 'post',
      path: '/api/connectors/agent-requests/{requestId}/authentication-flows',
      success: 201,
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, { requestId, ...input }, context) => {
    const requests = agentRequestsOf(deps);
    try {
      return await requests.startAuthentication(ownerOf(context), requestId, input);
    } catch (error) {
      managementRefusal(deps, error);
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
    letAgentBackInCapability,
    answerAgentRequestCapability,
    startAgentRequestSignInCapability,
  ],
};
