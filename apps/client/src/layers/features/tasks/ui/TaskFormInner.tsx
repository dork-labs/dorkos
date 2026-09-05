import { useStore } from '@tanstack/react-form';
import { ChevronRight, Trash2 } from 'lucide-react';
import { useCreateTask, useUpdateTask } from '@/layers/entities/tasks';
import type { TaskTemplate } from '@/layers/entities/tasks';
import {
  ResponsiveDialogFooter,
  Label,
  Button,
  PermissionModeScopeNote,
  Switch,
  TrustDial,
  UnattendedAutonomyDialog,
} from '@/layers/shared/ui';
import { useAppForm } from '@/layers/shared/lib/form';
import { permissionModeLabel } from '@/layers/shared/lib';
import type { EffortLevel, PermissionMode, Task } from '@dorkos/shared/types';
import { ScheduleBuilder, isCronValid } from './TaskBuilder';
import { TimezoneCombobox } from './TimezoneCombobox';
import { TaskAgentField, type TaskAgentRoster } from './TaskAgentField';
import { TaskExecutionFields } from './TaskExecutionFields';
import { useAgentRuntimes, useTaskExecution } from './use-task-execution';
import { usePostureConsent } from './use-posture-consent';
import { useAgentPick } from './use-agent-pick';

export type DialogStep = 'preset-picker' | 'form';

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

// ── ScheduleForm ──────────────────────────────────────────────────────────────
// Isolated component so useAppForm gets fresh defaultValues on each key change.
// The parent increments a key whenever a preset is applied or the dialog resets,
// causing this component to fully remount with the correct initial values.

export interface ScheduleFormProps {
  defaultValues: ScheduleFormValues;
  /**
   * The agents this machine can file a task against, carrying whether that
   * list is an answer yet — see {@link TaskAgentRoster}. The flags travel with
   * the list rather than beside it so no caller can flatten the three worlds
   * into one empty array.
   */
  roster: TaskAgentRoster;
  editTask?: Task;
  onSubmitSuccess: () => void;
  onCancel: () => void;
  onDeleteClick: () => void;
  isPending: boolean;
}

/** Inner form component. Remounted via `key` when defaultValues change. */
export function ScheduleForm({
  defaultValues,
  roster,
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
          sticky: value.sticky,
          // Always sent, and `null` where the form is empty — that is how an
          // update CLEARS an override (`UpdateTaskRequestSchema`). Omitting the
          // key would mean "leave it as it was", which makes the first option
          // in each select unreachable once a value has been saved.
          runtime: value.runtime || null,
          model: value.model || null,
          effort: (value.effort || null) as EffortLevel | null,
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
          ...(value.sticky ? { sticky: true } : {}),
          // Omitted rather than nulled on a CREATE: there is nothing to clear
          // yet, and a body that carries only what was chosen is the shape the
          // rest of this call already has.
          ...(value.runtime ? { runtime: value.runtime } : {}),
          ...(value.model ? { model: value.model } : {}),
          ...(value.effort ? { effort: value.effort as EffortLevel } : {}),
        };
        createTask.mutate(input, { onSuccess: onSubmitSuccess });
      }
    },
  });

  // The three values the Runs-on controls and the Trust dial both depend on,
  // read off the live form rather than through `form.Subscribe`: the resolution
  // below is hooks, and hooks cannot live inside a render prop.
  const agentId = useStore(form.store, (s) => s.values.agentId);
  const runtimeOverride = useStore(form.store, (s) => s.values.runtime);
  const modelOverride = useStore(form.store, (s) => s.values.model);
  const effortOverride = useStore(form.store, (s) => s.values.effort);
  // Read here as well as inside its own field, because the consent door below
  // has to know which mode it is about to hand to a different runtime.
  const permissionMode = useStore(form.store, (s) => s.values.permissionMode);

  // Every picker agent's own runtime, off the manifest that owns it (ADR-0043).
  // The whole list rather than the selected one, because the agent picker below
  // has to know what a candidate agent would run on before it commits the pick.
  const agentRuntimes = useAgentRuntimes(roster.agents);
  const agentRuntime = agentRuntimes.runtimeFor(agentId);

  const execution = useTaskExecution({
    runtime: runtimeOverride,
    model: modelOverride,
    effort: effortOverride,
    agentRuntime,
  });

  // The dial speaks the vocabulary of the runtime this task will ACTUALLY run
  // on — the task's own choice, else its agent's, else the server default.
  // Pinned to `claude-code` this used to caption a Codex run with Claude Code's
  // promises, which is the defect the retired `TASK_RUNTIME` constant named in
  // its own comment.
  //
  // The same hook owns the consent door, because the modes a runtime declares
  // are both what the dial reads and what decides whether a change of runtime
  // has to be asked about — two lookups that could disagree is how one door ends
  // up open and the other shut.
  const consent = usePostureConsent({
    permissionMode,
    effectiveRuntime: execution.effectiveRuntime,
  });
  const descriptors = consent.descriptors;

  // A pick is priced against the candidate agent's OWN runtime, and waits when
  // that is not known yet rather than guessing — see `use-agent-pick`, which
  // owns that policy and the reason it is not optional.
  //
  // A task with its own runtime override inherits nothing, so the agent cannot
  // move its posture there: that pick finds no widening and simply happens.
  const agentPick = useAgentPick({
    runtimes: agentRuntimes,
    onResolved: (nextAgentId, candidateRuntime) => {
      const nextRuntime = runtimeOverride || execution.inheritedRuntimeFor(candidateRuntime);
      consent.guardRuntime(nextRuntime, () => form.setFieldValue('agentId', nextAgentId));
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
          <TaskAgentField
            roster={roster}
            value={agentId}
            locked={editTask !== undefined}
            pick={agentPick}
          />

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
                    <Label>When it runs</Label>
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

          {/* The cron warning lives inside the Schedule section, which collapses
              — and a collapsed section plus a disabled Create button is a dead
              end with its reason hidden. This sits OUTSIDE the <details>, so the
              reason is on screen either way. Deliberately not forcing the
              section open instead: React only writes `open` when the prop
              changes, so a person who collapses it again would never see it
              reopen. */}
          <form.Subscribe selector={(s) => !isCronValid(s.values.cron)}>
            {(cronIsBroken) =>
              cronIsBroken ? (
                <p role="alert" data-testid="cron-blocks-save" className="text-destructive text-xs">
                  Fix the timing under Schedule before saving.
                </p>
              ) : null
            }
          </form.Subscribe>

          {/* ── Advanced settings (collapsed by default) ── */}
          <details className="group">
            <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1.5 text-sm">
              <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
              Advanced settings
            </summary>

            <div className="mt-3 space-y-4 pl-6">
              {/* Above Permissions on purpose: the dial's whole vocabulary comes
                  from the runtime chosen here, so the runtime is the thing to
                  read first. */}
              <TaskExecutionFields
                runtime={runtimeOverride}
                model={modelOverride}
                effort={effortOverride}
                execution={execution}
                // A model belongs to ONE runtime's id space (spec §2, decision
                // 3), so a model picked for Codex means nothing on Claude Code.
                // The runtime change does NOT silently drop it: the model row
                // goes amber and names the mismatch, the way the Runs on picker
                // does, and the person clears it or changes it themselves.
                // Deleting somebody's choice as a side effect of another choice
                // is the thing they cannot undo.
                //
                // The permission mode is the one thing a runtime change can
                // WIDEN rather than merely break, because the id survives and
                // the meaning does not, so this is the dial's consent door
                // reached by another route (see `usePostureConsent`). Nothing
                // is written until the door is answered: the select is
                // controlled by the field, so dismissing leaves it exactly where
                // it was, with no revert to write.
                onRuntimeChange={(value) =>
                  consent.guardRuntime(value || execution.inheritedRuntime, () =>
                    form.setFieldValue('runtime', value)
                  )
                }
                onModelChange={(value) => form.setFieldValue('model', value)}
                onEffortChange={(value) => form.setFieldValue('effort', value)}
              />

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
                          This scheduled task is set to “{modeLabel}”. The agent that runs it hasn’t
                          said what it can do, so there is nothing to choose from yet. Saving keeps
                          it as it is.
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
                        // on a run nobody is watching, so it asks first. This is
                        // one of THREE ways into that posture on this form; the
                        // others are the Runtime picker above and the Agent
                        // picker at the top, and all three go through one rule
                        // in `usePostureConsent` because a gate on one path is
                        // not a gate.
                        onChangeMode={(next) =>
                          consent.guardMode(
                            descriptors.find((d) => d.id === next),
                            () => field.handleChange(next as PermissionMode)
                          )
                        }
                        // A schedule has no Plan switch. One saved at `plan` is
                        // kept and named, not frozen behind a control that is
                        // not on this screen.
                        strandsWorkingMode
                        strandedNote={
                          <>
                            This scheduled task is set to “{modeLabel}”, which is not one of these.
                            Saving keeps it as it is. Pick a stop to change it.
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
                    </fieldset>
                  );
                }}
              </form.AppField>

              <form.AppField name="maxRuntime">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-max-runtime">Stop after</Label>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      Give up if the run takes longer than this.
                    </p>
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

              {/* Sticky: resume one session across runs (DOR-1571). */}
              <form.AppField name="sticky">
                {(field) => (
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="schedule-sticky">Remember the last run</Label>
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        Resume the same session each run, so the agent remembers what it did last
                        time. Off starts fresh every run.
                      </p>
                    </div>
                    <Switch
                      id="schedule-sticky"
                      checked={field.state.value}
                      onCheckedChange={(checked) => field.handleChange(checked)}
                    />
                  </div>
                )}
              </form.AppField>
            </div>
          </details>
        </div>
      </form>

      {/* One door, every route into a never-asking posture — the dial, the
          runtime picker and the agent picker. Outside the Permissions field on
          purpose: that field renders nothing when the effective runtime has
          declared no modes, and moving a task ONTO a runtime that declares one
          is exactly the case that has to be asked about. */}
      <UnattendedAutonomyDialog
        descriptor={consent.pendingDescriptor}
        consequence={
          <>
            A scheduled run has nobody to ask, so nothing is asked: no approval card, no message, no
            record of a decision anybody made. At a stop that asks, an action it cannot take is
            refused and the run works around it. Here it simply happens.
          </>
        }
        onCancel={consent.dismiss}
        onConfirm={consent.confirm}
      />

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
        {/* A cron the builder is already showing in red cannot also be saveable.
            It used to be: the escape-hatch input said "Invalid cron expression"
            and Create stayed live, so the schedule went to the server and came
            back rejected — or worse, saved and never fired. Same predicate as
            the warning (`isCronValid`), so the two cannot disagree. */}
        <form.Subscribe
          selector={(s) =>
            s.values.name.trim() !== '' &&
            s.values.prompt.trim() !== '' &&
            isCronValid(s.values.cron)
          }
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
