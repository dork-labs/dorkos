import { ChevronRight, Trash2 } from 'lucide-react';
import { useCreateTask, useUpdateTask } from '@/layers/entities/tasks';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { ResponsiveDialogFooter, Label, Button, PermissionModeScopeNote } from '@/layers/shared/ui';
import { useAppForm } from '@/layers/shared/lib/form';
import { permissionModeLabel } from '@/layers/shared/lib';
import type { PermissionMode, Task } from '@dorkos/shared/types';
import { ScheduleBuilder } from './TaskBuilder';
import { TimezoneCombobox } from './TimezoneCombobox';
import { AgentPicker } from './AgentPicker';

export type DialogStep = 'preset-picker' | 'form';

/**
 * The two modes this form lets a person choose between. A task can hold any of
 * the six (a SKILL.md on disk names them all, and so does the session picker),
 * and one that arrived on a different mode is shown as it is rather than
 * squeezed into one of these — see {@link buildFormValues}.
 */
const OFFERED_MODES: readonly PermissionMode[] = ['acceptEdits', 'bypassPermissions'];

/**
 * What the modes this form does NOT offer let a task do, in the same plain
 * words as the two it does ("Allow file edits", "Full autonomy") — a task's
 * mode sits next to those two, so an id like "Bypass All" reads as a different
 * kind of thing and tells a non-developer nothing.
 *
 * `auto` and `dontAsk` are deliberately absent. `packages/skills/src/task-schema.ts`
 * carries them "as-is" without saying what they do, and inventing a description
 * for a mode nobody has documented is how a person ends up trusting the wrong
 * sentence. Those fall back to {@link permissionModeLabel}, which returns an
 * unknown mode's own spelling for exactly this reason (DOR-496).
 */
const CARRIED_MODE_DESCRIPTIONS: Partial<Record<PermissionMode, string>> = {
  default: 'ask before every action',
  plan: 'plan only, change nothing',
};

/** Id tying the carried-mode explanation to the radio it describes. */
const CARRIED_MODE_NOTE_ID = 'schedule-permission-carried-note';

/** How a mode the form cannot change is named on its own radio. */
function carriedModeLabel(mode: PermissionMode): string {
  return `Keep current: ${CARRIED_MODE_DESCRIPTIONS[mode] ?? permissionModeLabel(mode)}`;
}

export const DEFAULT_MAX_RUNTIME = '10m';
const MAX_NAME_LENGTH = 100;

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
 * when it is one of the four modes this form does not offer. Coercing it to
 * `acceptEdits` on load — which this did — meant that opening a `plan`-mode task
 * to fix a typo in its prompt and pressing Save widened what that task may do,
 * without the person touching the setting or being told. Widening is a choice
 * somebody has to make on purpose.
 */
export function buildFormValues(
  editTask?: Task,
  preset?: TaskTemplate | null,
  initialAgentId?: string
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
      permissionMode: 'acceptEdits',
      maxRuntime: DEFAULT_MAX_RUNTIME,
    };
  }
  return {
    name: '',
    description: '',
    prompt: '',
    cron: '',
    agentId: initialAgentId ?? '',
    timezone: '',
    permissionMode: 'acceptEdits',
    maxRuntime: DEFAULT_MAX_RUNTIME,
  };
}

// ── ScheduleForm ──────────────────────────────────────────────────────────────
// Isolated component so useAppForm gets fresh defaultValues on each key change.
// The parent increments a key whenever a preset is applied or the dialog resets,
// causing this component to fully remount with the correct initial values.

export interface ScheduleFormProps {
  defaultValues: ScheduleFormValues;
  agents: Array<{ id: string; name: string; projectPath: string; icon?: string; color?: string }>;
  editTask?: Task;
  onSubmitSuccess: () => void;
  onCancel: () => void;
  onDeleteClick: () => void;
  isPending: boolean;
}

/** Inner form component. Remounted via `key` when defaultValues change. */
export function ScheduleForm({
  defaultValues,
  agents,
  editTask,
  onSubmitSuccess,
  onCancel,
  onDeleteClick,
  isPending,
}: ScheduleFormProps) {
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => {
      const resolvedAgentId = value.agentId.trim() || undefined;
      const cronTrimmed = value.cron.trim();

      if (editTask) {
        const input = {
          name: value.name.trim(),
          description: value.description.trim(),
          prompt: value.prompt.trim(),
          cron: cronTrimmed || null,
          ...(cronTrimmed && value.timezone ? { timezone: value.timezone } : {}),
          permissionMode: value.permissionMode,
          maxRuntime: value.maxRuntime.trim() || undefined,
        };
        updateTask.mutate({ id: editTask.id, ...input }, { onSuccess: onSubmitSuccess });
      } else {
        const target = resolvedAgentId ?? 'global';
        const input = {
          name: value.name.trim(),
          description: value.description.trim() || value.name.trim(),
          prompt: value.prompt.trim(),
          target,
          cron: cronTrimmed || undefined,
          ...(cronTrimmed && value.timezone ? { timezone: value.timezone } : {}),
          permissionMode: value.permissionMode,
          maxRuntime: value.maxRuntime.trim() || undefined,
        };
        createTask.mutate(input, { onSuccess: onSubmitSuccess });
      }
    },
  });

  return (
    <form.AppForm>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        id="schedule-form"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="space-y-5 px-4 py-5">
          {/* ── Agent (target) ── */}
          <div className="space-y-2">
            <Label>Agent</Label>
            <form.AppField name="agentId">
              {(field) => (
                <AgentPicker
                  agents={agents}
                  value={field.state.value || undefined}
                  onValueChange={(id) => field.handleChange(id ?? '')}
                />
              )}
            </form.AppField>
          </div>

          {/* ── Essential fields ── */}
          <form.AppField name="name">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="schedule-name">Name *</Label>
                <input
                  id="schedule-name"
                  className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  maxLength={MAX_NAME_LENGTH}
                  placeholder="Daily code review"
                />
                {field.state.meta.isTouched && field.state.meta.errors.length > 0 && (
                  <p className="text-destructive text-xs">{String(field.state.meta.errors[0])}</p>
                )}
              </div>
            )}
          </form.AppField>

          <form.AppField name="description">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="schedule-description">Description *</Label>
                <input
                  id="schedule-description"
                  className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="A short description of this schedule"
                />
                {field.state.meta.isTouched && field.state.meta.errors.length > 0 && (
                  <p className="text-destructive text-xs">{String(field.state.meta.errors[0])}</p>
                )}
              </div>
            )}
          </form.AppField>

          <form.AppField name="prompt">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="schedule-prompt">Prompt *</Label>
                <textarea
                  id="schedule-prompt"
                  className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  rows={4}
                  placeholder="Review all pending PRs and summarize findings..."
                />
                {field.state.meta.isTouched && field.state.meta.errors.length > 0 && (
                  <p className="text-destructive text-xs">{String(field.state.meta.errors[0])}</p>
                )}
              </div>
            )}
          </form.AppField>

          {/* ── Schedule (optional) ── */}
          <details className="group" open={!!defaultValues.cron}>
            <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1.5 text-sm">
              <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
              Schedule
              <span className="text-muted-foreground/60 text-xs">(optional)</span>
            </summary>
            <div className="mt-3 space-y-4 pl-6">
              <form.AppField name="cron">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label>Cron Expression</Label>
                    <ScheduleBuilder
                      value={field.state.value}
                      onChange={(cron) => field.handleChange(cron)}
                    />
                  </div>
                )}
              </form.AppField>
              <form.AppField name="timezone">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label>Timezone</Label>
                    <TimezoneCombobox
                      value={field.state.value}
                      onChange={(tz) => field.handleChange(tz)}
                    />
                  </div>
                )}
              </form.AppField>
            </div>
          </details>

          {/* ── Advanced settings (collapsed by default) ── */}
          <details className="group">
            <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1.5 text-sm">
              <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
              Advanced settings
            </summary>

            <div className="mt-3 space-y-4 pl-6">
              <form.AppField name="permissionMode">
                {(field) => (
                  <fieldset className="space-y-2">
                    <legend className="mb-1.5 text-sm font-medium">Permission Mode</legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="permissionMode"
                        checked={field.state.value === 'acceptEdits'}
                        onChange={() => field.handleChange('acceptEdits')}
                      />
                      Allow file edits
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="permissionMode"
                        checked={field.state.value === 'bypassPermissions'}
                        onChange={() => field.handleChange('bypassPermissions')}
                      />
                      Full autonomy
                    </label>
                    {!OFFERED_MODES.includes(field.state.value) && (
                      <>
                        <label className="text-muted-foreground flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="permissionMode"
                            checked
                            disabled
                            readOnly
                            aria-describedby={CARRIED_MODE_NOTE_ID}
                          />
                          {carriedModeLabel(field.state.value)}
                        </label>
                        <p id={CARRIED_MODE_NOTE_ID} className="text-muted-foreground text-xs">
                          This task was set up somewhere else. Saving keeps it as it is — pick one
                          of the options above to change it.
                        </p>
                      </>
                    )}
                    {field.state.value === 'bypassPermissions' && (
                      <p className="text-xs text-yellow-600 dark:text-yellow-400">
                        Warning: This allows the agent to execute any tool without approval.
                      </p>
                    )}
                    <PermissionModeScopeNote mode={field.state.value} />
                  </fieldset>
                )}
              </form.AppField>

              <form.AppField name="maxRuntime">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-max-runtime">Max Runtime</Label>
                    <input
                      id="schedule-max-runtime"
                      className="border-input focus-visible:ring-ring w-24 rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="10m"
                    />
                  </div>
                )}
              </form.AppField>
            </div>
          </details>
        </div>
      </form>

      {/* Footer uses form.Subscribe to reactively derive submit-button disabled state. */}
      <ResponsiveDialogFooter className="shrink-0 border-t px-4 py-3">
        {editTask && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive mr-auto"
            onClick={onDeleteClick}
          >
            <Trash2 className="mr-1.5 size-4" />
            Delete
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <form.Subscribe
          selector={(s) => s.values.name.trim() !== '' && s.values.prompt.trim() !== ''}
        >
          {(isFormValid) => (
            <Button
              type="submit"
              size="sm"
              form="schedule-form"
              disabled={!isFormValid || isPending}
            >
              {isPending ? 'Saving...' : editTask ? 'Save' : 'Create'}
            </Button>
          )}
        </form.Subscribe>
      </ResponsiveDialogFooter>
    </form.AppForm>
  );
}
