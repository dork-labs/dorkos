/**
 * A scheduled task one agent makes or changes for ANOTHER agent (DOR-3938). Below Full autonomy
 * an agent schedules only for itself or `global` (DOR-3640 R1, `schedule-owner.ts`). A turn that
 * really runs at Full may schedule for any registered agent, on Security's five conditions:
 *
 * 1. Full is read from the server: the level this process recorded for the calling turn, its
 *    ceiling applied (`turn-levels.ts`), never the agent's stored setting or the tool's input.
 * 2. A turn with the outsider mark is refused, however it got the mark (a teammate's hop that
 *    carried one too). A teammate's mark alone does not refuse (PM, Nov 7 19:42 CT).
 * 3. The task keeps the last other agent that made or changed it, that turn, and its marks
 *    (`pulse_schedules.cross_agent_writer`); each run records them and starts with those marks,
 *    as a `chat_send` hop does.
 * 4. Its mode is capped at the target agent's own level, Bypass included, at create and at every
 *    later edit by another agent.
 * 5. Pinned by `runtimes/claude-code/mcp-tools/__tests__/task-tools-cross-agent*.test.ts` and
 *    `tasks/__tests__/cross-agent-run-marks.test.ts`.
 *
 * @module services/tasks/approvals/cross-agent
 */
import type { MeshCore } from '@dorkos/mesh';
import type { MessageOpts, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
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
  marksHold,
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

/** The refusal for a Full turn that carries the outsider mark. */
export const CROSS_AGENT_MARKED_MESSAGE =
  'This chat read messages from outside your team, so in this turn it cannot schedule or ' +
  'change a task for another agent. A person can, or you can schedule it for yourself.';

/**
 * Whether the calling turn may schedule for, or change a task of, another agent: it runs at Full
 * autonomy right now and carries no outsider mark. Fails closed: no chat, or a chat this process ran no
 * turn on, is not Full.
 *
 * @param caller - The calling turn, as the server resolved it.
 * @returns `null` when it may, else the refusal.
 */
export function crossAgentRefusal(caller: CrossAgentCaller): CrossAgentRefusal | null {
  const levels = turnIdsOf(caller).map(lastTurnLevelOf);
  const known = levels.filter((level) => level !== undefined);
  if (known.length === 0 || !known.every(isFullLevel)) {
    return { error: CROSS_AGENT_NEEDS_FULL_MESSAGE, code: 'cross_agent_needs_full' };
  }
  if (marksHold(turnMarksOf(caller))) {
    return { error: CROSS_AGENT_MARKED_MESSAGE, code: 'cross_agent_marked_turn' };
  }
  return null;
}

/**
 * The marks of the calling turn, merged over every id its level is kept under and its agent's
 * running marks: what {@link crossAgentRefusal} checks, and what a cross-agent write keeps.
 *
 * @param caller - The calling turn, as the server resolved it.
 */
export function turnMarksOf(caller: CrossAgentCaller): TurnMarks {
  return turnIdsOf(caller)
    .map((id) => marksOfLevel(lastTurnLevelOf(id)))
    .reduce(mergeMarks, marksOf(caller.sessionId, caller.agentPath));
}

/** Every id a calling turn's level may be kept under. */
function turnIdsOf(caller: CrossAgentCaller): string[] {
  return [...new Set([caller.sessionId, ...(caller.turnSessionIds ?? [])])].filter(
    (id): id is string => typeof id === 'string' && id !== ''
  );
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

/** The other agent that last made or changed a task, as its runs record it (Must 3). */
export interface CrossAgentWriter {
  /** That agent's home. */
  agentPath: string;
  /** The chat it wrote from, when known. */
  sessionId: string | null;
  /** The marks that chat's turn carried. */
  marks: TurnMarks;
}

/**
 * Keep the agent that just made or changed a task for another agent on the task, with its turn's
 * marks, so the next run starts with them. The marks are MERGED with every earlier writer's (a
 * union, Security's ruling): if A made B's task and C edits it, its runs carry A's and C's marks.
 * The agent and chat named are the latest writer's. A person's approval does not clear it.
 *
 * @param db - The database the store writes.
 * @param id - The task.
 * @param writer - Who wrote it, read by the server.
 */
export function recordCrossAgentWriter(db: Db, id: string, writer: CrossAgentWriter): void {
  const marks = mergeMarks(crossAgentWriterOf(db, id)?.marks ?? NO_MARKS, writer.marks);
  db.update(pulseSchedules)
    .set({ crossAgentWriter: JSON.stringify({ ...writer, marks: marksOnly(marks) }) })
    .where(eq(pulseSchedules.id, id))
    .run();
}

/**
 * The other agent that last wrote a task, or `undefined` when only its own agent or a person did.
 *
 * @param db - The database the store writes.
 * @param id - The task, or nothing.
 */
export function crossAgentWriterOf(
  db: Db,
  id: string | null | undefined
): CrossAgentWriter | undefined {
  if (!id) return undefined;
  const row = db
    .select({ writer: pulseSchedules.crossAgentWriter })
    .from(pulseSchedules)
    .where(eq(pulseSchedules.id, id))
    .get();
  if (!row?.writer) return undefined;
  try {
    const value = JSON.parse(row.writer) as {
      agentPath?: unknown;
      sessionId?: unknown;
      marks?: unknown;
    };
    if (typeof value.agentPath !== 'string') return undefined;
    return {
      agentPath: value.agentPath,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
      marks: parseStoredMarks(JSON.stringify(value.marks ?? {})),
    };
  } catch {
    // Unreadable: carry an outsider's mark rather than none (fails closed).
    return { agentPath: 'unknown', sessionId: null, marks: { outsider: true } };
  }
}

/** Only the mark fields of a set of marks, for storage. */
function marksOnly(marks: TurnMarks): TurnMarks {
  return {
    ...(marks.outsider ? { outsider: true as const } : {}),
    ...(marks.teammate !== undefined ? { teammate: marks.teammate } : {}),
  };
}

/** The parts of a task a run's creator is read from. */
type CreatedTask = Pick<Task, 'id' | 'proposedByAgentPath' | 'proposedBySessionId'>;

/**
 * The run columns that record who made the task: the other agent that last wrote it, else the
 * agent that proposed it (with no marks carried). Empty for a task no agent made.
 *
 * @param task - The run's task, or `null`.
 * @param store - The task store, where its cross-agent writer is kept.
 */
export function runCreatorColumns(task: CreatedTask | null | undefined, store: WriterSource) {
  const writer = task ? store.approvals.crossAgentWriterOf(task.id) : undefined;
  const agentPath = writer?.agentPath ?? task?.proposedByAgentPath;
  if (!agentPath) return {};
  return {
    creatorAgentPath: agentPath,
    creatorSessionId: writer ? writer.sessionId : (task?.proposedBySessionId ?? null),
    creatorMarks: JSON.stringify(writer?.marks ?? NO_MARKS),
  };
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
): CrossAgentWriter | null {
  if (!row?.creatorAgentPath) return null;
  return {
    agentPath: row.creatorAgentPath,
    sessionId: row.creatorSessionId,
    marks: parseStoredMarks(row.creatorMarks),
  };
}

/** What the run helpers read a task's cross-agent writer from: the task store. */
type WriterSource = { approvals: { crossAgentWriterOf(id: string): CrossAgentWriter | undefined } };

/**
 * Whether a run of this task must start with marks another agent's write carried. Such a run
 * executes in this process rather than over the relay, whose task payload carries no marks, so the
 * marks always reach the turn.
 *
 * @param store - The task store.
 * @param task - The task about to run.
 */
export function creatorMarked(store: WriterSource, task: Pick<Task, 'id'>): boolean {
  return hasMarks(store.approvals.crossAgentWriterOf(task.id)?.marks ?? NO_MARKS);
}

/**
 * A run's send settings with the marks of the other agent that last wrote its task, the way a
 * `chat_send` hop carries the sender's: an outsider's as a carried mark, a teammate's chain as a
 * ceiling that lowers nothing (`ceilingCarrying`). Unchanged for a task no other agent wrote.
 *
 * @param store - The task store.
 * @param task - The task about to run.
 * @param settings - The run's resolved settings.
 */
export function withCreatorMarks<T extends object>(
  store: WriterSource,
  task: Pick<Task, 'id'>,
  settings: T
): T & Pick<MessageOpts, 'carriedMarks' | 'permissionCeiling'> {
  const marks = store.approvals.crossAgentWriterOf(task.id)?.marks ?? NO_MARKS;
  const ceiling = ceilingCarrying(marks);
  return {
    ...settings,
    ...(marks.outsider ? { carriedMarks: { outsider: true as const } } : {}),
    ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}),
  };
}
