/**
 * A scheduled task one agent makes or changes for ANOTHER agent (DOR-3938). Below Full autonomy
 * an agent schedules only for itself or `global` (DOR-3640 R1, `schedule-owner.ts`). A turn that
 * really runs at Full may schedule for any registered agent, on Security's five conditions:
 *
 * 1. Full is read from the server: the level this process recorded for the calling turn, its
 *    ceiling applied (`turn-levels.ts`), never the agent's stored setting or the tool's input.
 * 2. A marked turn is refused: any mark at all, an outsider's or a teammate's.
 * 3. The task keeps who made it (the proposer's agent and chat) and the marks of that turn, and
 *    each run records them and starts with those marks, as a `chat_send` hop does.
 * 4. Its mode is capped at the target agent's own level, Bypass included, at create and at every
 *    later edit by another agent.
 * 5. Pinned by `__tests__/cross-agent-tasks.test.ts`.
 *
 * @module services/tasks/approvals/cross-agent
 */
import type { MeshCore } from '@dorkos/mesh';
import type { MessageOpts, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { ScheduleOriginMarks } from '@dorkos/shared/schemas';
import type { Task } from '@dorkos/shared/types';
import {
  clampModeToCeiling,
  levelOfMode,
  READ_ONLY_LEVEL,
} from '@dorkos/shared/permission-semantics';
import { lastTurnLevelOf, marksOf } from '../../core/turn-power/turn-levels.js';
import {
  ceilingCarrying,
  hasMarks,
  marksOfLevel,
  mergeMarks,
  NO_MARKS,
  parseStoredMarks,
  type TurnMarks,
} from '../../core/turn-power/turn-marks.js';
import { isFullLevel } from '../../core/turn-power/full-autonomy.js';
import { resolveAgentLaunchLevel } from '../../session/resolution/agent-launch-level.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { logError, logger } from '../../../lib/logger.js';
import { agentIdOfHome } from './schedule-owner.js';

/** Claude Code's modes that ask before a command (or only plan), for a runtime with no declaration. */
const ASKING_MODES: ReadonlySet<string> = new Set(['plan', 'default']);

/** Mesh, as far as naming registered agents goes; absent when Mesh is off. */
type MeshNames = Pick<MeshCore, 'listWithPaths'> | null | undefined;

/** The calling turn, as the server resolved it. Never read from a tool's input. */
export interface CrossAgentCaller {
  /** The calling chat's canonical id. */
  sessionId?: string;
  /** Every id the chat's turn level may be kept under. */
  turnSessionIds?: readonly string[];
  /** The calling agent's verified home. */
  agentPath?: string;
}

/** Why a cross-agent write was refused. */
export interface CrossAgentRefusal {
  error: string;
  code: 'cross_agent_needs_full' | 'cross_agent_marked_turn';
}

/** The refusal for a turn below Full autonomy, or one whose level DorkOS does not know. */
export const CROSS_AGENT_NEEDS_FULL_MESSAGE =
  'Only a chat running at Full autonomy can schedule or change a task for another agent. ' +
  'Use your own agent id as the target, or "global", or ask a person.';

/** The refusal for a Full turn that read words from outside, or a teammate's. */
export const CROSS_AGENT_MARKED_MESSAGE =
  'This chat read messages from others, so it cannot schedule or change a task for another ' +
  'agent in this turn. A person can, or you can schedule it for yourself.';

/**
 * Whether the calling turn may schedule for, or change a task of, another agent: it runs at Full
 * autonomy right now and carries no mark. Fails closed: no chat, or a chat this process ran no
 * turn on, is not Full.
 *
 * @param caller - The calling turn, as the server resolved it.
 * @returns `null` when it may, else the refusal.
 */
export function crossAgentRefusal(caller: CrossAgentCaller): CrossAgentRefusal | null {
  const ids = [...new Set([caller.sessionId, ...(caller.turnSessionIds ?? [])])].filter(
    (id): id is string => typeof id === 'string' && id !== ''
  );
  const levels = ids.map(lastTurnLevelOf);
  const known = levels.filter((level) => level !== undefined);
  if (known.length === 0 || !known.every(isFullLevel)) {
    return { error: CROSS_AGENT_NEEDS_FULL_MESSAGE, code: 'cross_agent_needs_full' };
  }
  const marks = known
    .map(marksOfLevel)
    .reduce(mergeMarks, marksOf(caller.sessionId, caller.agentPath));
  if (hasMarks(marks)) {
    return { error: CROSS_AGENT_MARKED_MESSAGE, code: 'cross_agent_marked_turn' };
  }
  return null;
}

/**
 * Whether `target` names an agent other than the caller (`global` and the caller itself do not).
 *
 * @param target - The target a create names, or a task's stored agent id.
 * @param callerAgentPath - The calling agent's verified home.
 * @param meshCore - Mesh, which names each registered home.
 */
export function isForAnotherAgent(
  target: string | null | undefined,
  callerAgentPath: string | undefined,
  meshCore: MeshNames
): boolean {
  if (!target || target === 'global') return false;
  const callerId = callerAgentPath
    ? agentIdOfHome(meshCore ?? undefined, callerAgentPath)
    : undefined;
  return target !== callerId;
}

/**
 * A mode capped at an agent's own level (its Files & commands stop, read through the permission
 * gate), on the runtime the task runs on. Bypass is capped too: a target below Full never gets a
 * Full task. Fails closed: an unreadable level caps at the runtime's default, and a runtime that
 * declares no modes at Read only.
 *
 * @param mode - The mode the task would be saved with.
 * @param agentPath - The target agent's folder.
 * @param capabilities - The capabilities of the runtime the task runs on.
 */
export async function capModeAtAgentLevel(
  mode: string,
  agentPath: string | undefined,
  capabilities: RuntimeCapabilities | undefined
): Promise<string> {
  const declared = capabilities?.permissionModes;
  // No declared modes to compare with: only the modes that ask before a command or never act.
  if (!declared?.supported || declared.values.length === 0) {
    return ASKING_MODES.has(mode) ? mode : 'default';
  }
  let agentMode: string | undefined;
  try {
    if (agentPath) agentMode = (await resolveAgentLaunchLevel({ agentPath, capabilities })).mode;
  } catch (err) {
    logger.warn("[tasks] could not read the target agent's level; capping at the default", {
      agentPath,
      ...logError(err),
    });
  }
  const bound = levelOfMode(declared, agentMode ?? declared.default) ?? READ_ONLY_LEVEL;
  return clampModeToCeiling(declared, mode, bound);
}

/**
 * An agent's name for a line a person reads, by its Mesh id: its display name, else its name,
 * else "another agent".
 *
 * @param meshCore - Mesh, which names each registered agent.
 * @param agentId - The agent's Mesh id.
 */
export function agentNameOf(meshCore: MeshNames, agentId: string | null | undefined): string {
  const agent = agentId ? meshCore?.listWithPaths().find((a) => a.id === agentId) : undefined;
  return agent?.displayName || agent?.name || 'another agent';
}

/**
 * Write the audit row for a task one agent made or changed for another: who, for which agent,
 * and at what mode. Never throws; the write already happened.
 *
 * @param task - The task as it now stands.
 * @param action - Whether it was made or changed.
 * @param creatorAgentPath - The agent that did it.
 * @param meshCore - Mesh, to name the agent it is for.
 */
export function auditCrossAgentTask(
  task: Pick<Task, 'id' | 'name' | 'displayName' | 'agentId' | 'permissionMode'>,
  action: 'create' | 'modify',
  creatorAgentPath: string | undefined,
  meshCore?: MeshNames
): void {
  try {
    recordAudit({
      action: action === 'create' ? 'tasks.create_for_agent' : 'tasks.update_for_agent',
      operation: action,
      target: { type: 'task', id: task.id, name: task.displayName ?? task.name },
      outcome: 'ok',
      change: [
        { field: 'createdBy', after: creatorAgentPath ?? null },
        { field: 'createdFor', after: task.agentId },
        { field: 'permissionMode', after: task.permissionMode },
      ],
      summary:
        `${action === 'create' ? 'Scheduled' : 'Changed'} task ${task.displayName ?? task.name} ` +
        `for ${agentNameOf(meshCore, task.agentId)}`,
    });
  } catch (err) {
    logger.warn('[tasks] could not record a task made for another agent', logError(err));
  }
}

/** Who made a task, as each of its runs records it (Security's Must 3). */
export interface RunCreator {
  /** The agent that made the task. */
  agentPath: string;
  /** The chat it was made from, when known. */
  sessionId: string | null;
  /** The marks that chat's turn carried, as stored on the task. */
  marks: TurnMarks;
}

/** The parts of a task its creator is read from. */
type CreatedTask = Pick<Task, 'agentId' | 'proposedByAgentPath' | 'proposedBySessionId'> & {
  originMarks?: ScheduleOriginMarks | null;
};

/**
 * Who made this task, read from its stored record and never from a run's input: the proposing
 * agent, its chat, and the marks kept on the task. `undefined` for a task no agent made.
 *
 * @param task - The task about to run, or `null`.
 */
export function taskCreatorOf(task: CreatedTask | null | undefined): RunCreator | undefined {
  const creator = task?.proposedByAgentPath;
  if (!task || !creator) return undefined;
  const stored = task.originMarks;
  const marks: TurnMarks = {
    ...(stored?.outsider ? { outsider: true as const } : {}),
    ...(stored?.teammate?.length
      ? { teammate: stored.teammate.map(({ roomId, authorId }) => ({ roomId, authorId })) }
      : {}),
  };
  return { agentPath: creator, sessionId: task.proposedBySessionId ?? null, marks };
}

/**
 * The run columns that record who made the task, for `TaskStore.recordRunExecution`: empty for a
 * task no agent made.
 *
 * @param task - The run's task, or `null`.
 */
export function runCreatorColumns(task: CreatedTask | null | undefined) {
  const creator = taskCreatorOf(task);
  return creator
    ? {
        creatorAgentPath: creator.agentPath,
        creatorSessionId: creator.sessionId,
        creatorMarks: JSON.stringify(creator.marks),
      }
    : {};
}

/**
 * Who made a run's task, as the run recorded it, or `null` for a run that recorded nobody.
 *
 * @param row - The run's row.
 */
export function recordedRunCreator(
  row:
    | {
        creatorAgentPath: string | null;
        creatorSessionId: string | null;
        creatorMarks: string | null;
      }
    | undefined
): RunCreator | null {
  if (!row?.creatorAgentPath) return null;
  return {
    agentPath: row.creatorAgentPath,
    sessionId: row.creatorSessionId,
    marks: parseStoredMarks(row.creatorMarks),
  };
}

/**
 * The creator whose marks a run of this task starts with: one that is ANOTHER agent than the one
 * the task runs as. `undefined` otherwise.
 *
 * @param task - The task about to run.
 * @param meshCore - Mesh, which names each registered home.
 */
export function runCreatorOf(task: CreatedTask, meshCore: MeshNames): RunCreator | undefined {
  const creator = taskCreatorOf(task);
  // Without Mesh nobody can say whose home the creator's is, and no agent's task exists anyway.
  if (!meshCore || !creator) return undefined;
  let another: boolean;
  try {
    another = isForAnotherAgent(task.agentId, creator.agentPath, meshCore);
  } catch (err) {
    // A run must still start; one whose creator cannot be told apart carries its marks.
    logger.warn("[tasks] could not tell who made this run's task", logError(err));
    another = true;
  }
  return another ? creator : undefined;
}

/**
 * Whether a run of this task must start with marks another agent carried when it made the task.
 * Such a run executes in this process rather than over the relay, whose task payload carries no
 * marks, so the marks always reach the turn.
 *
 * @param task - The task about to run.
 * @param meshCore - Mesh, which names each registered home.
 */
export function creatorMarked(task: CreatedTask, meshCore: MeshNames): boolean {
  return hasMarks(runCreatorOf(task, meshCore)?.marks ?? NO_MARKS);
}

/**
 * A run's send settings with the marks of the agent that made its task for it, the way a
 * `chat_send` hop carries the sender's: an outsider's as a carried mark, a teammate's chain as a
 * ceiling that lowers nothing (`ceilingCarrying`). Unchanged for a task its own agent made, or an
 * unmarked creator.
 *
 * @param task - The task about to run.
 * @param meshCore - Mesh, which names each registered home.
 * @param settings - The run's resolved settings.
 */
export function withCreatorMarks<T extends object>(
  task: CreatedTask,
  meshCore: MeshNames,
  settings: T
): T & Pick<MessageOpts, 'carriedMarks' | 'permissionCeiling'> {
  const marks = runCreatorOf(task, meshCore)?.marks ?? NO_MARKS;
  const ceiling = ceilingCarrying(marks);
  return {
    ...settings,
    ...(marks.outsider ? { carriedMarks: { outsider: true as const } } : {}),
    ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}),
  };
}
