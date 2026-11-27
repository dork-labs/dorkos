/**
 * The owner's lists of connected accounts the capability mount serves on
 * `/api/connectors`, each a page at a time (DOR-4982): what every agent
 * inherits, one agent's accounts, one chat's accounts, programs' requested
 * changes, and the agents left out of an account shared with every agent.
 *
 * Behind the account-decision bar like the other owner doors
 * (`resources/owner-capabilities.ts`), whose deps, bar and refusals they
 * share: person-only, with no MCP surface. Every page is newest first on a key
 * that never changes (when the account was connected, the review asked for,
 * the agent left out), the id breaking a tie. Each answers the codes and
 * sentences its hand route did.
 *
 * @module services/connectors/owner-lists/owner-list-capabilities
 */
import { z } from 'zod';
import { PageQuerySchema, type PageQuery } from '@dorkos/shared/paging';
import {
  ConnectorAgentConnectionsPageSchema,
  ConnectorEveryAgentGrantsPageSchema,
  ConnectorManagementReviewPageSchema,
  ConnectorSessionConnectionsPageSchema,
} from '@dorkos/shared/connector-resource-schemas';
import { ConnectorGrantExclusionPageSchema } from '@dorkos/shared/connector-exclusion-schemas';

import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../../core/capabilities/capability-definition.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import { keysetPage, type KeysetPage } from '../../../lib/paging/keyset-page.js';
import {
  ConnectionId,
  OWNER_BAR,
  PERSON_ONLY_NOTE,
  connectionOwnerDepsOf,
  connectionRefusal,
  ownerOf,
} from '../resources/owner-capabilities.js';
import { heldTo, managementRefusal } from '../resources/owner-management-capabilities.js';

/** Why an account list can repeat or miss one across pages, said in every description. */
const MOVES =
  ' A page at a time, newest account first: pass `nextCursor` back as `cursor` for the next. ' +
  'An account given or taken away while paging can repeat or be missed.';

/**
 * One page of accounts, newest connected first.
 *
 * @param deps - The registry's deps, for when each account was connected.
 * @param list - The list's name, bound into its cursor.
 * @param rows - Every account the owner may see on this list.
 * @param query - The cursor and page size.
 */
function accountPage<T extends { connectionId: string }>(
  deps: CapabilityDeps,
  list: string,
  rows: readonly T[],
  query: PageQuery
): KeysetPage<T> {
  const ages = connectionOwnerDepsOf(deps).query.createdAtOf(rows.map((row) => row.connectionId));
  return keysetPage(
    list,
    rows,
    (row) => [ages.get(row.connectionId) ?? '', row.connectionId],
    query
  );
}

/**
 * Every row of one of the owner's account lists, a service refusal mapped as
 * the connection doors map it. The owner is read first, outside the mapping,
 * so the bar's own refusal passes through unchanged.
 *
 * @param deps - The registry's deps.
 * @param context - The handler's context, for the owner the bar resolved.
 * @param read - Reads the whole list for that owner.
 */
async function ownerList<T>(
  deps: CapabilityDeps,
  context: CapabilityHandlerContext,
  read: (owner: ReturnType<typeof ownerOf>) => T | Promise<T>
): Promise<T> {
  const owner = ownerOf(context);
  try {
    return await read(owner);
  } catch (error) {
    connectionRefusal(deps, error);
  }
}

/** `connectors.list_every_agent_grants`: what every agent, a new one too, inherits. */
export const everyAgentGrantsCapability = defineCapability({
  id: 'connectors.list_every_agent_grants',
  title: 'See what every agent inherits',
  description:
    'Each connected account the owner shared with every agent, at which level. A new agent gets ' +
    `these the moment it is created. Only the owner of this DorkOS.${MOVES}`,
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: PageQuerySchema,
  output: ConnectorEveryAgentGrantsPageSchema,
  surfaces: { http: { method: 'get', path: '/api/connectors/every-agent-grants', ...OWNER_BAR } },
  invoke: async (deps, query, context) => {
    const reads = connectionOwnerDepsOf(deps).query;
    const all = await ownerList(deps, context, (owner) => reads.everyAgentGrants(owner));
    const page = accountPage(deps, 'every-agent-grants', all.connections, query);
    return { connections: page.items, nextCursor: page.nextCursor };
  },
});

/** `connectors.list_agent_connections`: the accounts one agent was given. */
export const agentConnectionsCapability = defineCapability({
  id: 'connectors.list_agent_connections',
  title: 'See an agent’s connected accounts',
  description:
    'The connected accounts one agent was given, by name or as every agent, with the exact ' +
    `actions and whether each is ready. Only the owner of this DorkOS.${MOVES}`,
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: PageQuerySchema.extend({ agentId: z.string().min(1).describe('The agent.') }),
  output: ConnectorAgentConnectionsPageSchema,
  surfaces: {
    http: { method: 'get', path: '/api/connectors/agents/{agentId}/connections', ...OWNER_BAR },
  },
  invoke: async (deps, { agentId, ...query }, context) => {
    const reads = connectionOwnerDepsOf(deps).query;
    const all = await ownerList(deps, context, (owner) => reads.agentConnections(owner, agentId));
    const page = accountPage(deps, `agent:${agentId}`, all.connections, query);
    return { agentId: all.agentId, connections: page.items, nextCursor: page.nextCursor };
  },
});

/** `connectors.list_session_connections`: the accounts one chat's agent can use. */
export const sessionConnectionsCapability = defineCapability({
  id: 'connectors.list_session_connections',
  title: 'See a chat’s connected accounts',
  description:
    'The connected accounts one chat’s agent can use, where each comes from, and whether the ' +
    `owner turned it off for this chat. Only the owner of this DorkOS.${MOVES}`,
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: PageQuerySchema.extend({ sessionId: z.string().min(1).describe('The chat.') }),
  output: ConnectorSessionConnectionsPageSchema,
  surfaces: {
    http: { method: 'get', path: '/api/connectors/sessions/{sessionId}/connections', ...OWNER_BAR },
  },
  invoke: async (deps, { sessionId, ...query }, context) => {
    const reads = connectionOwnerDepsOf(deps).query;
    const all = await ownerList(deps, context, (owner) =>
      reads.sessionConnections(owner, sessionId)
    );
    const page = accountPage(deps, `session:${sessionId}`, all.connections, query);
    return { ...all, connections: page.items, nextCursor: page.nextCursor };
  },
});

/** `connectors.list_reviews`: programs' requested changes, for the owner to review. */
export const reviewsCapability = defineCapability({
  id: 'connectors.list_reviews',
  title: 'See requested account changes',
  description:
    'Changes programs asked to make to connected accounts, waiting or answered, newest first, a ' +
    'page at a time: pass `nextCursor` back as `cursor` for the next. One answered while paging ' +
    'can repeat or be missed. Only the owner of this DorkOS.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: PageQuerySchema.extend({
    state: z
      .enum(['pending', 'resolved'])
      .optional()
      .describe('Only waiting (`pending`) or only answered (`resolved`) ones; both when left out.'),
  }).strict(),
  output: ConnectorManagementReviewPageSchema,
  surfaces: { http: { method: 'get', path: '/api/connectors/reviews', ...OWNER_BAR } },
  invoke: async (deps, { state, ...query }, context) => {
    const owner = ownerOf(context);
    let all: ReturnType<ReturnType<typeof connectionOwnerDepsOf>['reviews']['list']> = [];
    try {
      all = connectionOwnerDepsOf(deps).reviews.list(owner, state);
    } catch (error) {
      managementRefusal(deps, error);
    }
    const page = keysetPage(
      `reviews:${state ?? 'all'}`,
      all,
      (row) => [row.createdAt, row.reviewRequestId],
      query
    );
    return { reviews: page.items, nextCursor: page.nextCursor };
  },
});

/** `connectors.list_exclusions`: the agents left out of an account shared with every agent. */
export const exclusionsCapability = defineCapability({
  id: 'connectors.list_exclusions',
  title: 'See agents left out of a shared account',
  description:
    'The agents left out of one connected account shared with every agent, newest first, a page ' +
    'at a time: pass `nextCursor` back as `cursor` for the next. Only the owner of this DorkOS.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_ONLY_NOTE,
  input: PageQuerySchema.extend({ connectionId: ConnectionId }),
  output: ConnectorGrantExclusionPageSchema,
  surfaces: {
    http: {
      method: 'get',
      path: '/api/connectors/connections/{connectionId}/exclusions',
      ...OWNER_BAR,
    },
  },
  invoke: async (deps, { connectionId, ...query }, context) => {
    const owner = ownerOf(context);
    let all: ReturnType<ReturnType<typeof connectionOwnerDepsOf>['exclusions']['list']> = [];
    try {
      all = connectionOwnerDepsOf(deps).exclusions.list(owner, connectionId);
    } catch (error) {
      managementRefusal(deps, error);
    }
    const page = keysetPage(
      `exclusions:${connectionId}`,
      all,
      (row) => [row.createdAt, row.agentId],
      query
    );
    return heldTo(ConnectorGrantExclusionPageSchema, {
      connectionId,
      exclusions: page.items,
      nextCursor: page.nextCursor,
    });
  },
});

/** The owner's paged account lists, served on `/api/connectors` by the mount. */
export const connectionListDomain: CapabilityDomain = {
  name: 'connectors',
  assertDeps: connectionOwnerDepsOf,
  capabilities: [
    everyAgentGrantsCapability,
    agentConnectionsCapability,
    sessionConnectionsCapability,
    reviewsCapability,
    exclusionsCapability,
  ],
};
