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
 * `null` to let the call proceed. With `tasks.agentModeControl` on it always
 * answers `null`: the two fields go to the agent-mode decision instead.
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
  if (agentModeControlOn()) return null;
  const operatorOnly = findOperatorOnlyTaskFields(args);
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

/** Get recent runs for a schedule. */
export function createGetRunHistoryHandler(deps: McpToolDeps) {
  return async (args: { schedule_id: string; limit?: number }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const runs = deps.taskStore!.listRuns({
      taskId: args.schedule_id,
      limit: args.limit ?? 20,
    });
    return jsonContent({ runs, count: runs.length });
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
