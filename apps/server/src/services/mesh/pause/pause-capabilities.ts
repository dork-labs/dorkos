/**
 * The `agent.pause` and `agent.resume` capabilities (spec `audit-trail` PR5).
 *
 * Declared once here; the registry projects them onto both MCP servers
 * (`pause_agent`, `resume_agent`), `dorkos call agent.pause`, and the OpenAPI
 * document for `POST /api/agents/{agentId}/pause|resume` (served by
 * `routes/agent-pause.ts`, which invokes these through the registry so every
 * surface is gated and recorded the same way).
 *
 * **Both are `act` with no permission area, and that is the carve-out.** They
 * are the emergency lever: a person, or any agent, must be able to stop an
 * agent without waiting on an approval card under any preset. An action with
 * no area is decided by its tier alone, and an `act` with no area is allowed;
 * `permission-enforcement.ts` names both in `NEVER_ASKS_ACTIONS` so a later
 * edit that gives them an area still cannot make them ask, and a test pins it
 * under the strictest preset. A revoked agent identity is still refused, as for
 * every non-read action: revocation is a person saying stop.
 *
 * Who may lift a pause is the service's rule, not the gate's: anyone except the
 * paused agent itself (`CANNOT_RESUME_SELF`).
 *
 * @module services/mesh/pause/pause-capabilities
 */
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import {
  AgentPauseListSchema,
  AgentPauseRequestSchema,
  AgentPauseResultSchema,
} from '@dorkos/shared/mesh-schemas';
import { z } from 'zod';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../../core/capabilities/index.js';
import { auditTrail } from '../../audit/audit-trail.js';
import { currentAuditActor } from '../../audit/audit-context.js';
import {
  CannotResumeSelfError,
  PauseAgentNotFoundError,
  type AgentPauseService,
} from './agent-pause.js';

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the server can pause agents; gates the `agent` pause domain. */
    agentPauseDeps?: {
      /** The pause service. */
      pauses: Pick<AgentPauseService, 'pause' | 'resume' | 'list'>;
    };
  }
}

/**
 * Narrow the bag to the pause service, throwing if the registry was composed
 * without it (a wiring bug, caught at boot by `assertDeps`).
 *
 * @param deps - The capability bag.
 */
function requirePauseDeps(
  deps: CapabilityDeps
): Pick<AgentPauseService, 'pause' | 'resume' | 'list'> {
  if (!deps.agentPauseDeps) {
    throw new Error('Agent pause capability invoked without agentPauseDeps in the registry bag.');
  }
  return deps.agentPauseDeps.pauses;
}

/**
 * Who is calling, as the audit log names them: the agent its token named, an
 * agent DorkOS could not name, or whoever the request's scope says (the person
 * at the app, or the owner).
 *
 * @param context - The call's context.
 */
function pauseActorOf(context: CapabilityHandlerContext): AuditActor {
  const trail = auditTrail();
  const name = context.identity?.displayName ?? 'Agent';
  if (context.identity) {
    return trail
      ? trail.accounts.forAgentIdentity(context.identity)
      : { accountId: context.identity.agentPath, kind: 'agent', name };
  }
  if (context.agentIdentityPresented) {
    return trail
      ? trail.accounts.unidentified('Unidentified caller')
      : { accountId: 'unidentified', kind: 'external', name: 'Unidentified caller' };
  }
  const scoped = currentAuditActor()?.actor;
  if (scoped) return scoped;
  if (context.userId && trail) return trail.accounts.forUser(context.userId);
  return trail ? trail.accounts.owner() : { accountId: 'owner', kind: 'person', name: 'Owner' };
}

/** Turn the service's typed refusals into the tool error every surface shows. */
function asToolError(err: unknown): never {
  if (err instanceof CannotResumeSelfError || err instanceof PauseAgentNotFoundError) {
    throw new CapabilityToolError({ error: err.message, code: err.code });
  }
  throw err;
}

/** The capability ids; `NEVER_ASKS_ACTIONS` names the same two. */
const AGENT_PAUSE_CAPABILITY_ID = 'agent.pause';
const AGENT_RESUME_CAPABILITY_ID = 'agent.resume';

/** The agent pause domain. */
export const agentPauseDomain: CapabilityDomain = {
  name: 'agent',
  assertDeps: requirePauseDeps,
  capabilities: [
    defineCapability({
      id: AGENT_PAUSE_CAPABILITY_ID,
      title: 'Pause an agent everywhere',
      description:
        'Stop an agent everywhere at once: its running turns end, its running scheduled runs ' +
        'stop, and nothing starts a new turn for it (messages, schedules, rooms, relay) until ' +
        'someone resumes it. Anyone may pause any agent, including DorkBot; it never waits for ' +
        'approval. Held work is not replayed later. Recorded with who did it and why. Pass ' +
        'the mesh id of the agent and, ideally, a reason.',
      tier: 'act',
      area: null,
      areaNote: 'emergency stop: never asks',
      input: AgentPauseRequestSchema,
      output: AgentPauseResultSchema,
      surfaces: {
        mcp: {
          toolName: 'pause_agent',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
        cli: { verb: 'agent', subcommand: 'pause' },
        http: { method: 'post', path: '/api/agents/{agentId}/pause' },
      },
      invoke: async (deps, input, context) =>
        requirePauseDeps(deps)
          .pause(input.agentId, pauseActorOf(context), input.reason)
          .catch(asToolError),
    }),
    defineCapability({
      id: AGENT_RESUME_CAPABILITY_ID,
      title: 'Resume a paused agent',
      description:
        'Lift a pause so the agent can work again. Anyone may resume an agent except the paused ' +
        'agent itself. Work it was held from is not replayed. Recorded with who did it and why.',
      tier: 'act',
      area: null,
      areaNote: 'emergency stop: never asks',
      input: AgentPauseRequestSchema,
      output: AgentPauseResultSchema,
      surfaces: {
        mcp: {
          toolName: 'resume_agent',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
        cli: { verb: 'agent', subcommand: 'resume' },
        http: { method: 'post', path: '/api/agents/{agentId}/resume' },
      },
      invoke: async (deps, input, context) => {
        try {
          return requirePauseDeps(deps).resume(input.agentId, pauseActorOf(context), input.reason);
        } catch (err) {
          return asToolError(err);
        }
      },
    }),
    defineCapability({
      id: 'agent.list_paused',
      title: 'List paused agents',
      description: 'List every agent that is paused right now, with who paused it, when, and why.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object({}),
      output: AgentPauseListSchema,
      surfaces: {
        mcp: {
          toolName: 'list_paused_agents',
          servers: ['in-session', 'external'],
          annotations: { idempotentHint: true },
        },
        http: { method: 'get', path: '/api/agents/pauses' },
      },
      invoke: async (deps) => ({ pauses: requirePauseDeps(deps).list() }),
    }),
  ],
};
