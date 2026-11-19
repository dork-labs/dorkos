/**
 * The smaller parts of the `tasks_*` tools, split from `task-tools.ts` so the
 * create and update handlers stay readable: who is calling, the two read-only
 * handlers, and the refusal of fields only a person may set.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-tool-parts
 */
import type { McpToolDeps } from '../types.js';
import { jsonContent, requireTasks, structuredJsonContent } from '../types.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
} from '../../../../tasks/task-write-policy.js';
import { marksOf } from '../../../../core/turn-power/turn-levels.js';
import { marksHold, type TurnMarks } from '../../../../core/turn-power/turn-marks.js';
import type {
  AgentIdentityResolution,
  AgentModeCaller,
} from '../../../../tasks/agent-mode/agent-mode-decision.js';
import { identityResolutionOf } from '../../../../tasks/agent-mode/agent-mode-identity.js';
import { agentModeControlOn } from '../../../../tasks/agent-mode/agent-mode-actions.js';
import {
  liveRunOriginSources,
  withRunOrigin,
} from '../../../../tasks/agent-mode/agent-mode-run-origin.js';
import type { TaskStore } from '../../../../tasks/task-store.js';
import { agentIdOfHome } from '../../../../tasks/approvals/schedule-owner.js';
import type { Task } from '@dorkos/shared/types';

/**
 * Who is proposing a schedule, read at CALL time rather than at registration.
 *
 * Both fields are resolved lazily and for the same reason: the SDK rekeys a
 * session to its canonical id mid-first-turn, so an id captured when the tool
 * server was built names a session that no longer exists. The DevTools tools
 * resolve their session id late for exactly this reason — see
 * `mcp-tools/index.ts`.
 *
 * Absent entirely on the sessionless external `/mcp` server, where there is no
 * session to attribute a proposal to and provenance stays null.
 */
export type TaskProvenanceResolver = () => {
  /** The invoking session's canonical id. */
  sessionId?: string;
  /**
   * The invoking session's working directory, which is the key agent identity
   * is stored under (`agent-identity/agent-token-env.ts`) — so this is what
   * later resolves the proposer's name.
   */
  agentPath?: string;
  /** The folder the chat really runs in: its home, or a worktree mapped to it (DOR-3703). */
  cwd?: string;
  /** Every id the chat's turn levels may be kept under: its canonical one and its first. */
  turnSessionIds?: string[];
  /** The chat reads narrowed now: its turn runs where the status reads run unasked (DOR-4601). */
  narrowedReads?: boolean;
};

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
export function readOutsiderWords(provenance: { sessionId?: string; agentPath?: string }): boolean {
  return marksHold(marksOf(provenance.sessionId, provenance.agentPath));
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
  resolveProvenance: TaskProvenanceResolver | undefined,
  callerMarks: CallerMarksResolver | undefined,
  callerAgent: CallerAgentResolver | undefined,
  store?: Pick<TaskStore, 'resolveTaskOrigins'>
): AgentModeCaller {
  const provenance = resolveProvenance?.() ?? {};
  const { callerAgentPath } = callerAgentPathOf(provenance, callerAgent);
  const marks = callerMarks?.() ?? marksOf(provenance.sessionId, provenance.agentPath);
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
    marked: marksHold(marks),
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
export function createListSchedulesHandler(deps: McpToolDeps) {
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
function callerIdOf(deps: McpToolDeps, agentPath: string | undefined): string | undefined {
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
  deps: McpToolDeps,
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
  deps: McpToolDeps,
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
