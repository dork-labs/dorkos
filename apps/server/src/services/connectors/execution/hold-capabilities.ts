/**
 * `connectors.cancel_held_action`: cancel another agent's irreversible action
 * in a connected app while it waits out its cancel window (spec
 * `trusted-by-default-flip` §5.6, DOR-2739).
 *
 * Any agent may cancel, and so may a person through `POST
 * /api/connectors/holds/:id/cancel`, except the agent that asked for the
 * action: it is refused whether it names itself by identity or by its chat.
 * Cancelling is the safe direction, so it never asks anyone.
 *
 * @module services/connectors/execution/hold-capabilities
 */
import { z } from 'zod';
import { CancelHeldActionResponseSchema } from '@dorkos/shared/connector-hold-schemas';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import type {
  CancelHoldResult,
  DestructiveHoldService,
  HoldCanceller,
} from './destructive-hold.js';

/** The hold service from the connector deps, or a tool error when it is not running. */
function requireHolds(deps: CapabilityDeps): DestructiveHoldService {
  const holds = deps.connectorExecutionDeps?.holds;
  if (!holds) {
    throw new CapabilityToolError({
      error: 'No action is waiting to run right now.',
      code: 'HOLD_NOT_FOUND',
    });
  }
  return holds;
}

/**
 * Who is cancelling, from what the surface verified about the caller.
 *
 * @param context - The handler context.
 * @returns The canceller.
 */
export function cancellerOf(context: CapabilityHandlerContext): HoldCanceller {
  if (context.trusted) return { kind: 'person' };
  if (context.identity) {
    return {
      kind: 'agent',
      agentPath: context.identity.agentPath,
      name: context.identity.displayName || 'Another agent',
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    };
  }
  return { kind: 'unidentified', ...(context.sessionId ? { sessionId: context.sessionId } : {}) };
}

/** The sentence a refused cancel answers with, by why. */
export const CANCEL_REFUSALS: Record<Exclude<CancelHoldResult, { ok: true }>['code'], string> = {
  HOLD_NOT_FOUND:
    'No action is waiting under that id. It already ran, was already cancelled, or DorkOS restarted.',
  HOLD_REQUESTER: 'The agent that asked for this action cannot cancel it. Anyone else can.',
};

/** Cancel a held connected-app action before it runs. */
export const cancelHeldAction = defineCapability({
  id: 'connectors.cancel_held_action',
  title: 'Cancel an action waiting to run in a connected app',
  description:
    "Cancel another agent's high-risk action in a connected app while it waits to run. " +
    'Such an action waits 60 seconds after it is asked for, and everyone is told. Its holdId is ' +
    'the resourceId of its connector.destructive_held event in the Activity log. A cancelled action ' +
    'does not run. The agent that asked for an action cannot cancel its own. This cannot undo ' +
    'an action that already ran.',
  tier: 'act',
  area: null,
  areaNote: 'cancelling only stops an action; it never does one',
  input: z
    .object({
      holdId: z
        .string()
        .min(1)
        .describe('The waiting action: its connector.destructive_held resourceId.'),
    })
    .strict(),
  output: CancelHeldActionResponseSchema,
  surfaces: {
    mcp: { toolName: 'connectors_cancel_held_action', servers: ['in-session', 'external'] },
  },
  invoke: async (deps, input, context) => {
    const result = requireHolds(deps).cancel(input.holdId, cancellerOf(context));
    if (!result.ok) {
      throw new CapabilityToolError({ error: CANCEL_REFUSALS[result.code], code: result.code });
    }
    return { status: 'cancelled' as const, holdId: input.holdId };
  },
});

/**
 * The held-action domain. Apart from `connectorExecutionDomain` on purpose:
 * that domain's verbs are reachable only from the authenticated connector
 * server, while cancelling is offered on both ordinary MCP servers, so any
 * agent (not only one with connected-app access) can stop another's action.
 * Composed whenever the connector execution services are.
 */
export const connectorHoldDomain: CapabilityDomain = {
  name: 'connectors',
  assertDeps: (deps) => {
    if (!deps.connectorExecutionDeps) {
      throw new Error('Connector hold capability requires connectorExecutionDeps.');
    }
  },
  capabilities: [cancelHeldAction],
};
