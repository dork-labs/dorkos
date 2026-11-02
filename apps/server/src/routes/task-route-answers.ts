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
export async function taskPermissionModes(
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
