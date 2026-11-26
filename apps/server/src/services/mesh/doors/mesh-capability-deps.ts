/**
 * What the agent registry's doors on `/api/mesh/*` read (DOR-4978,
 * ADR 261123-170830), and the helpers the reads and a person's writes share.
 *
 * @module services/mesh/doors/mesh-capability-deps
 */
import type { MeshCore } from '@dorkos/mesh';
import type { TopologyView } from '@dorkos/shared/mesh-schemas';

import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';
import type { ActivityService } from '../../activity/activity-service.js';

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The agent registry's doors: the registry, the feed, and what topology counts read. */
    meshDeps?: MeshCapabilityDeps;
  }
}

/** The registry and the subsystems the topology view's counts are read from. */
export interface MeshTopologySources {
  /** The agent registry. */
  meshCore: MeshCore;
  /** Task store for per-agent schedule counts; only enabled, `active` tasks count. */
  taskStore?: {
    getTasks(): Array<{ agentId: string | null; enabled: boolean; status: string }>;
  };
  /** Relay, for the endpoints an agent's adapters are read from. */
  relayCore?: { listEndpoints(): Array<{ subject: string }> };
}

/** The registry's view, each agent enriched with its health, Relay adapters and schedules. */
export type EnrichTopology = (topology: TopologyView, sources: MeshTopologySources) => TopologyView;

/** An agent with the computer it runs on, when the canonical path has one bound. */
export type ProjectComputerPlacement = <T extends { projectPath?: string }>(
  agent: T
) => T & { effectiveRuntimeId?: string };

/** The same, for an agent read without its path, found by id among `paths`. */
export type ProjectComputerPlacementById = <T extends { id: string }>(
  agent: T,
  paths: readonly { id: string; projectPath: string }[]
) => T & { effectiveRuntimeId?: string };

/**
 * How the reads shape what they answer. The composition root passes the mesh
 * routes' own (`routes/mesh-topology.ts`, `routes/computer-placement.ts`), so
 * a door and a route answer alike.
 */
export interface MeshReadViews {
  enrichTopology: EnrichTopology;
  projectPlacement: ProjectComputerPlacement;
  projectPlacementById: ProjectComputerPlacementById;
}

/** The registry, the activity feed and the subsystems the topology view reads. */
export interface MeshCapabilityDeps extends MeshTopologySources {
  /** Where registrations and removals are recorded; absent in a test that does not watch it. */
  activity?: ActivityService;
  /** How the reads shape what they answer. */
  views: MeshReadViews;
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
