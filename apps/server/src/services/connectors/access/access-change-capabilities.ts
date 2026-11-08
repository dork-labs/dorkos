/**
 * The agent tools for taking connection access away (spec
 * `agent-grant-autonomy` §6.1, phase 2).
 *
 * Two narrowing tools, because a capability's permission area is fixed: one
 * for the caller's own access (no area: an agent can always give up its own),
 * and one for another agent's (the `permissions` area, so a Careful install
 * asks a person). The second also runs the turn gate, the rate limit and the
 * required reason inside the service.
 *
 * The descriptions say only what is true before DOR-3969: they name the turns
 * DorkOS marks, never "after reading outside content", and say plainly that a
 * read through a connected app doesn't mark a turn yet (§4.4).
 *
 * @module services/connectors/access/access-change-capabilities
 */
import { z } from 'zod';
import { and, connectionGrantChanges, desc, eq, or, type Db } from '@dorkos/db';
import { defineCapability, type CapabilityDeps } from '../../core/capabilities/index.js';
import type {
  CapabilityHandlerContext,
  CapabilityInvocationContext,
} from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { isServerPrincipal } from '../principal/server-principal.js';
import {
  AccessNarrowingError,
  REASON_MAX_WORDS,
  type AccessNarrowingService,
  type NarrowCaller,
  type NarrowChange,
} from './access-narrowing.js';

/** What the tools need. */
export interface AccessChangeCapabilityDeps {
  readonly narrowing: AccessNarrowingService;
  readonly db: Db;
}

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Taking connection access away; absent while connector identity is offline. */
    accessChangeDeps?: AccessChangeCapabilityDeps;
  }
}

function requireDeps(deps: CapabilityDeps): AccessChangeCapabilityDeps {
  if (!deps.accessChangeDeps) {
    throw new CapabilityToolError({
      error: 'Changing access is unavailable while agent identity is offline.',
      code: 'CONNECTOR_REQUEST_UNAVAILABLE',
    });
  }
  return deps.accessChangeDeps;
}

function callerOf(context: CapabilityInvocationContext | CapabilityHandlerContext): NarrowCaller {
  const principal = context.serverPrincipal;
  if (!principal || !isServerPrincipal(principal) || principal.claims.kind !== 'runtime') {
    throw new CapabilityToolError({
      error: 'DorkOS couldn’t tell which agent in which chat is asking, so it changed nothing.',
      code: 'CONNECTOR_PRINCIPAL_REQUIRED',
    });
  }
  const claims = principal.claims;
  return {
    agentId: claims.agentId,
    agentPath: claims.agentPath,
    sessionId: claims.canonicalSessionId,
    owner: claims.owner,
  };
}

function narrowingError(error: unknown): never {
  if (error instanceof AccessNarrowingError) {
    throw new CapabilityToolError({ error: error.message, code: error.code });
  }
  throw error;
}

const ChangeSchema = {
  connectionId: z.string().min(1).describe('The connected app, from list_granted_connections.'),
  to: z
    .enum(['read', 'none'])
    .optional()
    .describe(
      'Lower the access to Read, or remove it. Give exactly one of to, removeOperationRevisionIds or leaveOutOfShare.'
    ),
  removeOperationRevisionIds: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('Remove just these actions.'),
  leaveOutOfShare: z
    .literal(true)
    .optional()
    .describe(
      'Stop the app’s every-agent share from reaching the agent. Only a person can undo this.'
    ),
};

function changeOf(input: {
  to?: 'read' | 'none';
  removeOperationRevisionIds?: string[];
  leaveOutOfShare?: true;
}): NarrowChange {
  const given = [input.to, input.removeOperationRevisionIds, input.leaveOutOfShare].filter(
    (value) => value !== undefined
  );
  if (given.length !== 1) {
    throw new CapabilityToolError({
      error: 'Give exactly one of to, removeOperationRevisionIds or leaveOutOfShare.',
      code: 'GRANT_NOT_A_NARROWING',
    });
  }
  if (input.leaveOutOfShare) return { kind: 'leave_out' };
  if (input.removeOperationRevisionIds) {
    return { kind: 'remove', operationRevisionIds: input.removeOperationRevisionIds };
  }
  return { kind: 'level', to: input.to! };
}

const NarrowResultSchema = z.object({
  changed: z.boolean(),
  changeId: z.string().nullable(),
  note: z.string(),
});

const ownNote = (changed: boolean) =>
  changed
    ? 'Done. It takes effect on your next call. Only a person can give it back.'
    : 'Nothing changed: you already had no more than that.';

const narrowOwnAccess = defineCapability({
  id: 'connectors.narrow_own_access',
  title: 'Give up your own access to a connected app',
  description:
    'Give up some or all of your own access to one connected app: lower it to Read, remove ' +
    'some actions, remove it, or leave yourself out of the app’s every-agent share. Always ' +
    'allowed, from any turn. It never disconnects the app. Only a person can give the access ' +
    'back. reason is optional: one line, at most ' +
    `${REASON_MAX_WORDS} words, shown only to the person.`,
  tier: 'act',
  area: null,
  areaNote: 'an agent can always give up its own access (spec agent-grant-autonomy N1)',
  input: z
    .object({
      ...ChangeSchema,
      reason: z.string().optional().describe('Why, in one line. Only the person sees it.'),
    })
    .strict(),
  output: NarrowResultSchema,
  surfaces: {},
  invoke: async (deps, input, context) => {
    const { narrowing } = requireDeps(deps);
    const caller = callerOf(context);
    try {
      const result = await narrowing.narrow(caller, {
        targetAgentId: caller.agentId,
        connectionId: input.connectionId,
        change: changeOf(input),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      return { changed: result.changed, changeId: result.changeId, note: ownNote(result.changed) };
    } catch (error) {
      return narrowingError(error);
    }
  },
});

const narrowAgentAccess = defineCapability({
  id: 'connectors.narrow_agent_access',
  title: "Take away another agent's access to a connected app",
  description:
    'Take some or all of another agent’s access to one connected app away: lower it to Read, ' +
    'remove some actions, remove it, or leave that agent out of the app’s every-agent share. ' +
    'It never disconnects the app, and never gives access. A left-out agent can’t use the app ' +
    'directly. reason is required: one line, at most ' +
    `${REASON_MAX_WORDS} words, shown only to the person. The person is told at once and can ` +
    'undo it. Refused in a turn another agent’s message started, in a turn DorkOS marks as ' +
    'having read words it can’t vouch for, when DorkOS can’t tell either, and after 3 such ' +
    'changes in an hour. DorkOS doesn’t yet notice when a turn reads an email or web page ' +
    'through a connected app, so these limits don’t cover that case.',
  tier: 'act',
  area: 'permissions',
  approvalDisplayFields: ['agentId', 'connectionId', 'to', 'leaveOutOfShare', 'reason'],
  input: z
    .object({
      agentId: z.string().min(1).describe('The other agent.'),
      ...ChangeSchema,
      reason: z.string().describe('Why, in one line, at most 15 words. Only the person sees it.'),
    })
    .strict(),
  output: NarrowResultSchema,
  surfaces: {},
  invoke: async (deps, input, context) => {
    const { narrowing } = requireDeps(deps);
    const caller = callerOf(context);
    try {
      const result = await narrowing.narrow(caller, {
        targetAgentId: input.agentId,
        connectionId: input.connectionId,
        change: changeOf(input),
        reason: input.reason,
      });
      return {
        changed: result.changed,
        changeId: result.changeId,
        note: result.changed
          ? 'Done. The person was told and can undo it.'
          : 'Nothing changed: that agent already had no more than that.',
      };
    } catch (error) {
      return narrowingError(error);
    }
  },
});

const AccessChangeSchema = z.object({
  changeId: z.string(),
  kind: z.string(),
  outcome: z.string(),
  refusalCode: z.string().nullable(),
  actorAgentId: z.string(),
  targetAgentId: z.string(),
  connectionId: z.string(),
  undone: z.boolean(),
  createdAt: z.string(),
});

const listAccessChanges = defineCapability({
  id: 'connectors.list_access_changes',
  title: 'List access changes you made or that were made to you',
  description:
    'List the changes to app access you made, or that another agent made to your access, ' +
    'newest first, with their changeId. Reasons are not included: only the person sees them.',
  tier: 'observe',
  area: null,
  areaNote: 'reads only the caller’s own ledger rows, never a reason',
  input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
  output: z.object({ changes: z.array(AccessChangeSchema) }),
  surfaces: {},
  invoke: async (deps, input, context) => {
    const { db } = requireDeps(deps);
    const caller = callerOf(context);
    const rows = db
      .select()
      .from(connectionGrantChanges)
      .where(
        and(
          or(
            eq(connectionGrantChanges.actorId, caller.agentId),
            eq(connectionGrantChanges.targetAgentId, caller.agentId)
          )
        )
      )
      .orderBy(desc(connectionGrantChanges.createdAt))
      .limit(input.limit ?? 20)
      .all();
    return {
      changes: rows.map((row) => ({
        changeId: row.id,
        kind: row.kind,
        outcome: row.outcome,
        refusalCode: row.refusalCode,
        actorAgentId: row.actorId,
        targetAgentId: row.targetAgentId,
        connectionId: row.connectionId,
        undone: row.undoneBy !== null,
        createdAt: row.createdAt,
      })),
    };
  },
});

/** The three tools, added to the connector runtime domain. */
export const ACCESS_CHANGE_CAPABILITIES = [narrowOwnAccess, narrowAgentAccess, listAccessChanges];
