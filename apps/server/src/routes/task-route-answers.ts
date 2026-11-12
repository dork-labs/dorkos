/**
 * Small scheduled-task route answers: the activity feed’s permission label,
 * the caller editing a schedule, and whether a request names credits.
 *
 * @module routes/task-route-answers
 */
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { MeshCore } from '@dorkos/mesh';
import type { Task, UpdateTaskRequest } from '@dorkos/shared/types';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { RequestFacts } from '../http/request-facts.js';
import type { ScheduleEditor } from '../services/tasks/approvals/schedule-owner.js';
import { capabilitiesForTaskRuntime } from '../services/tasks/scheduled-run-power.js';
import { readAgentExecutionDefaults } from '../services/session/resolution/resolve-session-defaults.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
} from '../services/tasks/task-write-policy.js';

/**
 * What the activity feed says a schedule runs at, when nobody can be told the
 * runtime's own word for it.
 *
 * Deliberately not the mode id. An id is the runtime's internal spelling —
 * `bypassPermissions`, `danger-full-access`, `workspace-write` — and a feed a
 * person reads months later to answer "who gave this thing that much power?"
 * is the last place to print one.
 */
const UNNAMED_PERMISSION_LEVEL = 'the level saved on it';

/**
 * The human name of the level a schedule runs at, in the vocabulary of the
 * runtime that will run it (DOR-2100).
 *
 * The runtime is resolved on the SAME ladder the create path walks
 * (`resolveCreateRuntime`) and the fire path repeats
 * (`resolve-run-execution.ts`): what the task names, then its AGENT's manifest,
 * then the registry default. The agent rung costs one manifest read, once per
 * approval click, and it is the rung that matters — a task filed under a
 * Codex-pinned agent is the COMMON shape of an agent-proposed schedule, and
 * labelling it through Claude Code's vocabulary would print one runtime's word
 * for a level another runtime is actually running at.
 *
 * **Where a rung that answers nothing lands, and why that is right.** No agent
 * on the task, no mesh to place one, no manifest in the agent's folder, a
 * manifest the reader cannot use, or one naming a runtime this build has no
 * adapter for all fall through to the DEFAULT runtime — and the label is then
 * the default runtime's word, not a shrug. That is not a degradation, it is the same answer the RUN gets:
 * `resolveRuntimeType` falls through to `getDefaultType()` on every one of
 * those, so the run really does execute in the ids being named. The last of
 * the five is why this asks `capabilitiesForTaskRuntime` about the agent's
 * runtime before taking it: the fire path guards the agent rung with
 * `runtimes.has(...)`, and a label that skipped that guard would answer "no
 * idea" about a run heading for a perfectly well-named default.
 *
 * {@link UNNAMED_PERMISSION_LEVEL} is therefore narrow. It is reached when the
 * TASK itself names a runtime this server does not hold — where the fire path
 * refuses the run rather than substituting one, so there is genuinely no
 * vocabulary to name the level in — or when the resolved runtime declares no
 * mode by that id. The id is on the event's `metadata` in every case, so
 * nothing is lost for a machine reader.
 *
 * @param task - The schedule as it now stands.
 * @param meshCore - Resolves the task's agent to its project path; absent when
 *   Mesh is disabled, which is one of the five ways the agent rung answers
 *   nothing and the default runtime's vocabulary is used instead.
 * @returns The runtime's label for its mode, or the neutral phrase.
 */
export async function describeTaskPermissionLevel(
  task: Task,
  meshCore?: MeshCore
): Promise<string> {
  const declared = await taskPermissionModes(task, meshCore);
  return (
    declared.find((mode) => mode.id === task.permissionMode)?.label ?? UNNAMED_PERMISSION_LEVEL
  );
}

/** Modes declared by the runtime that will actually execute this task. */
async function taskPermissionModes(
  task: Pick<Task, 'runtime' | 'agentId'>,
  meshCore?: MeshCore
): Promise<readonly PermissionModeDescriptor[]> {
  const agentPath = task.agentId ? meshCore?.getProjectPath(task.agentId) : undefined;
  const agentRuntime = agentPath
    ? ((await readAgentExecutionDefaults(agentPath)).runtime ?? null)
    : null;
  // The agent's runtime only when this build can actually run it — the same
  // `has(...)` guard `resolveRuntimeType` applies, asked through the function
  // that already answers it. Without this the label and the run disagree for
  // an agent pinned to a runtime with no adapter here.
  const runtime =
    task.runtime ??
    (agentRuntime && capabilitiesForTaskRuntime(agentRuntime) ? agentRuntime : null);
  return capabilitiesForTaskRuntime(runtime)?.permissionModes?.values ?? [];
}

/** Refuse an approval or execution change before either the file or row is written. */
export async function taskModeRefusal(task: Task, change: UpdateTaskRequest, mesh?: MeshCore) {
  if (
    change.permissionMode === undefined &&
    change.runtime === undefined &&
    change.status !== 'active'
  )
    return null;
  const candidate = { ...task, ...change };
  const modes = await taskPermissionModes(candidate, mesh);
  return modes.some((mode) => mode.id === candidate.permissionMode)
    ? null
    : {
        error: 'Choose a permission mode this task can run.',
        code: 'unsupported_task_mode',
      };
}

/**
 * Who is changing a schedule over HTTP: the person (a caller that cleared the
 * agent bar), an agent whose token verified and is live, or anyone else.
 *
 * @param facts - The request's facts.
 * @param trusted - Whether the caller cleared the agent bar.
 */
export function scheduleEditorOf(facts: RequestFacts, trusted: boolean): ScheduleEditor {
  if (trusted) return { kind: 'person' };
  const identity = facts.agentIdentity;
  return identity && !identity.inactive
    ? { kind: 'agent', agentPath: identity.agentPath }
    : { kind: 'unidentified' };
}

/** Whether a task write body names DorkOS credits as its account. */
export function namesCredits(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { account?: unknown }).account === CREDITS_ACCOUNT_ID
  );
}

/**
 * Refuse a task write that reaches for a field only a person may set (DOR-504):
 * the 403 body to answer with, or `null` when the write may go on.
 *
 * ## Why this route needs a caller check when the MCP twin does not
 *
 * `tasks_create` and `tasks_update` refuse `permissionMode` and `status`
 * unconditionally, because an MCP tool call is by construction the agent surface.
 * This route is not: the app's Approve button writes `status: 'active'`
 * through it (`TaskRow.tsx`), and its task form writes `permissionMode`. So the
 * policy is skipped for a caller that clears {@link clearsTheAgentBar} — a person
 * positively established, with no agent identity and no approval token — and
 * applied to everyone else. That is exactly the shape `PATCH /api/config` uses for
 * operator-only settings. Under login-on that trust now requires a session cookie
 * (DOR-1569), so a per-user API key is refused here just as a named agent is.
 * Under the default `local-trust` posture, though, a caller with a shell can omit
 * every header and be indistinguishable from the app, so this stops an agent
 * that follows the protocol, not an adversary already running as you — the
 * documented DOR-505 residual, closed only by turning login on.
 *
 * ## Read the RAW body, and refuse it whole
 *
 * The check runs before the schema parse for two reasons. It has to see what the
 * CALLER sent rather than what the route resolved: an omitted `permissionMode`
 * is filled in from the operator's own trust stop a few lines later
 * (`resolveScheduledRunPermissionMode`), and a guard reading the resolved value
 * could not tell a caller that named a level from one that did not. That was
 * true of the Zod default this replaced and it is true of the ladder — the guard
 * did not change, only the thing it must not be moved after. And refusing before
 * anything is parsed or written is what makes the refusal whole: a caller is
 * never told a change landed when only part of it did.
 *
 * @param body - The raw request body, as the caller sent it.
 * @param trusted - Whether the caller cleared {@link clearsTheAgentBar}. Passed in
 *   rather than resolved here because `POST /` needs the same answer a second
 *   time — it decides whether the new task parks at `pending_approval`
 *   (`createScheduledTask`) — and asking twice would let the two uses disagree.
 * @returns The refusal, answered with 403 by the route, or `null`.
 */
export function operatorOnlyTaskRefusal(body: unknown, trusted: boolean) {
  if (trusted) return null;
  const operatorOnly = findOperatorOnlyTaskFields(body);
  if (operatorOnly.length === 0) return null;
  return {
    error: OPERATOR_ONLY_TASK_ERROR,
    code: OPERATOR_ONLY_TASK_CODE,
    fields: operatorOnly,
    message: describeOperatorOnlyTaskRefusal(operatorOnly),
  };
}
