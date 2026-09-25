/**
 * Notices a change to an agent's runtime, model or effort that nobody made
 * through DorkOS, and re-asks for the approved schedules it would move
 * (DOR-2337).
 *
 * A schedule that leaves its runtime, model or effort unset runs on its
 * agent's, and a person's approval of it records "follow the agent", not the
 * agent's value (DOR-2323). DOR-2328 put every DorkOS door that changes those
 * three for an agent behind a person. What it left, on purpose, is the file:
 * `.dork/agent.json` is the person's to edit (the DOR-2306 line), and DorkOS
 * cannot tell the person's editor from an agent's shell writing the same bytes.
 *
 * This does not police the disk. It makes such an edit visible and re-asks for
 * the approved work it would move:
 *
 * - the change is recorded in Activity as "Changed outside DorkOS", old → new;
 * - every approved schedule that follows the agent for a changed part waits for
 *   a person again, and its card shows the change old → new
 *   (`TaskApprovals.parkAgentFollowers`);
 * - nothing is ever switched on, and changing the agent back does not undo the
 *   park: a person decides.
 *
 * **When it looks.** Before every scheduled fire of a schedule with an agent
 * (the fire reads the manifest fresh, so an edit is caught before it can run),
 * and on the task reconciler's five-minute pass, so the card appears without
 * waiting for a fire. An edit that lands in the few milliseconds between the
 * check and the fire's own read of the manifest runs once, and is caught by the
 * next check.
 *
 * **What is not outside.** A write DorkOS makes, through the app, the routes or
 * an approved `update_agent_execution`, is bracketed by
 * {@link AgentExecutionObserver.writingExecution}: an earlier outside edit is
 * observed first (so the DorkOS write cannot absorb it), then the write moves
 * the last-seen value with it. The person's own changes never park anything.
 *
 * @module services/tasks/approvals/agent-execution-observer
 */
import { readManifest } from '@dorkos/shared/manifest';

import type { ActivityService } from '../../activity/activity-service.js';
import {
  OutsideChangeObserver,
  type ObservedAgentRef,
} from '../../core/agent-observation/outside-change-observer.js';
import type { FollowedAgentChange, FollowedAgentField } from '../schedule-permission-clamp.js';
import type { TaskApprovals } from './task-approvals.js';

/** An agent's execution defaults, as compared. `null` is "not set". */
export interface AgentExecutionValues {
  runtime: string | null;
  model: string | null;
  effort: string | null;
}

/** The Activity event a change made outside DorkOS is recorded as. */
export const AGENT_EXECUTION_CHANGED_OUTSIDE_EVENT = 'agent.execution_changed_outside';

/** The Activity event said once when the last-seen record cannot be read. */
export const AGENT_EXECUTION_CHECK_UNAVAILABLE_EVENT = 'agent.execution_check_unavailable';

/** How the record names each field. */
const LABEL: Record<FollowedAgentField, string> = {
  runtime: 'runtime',
  model: 'model',
  effort: 'effort',
};

const FIELDS: readonly FollowedAgentField[] = ['runtime', 'model', 'effort'];

/** What the observer needs. */
export interface AgentExecutionObserverDeps {
  /** Where the last-seen values are kept, inside DorkOS's data directory. */
  snapshotFile: string;
  /** The registered agent at a project path; only a registered agent is observed. */
  agentAt: (agentPath: string) => ObservedAgentRef | undefined;
  /** Parks the approved schedules that follow an agent. */
  approvals: Pick<TaskApprovals, 'parkAgentFollowers'>;
  /** Told about each schedule a change parked, to raise it for a person. */
  onParked: (taskIds: readonly string[]) => Promise<void>;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'> | undefined;
  /** Where a failure is reported; observing never fails the caller. */
  logger: { warn: (...args: unknown[]) => void };
  /** Reads the values off a manifest; the manifest reader by default. */
  read?: (agentPath: string) => Promise<AgentExecutionValues>;
}

/**
 * Read an agent's execution defaults off its manifest. Throws when there is no
 * manifest to read, so a missing or broken file is never mistaken for every
 * value being cleared.
 *
 * @param agentPath - The agent's project directory.
 */
async function readExecutionValues(agentPath: string): Promise<AgentExecutionValues> {
  const manifest = await readManifest(agentPath);
  if (!manifest) throw new Error(`No readable agent manifest at ${agentPath}`);
  return {
    runtime: manifest.runtime ?? null,
    model: manifest.model ?? null,
    effort: manifest.effort ?? null,
  };
}

/** One value as the record says it. */
function say(value: string | null): string {
  return value ?? 'the default';
}

/**
 * Records runtime, model and effort changes made to an agent's file outside
 * DorkOS, and re-asks for the approved schedules they would move.
 */
export class AgentExecutionObserver {
  private readonly core: OutsideChangeObserver<AgentExecutionValues, AgentExecutionValues>;
  private readonly read: (agentPath: string) => Promise<AgentExecutionValues>;

  constructor(private readonly deps: AgentExecutionObserverDeps) {
    this.read = deps.read ?? readExecutionValues;
    this.core = new OutsideChangeObserver({
      snapshotFile: deps.snapshotFile,
      agentAt: deps.agentAt,
      read: this.read,
      canonical: (value) => ({
        runtime: value.runtime ?? null,
        model: value.model ?? null,
        effort: value.effort ?? null,
      }),
      onChange: async ({ agent, agentPath, before, after }) => {
        const changes: FollowedAgentChange[] = FIELDS.filter(
          (field) => before[field] !== after[field]
        ).map((field) => ({ field, from: before[field], to: after[field] }));
        if (changes.length === 0) return;
        // The park first, and a person told of it, because those stop work;
        // the Activity line last. A repeat after a failed line parks nothing
        // twice and raises nothing twice: the schedules are already waiting.
        const { parked, updated } = deps.approvals.parkAgentFollowers(agent.id, changes);
        if (parked.length > 0) await deps.onParked(parked);
        await this.record(agent, agentPath, changes, parked.length + updated.length);
      },
      reportUnreadable: async (agent, agentPath) => {
        if (!deps.activity) return;
        await deps.activity.emit({
          actorType: 'system',
          actorLabel: 'DorkOS',
          category: 'agent',
          eventType: AGENT_EXECUTION_CHECK_UNAVAILABLE_EVENT,
          resourceType: 'agent',
          resourceId: agent.id,
          resourceLabel: agent.name,
          summary: `${agent.name}: DorkOS can't check this agent's runtime, model and effort for outside changes right now`,
          linkPath: null,
          metadata: { agentPath },
        });
      },
      logger: deps.logger,
      logLabel: '[AgentExecution]',
    });
  }

  /** The Activity line for one change. */
  private async record(
    agent: ObservedAgentRef,
    agentPath: string,
    changes: readonly FollowedAgentChange[],
    waiting: number
  ): Promise<void> {
    if (!this.deps.activity) return;
    const what = changes.map((c) => `${LABEL[c.field]} ${say(c.from)} → ${say(c.to)}`).join(', ');
    const waitingLine =
      waiting === 0
        ? ''
        : `. ${waiting} scheduled task${waiting === 1 ? ' that follows it is' : 's that follow it are'} waiting for you again`;
    await this.deps.activity.emit({
      actorType: 'system',
      actorLabel: 'Changed outside DorkOS',
      category: 'agent',
      eventType: AGENT_EXECUTION_CHANGED_OUTSIDE_EVENT,
      resourceType: 'agent',
      resourceId: agent.id,
      resourceLabel: agent.name,
      summary: `${agent.name}'s ${what}, changed outside DorkOS${waitingLine}`,
      linkPath: waiting === 0 ? null : '/tasks',
      metadata: { agentPath, changes, waiting },
    });
  }

  /**
   * Compare an agent's runtime, model and effort with the last values DorkOS
   * saw, and act on a difference. Never throws: a manifest that cannot be read
   * is not a change, and a failure is logged.
   *
   * @param agentPath - The agent's project directory.
   */
  async check(agentPath: string): Promise<void> {
    try {
      await this.core.readObserved(agentPath);
    } catch (err) {
      this.deps.logger.warn('[AgentExecution] Could not read an agent to check it', {
        agentPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Run one of DorkOS's own writes that may change an agent's runtime, model or
   * effort, so it is never taken for an outside change.
   *
   * An outside edit made before it is observed FIRST: the write merges into the
   * manifest, so without that it would carry the edit through and the edit
   * would never be seen.
   *
   * @param agentPath - The agent's project directory.
   * @param write - The write itself.
   */
  async writingExecution(agentPath: string, write: () => Promise<void>): Promise<void> {
    await this.check(agentPath);
    await this.core.writing(agentPath, () => this.read(agentPath), write);
  }
}
