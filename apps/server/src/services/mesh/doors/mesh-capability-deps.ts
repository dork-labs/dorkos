/**
 * What the agent registry's doors on `/api/mesh/*` read (DOR-4978,
 * ADR 261123-170830), and the helpers the reads and a person's writes share.
 *
 * @module services/mesh/doors/mesh-capability-deps
 */
import type { MeshCore } from '@dorkos/mesh';

import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';
import type { ActivityService } from '../../activity/activity-service.js';
import type { TopologyEnrichmentDeps } from '../../../routes/mesh-topology.js';

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The agent registry's doors: the registry, the feed, and what topology counts read. */
    meshDeps?: MeshCapabilityDeps;
  }
}

/** The registry, the activity feed and the subsystems the topology view reads. */
export interface MeshCapabilityDeps extends TopologyEnrichmentDeps {
  /** The agent registry. */
  meshCore: MeshCore;
  /** Where registrations and removals are recorded; absent in a test that does not watch it. */
  activity?: ActivityService;
}

/**
 * The registry's deps, or a throw when the mesh did not start.
 *
 * @param deps - The composed dependency bag.
 */
export function meshOf(deps: CapabilityDeps): MeshCapabilityDeps {
  if (!deps.meshDeps) throw new Error('The agent registry is unavailable.');
  return deps.meshDeps;
}

/**
 * Whether an agent, or a machine that presented an agent token, is asking.
 * The person at the app presents neither.
 *
 * @param context - The call's context.
 */
export function agentIsAsking(context: CapabilityHandlerContext): boolean {
  return context.identity !== undefined || context.agentIdentityPresented === true;
}

/** The Mesh id a path names. */
export const MESH_AGENT_PARAM = { id: 'agentId' } as const;

/** Why a person's registry door has no permission area: no agent can call it. */
export const PERSON_DOOR_NOTE = 'a person’s own registry change; agents use the mesh_ tools';
