/**
 * The smaller parts of the `tasks_*` tools, split from `task-tools.ts` so the
 * create and update handlers stay readable: who is calling, the two read-only
 * handlers, and the refusal of fields only a person may set.
 *
 * @module services/tasks/agent-tools/task-tool-parts
 */
import type {
  AgentToolDeps,
  TaskProvenanceResolver,
} from '../../core/agent-tool-kit/agent-tool-kit.js';
import { reachOf } from './task-tool-reach.js';
import {
  jsonContent,
  requireTasks,
  structuredJsonContent,
} from '../../core/agent-tool-kit/agent-tool-kit.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
} from '../task-write-policy.js';
import type { TurnMarks } from '../../core/turn-power/turn-marks.js';
import type {
  AgentIdentityResolution,
  AgentModeCaller,
} from '../agent-mode/agent-mode-decision.js';
import { identityResolutionOf } from '../agent-mode/agent-mode-identity.js';
import { agentModeControlOn } from '../agent-mode/agent-mode-actions.js';
import { liveRunOriginSources, withRunOrigin } from '../agent-mode/agent-mode-run-origin.js';
import type { TaskStore } from '../task-store.js';
import { agentIdOfHome } from '../approvals/schedule-owner.js';
import type { PermissionMode, Task, UpdateTaskRequest } from '@dorkos/shared/types';
import {
  accountMovePolicy,
  announceAccountMove,
  priorAccountOf,
  settleAccountUnpin,
} from '../approvals/account-move.js';

/**
 * The marks of the turn making a task call, for a surface that cannot name the calling session
 * (the external `/mcp` server, DOR-3036). The in-session server reads them from its session.
 */
export type CallerMarksResolver = () => TurnMarks;

/**
 * The verified home of the calling agent when the provenance names none: the
 * agent an external `/mcp` token names (DOR-3640 R1). Never read from the input.
 */
export type CallerAgentResolver = () => string | undefined;

/**
 * The calling agent's verified home, as the spread a create takes: the
 * in-session provenance's, else the external token's.
 *
 * @param provenance - The in-session caller, when there is one.
 * @param callerAgent - The external caller, when a token names one.
 */
export function callerAgentPathOf(
  provenance: ReturnType<TaskProvenanceResolver>,
  callerAgent: CallerAgentResolver | undefined
): { callerAgentPath?: string } {
  const callerAgentPath = provenance.agentPath ?? callerAgent?.();
  return callerAgentPath ? { callerAgentPath } : {};
}

/**
 * Whether the calling turn read words DorkOS cannot vouch for, from the turn's
 * own marks (`marksOf`, DOR-3036): its schedule writes then park for a person.
 *
 * @param provenance - The calling session and agent, as the server resolved them.
 */
export function readOutsiderWords(
  deps: Pick<AgentToolDeps, 'tasksReach'>,
  provenance: { sessionId?: string; agentPath?: string }
): boolean {
  const reach = reachOf(deps);
  return reach.marksHold(reach.marksOf(provenance.sessionId, provenance.agentPath));
}

/**
 * The caller of a `tasks_*` write, as the agent-mode decision reads it
 * (DOR-3703). Structural only on the in-session server, where the provenance
 * names the chat's own agent; the external server's caller is a token, a key
 * or nobody, and is never Allowed.
 *
 * @param resolveProvenance - The in-session caller, absent on the external server.
 * @param callerMarks - The external caller's turn marks.
 * @param callerAgent - The external caller's verified home.
 * @param store - The task store, to tell whether the chat is, or was started
 *   by, a scheduled run (M7).
 */
export function agentModeCallerOf(
  deps: Pick<AgentToolDeps, 'tasksReach'>,
  resolveProvenance: TaskProvenanceResolver | undefined,
  callerMarks: CallerMarksResolver | undefined,
  callerAgent: CallerAgentResolver | undefined,
  store?: Pick<TaskStore, 'resolveTaskOrigins'>
): AgentModeCaller {
  const provenance = resolveProvenance?.() ?? {};
  const { callerAgentPath } = callerAgentPathOf(provenance, callerAgent);
  const reach = reachOf(deps);
  const marks = callerMarks?.() ?? reach.marksOf(provenance.sessionId, provenance.agentPath);
  const inSession = resolveProvenance !== undefined && provenance.agentPath !== undefined;
  const resolved: AgentIdentityResolution = inSession
    ? identityResolutionOf(provenance.cwd ?? provenance.agentPath, provenance.agentPath)
    : callerAgentPath
      ? 'token'
      : 'unidentified';
  const caller: AgentModeCaller = {
    structural: inSession && resolved !== 'unidentified',
    resolved,
    ...(callerAgentPath ? { agentPath: callerAgentPath } : {}),
    ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
    ...(provenance.turnSessionIds?.length ? { turnSessionIds: provenance.turnSessionIds } : {}),
    marked: reach.marksHold(marks),
  };
  return store ? withRunOrigin(caller, liveRunOriginSources(store)) : caller;
}

/**
 * Refuse a task write that reaches for a field only a person may set, or return
 * `null` to let the call proceed. With `tasks.agentModeControl` on, only the
 * legacy mode and status fields go to the agent-mode decision. Applied allow
 * rules and the looser-grant confirmation remain person-only on every path.
 *
 * Unconditional, and that is the design rather than an omission. The wrong shape
 * here would be "refuse when the caller presented an agent identity", because
 * then omitting a header would be the bypass — the exact inversion
 * `approvals/decision-authority.ts` was rewritten to remove. An MCP tool call IS
 * the agent surface, so the proof is structural: there is no header involved and
 * nothing to strip. `operator-tool-handlers.ts` refuses operator-only config
 * paths the same way, for the same reason.
 *
 * The refusal is WHOLE. Nothing is written, including the fields the caller was
 * allowed to send, so a caller is never told a change landed when part of it did
 * not.
 *
 * @param args - The arguments the SDK parsed for this call.
 * @returns The refusal envelope, or `null` when the call may proceed.
 */
export function refuseOperatorOnlyTaskFields(args: unknown) {
  const operatorOnly = findOperatorOnlyTaskFields(args).filter(
    (field) => !agentModeControlOn() || (field !== 'permissionMode' && field !== 'status')
  );
  if (operatorOnly.length === 0) return null;
  return jsonContent(
    {
      error: OPERATOR_ONLY_TASK_ERROR,
      code: OPERATOR_ONLY_TASK_CODE,
      fields: operatorOnly,
      message: describeOperatorOnlyTaskRefusal(operatorOnly),
    },
    true
  );
}

/** List all Tasks scheduled jobs. */
export function createListSchedulesHandler(deps: AgentToolDeps) {
  return async (args: { enabled_only?: boolean }) => {
    const err = requireTasks(deps);
    if (err) return err;
    let schedules = deps.taskStore!.getTasks();
    const history = deps.taskStore!.runHistory();
    schedules = schedules.map((schedule) => ({
      ...schedule,
      lastRunAt: history(schedule.id).lastRunAt,
    }));
    if (args.enabled_only) {
      schedules = schedules.filter((s) => s.enabled);
    }
    // The row never stores `nextRun`; the scheduler is what knows it, as it is
    // for `GET /api/tasks` (DOR-3125). An ISO instant in UTC, which an agent
    // reads beside the task's own `timezone`.
    const next = deps.nextRunOf;
    if (next)
      schedules = schedules.map((s) => ({ ...s, nextRun: next(s.id)?.toISOString() ?? null }));
    return structuredJsonContent({ schedules, count: schedules.length });
  };
}

/** The refusal for another agent's run history, read from a chat below Full (DOR-4600). */
export const NOT_YOUR_SCHEDULE_RUNS_MESSAGE =
  "That scheduled task belongs to another agent, so its runs aren't yours to read. Only that " +
  'agent, a person, or a chat at Full autonomy can read them.';

/** The refusal for an agent's run history when DorkOS can't tell which agent is asking. */
export const UNIDENTIFIED_RUNS_MESSAGE =
  "DorkOS can't tell which agent is asking, so it can't show an agent's scheduled task runs.";

/** The Mesh id of the calling agent, or `undefined` when DorkOS cannot name one. */
function callerIdOf(deps: AgentToolDeps, agentPath: string | undefined): string | undefined {
  return agentPath ? agentIdOfHome(deps.meshCore ?? undefined, agentPath) : undefined;
}

/** What run history says in place of the summaries it left out. */
export const RUN_SUMMARIES_LEFT_OUT =
  'Each run’s summary is left out: it is that run’s own words and can quote what it read. ' +
  '`refusedTools` still says what each run was refused.';

/**
 * Get recent runs for a schedule.
 *
 * Where the status reads run unasked (Never ask, Ask first, Accept edits: DOR-3971, DOR-4601),
 * each run's `outputSummary` is left out (Security): it is the first 500 characters of what that
 * run wrote, so it can carry words the run read from anyone. A run's status, timing and
 * `refusedTools` stay, which is what an unattended watchdog reads.
 *
 * In a chat, it answers only for the calling agent's own schedules and global ones, as its
 * edits do (DOR-4600, Security): another agent's runs come back as a refusal unless
 * `readsOthers` says the turn may (Full autonomy, unmarked). A global schedule's runs stay
 * readable whoever proposed it (the ticket's rule; editing one is narrower). The sessionless
 * external server keeps its answer.
 *
 * @param deps - The tool dependencies.
 * @param resolveProvenance - The calling chat, read at call time; absent off a session.
 * @param readsOthers - Whether the calling turn may read another agent's schedule.
 */
export function createGetRunHistoryHandler(
  deps: AgentToolDeps,
  resolveProvenance?: TaskProvenanceResolver,
  readsOthers: () => boolean = () => false
) {
  return async (args: { schedule_id: string; limit?: number }) => {
    const err = requireTasks(deps);
    if (err) return err;
    if (resolveProvenance && !readsOthers()) {
      const task = deps.taskStore!.getTask(args.schedule_id);
      const { agentPath } = resolveProvenance();
      if (task?.agentId && task.agentId !== callerIdOf(deps, agentPath)) {
        const error = agentPath ? NOT_YOUR_SCHEDULE_RUNS_MESSAGE : UNIDENTIFIED_RUNS_MESSAGE;
        return jsonContent({ error, code: 'not_your_schedule' }, true);
      }
    }
    const runs = deps.taskStore!.listRuns({
      taskId: args.schedule_id,
      limit: args.limit ?? 20,
    });
    if (resolveProvenance?.().narrowedReads !== true)
      return jsonContent({ runs, count: runs.length });
    const withoutSummaries = runs.map(({ outputSummary: _left, ...run }) => run);
    return jsonContent({
      runs: withoutSummaries,
      count: runs.length,
      note: RUN_SUMMARIES_LEFT_OUT,
    });
  };
}

/**
 * What `tasks_create` answers when it is sent `agentId`, which is not a create
 * field: `target` is. A silent strip is what sent an agent looking for another
 * way to own its own task.
 */
export const AGENT_ID_ON_CREATE_REFUSAL = {
  error: 'DorkOS changed nothing — `agentId` is not a field on a scheduled task write.',
  code: 'unknown_task_field',
  fields: ['agentId'],
  message:
    'Say which agent a scheduled task belongs to with `target` instead: your own agent id ' +
    'to file it under yourself, or "global" for a scheduled task that belongs to no agent.',
} as const;

/**
 * Record that an agent switched a schedule back on, where the person will see
 * it: the one trace that an agent, not its owner, turned it back on. Named by
 * the agent's project path when the session has one, "An agent" otherwise.
 *
 * @param deps - The tool dependencies.
 * @param agentPath - The calling agent's project path, when known.
 * @param updated - The schedule after the edit.
 */
export function emitAgentSwitchedOn(
  deps: AgentToolDeps,
  agentPath: string | undefined,
  updated: Task
): void {
  deps.activityService?.emit({
    actorType: 'agent',
    actorLabel: 'An agent',
    ...(agentPath ? { actorId: agentPath } : {}),
    category: 'tasks',
    eventType: 'tasks.task_resumed',
    resourceType: 'schedule',
    resourceId: updated.id,
    resourceLabel: updated.displayName ?? updated.name,
    summary: `Switched on scheduled task ${updated.displayName ?? updated.name}`,
    linkPath: '/',
  });
}

/** What {@link settleTaskAccountEdit} did. */
export interface TaskAccountEditOutcome {
  /** A kept account move stands, and the person was told. */
  moved: boolean;
  /** The task waits for a person now, over its account. */
  parked: boolean;
}

/**
 * After an agent's `tasks_update` (DOR-5097): tell the person when it moved an
 * approved, still running task to another account (with an Undo); a notice
 * that could not be posted parks it instead. An unpin ("This account only"
 * off) is told, or parks the task on Careful.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param before - The task before the edit.
 * @param caller - The calling agent, by its home when DorkOS knows it.
 * @param moved - Whether the edit was settled as a kept account move.
 */
export async function settleTaskAccountEdit(
  deps: AgentToolDeps,
  before: Task,
  caller: { agentPath?: string | null },
  moved: boolean
): Promise<TaskAccountEditOutcome> {
  const store = deps.taskStore!;
  const after = store.getTask(before.id);
  if (!after) return { moved: false, parked: false };
  const edit = { before, after, agentPath: caller.agentPath ?? null };
  const stands = moved && after.status === 'active' && (await announceAccountMove(store, edit));
  const unpin = await settleAccountUnpin(store, edit);
  return { moved: stands, parked: (moved && !stands) || unpin === 'parked' };
}

/**
 * The account-move rule for a `tasks_update` call: kept only for one of our
 * agents DorkOS identified, from an unmarked turn, off the Careful preset, and
 * never off credits, the task's own or the one it followed (`accountMovePolicy`).
 *
 * @param deps - Shared MCP tool dependencies, for the agent's home.
 * @param task - The task before the edit.
 * @param caller - The calling agent and whether its turn is marked.
 */
export async function accountMovePolicyFor(
  deps: AgentToolDeps,
  task: Task,
  caller: Pick<AgentModeCaller, 'agentPath' | 'marked'>
): Promise<ReturnType<typeof accountMovePolicy>> {
  const home = task.agentId ? deps.meshCore?.getProjectPath(task.agentId) : undefined;
  return accountMovePolicy(
    caller.agentPath !== undefined && !caller.marked,
    await priorAccountOf(task, home)
  );
}

/** The agent-writable fields a `tasks_update` call may carry into the store. */
type ToolUpdateFields = Pick<
  UpdateTaskRequest,
  | 'name'
  | 'prompt'
  | 'enabled'
  | 'sticky'
  | 'readsOutsideText'
  | 'runtime'
  | 'model'
  | 'effort'
  | 'account'
  | 'accountPinned'
  | 'requestedPermissionMode'
  | 'requestedAllow'
  | 'resetTiming'
> & { cron?: string; timezone?: string; maxRuntime?: string };

/**
 * The patch a `tasks_update` call writes, assembled field by field rather than
 * spread from the call, so nothing here could carry `permissionMode` to the
 * store except the mode an approval decided (S-C).
 *
 * @param args - The call's fields.
 * @param permissionMode - The mode a mode-only decision set, if any.
 */
export function toolUpdatePatch(
  args: ToolUpdateFields,
  permissionMode: PermissionMode | undefined
): UpdateTaskRequest {
  return {
    ...(args.name !== undefined && { name: args.name }),
    ...(args.prompt !== undefined && { prompt: args.prompt }),
    ...(args.cron !== undefined && { cron: args.cron }),
    ...(args.enabled !== undefined && { enabled: args.enabled }),
    ...(args.timezone !== undefined && { timezone: args.timezone }),
    ...(args.maxRuntime !== undefined && { maxRuntime: args.maxRuntime }),
    ...(args.sticky !== undefined && { sticky: args.sticky }),
    // Only `true` gets here: the policy refused anything else first (DOR-3969).
    ...(args.readsOutsideText === true && { readsOutsideText: true }),
    ...(args.runtime !== undefined && { runtime: args.runtime }),
    ...(args.model !== undefined && { model: args.model }),
    ...(args.effort !== undefined && { effort: args.effort }),
    ...(args.account !== undefined && { account: args.account }),
    ...(args.accountPinned !== undefined && { accountPinned: args.accountPinned }),
    ...(args.requestedPermissionMode !== undefined && {
      requestedPermissionMode: args.requestedPermissionMode,
    }),
    ...(args.requestedAllow !== undefined && { requestedAllow: args.requestedAllow }),
    ...(args.resetTiming === true && { resetTiming: true as const }),
    ...(permissionMode !== undefined && { permissionMode }),
  };
}
