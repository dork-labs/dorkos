import { ChevronLeft, ChevronRight, FolderOpen, Trash2 } from 'lucide-react';
import { useCreateSchedule, useUpdateSchedule } from '@/layers/entities/pulse';
import type { PulsePreset } from '@/layers/entities/pulse';
import { ResponsiveDialogFooter, DirectoryPicker, Label, Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useAppForm } from '@/layers/shared/lib/form';
import type { PulseSchedule } from '@dorkos/shared/types';
import { ScheduleBuilder, DEFAULT_CRON } from './ScheduleBuilder';
import { TimezoneCombobox } from './TimezoneCombobox';
import { AgentPicker } from './AgentPicker';

export type PermissionMode = 'acceptEdits' | 'bypassPermissions';
export type ScheduleTarget = 'agent' | 'directory';
export type DialogStep = 'preset-picker' | 'form';

export const DEFAULT_MAX_RUNTIME_MIN = 10;
const MAX_NAME_LENGTH = 100;
const MAX_RUNTIME_MIN = 720;

/** All fields managed by TanStack Form. */
export type ScheduleFormValues = {
  name: string;
  prompt: string;
  cron: string;
  cwd: string;
  /** Empty string means "no agent selected" — sentinel avoids string | undefined type mismatch. */
  agentId: string;
  timezone: string;
  permissionMode: PermissionMode;
  maxRuntimeMin: number;
};

/** Build form default values from an edit schedule, a preset, or blank defaults. */
export function buildFormValues(
  editSchedule?: PulseSchedule,
  preset?: PulsePreset | null,
  initialAgentId?: string
): ScheduleFormValues {
  if (editSchedule) {
    return {
      name: editSchedule.name,
      prompt: editSchedule.prompt,
      cron: editSchedule.cron,
      cwd: editSchedule.cwd ?? '',
      agentId: editSchedule.agentId ?? '',
      timezone: editSchedule.timezone ?? '',
      permissionMode:
        editSchedule.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits',
      maxRuntimeMin: editSchedule.maxRuntime
        ? editSchedule.maxRuntime / 60_000
        : DEFAULT_MAX_RUNTIME_MIN,
    };
  }
  if (preset) {
    return {
      name: preset.name,
      prompt: preset.prompt,
      cron: preset.cron,
      cwd: '',
      agentId: initialAgentId ?? '',
      timezone: preset.timezone ?? '',
      permissionMode: 'acceptEdits',
      maxRuntimeMin: DEFAULT_MAX_RUNTIME_MIN,
    };
  }
  return {
    name: '',
    prompt: '',
    cron: DEFAULT_CRON,
    cwd: '',
    agentId: initialAgentId ?? '',
    timezone: '',
    permissionMode: 'acceptEdits',
    maxRuntimeMin: DEFAULT_MAX_RUNTIME_MIN,
  };
}

// ── ScheduleForm ──────────────────────────────────────────────────────────────
// Isolated component so useAppForm gets fresh defaultValues on each key change.
// The parent increments a key whenever a preset is applied or the dialog resets,
// causing this component to fully remount with the correct initial values.

export interface ScheduleFormProps {
  defaultValues: ScheduleFormValues;
  agents: Array<{ id: string; name: string; projectPath: string; icon?: string; color?: string }>;
  editSchedule?: PulseSchedule;
  scheduleTarget: ScheduleTarget;
  onScheduleTargetChange: (target: ScheduleTarget) => void;
  onSubmitSuccess: () => void;
  onCancel: () => void;
  onDeleteClick: () => void;
  isPending: boolean;
  cwdPickerOpen: boolean;
  onCwdPickerOpenChange: (open: boolean) => void;
}

/** Inner form component. Remounted via `key` when defaultValues change. */
export function ScheduleForm({
  defaultValues,
  agents,
  editSchedule,
  scheduleTarget,
  onScheduleTargetChange,
  onSubmitSuccess,
  onCancel,
  onDeleteClick,
  isPending,
  cwdPickerOpen,
  onCwdPickerOpenChange,
}: ScheduleFormProps) {
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();

  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) => {
      const resolvedAgentId = value.agentId.trim() || undefined;
      const input = {
        name: value.name.trim(),
        prompt: value.prompt.trim(),
        cron: value.cron.trim(),
        ...(scheduleTarget === 'agent' && resolvedAgentId ? { agentId: resolvedAgentId } : {}),
        ...(scheduleTarget === 'directory' && value.cwd.trim() ? { cwd: value.cwd.trim() } : {}),
        ...(value.timezone && { timezone: value.timezone }),
        permissionMode: value.permissionMode,
        maxRuntime: value.maxRuntimeMin * 60_000,
      };

      if (editSchedule) {
        updateSchedule.mutate({ id: editSchedule.id, ...input }, { onSuccess: onSubmitSuccess });
      } else {
        createSchedule.mutate(input, { onSuccess: onSubmitSuccess });
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
          {/* ── Agent / Directory ── */}
          {scheduleTarget === 'agent' ? (
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
              <button
                type="button"
                onClick={() => {
                  onScheduleTargetChange('directory');
                  form.setFieldValue('agentId', '');
                }}
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              >
                Run in a specific directory instead...
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => onScheduleTargetChange('agent')}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs underline-offset-4 hover:underline"
              >
                <ChevronLeft className="size-3" />
                Back to agent selection
              </button>
              <Label htmlFor="schedule-cwd">Working Directory</Label>
              <form.AppField name="cwd">
                {(field) => (
                  <div className="flex gap-2">
                    <div
                      className={cn(
                        'flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm',
                        field.state.value ? 'text-foreground' : 'text-muted-foreground'
                      )}
                    >
                      {field.state.value || 'Default (server working directory)'}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      onClick={() => onCwdPickerOpenChange(true)}
                      aria-label="Browse directories"
                    >
                      <FolderOpen className="size-4" />
                    </Button>
                  </div>
                )}
              </form.AppField>
            </div>
          )}

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

          <form.AppField name="cron">
            {(field) => (
              <div className="space-y-1.5">
                <Label>Schedule *</Label>
                <ScheduleBuilder
                  value={field.state.value}
                  onChange={(cron) => field.handleChange(cron)}
                />
              </div>
            )}
          </form.AppField>

          {/* ── Timezone ── */}
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
                    {field.state.value === 'bypassPermissions' && (
                      <p className="text-xs text-yellow-600 dark:text-yellow-400">
                        Warning: This allows the agent to execute any tool without approval.
                      </p>
                    )}
                  </fieldset>
                )}
              </form.AppField>

              <form.AppField name="maxRuntimeMin">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-max-runtime">Max Runtime (minutes)</Label>
                    <input
                      id="schedule-max-runtime"
                      type="number"
                      className="border-input focus-visible:ring-ring w-24 rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(Number(e.target.value))}
                      onBlur={field.handleBlur}
                      min={1}
                      max={MAX_RUNTIME_MIN}
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
        {editSchedule && (
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
          selector={(s) =>
            s.values.name.trim() !== '' &&
            s.values.prompt.trim() !== '' &&
            s.values.cron.trim() !== ''
          }
        >
          {(isFormValid) => (
            <Button
              type="submit"
              size="sm"
              form="schedule-form"
              disabled={!isFormValid || isPending}
            >
              {isPending ? 'Saving...' : editSchedule ? 'Save' : 'Create'}
            </Button>
          )}
        </form.Subscribe>
      </ResponsiveDialogFooter>

      {/* DirectoryPicker lives here so it shares form context for cwd field updates. */}
      <form.AppField name="cwd">
        {(field) => (
          <DirectoryPicker
            open={cwdPickerOpen}
            onOpenChange={onCwdPickerOpenChange}
            onSelect={(path) => field.handleChange(path)}
          />
        )}
      </form.AppField>
    </form.AppForm>
  );
}
