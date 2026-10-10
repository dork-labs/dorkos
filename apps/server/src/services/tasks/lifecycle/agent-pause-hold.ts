/**
 * How the scheduler holds a paused agent's runs (spec `audit-trail` PR5): a
 * scheduled fire or a person's Run now of a paused agent's task is recorded as
 * a skipped run and never started. The first skipped fire of each task in a
 * pause is one `agent.turn_held` audit row; the run rows record the rest.
 *
 * @module services/tasks/lifecycle/agent-pause-hold
 */
import type { AgentPauseService, PausedAgentRef } from '../../mesh/pause/index.js';
import type { TaskStore } from '../task-store.js';

/** The update that closes a run row. */
type RunUpdate = Parameters<TaskStore['updateRun']>[1];

/** Why a paused agent's run was not started, in the words a person reads on the run row. */
export const AGENT_PAUSED_SKIP_REASON = 'The agent is paused, so this run was skipped';

/** What the scheduler reads of the pause service. */
export type TaskAgentPauses = Pick<AgentPauseService, 'pausedAgent' | 'recordHeld'>;

/** The scheduler's view of which agents are paused, and its record of what it held. */
export class TaskPauseHold {
  /**
   * The pause (by when it began) each task's skipped fires were last recorded
   * under, so an hourly task paused for a week is one held row, not 168.
   */
  private readonly heldTaskPauses = new Map<string, string>();

  /**
   * Hold runs for paused agents.
   *
   * @param pauses - The pause service; `null` holds nothing (tests that do not care).
   */
  constructor(private readonly pauses: TaskAgentPauses | null) {}

  /**
   * The paused agent a task belongs to, if its agent is paused.
   *
   * @param agentId - The task's agent, if it has one.
   */
  pausedAgentOf(agentId: string | null | undefined): PausedAgentRef | undefined {
    return agentId ? this.pauses?.pausedAgent(agentId) : undefined;
  }

  /**
   * Record a person's Run now held by a pause, and answer the update that
   * closes its run row as skipped, saying why.
   *
   * @param paused - The paused agent.
   * @param runId - The run that was not started.
   */
  skipManualRun(paused: PausedAgentRef, runId: string): RunUpdate {
    this.pauses?.recordHeld(paused, { via: 'schedule', taskRunId: runId });
    return {
      status: 'skipped',
      error: AGENT_PAUSED_SKIP_REASON,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    };
  }

  /**
   * Record a scheduled fire skipped for a pause, once per task per pause:
   * every later fire has its own skipped run row already.
   *
   * @param taskId - The task whose fire was skipped.
   * @param paused - The paused agent.
   * @param runId - The skipped run.
   */
  recordScheduledSkip(taskId: string, paused: PausedAgentRef, runId: string): void {
    const pausedAt = paused.pausedAt ?? '';
    if (this.heldTaskPauses.get(taskId) === pausedAt) return;
    this.heldTaskPauses.set(taskId, pausedAt);
    this.pauses?.recordHeld(paused, { via: 'schedule', taskRunId: runId });
  }
}
