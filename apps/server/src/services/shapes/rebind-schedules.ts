/**
 * The agent-create seam for Shape schedule re-binding (spec §"Contract changes"
 * item 3, DOR-355).
 *
 * When a Shape is applied before its offered agent exists, the schedule is
 * created global + disabled (apply-shape §7). Re-applying the Shape once the
 * agent exists re-binds it — but the user should not have to re-apply. This is
 * the other half of the promise: when a matching agent is created or registered,
 * any Shape schedule still waiting on it re-targets to the agent and enables,
 * without a re-apply. The Linear Ops flow it makes real: install shape → apply
 * (inbox-tick created disabled) → create "Linear Keeper" → the 15-minute tick
 * turns on.
 *
 * Pure and fully injected — the installed-Shape lister and the schedule service
 * are structural interfaces, so it is exercised with lightweight fakes. The
 * concrete wiring (call at the create seam) lives in the routes/index layer.
 *
 * @module services/shapes/rebind-schedules
 */
import type { ShapePackageManifest } from '@dorkos/marketplace';
import { matchesAgentByName, type ShapeScheduleServiceLike } from './apply-shape.js';

/** The just-created / just-registered agent a re-bind is evaluated against. */
export interface RebindAgent {
  /** The agent's id — schedules re-bind to this. */
  id: string;
  /** The agent's slug, matched against a Shape entry's `matchName`. */
  name: string;
  /** The agent's display name, also matched against `matchName`. */
  displayName?: string;
}

/** Injected collaborators for {@link rebindShapeSchedulesForAgent}. */
export interface RebindShapeSchedulesDeps {
  /** Every installed Shape manifest, scanned for schedules waiting on an agent. */
  listShapes(): Promise<ShapePackageManifest[]> | ShapePackageManifest[];
  /** The schedule service (its existing-list + re-bind operations). */
  scheduleService: ShapeScheduleServiceLike;
}

/**
 * Re-bind every installed Shape schedule that is waiting on `agent`. A schedule
 * is waiting when all three hold:
 *
 *  1. its `agentRef` resolves to a Shape agent entry whose `matchName` matches
 *     `agent` — the same rule apply-shape uses ({@link matchesAgentByName});
 *  2. a schedule with that name currently exists global (unbound); and
 *  3. that schedule's provenance marker names THIS Shape — a user can create
 *     their own global schedule with a colliding name via the tasks API, so
 *     name + unbound alone never proves ownership.
 *
 * A schedule that is already agent-bound is never touched, so a user who
 * disabled their own bound schedule keeps that choice; an unmarked or
 * other-Shape schedule is never touched either. Nothing is created — this only
 * re-targets copies an earlier apply already stood up.
 *
 * @param agent - The just-created / just-registered agent.
 * @param deps - Injected Shape lister + schedule service.
 * @returns The names of the schedules re-bound (empty when none were waiting).
 */
export async function rebindShapeSchedulesForAgent(
  agent: RebindAgent,
  deps: RebindShapeSchedulesDeps
): Promise<string[]> {
  const shapes = await deps.listShapes();
  const existingByName = new Map(
    (await deps.scheduleService.listSchedules()).map((s) => [s.name, s] as const)
  );

  const rebound: string[] = [];
  for (const shape of shapes) {
    // The Shape agent refs this new agent satisfies by matchName.
    const satisfiedRefs = new Set(
      shape.agents.filter((a) => matchesAgentByName(a.matchName, agent)).map((a) => a.ref)
    );
    if (satisfiedRefs.size === 0) continue;

    for (const schedule of shape.schedules) {
      if (!satisfiedRefs.has(schedule.agentRef)) continue;
      const existing = existingByName.get(schedule.name);
      // Only re-bind a schedule that exists, is still unbound (global), and
      // carries THIS Shape's provenance marker. An absent one was never
      // created; an already-bound one is left as-is; an unmarked or
      // other-Shape one is not ours to move.
      if (!existing || existing.agentId !== null || existing.shapeOrigin !== shape.name) continue;

      const enabled = !schedule.startDisabled;
      await deps.scheduleService.rebindSchedule(schedule.name, { agentId: agent.id, enabled });
      existingByName.set(schedule.name, {
        name: schedule.name,
        agentId: agent.id,
        enabled,
        shapeOrigin: shape.name,
      });
      rebound.push(schedule.name);
    }
  }
  return rebound;
}
