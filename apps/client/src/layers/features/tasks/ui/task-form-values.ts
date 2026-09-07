/**
 * What a task form holds, and where its opening values come from.
 *
 * The shape and the three ways of filling it — an edit, a preset, a blank —
 * are the form's model, not its markup: `CreateTaskDialog` builds values here
 * and `ScheduleForm` only renders them. Keeping them beside the component put
 * a hundred lines of defaults in front of every reader of the form itself, and
 * pushed `TaskFormInner.tsx` past the file-length ceiling once two batches had
 * each grown it a little (DOR-1815).
 *
 * @module features/tasks/ui/task-form-values
 */
import type { TaskTemplate } from '@/layers/entities/tasks';
import type { PermissionMode, Task } from '@dorkos/shared/types';

/** Which half of the create dialog is on screen. */
export type DialogStep = 'preset-picker' | 'form';

/** How long a run may take before it is cut off, when nobody says otherwise. */
export const DEFAULT_MAX_RUNTIME = '10m';

/** All fields managed by TanStack Form. */
export type ScheduleFormValues = {
  name: string;
  description: string;
  prompt: string;
  cron: string;
  /** Empty string means "no agent selected" — sentinel avoids string | undefined type mismatch. */
  agentId: string;
  timezone: string;
  permissionMode: PermissionMode;
  maxRuntime: string;
  /** Whether every run resumes one session instead of starting fresh (DOR-1571). */
  sticky: boolean;
  /**
   * Which runtime this task's runs execute on. Empty string means "no override"
   * — the run follows its agent, then the server default (DOR-1615).
   *
   * The same empty-string sentinel `agentId` uses above, and for the same
   * reason: a form value that is sometimes `undefined` fights the field types
   * all the way down. It becomes `null` on the wire, which is how an update
   * clears a value.
   */
  runtime: string;
  /** The model this task's runs execute on; empty means "agent default" (DOR-1347). */
  model: string;
  /** How hard the model thinks; empty means "agent default". */
  effort: string;
};

/** Convert milliseconds to a human-friendly duration string (e.g. "10m"). */
function msToRuntimeStr(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${minutes}m`;
}

/**
 * Build form default values from an edit task, a preset, or blank defaults.
 *
 * A task's stored `permissionMode` is carried through exactly as it is, even
 * when it is a mode the dial has no stop for. Coercing it to `acceptEdits` on
 * load — which this did — meant that opening a `plan`-mode task to fix a typo in
 * its prompt and pressing Save widened what that task may do, without the person
 * touching the setting or being told. Widening is a choice somebody has to make
 * on purpose.
 *
 * A NEW task (preset or blank) starts at the operator's own configured stop
 * rather than a hardcoded `acceptEdits` (spec `full-power-defaults`, D6), so a
 * person who set their default to Full autonomy is not asked to re-choose it on
 * every schedule. The caller resolves that mode from config; `defaultMode` falls
 * back to `'acceptEdits'` for anyone who never set a stop — byte-for-byte the old
 * behaviour. The edit branch never reads it: an existing task keeps its own mode.
 *
 * @param editTask - The task being edited, if any.
 * @param preset - The template a new task starts from, if any.
 * @param initialAgentId - The agent to pre-select for a new task.
 * @param defaultMode - The mode a new task opens at; the operator's configured
 *   stop mapped to the runtime, or `'acceptEdits'` when none is configured.
 */
export function buildFormValues(
  editTask?: Task,
  preset?: TaskTemplate | null,
  initialAgentId?: string,
  defaultMode: PermissionMode = 'acceptEdits'
): ScheduleFormValues {
  if (editTask) {
    return {
      name: editTask.name,
      description: editTask.description ?? '',
      prompt: editTask.prompt,
      cron: editTask.cron ?? '',
      agentId: editTask.agentId ?? '',
      timezone: editTask.timezone ?? '',
      permissionMode: editTask.permissionMode,
      maxRuntime: editTask.maxRuntime ? msToRuntimeStr(editTask.maxRuntime) : DEFAULT_MAX_RUNTIME,
      sticky: editTask.sticky,
      runtime: editTask.runtime ?? '',
      model: editTask.model ?? '',
      effort: editTask.effort ?? '',
    };
  }
  if (preset) {
    return {
      name: preset.name,
      description: preset.description,
      prompt: preset.prompt,
      cron: preset.cron,
      agentId: initialAgentId ?? '',
      timezone: preset.timezone ?? '',
      permissionMode: defaultMode,
      maxRuntime: DEFAULT_MAX_RUNTIME,
      sticky: false,
      // A template says what a task DOES, never where it runs: a preset
      // carrying a runtime would put one machine's answer on everybody's
      // schedule (spec `task-runtime-model` §2, decision 12 — marketplace
      // shape declarations do not carry these either).
      runtime: '',
      model: '',
      effort: '',
    };
  }
  return {
    name: '',
    description: '',
    prompt: '',
    cron: '',
    agentId: initialAgentId ?? '',
    timezone: '',
    permissionMode: defaultMode,
    maxRuntime: DEFAULT_MAX_RUNTIME,
    sticky: false,
    runtime: '',
    model: '',
    effort: '',
  };
}
