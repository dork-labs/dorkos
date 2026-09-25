/**
 * Where and when DorkOS looks for an agent's runtime, model or effort changed
 * outside DorkOS (DOR-2337), wired in one place so boot does not have to.
 *
 * {@link AgentExecutionObserver} decides what a change means; this decides
 * when to ask, and every answer here exists so no agent is ever seen for the
 * first time at the moment it matters. The first sighting of an agent is
 * silent (there is nothing to compare with), so an agent first seen AFTER an
 * edit would carry the edit in as its baseline. So every registered agent is
 * looked at:
 *
 * - at boot, before anything fires, and again after every five-minute pass;
 * - when it registers;
 * - when a person approves a schedule of its, or one is created approved,
 *   so a schedule that starts following it has something to be compared with;
 * - before every scheduled fire of one of its schedules, and the fire then
 *   runs on the values that check read ({@link AgentExecutionWatch.beforeScheduledFire}).
 *
 * It also installs the bracket DorkOS's own writes run through
 * (`agent-execution-writes.ts`), so a person's change is never taken for an
 * outside one.
 *
 * @module services/tasks/approvals/agent-execution-watch
 */
import path from 'node:path';
import type { Task } from '@dorkos/shared/types';

import type { ActivityService } from '../../activity/activity-service.js';
import { initAgentExecutionWrites } from '../../core/agent-observation/agent-execution-writes.js';
import type { AgentExecutionDefaults } from '../../session/resolve-session-defaults.js';
import type { TaskStore } from '../task-store.js';
import { AgentExecutionObserver, type AgentExecutionValues } from './agent-execution-observer.js';

/** A registered agent, as the watch needs it. */
export interface WatchedAgent {
  id: string;
  name: string;
  displayName?: string;
  projectPath: string;
}

/** What the watch needs. */
export interface AgentExecutionWatchDeps {
  /** DorkOS's data directory; the last-seen record lives inside it. */
  dorkHome: string;
  /** The task store whose approvals it parks and watches. */
  store: Pick<TaskStore, 'approvals' | 'getTask'>;
  /** Every registered agent, read fresh each time. */
  agents: () => readonly WatchedAgent[];
  /** Told about each schedule a change parked, to raise it for a person. */
  onParked: (tasks: readonly Task[]) => Promise<void>;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'> | undefined;
  /** Where a failure is reported. */
  logger: { warn: (...args: unknown[]) => void };
}

/** The running watch. */
export interface AgentExecutionWatch {
  /** Look at every registered agent. Boot and the five-minute pass call this. */
  checkAll(): Promise<void>;
  /** Look at one agent, by its project directory. Registration calls this. */
  checkAgent(agentPath: string): Promise<void>;
  /**
   * Look at a task's agent just before its scheduled fire, and answer what was
   * read, for the run to resolve on.
   */
  beforeScheduledFire(task: Task): Promise<AgentExecutionDefaults | undefined>;
  /** Uninstall the hooks this installed. */
  stop(): void;
}

/**
 * Where the last-seen record lives: beside the permission record, in DorkOS's
 * own state, never in the agents' tree an agent's file tools can reach as
 * part of its own folder.
 *
 * @param dorkHome - DorkOS's data directory.
 */
export function agentExecutionRecordPath(dorkHome: string): string {
  return path.join(dorkHome, 'permissions', 'observed-agent-execution.json');
}

/** The values a check read, in the shape the run resolver takes. */
function asExecutionDefaults(values: AgentExecutionValues): AgentExecutionDefaults {
  return {
    ...(values.runtime !== null ? { runtime: values.runtime } : {}),
    ...(values.model !== null ? { model: values.model } : {}),
    // Read off a schema-validated manifest, so it is a rung the ladder knows.
    ...(values.effort !== null
      ? { effort: values.effort as AgentExecutionDefaults['effort'] }
      : {}),
  };
}

/**
 * Start watching for outside changes to agents' runtime, model and effort.
 *
 * @param deps - What the watch needs.
 */
export function startAgentExecutionWatch(deps: AgentExecutionWatchDeps): AgentExecutionWatch {
  const agentAt = (agentPath: string) => {
    const agent = deps.agents().find((a) => a.projectPath === agentPath);
    return agent ? { id: agent.id, name: agent.displayName || agent.name } : undefined;
  };
  const pathOf = (agentId: string) => deps.agents().find((a) => a.id === agentId)?.projectPath;

  const observer = new AgentExecutionObserver({
    snapshotFile: agentExecutionRecordPath(deps.dorkHome),
    agentAt,
    approvals: deps.store.approvals,
    onParked: async (ids) => {
      const tasks = ids.map((id) => deps.store.getTask(id)).filter((t): t is Task => t !== null);
      await deps.onParked(tasks);
    },
    activity: deps.activity,
    logger: deps.logger,
  });

  initAgentExecutionWrites((agentPath, write) => observer.writingExecution(agentPath, write));
  deps.store.approvals.setOnApproved((agentId) => {
    const agentPath = pathOf(agentId);
    // Never awaited: an approval is a synchronous store write. The check is
    // queued behind any other for the same agent, and never throws.
    if (agentPath) void observer.check(agentPath);
  });

  return {
    checkAll: async () => {
      for (const agent of deps.agents()) await observer.check(agent.projectPath);
    },
    checkAgent: async (agentPath) => {
      await observer.check(agentPath);
    },
    beforeScheduledFire: async (task) => {
      const agentPath = task.agentId ? pathOf(task.agentId) : undefined;
      if (!agentPath) return undefined;
      const values = await observer.check(agentPath);
      return values ? asExecutionDefaults(values) : undefined;
    },
    stop: () => {
      initAgentExecutionWrites(undefined);
      deps.store.approvals.setOnApproved(null);
    },
  };
}
