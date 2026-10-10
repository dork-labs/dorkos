/**
 * Builds the one {@link AgentPauseService} at startup (spec `audit-trail` PR5),
 * kept out of `index.ts` so the composition root only names it.
 *
 * Built before any runtime registers, so the hold at the runtime seam sees a
 * pause that outlived a restart from the first turn on.
 *
 * @module services/mesh/pause/wire-agent-pause
 */
import type { Db } from '@dorkos/db';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { TaskSchedulerService } from '../../tasks/task-scheduler-service.js';
import { AgentPauseService, initAgentPause } from './agent-pause.js';

/**
 * Build, register and return the pause service.
 *
 * @param db - The consolidated database, which holds the pauses in force.
 * @param scheduler - The task scheduler once it exists; pausing an agent stops
 *   the runs it already has going.
 */
export function wireAgentPause(
  db: Db,
  scheduler: () => Pick<TaskSchedulerService, 'cancelRunsForAgent'> | null
): AgentPauseService {
  const pauses = new AgentPauseService({
    db,
    // Read when a pause lands, so every runtime registered by then ends the
    // agent's sessions from its own records.
    runtimes: () => runtimeRegistry.listRuntimes(),
    onChange: () =>
      eventFanOut.broadcast('agent_pauses_changed', { changedAt: new Date().toISOString() }),
  });
  pauses.setTaskRunStopper(
    async (agentId) => (await scheduler()?.cancelRunsForAgent(agentId)) ?? 0
  );
  initAgentPause(pauses);
  return pauses;
}
