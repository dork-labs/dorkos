import { useState } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import { useCreateTask, useUpdateTask } from '@/layers/entities/tasks';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import {
  ResponsiveDialogFooter,
  Label,
  Button,
  PermissionModeScopeNote,
  TrustDial,
  UnattendedAutonomyDialog,
} from '@/layers/shared/ui';
import { useAppForm } from '@/layers/shared/lib/form';
import { needsConsentRitual, permissionModeLabel } from '@/layers/shared/lib';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { PermissionMode, Task } from '@dorkos/shared/types';
import { ScheduleBuilder } from './TaskBuilder';
import { TimezoneCombobox } from './TimezoneCombobox';
import { AgentPicker } from './AgentPicker';

export type DialogStep = 'preset-picker' | 'form';

/**
 * The runtime a scheduled run actually executes on.
 *
 * **This is an assumption, and deliberately not the registry default.** A task
 * carries no runtime of its own, and the scheduler's is fixed at boot:
 * `apps/server/src/index.ts` binds `schedulerAgentManager` to the
 * `ClaudeCodeRuntime` it constructs and hands that to `TaskSchedulerService`.
 * The `runtimes.default` setting moves the *registry's* default — which runtime
 * a new chat session gets — and never reaches the scheduler. So on a server set
 * to Codex, dialling the default would caption a Claude Code run with Codex's
 * promises: amber "can't pause to ask" for a run that will pause and ask, and no
 * unattended-approval note at all, because Codex declares `asks: 'never'` at
 * that stop.
 *
 * **Where this breaks:** the day the scheduler takes its runtime from the
 * registry, or a task carries one. The fix then is to read it from the task (or
 * from a scheduler-runtime endpoint), not to widen this constant.
 *
 * A test-mode boot is the one case this is already wrong about — the scheduler
 * runs on `TestModeRuntime` there and `claude-code` is never registered. That
 * resolves to no profile at all, which the form says out loud rather than
 * guessing.
 */
export const TASK_RUNTIME = 'claude-code';

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
  const caps = useCapabilitiesForRuntime(TASK_RUNTIME);
  const descriptors = caps?.permissionModes.values ?? [];
  const [pendingAutonomy, setPendingAutonomy] = useState<PermissionModeDescriptor | null>(null);

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
                {(field) => {
                  const current = descriptors.find((d) => d.id === field.state.value);
                  // The runtime's own word for the mode wherever it declared one.
                  const modeLabel = current?.label ?? permissionModeLabel(field.state.value);
                  if (descriptors.length === 0) {
                    // No profile in hand — one round trip on a cold open, and
                    // forever under a test-mode boot, where the scheduler runs on
                    // `TestModeRuntime` and `claude-code` is never registered.
                    return (
                      <fieldset className="space-y-2">
                        <legend className="mb-1.5 text-sm font-medium">Permissions</legend>
                        <p
                          data-testid="trust-dial-unavailable"
                          className="text-muted-foreground px-1 text-xs leading-relaxed"
                        >
                          This task is set to “{modeLabel}”. The agent that runs it hasn’t said what
                          it can do, so there is nothing to choose from yet — saving keeps it as it
                          is.
                        </p>
                      </fieldset>
                    );
                  }
                  return (
                    <fieldset className="space-y-2">
                      <legend className="mb-1.5 text-sm font-medium">Permissions</legend>
                      <TrustDial
                        mode={field.state.value}
                        descriptors={descriptors}
                        // A stop that never asks is the one nobody can walk back
                        // on a run nobody is watching, so it asks first. The
                        // rule is `needsConsentRitual` — the server's own — not
                        // a stop comparison, so a runtime that files a
                        // never-asking mode at the MIDDLE stop is caught here
                        // too (DOR-816).
                        onChangeMode={(next) => {
                          const descriptor = descriptors.find((d) => d.id === next);
                          if (descriptor && needsConsentRitual(descriptor)) {
                            setPendingAutonomy(descriptor);
                            return;
                          }
                          field.handleChange(next as PermissionMode);
                        }}
                        // A schedule has no Plan switch. One saved at `plan` is
                        // kept and named, not frozen behind a control that is
                        // not on this screen.
                        strandsWorkingMode
                        strandedNote={
                          <>
                            This task is set to “{modeLabel}”, which is not one of these. Saving
                            keeps it as it is — pick a stop to change it.
                          </>
                        }
                      />
                      {/* The fact that is true here and on no attended surface:
                          a stop that asks has nobody to ask. Read from what the
                          runtime declared, never from a mode id.

                          What happens next is NOT a stall until `maxRuntime`:
                          `interactive-handlers.ts` refuses the ask at
                          `SESSIONS.INTERACTION_TIMEOUT_MS` and the turn carries
                          on, so a long task with three asks quietly loses half an
                          hour of work and still finishes. */}
                      {current !== undefined && current.asks !== 'never' && (
                        <p
                          data-testid="task-unattended-note"
                          className="text-muted-foreground px-1 text-xs leading-relaxed"
                        >
                          Nobody is watching a scheduled run. Anything it stops to ask about is
                          refused after 10 minutes, and the run carries on without it.
                        </p>
                      )}
                      <PermissionModeScopeNote
                        mode={field.state.value}
                        {...(current ? { descriptor: current } : {})}
                        className="px-1"
                      />
                      <UnattendedAutonomyDialog
                        descriptor={pendingAutonomy}
                        consequence={
                          <>
                            A scheduled run has nobody to ask, so nothing is asked: no approval
                            card, no message, no record of a decision anybody made. At a stop that
                            asks, an action it cannot take is refused and the run works around it.
                            Here it simply happens.
                          </>
                        }
                        onCancel={() => setPendingAutonomy(null)}
                        onConfirm={() => {
                          if (pendingAutonomy) {
                            field.handleChange(pendingAutonomy.id as PermissionMode);
                          }
                          setPendingAutonomy(null);
                        }}
                      />
                    </fieldset>
                  );
                }}
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
