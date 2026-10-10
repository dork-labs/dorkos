/**
 * The two things every surface that writes `reportsTo` does (spec `heartbeats`
 * §4.1, §4.2): refuse a manager who does not exist or would close a loop, and
 * record a change once it has landed.
 *
 * One module so `update_agent`, the profile picker's route and the operator's
 * agent PATCH answer in the same words with the same code, and record the same
 * row.
 *
 * @module services/heartbeats/reports-to-writes
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { recordAudit } from '../audit/audit-trail.js';
import { createReportsToChain, type ReportsToMesh } from './reports-to.js';

export type { ReportsToMesh } from './reports-to.js';

/** The error code every write surface refuses a loop with. */
export const REPORTS_TO_CYCLE_CODE = 'REPORTS_TO_CYCLE';

/** Plain words for a refused loop, shared by every surface that refuses one. */
export const REPORTS_TO_CYCLE_MESSAGE =
  'That would make a loop: an agent can’t report to someone who reports to it.';

/** Plain words for a manager nobody can find. */
export const REPORTS_TO_UNKNOWN_MESSAGE = 'No agent or person has that id.';

/** Why a reports-to write was refused. */
export interface ReportsToRefusal {
  /** `REPORTS_TO_CYCLE` for a loop, `VALIDATION` for a manager who does not exist. */
  code: typeof REPORTS_TO_CYCLE_CODE | 'VALIDATION';
  /** One plain sentence, safe to show a person. */
  message: string;
}

/**
 * Whether making `newManagerId` the manager of `agentId` may be stored.
 *
 * Clearing (`null`) is always allowed: it returns the agent to the default
 * chain, which ends at a person by construction. Without a mesh to walk (a unit
 * test, a script), only the one loop that needs no lookup is caught: an agent
 * naming itself.
 *
 * @param mesh - Where agents are looked up.
 * @param agentId - The agent being changed.
 * @param newManagerId - The account id it would report to, or `null`.
 * @returns The refusal, or `null` when the write may go ahead.
 */
export function checkReportsToWrite(
  mesh: Partial<ReportsToMesh> | undefined,
  agentId: string,
  newManagerId: string | null
): ReportsToRefusal | null {
  if (newManagerId === null) return null;
  if (newManagerId === agentId) {
    return { code: REPORTS_TO_CYCLE_CODE, message: REPORTS_TO_CYCLE_MESSAGE };
  }
  if (!mesh?.get) return null;
  const chain = createReportsToChain({ get: mesh.get.bind(mesh) });
  if (!chain.names(newManagerId))
    return { code: 'VALIDATION', message: REPORTS_TO_UNKNOWN_MESSAGE };
  if (chain.wouldCreateCycle(agentId, newManagerId)) {
    return { code: REPORTS_TO_CYCLE_CODE, message: REPORTS_TO_CYCLE_MESSAGE };
  }
  return null;
}

/**
 * The value to store for a manager a write named: the owner's canonical
 * account id for any of the owner's aliases, anything else unchanged.
 *
 * @param mesh - Where agents are looked up (an agent id is never rewritten).
 * @param newManagerId - The account id the write named, or `null`.
 */
export function canonicalReportsTo(
  mesh: Partial<ReportsToMesh> | undefined,
  newManagerId: string | null
): string | null {
  if (newManagerId === null) return null;
  const get = mesh?.get ? mesh.get.bind(mesh) : () => undefined;
  return createReportsToChain({ get }).canonical(newManagerId);
}

/**
 * Record that an agent's manager changed (`agent.reports_to_changed`), as the
 * person or agent of the current audit scope. Nothing is recorded when the
 * value did not move.
 *
 * @param agent - The agent whose manager changed.
 * @param before - Its `reportsTo` before the write, `null` when unset.
 * @param after - Its `reportsTo` after the write, `null` when unset.
 */
export function recordReportsToChange(
  agent: Pick<AgentManifest, 'id' | 'name' | 'displayName'>,
  before: string | null,
  after: string | null
): void {
  if (before === after) return;
  recordAudit({
    action: 'agent.reports_to_changed',
    operation: 'modify',
    target: { type: 'agent', id: agent.id, name: agent.displayName ?? agent.name },
    outcome: 'ok',
    change: [{ field: 'reportsTo', before, after }],
    summary:
      after === null ? 'Reports to its default manager again.' : 'Changed who it reports to.',
    visibility: 'space',
  });
}
