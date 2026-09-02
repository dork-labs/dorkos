import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useTaskTemplateDialog,
} from '@/layers/entities/tasks';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useConfig } from '@/layers/entities/config';
import { useCapabilitiesForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { operatorStopForRuntime, resolveConfiguredStopMode } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Switch,
} from '@/layers/shared/ui';
import type { Task } from '@dorkos/shared/types';
import { TaskTemplateGallery } from './TaskTemplateGallery';
import {
  ScheduleForm,
  buildFormValues,
  type ScheduleFormValues,
  type DialogStep,
} from './TaskFormInner';
import type { TaskAgentRoster } from './TaskAgentField';
import { useAgentRuntime } from './use-task-execution';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTask?: Task;
  /** When provided, dialog opens directly at form step with this preset pre-filled. */
  initialPreset?: TaskTemplate | null;
  /** Pre-select this agent when creating a new schedule. */
  initialAgentId?: string;
}

// ── CreateTaskDialog ──────────────────────────────────────────────────────

/** Create or edit a Tasks schedule using ResponsiveDialog with progressive disclosure. */
export function CreateTaskDialog({
  open,
  onOpenChange,
  editTask,
  initialPreset,
  initialAgentId,
}: Props) {
  const deleteTask = useDeleteTask();
  const updateTask = useUpdateTask();
  const createTask = useCreateTask();
  // The list AND whether it is an answer yet, kept together all the way down.
  // Flattened to `agents` alone, an in-flight read and a failed one both look
  // exactly like "this machine has no agents" — and the edit form then tells
  // somebody their perfectly healthy task points at an agent that is gone
  // (DOR-1694). `useAgentRuntimes` splits the same three worlds for the same
  // reason.
  const { data: agentsData, isError: agentsUnreadable } = useMeshAgentPaths();
  const roster: TaskAgentRoster = {
    agents: agentsData?.agents ?? [],
    answered: agentsData !== undefined,
    unreadable: agentsUnreadable,
  };

  // Which runtime a NEW task will actually run on, so the operator's configured
  // stop is mapped through THAT runtime's own modes and the mode this dialog
  // stores is the one that will execute.
  //
  // Resolved from the agent the dialog was OPENED on, and deliberately not
  // re-resolved when somebody picks a different agent in the form: the mode is a
  // starting position, and moving it under a person mid-edit would overwrite a
  // choice they may already have made. The dial's caption does follow the live
  // `effectiveRuntime`, so what is on screen always describes the run.
  //
  // Two rungs of the fire-time ladder are reachable here (spec
  // `task-runtime-model` §2.4; `services/tasks/execution/resolve-run-execution.ts`):
  // the task carries no runtime of its own until somebody picks one in the form,
  // so it is the target agent's manifest runtime, else the server default. The
  // agent tier counts only for a runtime this machine has REGISTERED — the same
  // tolerance the server's resolver applies. Pinned to `claude-code`, this used
  // to hand a Codex agent's task a stop resolved in Claude Code's vocabulary.
  const { data: capabilityMap } = useRuntimeCapabilities();
  const initialAgentRuntime = useAgentRuntime(roster.agents, initialAgentId);
  // REGISTERED means an own property, not a truthy index. A manifest's `runtime`
  // is a free string, so `constructor` and `toString` are reachable values, and
  // a truthiness test answers them with an inherited member — `Object` is truthy,
  // so the agent tier was taken for a runtime that does not exist. The task then
  // resolved its opening stop against an empty mode list and fell back to
  // `acceptEdits`, quietly discarding the operator's configured stop for the
  // runtime the task would ACTUALLY run on. `useTaskExecution` has always read
  // this from `Object.keys`; this is the same question, so it gets the same
  // answer.
  const agentRuntimeIsRegistered =
    initialAgentRuntime !== null &&
    capabilityMap !== undefined &&
    Object.hasOwn(capabilityMap.capabilities, initialAgentRuntime);
  const newTaskRuntime = agentRuntimeIsRegistered
    ? initialAgentRuntime
    : (capabilityMap?.defaultRuntime ?? null);

  // A NEW task opens at the operator's own configured stop, mapped to that
  // runtime's mode, rather than a hardcoded `acceptEdits` (spec
  // `full-power-defaults`, D6). Falls back to `acceptEdits` when no stop is set
  // or the profile has not loaded. Held in a ref so a late-arriving config does
  // not reset a form the person is already editing — the reset below runs on
  // open, and reads the freshest value then.
  const { data: config } = useConfig();
  const taskCaps = useCapabilitiesForRuntime(newTaskRuntime);
  const defaultMode = resolveConfiguredStopMode(
    newTaskRuntime ? operatorStopForRuntime(config?.executionDefaults, newTaskRuntime) : null,
    // `?.` on the last link too: the truthiness test above passes an INHERITED
    // member straight through — an agent pinned to a runtime called `constructor`
    // resolves `Object` there — and that member has no `permissionModes`.
    taskCaps?.permissionModes?.values ?? []
  );
  const defaultModeRef = useRef(defaultMode);
  // Latest-value ref, kept fresh in an effect rather than during render (a
  // render-time ref write is impure). Runs before the reset effect below, so
  // that effect always reads the freshest resolved mode on open.
  useLayoutEffect(() => {
    defaultModeRef.current = defaultMode;
  }, [defaultMode]);

  // ── UI-only state ──
  const [step, setStep] = useState<DialogStep>(() => (editTask ? 'form' : 'preset-picker'));
  const [appliedPreset, setAppliedPreset] = useState<TaskTemplate | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Local shadow of enabled state — allows the Switch to respond immediately
  // while the mutation + refetch catches up.
  const [localEnabled, setLocalEnabled] = useState(editTask?.enabled ?? true);

  // formValues drives ScheduleForm defaultValues. Changing this + incrementing
  // formKey causes ScheduleForm to remount with fresh form state.
  const [formValues, setFormValues] = useState<ScheduleFormValues>(() =>
    // Read `defaultMode` directly, not the ref: at mount they are equal, and
    // reading a ref during render is impure. The ref exists only for the
    // reset-on-open effect, which must not carry `defaultMode` as a dependency.
    buildFormValues(editTask, undefined, initialAgentId, defaultMode)
  );
  // Incrementing this key remounts ScheduleForm so useAppForm gets fresh defaultValues.
  const [formKey, setFormKey] = useState(0);

  function applyFormValues(values: ScheduleFormValues) {
    setFormValues(values);
    setFormKey((k) => k + 1);
  }

  // Reset when dialog opens/closes or edit target changes.

  useEffect(() => {
    if (!open) {
      applyFormValues(buildFormValues(editTask, undefined, initialAgentId, defaultModeRef.current));
      setAppliedPreset(null);
      setDeleteConfirmOpen(false);
      setStep(editTask ? 'form' : 'preset-picker');
      return;
    }
    if (editTask) {
      applyFormValues(buildFormValues(editTask));
      setLocalEnabled(editTask.enabled);
      setStep('form');
    } else if (initialPreset) {
      applyFormValues(
        buildFormValues(undefined, initialPreset, initialAgentId, defaultModeRef.current)
      );
      setAppliedPreset(initialPreset);
      setStep('form');
    } else {
      applyFormValues(
        buildFormValues(undefined, undefined, initialAgentId, defaultModeRef.current)
      );
      setStep('preset-picker');
    }
  }, [editTask, open, initialPreset, initialAgentId]);

  // Wire external trigger from useTaskTemplateDialog (e.g. from TasksView sidebar).
  const { pendingTemplate, externalTrigger, clear } = useTaskTemplateDialog();

  useEffect(() => {
    if (externalTrigger && pendingTemplate) {
      applyFormValues(
        buildFormValues(undefined, pendingTemplate, initialAgentId, defaultModeRef.current)
      );
      setAppliedPreset(pendingTemplate);
      setStep('form');
      clear();
    }
  }, [externalTrigger, pendingTemplate, clear, initialAgentId]);

  function handleSelectPreset(preset: TaskTemplate) {
    applyFormValues(buildFormValues(undefined, preset, initialAgentId, defaultModeRef.current));
    setAppliedPreset(preset);
    setStep('form');
  }

  function handleDelete() {
    if (!editTask) return;
    deleteTask.mutate(editTask.id, {
      onSuccess: () => {
        setDeleteConfirmOpen(false);
        onOpenChange(false);
      },
    });
  }

  function handleToggleEnabled(checked: boolean) {
    if (!editTask) return;
    setLocalEnabled(checked);
    updateTask.mutate(
      { id: editTask.id, enabled: checked },
      // The switch moves before the server has agreed. When the PATCH fails, the
      // shared mutation toast (`useUpdateTask`'s `meta.errorLabel`) says so — but
      // the switch stayed where the click put it, so the dialog went on claiming
      // a schedule was off when it was still running on its cron. Put it back.
      //
      // Back to the last value the server confirmed, not to what the switch read
      // just before the click. Those differ the moment two toggles overlap, and a
      // rollback to a stale local value is how you end up asserting a state
      // nobody holds. The switch is disabled while a change is in flight (below),
      // so overlapping toggles should not be reachable from the UI at all — this
      // is the second lock on the same door, because `mutate` is callable from
      // anywhere and a detached observer's `onError` never runs.
      //
      // The residual, stated honestly: `editTask` is a prop, so for one round
      // trip after a SUCCESSFUL toggle it is stale by one write, and a failure
      // landing inside that window rolls back one value behind. It self-heals
      // rather than sticking — the success invalidated the list, and the refetch
      // hands down a new `editTask` identity (structural sharing only preserves
      // identity when the data is unchanged), which re-runs the sync effect above
      // and sets `localEnabled` from it.
      { onError: () => setLocalEnabled(editTask.enabled) }
    );
  }

  const isPending = createTask.isPending || updateTask.isPending;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 p-0">
        <ResponsiveDialogHeader className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            {step === 'form' && !editTask && (
              <button
                type="button"
                onClick={() => setStep('preset-picker')}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
                aria-label="Back to preset picker"
              >
                <ChevronLeft className="size-4" />
                Back
              </button>
            )}
            <ResponsiveDialogTitle>
              {editTask ? 'Edit Schedule' : 'New Schedule'}
            </ResponsiveDialogTitle>
            {editTask && (
              <Switch
                className="ml-auto"
                checked={localEnabled}
                onCheckedChange={handleToggleEnabled}
                // One change at a time. A second toggle issued while the first
                // is still in flight detaches the first mutation's observer, so
                // its `onError` never runs and a failed pair leaves the switch
                // asserting the opposite of what the server holds.
                disabled={updateTask.isPending}
                aria-label={localEnabled ? 'Disable schedule' : 'Enable schedule'}
              />
            )}
          </div>
          <ResponsiveDialogDescription className="sr-only">
            {editTask ? 'Edit an existing schedule' : 'Create a new schedule'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {/* Step 1: Preset picker */}
        {step === 'preset-picker' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-4 px-4 py-5">
              <p className="text-muted-foreground text-sm">Start from a template</p>
              <TaskTemplateGallery onSelect={handleSelectPreset} selectedId={appliedPreset?.id} />
              <button
                type="button"
                onClick={() => {
                  setAppliedPreset(null);
                  setStep('form');
                }}
                className="text-muted-foreground hover:text-foreground w-full text-center text-sm transition-colors"
              >
                Start from scratch
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Form — keyed so it remounts with fresh defaultValues on preset change */}
        {step === 'form' && (
          <ScheduleForm
            key={formKey}
            defaultValues={formValues}
            roster={roster}
            editTask={editTask}
            onSubmitSuccess={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
            onDeleteClick={() => setDeleteConfirmOpen(true)}
            isPending={isPending}
          />
        )}
      </ResponsiveDialogContent>

      {editTask && (
        <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete scheduled task</DialogTitle>
              <DialogDescription>
                Delete &ldquo;{editTask.name}&rdquo;? This will also remove all run history. This
                action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteTask.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
              >
                {deleteTask.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ResponsiveDialog>
  );
}
